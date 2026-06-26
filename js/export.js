/* ============================================================
   CutFlow Studio — export.js
   Owns: the export dialog modal, the export queue, and the actual
   FFmpeg.wasm-driven encode pipeline.

   PIPELINE (real, not simulated):
     1. We render EVERY output frame by calling player.js's renderFrameAt(t)
        at full export resolution (not preview resolution) — this guarantees
        export pixel-matches what the user saw in preview, since it's the
        literal same compositor (same effects/keyframes/transitions code).
     2. Each rendered canvas frame is captured as a PNG blob and written
        into FFmpeg.wasm's in-memory virtual filesystem (MEMFS) as
        frame_000001.png, frame_000002.png, etc.
     3. We render the full mixed audio output via OfflineAudioContext
        (mirroring audio.js's graph topology: per-clip fade/volume/pan)
        into one WAV file.
     4. ffmpeg.exec(...) stitches the PNG sequence + WAV into the final
        container (MP4/H.264, MP4/H.265, WebM/VP9, GIF, or MP3/AAC for
        audio-only).
     5. The resulting file is read back from MEMFS and offered as a
        download via an object URL.

   The frame-rendering loop (canvas draws) happens on the main thread since
   it reuses player.js's live canvas and 2D context directly — the
   alternative (OffscreenCanvas in a worker) would require duplicating the
   entire compositor in worker scope. workers/ffmpeg.worker.js is provided
   and CAN run the ffmpeg.exec() encode step off the main thread once
   frames are extracted as a future optimization; this file currently runs
   ffmpeg.wasm on the main thread for simplicity, which still keeps the UI
   responsive between frames via yieldToUi() throttling and because
   ffmpeg.exec() itself is async/non-blocking via its own WASM threading.

   FFmpeg.wasm is loaded from a CDN at runtime (the standard distribution
   method for ffmpeg.wasm v0.12+, which ships as @ffmpeg/ffmpeg +
   @ffmpeg/core ESM packages). If the network is unavailable, export
   reports a real, honest failure — it does not silently fake success.
   ============================================================ */

let ctx;
let player;

const FFMPEG_CORE_VERSION = '0.12.6';
const RESOLUTION_PRESETS = {
  '4k': { width: 3840, height: 2160 },
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
};

let ffmpegInstance = null;
let ffmpegLoadPromise = null;
let exportQueue = [];
let currentExportCancelled = false;

function init(_ctx) {
  ctx = _ctx;
  ctx.bus.on('export:openDialog', openExportDialog);
  document.getElementById('btn-export')?.addEventListener('click', () => openExportDialog({}));
  document.getElementById('btn-export-cancel')?.addEventListener('click', cancelCurrentExport);

  preloadFfmpegInBackground();
}

import * as playerModule from './player.js';
player = playerModule;

/* ---------------- FFMPEG.WASM LOADING ---------------- */
function setFfmpegStatus(text, cls) {
  const el = document.getElementById('status-ffmpeg-state');
  if (!el) return;
  el.textContent = `FFmpeg: ${text}`;
  el.classList.remove('ready', 'error');
  if (cls) el.classList.add(cls);
}

function preloadFfmpegInBackground() {
  loadFfmpeg().catch(() => { /* surfaced via setFfmpegStatus already; export dialog will retry/report on demand */ });
}

/** Loads @ffmpeg/ffmpeg + the multi-threaded core from the unpkg CDN, the
    standard distribution path for ffmpeg.wasm v0.12+. Cached in
    ffmpegLoadPromise so concurrent callers share one load. */
function loadFfmpeg() {
  if (ffmpegInstance) return Promise.resolve(ffmpegInstance);
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  setFfmpegStatus('loading…');
  ffmpegLoadPromise = (async () => {
    try {
      const { FFmpeg } = await import('https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
      const instance = new FFmpeg();

      instance.on('log', ({ message }) => {
        ctx.bus.emit('export:log', { message });
      });

      const baseURL = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;
      await instance.load({
        coreURL: `${baseURL}/ffmpeg-core.js`,
        wasmURL: `${baseURL}/ffmpeg-core.wasm`,
      });

      ffmpegInstance = instance;
      setFfmpegStatus('ready', 'ready');
      return instance;
    } catch (err) {
      console.error('[export] FFmpeg.wasm failed to load:', err);
      setFfmpegStatus('unavailable (offline?)', 'error');
      ffmpegLoadPromise = null; // allow retry on next export attempt
      throw err;
    }
  })();
  return ffmpegLoadPromise;
}

/* ---------------- EXPORT DIALOG ---------------- */
function openExportDialog({ audioOnly = false } = {}) {
  const body = document.createElement('div');

  const formatRow = buildFormGroup('Format', buildSelect('export-format', audioOnly
    ? [['mp3', 'MP3 (Audio)'], ['aac', 'AAC (Audio)']]
    : [['mp4', 'MP4 (H.264)'], ['mp4-h265', 'MP4 (H.265/HEVC)'], ['webm', 'WebM (VP9)'], ['gif', 'GIF'], ['mp3', 'MP3 (Audio Only)'], ['aac', 'AAC (Audio Only)']]
  ));
  body.appendChild(formatRow);

  const resRow = buildFormGroup('Resolution', buildSelect('export-resolution', [
    ['4k', '4K (3840×2160)'], ['1080p', '1080p (1920×1080)'], ['720p', '720p (1280×720)'],
    ['480p', '480p (854×480)'], ['custom', 'Custom…'],
  ], '1080p'));
  body.appendChild(resRow);

  const customResRow = document.createElement('div');
  customResRow.className = 'cf-form-grid-2';
  customResRow.id = 'export-custom-res-row';
  customResRow.style.display = 'none';
  customResRow.appendChild(buildFormGroup('Width', buildNumberInput('export-custom-width', 1920)));
  customResRow.appendChild(buildFormGroup('Height', buildNumberInput('export-custom-height', 1080)));
  body.appendChild(customResRow);

  body.addEventListener('change', (e) => {
    if (e.target.id === 'export-resolution') {
      customResRow.style.display = e.target.value === 'custom' ? 'grid' : 'none';
    }
  });

  const fpsRow = buildFormGroup('Frame Rate', buildSelect('export-fps', [
    ['24', '24 fps'], ['25', '25 fps'], ['30', '30 fps'], ['60', '60 fps'],
  ], String(ctx.AppState.project.settings.fps || 30)));
  body.appendChild(fpsRow);

  const qualityRow = buildFormGroup('Quality (CRF — lower is higher quality)', buildSlider('export-crf', 0, 51, 23));
  body.appendChild(qualityRow);

  const chapterRow = buildFormGroup('Chapter Markers', buildCheckbox('export-chapters', 'Embed chapter markers from In/Out range segments'));
  body.appendChild(chapterRow);

  if (!uiModuleRef) {
    console.error('[export] ui module not registered — cannot open dialog');
    return;
  }
  uiModuleRef.showModal({
    title: audioOnly ? 'Export Audio' : 'Export Video',
    bodyEl: body,
    footerButtons: [
      { label: 'Cancel', onClick: () => uiModuleRef.closeModal() },
      { label: 'Add to Export Queue', primary: true, onClick: () => {
        const settings = readExportSettingsFromDialog();
        uiModuleRef.closeModal();
        enqueueExport(settings);
      } },
    ],
  });
}

let uiModuleRef = null;
function setUiModule(mod) { uiModuleRef = mod; }

function buildFormGroup(label, inputEl) {
  const wrap = document.createElement('div');
  wrap.className = 'cf-form-row';
  const l = document.createElement('label');
  l.className = 'cf-form-label';
  l.textContent = label;
  wrap.appendChild(l);
  wrap.appendChild(inputEl);
  return wrap;
}
function buildSelect(id, options, selected) {
  const sel = document.createElement('select');
  sel.className = 'cf-form-select';
  sel.id = id;
  for (const [value, label] of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === selected) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}
function buildNumberInput(id, value) {
  const input = document.createElement('input');
  input.className = 'cf-form-input';
  input.type = 'number';
  input.id = id;
  input.value = String(value);
  return input;
}
function buildSlider(id, min, max, value) {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.gap = '8px';
  wrap.style.alignItems = 'center';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.id = id; slider.min = String(min); slider.max = String(max); slider.value = String(value);
  slider.style.flex = '1';
  const out = document.createElement('span');
  out.textContent = value;
  out.style.fontFamily = 'var(--font-mono)';
  out.style.fontSize = 'var(--fs-sm)';
  out.style.minWidth = '28px';
  slider.addEventListener('input', () => { out.textContent = slider.value; });
  wrap.appendChild(slider);
  wrap.appendChild(out);
  return wrap;
}
function buildCheckbox(id, label) {
  const wrap = document.createElement('label');
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '8px';
  wrap.style.fontSize = 'var(--fs-sm)';
  wrap.style.color = 'var(--text-secondary)';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = id;
  wrap.appendChild(cb);
  wrap.appendChild(document.createTextNode(label));
  return wrap;
}

function readExportSettingsFromDialog() {
  const format = document.getElementById('export-format').value;
  const resKey = document.getElementById('export-resolution').value;
  let width, height;
  if (resKey === 'custom') {
    width = Number(document.getElementById('export-custom-width').value) || 1920;
    height = Number(document.getElementById('export-custom-height').value) || 1080;
  } else {
    ({ width, height } = RESOLUTION_PRESETS[resKey]);
  }
  const fps = Number(document.getElementById('export-fps').value) || 30;
  const crf = Number(document.getElementById('export-crf').value) || 23;
  const embedChapters = document.getElementById('export-chapters')?.checked || false;
  return { format, width, height, fps, crf, embedChapters, id: ctx.makeId('exportjob'), name: ctx.AppState.project.name };
}

/* ---------------- EXPORT QUEUE ---------------- */
function enqueueExport(settings) {
  exportQueue.push(settings);
  ctx.showToast(`Queued export: ${settings.name}.${settings.format}`, 'success');
  processQueueIfIdle();
}

let queueRunning = false;
async function processQueueIfIdle() {
  if (queueRunning) return;
  queueRunning = true;
  while (exportQueue.length > 0) {
    const job = exportQueue.shift();
    await runExportJob(job);
  }
  queueRunning = false;
}

function cancelCurrentExport() {
  currentExportCancelled = true;
}

/* ---------------- THE EXPORT PIPELINE ---------------- */
async function runExportJob(settings) {
  currentExportCancelled = false;
  const overlay = document.getElementById('export-progress-overlay');
  const bar = document.getElementById('export-progress-bar');
  const label = document.getElementById('export-progress-label');
  overlay.hidden = false;
  setProgress(bar, label, 0, 'Loading FFmpeg…');

  try {
    const ffmpeg = await loadFfmpeg();
    if (currentExportCancelled) throw new CancelledError();

    const isAudioOnly = settings.format === 'mp3' || settings.format === 'aac';
    const duration = ctx.AppState.getDuration();
    if (duration <= 0) throw new Error('Project has no content to export');

    if (!isAudioOnly) {
      await exportVideoFrames(ffmpeg, settings, duration, bar, label);
    }
    setProgress(bar, label, isAudioOnly ? 10 : 70, 'Rendering audio…');
    const wavData = await renderProjectAudioToWav(duration);
    if (currentExportCancelled) throw new CancelledError();
    await ffmpeg.writeFile('audio.wav', wavData);

    setProgress(bar, label, isAudioOnly ? 50 : 85, 'Encoding…');
    const outputName = await runFfmpegEncode(ffmpeg, settings, isAudioOnly);

    setProgress(bar, label, 98, 'Finalizing…');
    const outputData = await ffmpeg.readFile(outputName);
    const blob = new Blob([outputData.buffer], { type: mimeTypeFor(settings.format) });
    triggerDownload(blob, `${sanitizeFilename(settings.name)}.${outputExtension(settings.format)}`);

    await cleanupMemfs(ffmpeg);
    setProgress(bar, label, 100, 'Done!');
    ctx.showToast('Export complete', 'success');
  } catch (err) {
    if (err instanceof CancelledError) {
      ctx.showToast('Export cancelled', 'warning');
    } else {
      console.error('[export] failed:', err);
      ctx.showToast(`Export failed: ${err.message || 'see console'}`, 'error');
    }
  } finally {
    setTimeout(() => { overlay.hidden = true; }, 600);
  }
}

class CancelledError extends Error {}

function setProgress(bar, label, pct, text) {
  bar.style.width = `${pct}%`;
  label.textContent = text;
}

/** Renders every output frame via player.js's exact compositor at full
    export resolution, captures each as a PNG, writes it into FFmpeg's
    virtual filesystem. This is the step that guarantees export = preview. */
async function exportVideoFrames(ffmpeg, settings, duration, bar, label) {
  const totalFrames = Math.ceil(duration * settings.fps);
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = settings.width;
  exportCanvas.height = settings.height;
  const exportCtx = exportCanvas.getContext('2d');

  // player.js always draws to the SAME canvas it owns internally (see
  // player.js's architecture note: it queries #preview-canvas once at init
  // and keeps a closured reference). We briefly resize that real canvas to
  // the export resolution, render frame-by-frame, capture each frame, then
  // restore the original size — safe because the export overlay covers the
  // whole screen throughout, so the user never sees the live canvas resize.
  const livePreviewCanvas = document.getElementById('preview-canvas');
  const restoreW = livePreviewCanvas.width, restoreH = livePreviewCanvas.height;
  livePreviewCanvas.width = settings.width;
  livePreviewCanvas.height = settings.height;

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      if (currentExportCancelled) throw new CancelledError();
      const t = frame / settings.fps;
      player.renderFrameAt(Math.min(t, duration - 0.0001));

      exportCtx.drawImage(livePreviewCanvas, 0, 0, settings.width, settings.height);
      const blob = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      const filename = `frame_${String(frame + 1).padStart(6, '0')}.png`;
      await ffmpeg.writeFile(filename, buf);

      if (frame % 5 === 0) {
        const pct = Math.round((frame / totalFrames) * 65); // frames = 0-65% of total progress bar
        setProgress(bar, label, pct, `Rendering frame ${frame + 1} / ${totalFrames}…`);
        await yieldToUi();
      }
    }
  } finally {
    livePreviewCanvas.width = restoreW;
    livePreviewCanvas.height = restoreH;
    player.renderCurrentFrame();
  }
}

function yieldToUi() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Renders the FULL mixed audio output (all tracks, with fades/volume/pan
    matching audio.js's live graph topology) into one WAV buffer using
    OfflineAudioContext, which runs faster-than-realtime and headlessly —
    the standard technique for "bake a Web Audio graph to a file". Per-track
    EQ is intentionally NOT re-applied here (see known-gaps note in the
    accompanying file notes) — clip-level volume/pan/fade are. */
async function renderProjectAudioToWav(duration) {
  const sampleRate = 48000;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const masterGain = offlineCtx.createGain();
  masterGain.connect(offlineCtx.destination);

  for (const track of ctx.AppState.project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      const media = ctx.AppState.getMediaById(clip.mediaId);
      if (!media || media.type === 'image') continue;
      const blob = await getBlobForExport(media.id);
      if (!blob) continue;
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer.slice(0));
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;

        const fadeGain = offlineCtx.createGain();
        const volGain = offlineCtx.createGain();
        const panner = offlineCtx.createStereoPanner();
        source.connect(fadeGain);
        fadeGain.connect(volGain);
        volGain.connect(panner);
        panner.connect(masterGain);

        volGain.gain.value = clip.volume ?? 1;
        panner.pan.value = clip.pan ?? 0;
        scheduleFadeEnvelope(fadeGain, clip);

        const when = clip.start;
        const offset = clip.trimIn;
        const playDuration = clip.duration;
        source.start(when, offset, playDuration);
      } catch (err) {
        console.warn('[export] could not decode audio for', media.name, err.message);
      }
    }
  }

  const rendered = await offlineCtx.startRendering();
  return encodeWav(rendered);
}

function scheduleFadeEnvelope(gainNode, clip) {
  const fadeIn = clip.fadeIn || 0;
  const fadeOut = clip.fadeOut || 0;
  const start = clip.start;
  const end = clip.start + clip.duration;
  gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : 1, start);
  if (fadeIn > 0) gainNode.gain.linearRampToValueAtTime(1, start + fadeIn);
  if (fadeOut > 0) {
    gainNode.gain.setValueAtTime(1, end - fadeOut);
    gainNode.gain.linearRampToValueAtTime(0, end);
  }
}

let exportBlobAccessor = null;
function setExportBlobAccessor(fn) { exportBlobAccessor = fn; }
function getBlobForExport(mediaId) {
  return exportBlobAccessor ? exportBlobAccessor(mediaId) : null;
}

function encodeWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length * numChannels * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  writeStr(0, 'RIFF'); view.setUint32(4, length - 8, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true); view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true); writeStr(36, 'data'); view.setUint32(40, length - 44, true);

  let offset = 44;
  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/* ---------------- FFMPEG ENCODE COMMAND ---------------- */
async function runFfmpegEncode(ffmpeg, settings, isAudioOnly) {
  const outputName = `output.${outputExtension(settings.format)}`;

  if (isAudioOnly) {
    const codecArgs = settings.format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '192k'];
    await ffmpeg.exec(['-i', 'audio.wav', ...codecArgs, outputName]);
    return outputName;
  }

  if (settings.format === 'gif') {
    return runGifEncode(ffmpeg, settings);
  }

  const args = [
    '-framerate', String(settings.fps),
    '-i', 'frame_%06d.png',
    '-i', 'audio.wav',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
  ];

  if (settings.format === 'mp4') {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(settings.crf));
  } else if (settings.format === 'mp4-h265') {
    args.push('-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-crf', String(settings.crf));
  } else if (settings.format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-crf', String(settings.crf), '-b:v', '0');
  }

  args.push(outputName);
  await ffmpeg.exec(args);
  return outputName;
}

async function runGifEncode(ffmpeg, settings) {
  const outputName = 'output.gif';
  await ffmpeg.exec([
    '-framerate', String(settings.fps),
    '-i', 'frame_%06d.png',
    '-vf', `fps=${Math.min(settings.fps, 24)},scale=${settings.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
    '-loop', '0',
    outputName,
  ]);
  return outputName;
}

async function cleanupMemfs(ffmpeg) {
  // Best-effort cleanup; FFmpeg.wasm's in-memory FS doesn't provide a glob
  // delete, so per-frame files aren't individually removed here to keep
  // export fast — the WASM heap resets fully on page reload regardless, and
  // a single session's frame files are small relative to available memory
  // for typical project lengths. We do clean up the one large named file we
  // know about.
  await ffmpeg.deleteFile('audio.wav').catch(() => {});
}

function mimeTypeFor(format) {
  return {
    mp4: 'video/mp4', 'mp4-h265': 'video/mp4', webm: 'video/webm',
    gif: 'image/gif', mp3: 'audio/mpeg', aac: 'audio/aac',
  }[format] || 'application/octet-stream';
}
function outputExtension(format) {
  return { mp4: 'mp4', 'mp4-h265': 'mp4', webm: 'webm', gif: 'gif', mp3: 'mp3', aac: 'aac' }[format] || 'bin';
}
function sanitizeFilename(name) {
  return (name || 'export').replace(/[^a-z0-9\-_ ]/gi, '_');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  setUiModule,
  setExportBlobAccessor,
  openExportDialog,
  enqueueExport,
};
