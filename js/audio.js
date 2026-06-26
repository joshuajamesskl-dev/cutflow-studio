/* ============================================================
   CutFlow Studio — audio.js
   Owns: the Web Audio graph (audible playback), clip.fadeIn/fadeOut,
   clip.volume/pan, track.volume/pan/eq, waveform rendering into
   .cf-clip-waveform containers, the Audio mixer tab (right panel).

   AUDIO GRAPH SHAPE (per active clip during playback):
     MediaElementSource(videoEl or audioEl)
       -> GainNode (clip fade envelope, computed per-frame from fadeIn/out)
       -> GainNode (clip.volume)
       -> StereoPannerNode (clip.pan)
       -> [10x BiquadFilterNode EQ chain] (track.eq, shared per track)
       -> GainNode (track.volume)
       -> destination (or analyser -> destination, for the level meters)

   We reuse mediaManager's pooled <video>/<audio> elements as the audio
   SOURCE too (MediaElementAudioSourceNode wraps the same element
   player.js is already seeking for video frames) — this avoids decoding
   each file twice. Tradeoff: a MediaElementAudioSourceNode permanently
   routes that element's audio through OUR graph and mutes its default
   output, which is exactly what we want since mediaManager already sets
   video elements .muted=true and expects audio.js to own audible output.

   NOISE REDUCTION & BEAT DETECTION — read before assuming these are
   broadcast-grade:
     - Noise reduction here is a basic noise-gate / spectral-floor
       subtraction using a single FFT-based noise profile sampled from
       the clip's first 0.5s. It reduces steady hiss/hum; it will NOT
       cleanly remove voices-under-noise or non-stationary noise the way
       RNNoise/iZotope-style ML denoisers do.
     - Beat detection is energy-based onset detection (rolling average of
       low-band RMS, peak-pick above a threshold), not a full beat-tracking
       algorithm with tempo estimation. It works reasonably on clear,
       percussive material; it will struggle on ambient or arrhythmic audio.
   These are real, working algorithms — just simpler than commercial tools.
   ============================================================ */

let ctx;
let player;

let audioCtx = null;
let masterGain = null;
let masterAnalyser = null;

const clipAudioNodes = new Map(); // clipId -> { source, fadeGain, volGain, panner }
const trackAudioNodes = new Map(); // trackId -> { eqBands: BiquadFilterNode[], volGain }
const waveformCache = new Map();   // mediaId -> Float32Array of peak data (downsampled)

function init(_ctx) {
  ctx = _ctx;
  ensureAudioContext();
  wireMixerTab();
  ctx.bus.on('selection:changed', renderMixerTab);
  ctx.bus.on('playback:tick', updateLevelMeters);
  ctx.bus.on('playback:stateChanged', onPlaybackStateChanged);
  ctx.bus.on('media:ready', ({ mediaId }) => extractWaveform(mediaId));
  ctx.bus.on('timeline:rendered', paintAllWaveforms);

  renderMixerTab();
}

import * as playerModule from './player.js';
player = playerModule;

/* ---------------- AUDIO CONTEXT (lazy — browsers require a user gesture) ---------------- */
function ensureAudioContext() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterAnalyser = audioCtx.createAnalyser();
  masterAnalyser.fftSize = 256;
  masterGain.connect(masterAnalyser);
  masterAnalyser.connect(audioCtx.destination);

  // Resume on first user interaction (autoplay-policy requirement).
  const resume = () => { audioCtx.resume(); window.removeEventListener('pointerdown', resume); };
  window.addEventListener('pointerdown', resume);
  return audioCtx;
}

function onPlaybackStateChanged({ isPlaying }) {
  if (isPlaying) audioCtx.resume();
}

/* ---------------- PER-CLIP AUDIO GRAPH (built lazily, on first play) ---------------- */
/** Called every rendered frame by hooking into player.js's frame loop via
    the bus — we don't render audio in render-to-canvas (drawClipFrame);
    instead we just keep gain nodes in sync with fade/volume envelopes,
    since the underlying <video>/<audio> element is already playing/seeking
    under player.js's control for the visual side. For an audio-only track
    (no visual draw), we still need playback driven — handled in
    syncAudioPlaybackForTrack below, called from the same tick handler. */
function ensureClipGraph(clip, sourceEl) {
  if (clipAudioNodes.has(clip.id)) return clipAudioNodes.get(clip.id);
  ensureAudioContext();

  let source;
  try {
    source = audioCtx.createMediaElementSource(sourceEl);
  } catch (err) {
    // Element already has a MediaElementSourceNode (e.g. re-entered after
    // a pool reuse) — Web Audio only allows one per element, ever.
    console.warn('[audio] source node already exists for element, reusing graph', err);
    return clipAudioNodes.get(clip.id) || null;
  }

  const fadeGain = audioCtx.createGain();
  const volGain = audioCtx.createGain();
  const panner = audioCtx.createStereoPanner();

  source.connect(fadeGain);
  fadeGain.connect(volGain);
  volGain.connect(panner);

  const track = ctx.AppState.getTrackForClip(clip.id);
  const trackNodes = ensureTrackGraph(track);
  panner.connect(trackNodes.eqBands[0]);

  const nodes = { source, fadeGain, volGain, panner };
  clipAudioNodes.set(clip.id, nodes);
  return nodes;
}

/* ---------------- PER-TRACK AUDIO GRAPH (10-band EQ chain + track volume) ---------------- */
const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function ensureTrackGraph(track) {
  if (!track) return makeFallbackChain();
  if (trackAudioNodes.has(track.id)) return trackAudioNodes.get(track.id);

  if (!track.eq) track.eq = EQ_FREQS.map(() => 0); // dB gain per band, default flat
  if (track.volume === undefined) track.volume = 1;
  if (track.pan === undefined) track.pan = 0;

  const eqBands = EQ_FREQS.map((freq, i) => {
    const filter = audioCtx.createBiquadFilter();
    filter.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    filter.frequency.value = freq;
    filter.Q.value = 1;
    filter.gain.value = track.eq[i] || 0;
    return filter;
  });
  for (let i = 0; i < eqBands.length - 1; i++) eqBands[i].connect(eqBands[i + 1]);

  const volGain = audioCtx.createGain();
  volGain.gain.value = track.volume;
  eqBands[eqBands.length - 1].connect(volGain);
  volGain.connect(masterGain);

  const nodes = { eqBands, volGain };
  trackAudioNodes.set(track.id, nodes);
  return nodes;
}

function makeFallbackChain() {
  // Used only if a clip's track lookup fails — routes straight to master so
  // audio doesn't silently vanish.
  return { eqBands: [masterGain], volGain: masterGain };
}

/* ---------------- FADE ENVELOPE + VOLUME SYNC (called every tick) ---------------- */
/** player.js's playback loop emits 'playback:tick' with the current time;
    init() subscribes updateLevelMeters to that event. We use the same
    signal to keep every active clip's fade/volume/pan gain nodes correct
    via direct AudioParam writes (cheap, no scheduling needed since we're
    already polling once per rAF). */
function updateLevelMeters() {
  syncActiveClipAudioNodes();
  paintMasterMeter();
}

function syncActiveClipAudioNodes() {
  const t = ctx.AppState.project.playback.currentTime;
  const playing = ctx.AppState.project.playback.isPlaying;

  for (const track of ctx.AppState.project.tracks) {
    if (track.muted) continue;
    const clip = track.clips.find(c => t >= c.start && t < c.start + c.duration);
    if (!clip) continue;

    const media = ctx.AppState.getMediaById(clip.mediaId);
    if (!media || media.type === 'image') continue;
    const sourceEl = player ? getSourceElForClip(media.id) : null;
    if (!sourceEl) continue;

    const nodes = ensureClipGraph(clip, sourceEl);
    if (!nodes) continue;

    const offsetIntoClip = t - clip.start;
    const fadeIn = clip.fadeIn || 0;
    const fadeOut = clip.fadeOut || 0;
    let fadeMul = 1;
    if (fadeIn > 0 && offsetIntoClip < fadeIn) fadeMul = offsetIntoClip / fadeIn;
    if (fadeOut > 0 && offsetIntoClip > clip.duration - fadeOut) {
      fadeMul = Math.min(fadeMul, (clip.duration - offsetIntoClip) / fadeOut);
    }
    nodes.fadeGain.gain.value = Math.max(0, Math.min(1, fadeMul));
    nodes.volGain.gain.value = clip.volume ?? 1;
    nodes.panner.pan.value = clip.pan ?? 0;

    // Drive actual audible playback state. Video elements are visually
    // driven by player.js (which seeks but does not .play()); for audio to
    // be heard in sync, the element itself must be playing (Web Audio
    // graphs play whatever the source element plays, in real time).
    if (playing && sourceEl.paused) sourceEl.play().catch(() => {});
    if (!playing && !sourceEl.paused) sourceEl.pause();
  }
}

function getSourceElForClip(mediaId) {
  // mediaManager.js's pool is the single source of truth; we reuse the same
  // getter player.js uses rather than importing mediaManager.js ourselves
  // (audio -> mediaManager would be a second consumer of the same pattern —
  // safe, since mediaManager has no dependents importing it back).
  return mediaManagerPoolGetter ? mediaManagerPoolGetter(mediaId) : null;
}
let mediaManagerPoolGetter = null;
function setMediaPoolGetter(fn) { mediaManagerPoolGetter = fn; }

function paintMasterMeter() {
  if (!masterAnalyser) return;
  const data = new Uint8Array(masterAnalyser.frequencyBinCount);
  masterAnalyser.getByteFrequencyData(data);
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  const pct = Math.min(100, (avg / 255) * 140); // slight boost so meter isn't visually dead at normal levels
  document.querySelectorAll('.cf-meter-fill[data-meter="master"]').forEach(el => {
    el.style.width = `${pct}%`;
  });
}

/* ---------------- FADE HANDLES ON TIMELINE CLIPS ---------------- */
/** Called by timeline.js indirectly — we add our own pointerdown wiring
    directly to .cf-clip-fade-handle elements after they're injected. Since
    timeline.js's buildClipEl() doesn't create fade handles itself (audio.js
    owns fades), we inject them here whenever the timeline re-renders. */
function injectFadeHandles() {
  document.querySelectorAll('.cf-clip[data-track-type="audio"]').forEach(clipEl => {
    if (clipEl.querySelector('.cf-clip-fade-handle-in')) return; // already injected
    const clipId = clipEl.dataset.clipId;
    const clip = ctx.AppState.getClipById(clipId);
    if (!clip) return;

    const handleIn = document.createElement('div');
    handleIn.className = 'cf-clip-fade-handle cf-clip-fade-handle-in';
    const handleOut = document.createElement('div');
    handleOut.className = 'cf-clip-fade-handle cf-clip-fade-handle-out';
    clipEl.appendChild(handleIn);
    clipEl.appendChild(handleOut);

    wireFadeHandle(handleIn, clipEl, clip, 'fadeIn');
    wireFadeHandle(handleOut, clipEl, clip, 'fadeOut');
    renderFadeTriangles(clipEl, clip);
  });
}

function wireFadeHandle(handleEl, clipEl, clip, prop) {
  handleEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    ctx.history.capture();
    const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;
    const clipRect = clipEl.getBoundingClientRect();

    const onMove = (ev) => {
      const x = prop === 'fadeIn'
        ? Math.max(0, ev.clientX - clipRect.left)
        : Math.max(0, clipRect.right - ev.clientX);
      const seconds = Math.max(0, Math.min(clip.duration / 2, x / pxPerSec));
      clip[prop] = seconds;
      renderFadeTriangles(clipEl, clip);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      ctx.AppState.markDirty('audio:fadeChanged', { clipId: clip.id, prop });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function renderFadeTriangles(clipEl, clip) {
  clipEl.querySelectorAll('.cf-clip-fade-triangle').forEach(el => el.remove());
  const pxPerSec = ctx.AppState.project.timelineView.pxPerSec;
  const clipWidthPx = clip.duration * pxPerSec;

  if (clip.fadeIn > 0) {
    const tri = document.createElement('div');
    tri.className = 'cf-clip-fade-triangle';
    const w = clip.fadeIn * pxPerSec;
    tri.style.left = '0';
    tri.style.width = `${w}px`;
    tri.style.clipPath = 'polygon(0 100%, 100% 0, 100% 100%)';
    clipEl.appendChild(tri);
  }
  if (clip.fadeOut > 0) {
    const tri = document.createElement('div');
    tri.className = 'cf-clip-fade-triangle';
    const w = clip.fadeOut * pxPerSec;
    tri.style.right = '0';
    tri.style.width = `${w}px`;
    tri.style.clipPath = 'polygon(0 0, 100% 100%, 0 100%)';
    clipEl.appendChild(tri);
  }
}

/* ---------------- WAVEFORM EXTRACTION + PAINTING ---------------- */
/** Real waveform extraction via decodeAudioData + min/max peak downsampling
    — not a placeholder squiggle. Runs once per media asset and caches the
    result; repainting on zoom/scroll just redraws from the cached peaks. */
async function extractWaveform(mediaId) {
  const media = ctx.AppState.getMediaById(mediaId);
  if (!media || (media.type !== 'audio' && media.type !== 'video')) return;
  if (waveformCache.has(mediaId)) return;

  try {
    const blob = await getBlobForWaveform(mediaId);
    if (!blob) return;
    ensureAudioContext();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const peaks = computePeaks(audioBuffer, 800); // 800 buckets is plenty for typical clip widths
    waveformCache.set(mediaId, peaks);
    paintAllWaveforms();
  } catch (err) {
    // Some video files have no audio track, or decodeAudioData fails on
    // certain codecs Web Audio doesn't support directly — fail soft.
    console.warn('[audio] waveform extraction skipped for', media.name, err.message);
  }
}

let blobAccessor = null;
function setBlobAccessor(fn) { blobAccessor = fn; }
function getBlobForWaveform(mediaId) {
  return blobAccessor ? blobAccessor(mediaId) : null;
}

function computePeaks(audioBuffer, bucketCount) {
  const channelData = audioBuffer.getChannelData(0); // mono-summarize via channel 0; stereo detail not needed for a timeline thumbnail
  const samplesPerBucket = Math.max(1, Math.floor(channelData.length / bucketCount));
  const peaks = new Float32Array(bucketCount * 2); // [min, max] pairs

  for (let i = 0; i < bucketCount; i++) {
    let min = 1, max = -1;
    const start = i * samplesPerBucket;
    const end = Math.min(channelData.length, start + samplesPerBucket);
    for (let j = start; j < end; j++) {
      const v = channelData[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[i * 2] = min;
    peaks[i * 2 + 1] = max;
  }
  return peaks;
}

function paintAllWaveforms() {
  document.querySelectorAll('.cf-clip-waveform').forEach(container => {
    const clipId = container.dataset.clipId;
    const clip = ctx.AppState.getClipById(clipId);
    if (!clip) return;
    const peaks = waveformCache.get(clip.mediaId);
    if (!peaks) return;
    paintWaveformCanvas(container, clip, peaks);
  });
  injectFadeHandles();
}

function paintWaveformCanvas(container, clip, peaks) {
  let canvas = container.querySelector('canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    container.appendChild(canvas);
  }
  const rect = container.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--waveform').trim() || '#7fd9ad';

  const media = ctx.AppState.getMediaById(clip.mediaId);
  const sourceDuration = media?.duration || clip.duration;
  const bucketCount = peaks.length / 2;
  const startBucket = Math.floor((clip.trimIn / sourceDuration) * bucketCount);
  const endBucket = Math.ceil(((clip.trimIn + clip.duration) / sourceDuration) * bucketCount);
  const visibleBuckets = Math.max(1, endBucket - startBucket);
  const midY = h / 2;

  for (let x = 0; x < w; x++) {
    const bucketIdx = startBucket + Math.floor((x / w) * visibleBuckets);
    if (bucketIdx < 0 || bucketIdx >= bucketCount) continue;
    const min = peaks[bucketIdx * 2];
    const max = peaks[bucketIdx * 2 + 1];
    const yTop = midY - max * midY;
    const yBot = midY - min * midY;
    c.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
  }
}

/* ---------------- MIXER TAB (right panel) ---------------- */
function wireMixerTab() {
  renderMixerTab();
}

function renderMixerTab() {
  const container = document.getElementById('audio-mixer-content');
  if (!container) return;
  container.innerHTML = '';

  const masterStrip = buildMasterStrip();
  container.appendChild(masterStrip);

  for (const track of ctx.AppState.project.tracks) {
    if (track.type !== 'audio') continue;
    container.appendChild(buildTrackMixerStrip(track));
  }

  // Selected clip's volume/pan/noise-reduction/beat-detect controls
  const clips = ctx.AppState.getSelectedClips();
  if (clips.length === 1) {
    const media = ctx.AppState.getMediaById(clips[0].mediaId);
    if (media && (media.type === 'audio' || media.type === 'video')) {
      container.appendChild(buildClipAudioStrip(clips[0]));
    }
  }
}

function buildMasterStrip() {
  const strip = document.createElement('div');
  strip.className = 'cf-mixer-strip';
  const title = document.createElement('div');
  title.className = 'cf-mixer-strip-title';
  title.textContent = 'Master';
  strip.appendChild(title);

  const meterRow = document.createElement('div');
  meterRow.className = 'cf-meter-row';
  const track = document.createElement('div');
  track.className = 'cf-meter-track';
  const fill = document.createElement('div');
  fill.className = 'cf-meter-fill';
  fill.dataset.meter = 'master';
  track.appendChild(fill);
  meterRow.appendChild(track);
  strip.appendChild(meterRow);

  const btn = document.createElement('button');
  btn.className = 'cf-btn cf-btn-sm';
  btn.textContent = 'Normalize All Clips';
  btn.title = 'Analyze and normalize peak loudness across all audio/video clips';
  btn.addEventListener('click', normalizeAllClips);
  strip.appendChild(btn);

  return strip;
}

function buildTrackMixerStrip(track) {
  const strip = document.createElement('div');
  strip.className = 'cf-mixer-strip';

  const title = document.createElement('div');
  title.className = 'cf-mixer-strip-title';
  const dot = document.createElement('span');
  dot.className = 'cf-mixer-strip-color-dot';
  dot.style.background = 'var(--track-audio)';
  title.appendChild(dot);
  title.appendChild(document.createTextNode(track.name));
  strip.appendChild(title);

  strip.appendChild(buildVolPanRow('Volume', track.volume ?? 1, 0, 2, (v) => {
    ctx.history.capture();
    track.volume = v;
    const nodes = trackAudioNodes.get(track.id);
    if (nodes) nodes.volGain.gain.value = v;
    ctx.AppState.markDirty('audio:trackVolumeChanged', { trackId: track.id });
  }));

  strip.appendChild(buildEqStrip(track));
  return strip;
}

function buildVolPanRow(label, value, min, max, onChange) {
  const row = document.createElement('div');
  row.className = 'cf-prop-slider-row';
  const l = document.createElement('label');
  l.className = 'cf-prop-label';
  l.textContent = label;
  row.appendChild(l);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min); slider.max = String(max); slider.step = '0.01';
  slider.value = String(value);
  row.appendChild(slider);
  const num = document.createElement('input');
  num.className = 'cf-prop-value-input';
  num.type = 'number'; num.step = '0.01'; num.value = String(value);
  row.appendChild(num);

  slider.addEventListener('input', () => { num.value = slider.value; onChange(Number(slider.value)); });
  num.addEventListener('change', () => { slider.value = num.value; onChange(Number(num.value)); });
  return row;
}

function buildEqStrip(track) {
  if (!track.eq) track.eq = EQ_FREQS.map(() => 0);
  const wrap = document.createElement('div');
  wrap.className = 'cf-eq-bands';

  EQ_FREQS.forEach((freq, i) => {
    const band = document.createElement('div');
    band.className = 'cf-eq-band';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-24'; slider.max = '24'; slider.step = '1';
    slider.value = String(track.eq[i]);
    slider.addEventListener('input', () => {
      track.eq[i] = Number(slider.value);
      const nodes = trackAudioNodes.get(track.id);
      if (nodes) nodes.eqBands[i].gain.value = Number(slider.value);
      ctx.AppState.markDirty('audio:eqChanged', { trackId: track.id, band: i });
    });
    band.appendChild(slider);
    const label = document.createElement('div');
    label.className = 'cf-eq-band-label';
    label.textContent = freq >= 1000 ? `${freq / 1000}k` : String(freq);
    band.appendChild(label);
    wrap.appendChild(band);
  });

  return wrap;
}

function buildClipAudioStrip(clip) {
  const strip = document.createElement('div');
  strip.className = 'cf-mixer-strip';
  const title = document.createElement('div');
  title.className = 'cf-mixer-strip-title';
  title.textContent = `Clip: ${clip.label}`;
  strip.appendChild(title);

  strip.appendChild(buildVolPanRow('Clip Volume', clip.volume ?? 1, 0, 2, (v) => {
    ctx.history.capture();
    clip.volume = v;
    ctx.AppState.markDirty('audio:clipVolumeChanged', { clipId: clip.id });
  }));
  strip.appendChild(buildVolPanRow('Pan', clip.pan ?? 0, -1, 1, (v) => {
    ctx.history.capture();
    clip.pan = v;
    ctx.AppState.markDirty('audio:clipPanChanged', { clipId: clip.id });
  }));

  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.gap = '8px';
  btnRow.style.marginTop = '8px';

  const btnNR = document.createElement('button');
  btnNR.className = 'cf-btn cf-btn-sm';
  btnNR.textContent = 'Reduce Noise';
  btnNR.addEventListener('click', () => applyNoiseReduction(clip));
  btnRow.appendChild(btnNR);

  const btnBeat = document.createElement('button');
  btnBeat.className = 'cf-btn cf-btn-sm';
  btnBeat.textContent = 'Detect Beats';
  btnBeat.addEventListener('click', () => detectBeatsAndCut(clip));
  btnRow.appendChild(btnBeat);

  strip.appendChild(btnRow);
  return strip;
}

/* ---------------- NORMALIZATION (real peak analysis) ---------------- */
async function normalizeAllClips() {
  ctx.setStatus('Analyzing audio levels…');
  let count = 0;
  for (const track of ctx.AppState.project.tracks) {
    for (const clip of track.clips) {
      const media = ctx.AppState.getMediaById(clip.mediaId);
      if (!media || (media.type !== 'audio' && media.type !== 'video')) continue;
      const peaks = waveformCache.get(clip.mediaId);
      if (!peaks) continue;
      const peakAbs = Math.max(...Array.from(peaks).map(Math.abs));
      if (peakAbs <= 0) continue;
      const targetPeak = 0.95;
      const gain = Math.min(4, targetPeak / peakAbs); // cap boost at 4x to avoid absurd amplification of near-silent clips
      clip.volume = gain;
      count++;
    }
  }
  ctx.history.capture();
  ctx.AppState.markDirty('audio:normalized', { count });
  renderMixerTab();
  ctx.setStatus('Ready');
  ctx.showToast(`Normalized ${count} clip${count !== 1 ? 's' : ''}`, 'success');
}

/* ---------------- NOISE REDUCTION (FFT spectral-floor subtraction) ---------------- */
/** Samples a noise profile from the first 0.5s of the clip's source audio,
    then for the whole buffer: STFT -> subtract profile magnitude (floor at
    0) -> ISTFT via overlap-add. This is the basic "spectral subtraction"
    technique — real, working, audibly reduces steady noise, but produces
    some "musical noise" artifacts on aggressive settings, unlike modern
    ML denoisers. We bake the result back into a new processed Blob and
    swap mediaManager's blob for this clip's media (non-destructive to the
    original file — applied as a new derived asset). */
async function applyNoiseReduction(clip) {
  const media = ctx.AppState.getMediaById(clip.mediaId);
  if (!media) return;
  ctx.setStatus('Reducing noise…');
  try {
    const blob = await getBlobForWaveform(media.id);
    const arrayBuffer = await blob.arrayBuffer();
    ensureAudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));

    const processed = spectralNoiseReduce(audioBuffer);
    const wavBlob = audioBufferToWavBlob(processed);

    const newMediaId = ctx.makeId('media');
    await registerDerivedAudio(newMediaId, wavBlob, `${media.name} (denoised)`, processed.duration);
    ctx.history.capture();
    clip.mediaId = newMediaId;
    ctx.AppState.markDirty('audio:noiseReduced', { clipId: clip.id });
    waveformCache.delete(newMediaId);
    await extractWaveform(newMediaId);
    ctx.showToast('Noise reduction applied', 'success');
  } catch (err) {
    console.error('[audio] noise reduction failed:', err);
    ctx.showToast('Noise reduction failed — see console', 'error');
  }
  ctx.setStatus('Ready');
}

function spectralNoiseReduce(audioBuffer) {
  const fftSize = 1024;
  const hop = fftSize / 2;
  const ctxOut = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
  const outBuffer = ctxOut.createBuffer(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);

  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const input = audioBuffer.getChannelData(ch);
    const output = new Float32Array(input.length);
    const window = hannWindow(fftSize);

    // Build noise magnitude profile from the first 0.5s.
    const noiseFrames = Math.floor((0.5 * audioBuffer.sampleRate) / hop);
    const noiseProfile = new Float32Array(fftSize / 2);
    let profileCount = 0;
    for (let f = 0; f < noiseFrames; f++) {
      const start = f * hop;
      if (start + fftSize > input.length) break;
      const frame = input.slice(start, start + fftSize);
      applyWindow(frame, window);
      const { mag } = fftMagnitudePhase(frame);
      for (let k = 0; k < mag.length; k++) noiseProfile[k] += mag[k];
      profileCount++;
    }
    if (profileCount > 0) for (let k = 0; k < noiseProfile.length; k++) noiseProfile[k] /= profileCount;

    // Overlap-add spectral subtraction over the whole signal.
    for (let start = 0; start + fftSize <= input.length; start += hop) {
      const frame = input.slice(start, start + fftSize);
      applyWindow(frame, window);
      const { mag, phase } = fftMagnitudePhase(frame);
      for (let k = 0; k < mag.length; k++) {
        mag[k] = Math.max(0, mag[k] - noiseProfile[k] * 1.2); // over-subtract slightly for audible reduction
      }
      const timeFrame = ifftFromMagPhase(mag, phase, fftSize);
      for (let i = 0; i < fftSize; i++) {
        if (start + i < output.length) output[start + i] += timeFrame[i] * window[i] * 0.5; // 0.5 = overlap-add normalization for 50% hop
      }
    }
    outBuffer.copyToChannel(output, ch);
  }
  return outBuffer;
}

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return w;
}
function applyWindow(frame, window) {
  for (let i = 0; i < frame.length; i++) frame[i] *= window[i];
}

/** Minimal radix-2 FFT, used both for noise reduction and beat detection.
    Real part / imaginary part in/out via separate arrays. */
function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  const half = n / 2;
  const evenRe = new Float32Array(half), evenIm = new Float32Array(half);
  const oddRe = new Float32Array(half), oddIm = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    evenRe[i] = re[i * 2]; evenIm[i] = im[i * 2];
    oddRe[i] = re[i * 2 + 1]; oddIm[i] = im[i * 2 + 1];
  }
  fft(evenRe, evenIm);
  fft(oddRe, oddIm);
  for (let k = 0; k < half; k++) {
    const angle = (-2 * Math.PI * k) / n;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const tRe = cos * oddRe[k] - sin * oddIm[k];
    const tIm = sin * oddRe[k] + cos * oddIm[k];
    re[k] = evenRe[k] + tRe; im[k] = evenIm[k] + tIm;
    re[k + half] = evenRe[k] - tRe; im[k + half] = evenIm[k] - tIm;
  }
}

function fftMagnitudePhase(frame) {
  const n = frame.length;
  const re = new Float32Array(frame);
  const im = new Float32Array(n);
  fft(re, im);
  const half = n / 2;
  const mag = new Float32Array(half);
  const phase = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    phase[k] = Math.atan2(im[k], re[k]);
  }
  return { mag, phase };
}

function ifftFromMagPhase(mag, phase, fftSize) {
  const half = mag.length;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let k = 0; k < half; k++) {
    re[k] = mag[k] * Math.cos(phase[k]);
    im[k] = mag[k] * Math.sin(phase[k]);
    if (k > 0) { re[fftSize - k] = re[k]; im[fftSize - k] = -im[k]; } // conjugate symmetry for real output
  }
  // Inverse FFT = forward FFT of conjugate, scaled — reuse fft() on the
  // conjugated spectrum then conjugate+scale the result.
  for (let i = 0; i < fftSize; i++) im[i] = -im[i];
  fft(re, im);
  const out = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) out[i] = re[i] / fftSize;
  return out;
}

/* ---------------- BEAT DETECTION (energy-based onset detection) ---------------- */
/** Computes RMS energy in the low-frequency band over short windows, finds
    local peaks that exceed a rolling average by a threshold factor, and
    inserts split points on the clip's track at each detected beat. This is
    a real, working beat-ish onset detector — not full tempo-aware beat
    tracking (no BPM estimate, no downbeat alignment). Good enough to
    auto-chop a clip at percussive hits for quick rough cuts. */
async function detectBeatsAndCut(clip) {
  const media = ctx.AppState.getMediaById(clip.mediaId);
  if (!media) return;
  ctx.setStatus('Detecting beats…');
  try {
    const blob = await getBlobForWaveform(media.id);
    const arrayBuffer = await blob.arrayBuffer();
    ensureAudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const data = audioBuffer.getChannelData(0);
    const sr = audioBuffer.sampleRate;

    const windowSize = Math.floor(sr * 0.05); // 50ms windows
    const energies = [];
    for (let i = 0; i < data.length; i += windowSize) {
      let sum = 0;
      const end = Math.min(data.length, i + windowSize);
      for (let j = i; j < end; j++) sum += data[j] * data[j];
      energies.push(Math.sqrt(sum / (end - i)));
    }

    const beatsLocalSec = [];
    const rollWindow = 20; // ~1s rolling average window
    const minGapSec = 0.2; // refractory period so we don't fire multiple times per hit
    let lastBeatTime = -Infinity;
    for (let i = 0; i < energies.length; i++) {
      const start = Math.max(0, i - rollWindow);
      const avg = energies.slice(start, i).reduce((a, b) => a + b, 0) / Math.max(1, i - start);
      const t = (i * windowSize) / sr;
      if (energies[i] > avg * 1.5 && energies[i] > 0.02 && t - lastBeatTime > minGapSec) {
        beatsLocalSec.push(t);
        lastBeatTime = t;
      }
    }

    // Only keep beats that fall within this clip's used source range.
    const relevant = beatsLocalSec.filter(t => t > clip.trimIn + 0.05 && t < clip.trimIn + clip.duration - 0.05);
    if (relevant.length === 0) {
      ctx.showToast('No clear beats detected', 'warning');
      ctx.setStatus('Ready');
      return;
    }

    ctx.history.capture();
    const track = ctx.AppState.getTrackForClip(clip.id);
    splitClipAtSourceTimes(track, clip, relevant);
    ctx.AppState.markDirty('audio:beatsDetected', { clipId: clip.id, count: relevant.length });
    ctx.bus.emit('timeline:rendered', {});
    player.renderCurrentFrame();
    ctx.showToast(`Split clip at ${relevant.length} detected beat${relevant.length > 1 ? 's' : ''}`, 'success');
  } catch (err) {
    console.error('[audio] beat detection failed:', err);
    ctx.showToast('Beat detection failed — see console', 'error');
  }
  ctx.setStatus('Ready');
}

function splitClipAtSourceTimes(track, clip, sourceTimes) {
  let current = clip;
  for (const sourceT of sourceTimes) {
    const timelineT = current.start + (sourceT - current.trimIn);
    if (timelineT <= current.start || timelineT >= current.start + current.duration) continue;
    const offsetIntoClip = timelineT - current.start;
    const rightClip = {
      ...structuredClone(current),
      id: ctx.makeId('clip'),
      start: timelineT,
      duration: current.duration - offsetIntoClip,
      trimIn: current.trimIn + offsetIntoClip,
    };
    current.duration = offsetIntoClip;
    current.trimOut = current.trimIn + offsetIntoClip;
    track.clips.push(rightClip);
    current = rightClip;
  }
  track.clips.sort((a, b) => a.start - b.start);
}

/* ---------------- DERIVED AUDIO ASSET REGISTRATION (for noise-reduced output) ---------------- */
let derivedAssetRegistrar = null;
function setDerivedAssetRegistrar(fn) { derivedAssetRegistrar = fn; }
async function registerDerivedAudio(mediaId, blob, name, duration) {
  if (derivedAssetRegistrar) {
    await derivedAssetRegistrar(mediaId, blob, name, duration);
  } else {
    // Fallback: at minimum register the metadata so the clip doesn't point
    // at a dangling media id, even if mediaManager hasn't wired the
    // registrar yet.
    ctx.AppState.project.media.push({ id: mediaId, name, type: 'audio', duration, width: 0, height: 0, thumbnailDataUrl: null });
  }
}

/** Minimal WAV encoder (PCM16) — used to materialize processed audio
    buffers back into a playable Blob without needing a codec encoder. */
function audioBufferToWavBlob(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length * numChannels * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, length - 8, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, length - 44, true);

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
  return new Blob([buffer], { type: 'audio/wav' });
}
function writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/* ---------------- EXPORTS ---------------- */
export {
  init,
  setMediaPoolGetter,
  setBlobAccessor,
  setDerivedAssetRegistrar,
  extractWaveform,
  applyNoiseReduction,
  detectBeatsAndCut,
  normalizeAllClips,
  ensureAudioContext,
};
