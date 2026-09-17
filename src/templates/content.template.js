(function () {
  __FP_PRIVATE_HOST_GUARD__

  const base = __FP_DATASET__;
  const CHANNEL = '__FP_CHANNEL__';
  const seed = Math.random();
  const noise = (i) => Math.sin(seed * 9999 + i) * 0.5 * 0.0003;
  window.__fpSpoofActive = true; // debug marker: check this in DevTools console to confirm the script ran on a given site
  const report = (method) => {
    try { window.postMessage({ channel: CHANNEL, method }, window.location.origin); } catch (e) {}
  };
  const defineGetter = (target, prop, value) => {
    if (value === undefined || value === null) return;
    try { Object.defineProperty(target, prop, { get: () => value, configurable: true }); } catch (e) {}
  };

  __FP_ANALYSER_HELPERS__

  if (base.canvasImageData) {
    CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
      report('getImageData');
      const src = base.canvasImageData;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.min(255, Math.max(0, (src[i % src.length] || 0) + noise(i)));
      }
      return new ImageData(data, w, h);
    };
  }

  // Returns the baseline captured at build time as-is. Deliberately does NOT
  // decode/redraw/re-encode (which would mean invoking the real native
  // canvas encoder at runtime); to change this value, edit fingerprint.json
  // and rebuild rather than expecting it to vary per session.
  if (base.canvasDataURL) {
    HTMLCanvasElement.prototype.toDataURL = function () {
      report('toDataURL');
      return base.canvasDataURL;
    };
  }

  // Every WebGL parameter this serves is looked up in the captured baseline.
  // Anything not present returns a generic placeholder instead of falling
  // through to the real native getParameter call.
  if (base.webgl) {
    const known = {
      37445: base.webgl.unmaskedVendor || base.webgl.vendor,   // UNMASKED_VENDOR_WEBGL
      37446: base.webgl.unmaskedRenderer || base.webgl.renderer, // UNMASKED_RENDERER_WEBGL
      7936: base.webgl.vendor,   // VENDOR
      7937: base.webgl.renderer, // RENDERER
      3379: base.webgl.maxTextureSize, // MAX_TEXTURE_SIZE
    };
    const patch = (proto) => {
      proto.getParameter = function (p) {
        report('getParameter');
        return Object.prototype.hasOwnProperty.call(known, p) ? known[p] : null;
      };

      // Served as captured (real values), not vendor-matched to the fake
      // GPU string above: building realistic per-vendor extension-list
      // and shader-precision pools is real effort for comparatively low
      // marginal value here, since these vary less across GPUs than
      // vendor/renderer strings do. Known limitation, not an oversight.
      if (base.webgl.extensions) {
        proto.getSupportedExtensions = function () {
          report('webglExtensions');
          return base.webgl.extensions.slice();
        };
      }
      if (base.webgl.shaderPrecision) {
        proto.getShaderPrecisionFormat = function (shaderType, precisionType) {
          report('webglExtensions');
          const fmt = base.webgl.shaderPrecision[`${shaderType}_${precisionType}`];
          return fmt ? { rangeMin: fmt.rangeMin, rangeMax: fmt.rangeMax, precision: fmt.precision } : null;
        };
      }
    };
    if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  }

  if (base.audioSamples) {
    AudioBuffer.prototype.getChannelData = function (channel) {
      report('getChannelData');
      const src = base.audioSamples;
      const data = new Float32Array(this.length);
      for (let i = 0; i < data.length; i++) {
        data[i] = (src[i % src.length] || 0) + noise(i);
      }
      return data;
    };
  }

  // AnalyserNode: the live-fingerprinting technique publicly documented for
  // AliExpress's fireyejs.js/collina.js (an oscillator feeding an
  // AnalyserNode, plus a silent gain=0 path to the destination, read
  // repeatedly over time): a separate API surface from getChannelData
  // above, which only covers the one-shot OfflineAudioContext-render
  // pattern. These methods write into a caller-supplied typed array rather
  // than returning a value.
  if (base.analyserFrequencyData || base.analyserTimeDomainData) {
    const freqSrc = base.analyserFrequencyData || [];
    const timeSrc = base.analyserTimeDomainData || [];

    AnalyserNode.prototype.getFloatFrequencyData = function (array) {
      report('analyser');
      __fpFillFreqData(array, freqSrc, seed);
    };

    AnalyserNode.prototype.getByteFrequencyData = function (array) {
      report('analyser');
      __fpFillByteFreqData(array, freqSrc, seed, this.minDecibels, this.maxDecibels);
    };

    AnalyserNode.prototype.getFloatTimeDomainData = function (array) {
      report('analyser');
      __fpFillTimeData(array, timeSrc, seed);
    };

    AnalyserNode.prototype.getByteTimeDomainData = function (array) {
      report('analyser');
      __fpFillByteTimeData(array, timeSrc, seed);
    };
  }

  // canPlayType()/MediaCapabilities.decodingInfo(): both queried against the
  // same captured probe table: a lookup by exact format/codec string,
  // never a live media-framework call. Anything not in the captured table
  // returns the "can't play this" answer (empty string / supported:false)
  // rather than falling through to a real capability check.
  if (base.canPlayType) {
    HTMLMediaElement.prototype.canPlayType = function (type) {
      report('canPlayType');
      return Object.prototype.hasOwnProperty.call(base.canPlayType, type) ? base.canPlayType[type] : '';
    };

    if (window.MediaCapabilities) {
      MediaCapabilities.prototype.decodingInfo = function (config) {
        report('canPlayType');
        const contentType = (config && ((config.video && config.video.contentType) || (config.audio && config.audio.contentType))) || '';
        const support = Object.prototype.hasOwnProperty.call(base.canPlayType, contentType) ? base.canPlayType[contentType] : '';
        const supported = support === 'probably' || support === 'maybe';
        return Promise.resolve({ supported, smooth: supported, powerEfficient: supported });
      };
    }
  }

  // Static navigator/screen properties. These are plain property reads with
  // no underlying "real" computation to avoid calling; overriding them is
  // just replacing one static value with another.
  if (base.navigatorInfo) {
    const nav = base.navigatorInfo;
    defineGetter(Navigator.prototype, 'hardwareConcurrency', nav.hardwareConcurrency);
    defineGetter(Navigator.prototype, 'deviceMemory', nav.deviceMemory);
    // userAgent/platform are captured and served for completeness, but see
    // the README caveat: overriding these here does NOT change the real
    // HTTP User-Agent header sent with requests, so editing them away from
    // your real values creates a JS-vs-header mismatch that some anti-bot
    // systems specifically check for. Leave these two as captured (real)
    // unless you also rewrite the header (see README).
    defineGetter(Navigator.prototype, 'userAgent', nav.userAgent);
    defineGetter(Navigator.prototype, 'platform', nav.platform);
  }

  if (base.screenInfo) {
    const scr = base.screenInfo;
    defineGetter(Screen.prototype, 'colorDepth', scr.colorDepth);
    defineGetter(Screen.prototype, 'pixelDepth', scr.pixelDepth);
    // width/height/availWidth/availHeight are pure reporting: unlike
    // window.innerWidth/innerHeight, CSS layout never reads screen.*, so
    // there's no visual side effect from overriding these.
    defineGetter(Screen.prototype, 'width', scr.width);
    defineGetter(Screen.prototype, 'height', scr.height);
    defineGetter(Screen.prototype, 'availWidth', scr.availWidth);
    defineGetter(Screen.prototype, 'availHeight', scr.availHeight);
    defineGetter(window, 'devicePixelRatio', scr.devicePixelRatio);
  }

  // navigator.plugins/mimeTypes: always report empty, regardless of what's
  // actually installed. Modern Chrome's real plugin list is nearly empty
  // anyway (NPAPI plugins have been gone for years), so there's little to
  // lose and it's simpler/more consistent than trying to report a
  // "realistic" non-empty list.
  {
    const makeEmptyPluginArray = () => {
      const arr = [];
      arr.item = () => null;
      arr.namedItem = () => null;
      arr.refresh = () => {};
      try { Object.defineProperty(arr, Symbol.toStringTag, { value: 'PluginArray' }); } catch (e) {}
      return arr;
    };
    const makeEmptyMimeTypeArray = () => {
      const arr = [];
      arr.item = () => null;
      arr.namedItem = () => null;
      try { Object.defineProperty(arr, Symbol.toStringTag, { value: 'MimeTypeArray' }); } catch (e) {}
      return arr;
    };
    try {
      Object.defineProperty(Navigator.prototype, 'plugins', { get: makeEmptyPluginArray, configurable: true });
      Object.defineProperty(Navigator.prototype, 'mimeTypes', { get: makeEmptyMimeTypeArray, configurable: true });
    } catch (e) {}
  }

  // navigator.webdriver: always false. This is already false on a normal,
  // non-automated Chrome session; this override mainly matters as a
  // safety net (an automated/dev environment, or another extension/flag,
  // could otherwise leave it true) rather than changing typical real-user
  // behavior.
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
  } catch (e) {}

  // RTCPeerConnection: unlike the fingerprint-read overrides above, this
  // must still construct a real peer connection: WebRTC has to actually
  // work for sites that use it for calls/screen share. What this does is
  // filter host ICE candidates that carry your real local IP out of the
  // events the page sees, rather than fabricate a fake connection object
  // (which would break real WebRTC use entirely).
  if (window.RTCPeerConnection) {
    const OrigRTCPeerConnection = window.RTCPeerConnection;
    const isPrivateOrLocal = (candidateStr) => {
      if (!candidateStr) return false;
      return /(?:\b127\.|\b10\.|\b192\.168\.|\b172\.(?:1[6-9]|2\d|3[0-1])\.|\bfe80:|\b::1\b)/.test(candidateStr);
    };

    const WrappedRTCPeerConnection = function (...args) {
      report('rtc');
      const pc = new OrigRTCPeerConnection(...args);

      const origAddEventListener = pc.addEventListener.bind(pc);
      pc.addEventListener = function (type, listener, ...rest) {
        if (type === 'icecandidate' && typeof listener === 'function') {
          const wrapped = (event) => {
            if (event.candidate && isPrivateOrLocal(event.candidate.candidate)) return;
            listener(event);
          };
          return origAddEventListener(type, wrapped, ...rest);
        }
        return origAddEventListener(type, listener, ...rest);
      };

      let onicecandidateHandler = null;
      Object.defineProperty(pc, 'onicecandidate', {
        get: () => onicecandidateHandler,
        set: (fn) => { onicecandidateHandler = fn; },
        configurable: true,
      });
      // Route the real event through the filter before invoking whatever the
      // page assigned to onicecandidate.
      pc.addEventListener('icecandidate', (event) => {
        if (typeof onicecandidateHandler === 'function') onicecandidateHandler(event);
      });

      return pc;
    };
    WrappedRTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;

    // A plain assignment here can be silently overwritten by a page script
    // that runs after us and reassigns window.RTCPeerConnection again,
    // observed happening in practice for window.AudioContext (AliExpress's
    // own fireyejs.js does its own reassignment later in page load; see
    // audio-hardblock.template.js). Locking the property the same way here
    // guards against the same thing happening to this override.
    try {
      Object.defineProperty(window, 'RTCPeerConnection', {
        value: WrappedRTCPeerConnection, writable: false, configurable: false, enumerable: true,
      });
    } catch (e) {
      try { window.RTCPeerConnection = WrappedRTCPeerConnection; } catch (e2) {}
    }
  }
})();
