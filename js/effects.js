/* ============================================================
   CutFlow Studio — effects.js
   Owns: clip.effects[] (EffectInstance[]) and per-clip colorGrade data,
         the effects browser list (left panel), the Color tab (right panel).

   EffectInstance shape (in clip.effects[]):
     { id, type, params: {...}, enabled: true }

   colorGrade shape (clip.colorGrade, lazily created):
     { lift: {r,g,b}, gamma: {r,g,b}, gain: {r,g,b},
       brightness, contrast, saturation, temperature, tint,
       hue, lutId or null }

   RENDER STRATEGY:
   player.js calls our registered pipeline function once per drawn clip,
   passing the raw <video>/<img> source element. We:
     1. Draw the source to an offscreen canvas at canvas resolution
        (cheap — same cost player.js would pay anyway).
     2. Apply CSS canvas filter string (brightness/contrast/saturate/
        hue-rotate/blur) — hardware-accelerated, real Canvas2D `filter` API.
     3. For effects that need raw pixel access (chroma key, vignette,
        grain, lift/gamma/gain, temperature/tint — none of which the CSS
        `filter` shorthand can express), we read back ImageData and run a
        per-pixel pass. This is the expensive path; we only pay it for
        clips that actually use those effects.
     4. Blit the offscreen canvas onto the real canvas with the clip's
        keyframed transform (delegating to player.js's drawSourceWithTransform-
        style logic via a callback, so transform math lives in one place).
   ============================================================ */

let ctx;
let player; // imported directly (effects -> player is a safe one-way edge, same as mediaManager -> player)

let offCanvas, offCtx;

const EFFECT_DEFS = [
  { id: 'brightness-contrast', category: 'Color', label: 'Brightness/Contrast', icon: '☀️', defaults: { brightness: 0, contrast: 0 } },
  { id: 'saturation', category: 'Color', label: 'Saturation', icon: '🎨', defaults: { saturation: 0 } },
  { id: 'temperature-tint', category: 'Color', label: 'Temperature/Tint', icon: '🌡️', defaults: { temperature: 0, tint: 0 } },
  { id: 'blur', category: 'Stylize', label: 'Gaussian Blur', icon: '◌', defaults: { radius: 4 } },
  { id: 'sharpen', category: 'Stylize', label: 'Sharpen', icon: '◆', defaults: { amount: 0.5 } },
  { id: 'grain', category: 'Stylize', label: 'Film Grain', icon: '▦', defaults: { amount: 0.15 } },
  { id: 'vignette', category: 'Stylize', label: 'Vignette', icon: '◯', defaults: { amount: 0.4, radius: 0.75 } },
  { id: 'chromatic-aberration', category: 'Stylize', label: 'Chromatic Aberration', icon: '🌈', defaults: { amount: 3 } },
  { id: 'chroma-key', category: 'Key', label: 'Green Screen / Chroma Key', icon: '🟩', defaults: { keyColor: '#00ff00', tolerance: 0.35, softness: 0.08 } },
  { id: 'crop', category: 'Transform', label: 'Crop', icon: '⬚', defaults: { top: 0, right: 0, bottom: 0, left: 0 } },
];

function init(_ctx) {
  ctx = _ctx;
  offCanvas = document.createElement('canvas');
  offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

  renderEffectsBrowser();
  wireEffectsSearch();
  wireColorTab();

  ctx.bus.on('selection:changed', renderColorTabForSelection);
}

import * as playerModule from './player.js';
player = playerModule;
player.setEffectsPipeline(runEffectsPipeline);

/* ---------------- EFFECTS BROWSER (left panel) ---------------- */
function renderEffectsBrowser(filter = '') {
  const list = document.getElementById('effects-list');
  if (!list) return;
  list.innerHTML = '';

  const byCategory = new Map();
  for (const def of EFFECT_DEFS) {
    const matches = !filter || def.label.toLowerCase().includes(filter.toLowerCase());
    if (!matches) continue;
    if (!byCategory.has(def.category)) byCategory.set(def.category, []);
    byCategory.get(def.category).push(def);
  }

  for (const [category, defs] of byCategory) {
    const heading = document.createElement('div');
    heading.className = 'cf-fx-category';
    heading.textContent = category;
    list.appendChild(heading);

    for (const def of defs) {
      list.appendChild(buildEffectListItem(def));
    }
  }

  if (list.children.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'cf-empty-hint';
    hint.textContent = 'No effects match your search.';
    list.appendChild(hint);
  }
}

function buildEffectListItem(def) {
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
    e.dataTransfer.setData('text/cutflow-effect-id', def.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  // Double-click applies to the currently selected clip(s) — faster than
  // dragging when you already know which clip you want it on.
  item.addEventListener('dblclick', () => {
    const clips = ctx.AppState.getSelectedClips();
    if (clips.length === 0) {
      ctx.showToast('Select a clip first', 'warning');
      return;
    }
    for (const clip of clips) addEffectToClip(clip.id, def.id);
    ctx.showToast(`Added ${def.label} to ${clips.length} clip${clips.length > 1 ? 's' : ''}`, 'success');
  });

  return item;
}

function wireEffectsSearch() {
  document.getElementById('effects-search')?.addEventListener('input', (e) => {
    renderEffectsBrowser(e.target.value);
  });
}

/* ---------------- APPLYING / REMOVING EFFECTS ---------------- */
function addEffectToClip(clipId, effectTypeId) {
  const clip = ctx.AppState.getClipById(clipId);
  const def = EFFECT_DEFS.find(d => d.id === effectTypeId);
  if (!clip || !def) return null;

  ctx.history.capture();
  const instance = {
    id: ctx.makeId('fx'),
    type: effectTypeId,
    params: structuredClone(def.defaults),
    enabled: true,
  };
  clip.effects.push(instance);
  ctx.AppState.markDirty('effects:added', { clipId, effectId: instance.id });
  player.renderCurrentFrame();
  ctx.bus.emit('properties:refreshRequest', {});
  return instance;
}

function removeEffectFromClip(clipId, effectInstanceId) {
  const clip = ctx.AppState.getClipById(clipId);
  if (!clip) return;
  ctx.history.capture();
  clip.effects = clip.effects.filter(e => e.id !== effectInstanceId);
  ctx.AppState.markDirty('effects:removed', { clipId, effectInstanceId });
  player.renderCurrentFrame();
  ctx.bus.emit('properties:refreshRequest', {});
}

function updateEffectParams(clipId, effectInstanceId, paramPatch) {
  const clip = ctx.AppState.getClipById(clipId);
  const inst = clip?.effects.find(e => e.id === effectInstanceId);
  if (!inst) return;
  Object.assign(inst.params, paramPatch);
  ctx.AppState.markDirty('effects:paramsChanged', { clipId, effectInstanceId });
  player.renderCurrentFrame();
}

function ensureColorGrade(clip) {
  if (!clip.colorGrade) {
    clip.colorGrade = {
      lift: { r: 0, g: 0, b: 0 },
      gamma: { r: 0, g: 0, b: 0 },
      gain: { r: 0, g: 0, b: 0 },
      brightness: 0, contrast: 0, saturation: 0,
      temperature: 0, tint: 0, hue: 0,
      lutId: null,
    };
  }
  return clip.colorGrade;
}

/* ---------------- COLOR TAB (right panel) ---------------- */
function wireColorTab() {
  // Built once; refreshed in place on selection change rather than rebuilt,
  // since color wheel drag-state would otherwise be lost mid-gesture.
  renderColorTabForSelection();
}

function renderColorTabForSelection() {
  const container = document.getElementById('color-content');
  if (!container) return;
  const clips = ctx.AppState.getSelectedClips();

  if (clips.length !== 1) {
    container.innerHTML = '<p class="cf-empty-hint">Select a single clip to color grade.</p>';
    return;
  }
  const clip = clips[0];
  const grade = ensureColorGrade(clip);
  container.innerHTML = '';
  container.appendChild(buildColorWheels(clip, grade));
  container.appendChild(buildBasicSliders(clip, grade));
  container.appendChild(buildLutRow(clip, grade));
}

function buildColorWheels(clip, grade) {
  const wrap = document.createElement('div');
  wrap.className = 'cf-color-wheels';
  for (const [key, label] of [['lift', 'Lift'], ['gamma', 'Gamma'], ['gain', 'Gain']]) {
    wrap.appendChild(buildColorWheelBlock(clip, grade, key, label));
  }
  return wrap;
}

function buildColorWheelBlock(clip, grade, key, label) {
  const block = document.createElement('div');
  block.className = 'cf-color-wheel-block';

  const wheel = document.createElement('div');
  wheel.className = `cf-color-wheel cf-color-wheel-${key}`;
  const dot = document.createElement('div');
  dot.className = 'cf-color-wheel-dot';
  wheel.appendChild(dot);

  const positionDot = () => {
    const v = grade[key];
    const radius = 32;
    const x = Math.max(-1, Math.min(1, v.r - v.g)) * radius; // crude RG axis mapping for a 2D wheel
    const y = Math.max(-1, Math.min(1, v.b - (v.r + v.g) / 2)) * radius;
    dot.style.left = `calc(50% + ${x}px)`;
    dot.style.top = `calc(50% + ${y}px)`;
  };
  positionDot();

  wheel.addEventListener('pointerdown', (e) => {
    ctx.history.capture();
    const rect = wheel.getBoundingClientRect();
    const onMove = (ev) => {
      const x = (ev.clientX - rect.left - rect.width / 2) / (rect.width / 2);
      const y = (ev.clientY - rect.top - rect.height / 2) / (rect.height / 2);
      grade[key].r = Math.max(-1, Math.min(1, x));
      grade[key].g = Math.max(-1, Math.min(1, -x));
      grade[key].b = Math.max(-1, Math.min(1, y));
      positionDot();
      ctx.AppState.markDirty('effects:colorGradeChanged', { clipId: clip.id });
      player.renderCurrentFrame();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  block.appendChild(wheel);
  const lbl = document.createElement('div');
  lbl.className = 'cf-color-wheel-label';
  lbl.textContent = label;
  block.appendChild(lbl);
  return block;
}

function buildBasicSliders(clip, grade) {
  const wrap = document.createElement('div');
  wrap.className = 'cf-hsl-rows';
  const sliders = [
    ['brightness', 'Brightness', -100, 100],
    ['contrast', 'Contrast', -100, 100],
    ['saturation', 'Saturation', -100, 100],
    ['temperature', 'Temperature', -100, 100],
    ['tint', 'Tint', -100, 100],
    ['hue', 'Hue', -180, 180],
  ];
  for (const [key, label, min, max] of sliders) {
    wrap.appendChild(buildSliderRow(label, grade[key], min, max, (val) => {
      grade[key] = val;
      ctx.AppState.markDirty('effects:colorGradeChanged', { clipId: clip.id });
      player.renderCurrentFrame();
    }));
  }
  return wrap;
}

function buildSliderRow(label, value, min, max, onChange) {
  const row = document.createElement('div');
  row.className = 'cf-prop-slider-row';

  const lbl = document.createElement('label');
  lbl.className = 'cf-prop-label';
  lbl.textContent = label;
  row.appendChild(lbl);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = '1';
  slider.value = String(value);
  row.appendChild(slider);

  const numInput = document.createElement('input');
  numInput.className = 'cf-prop-value-input';
  numInput.type = 'number';
  numInput.value = String(value);
  row.appendChild(numInput);

  let captured = false;
  const ensureCapture = () => { if (!captured) { ctx.history.capture(); captured = true; } };

  slider.addEventListener('pointerdown', () => { captured = false; });
  slider.addEventListener('input', () => {
    ensureCapture();
    numInput.value = slider.value;
    onChange(Number(slider.value));
  });
  numInput.addEventListener('change', () => {
    ctx.history.capture();
    const v = Math.max(min, Math.min(max, Number(numInput.value) || 0));
    slider.value = String(v);
    numInput.value = String(v);
    onChange(v);
  });

  return row;
}

function buildLutRow(clip, grade) {
  const wrap = document.createElement('div');
  wrap.className = 'cf-form-row';

  const label = document.createElement('label');
  label.className = 'cf-form-label';
  label.textContent = 'LUT (.cube file)';
  wrap.appendChild(label);

  const row = document.createElement('div');
  row.className = 'cf-lut-row';

  const name = document.createElement('span');
  name.className = 'cf-lut-name';
  name.textContent = grade.lutId ? lutStore.get(grade.lutId)?.name || 'Loaded LUT' : 'No LUT loaded';
  row.appendChild(name);

  const btnLoad = document.createElement('button');
  btnLoad.className = 'cf-btn cf-btn-sm';
  btnLoad.textContent = 'Load…';
  row.appendChild(btnLoad);

  const btnClear = document.createElement('button');
  btnClear.className = 'cf-btn cf-btn-sm';
  btnClear.textContent = 'Clear';
  row.appendChild(btnClear);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.cube';
  fileInput.hidden = true;
  row.appendChild(fileInput);

  btnLoad.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const lutId = await loadCubeLut(file);
      ctx.history.capture();
      grade.lutId = lutId;
      ctx.AppState.markDirty('effects:lutLoaded', { clipId: clip.id });
      player.renderCurrentFrame();
      renderColorTabForSelection();
      ctx.showToast(`Loaded LUT "${file.name}"`, 'success');
    } catch (err) {
      console.error('[effects] LUT parse failed:', err);
      ctx.showToast('Could not parse .cube file', 'error');
    }
  });

  btnClear.addEventListener('click', () => {
    ctx.history.capture();
    grade.lutId = null;
    ctx.AppState.markDirty('effects:lutCleared', { clipId: clip.id });
    player.renderCurrentFrame();
    renderColorTabForSelection();
  });

  wrap.appendChild(row);
  return wrap;
}

/* ---------------- .CUBE LUT PARSING (real format parsing, 3D LUT) ---------------- */
const lutStore = new Map(); // lutId -> { name, size, data: Float32Array (size^3 * 3) }

function loadCubeLut(file) {
  return file.text().then(text => {
    const lines = text.split('\n');
    let size = 33;
    const data = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('LUT_3D_SIZE')) {
        size = parseInt(line.split(/\s+/)[1], 10);
        continue;
      }
      if (line.startsWith('TITLE') || line.startsWith('DOMAIN_')) continue;
      const parts = line.split(/\s+/).map(Number);
      if (parts.length === 3 && parts.every(n => !isNaN(n))) data.push(parts);
    }
    if (data.length === 0) throw new Error('No LUT data parsed');
    const lutId = ctx.makeId('lut');
    lutStore.set(lutId, { name: file.name, size, data: new Float32Array(data.flat()) });
    return lutId;
  });
}

/** Trilinear-interpolated LUT sample. r,g,b in [0,1]. */
function sampleLut(lut, r, g, b) {
  const n = lut.size;
  const scale = n - 1;
  const rf = r * scale, gf = g * scale, bf = b * scale;
  const r0 = Math.floor(rf), g0 = Math.floor(gf), b0 = Math.floor(bf);
  const r1 = Math.min(r0 + 1, scale), g1 = Math.min(g0 + 1, scale), b1 = Math.min(b0 + 1, scale);
  const dr = rf - r0, dg = gf - g0, db = bf - b0;

  const at = (ri, gi, bi) => {
    const idx = (ri + gi * n + bi * n * n) * 3;
    return [lut.data[idx], lut.data[idx + 1], lut.data[idx + 2]];
  };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  const c000 = at(r0, g0, b0), c100 = at(r1, g0, b0);
  const c010 = at(r0, g1, b0), c110 = at(r1, g1, b0);
  const c001 = at(r0, g0, b1), c101 = at(r1, g0, b1);
  const c011 = at(r0, g1, b1), c111 = at(r1, g1, b1);

  const c00 = lerp3(c000, c100, dr), c10 = lerp3(c010, c110, dr);
  const c01 = lerp3(c001, c101, dr), c11 = lerp3(c011, c111, dr);
  const c0 = lerp3(c00, c10, dg), c1 = lerp3(c01, c11, dg);
  return lerp3(c0, c1, db);
}

/* ---------------- THE RENDER PIPELINE (called by player.js per clip) ---------------- */
/** Returns true if we drew the clip (so player.js skips its default draw). */
function runEffectsPipeline({ sourceEl, clip, xform, canvasCtx, canvasW, canvasH, drawSourceWithTransform }) {
  const hasColorGrade = clip.colorGrade && hasAnyGradeValue(clip.colorGrade);
  const pixelEffects = (clip.effects || []).filter(e => e.enabled && needsPixelAccess(e.type));
  const cssFilter = buildCssFilterString(clip.colorGrade);

  if (!hasColorGrade && clip.effects?.length === 0) return false; // nothing to do — let player.js draw normally

  const srcW = sourceEl.videoWidth || sourceEl.naturalWidth || canvasW;
  const srcH = sourceEl.videoHeight || sourceEl.naturalHeight || canvasH;
  if (!srcW || !srcH) return false;

  offCanvas.width = srcW;
  offCanvas.height = srcH;
  offCtx.filter = cssFilter || 'none';
  offCtx.clearRect(0, 0, srcW, srcH);
  offCtx.drawImage(sourceEl, 0, 0, srcW, srcH);
  offCtx.filter = 'none';

  if (pixelEffects.length > 0 || clip.colorGrade?.lutId || hasLiftGammaGain(clip.colorGrade)) {
    applyPixelEffects(offCtx, srcW, srcH, clip, pixelEffects);
  }

  // Hand off to the same transform/compositing logic player.js uses for the
  // un-effected path, just with our offscreen canvas as the source image.
  // Hand off to the same transform/compositing logic player.js uses for the
  // un-effected path, just with our offscreen canvas as the source image and
  // whatever target context this draw call was given (live canvas, or one of
  // transitions.js's offscreen contexts during a blend).
  drawSourceWithTransform(offCanvas, xform, canvasW, canvasH, canvasCtx);
  return true;
}

function hasAnyGradeValue(g) {
  return g.brightness || g.contrast || g.saturation || g.temperature || g.tint || g.hue || g.lutId
    || hasLiftGammaGain(g);
}
function hasLiftGammaGain(g) {
  if (!g) return false;
  const nz = (v) => v.r !== 0 || v.g !== 0 || v.b !== 0;
  return nz(g.lift) || nz(g.gamma) || nz(g.gain);
}

function needsPixelAccess(type) {
  return ['chroma-key', 'vignette', 'grain', 'chromatic-aberration', 'crop'].includes(type);
}

/** Effects expressible via the native Canvas2D `filter` property — far
    cheaper than a manual pixel loop since the browser/GPU does the work. */
function buildCssFilterString(grade) {
  if (!grade) return '';
  const parts = [];
  if (grade.brightness) parts.push(`brightness(${1 + grade.brightness / 100})`);
  if (grade.contrast) parts.push(`contrast(${1 + grade.contrast / 100})`);
  if (grade.saturation) parts.push(`saturate(${1 + grade.saturation / 100})`);
  if (grade.hue) parts.push(`hue-rotate(${grade.hue}deg)`);
  return parts.join(' ');
}

/** Manual per-pixel pass for everything CSS filter can't express:
    lift/gamma/gain, temperature/tint, LUT sampling, chroma key, vignette,
    grain, chromatic aberration, crop. Runs once per drawn frame per clip
    that uses one of these — acceptable at preview resolution (quarter/half),
    and export.js will run it at full res per output frame (slower, but
    export is already an offline/batch operation, not realtime).
    Order applied: lift/gamma/gain+temp/tint -> LUT -> chroma key -> vignette
    -> grain. Chromatic aberration is a channel-shift, applied as the very
    last pixel op since it offsets sampling, not color. Crop just blanks
    pixels outside the crop rect. */
function applyPixelEffects(offscreenCtx, w, h, clip, pixelEffects) {
  const grade = clip.colorGrade;
  const lut = grade?.lutId ? lutStore.get(grade.lutId) : null;
  const chromaKey = pixelEffects.find(e => e.type === 'chroma-key');
  const vignette = pixelEffects.find(e => e.type === 'vignette');
  const grain = pixelEffects.find(e => e.type === 'grain');
  const aberration = pixelEffects.find(e => e.type === 'chromatic-aberration');
  const crop = pixelEffects.find(e => e.type === 'crop');

  const imgData = offscreenCtx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const keyRgb = chromaKey ? hexToRgb(chromaKey.params.keyColor) : null;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      let a = d[i + 3] / 255;

      if (grade) {
        [r, g, b] = applyLiftGammaGain(r, g, b, grade);
        [r, g, b] = applyTemperatureTint(r, g, b, grade.temperature, grade.tint);
      }
      if (lut) [r, g, b] = sampleLut(lut, clampUnit(r), clampUnit(g), clampUnit(b));

      if (chromaKey && keyRgb) {
        a *= chromaKeyAlpha(r, g, b, keyRgb, chromaKey.params.tolerance, chromaKey.params.softness);
      }
      if (vignette) {
        const dx = (px / w - 0.5), dy = (py / h - 0.5);
        const dist = Math.sqrt(dx * dx + dy * dy) / 0.707;
        const falloff = Math.max(0, dist - (1 - vignette.params.radius)) / Math.max(0.001, vignette.params.radius);
        const dark = 1 - Math.min(1, falloff) * vignette.params.amount;
        r *= dark; g *= dark; b *= dark;
      }
      if (grain) {
        const n = (pseudoRandom(px, py) - 0.5) * grain.params.amount;
        r += n; g += n; b += n;
      }
      if (crop) {
        const inX = px >= w * crop.params.left && px <= w * (1 - crop.params.right);
        const inY = py >= h * crop.params.top && py <= h * (1 - crop.params.bottom);
        if (!inX || !inY) a = 0;
      }

      d[i] = clampUnit(r) * 255;
      d[i + 1] = clampUnit(g) * 255;
      d[i + 2] = clampUnit(b) * 255;
      d[i + 3] = clampUnit(a) * 255;
    }
  }

  if (aberration) {
    applyChromaticAberration(d, w, h, aberration.params.amount);
  }

  offscreenCtx.putImageData(imgData, 0, 0);
}

function applyLiftGammaGain(r, g, b, grade) {
  const lift = grade.lift, gamma = grade.gamma, gain = grade.gain;
  const applyChan = (v, l, gm, gn) => {
    let out = v + l * 0.5;             // lift: shifts shadows
    out = Math.pow(Math.max(0, out), 1 / (1 + gm * 0.8)); // gamma: midtone curve
    out = out * (1 + gn * 0.8);         // gain: highlight scale
    return out;
  };
  return [
    applyChan(r, lift.r, gamma.r, gain.r),
    applyChan(g, lift.g, gamma.g, gain.g),
    applyChan(b, lift.b, gamma.b, gain.b),
  ];
}

function applyTemperatureTint(r, g, b, temperature = 0, tint = 0) {
  const t = temperature / 100, ti = tint / 100;
  return [
    r + t * 0.15 - ti * 0.05,
    g + ti * 0.1,
    b - t * 0.15 - ti * 0.05,
  ];
}

function chromaKeyAlpha(r, g, b, keyRgb, tolerance, softness) {
  const dist = Math.sqrt(
    (r - keyRgb.r) ** 2 + (g - keyRgb.g) ** 2 + (b - keyRgb.b) ** 2
  ) / Math.sqrt(3);
  if (dist < tolerance) return 0;
  if (dist < tolerance + softness) return (dist - tolerance) / softness;
  return 1;
}

function applyChromaticAberration(d, w, h, amount) {
  const shift = Math.round(amount);
  if (shift <= 0) return;
  const copy = new Uint8ClampedArray(d);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      const rx = Math.min(w - 1, px + shift);
      const bx = Math.max(0, px - shift);
      d[i] = copy[(py * w + rx) * 4];       // red channel shifted right
      d[i + 2] = copy[(py * w + bx) * 4 + 2]; // blue channel shifted left
    }
  }
}

function pseudoRandom(x, y) {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function clampUnit(v) { return Math.max(0, Math.min(1, v)); }

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 1, b: 0 };
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  addEffectToClip,
  removeEffectFromClip,
  updateEffectParams,
  ensureColorGrade,
  runEffectsPipeline,
  EFFECT_DEFS,
};
