#!/usr/bin/env node
// Takes a captured fingerprint.json and rewrites its obscurable fields with
// randomized-but-realistic alternate values, plus a fresh synthetic
// canvasDataURL. Unlike a one-off manual edit, this is repeatable: re-run it
// any time you want to rotate to a new fake identity, and pass --seed for a
// reproducible run.
//
// Usage: node src/obscure-fingerprint.js <fingerprint.json> [output.json] [--seed=N]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const seedArg = args.find((a) => a.startsWith('--seed='));
const positional = args.filter((a) => !a.startsWith('--'));
const [inputArg, outputArg] = positional;

if (!inputArg) {
  console.error('Usage: node src/obscure-fingerprint.js <fingerprint.json> [output.json] [--seed=N]');
  process.exit(1);
}

const inputPath = path.resolve(inputArg);
const outputPath = path.resolve(outputArg || inputArg);

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

// Simple seeded PRNG (mulberry32) so --seed gives a reproducible run;
// without it, each run picks a genuinely new fake identity.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(seedArg ? parseInt(seedArg.split('=')[1], 10) : Date.now() % 2 ** 31);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const pickDifferent = (arr, current) => {
  const choices = arr.filter((v) => JSON.stringify(v) !== JSON.stringify(current));
  return choices.length ? pick(choices) : pick(arr);
};

// Pool formats and realism constraints are documented in obscure-pools.md;
// the fixed WebGL-extension rationale also lives in TECHNICAL.md.
const pools = JSON.parse(fs.readFileSync(path.join(__dirname, 'obscure-pools.json'), 'utf8'));
const {
  gpuPool: GPU_POOL,
  maxTextureSizePool: MAX_TEXTURE_SIZE_POOL,
  defaultExtensions: DEFAULT_EXTENSIONS,
  hardwareConcurrencyPool: HARDWARE_CONCURRENCY_POOL,
  deviceMemoryPool: DEVICE_MEMORY_POOL,
  screenPool: SCREEN_POOL,
} = pools;

function jitterArray(arr, { offsetRange = 0, scaleRange = 0, clampMin = -Infinity, clampMax = Infinity, skipEvery4th = false } = {}) {
  const offset = (rng() * 2 - 1) * offsetRange;
  const scale = 1 + (rng() * 2 - 1) * scaleRange;
  return arr.map((v, i) => {
    if (skipEvery4th && i % 4 === 3) return v; // leave alpha channel alone
    return Math.max(clampMin, Math.min(clampMax, v * scale + offset));
  });
}

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, dataBuf) {
  const len = Buffer.alloc(4); len.writeUInt32BE(dataBuf.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, dataBuf])), 0);
  return Buffer.concat([len, typeBuf, dataBuf, crcBuf]);
}
function synthesizePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA, no interlace
  const [r, g, b] = [Math.floor(rng() * 256), Math.floor(rng() * 256), Math.floor(rng() * 256)];
  const rowLen = w * 4 + 1;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    raw[y * rowLen] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * rowLen + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const idatData = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const before = JSON.parse(JSON.stringify(data)); // for the summary diff

if (data.webgl) {
  const gpu = pickDifferent(GPU_POOL, { unmaskedVendor: data.webgl.unmaskedVendor, unmaskedRenderer: data.webgl.unmaskedRenderer });
  data.webgl.unmaskedVendor = gpu.unmaskedVendor;
  data.webgl.unmaskedRenderer = gpu.unmaskedRenderer;
  data.webgl.maxTextureSize = pickDifferent(MAX_TEXTURE_SIZE_POOL, data.webgl.maxTextureSize);

  // Extensions: wholesale replaced with the fixed defaults list, not
  // derived from the captured value at all, no shuffling, no randomness,
  // no per-machine variance. shaderPrecision is deliberately left
  // untouched, those values are essentially IEEE-754 standard-compliance
  // numbers, the same across vendors on modern hardware, so jittering them
  // would make them look LESS realistic.
  if (Array.isArray(data.webgl.extensions)) {
    data.webgl.extensions = DEFAULT_EXTENSIONS.slice();
  }
}

if (data.navigatorInfo) {
  data.navigatorInfo.hardwareConcurrency = pickDifferent(HARDWARE_CONCURRENCY_POOL, data.navigatorInfo.hardwareConcurrency);
  data.navigatorInfo.deviceMemory = pickDifferent(DEVICE_MEMORY_POOL, data.navigatorInfo.deviceMemory);
  // userAgent/platform deliberately untouched: JS-vs-HTTP-header mismatch risk, see README
}
if (data.screenInfo) {
  // colorDepth/pixelDepth deliberately untouched: 24-bit is near-universal;
  // an unusual value stands out more than it hides.
  const screen = pickDifferent(SCREEN_POOL, {
    width: data.screenInfo.width,
    height: data.screenInfo.height,
    devicePixelRatio: data.screenInfo.devicePixelRatio,
  });
  data.screenInfo.width = screen.width;
  data.screenInfo.height = screen.height;
  data.screenInfo.devicePixelRatio = screen.devicePixelRatio;
  data.screenInfo.availWidth = screen.width;
  data.screenInfo.availHeight = screen.height - 40; // approximate Windows taskbar height in logical (CSS) pixels
}

if (data.canvasImageData) {
  data.canvasImageData = jitterArray(data.canvasImageData, { offsetRange: 15, clampMin: 0, clampMax: 255, skipEvery4th: true });
}
if (data.audioSamples) {
  data.audioSamples = jitterArray(data.audioSamples, { scaleRange: 0.3, clampMin: -1, clampMax: 1 });
}
if (data.analyserFrequencyData) {
  data.analyserFrequencyData = jitterArray(data.analyserFrequencyData, { offsetRange: 8, clampMin: -140, clampMax: 0 });
}
if (data.analyserTimeDomainData) {
  data.analyserTimeDomainData = jitterArray(data.analyserTimeDomainData, { scaleRange: 0.3, clampMin: -1, clampMax: 1 });
}

// canvasDataURL gets zero runtime noise (served as-is on every call), so the
// baked-in value here is the *only* obscuring it ever gets. Always
// regenerated as a fresh synthetic image, unrelated to any real content.
if (data.canvasDataURL) {
  const png = synthesizePng(220, 30);
  data.canvasDataURL = 'data:image/png;base64,' + png.toString('base64');
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));

console.log(`Obscured -> ${outputPath}\n`);
console.log('webgl:', JSON.stringify({
  before: { unmaskedVendor: before.webgl && before.webgl.unmaskedVendor, unmaskedRenderer: before.webgl && before.webgl.unmaskedRenderer, maxTextureSize: before.webgl && before.webgl.maxTextureSize, extensionCount: before.webgl && before.webgl.extensions ? before.webgl.extensions.length : 0 },
  after: { unmaskedVendor: data.webgl && data.webgl.unmaskedVendor, unmaskedRenderer: data.webgl && data.webgl.unmaskedRenderer, maxTextureSize: data.webgl && data.webgl.maxTextureSize, extensionCount: data.webgl && data.webgl.extensions ? data.webgl.extensions.length : 0 },
}, null, 2));
console.log('navigatorInfo:', JSON.stringify({ before: before.navigatorInfo, after: data.navigatorInfo }, null, 2));
console.log('screenInfo:', JSON.stringify({ before: before.screenInfo, after: data.screenInfo }, null, 2));
console.log('canvasDataURL: regenerated (synthetic, no longer related to captured content)');
console.log('canvasImageData / audioSamples / analyserFrequencyData / analyserTimeDomainData: baseline jittered (magnitude on top of existing runtime noise)');
