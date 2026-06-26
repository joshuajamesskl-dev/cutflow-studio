/* ============================================================
   CutFlow Studio — ui.js
   Owns: generic chrome that no feature module should duplicate:
     - left/right panel tab switching
     - toasts (#toast-root) — renders 'toast:show' bus events
     - status bar text — renders 'status:set' bus events
     - modals (#modal-root) — generic showModal()/closeModal() API
     - context menus (#context-menu-root) — renders 'contextmenu:request'
     - top menu bar dropdowns (File/Edit/View/Export/Help)
     - panel resize handles (drag left/right panel width)
     - keyboard shortcut cheat sheet (#shortcut-cheatsheet, press ?)
     - first-run onboarding tour
     - project browser modal (recent/all projects, backed by projectManager.js)
   ============================================================ */

let ctx;

function init(_ctx) {
  ctx = _ctx;
  wireTabs();
  wireToasts();
  wireStatusBar();
  wireMenuBar();
  wireContextMenus();
  wirePanelResize();
  wireShortcutCheatsheet();
  wireProjectBrowser();
  maybeStartOnboarding();

  document.addEventListener('click', closeAllDropdowns);
  document.addEventListener('click', closeContextMenu);
}

/* ---------------- TABS ---------------- */
function wireTabs() {
  document.querySelectorAll('.cf-panel').forEach(panel => {
    const tabs = panel.querySelectorAll('.cf-panel-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const targetKey = tab.dataset.tab;
        const prefix = panel.dataset.panel === 'left' ? 'tab-' : 'rtab-';
        panel.querySelectorAll('.cf-tab-content').forEach(content => {
          content.classList.toggle('active', content.id === `${prefix}${targetKey}`);
        });
        ctx.bus.emit('ui:tabChanged', { panel: panel.dataset.panel, tab: targetKey });
      });
    });
  });
}

/* ---------------- TOASTS ---------------- */
function wireToasts() {
  ctx.bus.on('toast:show', ({ message, type, duration }) => showToastEl(message, type, duration));
}

function showToastEl(message, type = 'info', duration = 3500) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `cf-toast cf-toast-${type}`;
  toast.textContent = message;
  root.appendChild(toast);

  const remove = () => {
    toast.classList.add('cf-toast-leaving');
    setTimeout(() => toast.remove(), 180);
  };
  const timer = setTimeout(remove, duration);
  toast.addEventListener('click', () => { clearTimeout(timer); remove(); });
}

/* ---------------- STATUS BAR ---------------- */
function wireStatusBar() {
  ctx.bus.on('status:set', ({ message }) => {
    const el = document.getElementById('status-message');
    if (el) el.textContent = message;
  });
  ctx.bus.on('timeline:rendered', updateProjectStats);
  ctx.bus.on('project:replaced', updateProjectStats);
  updateProjectStats();
}

function updateProjectStats() {
  const el = document.getElementById('status-project-stats');
  if (!el) return;
  const { project } = ctx.AppState;
  const clipCount = project.tracks.reduce((sum, t) => sum + t.clips.length, 0);
  const duration = ctx.AppState.getDuration();
  const mm = Math.floor(duration / 60);
  const ss = Math.floor(duration % 60);
  el.textContent = `${project.tracks.length} tracks · ${clipCount} clips · ${mm}:${String(ss).padStart(2, '0')}`;
}

/* ---------------- MENU BAR (File/Edit/View/Export/Help dropdowns) ---------------- */
const MENU_DEFS = {
  file: [
    { label: 'New Project', action: 'file:new', shortcut: 'Ctrl+Alt+N' },
    { label: 'Open Project…', action: 'file:open', shortcut: 'Ctrl+O' },
    { label: 'Save Project', action: 'file:save', shortcut: 'Ctrl+S' },
    { sep: true },
    { label: 'Import Media…', action: 'file:import' },
    { sep: true },
    { label: 'Export…', action: 'export:open', shortcut: 'Ctrl+E' },
  ],
  edit: [
    { label: 'Undo', action: 'edit:undo', shortcut: 'Ctrl+Z' },
    { label: 'Redo', action: 'edit:redo', shortcut: 'Ctrl+Shift+Z' },
    { sep: true },
    { label: 'Split at Playhead', action: 'edit:split', shortcut: 'S' },
    { label: 'Ripple Delete', action: 'edit:rippleDelete', shortcut: 'Shift+Del' },
    { sep: true },
    { label: 'Select All', action: 'edit:selectAll', shortcut: 'Ctrl+A' },
  ],
  view: [
    { label: 'Zoom In', action: 'view:zoomIn', shortcut: '+' },
    { label: 'Zoom Out', action: 'view:zoomOut', shortcut: '-' },
    { label: 'Zoom to Fit', action: 'view:zoomFit', shortcut: 'Shift+Z' },
    { sep: true },
    { label: 'Keyboard Shortcuts', action: 'view:shortcuts', shortcut: '?' },
  ],
  export: [
    { label: 'Export Video…', action: 'export:open', shortcut: 'Ctrl+E' },
    { label: 'Export Audio Only…', action: 'export:audioOnly' },
  ],
  help: [
    { label: 'Keyboard Shortcuts', action: 'view:shortcuts', shortcut: '?' },
    { label: 'Restart Onboarding Tour', action: 'help:tour' },
  ],
};

function wireMenuBar() {
  document.querySelectorAll('.cf-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menuKey = btn.dataset.menu;
      if (btn.classList.contains('active')) { closeAllDropdowns(); return; }
      closeAllDropdowns();
      btn.classList.add('active');
      openDropdown(btn, MENU_DEFS[menuKey] || []);
    });
  });
}

function openDropdown(anchorEl, items) {
  const menu = document.createElement('div');
  menu.className = 'cf-dropdown-menu';
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'cf-dropdown-separator';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'cf-dropdown-item';
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(label);
    if (item.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'cf-context-item-shortcut';
      sc.textContent = item.shortcut;
      row.appendChild(sc);
    }
    row.addEventListener('click', () => {
      handleMenuAction(item.action);
      closeAllDropdowns();
    });
    menu.appendChild(row);
  }
  document.getElementById('context-menu-root').appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 2}px`;
}

function closeAllDropdowns() {
  document.querySelectorAll('.cf-menu-btn.active').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.cf-dropdown-menu').forEach(m => m.remove());
}

function handleMenuAction(action) {
  if (!action) return;
  if (action.startsWith('file:')) { ctx.bus.emit('menu:action', { action }); return; }
  if (action === 'edit:undo') { ctx.history.undo(); return; }
  if (action === 'edit:redo') { ctx.history.redo(); return; }
  if (action === 'edit:split') { ctx.bus.emit('shortcut:trigger', { action: 'split' }); return; }
  if (action === 'edit:rippleDelete') { ctx.bus.emit('shortcut:trigger', { action: 'rippleDelete' }); return; }
  if (action === 'edit:selectAll') { ctx.bus.emit('shortcut:trigger', { action: 'selectAll' }); return; }
  if (action === 'view:zoomIn') { ctx.bus.emit('shortcut:trigger', { action: 'zoomIn' }); return; }
  if (action === 'view:zoomOut') { ctx.bus.emit('shortcut:trigger', { action: 'zoomOut' }); return; }
  if (action === 'view:zoomFit') { ctx.bus.emit('shortcut:trigger', { action: 'zoomFit' }); return; }
  if (action === 'view:shortcuts') { showShortcutCheatsheet(); return; }
  if (action === 'export:open') { ctx.bus.emit('export:openDialog', {}); return; }
  if (action === 'export:audioOnly') { ctx.bus.emit('export:openDialog', { audioOnly: true }); return; }
  if (action === 'help:tour') { startOnboardingTour(); return; }
  if (action === 'file:import') { document.getElementById('btn-import-media')?.click(); return; }
}

/* ---------------- GENERIC MODAL API ---------------- */
function showModal({ title, bodyEl, footerButtons = [] }) {
  closeModal();
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'cf-modal-backdrop';
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

  const modal = document.createElement('div');
  modal.className = 'cf-modal';

  const header = document.createElement('div');
  header.className = 'cf-modal-header';
  const titleEl = document.createElement('div');
  titleEl.className = 'cf-modal-title';
  titleEl.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'cf-modal-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeModal);
  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'cf-modal-body';
  body.appendChild(bodyEl);
  modal.appendChild(body);

  if (footerButtons.length) {
    const footer = document.createElement('div');
    footer.className = 'cf-modal-footer';
    for (const btnDef of footerButtons) {
      const btn = document.createElement('button');
      btn.className = `cf-btn ${btnDef.primary ? 'cf-btn-primary' : ''}`;
      btn.textContent = btnDef.label;
      btn.addEventListener('click', () => btnDef.onClick?.());
      footer.appendChild(btn);
    }
    modal.appendChild(footer);
  }

  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  const onEsc = (e) => { if (e.key === 'Escape') closeModal(); };
  window.addEventListener('keydown', onEsc, { once: true });
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

/* ---------------- CONTEXT MENUS ---------------- */
const CONTEXT_MENU_BUILDERS = {
  clip: ({ clipId }) => {
    const clip = ctx.AppState.getClipById(clipId);
    if (!clip) return [];
    return [
      { label: 'Split at Playhead', onClick: () => ctx.bus.emit('shortcut:trigger', { action: 'split' }) },
      { label: 'Delete', onClick: () => ctx.bus.emit('shortcut:trigger', { action: 'delete' }) },
      { label: 'Ripple Delete', onClick: () => ctx.bus.emit('shortcut:trigger', { action: 'rippleDelete' }) },
      { sep: true },
      { label: 'Copy', onClick: () => ctx.bus.emit('shortcut:trigger', { action: 'copy' }) },
      { sep: true },
      { label: 'Reveal in Media Bin', onClick: () => revealInMediaBin(clip) },
    ];
  },
  media: ({ mediaId }) => [
    { label: 'Add to Timeline at Playhead', onClick: () => addMediaAtPlayhead(mediaId) },
    { sep: true },
    { label: 'Remove from Project', onClick: () => removeMediaFromProject(mediaId) },
  ],
  timeline: () => [
    { label: 'Paste', onClick: () => ctx.bus.emit('shortcut:trigger', { action: 'paste' }) },
    { label: 'Add Video Track', onClick: () => ctx.bus.emit('shortcut:trigger', { action: 'addVideoTrack' }) },
    { label: 'Add Audio Track', onClick: () => ctx.bus.emit('shortcut:trigger', { action: 'addAudioTrack' }) },
  ],
};

function wireContextMenus() {
  ctx.bus.on('contextmenu:request', ({ x, y, kind, ...rest }) => {
    const builder = CONTEXT_MENU_BUILDERS[kind];
    if (!builder) return;
    const items = builder(rest);
    openContextMenuAt(x, y, items);
  });
}

function openContextMenuAt(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'cf-context-menu';
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'cf-context-separator';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'cf-context-item';
    row.textContent = item.label;
    row.addEventListener('click', () => { item.onClick?.(); closeContextMenu(); });
    menu.appendChild(row);
  }
  document.getElementById('context-menu-root').appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeContextMenu() {
  document.querySelectorAll('.cf-context-menu').forEach(m => m.remove());
}

function revealInMediaBin(clip) {
  ctx.AppState.project.selection.mediaId = clip.mediaId;
  document.querySelector('.cf-panel-tab[data-tab="media"]')?.click();
  ctx.bus.emit('media:selected', { mediaId: clip.mediaId });
}

function addMediaAtPlayhead(mediaId) {
  let track = ctx.AppState.project.tracks.find(t => t.type === 'video');
  if (!track) { ctx.showToast('No video track available', 'warning'); return; }
  ctx.bus.emit('media:dropOnTimeline', {
    mediaId, trackId: track.id, start: ctx.AppState.project.playback.currentTime,
  });
}

function removeMediaFromProject(mediaId) {
  ctx.history.capture();
  ctx.AppState.project.media = ctx.AppState.project.media.filter(m => m.id !== mediaId);
  for (const track of ctx.AppState.project.tracks) {
    track.clips = track.clips.filter(c => c.mediaId !== mediaId);
  }
  ctx.AppState.markDirty('media:removed', { mediaId });
  ctx.bus.emit('timeline:rendered', {});
  ctx.bus.emit('project:replaced', {});
}

/* ---------------- PANEL RESIZE ---------------- */
function wirePanelResize() {
  setupResizeHandle(document.getElementById('panel-left'), 'left');
  setupResizeHandle(document.getElementById('panel-right'), 'right');
}

function setupResizeHandle(panelEl, side) {
  if (!panelEl) return;
  const handle = document.createElement('div');
  handle.className = 'cf-panel-resize-handle';
  panelEl.appendChild(handle);

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelEl.getBoundingClientRect().width;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newWidth = side === 'left' ? startWidth + dx : startWidth - dx;
      const clamped = Math.max(220, Math.min(520, newWidth));
      document.documentElement.style.setProperty(side === 'left' ? '--panel-left-w' : '--panel-right-w', `${clamped}px`);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

/* ---------------- SHORTCUT CHEAT SHEET ---------------- */
const SHORTCUT_GROUPS = [
  { title: 'Playback', rows: [['Space', 'Play / Pause'], ['J', 'Rewind / Speed down'], ['K', 'Pause'], ['L', 'Forward / Speed up'], ['←/→', 'Step one frame']] },
  { title: 'Editing', rows: [['C', 'Cut / Razor tool'], ['V', 'Select tool'], ['S', 'Split at playhead'], ['I', 'Mark In'], ['O', 'Mark Out'], ['Del', 'Delete'], ['Shift+Del', 'Ripple Delete']] },
  { title: 'Timeline', rows: [['N', 'Toggle snapping'], ['M', 'Toggle magnetic mode'], ['+/-', 'Zoom in/out'], ['Shift+Z', 'Zoom to fit']] },
  { title: 'General', rows: [['Ctrl+Z', 'Undo'], ['Ctrl+Shift+Z', 'Redo'], ['Ctrl+S', 'Save'], ['Ctrl+E', 'Export'], ['?', 'This cheat sheet']] },
];

function wireShortcutCheatsheet() {
  document.getElementById('btn-shortcuts')?.addEventListener('click', showShortcutCheatsheet);
  ctx.bus.on('shortcut:showCheatsheet', showShortcutCheatsheet);
  const sheet = document.getElementById('shortcut-cheatsheet');
  sheet?.addEventListener('click', (e) => { if (e.target === sheet) hideShortcutCheatsheet(); });
}

function showShortcutCheatsheet() {
  const sheet = document.getElementById('shortcut-cheatsheet');
  if (!sheet) return;
  sheet.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'cf-cheatsheet-card';
  const title = document.createElement('h3');
  title.textContent = 'Keyboard Shortcuts';
  title.style.margin = '0';
  card.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'cf-cheatsheet-grid';
  for (const group of SHORTCUT_GROUPS) {
    const col = document.createElement('div');
    const h = document.createElement('div');
    h.className = 'cf-cheatsheet-group-title';
    h.textContent = group.title;
    col.appendChild(h);
    for (const [key, label] of group.rows) {
      const row = document.createElement('div');
      row.className = 'cf-cheatsheet-row';
      const span = document.createElement('span');
      span.textContent = label;
      const kbd = document.createElement('span');
      kbd.className = 'cf-cheatsheet-key';
      kbd.textContent = key;
      row.appendChild(span);
      row.appendChild(kbd);
      col.appendChild(row);
    }
    grid.appendChild(col);
  }
  card.appendChild(grid);
  sheet.appendChild(card);
  sheet.hidden = false;
}

function hideShortcutCheatsheet() {
  const sheet = document.getElementById('shortcut-cheatsheet');
  if (sheet) sheet.hidden = true;
}

/* ---------------- PROJECT BROWSER MODAL ---------------- */
let projectManagerRef = null;
function setProjectManager(pm) { projectManagerRef = pm; }

function wireProjectBrowser() {
  ctx.bus.on('ui:openProjectBrowser', openProjectBrowserModal);
  ctx.bus.on('projectManager:recentsAvailable', ({ recents }) => {
    if (recents.length > 0) {
      ctx.showToast(`Welcome back — "${recents[0].name}" was your last project`, 'info', 5000);
    }
  });
}

async function openProjectBrowserModal() {
  if (!projectManagerRef) return;
  const projects = await projectManagerRef.listProjects();
  const body = document.createElement('div');

  if (projects.length === 0) {
    body.innerHTML = '<p class="cf-empty-hint">No saved projects yet.</p>';
  } else {
    const group = document.createElement('div');
    group.className = 'cf-radio-card-group';
    for (const p of projects) {
      const card = document.createElement('div');
      card.className = 'cf-radio-card';
      const info = document.createElement('div');
      info.style.flex = '1';
      const name = document.createElement('div');
      name.textContent = p.name;
      name.style.fontWeight = '600';
      const date = document.createElement('div');
      date.style.fontSize = 'var(--fs-xs)';
      date.style.color = 'var(--text-tertiary)';
      date.textContent = new Date(p.modifiedAt).toLocaleString();
      info.appendChild(name);
      info.appendChild(date);
      card.appendChild(info);

      const btnOpen = document.createElement('button');
      btnOpen.className = 'cf-btn cf-btn-sm';
      btnOpen.textContent = 'Open';
      btnOpen.addEventListener('click', async (e) => {
        e.stopPropagation();
        await projectManagerRef.loadProject(p.id);
        closeModal();
      });
      card.appendChild(btnOpen);

      const btnDelete = document.createElement('button');
      btnDelete.className = 'cf-btn cf-btn-sm cf-btn-danger';
      btnDelete.textContent = '✕';
      btnDelete.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (window.confirm(`Delete "${p.name}"? This cannot be undone.`)) {
          await projectManagerRef.deleteProject(p.id);
          card.remove();
        }
      });
      card.appendChild(btnDelete);

      group.appendChild(card);
    }
    body.appendChild(group);
  }

  showModal({ title: 'Open Project', bodyEl: body });
}

/* ---------------- ONBOARDING TOUR ---------------- */
const TOUR_STEPS = [
  { selector: '#btn-import-media', title: 'Import Media', body: 'Start by importing video, audio, or image files into your media bin.' },
  { selector: '#timeline-container', title: 'The Timeline', body: 'Drag clips here to build your edit. Scroll to navigate, Ctrl+scroll to zoom.' },
  { selector: '#preview-canvas', title: 'Preview Player', body: 'Watch your edit update in real time as you build it.' },
  { selector: '#panel-right', title: 'Properties & Color', body: 'Select a clip to adjust its transform, color grade, audio, and keyframes here.' },
  { selector: '#btn-export', title: 'Export', body: 'When you\'re ready, export to MP4, WebM, GIF, or audio-only.' },
];

function maybeStartOnboarding() {
  if (localStorage.getItem('cutflow:onboarded')) return;
  setTimeout(() => startOnboardingTour(), 600);
}

function startOnboardingTour() {
  let step = 0;
  showTourStep(step);

  function showTourStep(i) {
    clearTour();
    if (i >= TOUR_STEPS.length) { localStorage.setItem('cutflow:onboarded', '1'); return; }
    const def = TOUR_STEPS[i];
    const target = document.querySelector(def.selector);
    if (!target) { step = i + 1; showTourStep(step); return; }
    const rect = target.getBoundingClientRect();

    const spotlight = document.createElement('div');
    spotlight.className = 'cf-tour-spotlight';
    spotlight.style.left = `${rect.left - 6}px`;
    spotlight.style.top = `${rect.top - 6}px`;
    spotlight.style.width = `${rect.width + 12}px`;
    spotlight.style.height = `${rect.height + 12}px`;
    document.body.appendChild(spotlight);

    const tooltip = document.createElement('div');
    tooltip.className = 'cf-tour-tooltip';
    tooltip.style.left = `${Math.min(window.innerWidth - 300, rect.left)}px`;
    tooltip.style.top = `${Math.min(window.innerHeight - 160, rect.bottom + 12)}px`;
    tooltip.innerHTML = `
      <div class="cf-tour-tooltip-title">${def.title}</div>
      <div class="cf-tour-tooltip-body">${def.body}</div>
      <div class="cf-tour-tooltip-footer">
        <span class="cf-tour-tooltip-step">${i + 1} / ${TOUR_STEPS.length}</span>
        <div style="display:flex; gap:8px;">
          <button class="cf-btn cf-btn-sm" id="tour-skip">Skip</button>
          <button class="cf-btn cf-btn-sm cf-btn-primary" id="tour-next">${i === TOUR_STEPS.length - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>`;
    document.body.appendChild(tooltip);

    tooltip.querySelector('#tour-skip').addEventListener('click', () => {
      clearTour();
      localStorage.setItem('cutflow:onboarded', '1');
    });
    tooltip.querySelector('#tour-next').addEventListener('click', () => { step = i + 1; showTourStep(step); });
  }

  function clearTour() {
    document.querySelectorAll('.cf-tour-spotlight, .cf-tour-tooltip').forEach(el => el.remove());
  }
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  showModal,
  closeModal,
  showToastEl,
  setProjectManager,
  startOnboardingTour,
  showShortcutCheatsheet,
};
