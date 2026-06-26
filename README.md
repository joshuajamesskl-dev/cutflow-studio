# CutFlow Studio

A browser-based, zero-backend video editor. Vanilla ES Modules + Canvas2D + Web Audio + IndexedDB + FFmpeg.wasm.

## Running it

This is a static site — no build step. Two ways to run it:

1. **Any static file server** (required — `file://` won't work because ES Modules and Web Workers need a real origin):
   ```bash
   npx serve .
   # or
   python3 -m http.server 8080
   ```
   Then open `http://localhost:8080` (or whatever port).

2. Deploy the folder as-is to Netlify/Vercel/GitHub Pages/Cloudflare Pages — it's just static files.

No `npm install` needed. FFmpeg.wasm, Google Fonts, and Tailwind are all loaded from CDNs at runtime (see Network Requirements below).

## Network requirements

The app needs internet access for:
- **Tailwind CDN** (`cdn.tailwindcss.com`) — utility classes for layout chrome.
- **Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`) — text overlay fonts.
- **FFmpeg.wasm** (`unpkg.com/@ffmpeg/ffmpeg`, `unpkg.com/@ffmpeg/core`) — export encoding. **This is the one hard dependency**: export will not work offline. Everything else (import, edit, preview, color, effects, transitions, text, audio mixing) works fully offline once the page has loaded once.

If you're running this in a sandboxed/offline environment, vendor these three dependencies locally and update the URLs in `index.html` and `js/export.js`.

## Architecture

- **`js/app.js`** — boots everything. Owns `AppState` (the single project state object), `bus` (pub/sub event bus), `history` (undo/redo). Every other module receives these via a shared `ctx` object passed to its `init(ctx)`.
- **`js/player.js`** — the canvas compositor and playback clock. It's a **leaf module**: imports nothing else, and every feature module (`effects`, `audio`, `keyframes`, `transitions`, `text`, `mediaManager`) registers a hook *into* it (`setEffectsPipeline`, `registerTransitionHandler`, etc.) rather than player.js reaching out to them. This keeps the import graph acyclic — see the diagram below.
- **`js/timeline.js`** — owns all track/clip data and the timeline UI/interactions. Also acyclic (imports nothing).
- Every other module imports `player.js` one-directionally to register its hook, and `app.js` is the only module that imports all twelve.

```
app.js → ui, projectManager, mediaManager, timeline, player,
         effects, audio, keyframes, transitions, text, export, shortcuts
mediaManager, effects, audio, keyframes, transitions, text, export → player
shortcuts → timeline, player
(timeline, player, ui, projectManager import nothing — leaf modules)
```

This was verified with no cycles before packaging (see the import graph any time with `grep -oE "from '\./[^']+'" js/*.js`).

## Known gaps (intentionally not hidden)

These are real limitations, not bugs — documented here so whoever picks this up next doesn't have to rediscover them by testing:

- **Chroma key has no despill.** Edge pixels near the matte line will retain a faint tint of the key color. A real despill pass (suppressing the key channel in spill-affected pixels) is a follow-up.
- **Sharpen effect is listed in the UI but not wired to a pixel operation yet.** Adding it to a clip currently does nothing visually. Needs an unsharp-mask convolution pass in `effects.js`'s `applyPixelEffects`.
- **Per-pixel effects (chroma key, vignette, grain, chromatic aberration, LUT, lift/gamma/gain) run on the CPU via a JS loop**, not a GPU shader. Fine at quarter/half preview resolution; will visibly drop frames at full 4K with multiple such effects active simultaneously during scrubbing. A WebGL/WebGPU fragment-shader rewrite of that section is the real fix, not a tweak.
- **Noise reduction is basic spectral-floor subtraction**, not an ML denoiser (RNNoise-style). It reduces steady hiss/hum; it won't cleanly separate voice from non-stationary noise, and aggressive settings can introduce "musical noise" artifacts. This is disclosed in `audio.js`'s file header too.
- **Beat detection is energy-based onset detection**, not full tempo-aware beat tracking. No BPM estimate, no downbeat alignment. Works on clear percussive material; struggles on ambient/arrhythmic audio.
- **Per-keyframe easing isn't implemented** — all keyframe interpolation is linear. No ease-in/ease-out/hold per keyframe yet.
- **True "magnetic timeline" behavior is partial.** Ripple delete closes gaps when magnetic mode is on; dragging/trimming does not yet auto-ripple downstream clips. Overlap *correctness* (clips never visually overlapping) is always enforced regardless of magnetic mode — that's a separate guarantee from the "auto-close-gaps-on-any-edit" behavior real NLEs offer.
- **Same media asset used twice concurrently** (e.g. split-screen of one source) can flicker — the source-element pooling plumbing for per-clip-instance elements exists in `mediaManager.js` (`ensurePooledElement`'s `clipId` parameter) but `player.js` doesn't yet pass a clip id through to claim a dedicated pooled element. Single concurrent use (the overwhelming common case) is unaffected.
- **Export resolution scaling temporarily resizes the live preview canvas** during export (see `export.js`'s `exportVideoFrames`) and restores it afterward. This is invisible to the user because the export progress overlay covers the screen throughout, but it means triggering a second export concurrently with the first is not supported (there's only one canvas).
- **`workers/ffmpeg.worker.js` is a complete, working implementation that isn't wired into the main pipeline yet.** `export.js` currently runs FFmpeg.wasm on the main thread because the frame-capture step needs the live canvas anyway. The worker is ready to take over just the `ffmpeg.exec()` encode step as a future optimization — see comments in both files for the handoff protocol.
- **`workers/waveform.worker.js` is similarly complete but not wired in** — `audio.js` computes waveform peaks inline since `decodeAudioData` is already async. Swap-in point is documented in the worker's header.

## Browser support notes

- Web Audio's `MediaElementAudioSourceNode` permanently captures an element's audio output — this is why `mediaManager.js` mutes `<video>` elements by default (`audio.js` owns audible playback via its own Web Audio graph).
- `structuredClone` (used throughout for undo snapshots and clip duplication) needs a reasonably modern browser — all current evergreen browsers support it.
- FFmpeg.wasm v0.12+ requires `SharedArrayBuffer`, which requires the page to be served with proper COOP/COEP headers in some browsers for multi-threaded mode, or it falls back to single-threaded (slower but still works). Most static hosts (Netlify, Vercel) set reasonable defaults; if export hangs at "Loading FFmpeg…", check your host's cross-origin isolation headers.

## File structure

```
cutflow-studio/
├── index.html
├── styles/
│   ├── main.css
│   ├── timeline.css
│   ├── panels.css
│   └── modals.css
├── js/
│   ├── app.js
│   ├── projectManager.js
│   ├── mediaManager.js
│   ├── timeline.js
│   ├── player.js
│   ├── effects.js
│   ├── audio.js
│   ├── export.js
│   ├── keyframes.js
│   ├── transitions.js
│   ├── text.js
│   ├── shortcuts.js
│   ├── ui.js
│   └── workers/
│       ├── ffmpeg.worker.js
│       └── waveform.worker.js
└── assets/
    ├── icons/
    ├── fonts/
    └── luts/
```
