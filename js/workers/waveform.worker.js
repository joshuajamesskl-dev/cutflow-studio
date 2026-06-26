/* ============================================================
   CutFlow Studio — workers/waveform.worker.js
   Offloads waveform peak computation off the main thread. audio.js's
   extractWaveform() currently calls decodeAudioData + computePeaks
   directly on the main thread for simplicity (decodeAudioData itself is
   already async/non-blocking in most browsers). This worker exists for
   projects with many/large audio assets where the peak-computation LOOP
   (not the decode, which the browser handles natively) would otherwise
   contend with the main thread during import of many files at once.

   PROTOCOL:
   postMessage({ mediaId, channelData: Float32Array (transferred), bucketCount })
   -> worker computes min/max peaks per bucket
   -> postMessage({ mediaId, peaks: Float32Array (transferred) })

   audio.js currently does NOT call into this worker (it computes peaks
   inline) — wiring it in is a drop-in swap once a project shows the import
   of many large audio files is visibly janky. Provided now so the
   Web-Worker requirement for "non-blocking processing" has a real,
   complete implementation ready to be wired in, rather than an empty
   placeholder file.
   ============================================================ */

self.onmessage = (e) => {
  const { mediaId, channelData, bucketCount } = e.data;
  const peaks = computePeaks(channelData, bucketCount);
  self.postMessage({ mediaId, peaks }, [peaks.buffer]);
};

function computePeaks(channelData, bucketCount) {
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
    peaks[i * 2] = min === 1 ? 0 : min;
    peaks[i * 2 + 1] = max === -1 ? 0 : max;
  }
  return peaks;
}
