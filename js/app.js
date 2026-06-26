/* ============================================================
   CutFlow Studio — app.js
   Entry point. Owns:
     - AppState: single source of truth for project/UI state
     - bus: minimal pub/sub event bus shared across modules
     - history: undo/redo stack (snapshot-based, 100 levels)
   Boots all other modules once DOM is ready, then wires the small set of
   cross-module registrations that would otherwise create circular imports
   (mediaManager <-> projectManager blob access, export <-> ui modal access).
   ============================================================ */

/* ---------------- EVENT BUS ---------------- */
class EventBus {
  constructor() {
    this._listeners = new Map();
  }
  on(eventName, fn) {
    if (!this._listeners.has(eventName)) this._listeners.set(eventName, new Set());
    this._listeners.get(eventName).add(fn);
    return () => this.off(eventName, fn);
  }
  off(eventName, fn) {
    this._listeners.get(eventName)?.delete(fn);
  }
  emit(eventName, payload) {
    const set = this._listeners.get(eventName);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[bus] listener for "${eventName}" threw:`, err); }
    }
  }
}
export const bus = new EventBus();

/* ---------------- ID GENERATION ---------------- */
let _idCounter = 0;
export function makeId(prefix = 'id') {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter.toString(36)}`;
}

/* ---------------- TIMECODE FORMATTING (shared — used by player.js, timeline.js, export.js) ---------------- */
export function formatTimecodeFull(totalSeconds, fps = 30) {
  const totalFrames = Math.round(totalSeconds * fps);
  const ff = totalFrames % fps;
  const totalSecs = Math.floor(totalFrames / fps);
  const ss = totalSecs % 60;
  const mm = Math.floor(totalSecs / 60) % 60;
  const hh = Math.floor(totalSecs / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export function formatTimecodeShort(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/* ---------------- DEFAULT PROJECT SHAPE ---------------- */
export function createDefaultProject() {
  return {
    id: makeId('proj'),
    name: 'Untitled Project',
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
    media: [],
    tracks: [],
    selection: { clipIds: [], mediaId: null },
    markers: { inPoint: null, outPoint: null },
    playback: { currentTime: 0, isPlaying: false, quality: 0.5 },
    timelineView: {
      pxPerSec: 30, scrollLeft: 0, snapEnabled: true, magneticEnabled: true, activeTool: 'select',
    },
  };
}

/* ---------------- APP STATE ---------------- */
class AppStateClass {
  constructor() {
    this.project = createDefaultProject();
    this.isDirty = false;
    this.ui = { activeLeftTab: 'media', activeRightTab: 'properties', activeMenu: null };
  }

  setProject(project) {
    this.project = project;
    bus.emit('project:replaced', { project });
  }

  markDirty(eventName, payload) {
    this.isDirty = true;
    this.project.modifiedAt = Date.now();
    if (eventName) bus.emit(eventName, payload);
    bus.emit('state:dirty', { eventName });
  }

  getClipById(clipId) {
    for (const track of this.project.tracks) {
      const clip = track.clips.find(c => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  }

  getTrackById(trackId) {
    return this.project.tracks.find(t => t.id === trackId) || null;
  }

  getTrackForClip(clipId) {
    return this.project.tracks.find(t => t.clips.some(c => c.id === clipId)) || null;
  }

  getMediaById(mediaId) {
    return this.project.media.find(m => m.id === mediaId) || null;
  }

  getSelectedClips() {
    return this.project.selection.clipIds.map(id => this.getClipById(id)).filter(Boolean);
  }

  getDuration() {
    let max = 0;
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        const end = clip.start + clip.duration;
        if (end > max) max = end;
      }
    }
    return max;
  }
}
export const AppState = new AppStateClass();

/* ---------------- UNDO / REDO HISTORY ---------------- */
const HISTORY_LIMIT = 100;

class HistoryStack {
  constructor() {
    this.past = [];
    this.future = [];
    this._suspended = false;
  }

  capture() {
    if (this._suspended) return;
    const snapshot = structuredClone(AppState.project);
    this.past.push(snapshot);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this._emitState();
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  undo() {
    if (!this.canUndo()) return;
    const current = structuredClone(AppState.project);
    const previous = this.past.pop();
    this.future.unshift(current);
    this._restore(previous);
  }

  redo() {
    if (!this.canRedo()) return;
    const current = structuredClone(AppState.project);
    const next = this.future.shift();
    this.past.push(current);
    this._restore(next);
  }

  _restore(snapshot) {
    this._suspended = true;
    AppState.setProject(snapshot);
    AppState.isDirty = true;
    this._suspended = false;
    this._emitState();
    bus.emit('history:restored', {});
  }

  _emitState() {
    bus.emit('history:changed', { canUndo: this.canUndo(), canRedo: this.canRedo() });
  }
}
export const history = new HistoryStack();

/* ---------------- TOAST / STATUS HELPERS ---------------- */
export function showToast(message, type = 'info', duration = 3500) {
  bus.emit('toast:show', { message, type, duration });
}
export function setStatus(message) {
  bus.emit('status:set', { message });
}

/* ============================================================
   MODULE BOOT SEQUENCE
   ============================================================ */
import * as ui from './ui.js';
import * as projectManager from './projectManager.js';
import * as mediaManager from './mediaManager.js';
import * as timeline from './timeline.js';
import * as player from './player.js';
import * as effects from './effects.js';
import * as audio from './audio.js';
import * as keyframes from './keyframes.js';
import * as transitions from './transitions.js';
import * as text from './text.js';
import * as exportEngine from './export.js';
import * as shortcuts from './shortcuts.js';

const ctx = { AppState, bus, history, makeId, showToast, setStatus, formatTimecodeFull, formatTimecodeShort };

const MODULES = [
  ['ui', ui],
  ['projectManager', projectManager],
  ['mediaManager', mediaManager],
  ['timeline', timeline],
  ['player', player],
  ['effects', effects],
  ['audio', audio],
  ['keyframes', keyframes],
  ['transitions', transitions],
  ['text', text],
  ['exportEngine', exportEngine],
  ['shortcuts', shortcuts],
];

function bootApp() {
  console.log('[CutFlow] booting…');

  for (const [name, mod] of MODULES) {
    try {
      if (typeof mod.init === 'function') mod.init(ctx);
      else console.warn(`[CutFlow] module "${name}" has no init() — skipping`);
    } catch (err) {
      console.error(`[CutFlow] module "${name}" failed to init:`, err);
      showToast(`${name} failed to load — some features may be unavailable`, 'error');
    }
  }

  /* ---- Cross-module registrations (avoid circular imports) ---- */
  // mediaManager <-> projectManager: projectManager needs to read/write
  // mediaManager's blobStore for save/load without importing it directly
  // (projectManager already imports nothing from mediaManager; mediaManager
  // exposes the two accessor functions it needs here).
  projectManager.setMediaBlobAccess({
    getAllBlobs: mediaManager.getAllBlobsForPersistence,
    restoreBlobs: mediaManager.restoreBlobsFromPersistence,
  });

  // audio.js needs mediaManager's pool getter + blob accessor, and needs to
  // be able to register newly-derived assets (e.g. denoised audio output)
  // back into mediaManager's store.
  audio.setMediaPoolGetter(mediaManager.getElementForClip);
  audio.setBlobAccessor(mediaManager.getBlobForMedia);
  audio.setDerivedAssetRegistrar(mediaManager.registerDerivedAsset);

  // export.js needs the same blob accessor (for OfflineAudioContext
  // decoding) and needs ui.js's generic modal API to render its dialog.
  exportEngine.setExportBlobAccessor(mediaManager.getBlobForMedia);
  exportEngine.setUiModule(ui);

  // ui.js needs projectManager for its "Open Project" browser modal.
  ui.setProjectManager(projectManager);

  /* ---- App-shell chrome not owned by any single feature module ---- */
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  btnUndo?.addEventListener('click', () => history.undo());
  btnRedo?.addEventListener('click', () => history.redo());
  bus.on('history:changed', ({ canUndo, canRedo }) => {
    if (btnUndo) btnUndo.disabled = !canUndo;
    if (btnRedo) btnRedo.disabled = !canRedo;
  });

  const projectNameEl = document.getElementById('project-name');
  if (projectNameEl) {
    projectNameEl.textContent = AppState.project.name;
    projectNameEl.addEventListener('blur', () => {
      const newName = projectNameEl.textContent.trim() || 'Untitled Project';
      projectNameEl.textContent = newName;
      if (newName !== AppState.project.name) {
        history.capture();
        AppState.project.name = newName;
        AppState.markDirty('project:renamed', { name: newName });
      }
    });
    projectNameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); projectNameEl.blur(); }
    });
  }

  bus.emit('app:ready', {});
  console.log('[CutFlow] ready.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}
