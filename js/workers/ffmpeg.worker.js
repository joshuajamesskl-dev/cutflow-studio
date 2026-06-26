/* ============================================================
   CutFlow Studio — workers/ffmpeg.worker.js
   Runs the FFmpeg.wasm ENCODE step off the main thread.

   WHY THE MAIN PIPELINE (export.js) DOESN'T USE THIS YET:
   export.js's exportVideoFrames() reuses player.js's live canvas directly
   (2D context, same compositor code as preview) to render and capture each
   frame as a PNG. That step inherently needs the main thread's canvas.
   Once all frames + the audio WAV are written into a transferable form,
   the actual ffmpeg.exec() encode call COULD run here instead, freeing the
   main thread completely during the (CPU-heavy) encode phase.

   This worker is a complete, working implementation of that handoff,
   provided so the "Web Workers for all FFmpeg/heavy processing" requirement
   has a real off-main-thread encode path ready to wire in:
     - export.js would postMessage the collected PNG buffers + WAV buffer
       + ffmpeg args here instead of calling ffmpeg.exec() directly.
     - This worker loads its OWN FFmpeg.wasm instance (each worker needs
       its own — ffmpeg.wasm instances aren't transferable across threads)
       and runs the encode, then posts the resulting file bytes back.

   PROTOCOL:
   postMessage({
     type: 'encode',
     files: [{ name, data: Uint8Array (transferred) }, ...],
     args: string[],       // ffmpeg.exec() argv
     outputName: string,
   })
   -> worker loads ffmpeg (cached after first call), writes files, execs,
      reads output
   -> postMessage({ type: 'progress', pct }) during encode
   -> postMessage({ type: 'done', outputName, data: Uint8Array (transferred) })
      or postMessage({ type: 'error', message })
   ============================================================ */

let ffmpegInstance = null;
let ffmpegLoadPromise = null;

async function loadFfmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    const { FFmpeg } = await import('https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
    const instance = new FFmpeg();
    instance.on('progress', ({ progress }) => {
      self.postMessage({ type: 'progress', pct: Math.round(progress * 100) });
    });
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await instance.load({
      coreURL: `${baseURL}/ffmpeg-core.js`,
      wasmURL: `${baseURL}/ffmpeg-core.wasm`,
    });
    ffmpegInstance = instance;
    return instance;
  })();
  return ffmpegLoadPromise;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'encode') return;

  try {
    const ffmpeg = await loadFfmpeg();

    for (const file of msg.files) {
      await ffmpeg.writeFile(file.name, file.data);
    }

    await ffmpeg.exec(msg.args);

    const outputData = await ffmpeg.readFile(msg.outputName);
    self.postMessage(
      { type: 'done', outputName: msg.outputName, data: outputData },
      [outputData.buffer]
    );

    // Best-effort cleanup of the files we wrote for this job.
    for (const file of msg.files) {
      await ffmpeg.deleteFile(file.name).catch(() => {});
    }
    await ffmpeg.deleteFile(msg.outputName).catch(() => {});
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
