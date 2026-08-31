#!/usr/bin/env node
// Launches your real installed Chrome via Playwright, captures a canvas/WebGL/audio
// fingerprint baseline from it, and writes the result to a JSON file.
//
// Usage: node src/capture-fingerprint.js [outputPath]

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// This file lives in src/; default output goes to the project root, one level up.
const outputPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'fingerprint.json'));

(async () => {
  console.log('Launching Chrome...');
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const dataset = await page.evaluate(async () => {
    const dataset = {};

    // Canvas
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 30;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('Cwm fjordbank glyphs vext quiz, 😃', 2, 2);
    dataset.canvasImageData = Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    dataset.canvasDataURL = canvas.toDataURL();

    // WebGL
    const glCanvas = document.createElement('canvas');
    const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      dataset.webgl = {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        extensions: gl.getSupportedExtensions(),
      };

      // getShaderPrecisionFormat: capture every (shader type, precision type)
      // combination, 2 shader types x 6 precision types. Keyed by
      // "<shaderType>_<precisionType>" (the raw GL enum values) for a simple
      // flat lookup at serve time.
      const shaderTypes = [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER];
      const precisionTypes = [gl.LOW_FLOAT, gl.MEDIUM_FLOAT, gl.HIGH_FLOAT, gl.LOW_INT, gl.MEDIUM_INT, gl.HIGH_INT];
      dataset.webgl.shaderPrecision = {};
      for (const st of shaderTypes) {
        for (const pt of precisionTypes) {
          const fmt = gl.getShaderPrecisionFormat(st, pt);
          if (fmt) {
            dataset.webgl.shaderPrecision[`${st}_${pt}`] = {
              rangeMin: fmt.rangeMin,
              rangeMax: fmt.rangeMax,
              precision: fmt.precision,
            };
          }
        }
      }
    }

    // Audio
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctxA = new AC(1, 5000, 44100);
    const osc = ctxA.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const compressor = ctxA.createDynamicsCompressor();
    osc.connect(compressor);
    compressor.connect(ctxA.destination);
    osc.start(0);
    const buffer = await ctxA.startRendering();
    dataset.audioSamples = Array.from(buffer.getChannelData(0).slice(0, 500));

    // Reproduces AliExpress's actual documented technique (sawtooth oscillator
    // -> AnalyserNode, silent gain=0 path to destination) so we have a
    // realistic baseline for the AnalyserNode read methods specifically;
    // getChannelData() above covers the offline-render fingerprinting
    // pattern, but AnalyserNode.getFloat/ByteFrequencyData/TimeDomainData is
    // a separate API surface those overrides don't touch.
    const ctxA2 = new AC(1, 5000, 44100);
    const osc2 = ctxA2.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = 1000;
    const analyser = ctxA2.createAnalyser();
    const silentGain = ctxA2.createGain();
    silentGain.gain.value = 0;
    osc2.connect(analyser);
    osc2.connect(silentGain);
    silentGain.connect(ctxA2.destination);
    osc2.start(0);
    await ctxA2.startRendering();
    const freqData = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqData);
    const timeData = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeData);
    dataset.analyserFrequencyData = Array.from(freqData);
    dataset.analyserTimeDomainData = Array.from(timeData.slice(0, 500));

    // canPlayType()/MediaCapabilities: capture real support for a
    // representative set of common format/codec strings, confirmed read
    // by AliExpress's own script per the Ars Technica coverage.
    const FORMAT_PROBE_LIST = [
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="avc1.4D401E"',
      'video/mp4; codecs="hev1.1.6.L93.B0"',
      'video/webm; codecs="vp8"',
      'video/webm; codecs="vp9"',
      'video/ogg; codecs="theora"',
      'video/mp4',
      'video/webm',
      'video/ogg',
      'audio/mpeg',
      'audio/mp4; codecs="mp4a.40.2"',
      'audio/ogg; codecs="vorbis"',
      'audio/ogg; codecs="opus"',
      'audio/wav; codecs="1"',
      'audio/webm; codecs="vorbis"',
      'audio/flac',
      'audio/mp4',
      'audio/ogg',
      'audio/wav',
      'audio/webm',
    ];
    const videoEl = document.createElement('video');
    const audioEl = document.createElement('audio');
    dataset.canPlayType = {};
    for (const type of FORMAT_PROBE_LIST) {
      const el = type.startsWith('video') ? videoEl : audioEl;
      dataset.canPlayType[type] = el.canPlayType(type);
    }

    // Static navigator/screen properties confirmed read by AliExpress's own
    // fireyejs.js risk-scoring script.
    dataset.navigatorInfo = {
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory || null,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
    };
    dataset.screenInfo = {
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      devicePixelRatio: window.devicePixelRatio,
    };

    return dataset;
  });

  fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2));
  console.log(`Fingerprint captured -> ${outputPath}`);

  await browser.close();
})().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
