/* ============================================================
   CutFlow Studio — mediaManager.js
   Owns: AppState.project.media (metadata only — see below),
         the actual Blob/File/ObjectURL store (kept OUTSIDE
         AppState.project so undo snapshots never clone media bytes),
         <video>/<audio>/<img> source-element pool used by player.js.

   MediaAsset shape (in AppState.project.media — metadata only):
     { id, name, type: 'video'|'audio'|'image', duration, width, height,
       thumbnailDataUrl }
   The actual playable Blob lives in `blobStore` (Map<mediaId, Blob>) and
   the decoded source elements live in `elementPool` (Map<mediaId, HTMLElement>)
   — both module-local, NOT on AppState, so history.capture()'s
   structuredClone(AppState.project) never touches binary data.

   SOURCE ELEMENT POOLING (the player.js "shared source" problem):
   If two clips reference the same mediaId and are both visually active
   in the same composited frame (e.g. same clip used on two tracks for a
   split-screen), one <video> element can't seek to two places at once.
   We solve this by keying pooled elements by a composite "(mediaId,
   poolSlot)" — player.js always asks for a source via clip.id first;
   we lazily assign each concurrently-active clip its own pooled element,
   recycling elements whose clip is no longer active. Most projects never
   need more than 1 element per media asset, so this stays cheap.
   ============================================================ */

let ctx;

const blobStore = new Map();     // mediaId -> Blob
const elementPool = new Map();   // mediaId -> HTMLElement[] (pool, usually length 1)
const clipToElement = new Map(); // clipId -> HTMLElement (which pooled element a clip is currently bound to)

let elDropzone, elList, elInput;

function init(_ctx) {
  ctx = _ctx;
  elDropzone = document.getElementById('media-bin-dropzone');
  elList = document.getElementById('media-bin-list');
  elInput = document.getElementById('input-import-media');

  wireImportButton();
  wireDropzone();
  wireGridToggle();

  registerWithPlayer();

  ctx.bus.on('project:replaced', renderMediaList);
  ctx.bus.on('history:restored', renderMediaList);

  renderMediaList();
}

/* player.js exposes setters but doesn't import us — we reach into it via the
   same ctx-free direct-call pattern by importing player.js here instead.
   This is the one acceptable direction for the cycle: mediaManager (low-level,
   no dependents) -> player (orchestrator) is fine; the reverse is not. */
import * as player from './player.js';
function registerWithPlayer() {
  player.setSourceElementGetter((mediaId) => getElementForClip(mediaId));
  player.setAllSourceElementsGetter(() => allActiveElements());
}

/* ---------------- IMPORT ---------------- */
function wireImportButton() {
  document.getElementById('btn-import-media')?.addEventListener('click', () => elInput?.click());
  elInput?.addEventListener('change', () => {
    if (elInput.files?.length) importFiles([...elInput.files]);
    elInput.value = '';
  });
}

function wireDropzone() {
  if (!elDropzone) return;
  elDropzone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    elDropzone.classList.add('drag-over');
  });
  elDropzone.addEventListener('dragleave', () => elDropzone.classList.remove('drag-over'));
  elDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    elDropzone.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) importFiles(files);
  });
}

function wireGridToggle() {
  const btn = document.getElementById('btn-media-grid-toggle');
  btn?.addEventListener('click', () => {
    elList.classList.toggle('cf-media-list-row');
  });
}

async function importFiles(files) {
  for (const file of files) {
    const type = classifyFile(file);
    if (!type) {
      ctx.showToast(`Unsupported file: ${file.name}`, 'warning');
      continue;
    }
    const mediaId = ctx.makeId('media');
    blobStore.set(mediaId, file);

    const placeholder = {
      id: mediaId,
      name: file.name,
      type,
      duration: 0,
      width: 0,
      height: 0,
      thumbnailDataUrl: null,
      _loading: true,
    };
    ctx.AppState.project.media.push(placeholder);
    ctx.AppState.markDirty('media:importStarted', { mediaId });
    renderMediaList();

    try {
      const meta = await probeMedia(file, type);
      Object.assign(placeholder, meta, { _loading: false });
      ctx.AppState.markDirty('media:imported', { mediaId });
      renderMediaList();
      ctx.bus.emit('media:ready', { mediaId });
    } catch (err) {
      console.error('[mediaManager] failed to probe', file.name, err);
      ctx.showToast(`Couldn't read ${file.name}`, 'error');
      const idx = ctx.AppState.project.media.findIndex(m => m.id === mediaId);
      if (idx !== -1) ctx.AppState.project.media.splice(idx, 1);
      blobStore.delete(mediaId);
      renderMediaList();
    }
  }
}

function classifyFile(file) {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

/** Loads the file enough to get duration/dimensions + a thumbnail, without
    keeping a long-lived element around yet (the pool creates those on demand
    when a clip actually needs to play). */
function probeMedia(file, type) {
  const url = URL.createObjectURL(file);
  if (type === 'image') {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resolve({ duration: null, width: img.naturalWidth, height: img.naturalHeight, thumbnailDataUrl: url });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
      img.src = url;
    });
  }

  const tagName = type === 'video' ? 'video' : 'audio';
  return new Promise((resolve, reject) => {
    const el = document.createElement(tagName);
    el.preload = 'metadata';
    el.muted = true;
    el.src = url;

    const onError = () => { cleanup(); reject(new Error(`${type} decode failed`)); };
    const onLoaded = () => {
      const duration = el.duration && isFinite(el.duration) ? el.duration : 0;
      if (tagName === 'audio') {
        cleanup();
        resolve({ duration, width: 0, height: 0, thumbnailDataUrl: null });
        return;
      }
      // Seek a hair in to grab a non-black first frame for the thumbnail.
      const grabAt = Math.min(0.1, duration > 0.2 ? duration * 0.05 : 0);
      el.currentTime = grabAt;
      el.addEventListener('seeked', () => {
        const thumb = grabThumbnail(el);
        cleanup();
        resolve({ duration, width: el.videoWidth, height: el.videoHeight, thumbnailDataUrl: thumb });
      }, { once: true });
    };

    function cleanup() {
      el.removeEventListener('error', onError);
      el.removeEventListener('loadedmetadata', onLoaded);
      // NOTE: we intentionally do NOT revoke `url` here — it's reused as the
      // element pool's src for actual playback later (see createSourceElement,
      // which creates its OWN object URL from the stored Blob, so this probe
      // URL is safe to release once probing finishes).
      URL.revokeObjectURL(url);
    }

    el.addEventListener('error', onError);
    el.addEventListener('loadedmetadata', onLoaded);
  });
}

function grabThumbnail(videoEl) {
  try {
    const c = document.createElement('canvas');
    const targetW = 160;
    const ratio = videoEl.videoHeight / videoEl.videoWidth || 9 / 16;
    c.width = targetW;
    c.height = Math.round(targetW * ratio);
    const cctx = c.getContext('2d');
    cctx.drawImage(videoEl, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return null; // tainted canvas or decode race — thumbnail just stays blank
  }
}

/* ---------------- SOURCE ELEMENT POOL (consumed by player.js) ---------------- */
/** Returns a live <video>/<audio>/<img> element bound to this media, for
    drawing the CURRENT frame. player.js calls this once per draw with the
    media id; the common case (one active instance of a given asset at a
    time) reuses a single pooled element. */
function getElementForClip(mediaId) {
  return ensurePooledElement(mediaId);
}

function ensurePooledElement(mediaId, clipId = null) {
  const media = ctx.AppState.getMediaById(mediaId);
  if (!media) return null;

  let pool = elementPool.get(mediaId);
  if (!pool) { pool = []; elementPool.set(mediaId, pool); }

  if (clipId && clipToElement.has(clipId)) return clipToElement.get(clipId);

  // Reuse an existing pooled element that's free (not claimed by a different
  // concurrently-active clip this frame) — covers the overwhelming majority
  // of timelines, where a given asset is only on screen once at a time.
  let el = pool.find(e => !e._claimedByClip || e._claimedByClip === clipId);
  if (!el) {
    el = createSourceElement(media);
    if (!el) return null;
    pool.push(el);
  }
  if (clipId) { el._claimedByClip = clipId; clipToElement.set(clipId, el); }
  return el;
}

function createSourceElement(media) {
  const blob = blobStore.get(media.id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);

  if (media.type === 'image') {
    const img = new Image();
    img.src = url;
    img.dataset.mediaId = media.id;
    return img;
  }

  const el = document.createElement(media.type === 'video' ? 'video' : 'audio');
  el.src = url;
  el.muted = media.type === 'video'; // video element is visual-only; audio.js owns audible playback via its own Web Audio graph
  el.playsInline = true;
  el.preload = 'auto';
  el.dataset.mediaId = media.id;
  document.body.appendChild(el); // attached-but-hidden elements decode more reliably cross-browser
  el.style.position = 'fixed';
  el.style.width = '1px';
  el.style.height = '1px';
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  el.style.top = '-9999px';
  return el;
}

function allActiveElements() {
  const out = [];
  for (const [mediaId, pool] of elementPool) {
    for (const el of pool) out.push([mediaId, el]);
  }
  return out;
}

/** Called when a clip/media is removed from the project so we don't leak
    elements/object URLs. Exposed for ui.js's "Remove from project" media-bin
    action and for timeline.js track/clip removal paths. */
function releaseMedia(mediaId) {
  const pool = elementPool.get(mediaId);
  if (pool) {
    for (const el of pool) {
      try { el.pause?.(); } catch { /* noop */ }
      if (el.src) URL.revokeObjectURL(el.src);
      el.remove?.();
    }
    elementPool.delete(mediaId);
  }
  for (const [clipId, el] of clipToElement) {
    if (el.dataset?.mediaId === mediaId) clipToElement.delete(clipId);
  }
}

/* ---------------- MEDIA BIN RENDERING ---------------- */
function renderMediaList() {
  const { media } = ctx.AppState.project;
  elList.innerHTML = '';

  if (media.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'cf-empty-hint';
    hint.textContent = 'Drag files here or click Import to add video, audio, and images.';
    elList.appendChild(hint);
    return;
  }

  for (const item of media) {
    elList.appendChild(buildMediaItemEl(item));
  }
}

function buildMediaItemEl(item) {
  const el = document.createElement('div');
  el.className = 'cf-media-item';
  el.dataset.mediaId = item.id;
  el.draggable = !item._loading;
  if (ctx.AppState.project.selection.mediaId === item.id) el.classList.add('selected');

  const thumb = document.createElement('div');
  thumb.className = 'cf-media-item-thumb';
  if (item.thumbnailDataUrl) {
    const img = document.createElement('img');
    img.src = item.thumbnailDataUrl;
    img.alt = item.name;
    thumb.appendChild(img);
  } else {
    thumb.textContent = item.type === 'audio' ? '♪' : item.type === 'image' ? '🖼' : '🎬';
  }

  const badge = document.createElement('span');
  badge.className = 'cf-media-item-type-badge';
  badge.textContent = item.type;
  thumb.appendChild(badge);

  if (item.duration) {
    const dur = document.createElement('span');
    dur.className = 'cf-media-item-duration';
    dur.textContent = formatDurationShort(item.duration);
    thumb.appendChild(dur);
  }

  if (item._loading) {
    const overlay = document.createElement('div');
    overlay.className = 'cf-media-item-progress';
    overlay.textContent = 'Loading…';
    thumb.appendChild(overlay);
  }

  el.appendChild(thumb);

  const info = document.createElement('div');
  info.className = 'cf-media-item-info';
  const name = document.createElement('div');
  name.className = 'cf-media-item-name';
  name.textContent = item.name;
  name.title = item.name;
  info.appendChild(name);
  const meta = document.createElement('div');
  meta.className = 'cf-media-item-meta';
  meta.textContent = item.width ? `${item.width}×${item.height}` : item.type;
  info.appendChild(meta);
  el.appendChild(info);

  el.addEventListener('click', () => {
    ctx.AppState.project.selection.mediaId = item.id;
    ctx.bus.emit('media:selected', { mediaId: item.id });
    document.querySelectorAll('.cf-media-item').forEach(n => n.classList.toggle('selected', n === el));
  });

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/cutflow-media-id', item.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ctx.bus.emit('contextmenu:request', { x: e.clientX, y: e.clientY, kind: 'media', mediaId: item.id });
  });

  return el;
}

function formatDurationShort(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  importFiles,
  releaseMedia,
  getElementForClip,
  ensurePooledElement,
  allActiveElements,
  getAllBlobsForPersistence,
  restoreBlobsFromPersistence,
  getBlobForMedia,
  registerDerivedAsset,
};

/* ---------------- PERSISTENCE ACCESSORS (consumed by app.js -> projectManager.js) ---------------- */
/** Returns the live blobStore Map directly — projectManager.js only reads
    it (iterates for save), never mutates it, so sharing the reference is
    safe and avoids a needless copy of potentially large media Blobs. */
function getAllBlobsForPersistence() {
  return blobStore;
}

/** Called by projectManager.js after loading a project's saved blobs from
    IndexedDB. Replaces blobStore's contents and clears any stale pooled
    elements/object URLs from the previous project so playback doesn't
    serve mismatched media. */
function restoreBlobsFromPersistence(restoredMap) {
  for (const mediaId of [...elementPool.keys()]) releaseMedia(mediaId);
  blobStore.clear();
  for (const [mediaId, blob] of restoredMap) blobStore.set(mediaId, blob);
}

/* ---------------- BLOB ACCESS (consumed by audio.js and export.js) ---------------- */
/** Returns the raw Blob for a media id (used for decodeAudioData in
    audio.js's waveform/noise-reduction/beat-detection paths and export.js's
    OfflineAudioContext rendering — neither of those need the pooled
    playback <video>/<audio> ELEMENT, just the underlying bytes). */
function getBlobForMedia(mediaId) {
  return blobStore.get(mediaId) || null;
}

/** Called by audio.js after producing a derived asset (e.g. denoised audio)
    that needs to become a first-class media item + blob entry, exactly as
    if the user had imported it. */
function registerDerivedAsset(mediaId, blob, name, duration) {
  blobStore.set(mediaId, blob);
  ctx.AppState.project.media.push({
    id: mediaId, name, type: 'audio', duration, width: 0, height: 0, thumbnailDataUrl: null,
  });
  ctx.AppState.markDirty('media:derivedAssetAdded', { mediaId });
  renderMediaList();
}
