/* ============================================================
   CutFlow Studio — keyframes.js
   Owns: clip.keyframes (property -> Keyframe[]), the Properties tab
   (right panel, transform controls + keyframe diamond toggles), and the
   Keyframes tab (right panel, mini timeline lanes).

   Keyframe shape: { id, time (seconds, LOCAL to clip — i.e. relative to
   clip.trimIn, NOT timeline time), value }

   Animatable properties: x, y, scale, rotation, opacity (matches the
   `xform` shape player.js/effects.js already consume).

   INTERPOLATION: linear only for v1. Real NLEs offer ease-in/ease-out/hold
   per-keyframe; that's a richer per-keyframe "interpolation mode" field
   we don't have yet — noted as a follow-up, not hidden.
   ============================================================ */

let ctx;
let player;

const ANIMATABLE_PROPS = [
  { key: 'x', label: 'Position X', min: -2000, max: 2000, step: 1, default: 0 },
  { key: 'y', label: 'Position Y', min: -2000, max: 2000, step: 1, default: 0 },
  { key: 'scale', label: 'Scale', min: 0.01, max: 5, step: 0.01, default: 1 },
  { key: 'rotation', label: 'Rotation', min: -360, max: 360, step: 1, default: 0 },
  { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 1 },
];

function init(_ctx) {
  ctx = _ctx;
  ctx.bus.on('selection:changed', renderPropertiesPanel);
  ctx.bus.on('properties:refreshRequest', renderPropertiesPanel);
  ctx.bus.on('playback:tick', refreshKeyframeToggleStates);
  ctx.bus.on('playback:seek', refreshKeyframeToggleStates);

  renderPropertiesPanel();
  renderKeyframesPanel();
}

import * as playerModule from './player.js';
player = playerModule;
player.setKeyframeResolver(resolveTransformAt);

/* ---------------- RESOLUTION (called every frame by player.js) ---------------- */
/** localTime is seconds relative to clip.trimIn (i.e. position within the
    SOURCE media, matching how keyframe times are stored — this keeps
    keyframes stable under trim-in changes from the left edge, but note:
    trimming the LEFT edge of a clip does NOT shift existing keyframe times,
    since they're source-relative, not clip-relative. This matches how most
    NLEs behave: trimming reveals more/less of an already-animated clip
    rather than re-timing the animation. */
function resolveTransformAt(clip, localTime) {
  const out = {};
  for (const prop of ANIMATABLE_PROPS) {
    const track = clip.keyframes?.[prop.key];
    out[prop.key] = track && track.length > 0
      ? interpolate(track, localTime)
      : (clip.staticTransform?.[prop.key] ?? prop.default);
  }
  return out;
}

function interpolate(track, t) {
  const sorted = [...track].sort((a, b) => a.time - b.time);
  if (sorted.length === 1) return sorted[0].value;
  if (t <= sorted[0].time) return sorted[0].time === t ? sorted[0].value : sorted[0].value;
  if (t >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].value;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const frac = span === 0 ? 0 : (t - a.time) / span;
      return a.value + (b.value - a.value) * frac;
    }
  }
  return sorted[sorted.length - 1].value;
}

/* ---------------- KEYFRAME CRUD ---------------- */
function ensureStaticTransform(clip) {
  if (!clip.staticTransform) {
    clip.staticTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  }
  return clip.staticTransform;
}

function addKeyframe(clip, propKey, localTime, value) {
  if (!clip.keyframes[propKey]) clip.keyframes[propKey] = [];
  const track = clip.keyframes[propKey];
  const existing = track.find(k => Math.abs(k.time - localTime) < 0.001);
  if (existing) {
    existing.value = value;
  } else {
    track.push({ id: ctx.makeId('kf'), time: localTime, value });
    track.sort((a, b) => a.time - b.time);
  }
}

function removeKeyframesNear(clip, propKey, localTime) {
  const track = clip.keyframes?.[propKey];
  if (!track) return;
  clip.keyframes[propKey] = track.filter(k => Math.abs(k.time - localTime) >= 0.001);
}

function hasKeyframeAt(clip, propKey, localTime) {
  const track = clip.keyframes?.[propKey];
  if (!track || track.length === 0) return false;
  return track.some(k => Math.abs(k.time - localTime) < 0.001);
}

function isAnimated(clip, propKey) {
  return (clip.keyframes?.[propKey]?.length || 0) > 0;
}

function getLocalTimeForClip(clip) {
  const t = ctx.AppState.project.playback.currentTime;
  return clip.trimIn + (t - clip.start);
}

/* ---------------- PROPERTIES TAB ---------------- */
function renderPropertiesPanel() {
  const container = document.getElementById('properties-content');
  if (!container) return;
  const clips = ctx.AppState.getSelectedClips();

  if (clips.length === 0) {
    container.innerHTML = '<p class="cf-empty-hint">Select a clip on the timeline to edit its properties.</p>';
    return;
  }
  if (clips.length > 1) {
    container.innerHTML = `<p class="cf-empty-hint">${clips.length} clips selected. Select a single clip to edit transform properties.</p>`;
    return;
  }

  const clip = clips[0];
  ensureStaticTransform(clip);
  container.innerHTML = '';
  container.appendChild(buildTransformGroup(clip));
  container.appendChild(buildClipInfoGroup(clip));
}

function buildTransformGroup(clip) {
  const group = document.createElement('div');
  group.className = 'cf-prop-group';

  const title = document.createElement('div');
  title.className = 'cf-prop-group-title';
  title.textContent = 'Transform';
  group.appendChild(title);

  for (const prop of ANIMATABLE_PROPS) {
    group.appendChild(buildAnimatablePropRow(clip, prop));
  }

  return group;
}

function buildAnimatablePropRow(clip, prop) {
  const row = document.createElement('div');
  row.className = 'cf-prop-slider-row';

  const labelWrap = document.createElement('div');
  labelWrap.style.display = 'flex';
  labelWrap.style.alignItems = 'center';
  labelWrap.style.gap = '6px';

  const toggle = document.createElement('button');
  toggle.className = 'cf-keyframe-toggle';
  toggle.title = 'Toggle keyframe at playhead';
  labelWrap.appendChild(toggle);

  const label = document.createElement('span');
  label.className = 'cf-prop-label';
  label.textContent = prop.label;
  labelWrap.appendChild(label);
  row.appendChild(labelWrap);

  const localTime = getLocalTimeForClip(clip);
  const animated = isAnimated(clip, prop.key);
  const currentValue = animated
    ? interpolate(clip.keyframes[prop.key], localTime)
    : ensureStaticTransform(clip)[prop.key];

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(prop.min);
  slider.max = String(prop.max);
  slider.step = String(prop.step);
  slider.value = String(currentValue);
  row.appendChild(slider);

  const numInput = document.createElement('input');
  numInput.className = 'cf-prop-value-input';
  numInput.type = 'number';
  numInput.step = String(prop.step);
  numInput.value = String(round2(currentValue));
  row.appendChild(numInput);

  const syncToggleVisual = () => {
    toggle.classList.toggle('active', hasKeyframeAt(clip, prop.key, getLocalTimeForClip(clip)));
  };
  syncToggleVisual();

  const applyValue = (val, { captureHistory = true } = {}) => {
    if (captureHistory) ctx.history.capture();
    if (isAnimated(clip, prop.key)) {
      addKeyframe(clip, prop.key, getLocalTimeForClip(clip), val);
    } else {
      ensureStaticTransform(clip)[prop.key] = val;
    }
    syncToggleVisual();
    ctx.AppState.markDirty('keyframes:propertyChanged', { clipId: clip.id, prop: prop.key });
    player.renderCurrentFrame();
    refreshKeyframesPanelIfVisible(clip);
  };

  let captured = false;
  slider.addEventListener('pointerdown', () => { captured = false; });
  slider.addEventListener('input', () => {
    if (!captured) { ctx.history.capture(); captured = true; }
    numInput.value = String(round2(Number(slider.value)));
    applyValue(Number(slider.value), { captureHistory: false });
  });
  numInput.addEventListener('change', () => {
    const v = Math.max(prop.min, Math.min(prop.max, Number(numInput.value) || 0));
    slider.value = String(v);
    numInput.value = String(v);
    applyValue(v);
  });

  toggle.addEventListener('click', () => {
    ctx.history.capture();
    const lt = getLocalTimeForClip(clip);
    if (hasKeyframeAt(clip, prop.key, lt)) {
      removeKeyframesNear(clip, prop.key, lt);
    } else {
      // First keyframe on this property: seed it with the current static
      // value so toggling on doesn't cause a visual jump.
      const seedValue = isAnimated(clip, prop.key)
        ? interpolate(clip.keyframes[prop.key], lt)
        : ensureStaticTransform(clip)[prop.key];
      addKeyframe(clip, prop.key, lt, seedValue);
    }
    syncToggleVisual();
    ctx.AppState.markDirty('keyframes:toggled', { clipId: clip.id, prop: prop.key });
    refreshKeyframesPanelIfVisible(clip);
  });

  return row;
}

function buildClipInfoGroup(clip) {
  const group = document.createElement('div');
  group.className = 'cf-prop-group';

  const title = document.createElement('div');
  title.className = 'cf-prop-group-title';
  title.textContent = 'Clip';
  group.appendChild(title);

  const media = ctx.AppState.getMediaById(clip.mediaId);
  const rows = [
    ['Name', clip.label],
    ['Source', media?.name || '—'],
    ['Duration', `${clip.duration.toFixed(2)}s`],
    ['Speed', `${(clip.speed ?? 1).toFixed(2)}×`],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'cf-prop-row';
    const l = document.createElement('span');
    l.className = 'cf-prop-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = value;
    v.style.fontSize = 'var(--fs-sm)';
    v.style.color = 'var(--text-primary)';
    row.appendChild(l);
    row.appendChild(v);
    group.appendChild(row);
  }

  group.appendChild(buildSpeedControl(clip));
  return group;
}

/** Speed ramp control. A single scalar speed multiplier per clip for v1
    (0.1x-16x as required); true ramping (speed changing OVER the clip's
    duration via its own keyframe track) is listed as a known gap below. */
function buildSpeedControl(clip) {
  const row = document.createElement('div');
  row.className = 'cf-prop-slider-row';
  row.style.marginTop = 'var(--sp-2)';

  const label = document.createElement('label');
  label.className = 'cf-prop-label';
  label.textContent = 'Speed';
  row.appendChild(label);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.1';
  slider.max = '16';
  slider.step = '0.1';
  slider.value = String(clip.speed ?? 1);
  row.appendChild(slider);

  const numInput = document.createElement('input');
  numInput.className = 'cf-prop-value-input';
  numInput.type = 'number';
  numInput.step = '0.1';
  numInput.value = String(clip.speed ?? 1);
  row.appendChild(numInput);

  const apply = (v) => {
    ctx.history.capture();
    clip.speed = Math.max(0.1, Math.min(16, v));
    ctx.AppState.markDirty('clip:speedChanged', { clipId: clip.id });
    player.renderCurrentFrame();
  };

  slider.addEventListener('change', () => { numInput.value = slider.value; apply(Number(slider.value)); });
  numInput.addEventListener('change', () => { slider.value = numInput.value; apply(Number(numInput.value)); });

  return row;
}

function round2(v) { return Math.round(v * 100) / 100; }

function refreshKeyframeToggleStates() {
  // Cheap: only re-render if the Properties tab is actually visible, since
  // this fires on every playback tick.
  const tabActive = document.getElementById('rtab-properties')?.classList.contains('active');
  if (tabActive) renderPropertiesPanel();
  const kfTabActive = document.getElementById('rtab-keyframes')?.classList.contains('active');
  if (kfTabActive) renderKeyframesPanel();
}

/* ---------------- KEYFRAMES TAB (mini lane view) ---------------- */
function renderKeyframesPanel() {
  const container = document.getElementById('keyframe-editor-content');
  if (!container) return;
  const clips = ctx.AppState.getSelectedClips();
  container.innerHTML = '';

  if (clips.length !== 1) {
    container.innerHTML = '<p class="cf-empty-hint">Select a single clip to view its keyframes.</p>';
    return;
  }
  const clip = clips[0];
  const animatedProps = ANIMATABLE_PROPS.filter(p => isAnimated(clip, p.key));

  if (animatedProps.length === 0) {
    container.innerHTML = '<p class="cf-empty-hint">No animated properties yet. Click the keyframe toggle next to a property in the Properties tab to start animating it.</p>';
    return;
  }

  for (const prop of animatedProps) {
    container.appendChild(buildKeyframeLane(clip, prop));
  }
}

function refreshKeyframesPanelIfVisible(clip) {
  if (document.getElementById('rtab-keyframes')?.classList.contains('active')) {
    renderKeyframesPanel();
  }
}

function buildKeyframeLane(clip, prop) {
  const row = document.createElement('div');
  row.className = 'cf-kf-track-row';

  const label = document.createElement('span');
  label.className = 'cf-kf-track-label';
  label.textContent = prop.label;
  row.appendChild(label);

  const lane = document.createElement('div');
  lane.className = 'cf-kf-track-lane';
  row.appendChild(lane);

  const track = clip.keyframes[prop.key];
  const localStart = clip.trimIn;
  const localEnd = clip.trimIn + clip.duration;
  const span = Math.max(0.001, localEnd - localStart);

  for (const kf of track) {
    const pct = Math.max(0, Math.min(1, (kf.time - localStart) / span));
    const diamond = document.createElement('div');
    diamond.className = 'cf-kf-diamond';
    diamond.style.left = `${pct * 100}%`;
    diamond.title = `t=${kf.time.toFixed(2)}s, value=${round2(kf.value)}`;

    diamond.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const laneRect = lane.getBoundingClientRect();
      const onMove = (ev) => {
        const x = Math.max(0, Math.min(laneRect.width, ev.clientX - laneRect.left));
        const newTime = localStart + (x / laneRect.width) * span;
        kf.time = Math.max(localStart, Math.min(localEnd, newTime));
        diamond.style.left = `${((kf.time - localStart) / span) * 100}%`;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        track.sort((a, b) => a.time - b.time);
        ctx.AppState.markDirty('keyframes:moved', { clipId: clip.id, prop: prop.key });
        player.renderCurrentFrame();
      };
      ctx.history.capture();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    diamond.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      ctx.history.capture();
      const idx = track.indexOf(kf);
      if (idx !== -1) track.splice(idx, 1);
      ctx.AppState.markDirty('keyframes:deleted', { clipId: clip.id, prop: prop.key });
      player.renderCurrentFrame();
      renderKeyframesPanel();
    });

    lane.appendChild(diamond);
  }

  return row;
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  resolveTransformAt,
  addKeyframe,
  removeKeyframesNear,
  isAnimated,
  ANIMATABLE_PROPS,
};
