/* ============================================================
   CutFlow Studio — transitions.js
   Owns: clip.transitionIn / clip.transitionOut ({ type, duration } | null),
   the transitions browser (left panel), the .cf-clip-transition DOM
   markers on the timeline, and the actual canvas blend rendering during
   a transition window.

   A transition lives "on" the edge between two adjacent clips on the SAME
   track. transitionOut on clip A and transitionIn on clip B describe the
   same logical transition (duration kept in sync by applyTransitionBetween).
   During the overlap window we draw BOTH clips' frames and blend per the
   transition's draw function.

   12 real, distinct blended transitions plus "cut" (no-op, included in the
   browser list for completeness): dissolve, dip-to-black, dip-to-white,
   wipe-left/right/up/down, slide-left/right, zoom-in/out, glitch.
   ============================================================ */

let ctx;
let player;

const TRANSITION_DEFS = [
  { id: 'cut', label: 'Cut', icon: '✂', defaultDuration: 0 },
  { id: 'dissolve', label: 'Dissolve', icon: '◐', defaultDuration: 0.5 },
  { id: 'dip-to-black', label: 'Dip to Black', icon: '⬛', defaultDuration: 0.5 },
  { id: 'dip-to-white', label: 'Dip to White', icon: '⬜', defaultDuration: 0.5 },
  { id: 'wipe-left', label: 'Wipe Left', icon: '◀', defaultDuration: 0.6 },
  { id: 'wipe-right', label: 'Wipe Right', icon: '▶', defaultDuration: 0.6 },
  { id: 'wipe-up', label: 'Wipe Up', icon: '▲', defaultDuration: 0.6 },
  { id: 'wipe-down', label: 'Wipe Down', icon: '▼', defaultDuration: 0.6 },
  { id: 'slide-left', label: 'Slide Left', icon: '⇤', defaultDuration: 0.6 },
  { id: 'slide-right', label: 'Slide Right', icon: '⇥', defaultDuration: 0.6 },
  { id: 'zoom-in', label: 'Zoom In', icon: '⊕', defaultDuration: 0.5 },
  { id: 'zoom-out', label: 'Zoom Out', icon: '⊖', defaultDuration: 0.5 },
  { id: 'glitch', label: 'Glitch', icon: '⚡', defaultDuration: 0.4 },
];

function init(_ctx) {
  ctx = _ctx;
  renderTransitionsBrowser();
  wireTransitionsSearch();
  ctx.bus.on('timeline:rendered', renderTransitionMarkers);
}

import * as playerModule from './player.js';
player = playerModule;
player.registerTransitionHandler(tryDrawTransition);

/* ---------------- BROWSER (left panel) ---------------- */
function renderTransitionsBrowser(filter = '') {
  const list = document.getElementById('transitions-list');
  if (!list) return;
  list.innerHTML = '';
  for (const def of TRANSITION_DEFS) {
    if (filter && !def.label.toLowerCase().includes(filter.toLowerCase())) continue;
    list.appendChild(buildTransitionListItem(def));
  }
}

function buildTransitionListItem(def) {
  const item = document.createElement('div');
  item.className = 'cf-fx-item';
  item.draggable = true;

  const icon = document.createElement('div');
  icon.className = 'cf-fx-item-icon';
  icon.textContent = def.icon;
  item.appendChild(icon);

  const label = document.createElement('div');
  label.className = 'cf-fx-item-label';
  label.textContent = def.label;
  item.appendChild(label);

  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/cutflow-transition-id', def.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  // Double-click applies to the OUT edge of the single selected clip and
  // the IN edge of whatever clip follows it on the same track, if adjacent.
  item.addEventListener('dblclick', () => {
    const clips = ctx.AppState.getSelectedClips();
    if (clips.length !== 1) { ctx.showToast('Select exactly one clip', 'warning'); return; }
    const track = ctx.AppState.getTrackForClip(clips[0].id);
    const next = findNextAdjacentClip(track, clips[0]);
    if (!next) { ctx.showToast('No adjacent clip to transition into', 'warning'); return; }
    applyTransitionBetween(clips[0], next, def.id, def.defaultDuration);
    ctx.showToast(`Added ${def.label} transition`, 'success');
  });

  return item;
}

function wireTransitionsSearch() {
  document.getElementById('transitions-search')?.addEventListener('input', (e) => {
    renderTransitionsBrowser(e.target.value);
  });
}

function findNextAdjacentClip(track, clip) {
  if (!track) return null;
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  const idx = sorted.findIndex(c => c.id === clip.id);
  if (idx === -1 || idx === sorted.length - 1) return null;
  return sorted[idx + 1];
}

function findPrevAdjacentClip(track, clip) {
  if (!track) return null;
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  const idx = sorted.findIndex(c => c.id === clip.id);
  if (idx <= 0) return null;
  return sorted[idx - 1];
}

/* ---------------- APPLYING A TRANSITION ---------------- */
function applyTransitionBetween(clipA, clipB, transitionType, duration) {
  ctx.history.capture();
  const maxDuration = Math.min(clipA.duration, clipB.duration) * 0.9;
  const clamped = Math.max(0.05, Math.min(duration, maxDuration));

  clipA.transitionOut = transitionType === 'cut' ? null : { type: transitionType, duration: clamped };
  clipB.transitionIn = transitionType === 'cut' ? null : { type: transitionType, duration: clamped };

  ctx.AppState.markDirty('transitions:applied', { clipAId: clipA.id, clipBId: clipB.id });
  player.renderCurrentFrame();
  ctx.bus.emit('timeline:rendered', {}); // refresh .cf-clip-transition markers
}

function removeTransition(clip, edge) {
  ctx.history.capture();
  if (edge === 'out') clip.transitionOut = null;
  else clip.transitionIn = null;
  ctx.AppState.markDirty('transitions:removed', { clipId: clip.id, edge });
  player.renderCurrentFrame();
  ctx.bus.emit('timeline:rendered', {});
}

function setTransitionDuration(clip, edge, duration) {
  const t = edge === 'out' ? clip.transitionOut : clip.transitionIn;
  if (!t) return;
  ctx.history.capture();
  t.duration = Math.max(0.05, duration);
  ctx.AppState.markDirty('transitions:durationChanged', { clipId: clip.id, edge });
  player.renderCurrentFrame();
}

/* ---------------- TIMELINE MARKERS (.cf-clip-transition diagonal blocks) ---------------- */
function renderTransitionMarkers() {
  document.querySelectorAll('.cf-clip-transition').forEach(el => el.remove());
  const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;

  for (const track of ctx.AppState.project.tracks) {
    for (const clip of track.clips) {
      if (clip.transitionOut) {
        appendTransitionMarker(clip, clip.transitionOut.duration, pxPerSec);
      }
    }
  }
}

function appendTransitionMarker(clip, duration, pxPerSec) {
  const clipEl = document.querySelector(`.cf-clip[data-clip-id="${clip.id}"]`);
  if (!clipEl) return;
  const marker = document.createElement('div');
  marker.className = 'cf-clip-transition';
  marker.style.width = `${Math.max(8, duration * pxPerSec)}px`;
  marker.style.right = '0';
  marker.title = `${clip.transitionOut.type} (${duration.toFixed(2)}s) — click to remove`;
  marker.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTransition(clip, 'out');
  });
  clipEl.appendChild(marker);
}

/* ---------------- RENDER-TIME BLEND (called by player.js per drawn clip) ---------------- */
/** Returns true if we handled drawing this clip (because it's mid-transition),
    false to let player.js fall back to the normal single-clip draw. */
function tryDrawTransition({ track, clip, t, canvasCtx, canvasW, canvasH, drawSingleClipLayer }) {
  // Outgoing transition: we're in the LAST `duration` seconds of `clip`,
  // and there's a next clip on the same track to blend into. Since
  // findActiveClip() in player.js only returns ONE active clip per track
  // per frame (the one whose [start, start+duration) contains t), and that
  // window naturally extends through the transition because clip.duration
  // already includes it, this branch is what actually fires during overlap.
  if (clip.transitionOut) {
    const trans = clip.transitionOut;
    const windowStart = clip.start + clip.duration - trans.duration;
    if (t >= windowStart && t < clip.start + clip.duration) {
      const next = findNextAdjacentClip(track, clip);
      if (next) {
        const progress = (t - windowStart) / trans.duration; // 0..1
        drawBlend(trans.type, progress, track, clip, next, t, canvasCtx, canvasW, canvasH, drawSingleClipLayer);
        return true;
      }
    }
  }
  return false;
}

function drawBlend(type, progress, track, clipA, clipB, t, canvasCtx, canvasW, canvasH, drawSingleClipLayer) {
  const p = Math.max(0, Math.min(1, progress));

  const offA = getOffscreen('transA', canvasW, canvasH);
  const offB = getOffscreen('transB', canvasW, canvasH);
  clearCanvas(offA.ctx, canvasW, canvasH);
  clearCanvas(offB.ctx, canvasW, canvasH);

  const sourceTimeA = clipA.trimIn + (t - clipA.start);
  const sourceTimeB = clipB.trimIn + (t - clipB.start);
  drawSingleClipLayer(track, clipA, sourceTimeA, canvasW, canvasH, new Set(), offA.ctx);
  drawSingleClipLayer(track, clipB, sourceTimeB, canvasW, canvasH, new Set(), offB.ctx);

  const blendFn = BLEND_FNS[type] || BLEND_FNS.dissolve;
  blendFn(canvasCtx, offA.canvas, offB.canvas, p, canvasW, canvasH);
}

const offscreenCache = new Map();
function getOffscreen(key, w, h) {
  let entry = offscreenCache.get(key);
  if (!entry) {
    const canvas = document.createElement('canvas');
    entry = { canvas, ctx: canvas.getContext('2d') };
    offscreenCache.set(key, entry);
  }
  if (entry.canvas.width !== w) entry.canvas.width = w;
  if (entry.canvas.height !== h) entry.canvas.height = h;
  return entry;
}

function clearCanvas(c, w, h) {
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#000';
  c.fillRect(0, 0, w, h);
}

/* ---------------- BLEND IMPLEMENTATIONS ---------------- */
const BLEND_FNS = {
  dissolve(ctx2d, a, b, p, w, h) {
    ctx2d.globalAlpha = 1; ctx2d.drawImage(a, 0, 0, w, h);
    ctx2d.globalAlpha = p; ctx2d.drawImage(b, 0, 0, w, h);
    ctx2d.globalAlpha = 1;
  },
  'dip-to-black'(ctx2d, a, b, p, w, h) {
    const half = p < 0.5;
    const localP = half ? p / 0.5 : (p - 0.5) / 0.5;
    ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, w, h);
    if (half) { ctx2d.globalAlpha = 1 - localP; ctx2d.drawImage(a, 0, 0, w, h); }
    else { ctx2d.globalAlpha = localP; ctx2d.drawImage(b, 0, 0, w, h); }
    ctx2d.globalAlpha = 1;
  },
  'dip-to-white'(ctx2d, a, b, p, w, h) {
    const half = p < 0.5;
    const localP = half ? p / 0.5 : (p - 0.5) / 0.5;
    ctx2d.fillStyle = '#fff'; ctx2d.fillRect(0, 0, w, h);
    if (half) { ctx2d.globalAlpha = 1 - localP; ctx2d.drawImage(a, 0, 0, w, h); }
    else { ctx2d.globalAlpha = localP; ctx2d.drawImage(b, 0, 0, w, h); }
    ctx2d.globalAlpha = 1;
  },
  'wipe-left'(ctx2d, a, b, p, w, h) { wipe(ctx2d, a, b, p, w, h, 'left'); },
  'wipe-right'(ctx2d, a, b, p, w, h) { wipe(ctx2d, a, b, p, w, h, 'right'); },
  'wipe-up'(ctx2d, a, b, p, w, h) { wipe(ctx2d, a, b, p, w, h, 'up'); },
  'wipe-down'(ctx2d, a, b, p, w, h) { wipe(ctx2d, a, b, p, w, h, 'down'); },
  'slide-left'(ctx2d, a, b, p, w, h) { slide(ctx2d, a, b, p, w, h, 'left'); },
  'slide-right'(ctx2d, a, b, p, w, h) { slide(ctx2d, a, b, p, w, h, 'right'); },
  'zoom-in'(ctx2d, a, b, p, w, h) {
    ctx2d.drawImage(a, 0, 0, w, h);
    const scale = 1 + (1 - p) * 0.5;
    ctx2d.globalAlpha = p;
    ctx2d.save();
    ctx2d.translate(w / 2, h / 2);
    ctx2d.scale(scale, scale);
    ctx2d.drawImage(b, -w / 2, -h / 2, w, h);
    ctx2d.restore();
    ctx2d.globalAlpha = 1;
  },
  'zoom-out'(ctx2d, a, b, p, w, h) {
    ctx2d.globalAlpha = 1 - p;
    ctx2d.save();
    const scaleA = 1 + p * 0.5;
    ctx2d.translate(w / 2, h / 2);
    ctx2d.scale(scaleA, scaleA);
    ctx2d.drawImage(a, -w / 2, -h / 2, w, h);
    ctx2d.restore();
    ctx2d.globalAlpha = 1;
    ctx2d.drawImage(b, 0, 0, w, h);
  },
  glitch(ctx2d, a, b, p, w, h) {
    // RGB-split-style horizontal slice displacement, intensity peaking mid-transition.
    const intensity = Math.sin(p * Math.PI); // 0 -> 1 -> 0
    const base = p < 0.5 ? a : b;
    ctx2d.drawImage(base, 0, 0, w, h);
    if (intensity < 0.02) return;
    const sliceCount = 8;
    const sliceH = h / sliceCount;
    for (let i = 0; i < sliceCount; i++) {
      const y = i * sliceH;
      const dx = (pseudoRandomT(i, p) - 0.5) * 40 * intensity;
      ctx2d.drawImage(base, 0, y, w, sliceH, dx, y, w, sliceH);
    }
  },
};

function wipe(ctx2d, a, b, p, w, h, direction) {
  ctx2d.drawImage(a, 0, 0, w, h);
  ctx2d.save();
  let rectX = 0, rectY = 0, rectW = w, rectH = h;
  if (direction === 'left') { rectW = w * p; }
  else if (direction === 'right') { rectX = w * (1 - p); rectW = w * p; }
  else if (direction === 'up') { rectH = h * p; }
  else if (direction === 'down') { rectY = h * (1 - p); rectH = h * p; }
  ctx2d.beginPath();
  ctx2d.rect(rectX, rectY, rectW, rectH);
  ctx2d.clip();
  ctx2d.drawImage(b, 0, 0, w, h);
  ctx2d.restore();
}

function slide(ctx2d, a, b, p, w, h, direction) {
  const dir = direction === 'left' ? -1 : 1;
  ctx2d.drawImage(a, dir * -w * p, 0, w, h);
  ctx2d.drawImage(b, dir * w * (1 - p), 0, w, h);
}

function pseudoRandomT(i, p) {
  const v = Math.sin(i * 12.9898 + p * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  applyTransitionBetween,
  removeTransition,
  setTransitionDuration,
  TRANSITION_DEFS,
};
