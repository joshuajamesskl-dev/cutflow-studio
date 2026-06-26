/* ============================================================
   CutFlow Studio — player.js
   Owns: AppState.project.playback (read/write), canvas rendering loop.
   Reads (does not own): tracks/clips (timeline.js), media (mediaManager.js),
   effects (effects.js), keyframes (keyframes.js), transitions (transitions.js),
   text (text.js).

   ARCHITECTURE NOTE (read this before touching the file):
   We do NOT play video by calling .play() on a single source element.
   With N overlapping tracks there is no single "the video" to drive
   playback timing — instead WE are the clock. On every rAF tick we:
     1. advance AppState.project.playback.currentTime ourselves
     2. ask each track which clip (if any) is active at that time
     3. seek that clip's underlying <video>/<img> source to the right
        SOURCE time (clip.trimIn + offsetIntoClip)
     4. draw each active source to the canvas, bottom track to top
     5. composite effects/keyframes/transitions/text on top

   This is the standard approach for browser multi-track editors and
   is what makes scrubbing, multi-track compositing, and frame-accurate
   export (export.js reuses drawFrameAt) possible at all.
   ============================================================ */

let ctx; // { AppState, bus, history, makeId, showToast, setStatus }

let canvas, canvasCtx;
let rafHandle = null;
let lastFrameTime = null; // performance.now() of previous rAF tick, for delta-time playback

/* Cache of <video>/<img> elements actively attached to the canvas this frame,
   so we can detect "this source is no longer needed" and pause it (saves CPU/decode). */
let activeSourceIds = new Set();

function init(_ctx) {
  ctx = _ctx;
  canvas = document.getElementById('preview-canvas');
  canvasCtx = canvas.getContext('2d', { alpha: false });

  wireTransportControls();
  wireQualitySelect();
  wireScrubKeys();

  ctx.bus.on('playback:seek', ({ time }) => seekTo(time, { fromUser: true }));
  ctx.bus.on('timeline:rendered', () => { if (!ctx.AppState.project.playback.isPlaying) renderCurrentFrame(); });
  ctx.bus.on('project:replaced', () => { stop(); renderCurrentFrame(); });
  ctx.bus.on('history:restored', () => renderCurrentFrame());
  ctx.bus.on('media:ready', () => renderCurrentFrame()); // a thumbnail/video element finished loading

  applyCanvasResolution();
  updateTimecodeReadouts();
  renderCurrentFrame();
}

/* ---------------- TRANSPORT WIRING ---------------- */
function wireTransportControls() {
  const btnPlayPause = document.getElementById('btn-play-pause');
  btnPlayPause?.addEventListener('click', togglePlay);

  document.getElementById('btn-step-back')?.addEventListener('click', () => stepFrame(-1));
  document.getElementById('btn-step-fwd')?.addEventListener('click', () => stepFrame(1));
  document.getElementById('btn-fullscreen-preview')?.addEventListener('click', toggleFullscreen);
}

function wireQualitySelect() {
  const sel = document.getElementById('select-quality');
  if (!sel) return;
  sel.value = String(ctx.AppState.project.playback.quality);
  sel.addEventListener('change', () => {
    ctx.AppState.project.playback.quality = Number(sel.value);
    applyCanvasResolution();
    renderCurrentFrame();
  });
}

function wireScrubKeys() {
  // Space/J/K/L/arrow keys are dispatched centrally by shortcuts.js, which
  // calls the exported functions below — we don't attach our own global
  // keydown listener here to avoid double-handling the same keys.
}

/* ---------------- PLAY / PAUSE / TRANSPORT ---------------- */
function togglePlay() {
  if (ctx.AppState.project.playback.isPlaying) pause();
  else play();
}

function play() {
  const { project } = ctx.AppState;
  if (project.playback.isPlaying) return;
  // If we're at (or past) the end, restart from 0 — matches user expectation
  // of pressing play again after watching to the end.
  if (project.playback.currentTime >= ctx.AppState.getDuration()) {
    project.playback.currentTime = 0;
  }
  project.playback.isPlaying = true;
  lastFrameTime = null;
  setPlayIcon(true);
  rafHandle = requestAnimationFrame(tick);
  ctx.bus.emit('playback:stateChanged', { isPlaying: true });
}

function pause() {
  const { project } = ctx.AppState;
  if (!project.playback.isPlaying) return;
  project.playback.isPlaying = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  pauseAllSources();
  setPlayIcon(false);
  ctx.bus.emit('playback:stateChanged', { isPlaying: false });
}

function stop() {
  pause();
  seekTo(0);
}

function setPlayIcon(isPlaying) {
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  if (iconPlay) iconPlay.style.display = isPlaying ? 'none' : '';
  if (iconPause) iconPause.style.display = isPlaying ? '' : 'none';
}

function tick(now) {
  const { project } = ctx.AppState;
  if (!project.playback.isPlaying) return;

  if (lastFrameTime === null) lastFrameTime = now;
  const deltaSec = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  project.playback.currentTime += deltaSec;

  const duration = ctx.AppState.getDuration();
  if (project.playback.currentTime >= duration) {
    project.playback.currentTime = duration;
    pause();
    renderFrameAt(duration);
    updateTimecodeReadouts();
    ctx.bus.emit('playback:tick', { time: duration });
    return;
  }

  renderFrameAt(project.playback.currentTime);
  updateTimecodeReadouts();
  syncTimelinePlayheadX();
  ctx.bus.emit('playback:tick', { time: project.playback.currentTime });

  rafHandle = requestAnimationFrame(tick);
}

function stepFrame(direction) {
  pause();
  const fps = ctx.AppState.project.settings.fps || 30;
  const t = ctx.AppState.project.playback.currentTime + direction / fps;
  seekTo(Math.max(0, Math.min(t, ctx.AppState.getDuration())));
}

/** Seek the playhead. fromUser=true means the request originated from the
    ruler/timeline (which already updated currentTime) — avoids a redundant
    write-then-emit loop with timeline.js's seekFromRulerEvent. */
function seekTo(time, { fromUser = false } = {}) {
  const clamped = Math.max(0, Math.min(time, Math.max(ctx.AppState.getDuration(), 0.001)));
  if (!fromUser) ctx.AppState.project.playback.currentTime = clamped;
  renderFrameAt(clamped);
  updateTimecodeReadouts();
  syncTimelinePlayheadX();
}

function syncTimelinePlayheadX() {
  // timeline.js owns the actual --playhead-x var; we just ask it to refresh.
  // (Cheap: timeline.js's updatePlayheadX only touches one CSS var, no DOM rebuild.)
  ctx.bus.emit('player:requestPlayheadSync', {});
}

function toggleFullscreen() {
  const stage = document.querySelector('.cf-preview-stage');
  if (!document.fullscreenElement) stage?.requestFullscreen?.();
  else document.exitFullscreen?.();
}

/* ---------------- TIMECODE READOUT ---------------- */
function updateTimecodeReadouts() {
  const { project } = ctx.AppState;
  const fps = project.settings.fps || 30;
  const elCur = document.getElementById('timecode-current');
  const elTotal = document.getElementById('timecode-total');
  if (elCur) elCur.textContent = ctx.formatTimecodeFull
    ? ctx.formatTimecodeFull(project.playback.currentTime, fps)
    : formatTimecodeFullLocal(project.playback.currentTime, fps);
  if (elTotal) elTotal.textContent = formatTimecodeFullLocal(ctx.AppState.getDuration(), fps);
}

// Local fallback copy (kept in sync with timeline.js's formatTimecodeFull) so
// player.js never throws if timeline.js hasn't attached a helper to ctx —
// ctx only carries AppState/bus/history/makeId/showToast/setStatus per app.js.
function formatTimecodeFullLocal(totalSeconds, fps = 30) {
  const totalFrames = Math.round(totalSeconds * fps);
  const ff = totalFrames % fps;
  const totalSecs = Math.floor(totalFrames / fps);
  const ss = totalSecs % 60;
  const mm = Math.floor(totalSecs / 60) % 60;
  const hh = Math.floor(totalSecs / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/* ---------------- CANVAS RESOLUTION ---------------- */
function applyCanvasResolution() {
  const { settings, playback } = ctx.AppState.project;
  const scale = playback.quality || 0.5;
  canvas.width = Math.max(2, Math.round(settings.width * scale));
  canvas.height = Math.max(2, Math.round(settings.height * scale));
}

/* ---------------- FRAME RENDERING (the core compositor) ---------------- */
function renderCurrentFrame() {
  renderFrameAt(ctx.AppState.project.playback.currentTime);
}

/** Renders the composited frame at time `t` (seconds) to the canvas.
    Exported so export.js can call this exact function per output frame —
    guarantees export pixel-matches preview. */
function renderFrameAt(t) {
  const { project } = ctx.AppState;
  const w = canvas.width, h = canvas.height;

  canvasCtx.save();
  canvasCtx.fillStyle = '#000';
  canvasCtx.fillRect(0, 0, w, h);

  const usedThisFrame = new Set();

  // Video/audio tracks first (bottom of project.tracks list = bottom of stack,
  // matching how timeline.js renders rows top-to-bottom = visual stacking order
  // for video tracks; audio tracks are skipped for drawing but still need their
  // <audio> element kept in sync for accurate scrub-preview-mute behavior, which
  // audio.js handles via the same activeSourceIds mechanism).
  const drawableTracks = project.tracks.filter(tr => tr.type !== 'audio' && !tr.muted);
  // Reverse so tracks added later (visually "on top" per timeline.js's stacking
  // convention — new video/overlay tracks unshift toward the top) draw last.
  for (const track of [...drawableTracks].reverse()) {
    const clip = findActiveClip(track, t);
    if (!clip) continue;
    drawClipFrame(track, clip, t, w, h, usedThisFrame);
  }

  pauseUnusedSources(usedThisFrame);
  canvasCtx.restore();

  ctx.bus.emit('player:frameRendered', { time: t });
}

function findActiveClip(track, t) {
  return track.clips.find(c => t >= c.start && t < c.start + c.duration) || null;
}

function drawClipFrame(track, clip, t, canvasW, canvasH, usedThisFrame) {
  const offsetIntoClip = t - clip.start;
  // clip.speed (set by keyframes.js's speed control, default 1) scales how
  // fast we advance through the SOURCE media relative to timeline time —
  // e.g. speed=2 means 1 timeline second consumes 2 seconds of source.
  const speed = clip.speed ?? 1;
  const sourceTime = clip.trimIn + offsetIntoClip * speed;

  // Transition compositing: if this clip has an active transitionIn/Out
  // overlapping `t`, transitions.js owns the actual blend draw — we delegate
  // and return early so we don't double-draw.
  const transitionHandled = tryDrawTransition(track, clip, t, canvasW, canvasH, usedThisFrame);
  if (transitionHandled) return;

  drawSingleClipLayer(track, clip, sourceTime, canvasW, canvasH, usedThisFrame);

  // Text/overlay content for this clip (text.js owns textConfig rendering).
  if (clip.textConfig) {
    ctx.bus.emit('text:renderRequest', {
      canvasCtx, clip, canvasW, canvasH, offsetIntoClip,
    });
  }
}

/* transitions.js subscribes to 'transitions:tryDraw' synchronously via a
   registered handler (see transitions.js init) rather than the async bus,
   because we need a real return value (was it handled?) this frame. We keep
   a tiny direct-call registry here to avoid a circular import. */
const transitionHandlers = [];
function registerTransitionHandler(fn) { transitionHandlers.push(fn); }
function tryDrawTransition(track, clip, t, canvasW, canvasH, usedThisFrame) {
  for (const fn of transitionHandlers) {
    const handled = fn({ track, clip, t, canvasCtx, canvasW, canvasH, usedThisFrame, drawSingleClipLayer });
    if (handled) return true;
  }
  return false;
}

/** Draws ONE clip's current source frame into the canvas, applying its
    effects chain (effects.js) and keyframe-resolved transform (keyframes.js).
    targetCtx defaults to the live preview canvas's context; transitions.js
    passes its own offscreen contexts here so it can render both halves of
    a blend separately before compositing them together. */
function drawSingleClipLayer(track, clip, sourceTime, canvasW, canvasH, usedThisFrame, targetCtx = canvasCtx) {
  const media = ctx.AppState.getMediaById(clip.mediaId);
  if (!media) return;

  const sourceEl = getSourceElementFor(media);
  if (!sourceEl) return;

  usedThisFrame.add(media.id);
  seekSourceIfNeeded(sourceEl, media, sourceTime);

  const xform = resolveKeyframes(clip, sourceTime - clip.trimIn);

  targetCtx.save();
  targetCtx.globalAlpha = xform.opacity;

  const drawn = applyEffectsAndDraw(sourceEl, clip, xform, canvasW, canvasH, targetCtx);
  if (!drawn) {
    drawSourceWithTransform(sourceEl, xform, canvasW, canvasH, targetCtx);
  }

  targetCtx.restore();
}

function drawSourceWithTransform(sourceEl, xform, canvasW, canvasH, targetCtx = canvasCtx) {
  const srcW = sourceEl.videoWidth || sourceEl.naturalWidth || canvasW;
  const srcH = sourceEl.videoHeight || sourceEl.naturalHeight || canvasH;
  if (!srcW || !srcH) return;

  // "Contain" fit by default inside the canvas, then apply keyframed
  // position (px offset from center)/scale/rotation on top.
  const fitScale = Math.min(canvasW / srcW, canvasH / srcH);
  const drawW = srcW * fitScale * xform.scale;
  const drawH = srcH * fitScale * xform.scale;
  const cx = canvasW / 2 + xform.x;
  const cy = canvasH / 2 + xform.y;

  targetCtx.translate(cx, cy);
  targetCtx.rotate((xform.rotation || 0) * Math.PI / 180);
  targetCtx.drawImage(sourceEl, -drawW / 2, -drawH / 2, drawW, drawH);
}

/* ---------------- KEYFRAME RESOLUTION (delegated to keyframes.js) ---------------- */
let keyframeResolver = null;
function setKeyframeResolver(fn) { keyframeResolver = fn; }
function resolveKeyframes(clip, localTime) {
  if (keyframeResolver) return keyframeResolver(clip, localTime);
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
}

/* ---------------- EFFECTS PIPELINE (delegated to effects.js) ---------------- */
let effectsPipeline = null;
function setEffectsPipeline(fn) { effectsPipeline = fn; }
/** Returns true if effects.js handled the draw (so we skip the default draw). */
function applyEffectsAndDraw(sourceEl, clip, xform, canvasW, canvasH, targetCtx = canvasCtx) {
  if (!effectsPipeline) return false;
  return effectsPipeline({ sourceEl, clip, xform, canvasCtx: targetCtx, canvasW, canvasH, drawSourceWithTransform });
}

/* ---------------- MEDIA SOURCE ELEMENT MANAGEMENT ---------------- */
/* mediaManager.js is the actual owner/creator of <video>/<img>/<audio>
   elements (keyed by media.id) since it owns import/decoding. We just ask
   for the element by id through a registered getter to avoid a circular
   import (mediaManager.js does not need to import player.js back). */
let sourceElementGetter = null;
function setSourceElementGetter(fn) { sourceElementGetter = fn; }
function getSourceElementFor(media) {
  if (!sourceElementGetter) return null;
  return sourceElementGetter(media.id);
}

function seekSourceIfNeeded(sourceEl, media, sourceTime) {
  if (media.type === 'image') return; // images have no timeline, nothing to seek
  if (sourceEl.tagName !== 'VIDEO' && sourceEl.tagName !== 'AUDIO') return;
  // Avoid redundant seeks (each one is a real decode-pipeline seek in Chrome);
  // only re-seek if drift exceeds half a frame at 30fps.
  if (Math.abs(sourceEl.currentTime - sourceTime) > 0.017) {
    try { sourceEl.currentTime = Math.max(0, sourceTime); } catch { /* not seekable yet */ }
  }
}

function pauseUnusedSources(usedThisFrame) {
  // mediaManager.js exposes all live elements via this getter so we can pause
  // anything not drawn this frame (keeps background decode work from running
  // for clips that have scrolled out of view of the playhead).
  if (!allSourceElementsGetter) return;
  for (const [mediaId, el] of allSourceElementsGetter()) {
    if (!usedThisFrame.has(mediaId) && el.tagName === 'VIDEO' && !el.paused) {
      el.pause();
    }
  }
  activeSourceIds = usedThisFrame;
}

let allSourceElementsGetter = null;
function setAllSourceElementsGetter(fn) { allSourceElementsGetter = fn; }

function pauseAllSources() {
  if (!allSourceElementsGetter) return;
  for (const [, el] of allSourceElementsGetter()) {
    if (el.tagName === 'VIDEO' && !el.paused) el.pause();
  }
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  play,
  pause,
  stop,
  togglePlay,
  stepFrame,
  seekTo,
  renderCurrentFrame,
  renderFrameAt,
  setKeyframeResolver,
  setEffectsPipeline,
  setSourceElementGetter,
  setAllSourceElementsGetter,
  registerTransitionHandler,
  drawSourceWithTransform,
};
