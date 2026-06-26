/* ============================================================
   CutFlow Studio — projectManager.js
   Owns: persistence. Two IndexedDB object stores:
     - 'projects'      : { id, name, createdAt, modifiedAt, projectJSON }
     - 'mediaBlobs'     : { id (== "<projectId>:<mediaId>"), blob }
   Project JSON (AppState.project) is metadata-only (see mediaManager.js
   header) so it serializes cheaply; the actual media Blobs are saved
   separately, keyed by project so re-opening a project can re-hydrate
   mediaManager's blobStore.

   Autosave fires 30s after the last dirty-marking action, debounced
   (not a dumb fixed-interval timer) so we don't write mid-keystroke.
   ============================================================ */

let ctx;

const DB_NAME = 'cutflow-studio';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_BLOBS = 'mediaBlobs';
const AUTOSAVE_DEBOUNCE_MS = 30000;
const RECENT_LIST_KEY = 'cutflow:recentProjectIds';

let db = null;
let autosaveTimer = null;
let mediaManagerRef = null; // set via setMediaManagerBlobAccess to read/write blobStore without a circular import

function init(_ctx) {
  ctx = _ctx;
  wireMenuActions();
  wireAutosaveIndicator();

  openDb()
    .then(() => {
      ctx.setStatus('Ready');
      maybeOfferLastProject();
    })
    .catch(err => {
      console.error('[projectManager] IndexedDB unavailable:', err);
      ctx.showToast('Project storage unavailable — autosave disabled', 'warning');
    });

  ctx.bus.on('state:dirty', scheduleAutosave);
}

/* mediaManager.js doesn't expose its blobStore publicly (by design — it's
   module-local). We ask it for a serialization-friendly accessor the same
   way player.js gets its source-element getters, to avoid reaching into
   another module's internals directly. */
function setMediaBlobAccess({ getAllBlobs, restoreBlobs }) {
  mediaManagerRef = { getAllBlobs, restoreBlobs };
}

/* ---------------- INDEXEDDB SETUP ---------------- */
function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB not supported')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const _db = req.result;
      if (!_db.objectStoreNames.contains(STORE_PROJECTS)) {
        _db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!_db.objectStoreNames.contains(STORE_BLOBS)) {
        _db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

/* ---------------- SAVE ---------------- */
async function saveProject({ silent = false } = {}) {
  if (!db) { if (!silent) ctx.showToast('Storage unavailable', 'error'); return false; }
  const { project } = ctx.AppState;

  try {
    setAutosaveIndicator('saving');

    const record = {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      modifiedAt: Date.now(),
      projectJSON: JSON.stringify(project),
    };
    await idbPut(STORE_PROJECTS, record);

    if (mediaManagerRef) {
      const blobs = mediaManagerRef.getAllBlobs(); // Map<mediaId, Blob>
      for (const [mediaId, blob] of blobs) {
        await idbPut(STORE_BLOBS, { id: `${project.id}:${mediaId}`, blob });
      }
    }

    addToRecentList(project.id);
    ctx.AppState.isDirty = false;
    setAutosaveIndicator('saved');
    if (!silent) ctx.showToast('Project saved', 'success');
    return true;
  } catch (err) {
    console.error('[projectManager] save failed:', err);
    setAutosaveIndicator('');
    if (!silent) ctx.showToast('Save failed — see console', 'error');
    return false;
  }
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readonly').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- LOAD ---------------- */
async function loadProject(projectId) {
  if (!db) return false;
  try {
    const record = await idbGet(STORE_PROJECTS, projectId);
    if (!record) { ctx.showToast('Project not found', 'error'); return false; }

    const project = JSON.parse(record.projectJSON);

    if (mediaManagerRef) {
      const allBlobRecords = await idbGetAll(STORE_BLOBS);
      const prefix = `${projectId}:`;
      const restored = new Map();
      for (const rec of allBlobRecords) {
        if (rec.id.startsWith(prefix)) {
          restored.set(rec.id.slice(prefix.length), rec.blob);
        }
      }
      mediaManagerRef.restoreBlobs(restored);
    }

    ctx.history.past = [];
    ctx.history.future = [];
    ctx.AppState.setProject(project);
    ctx.AppState.isDirty = false;
    addToRecentList(projectId);
    ctx.showToast(`Opened "${project.name}"`, 'success');
    return true;
  } catch (err) {
    console.error('[projectManager] load failed:', err);
    ctx.showToast('Failed to open project — see console', 'error');
    return false;
  }
}

async function deleteProject(projectId) {
  if (!db) return;
  await idbDelete(STORE_PROJECTS, projectId);
  const allBlobRecords = await idbGetAll(STORE_BLOBS);
  const prefix = `${projectId}:`;
  for (const rec of allBlobRecords) {
    if (rec.id.startsWith(prefix)) await idbDelete(STORE_BLOBS, rec.id);
  }
  removeFromRecentList(projectId);
}

async function listProjects() {
  if (!db) return [];
  const all = await idbGetAll(STORE_PROJECTS);
  return all
    .map(r => ({ id: r.id, name: r.name, createdAt: r.createdAt, modifiedAt: r.modifiedAt }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/* ---------------- NEW PROJECT ---------------- */
function newProject() {
  if (ctx.AppState.isDirty) {
    const proceed = window.confirm('Discard unsaved changes and start a new project?');
    if (!proceed) return;
  }
  ctx.history.past = [];
  ctx.history.future = [];
  // Re-use app.js's default shape by asking AppState for a fresh one via
  // setProject — we can't import createDefaultProject() (not exported, by
  // design, to keep one canonical creation path), so we ask the module that
  // owns it: app.js exposes AppState already holding a fresh default at
  // boot, and timeline.js listens for project:replaced to rebuild default
  // tracks if the incoming project has none.
  const fresh = structuredClone(ctx.AppState.project);
  fresh.id = ctx.makeId('proj');
  fresh.name = 'Untitled Project';
  fresh.createdAt = Date.now();
  fresh.modifiedAt = Date.now();
  fresh.media = [];
  fresh.tracks = [];
  fresh.selection = { clipIds: [], mediaId: null };
  fresh.markers = { inPoint: null, outPoint: null };
  fresh.playback = { currentTime: 0, isPlaying: false, quality: 0.5 };
  ctx.AppState.setProject(fresh);
  ctx.AppState.isDirty = false;
  document.getElementById('project-name').textContent = fresh.name;
  ctx.showToast('New project created', 'success');
}

/* ---------------- RECENT PROJECTS LIST (localStorage — tiny, no need for IDB) ---------------- */
function getRecentList() {
  try { return JSON.parse(localStorage.getItem(RECENT_LIST_KEY) || '[]'); }
  catch { return []; }
}

function addToRecentList(projectId) {
  let list = getRecentList().filter(id => id !== projectId);
  list.unshift(projectId);
  list = list.slice(0, 10);
  localStorage.setItem(RECENT_LIST_KEY, JSON.stringify(list));
}

function removeFromRecentList(projectId) {
  const list = getRecentList().filter(id => id !== projectId);
  localStorage.setItem(RECENT_LIST_KEY, JSON.stringify(list));
}

async function getRecentProjects() {
  const ids = getRecentList();
  const out = [];
  for (const id of ids) {
    const record = await idbGet(STORE_PROJECTS, id).catch(() => null);
    if (record) out.push({ id: record.id, name: record.name, modifiedAt: record.modifiedAt });
  }
  return out;
}

async function maybeOfferLastProject() {
  const recents = await getRecentProjects();
  if (recents.length === 0) return;
  ctx.bus.emit('projectManager:recentsAvailable', { recents });
}

/* ---------------- AUTOSAVE ---------------- */
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    saveProject({ silent: true });
  }, AUTOSAVE_DEBOUNCE_MS);
}

function wireAutosaveIndicator() {
  ctx.bus.on('state:dirty', () => setAutosaveIndicator('unsaved'));
}

function setAutosaveIndicator(state) {
  const el = document.getElementById('autosave-indicator');
  if (!el) return;
  el.classList.remove('saving', 'saved');
  if (state === 'saving') { el.classList.add('saving'); el.title = 'Saving…'; }
  else if (state === 'saved') { el.classList.add('saved'); el.title = 'All changes saved'; }
  else if (state === 'unsaved') { el.title = 'Unsaved changes'; }
}

/* ---------------- MENU WIRING (File menu actions live here; ui.js owns the dropdown chrome) ---------------- */
function wireMenuActions() {
  ctx.bus.on('menu:action', ({ action }) => {
    if (action === 'file:new') newProject();
    else if (action === 'file:save') saveProject();
    else if (action === 'file:open') ctx.bus.emit('ui:openProjectBrowser', {});
  });

  // Ctrl/Cmd+S
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveProject();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (ctx.AppState.isDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  setMediaBlobAccess,
  saveProject,
  loadProject,
  deleteProject,
  listProjects,
  newProject,
  getRecentProjects,
};
