/* ============================================================
   CutFlow Studio — text.js
   Owns: clip.textConfig (for overlay-track clips), the Titles browser
   (left panel), text rendering during player.js's per-clip draw pass via
   the 'text:renderRequest' bus event, shape overlays, and watermark/logo
   overlay clips (which are just textConfig-less image clips with opacity —
   handled by the normal video draw path, not this file, except for the
   opacity control surfaced in keyframes.js's Transform group already).

   textConfig shape:
     {
       text, fontFamily, fontSize, color, weight, align,
       animation: 'none'|'fade'|'slide-up'|'slide-down'|'typewriter',
       animationDuration,
       shape: null | { type: 'rect'|'circle'|'line'|'arrow', color, strokeWidth }
     }

   Text/shape clips live on overlay tracks (track.type === 'overlay').
   timeline.js already supports adding tracks of type 'overlay'? — checking
   addTrack(): it currently only wires video/audio buttons in the toolbar.
   text.js adds its own "+ Add Title" flow that creates an overlay track
   on demand if none exists, rather than waiting on a toolbar button.
   ============================================================ */

let ctx;
let player;

const TEXT_TEMPLATES = [
  { id: 'lower-third', label: 'Lower Third', preview: 'Name — Title', build: () => ({
    text: 'Your Name\nTitle / Role', fontFamily: 'Inter', fontSize: 42, color: '#ffffff', weight: '700',
    align: 'left', animation: 'slide-up', animationDuration: 0.5, position: 'lower-third', shape: null,
  }) },
  { id: 'title-card', label: 'Title Card', preview: 'BIG TITLE', build: () => ({
    text: 'YOUR TITLE HERE', fontFamily: 'Inter', fontSize: 96, color: '#ffffff', weight: '800',
    align: 'center', animation: 'fade', animationDuration: 0.8, position: 'center', shape: null,
  }) },
  { id: 'end-card', label: 'End Card', preview: 'Thanks for watching', build: () => ({
    text: 'Thanks for watching!\nSubscribe for more', fontFamily: 'Inter', fontSize: 56, color: '#ffffff',
    weight: '600', align: 'center', animation: 'fade', animationDuration: 1, position: 'center', shape: null,
  }) },
  { id: 'caption', label: 'Caption / Subtitle', preview: 'Caption text', build: () => ({
    text: 'Caption text goes here', fontFamily: 'Inter', fontSize: 36, color: '#ffffff', weight: '500',
    align: 'center', animation: 'none', animationDuration: 0, position: 'bottom', shape: null,
  }) },
  { id: 'callout', label: 'Callout Box', preview: '[ Callout ]', build: () => ({
    text: 'Callout', fontFamily: 'Inter', fontSize: 32, color: '#ffffff', weight: '600',
    align: 'center', animation: 'fade', animationDuration: 0.4, position: 'top',
    shape: { type: 'rect', color: 'rgba(0,0,0,0.6)', strokeWidth: 0 },
  }) },
];

const GOOGLE_FONTS = ['Inter', 'Roboto', 'Montserrat', 'Playfair Display', 'Bebas Neue', 'Oswald', 'Lato', 'Poppins'];
const loadedFonts = new Set();

function init(_ctx) {
  ctx = _ctx;
  renderTextTemplatesBrowser();
  ctx.bus.on('text:renderRequest', onTextRenderRequest);
  loadGoogleFont('Inter'); // default font, load immediately so first preview isn't using fallback serif
}

import * as playerModule from './player.js';
player = playerModule;

/* ---------------- GOOGLE FONTS LOADING ---------------- */
function loadGoogleFont(family) {
  if (loadedFonts.has(family)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@300;400;500;600;700;800;900&display=swap`;
  document.head.appendChild(link);
  loadedFonts.add(family);
}

function registerUploadedFont(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const fontFamily = file.name.replace(/\.[^.]+$/, '');
        const fontFace = new FontFace(fontFamily, reader.result);
        await fontFace.load();
        document.fonts.add(fontFace);
        loadedFonts.add(fontFamily);
        resolve(fontFamily);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/* ---------------- TITLES BROWSER (left panel) ---------------- */
function renderTextTemplatesBrowser() {
  const list = document.getElementById('text-templates-list');
  if (!list) return;
  list.innerHTML = '';

  const uploadRow = document.createElement('div');
  uploadRow.className = 'cf-panel-toolbar';
  uploadRow.style.margin = '0 0 var(--sp-3)';
  const btnUploadFont = document.createElement('button');
  btnUploadFont.className = 'cf-btn cf-btn-sm';
  btnUploadFont.textContent = '+ Upload Font';
  const fontInput = document.createElement('input');
  fontInput.type = 'file';
  fontInput.accept = '.ttf,.otf,.woff,.woff2';
  fontInput.hidden = true;
  btnUploadFont.addEventListener('click', () => fontInput.click());
  fontInput.addEventListener('change', async () => {
    const file = fontInput.files?.[0];
    if (!file) return;
    try {
      const family = await registerUploadedFont(file);
      ctx.showToast(`Font "${family}" loaded`, 'success');
    } catch {
      ctx.showToast('Could not load font file', 'error');
    }
  });
  uploadRow.appendChild(btnUploadFont);
  uploadRow.appendChild(fontInput);
  list.appendChild(uploadRow);

  for (const tpl of TEXT_TEMPLATES) {
    list.appendChild(buildTemplateCard(tpl));
  }

  // Shape overlay quick-adds
  const shapeHeading = document.createElement('div');
  shapeHeading.className = 'cf-fx-category';
  shapeHeading.textContent = 'Shapes';
  list.appendChild(shapeHeading);
  for (const shapeType of ['rect', 'circle', 'line', 'arrow']) {
    list.appendChild(buildShapeListItem(shapeType));
  }
}

function buildTemplateCard(tpl) {
  const card = document.createElement('div');
  card.className = 'cf-text-template-card';
  card.draggable = true;

  const preview = document.createElement('div');
  preview.className = 'cf-text-template-preview';
  preview.textContent = tpl.preview;
  card.appendChild(preview);

  const label = document.createElement('div');
  label.className = 'cf-text-template-label';
  label.textContent = tpl.label;
  card.appendChild(label);

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/cutflow-text-template', tpl.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  card.addEventListener('dblclick', () => addTextClipAtPlayhead(tpl));

  return card;
}

function buildShapeListItem(shapeType) {
  const item = document.createElement('div');
  item.className = 'cf-fx-item';
  const icon = document.createElement('div');
  icon.className = 'cf-fx-item-icon';
  icon.textContent = { rect: '▭', circle: '◯', line: '╱', arrow: '➜' }[shapeType];
  item.appendChild(icon);
  const label = document.createElement('div');
  label.className = 'cf-fx-item-label';
  label.textContent = shapeType[0].toUpperCase() + shapeType.slice(1);
  item.appendChild(label);
  item.addEventListener('dblclick', () => addShapeClipAtPlayhead(shapeType));
  return item;
}

/* ---------------- ADDING TEXT/SHAPE CLIPS ---------------- */
function ensureOverlayTrack() {
  let track = ctx.AppState.project.tracks.find(t => t.type === 'overlay');
  if (track) return track;
  ctx.history.capture();
  track = { id: ctx.makeId('track'), type: 'overlay', name: 'Titles', clips: [], muted: false, locked: false };
  // Overlay tracks render above all video tracks — insert at the very front
  // so player.js's reversed-stack draw order puts it on top.
  ctx.AppState.project.tracks.unshift(track);
  ctx.AppState.markDirty('timeline:trackAdded', { track });
  ctx.bus.emit('timeline:rendered', {});
  return track;
}

function addTextClipAtPlayhead(tpl) {
  const track = ensureOverlayTrack();
  const t = ctx.AppState.project.playback.currentTime;
  const config = tpl.build();
  loadGoogleFont(config.fontFamily);

  ctx.history.capture();
  const clip = {
    id: ctx.makeId('clip'),
    trackId: track.id,
    mediaId: null, // overlay text/shape clips have no underlying media asset
    start: t,
    duration: 4,
    trimIn: 0,
    trimOut: 4,
    label: tpl.label,
    fadeIn: 0, fadeOut: 0,
    transitionIn: null, transitionOut: null,
    effects: [],
    textConfig: config,
    keyframes: {},
  };
  track.clips.push(clip);
  track.clips.sort((a, b) => a.start - b.start);
  ctx.AppState.markDirty('text:clipAdded', { clipId: clip.id });
  ctx.bus.emit('timeline:rendered', {});
  player.renderCurrentFrame();
  ctx.showToast(`Added "${tpl.label}"`, 'success');
}

function addShapeClipAtPlayhead(shapeType) {
  const track = ensureOverlayTrack();
  const t = ctx.AppState.project.playback.currentTime;

  ctx.history.capture();
  const clip = {
    id: ctx.makeId('clip'),
    trackId: track.id,
    mediaId: null,
    start: t,
    duration: 3,
    trimIn: 0,
    trimOut: 3,
    label: `${shapeType} shape`,
    fadeIn: 0, fadeOut: 0,
    transitionIn: null, transitionOut: null,
    effects: [],
    textConfig: {
      text: '', fontFamily: 'Inter', fontSize: 32, color: '#ffffff', weight: '500',
      align: 'center', animation: 'fade', animationDuration: 0.3, position: 'center',
      shape: { type: shapeType, color: '#6c8cff', strokeWidth: 4 },
    },
    keyframes: {},
  };
  track.clips.push(clip);
  track.clips.sort((a, b) => a.start - b.start);
  ctx.AppState.markDirty('text:shapeAdded', { clipId: clip.id });
  ctx.bus.emit('timeline:rendered', {});
  player.renderCurrentFrame();
}

function updateTextConfig(clipId, patch) {
  const clip = ctx.AppState.getClipById(clipId);
  if (!clip?.textConfig) return;
  Object.assign(clip.textConfig, patch);
  if (patch.fontFamily) loadGoogleFont(patch.fontFamily);
  ctx.AppState.markDirty('text:configChanged', { clipId });
  player.renderCurrentFrame();
}

/* ---------------- RENDERING (called by player.js via bus event) ---------------- */
function onTextRenderRequest({ canvasCtx, clip, canvasW, canvasH, offsetIntoClip }) {
  const cfg = clip.textConfig;
  if (!cfg) return;

  const progress = cfg.animationDuration > 0 ? Math.min(1, offsetIntoClip / cfg.animationDuration) : 1;
  const fadeOutStart = clip.duration - (cfg.animationDuration || 0);
  const outProgress = cfg.animationDuration > 0 && offsetIntoClip > fadeOutStart
    ? Math.min(1, (offsetIntoClip - fadeOutStart) / cfg.animationDuration)
    : 0;

  const { alpha, offsetY } = computeAnimationState(cfg.animation, progress, outProgress, canvasH);

  canvasCtx.save();
  canvasCtx.globalAlpha = alpha;

  if (cfg.shape) drawShape(canvasCtx, cfg.shape, canvasW, canvasH);
  if (cfg.text) drawText(canvasCtx, cfg, canvasW, canvasH, offsetY, offsetIntoClip);

  canvasCtx.restore();
}

function computeAnimationState(animation, progress, outProgress, canvasH) {
  let alpha = 1, offsetY = 0;
  switch (animation) {
    case 'fade':
      alpha = Math.min(progress, 1 - outProgress);
      break;
    case 'slide-up':
      offsetY = (1 - progress) * 40;
      alpha = Math.min(progress * 2, 1, 1 - outProgress);
      break;
    case 'slide-down':
      offsetY = -(1 - progress) * 40;
      alpha = Math.min(progress * 2, 1, 1 - outProgress);
      break;
    case 'typewriter':
      alpha = 1 - outProgress; // character reveal handled in drawText via progress
      break;
    default:
      alpha = 1 - outProgress;
  }
  return { alpha: Math.max(0, alpha), offsetY };
}

function drawText(canvasCtx, cfg, canvasW, canvasH, offsetY, offsetIntoClip) {
  const lines = cfg.text.split('\n');
  const fontSize = cfg.fontSize * (canvasW / 1920); // scale relative to a 1920-wide reference so text stays proportional at lower preview resolutions
  canvasCtx.font = `${cfg.weight} ${fontSize}px "${cfg.fontFamily}", sans-serif`;
  canvasCtx.fillStyle = cfg.color;
  canvasCtx.textAlign = cfg.align;
  canvasCtx.textBaseline = 'middle';
  canvasCtx.shadowColor = 'rgba(0,0,0,0.6)';
  canvasCtx.shadowBlur = fontSize * 0.08;

  const x = cfg.align === 'left' ? canvasW * 0.08 : cfg.align === 'right' ? canvasW * 0.92 : canvasW / 2;
  const baseY = positionToY(cfg.position, canvasH, lines.length, fontSize);

  let displayLines = lines;
  if (cfg.animation === 'typewriter') {
    const fullText = lines.join('\n');
    const charsToShow = Math.floor((offsetIntoClip / Math.max(0.3, cfg.animationDuration || 1.5)) * fullText.length);
    displayLines = fullText.slice(0, Math.max(0, charsToShow)).split('\n');
  }

  displayLines.forEach((line, i) => {
    canvasCtx.fillText(line, x, baseY + offsetY + i * fontSize * 1.25);
  });
}

function positionToY(position, canvasH, lineCount, fontSize) {
  const blockHeight = lineCount * fontSize * 1.25;
  switch (position) {
    case 'top': return canvasH * 0.12 + blockHeight / 2;
    case 'lower-third': return canvasH * 0.78;
    case 'bottom': return canvasH * 0.9;
    case 'center':
    default: return canvasH / 2;
  }
}

function drawShape(canvasCtx, shape, canvasW, canvasH) {
  canvasCtx.fillStyle = shape.color;
  canvasCtx.strokeStyle = shape.color;
  canvasCtx.lineWidth = shape.strokeWidth || 0;

  const cx = canvasW / 2, cy = canvasH / 2;
  const w = canvasW * 0.4, h = canvasH * 0.15;

  switch (shape.type) {
    case 'rect':
      if (shape.strokeWidth > 0) canvasCtx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      else canvasCtx.fillRect(cx - w / 2, cy - h / 2, w, h);
      break;
    case 'circle':
      canvasCtx.beginPath();
      canvasCtx.arc(cx, cy, Math.min(w, h) / 2, 0, Math.PI * 2);
      if (shape.strokeWidth > 0) canvasCtx.stroke(); else canvasCtx.fill();
      break;
    case 'line':
      canvasCtx.lineWidth = Math.max(2, shape.strokeWidth);
      canvasCtx.beginPath();
      canvasCtx.moveTo(cx - w / 2, cy);
      canvasCtx.lineTo(cx + w / 2, cy);
      canvasCtx.stroke();
      break;
    case 'arrow':
      canvasCtx.lineWidth = Math.max(2, shape.strokeWidth);
      canvasCtx.beginPath();
      canvasCtx.moveTo(cx - w / 2, cy);
      canvasCtx.lineTo(cx + w / 2, cy);
      canvasCtx.moveTo(cx + w / 2 - 16, cy - 12);
      canvasCtx.lineTo(cx + w / 2, cy);
      canvasCtx.lineTo(cx + w / 2 - 16, cy + 12);
      canvasCtx.stroke();
      break;
  }
}

/* ---------------- WATERMARK / LOGO OVERLAY ---------------- */
/** A watermark is just an image clip on an overlay track with a fixed
    opacity and position — it reuses the existing image-clip draw path in
    player.js/effects.js (opacity already comes from keyframes.js's
    staticTransform.opacity), so text.js only needs to provide the
    convenience "Add Watermark" action that creates such a clip spanning
    the whole project duration. */
function addWatermarkClip(mediaId) {
  const media = ctx.AppState.getMediaById(mediaId);
  if (!media || media.type !== 'image') {
    ctx.showToast('Select an image in the media bin first', 'warning');
    return;
  }
  const track = ensureOverlayTrack();
  ctx.history.capture();
  const duration = Math.max(1, ctx.AppState.getDuration());
  const clip = {
    id: ctx.makeId('clip'),
    trackId: track.id,
    mediaId,
    start: 0,
    duration,
    trimIn: 0,
    trimOut: duration,
    label: `Watermark: ${media.name}`,
    fadeIn: 0, fadeOut: 0,
    transitionIn: null, transitionOut: null,
    effects: [],
    textConfig: null,
    keyframes: {},
    staticTransform: { x: canvasCornerOffset().x, y: canvasCornerOffset().y, scale: 0.15, rotation: 0, opacity: 0.7 },
  };
  track.clips.push(clip);
  ctx.AppState.markDirty('text:watermarkAdded', { clipId: clip.id });
  ctx.bus.emit('timeline:rendered', {});
  player.renderCurrentFrame();
}

function canvasCornerOffset() {
  const { width, height } = ctx.AppState.project.settings;
  return { x: width * 0.35, y: height * 0.4 }; // bottom-right-ish default placement
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  addTextClipAtPlayhead,
  addShapeClipAtPlayhead,
  addWatermarkClip,
  updateTextConfig,
  registerUploadedFont,
  TEXT_TEMPLATES,
  GOOGLE_FONTS,
};
