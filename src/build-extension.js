#!/usr/bin/env node
// Reads a captured fingerprint JSON file and generates a loadable, unpacked
// Chrome/Edge/Brave extension folder that serves it with per-session noise.
// The exclude list and hard-block list are both managed at runtime from the
// extension's popup; the seed files here are only used to populate
// chrome.storage.local on first install.
//
// Both list arguments accept a comma-separated list of JSON files, which are
// merged (deduplicated) into the seeded list, e.g. to combine the default
// exclude list with the optional financial-sites list without editing either
// file:
//   node build-extension.js fingerprint.json output/fp-extension exclude-list.json,exclude-financial.json
//
// Usage: node build-extension.js <fingerprint.json> [outputDir] [excludeList.json[,more.json...]] [hardblockList.json[,more.json...]]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// This file lives in src/; templates/ is a sibling directory here, but the
// JSON lists and default output dir live at the project root, one level up.
const ROOT_DIR = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

const [, , inputArg, outputArg, excludeArg, hardblockArg] = process.argv;

if (!inputArg) {
  console.error('Usage: node src/build-extension.js <fingerprint.json> [outputDir] [excludeList.json[,more.json...]] [hardblockList.json[,more.json...]]');
  process.exit(1);
}

function resolveListPaths(arg, defaultPath) {
  const raw = arg || defaultPath;
  return raw.split(',').map((p) => path.resolve(p.trim())).filter(Boolean);
}

const inputPath = path.resolve(inputArg);
const outputDir = path.resolve(outputArg || path.join(ROOT_DIR, 'output', 'fp-extension'));
const excludeListPaths = resolveListPaths(excludeArg, path.join(ROOT_DIR, 'exclude-list.json'));
const hardblockListPaths = resolveListPaths(hardblockArg, path.join(ROOT_DIR, 'hardblock-list.json'));

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const dataset = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const channel = 'fp_' + crypto.randomBytes(6).toString('hex');

fs.mkdirSync(outputDir, { recursive: true });

// Static files copied as-is.
fs.copyFileSync(path.join(TEMPLATES_DIR, 'manifest.template.json'), path.join(outputDir, 'manifest.json'));
for (const file of ['background.js', 'popup.html', 'popup.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(outputDir, file));
}

function seedList(srcPaths, destName) {
  const merged = [];
  const seen = new Set();
  for (const srcPath of srcPaths) {
    if (!fs.existsSync(srcPath)) continue;
    const entries = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    for (const entry of entries) {
      if (!seen.has(entry)) {
        seen.add(entry);
        merged.push(entry);
      }
    }
  }
  fs.writeFileSync(path.join(outputDir, destName), JSON.stringify(merged, null, 2) + '\n');
}

// Default/seed lists, only read by background.js on first install; after
// that, edits made from the popup live in chrome.storage.local. When
// multiple files are given, they're merged and deduplicated here at build
// time rather than requiring the source files themselves to be merged.
seedList(excludeListPaths, 'exclude-list.json');
seedList(hardblockListPaths, 'hardblock-list.json');

// content.js (MAIN world, does the actual patching), bridge.js (isolated
// world, relays call-detection events to the background worker), and
// audio-hardblock.js (MAIN world, fake AudioContext on hard-blocked sites)
// share one build-time-random channel token so bridge.js only reacts to
// messages from our own scripts, not arbitrary page postMessage traffic.
// AnalyserNode fake-data fill logic is shared source between content.js and
// audio-hardblock.js (both fake the same four read methods, on real vs. fake
// AnalyserNode instances respectively), spliced into each via this token so
// there's one copy to maintain instead of two.
const analyserHelpers = fs.readFileSync(path.join(TEMPLATES_DIR, 'analyser-fake.snippet.js'), 'utf8');

// Same idea for the private-host (RFC 1918/loopback/*.local) early-return
// guard: both MAIN-world scripts need the identical check at the very top,
// before they patch anything.
const privateHostGuard = fs.readFileSync(path.join(TEMPLATES_DIR, 'private-host-guard.snippet.js'), 'utf8');

const contentTemplate = fs.readFileSync(path.join(TEMPLATES_DIR, 'content.template.js'), 'utf8');
fs.writeFileSync(
  path.join(outputDir, 'content.js'),
  contentTemplate
    .replace('__FP_DATASET__', JSON.stringify(dataset))
    .replace(/__FP_CHANNEL__/g, channel)
    .replace('__FP_ANALYSER_HELPERS__', analyserHelpers)
    .replace('__FP_PRIVATE_HOST_GUARD__', privateHostGuard)
);

const bridgeTemplate = fs.readFileSync(path.join(TEMPLATES_DIR, 'bridge.template.js'), 'utf8');
fs.writeFileSync(
  path.join(outputDir, 'bridge.js'),
  bridgeTemplate.replace(/__FP_CHANNEL__/g, channel)
);

const hardblockTemplate = fs.readFileSync(path.join(TEMPLATES_DIR, 'audio-hardblock.template.js'), 'utf8');
fs.writeFileSync(
  path.join(outputDir, 'audio-hardblock.js'),
  hardblockTemplate
    .replace('__FP_DATASET__', JSON.stringify(dataset))
    .replace(/__FP_CHANNEL__/g, channel)
    .replace('__FP_ANALYSER_HELPERS__', analyserHelpers)
    .replace('__FP_PRIVATE_HOST_GUARD__', privateHostGuard)
);

console.log(`Extension built -> ${outputDir}`);
console.log('Load it via chrome://extensions (or edge://extensions, brave://extensions) -> Developer mode -> Load unpacked.');
console.log('Manage the exclude list, hard-block list, and per-site spoofed-call counts from the toolbar popup after loading.');
