// Shared AnalyserNode fake-data fill logic, spliced into both content.js
// (real AnalyserNode.prototype patch) and audio-hardblock.js (FakeAnalyserNode
// class on hard-blocked sites) by build-extension.js. Each caller passes its
// own noise seed, so the two scripts still produce independent noise from
// each other, same as before this was shared.
function __fpAnalyserNoise(seed, i) {
  return Math.sin(seed * 9999 + i) * 0.5 * 0.0003;
}
function __fpFillFreqData(array, freqSrc, seed) {
  for (let i = 0; i < array.length; i++) {
    array[i] = (freqSrc[i % freqSrc.length] || -100) + __fpAnalyserNoise(seed, i) * 1000;
  }
}
function __fpFillByteFreqData(array, freqSrc, seed, minDb, maxDb) {
  for (let i = 0; i < array.length; i++) {
    const db = (freqSrc[i % freqSrc.length] || -100) + __fpAnalyserNoise(seed, i) * 1000;
    const scaled = ((db - minDb) / (maxDb - minDb)) * 255;
    array[i] = Math.max(0, Math.min(255, Math.round(scaled)));
  }
}
function __fpFillTimeData(array, timeSrc, seed) {
  for (let i = 0; i < array.length; i++) {
    array[i] = (timeSrc[i % timeSrc.length] || 0) + __fpAnalyserNoise(seed, i);
  }
}
function __fpFillByteTimeData(array, timeSrc, seed) {
  for (let i = 0; i < array.length; i++) {
    const v = (timeSrc[i % timeSrc.length] || 0) + __fpAnalyserNoise(seed, i);
    array[i] = Math.max(0, Math.min(255, Math.round(128 + 128 * v)));
  }
}
