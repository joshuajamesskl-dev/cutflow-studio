/* ============================================================
   CutFlow Studio — shortcuts.js
   Owns: the single global keydown listener that maps keys to actions.
   Boots LAST (per app.js's MODULES order) so every other module's
   functions already exist to be imported and called directly.

   Dual dispatch: shortcuts.js calls timeline.js/player.js functions
   directly for actions it owns the mapping for, AND listens for
   'shortcut:trigger' bus events (emitted by ui.js's menu items and
   context menus) so the same action can be invoked from a keypress OR
   a menu click without duplicating logic in two places.
   ============================================================ */

let ctx;
let timeline, player;

function init(_ctx) {
  ctx = _ctx;
  ctx.bus.on('shortcut:trigger', ({ action }) => runAction(action));
  window.addEventListener('keydown', onKeyDown);
}

import * as timelineModule from './timeline.js';
import * as playerModule from './player.js';
timeline = timelineModule;
player = playerModule;

/* J/K/L speed ramping state (held across keypresses while playing) */
let jklSpeed = 1;
let shuttleRafId = null;

function onKeyDown(e) {
  if (isTypingTarget(e.target)) return;
  if (isModalOpen()) return; // don't fire timeline shortcuts while a modal/dialog has focus

  const key = e.key;
  const lower = key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;

  // ---- Modifier combos first (so plain-key checks below don't double-fire) ----
  if (mod && lower === 'z' && e.shiftKey) { e.preventDefault(); runAction('redo'); return; }
  if (mod && lower === 'z') { e.preventDefault(); runAction('undo'); return; }
  if (mod && lower === 'a') { e.preventDefault(); runAction('selectAll'); return; }
  if (mod && lower === 'e') { e.preventDefault(); runAction('exportOpen'); return; }
  // Ctrl+S is handled directly in projectManager.js (it owns save logic);
  // we deliberately don't re-handle it here to avoid a double save call.
  if (mod && lower === 'c') { e.preventDefault(); runAction('copy'); return; }
  if (mod && lower === 'v') { e.preventDefault(); runAction('paste'); return; }

  if (e.shiftKey && key === 'Delete') { e.preventDefault(); runAction('rippleDelete'); return; }
  if (e.shiftKey && lower === 'z') { e.preventDefault(); runAction('zoomFit'); return; }

  // ---- Plain keys ----
  switch (key) {
    case ' ':
      e.preventDefault();
      runAction('playPause');
      return;
    case 'Delete':
    case 'Backspace':
      // timeline.js already handles plain Delete/Backspace itself (see its
      // wireKeyboardModifiers) since it needs first refusal for clip
      // selection state; we don't double-handle here.
      return;
    case 'ArrowLeft':
      e.preventDefault();
      runAction('stepBack');
      return;
    case 'ArrowRight':
      e.preventDefault();
      runAction('stepForward');
      return;
    case '?':
      e.preventDefault();
      runAction('showShortcuts');
      return;
    case '+':
    case '=':
      runAction('zoomIn');
      return;
    case '-':
    case '_':
      runAction('zoomOut');
      return;
  }

  switch (lower) {
    case 'c': runAction('toolCut'); return;
    case 'v': runAction('toolSelect'); return;
    case 's': runAction('split'); return;
    case 'i': runAction('markIn'); return;
    case 'o': runAction('markOut'); return;
    case 'n': runAction('toggleSnap'); return;
    case 'm': runAction('toggleMagnetic'); return;
    case 'j': runAction('jShuttle'); return;
    case 'k': runAction('kPause'); return;
    case 'l': runAction('lShuttle'); return;
  }
}

function isTypingTarget(el) {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function isModalOpen() {
  return document.getElementById('modal-root')?.children.length > 0;
}

/* ---------------- ACTION DISPATCH TABLE ---------------- */
function runAction(action) {
  switch (action) {
    case 'undo': ctx.history.undo(); break;
    case 'redo': ctx.history.redo(); break;
    case 'selectAll': selectAllClips(); break;
    case 'playPause': player.togglePlay(); break;
    case 'stepBack': player.stepFrame(-1); break;
    case 'stepForward': player.stepFrame(1); break;
    case 'split': timeline.splitAtPlayhead(); break;
    case 'delete': timeline.deleteSelected(); break;
    case 'rippleDelete': timeline.rippleDeleteSelected(); break;
    case 'markIn': timeline.markIn(); break;
    case 'markOut': timeline.markOut(); break;
    case 'toolCut': timeline.setActiveTool('cut'); break;
    case 'toolSelect': timeline.setActiveTool('select'); break;
    case 'toggleSnap': toggleSnap(); break;
    case 'toggleMagnetic': toggleMagnetic(); break;
    case 'zoomIn': timeline.setZoom(ctx.AppState.project.timelineView.pxPerSec * 1.25); break;
    case 'zoomOut': timeline.setZoom(ctx.AppState.project.timelineView.pxPerSec * 0.8); break;
    case 'zoomFit': timeline.zoomToFit(); break;
    case 'showShortcuts': ctx.bus.emit('shortcut:showCheatsheet', {}); break;
    case 'exportOpen': ctx.bus.emit('export:openDialog', {}); break;
    case 'addVideoTrack': timeline.addTrack('video'); break;
    case 'addAudioTrack': timeline.addTrack('audio'); break;
    case 'jShuttle': shuttleJ(); break;
    case 'kPause': stopShuttleAndPause(); break;
    case 'lShuttle': shuttleL(); break;
    case 'copy': copySelection(); break;
    case 'paste': pasteClipboard(); break;
    default: break;
  }
}

function selectAllClips() {
  const allIds = ctx.AppState.project.tracks.flatMap(t => t.clips.map(c => c.id));
  timeline.selectClips(allIds);
}

function toggleSnap() {
  const tv = ctx.AppState.project.timelineView;
  tv.snapEnabled = !tv.snapEnabled;
  document.getElementById('btn-snap-toggle')?.classList.toggle('active', tv.snapEnabled);
  ctx.AppState.markDirty();
}

function toggleMagnetic() {
  const tv = ctx.AppState.project.timelineView;
  tv.magneticEnabled = !tv.magneticEnabled;
  document.getElementById('btn-magnetic-toggle')?.classList.toggle('active', tv.magneticEnabled);
  ctx.AppState.markDirty();
}

/* ---------------- J/K/L SHUTTLE ---------------- */
/** Classic NLE shuttle: L increases forward speed each press (1x, 2x, 4x,
    8x), J does the same in reverse, K stops. We drive this by directly
    manipulating playback.currentTime each rAF tick rather than relying on
    <video>.playbackRate, since player.js is the one true clock (see
    player.js's architecture note) and doesn't delegate timing to any
    single source element. */
function shuttleL() {
  jklSpeed = jklSpeed <= 0 ? 1 : Math.min(8, jklSpeed * 2);
  startShuttle();
}
function shuttleJ() {
  jklSpeed = jklSpeed >= 0 ? -1 : Math.max(-8, jklSpeed * 2);
  startShuttle();
}
function stopShuttleAndPause() {
  if (shuttleRafId) { cancelAnimationFrame(shuttleRafId); shuttleRafId = null; }
  jklSpeed = 1;
  player.pause();
}
function startShuttle() {
  player.pause();
  if (shuttleRafId) cancelAnimationFrame(shuttleRafId);
  let last = performance.now();
  const step = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    const t = ctx.AppState.project.playback.currentTime + dt * jklSpeed;
    const duration = ctx.AppState.getDuration();
    const clamped = Math.max(0, Math.min(duration, t));
    player.seekTo(clamped);
    if (clamped > 0 && clamped < duration) {
      shuttleRafId = requestAnimationFrame(step);
    } else {
      shuttleRafId = null;
    }
  };
  shuttleRafId = requestAnimationFrame(step);
}

/* ---------------- CLIPBOARD (simple in-memory copy/paste) ---------------- */
let clipboard = [];
function copySelection() {
  clipboard = ctx.AppState.getSelectedClips().map(c => structuredClone(c));
  if (clipboard.length) ctx.showToast(`Copied ${clipboard.length} clip${clipboard.length > 1 ? 's' : ''}`, 'success');
}
function pasteClipboard() {
  if (clipboard.length === 0) return;
  ctx.history.capture();
  const t = ctx.AppState.project.playback.currentTime;
  const earliestStart = Math.min(...clipboard.map(c => c.start));
  const newIds = [];
  for (const clip of clipboard) {
    const track = ctx.AppState.getTrackById(clip.trackId);
    if (!track) continue;
    const offset = clip.start - earliestStart;
    const newClip = { ...structuredClone(clip), id: ctx.makeId('clip'), start: t + offset };
    track.clips.push(newClip);
    track.clips.sort((a, b) => a.start - b.start);
    newIds.push(newClip.id);
  }
  ctx.AppState.markDirty('timeline:pasted', { newIds });
  timeline.renderAll();
  timeline.selectClips(newIds);
}

/* ---------------- EXPORTS ---------------- */
export { init, runAction };
