// Replaces the real-time AudioContext constructor with a fully functional
// fake, on sites in the hard-block list. This is deliberately NOT a
// throw-on-construct block: an uncaught exception on a core API is itself a
// detectable, suspicious signal ("a modern browser that can't create an
// AudioContext"), and some anti-bot systems specifically watch for that. A
// fake context that looks and behaves normally (real method names, no
// exceptions, plausible property values) is far harder to distinguish
// from a real one from the page's perspective.
//
// Crucially, this never constructs a real AudioContext, so no live
// oscillator/analyser graph is ever opened at the OS audio level, which is
// what actually stops the Bluetooth-multipoint-interference side effect,
// not just the fingerprint itself. OfflineAudioContext is left untouched
// (it never touches real hardware) and its AnalyserNode/AudioBuffer reads
// are already covered by content.js's prototype overrides.
(function () {
  __FP_PRIVATE_HOST_GUARD__

  const CHANNEL = '__FP_CHANNEL__';
  const base = __FP_DATASET__;
  const report = (method) => {
    try { window.postMessage({ channel: CHANNEL, method }, window.location.origin); } catch (e) {}
  };

  window.__fpAudioHardblockApplied = true; // debug marker: if this is true but window.AudioContext isn't our FakeAudioContext later, something else overwrote it after us

  if (!window.AudioContext && !window.webkitAudioContext) return;

  const seed = Math.random();
  const freqSrc = base.analyserFrequencyData || [];
  const timeSrc = base.analyserTimeDomainData || [];

  __FP_ANALYSER_HELPERS__

  class FakeAudioParam {
    constructor(value) { this.value = value; this.defaultValue = value; }
    setValueAtTime(v) { this.value = v; return this; }
    linearRampToValueAtTime(v) { this.value = v; return this; }
    exponentialRampToValueAtTime(v) { this.value = v; return this; }
    setTargetAtTime(v) { this.value = v; return this; }
  }

  class FakeAudioNode {
    constructor(ctx) { this.context = ctx; this.numberOfInputs = 1; this.numberOfOutputs = 1; }
    connect(dest) { return dest; }
    disconnect() {}
  }

  class FakeAnalyserNode extends FakeAudioNode {
    constructor(ctx) {
      super(ctx);
      this.fftSize = 2048;
      this.frequencyBinCount = 1024;
      this.minDecibels = -100;
      this.maxDecibels = -30;
      this.smoothingTimeConstant = 0.8;
    }
    getFloatFrequencyData(array) {
      report('analyser');
      __fpFillFreqData(array, freqSrc, seed);
    }
    getByteFrequencyData(array) {
      report('analyser');
      __fpFillByteFreqData(array, freqSrc, seed, this.minDecibels, this.maxDecibels);
    }
    getFloatTimeDomainData(array) {
      report('analyser');
      __fpFillTimeData(array, timeSrc, seed);
    }
    getByteTimeDomainData(array) {
      report('analyser');
      __fpFillByteTimeData(array, timeSrc, seed);
    }
  }

  class FakeGainNode extends FakeAudioNode {
    constructor(ctx) { super(ctx); this.gain = new FakeAudioParam(1); }
  }

  class FakeOscillatorNode extends FakeAudioNode {
    constructor(ctx) {
      super(ctx);
      this.type = 'sine';
      this.frequency = new FakeAudioParam(440);
      this.detune = new FakeAudioParam(0);
    }
    start() {}
    stop() {}
  }

  class FakeDynamicsCompressorNode extends FakeAudioNode {
    constructor(ctx) {
      super(ctx);
      this.threshold = new FakeAudioParam(-24);
      this.knee = new FakeAudioParam(30);
      this.ratio = new FakeAudioParam(12);
      this.attack = new FakeAudioParam(0.003);
      this.release = new FakeAudioParam(0.25);
      this.reduction = 0;
    }
  }

  class FakeBiquadFilterNode extends FakeAudioNode {
    constructor(ctx) {
      super(ctx);
      this.type = 'lowpass';
      this.frequency = new FakeAudioParam(350);
      this.Q = new FakeAudioParam(1);
      this.gain = new FakeAudioParam(0);
      this.detune = new FakeAudioParam(0);
    }
  }

  class FakeAudioDestinationNode extends FakeAudioNode {
    constructor(ctx) { super(ctx); this.maxChannelCount = 2; this.channelCount = 2; }
  }

  class FakeAudioContext {
    constructor() {
      report('audioContextFaked');
      this._startTime = Date.now();
      this.sampleRate = 44100;
      this.state = 'running';
      this.baseLatency = 0.01;
      this.destination = new FakeAudioDestinationNode(this);
      this.listener = {};
    }
    get currentTime() { return (Date.now() - this._startTime) / 1000; }
    createOscillator() { return new FakeOscillatorNode(this); }
    createAnalyser() { return new FakeAnalyserNode(this); }
    createGain() { return new FakeGainNode(this); }
    createDynamicsCompressor() { return new FakeDynamicsCompressorNode(this); }
    createBiquadFilter() { return new FakeBiquadFilterNode(this); }
    createBufferSource() { return new FakeAudioNode(this); }
    createMediaStreamSource() { return new FakeAudioNode(this); }
    createMediaElementSource() { return new FakeAudioNode(this); }
    createChannelMerger() { return new FakeAudioNode(this); }
    createChannelSplitter() { return new FakeAudioNode(this); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    addEventListener() {}
    removeEventListener() {}
  }

  FakeAudioContext.__isFpFake = true; // identity marker, so we can tell later whether window.AudioContext still points at this class

  // A plain `window.AudioContext = FakeAudioContext` assignment can be
  // undone by a page script that runs after us and reassigns it again
  // (observed in practice: AliExpress's own fireyejs.js does its own
  // AudioContext neutering later in the load, clobbering a simple
  // assignment). Defining the property as non-configurable/non-writable
  // makes our value stick: a later `window.AudioContext = X` from any
  // other script silently fails (or throws in strict mode) instead of
  // taking effect.
  const lockProperty = (name, value) => {
    try {
      Object.defineProperty(window, name, { value, writable: false, configurable: false, enumerable: true });
    } catch (e) {
      // Already non-configurable for some other reason; best effort.
      try { window[name] = value; } catch (e2) {}
    }
  };
  lockProperty('AudioContext', FakeAudioContext);
  if ('webkitAudioContext' in window) lockProperty('webkitAudioContext', FakeAudioContext);
})();
