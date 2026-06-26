/* ============================================================
   CutFlow Studio — timeline.js
   Owns: AppState.project.tracks, AppState.project.timelineView,
         AppState.project.markers, AppState.project.selection.clipIds
   Renders and drives the multi-track timeline: track rows, clips,
   ruler, playhead-x sync, drag/trim/split/ripple-delete, snapping,
   zoom, ripple-aware magnetic mode, multi-select marquee.

   Clip shape (owned here, read by player.js/effects.js/audio.js/etc):
     {
       id, trackId, mediaId,
       start, duration, trimIn, trimOut,
       label,
       fadeIn, fadeOut,
       transitionIn, transitionOut,
       effects: [],
       textConfig: null,
       keyframes: {},
       colorGrade: undefined,      // lazily created by effects.js
       staticTransform: undefined, // lazily created by keyframes.js
       speed: 1,                   // read by player.js for speed-ramp
       volume: 1, pan: 0,          // read by audio.js
     }

   Track shape:
     { id, type: 'video'|'audio'|'overlay', name, clips: [], muted, locked, solo }
   ============================================================ */

let ctx;

const MIN_PX_PER_SEC = 4;
const MAX_PX_PER_SEC = 400;
const SNAP_THRESHOLD_PX = 8;
const RULER_MAJOR_EVERY_PX = 80;

let elScroll, elRuler, elTracksHeader, elTracks, elPlayhead, elZoomSlider;
let drag = null;

function init(_ctx) {
  ctx = _ctx;
  elScroll = document.getElementById('timeline-scroll');
  elRuler = document.getElementById('timeline-ruler');
  elTracksHeader = document.getElementById('timeline-tracks-header');
  elTracks = document.getElementById('timeline-tracks');
  elPlayhead = document.getElementById('timeline-playhead');
  elZoomSlider = document.getElementById('zoom-slider');

  ensureDefaultTracks();
  wireToolbar();
  wireZoom();
  wireRuler();
  wireTracksSurface();
  wireKeyboardModifiers();

  ctx.bus.on('project:replaced', () => { ensureDefaultTracks(); renderAll(); });
  ctx.bus.on('history:restored', renderAll);
  ctx.bus.on('media:dropOnTimeline', onMediaDropped);
  ctx.bus.on('player:requestPlayheadSync', updatePlayheadX);

  elTracks.style.setProperty('--px-per-sec', `${ctx.AppState.project.timelineView.pxPerSec}px`);
  renderAll();
}

/* ---------------- BOOTSTRAP ---------------- */
function ensureDefaultTracks() {
  const { project } = ctx.AppState;
  if (project.tracks.length > 0) return;
  project.tracks.push(makeTrack('video', 'V1'));
  project.tracks.push(makeTrack('audio', 'A1'));
}

function makeTrack(type, name) {
  return { id: ctx.makeId('track'), type, name, clips: [], muted: false, locked: false, solo: false };
}

/* ---------------- PUBLIC HELPERS ---------------- */
function addClip(trackId, { mediaId, start, duration, trimIn = 0, trimOut = null, label = 'Clip' }) {
  const track = ctx.AppState.getTrackById(trackId);
  if (!track) return null;
  ctx.history.capture();
  const clip = {
    id: ctx.makeId('clip'),
    trackId, mediaId, start, duration,
    trimIn, trimOut: trimOut ?? (trimIn + duration),
    label,
    fadeIn: 0, fadeOut: 0,
    transitionIn: null, transitionOut: null,
    effects: [],
    textConfig: null,
    keyframes: {},
    speed: 1,
    volume: 1,
    pan: 0,
  };
  track.clips.push(clip);
  track.clips.sort((a, b) => a.start - b.start);
  ctx.AppState.markDirty('timeline:clipAdded', { clip });
  renderTrack(track);
  renderRuler();
  return clip;
}

function addTrack(type) {
  const { project } = ctx.AppState;
  const existingOfType = project.tracks.filter(t => t.type === type).length;
  const prefix = type === 'video' ? 'V' : type === 'audio' ? 'A' : 'O';
  ctx.history.capture();
  const track = makeTrack(type, `${prefix}${existingOfType + 1}`);
  if (type === 'audio') project.tracks.push(track);
  else {
    const firstAudioIdx = project.tracks.findIndex(t => t.type === 'audio');
    if (firstAudioIdx === -1) project.tracks.push(track);
    else project.tracks.splice(firstAudioIdx, 0, track);
  }
  ctx.AppState.markDirty('timeline:trackAdded', { track });
  renderAll();
  return track;
}

function removeTrack(trackId) {
  const { project } = ctx.AppState;
  const idx = project.tracks.findIndex(t => t.id === trackId);
  if (idx === -1) return;
  ctx.history.capture();
  project.tracks.splice(idx, 1);
  project.selection.clipIds = project.selection.clipIds.filter(id => ctx.AppState.getClipById(id));
  ctx.AppState.markDirty('timeline:trackRemoved', { trackId });
  renderAll();
}

/* ---------------- SELECTION ---------------- */
function selectClips(clipIds, { additive = false } = {}) {
  const { project } = ctx.AppState;
  if (additive) {
    const set = new Set(project.selection.clipIds);
    for (const id of clipIds) { if (set.has(id)) set.delete(id); else set.add(id); }
    project.selection.clipIds = [...set];
  } else {
    project.selection.clipIds = [...clipIds];
  }
  ctx.bus.emit('selection:changed', { clipIds: project.selection.clipIds });
  renderSelectionHighlight();
}

function clearSelection() {
  ctx.AppState.project.selection.clipIds = [];
  ctx.bus.emit('selection:changed', { clipIds: [] });
  renderSelectionHighlight();
}

/* ---------------- EDIT OPERATIONS ---------------- */
function splitAtPlayhead() {
  const { project } = ctx.AppState;
  const t = project.playback.currentTime;
  const targets = project.selection.clipIds.length
    ? ctx.AppState.getSelectedClips()
    : project.tracks.flatMap(tr => tr.clips).filter(c => t > c.start && t < c.start + c.duration);

  const splittable = targets.filter(c => t > c.start && t < c.start + c.duration);
  if (splittable.length === 0) { ctx.showToast('Playhead is not over a clip', 'warning'); return; }

  ctx.history.capture();
  const newIds = [];
  for (const clip of splittable) {
    const track = ctx.AppState.getTrackForClip(clip.id);
    const offsetIntoClip = t - clip.start;
    const rightDuration = clip.duration - offsetIntoClip;

    const rightClip = {
      ...structuredClone(clip),
      id: ctx.makeId('clip'),
      start: t,
      duration: rightDuration,
      trimIn: clip.trimIn + offsetIntoClip,
      transitionIn: null,
    };
    clip.duration = offsetIntoClip;
    clip.trimOut = clip.trimIn + offsetIntoClip;
    clip.transitionOut = null;

    track.clips.push(rightClip);
    track.clips.sort((a, b) => a.start - b.start);
    newIds.push(rightClip.id);
  }

  ctx.AppState.markDirty('timeline:split', { newIds });
  renderAll();
  ctx.showToast(`Split ${splittable.length} clip${splittable.length > 1 ? 's' : ''}`, 'success');
}

function rippleDeleteSelected() {
  const clips = ctx.AppState.getSelectedClips();
  if (clips.length === 0) return;
  ctx.history.capture();

  const byTrack = new Map();
  for (const clip of clips) {
    const track = ctx.AppState.getTrackForClip(clip.id);
    if (!track) continue;
    if (!byTrack.has(track.id)) byTrack.set(track.id, []);
    byTrack.get(track.id).push(clip);
  }

  for (const [trackId, trackClips] of byTrack) {
    const track = ctx.AppState.getTrackById(trackId);
    trackClips.sort((a, b) => a.start - b.start);
    for (const clip of trackClips) {
      const removedStart = clip.start;
      const removedDuration = clip.duration;
      track.clips = track.clips.filter(c => c.id !== clip.id);
      if (ctx.AppState.project.timelineView.magneticEnabled) {
        for (const other of track.clips) {
          if (other.start >= removedStart) other.start -= removedDuration;
        }
      }
    }
  }

  clearSelection();
  ctx.AppState.markDirty('timeline:rippleDeleted', { count: clips.length });
  renderAll();
  ctx.showToast(`Deleted ${clips.length} clip${clips.length > 1 ? 's' : ''}`, 'success');
}

function deleteSelected() {
  const clips = ctx.AppState.getSelectedClips();
  if (clips.length === 0) return;
  ctx.history.capture();
  for (const clip of clips) {
    const track = ctx.AppState.getTrackForClip(clip.id);
    if (track) track.clips = track.clips.filter(c => c.id !== clip.id);
  }
  clearSelection();
  ctx.AppState.markDirty('timeline:deleted', { count: clips.length });
  renderAll();
}

/* ---------------- MARK IN/OUT ---------------- */
function markIn() {
  const { project } = ctx.AppState;
  project.markers.inPoint = project.playback.currentTime;
  if (project.markers.outPoint !== null && project.markers.outPoint <= project.markers.inPoint) {
    project.markers.outPoint = null;
  }
  ctx.AppState.markDirty('markers:changed', {});
  renderInOutRange();
}

function markOut() {
  const { project } = ctx.AppState;
  project.markers.outPoint = project.playback.currentTime;
  if (project.markers.inPoint !== null && project.markers.inPoint >= project.markers.outPoint) {
    project.markers.inPoint = null;
  }
  ctx.AppState.markDirty('markers:changed', {});
  renderInOutRange();
}

/* ---------------- TOOLBAR WIRING ---------------- */
function wireToolbar() {
  document.getElementById('btn-tool-select')?.addEventListener('click', () => setActiveTool('select'));
  document.getElementById('btn-tool-cut')?.addEventListener('click', () => setActiveTool('cut'));
  document.getElementById('btn-split')?.addEventListener('click', splitAtPlayhead);
  document.getElementById('btn-ripple-delete')?.addEventListener('click', rippleDeleteSelected);
  document.getElementById('btn-mark-in')?.addEventListener('click', markIn);
  document.getElementById('btn-mark-out')?.addEventListener('click', markOut);

  const btnSnap = document.getElementById('btn-snap-toggle');
  btnSnap?.addEventListener('click', () => {
    const tv = ctx.AppState.project.timelineView;
    tv.snapEnabled = !tv.snapEnabled;
    btnSnap.classList.toggle('active', tv.snapEnabled);
    ctx.AppState.markDirty();
  });

  const btnMagnetic = document.getElementById('btn-magnetic-toggle');
  btnMagnetic?.addEventListener('click', () => {
    const tv = ctx.AppState.project.timelineView;
    tv.magneticEnabled = !tv.magneticEnabled;
    btnMagnetic.classList.toggle('active', tv.magneticEnabled);
    ctx.AppState.markDirty();
  });

  document.getElementById('btn-add-video-track')?.addEventListener('click', () => addTrack('video'));
  document.getElementById('btn-add-audio-track')?.addEventListener('click', () => addTrack('audio'));
}

function setActiveTool(tool) {
  ctx.AppState.project.timelineView.activeTool = tool;
  document.querySelectorAll('.cf-tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  elTracks.classList.toggle('tool-cut', tool === 'cut');
  elTracks.classList.toggle('tool-select', tool === 'select');
}

/* ---------------- ZOOM ---------------- */
function wireZoom() {
  elZoomSlider.value = String(ctx.AppState.project.timelineView.pxPerSec);
  elZoomSlider.addEventListener('input', () => setZoom(Number(elZoomSlider.value), { keepCenter: false }));

  document.getElementById('btn-zoom-in')?.addEventListener('click', () => stepZoom(1.25));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => stepZoom(0.8));
  document.getElementById('btn-zoom-fit')?.addEventListener('click', zoomToFit);

  elScroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = elTracks.getBoundingClientRect();
    const cursorX = e.clientX - rect.left + elScroll.scrollLeft;
    setZoom(ctx.AppState.project.timelineView.pxPerSec * factor, { anchorPx: cursorX });
  }, { passive: false });
}

function stepZoom(factor) {
  setZoom(ctx.AppState.project.timelineView.pxPerSec * factor, { keepCenter: true });
}

function zoomToFit() {
  const duration = Math.max(ctx.AppState.getDuration(), 1);
  const available = elScroll.clientWidth - 140;
  const fitPxPerSec = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, available / duration));
  setZoom(fitPxPerSec, { keepCenter: false });
}

function setZoom(pxPerSec, { keepCenter = false, anchorPx = null } = {}) {
  const tv = ctx.AppState.project.timelineView;
  const clamped = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, pxPerSec));
  const oldPxPerSec = tv.pxPerSec;

  let anchorSeconds = null;
  if (anchorPx !== null) {
    anchorSeconds = anchorPx / oldPxPerSec;
  } else if (keepCenter) {
    const centerPx = elScroll.scrollLeft + (elScroll.clientWidth - 140) / 2;
    anchorSeconds = centerPx / oldPxPerSec;
  }

  tv.pxPerSec = clamped;
  elZoomSlider.value = String(Math.round(clamped));
  elTracks.style.setProperty('--px-per-sec', `${clamped}px`);

  renderAll();

  if (anchorSeconds !== null) {
    const newAnchorPx = anchorSeconds * clamped;
    const targetScroll = anchorPx !== null
      ? newAnchorPx - (anchorPx - elScroll.scrollLeft)
      : newAnchorPx - (elScroll.clientWidth - 140) / 2;
    elScroll.scrollLeft = Math.max(0, targetScroll);
  }
}

/* ---------------- RULER ---------------- */
function wireRuler() {
  elRuler.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    seekFromRulerEvent(e);
    const onMove = (ev) => seekFromRulerEvent(ev);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function seekFromRulerEvent(e) {
  const rect = elRuler.getBoundingClientRect();
  const x = Math.max(0, e.clientX - rect.left);
  const t = x / ctx.AppState.project.timelineView.pxPerSec;
  ctx.AppState.project.playback.currentTime = t;
  ctx.bus.emit('playback:seek', { time: t });
  updatePlayheadX();
}

function renderRuler() {
  elRuler.innerHTML = '';
  const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;
  const duration = Math.max(ctx.AppState.getDuration() + 10, 30);
  const totalPx = duration * pxPerSec;
  elRuler.style.width = `${totalPx}px`;
  elTracks.style.width = `${totalPx}px`;

  const niceIntervals = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let majorInterval = niceIntervals.find(s => s * pxPerSec >= RULER_MAJOR_EVERY_PX) || 600;
  const minorInterval = majorInterval / 5;

  const frag = document.createDocumentFragment();
  for (let s = 0; s <= duration; s += minorInterval) {
    const isMajor = Math.abs(s % majorInterval) < 0.001;
    const tick = document.createElement('div');
    tick.className = `cf-ruler-tick${isMajor ? ' major' : ''}`;
    tick.style.left = `${s * pxPerSec}px`;
    frag.appendChild(tick);
    if (isMajor) {
      const label = document.createElement('div');
      label.className = 'cf-ruler-label';
      label.style.left = `${s * pxPerSec}px`;
      label.textContent = formatTimecodeShort(s);
      frag.appendChild(label);
    }
  }
  elRuler.appendChild(frag);
  renderInOutRange();
}

function renderInOutRange() {
  elRuler.querySelectorAll('.cf-inout-range, .cf-inout-marker').forEach(el => el.remove());
  const { inPoint, outPoint } = ctx.AppState.project.markers;
  const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;

  if (inPoint !== null && outPoint !== null) {
    const range = document.createElement('div');
    range.className = 'cf-inout-range';
    range.style.left = `${inPoint * pxPerSec}px`;
    range.style.width = `${(outPoint - inPoint) * pxPerSec}px`;
    elRuler.appendChild(range);
  }
  for (const key of ['inPoint', 'outPoint']) {
    const val = ctx.AppState.project.markers[key];
    if (val === null) continue;
    const marker = document.createElement('div');
    marker.className = 'cf-inout-marker';
    marker.style.left = `${val * pxPerSec}px`;
    elRuler.appendChild(marker);
  }
}

function formatTimecodeShort(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function formatTimecodeFull(totalSeconds, fps = 30) {
  const totalFrames = Math.round(totalSeconds * fps);
  const ff = totalFrames % fps;
  const totalSecs = Math.floor(totalFrames / fps);
  const ss = totalSecs % 60;
  const mm = Math.floor(totalSecs / 60) % 60;
  const hh = Math.floor(totalSecs / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/* ---------------- PLAYHEAD SYNC ---------------- */
function updatePlayheadX() {
  const x = ctx.AppState.project.playback.currentTime * ctx.AppState.project.timelineView.pxPerSec;
  elTracks.style.setProperty('--playhead-x', `${x}px`);
}

/* ---------------- FULL RENDER ---------------- */
function renderAll() {
  renderTracksHeader();
  renderRuler();
  renderTracksBody();
  renderSelectionHighlight();
  updatePlayheadX();
  ctx.bus.emit('timeline:rendered', {});
}

function renderTracksHeader() {
  elTracksHeader.innerHTML = '';
  for (const track of ctx.AppState.project.tracks) {
    elTracksHeader.appendChild(buildTrackHeaderRow(track));
  }
}

function buildTrackHeaderRow(track) {
  const row = document.createElement('div');
  row.className = 'cf-track-header';
  row.dataset.trackId = track.id;
  row.dataset.trackType = track.type;
  row.style.height = `var(--track-h${track.type === 'audio' ? '-audio' : ''})`;

  const colorBar = document.createElement('div');
  colorBar.className = 'cf-track-color-bar';
  row.appendChild(colorBar);

  const name = document.createElement('span');
  name.className = 'cf-track-name';
  name.contentEditable = 'true';
  name.spellcheck = false;
  name.textContent = track.name;
  name.addEventListener('blur', () => {
    const newName = name.textContent.trim() || track.name;
    name.textContent = newName;
    if (newName !== track.name) {
      ctx.history.capture();
      track.name = newName;
      ctx.AppState.markDirty('timeline:trackRenamed', { trackId: track.id });
    }
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
  row.appendChild(name);

  const controls = document.createElement('div');
  controls.className = 'cf-track-controls';

  const btnMute = document.createElement('button');
  btnMute.className = `cf-track-mini-btn${track.muted ? ' muted' : ''}`;
  btnMute.textContent = track.type === 'audio' ? '🔇' : '👁';
  btnMute.title = track.type === 'audio' ? 'Mute track' : 'Hide track';
  btnMute.addEventListener('click', () => {
    ctx.history.capture();
    track.muted = !track.muted;
    btnMute.classList.toggle('muted', track.muted);
    ctx.AppState.markDirty('timeline:trackMuteToggled', { trackId: track.id });
  });
  controls.appendChild(btnMute);

  const btnLock = document.createElement('button');
  btnLock.className = `cf-track-mini-btn${track.locked ? ' active' : ''}`;
  btnLock.textContent = '🔒';
  btnLock.title = 'Lock track';
  btnLock.addEventListener('click', () => {
    ctx.history.capture();
    track.locked = !track.locked;
    btnLock.classList.toggle('active', track.locked);
    ctx.AppState.markDirty('timeline:trackLockToggled', { trackId: track.id });
  });
  controls.appendChild(btnLock);

  const btnRemove = document.createElement('button');
  btnRemove.className = 'cf-track-mini-btn';
  btnRemove.textContent = '✕';
  btnRemove.title = 'Remove track';
  btnRemove.addEventListener('click', () => removeTrack(track.id));
  controls.appendChild(btnRemove);

  row.appendChild(controls);
  return row;
}

function renderTracksBody() {
  elTracks.innerHTML = '';
  elTracks.appendChild(elPlayhead);

  let topOffset = 0;
  for (const track of ctx.AppState.project.tracks) {
    const trackEl = buildTrackRow(track, topOffset);
    elTracks.appendChild(trackEl);
    topOffset += track.type === 'audio' ? 44 : 56;
  }
  elTracks.style.height = `${topOffset}px`;
}

function renderTrack(track) {
  const row = elTracks.querySelector(`.cf-track[data-track-id="${track.id}"]`);
  if (!row) { renderAll(); return; }
  row.querySelectorAll('.cf-clip').forEach(el => el.remove());
  for (const clip of track.clips) {
    row.appendChild(buildClipEl(clip, track));
  }
}

function buildTrackRow(track, topOffset) {
  const row = document.createElement('div');
  row.className = 'cf-track';
  row.dataset.trackId = track.id;
  row.dataset.trackType = track.type;
  row.style.position = 'absolute';
  row.style.top = `${topOffset}px`;
  row.style.left = '0';
  row.style.right = '0';
  row.style.height = track.type === 'audio' ? 'var(--track-h-audio)' : 'var(--track-h)';

  for (const clip of track.clips) {
    row.appendChild(buildClipEl(clip, track));
  }

  wireTrackDropTarget(row, track);
  return row;
}

/* ---------------- CLIP RENDERING ---------------- */
function buildClipEl(clip, track) {
  const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;
  const el = document.createElement('div');
  el.className = 'cf-clip';
  el.dataset.clipId = clip.id;
  el.dataset.trackType = track.type;
  el.style.left = `${clip.start * pxPerSec}px`;
  el.style.width = `${Math.max(clip.duration * pxPerSec, 8)}px`;
  if (ctx.AppState.project.selection.clipIds.includes(clip.id)) el.classList.add('selected');

  const label = document.createElement('div');
  label.className = 'cf-clip-label';
  label.textContent = clip.label;
  el.appendChild(label);

  if (track.type === 'audio') {
    const wf = document.createElement('div');
    wf.className = 'cf-clip-waveform';
    wf.dataset.clipId = clip.id;
    el.appendChild(wf);
  } else {
    const strip = document.createElement('div');
    strip.className = 'cf-clip-thumbstrip';
    strip.dataset.clipId = clip.id;
    el.appendChild(strip);
  }

  const leftHandle = document.createElement('div');
  leftHandle.className = 'cf-clip-handle cf-clip-handle-left';
  el.appendChild(leftHandle);
  const rightHandle = document.createElement('div');
  rightHandle.className = 'cf-clip-handle cf-clip-handle-right';
  el.appendChild(rightHandle);

  wireClipInteractions(el, clip, leftHandle, rightHandle);
  return el;
}

/* ---------------- CLIP INTERACTION ---------------- */
function wireClipInteractions(el, clip, leftHandle, rightHandle) {
  leftHandle.addEventListener('pointerdown', (e) => startTrim(e, clip, 'left'));
  rightHandle.addEventListener('pointerdown', (e) => startTrim(e, clip, 'right'));

  el.addEventListener('pointerdown', (e) => {
    if (e.target === leftHandle || e.target === rightHandle) return;

    const tool = ctx.AppState.project.timelineView.activeTool;
    if (tool === 'cut') { cutClipAt(clip, e); return; }

    const track = ctx.AppState.getTrackForClip(clip.id);
    if (track?.locked) return;

    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!ctx.AppState.project.selection.clipIds.includes(clip.id)) {
      selectClips([clip.id], { additive });
    } else if (additive) {
      selectClips([clip.id], { additive: true });
    }
    startMove(e, clip);
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!ctx.AppState.project.selection.clipIds.includes(clip.id)) selectClips([clip.id]);
    ctx.bus.emit('contextmenu:request', { x: e.clientX, y: e.clientY, kind: 'clip', clipId: clip.id });
  });
}

function cutClipAt(clip, e) {
  const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;
  const rect = e.currentTarget.getBoundingClientRect();
  const offsetPx = e.clientX - rect.left;
  const cutTime = clip.start + offsetPx / pxPerSec;
  if (cutTime <= clip.start + 0.05 || cutTime >= clip.start + clip.duration - 0.05) return;

  ctx.history.capture();
  const track = ctx.AppState.getTrackForClip(clip.id);
  const rightClip = {
    ...structuredClone(clip),
    id: ctx.makeId('clip'),
    start: cutTime,
    duration: clip.start + clip.duration - cutTime,
    trimIn: clip.trimIn + (cutTime - clip.start),
    transitionIn: null,
  };
  clip.duration = cutTime - clip.start;
  clip.trimOut = clip.trimIn + clip.duration;
  clip.transitionOut = null;
  track.clips.push(rightClip);
  track.clips.sort((a, b) => a.start - b.start);

  ctx.AppState.markDirty('timeline:split', { newIds: [rightClip.id] });
  renderAll();
}

/* ---- MOVE ---- */
function startMove(e, clip) {
  if (e.button !== 0) return;
  e.preventDefault();
  const track = ctx.AppState.getTrackForClip(clip.id);
  if (track?.locked) return;

  ctx.history.capture();
  const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;
  const selectedClips = ctx.AppState.getSelectedClips().includes(clip)
    ? ctx.AppState.getSelectedClips()
    : [clip];

  drag = {
    kind: 'move',
    pointerId: e.pointerId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    pxPerSec,
    clips: selectedClips.map(c => ({
      clip: c,
      origStart: c.start,
      origTrackId: c.trackId,
      el: elTracks.querySelector(`.cf-clip[data-clip-id="${c.id}"]`),
    })),
  };

  for (const item of drag.clips) item.el?.classList.add('dragging');
  window.addEventListener('pointermove', onMoveDrag);
  window.addEventListener('pointerup', endDrag);
}

function onMoveDrag(e) {
  if (!drag || drag.kind !== 'move') return;
  const dxPx = e.clientX - drag.startClientX;
  const dxSec = dxPx / drag.pxPerSec;

  const snapEnabled = ctx.AppState.project.timelineView.snapEnabled;
  let snappedDx = dxSec;
  let snapPoint = null;

  if (snapEnabled) {
    const primary = drag.clips[0];
    const proposedStart = Math.max(0, primary.origStart + dxSec);
    const proposedEnd = proposedStart + primary.clip.duration;
    const candidates = collectSnapCandidates(primary.clip.id, primary.clip.trackId);
    const snap = nearestSnap([proposedStart, proposedEnd], candidates, drag.pxPerSec);
    if (snap !== null) {
      snappedDx = (proposedStart + snap.delta) - primary.origStart;
      snapPoint = snap.point;
    }
  }

  const targetTrack = trackAtPointerY(e.clientY);

  for (const item of drag.clips) {
    const newStart = Math.max(0, item.origStart + snappedDx);
    item.clip._pendingStart = newStart;
    if (item.el) item.el.style.left = `${newStart * drag.pxPerSec}px`;
  }

  if (drag.clips.length === 1 && targetTrack && targetTrack.id !== drag.clips[0].origTrackId) {
    const compatible = targetTrack.type === ctx.AppState.getTrackById(drag.clips[0].origTrackId).type;
    drag.clips[0].el?.classList.toggle('invalid', !compatible);
    drag._hoverTrack = compatible ? targetTrack : null;
  } else {
    drag.clips[0].el?.classList.remove('invalid');
    drag._hoverTrack = null;
  }

  renderSnapGuides(snapPoint !== null ? [snapPoint] : []);
}

function trackAtPointerY(clientY) {
  const rect = elTracks.getBoundingClientRect();
  const y = clientY - rect.top;
  let offset = 0;
  for (const track of ctx.AppState.project.tracks) {
    const h = track.type === 'audio' ? 44 : 56;
    if (y >= offset && y < offset + h) return track;
    offset += h;
  }
  return null;
}

function collectSnapCandidates(excludeClipId, trackId) {
  const points = new Set([0, ctx.AppState.project.playback.currentTime]);
  const track = ctx.AppState.getTrackById(trackId);
  if (track) {
    for (const c of track.clips) {
      if (c.id === excludeClipId) continue;
      points.add(c.start);
      points.add(c.start + c.duration);
    }
  }
  return [...points];
}

function nearestSnap([proposedStart, proposedEnd], candidates, pxPerSec) {
  const thresholdSec = SNAP_THRESHOLD_PX / pxPerSec;
  let best = null;
  for (const point of candidates) {
    const startDist = Math.abs(proposedStart - point);
    const endDist = Math.abs(proposedEnd - point);
    if (startDist <= thresholdSec && (!best || startDist < Math.abs(best.delta))) {
      best = { delta: point - proposedStart, point, edge: 'start' };
    }
    if (endDist <= thresholdSec && (!best || endDist < Math.abs(best.delta))) {
      best = { delta: point - proposedEnd, point, edge: 'end' };
    }
  }
  return best;
}

function renderSnapGuides(positions) {
  elTracks.querySelectorAll('.cf-snap-guide').forEach(el => el.remove());
  const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;
  for (const s of positions) {
    const guide = document.createElement('div');
    guide.className = 'cf-snap-guide';
    guide.style.left = `${s * pxPerSec}px`;
    elTracks.appendChild(guide);
  }
}

/* ---- TRIM ---- */
function startTrim(e, clip, side) {
  e.preventDefault();
  e.stopPropagation();
  const track = ctx.AppState.getTrackForClip(clip.id);
  if (track?.locked) return;

  ctx.history.capture();
  selectClips([clip.id]);
  drag = {
    kind: 'trim',
    side,
    pointerId: e.pointerId,
    startClientX: e.clientX,
    pxPerSec: ctx.AppState.project.timelineView.pxPerSec,
    clip,
    origStart: clip.start,
    origDuration: clip.duration,
    origTrimIn: clip.trimIn,
    origTrimOut: clip.trimOut,
    el: elTracks.querySelector(`.cf-clip[data-clip-id="${clip.id}"]`),
  };
  window.addEventListener('pointermove', onTrimDrag);
  window.addEventListener('pointerup', endDrag);
}

function onTrimDrag(e) {
  if (!drag || drag.kind !== 'trim') return;
  const dxSec = (e.clientX - drag.startClientX) / drag.pxPerSec;
  const MIN_DURATION = 0.1;

  if (drag.side === 'left') {
    let newStart = drag.origStart + dxSec;
    newStart = Math.max(0, Math.min(newStart, drag.origStart + drag.origDuration - MIN_DURATION));
    newStart = Math.max(newStart, drag.origStart - drag.origTrimIn);
    const delta = newStart - drag.origStart;
    drag.clip.start = newStart;
    drag.clip.duration = drag.origDuration - delta;
    drag.clip.trimIn = drag.origTrimIn + delta;
  } else {
    let newDuration = drag.origDuration + dxSec;
    newDuration = Math.max(MIN_DURATION, newDuration);
    drag.clip.duration = newDuration;
    drag.clip.trimOut = drag.clip.trimIn + newDuration;
  }

  if (drag.el) {
    drag.el.style.left = `${drag.clip.start * drag.pxPerSec}px`;
    drag.el.style.width = `${Math.max(drag.clip.duration * drag.pxPerSec, 8)}px`;
  }
}

/* ---- SHARED DRAG END ---- */
function endDrag() {
  window.removeEventListener('pointermove', onMoveDrag);
  window.removeEventListener('pointermove', onTrimDrag);
  window.removeEventListener('pointerup', endDrag);
  if (!drag) return;

  if (drag.kind === 'move') {
    for (const item of drag.clips) {
      item.el?.classList.remove('dragging', 'invalid');
      if (item.clip._pendingStart !== undefined) {
        item.clip.start = item.clip._pendingStart;
        delete item.clip._pendingStart;
      }
      if (drag.clips.length === 1 && drag._hoverTrack && drag._hoverTrack.id !== item.origTrackId) {
        moveClipToTrack(item.clip, item.origTrackId, drag._hoverTrack.id);
      }
    }
    resolveOverlaps(drag.clips.map(i => i.clip));
    elTracks.querySelectorAll('.cf-snap-guide').forEach(el => el.remove());
    ctx.AppState.markDirty('timeline:clipsMoved', {});
    renderAll();
  } else if (drag.kind === 'trim') {
    ctx.AppState.markDirty('timeline:clipTrimmed', { clipId: drag.clip.id });
    renderAll();
  }

  drag = null;
}

function moveClipToTrack(clip, fromTrackId, toTrackId) {
  const fromTrack = ctx.AppState.getTrackById(fromTrackId);
  const toTrack = ctx.AppState.getTrackById(toTrackId);
  if (!fromTrack || !toTrack) return;
  fromTrack.clips = fromTrack.clips.filter(c => c.id !== clip.id);
  clip.trackId = toTrackId;
  toTrack.clips.push(clip);
}

function resolveOverlaps(movedClips) {
  const affectedTrackIds = new Set(movedClips.map(c => c.trackId));
  for (const trackId of affectedTrackIds) {
    const track = ctx.AppState.getTrackById(trackId);
    if (!track) continue;
    track.clips.sort((a, b) => a.start - b.start);
    for (let i = 1; i < track.clips.length; i++) {
      const prev = track.clips[i - 1];
      const cur = track.clips[i];
      const prevEnd = prev.start + prev.duration;
      if (cur.start < prevEnd) cur.start = prevEnd;
    }
  }
}

/* ---------------- MEDIA DROP-ON-TIMELINE ---------------- */
function wireTrackDropTarget(rowEl, track) {
  rowEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    rowEl.classList.add('drag-target');
  });
  rowEl.addEventListener('dragleave', () => rowEl.classList.remove('drag-target'));
  rowEl.addEventListener('drop', (e) => {
    e.preventDefault();
    rowEl.classList.remove('drag-target');
    const mediaId = e.dataTransfer.getData('text/cutflow-media-id');
    if (!mediaId) return;
    const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;
    const rect = rowEl.getBoundingClientRect();
    const dropX = e.clientX - rect.left;
    const start = Math.max(0, dropX / pxPerSec);
    ctx.bus.emit('media:dropOnTimeline', { mediaId, trackId: track.id, start });
  });
}

function onMediaDropped({ mediaId, trackId, start }) {
  const media = ctx.AppState.getMediaById(mediaId);
  if (!media) return;
  const duration = media.duration || 5;
  addClip(trackId, { mediaId, start, duration, trimIn: 0, trimOut: duration, label: media.name });
}

/* ---------------- SELECTION HIGHLIGHT ---------------- */
function renderSelectionHighlight() {
  const selected = new Set(ctx.AppState.project.selection.clipIds);
  elTracks.querySelectorAll('.cf-clip').forEach(el => {
    el.classList.toggle('selected', selected.has(el.dataset.clipId));
  });
}

/* ---------------- MARQUEE MULTI-SELECT + BACKGROUND CLICK ---------------- */
function wireTracksSurface() {
  let marqueeEl = null;
  let marqueeStart = null;

  elTracks.addEventListener('pointerdown', (e) => {
    if (e.target !== elTracks && !e.target.classList.contains('cf-track')) return;
    if (ctx.AppState.project.timelineView.activeTool === 'cut') return;

    if (!e.shiftKey) clearSelection();

    const rect = elTracks.getBoundingClientRect();
    marqueeStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    marqueeEl = document.createElement('div');
    marqueeEl.className = 'cf-selection-marquee';
    elTracks.appendChild(marqueeEl);

    const onMove = (ev) => {
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const left = Math.min(marqueeStart.x, x);
      const top = Math.min(marqueeStart.y, y);
      marqueeEl.style.left = `${left}px`;
      marqueeEl.style.top = `${top}px`;
      marqueeEl.style.width = `${Math.abs(x - marqueeStart.x)}px`;
      marqueeEl.style.height = `${Math.abs(y - marqueeStart.y)}px`;
      previewMarqueeSelection(left, top, Math.abs(x - marqueeStart.x), Math.abs(y - marqueeStart.y));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      marqueeEl?.remove();
      marqueeEl = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  elTracks.addEventListener('contextmenu', (e) => {
    if (e.target !== elTracks && !e.target.classList.contains('cf-track')) return;
    e.preventDefault();
    ctx.bus.emit('contextmenu:request', { x: e.clientX, y: e.clientY, kind: 'timeline' });
  });
}

function previewMarqueeSelection(left, top, width, height) {
  const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;
  const tMin = left / pxPerSec;
  const tMax = (left + width) / pxPerSec;
  const ids = [];
  let offset = 0;
  for (const track of ctx.AppState.project.tracks) {
    const h = track.type === 'audio' ? 44 : 56;
    const trackOverlapsY = top < offset + h && top + height > offset;
    if (trackOverlapsY) {
      for (const clip of track.clips) {
        const clipEnd = clip.start + clip.duration;
        if (clipEnd > tMin && clip.start < tMax) ids.push(clip.id);
      }
    }
    offset += h;
  }
  selectClips(ids);
}

/* ---------------- KEYBOARD MODIFIERS ---------------- */
function wireKeyboardModifiers() {
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (ctx.AppState.project.selection.clipIds.length === 0) return;
      e.preventDefault();
      if (e.shiftKey) rippleDeleteSelected();
      else deleteSelected();
    }
  });
}

function isTypingTarget(el) {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  addClip,
  addTrack,
  removeTrack,
  selectClips,
  clearSelection,
  splitAtPlayhead,
  rippleDeleteSelected,
  deleteSelected,
  markIn,
  markOut,
  setZoom,
  zoomToFit,
  setActiveTool,
  updatePlayheadX,
  renderAll,
  renderRuler,
  formatTimecodeFull,
  formatTimecodeShort,
};
