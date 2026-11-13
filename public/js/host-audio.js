/**
 * Host Audio Processing & Streaming Engine
 * Manages Web Audio context, zero-allocation DSP spatial matrix, system audio capture,
 * media file playback, synthetic 5.1 test tones, continuous sample-accurate timestamping,
 * and Direct Peer-to-Peer WebRTC UDP DataChannel streaming (with automatic WebSocket fallback).
 */
class HostAudioEngine {
  constructor(ws, ntpSync) {
    this.ws = ws;
    this.ntpSync = ntpSync;
    this.audioCtx = null;
    this.sourceNode = null;
    this.activeSourceType = 'none'; // 'system' | 'file' | 'demo'
    this.currentMode = 'PARTY'; // 'PARTY' (Stereo) | 'DOLBY' (Surround)
    this.activeChannels = new Set([255]); // Active destination channels
    this.connectedDeviceCount = 0;

    // Direct P2P WebRTC UDP DataChannels: deviceId -> { dc, channelIndex }
    this.peerDataChannels = new Map();

    // DSP Nodes
    this.analyser = null;
    this.masterGain = null;
    this.laptopDelayNode = null;
    this.laptopGain = null;
    this.processorMuteGain = null;

    // Packet streaming & clock anchoring
    this.sequence = 0;
    this.processor = null;
    this.workletNode = null;
    this.workletLoaded = false;
    this.isRunning = false;
    this.sampleRate = 48000;
    this.outputLatency = 0;
    this.streamAnchorLocalTime = null;
    this.streamAnchorAudioTime = null;
    this.streamAnchorNtpOffset = 0;
    this.totalSamplesProcessed = 0;

    // Stream references & callbacks
    this.mediaStream = null;
    this.audioElement = null;
    this.currentObjectUrl = null;
    this.currentFileName = '';
    this.fileLoop = true;
    this.onStreamEnded = null;

    // Ultra-low-latency default lead buffer (35ms for real-time video lip-sync)
    this.broadcastDelayMs = 35;
    this.initialLaptopVolume = 0.75;

    // Audio payload codec: 'auto' (Smart Adaptive), 'pcm' (Lossless 16-bit), or 'adpcm' (4:1 Stateful IMA-ADPCM)
    this.codec = 'auto';

    // Subwoofer Bandpass Filter: 65Hz High-Pass + 180Hz Low-Pass
    this._subLowpass = {
      b0: 0, b1: 0, b2: 0, a1: 0, a2: 0,
      x1: 0, x2: 0, y1: 0, y2: 0
    };
    this._subHighpass = {
      b0: 0, b1: 0, b2: 0, a1: 0, a2: 0,
      x1: 0, x2: 0, y1: 0, y2: 0
    };

    // 90-degree Surround All-Pass & Decorrelation Delay (15ms circular buffer, sized in init)
    this._surroundDelaySize = Math.floor(this.sampleRate * 0.015);
    this._surroundDelayBuf = new Float32Array(this._surroundDelaySize);
    this._surroundDelayIdx = 0;
    this._surroundAllpassState = { x1: 0, y1: 0, c: 0.6 };

    // Real-time audio telemetry (RMS & Peak)
    this.audioLevels = {
      leftRms: 0,
      rightRms: 0,
      leftPeak: 0,
      rightPeak: 0,
      energy: 0,
      channelEnergy: { 255: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
    };

    // Studio Demo Synthesizer State
    this.demoType = 'none';
    this.demoTimer = null;
    this.demoAudioNodes = [];

    // Pre-allocated static PCM buffers (2048 samples max) - Zero GC allocation during streaming
    const maxBufferSize = 2048;
    this.pcmBuffers = {
      255: new Int16Array(maxBufferSize),
      1: new Int16Array(maxBufferSize),
      2: new Int16Array(maxBufferSize),
      3: new Int16Array(maxBufferSize),
      4: new Int16Array(maxBufferSize),
      5: new Int16Array(maxBufferSize),
      6: new Int16Array(maxBufferSize)
    };

    this.testBuffer = new Int16Array(maxBufferSize);

    const headerSize = 16;
    const packetByteSize = headerSize + (maxBufferSize * 2);
    this.headerSize = headerSize;
    this.packetBuffers = {};
    this.packetViews = {};
    this.packetBytes = {};

    [255, 1, 2, 3, 4, 5, 6].forEach(chId => {
      const buffer = new ArrayBuffer(packetByteSize);
      this.packetBuffers[chId] = buffer;
      this.packetViews[chId] = new DataView(buffer);
      this.packetBytes[chId] = new Uint8Array(buffer);
    });

    this.onVisualizerData = null;
  }

  async init() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
      this.sampleRate = this.audioCtx.sampleRate;
      this._setupSubFilter(this.sampleRate);
      this._surroundDelaySize = Math.max(1, Math.floor(this.sampleRate * 0.015));
      this._surroundDelayBuf = new Float32Array(this._surroundDelaySize);
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.outputLatency = this.audioCtx.outputLatency || this.audioCtx.baseLatency || 0;

    if (!this.analyser) {
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
    }

    if (!this.laptopDelayNode) {
      this.laptopDelayNode = this.audioCtx.createDelay(1.0);
      this.laptopDelayNode.delayTime.value = Math.max(
        0,
        (this.broadcastDelayMs / 1000) - this.outputLatency
      );

      this.laptopGain = this.audioCtx.createGain();
      this.laptopGain.gain.value = this.initialLaptopVolume;

      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = 1.0;

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.laptopDelayNode);
      this.laptopDelayNode.connect(this.laptopGain);
      this.laptopGain.connect(this.audioCtx.destination);
    }

    if (!this.workletLoaded && this.audioCtx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await this.audioCtx.audioWorklet.addModule('/js/audio-worklet-processor.js');
        this.workletLoaded = true;
      } catch (err) {
        console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', err);
      }
    }
  }

  setPeerDataChannel(deviceId, dc, channelIndex = 255) {
    if (!dc) {
      this.peerDataChannels.delete(deviceId);
    } else {
      this.peerDataChannels.set(deviceId, { dc, channelIndex });
    }
  }

  updatePeerChannel(deviceId, channelIndex) {
    const entry = this.peerDataChannels.get(deviceId);
    if (entry) {
      entry.channelIndex = channelIndex;
    }
  }

  setMode(mode) {
    if (this.currentMode !== mode) {
      this.currentMode = mode;
      if (typeof AudioCodec !== 'undefined' && AudioCodec.resetState) {
        AudioCodec.resetState();
      }
    }
  }

  setConnectedDeviceCount(count) {
    this.connectedDeviceCount = Math.max(0, Number(count) || 0);
  }

  setActiveChannels(channels) {
    if (Array.isArray(channels)) {
      this.activeChannels = new Set(channels);
    } else if (channels instanceof Set) {
      this.activeChannels = channels;
    } else {
      this.activeChannels = null;
    }
  }

  setLaptopVolume(vol) {
    const clamped = Math.max(0, Math.min(1.5, vol));
    this.initialLaptopVolume = clamped;
    if (this.laptopGain && this.audioCtx) {
      this.laptopGain.gain.setValueAtTime(clamped, this.audioCtx.currentTime);
    }
  }

  setBroadcastDelay(ms) {
    this.broadcastDelayMs = ms;
    if (this.laptopDelayNode && this.audioCtx) {
      const outLat = this.audioCtx.outputLatency || this.audioCtx.baseLatency || 0;
      this.laptopDelayNode.delayTime.setValueAtTime(
        Math.max(0, (ms / 1000) - outLat),
        this.audioCtx.currentTime
      );
    }
  }

  setCodec(mode) {
    if (mode !== 'auto' && mode !== 'adpcm' && mode !== 'pcm') return;
    this.codec = (mode !== 'pcm' && typeof AudioCodec === 'undefined') ? 'pcm' : mode;
    if (typeof AudioCodec !== 'undefined' && AudioCodec.resetState) {
      AudioCodec.resetState();
    }
  }

  _shouldUseAdpcm() {
    if (typeof AudioCodec === 'undefined') return false;
    if (this.codec === 'adpcm') return true;
    if (this.codec === 'pcm') return false;
    const activeChCount = this.activeChannels ? this.activeChannels.size : 1;
    return this.currentMode === 'DOLBY' || activeChCount > 1 || this.connectedDeviceCount >= 3;
  }

  async startSystemAudio() {
    await this.init();
    this.stopCurrentSource();

    try {
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2
        }
      });

      const audioTracks = this.mediaStream.getAudioTracks();
      if (!audioTracks || audioTracks.length === 0) {
        this.mediaStream.getTracks().forEach(t => t.stop());
        this.mediaStream = null;
        throw new Error('No audio track selected! Please check the "Share audio" box when sharing.');
      }

      this.mediaStream.getVideoTracks().forEach(t => t.stop());

      this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.activeSourceType = 'system';
      this.setupProcessingGraph();

      audioTracks[0].onended = () => {
        this.stopCurrentSource();
        if (this.onStreamEnded) this.onStreamEnded('system');
      };

      return true;
    } catch (err) {
      console.error('Failed to capture system audio:', err);
      throw err;
    }
  }

  async startFileAudio(file) {
    await this.init();
    this.stopCurrentSource();

    const url = URL.createObjectURL(file);
    this.currentObjectUrl = url;
    this.currentFileName = file.name || 'Audio file';

    const audio = new Audio();
    audio.src = url;
    audio.loop = this.fileLoop;
    audio.crossOrigin = 'anonymous';

    audio.onended = () => {
      if (!audio.loop && this.activeSourceType === 'file') {
        this.isRunning = false;
        if (this.onStreamEnded) this.onStreamEnded('file');
      }
    };

    try {
      await audio.play();
    } catch (err) {
      this.stopCurrentSource();
      throw err;
    }

    this.audioElement = audio;
    this.sourceNode = this.audioCtx.createMediaElementSource(audio);
    this.activeSourceType = 'file';
    this.setupProcessingGraph();

    return true;
  }

  hasLoadedFile() {
    return this.activeSourceType === 'file' && Boolean(this.audioElement);
  }

  async pauseFileAudio() {
    if (this.audioElement && !this.audioElement.paused) {
      this.audioElement.pause();
    }
    this.isRunning = false;
  }

  async resumeFileAudio() {
    if (!this.audioElement) return false;
    await this.init();
    await this.audioElement.play();
    this.resetStreamAnchor();
    this.isRunning = true;
    return true;
  }

  seekFileAudio(seconds) {
    if (!this.audioElement || !Number.isFinite(seconds)) return;
    const dur = Number.isFinite(this.audioElement.duration) ? this.audioElement.duration : 0;
    const clamped = Math.max(0, dur > 0 ? Math.min(dur, seconds) : seconds);
    this.audioElement.currentTime = clamped;
    this.resetStreamAnchor();
  }

  resetStreamAnchor() {
    this.streamAnchorLocalTime = null;
    this.streamAnchorAudioTime = null;
    this.streamAnchorNtpOffset = this.ntpSync ? this.ntpSync.offset : 0;
    this.totalSamplesProcessed = 0;
    if (typeof AudioCodec !== 'undefined' && AudioCodec.resetState) {
      AudioCodec.resetState();
    }
  }

  setFileLoop(loop) {
    this.fileLoop = Boolean(loop);
    if (this.audioElement) {
      this.audioElement.loop = this.fileLoop;
    }
  }

  getFilePlaybackState() {
    if (!this.audioElement) return null;
    return {
      name: this.currentFileName,
      currentTime: this.audioElement.currentTime || 0,
      duration: Number.isFinite(this.audioElement.duration) ? this.audioElement.duration : 0,
      paused: this.audioElement.paused,
      loop: this.fileLoop
    };
  }

  setupProcessingGraph() {
    if (!this.sourceNode) return;

    this.sourceNode.connect(this.masterGain);

    this._subLowpass.x1 = 0; this._subLowpass.x2 = 0;
    this._subLowpass.y1 = 0; this._subLowpass.y2 = 0;
    this._subHighpass.x1 = 0; this._subHighpass.x2 = 0;
    this._subHighpass.y1 = 0; this._subHighpass.y2 = 0;
    this._surroundDelayBuf.fill(0);
    this._surroundDelayIdx = 0;
    this._surroundAllpassState.x1 = 0;
    this._surroundAllpassState.y1 = 0;

    if (!this.processorMuteGain) {
      this.processorMuteGain = this.audioCtx.createGain();
      this.processorMuteGain.gain.value = 0;
      this.processorMuteGain.connect(this.audioCtx.destination);
    }

    if (this.workletLoaded && typeof AudioWorkletNode !== 'undefined') {
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'sonora-capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.processorMuteGain);
      this.workletNode.port.onmessage = (e) => {
        if (!this.isRunning) return;
        const { left, right, audioTime } = e.data;
        this.handlePcmFrame(left, right, audioTime);
      };
    } else {
      // Low-latency 512-sample ScriptProcessor fallback
      const bufferSize = 512;
      this.processor = this.audioCtx.createScriptProcessor(bufferSize, 2, 2);
      this.sourceNode.connect(this.processor);
      this.processor.connect(this.processorMuteGain);
      this.processor.onaudioprocess = (e) => this.handleAudioProcess(e);
    }

    this.resetStreamAnchor();
    this.sequence = 0;
    this.isRunning = true;
  }

  _setupSubFilter(sampleRate) {
    {
      const fc = 65;
      const omega = 2 * Math.PI * fc / sampleRate;
      const sinO = Math.sin(omega);
      const cosO = Math.cos(omega);
      const alpha = sinO / (2 * 0.7071);
      const b0 = (1 + cosO) / 2;
      const b1 = -(1 + cosO);
      const b2 = (1 + cosO) / 2;
      const a0 = 1 + alpha;
      const a1 = -2 * cosO;
      const a2 = 1 - alpha;
      this._subHighpass = {
        b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
        a1: a1 / a0, a2: a2 / a0,
        x1: 0, x2: 0, y1: 0, y2: 0
      };
    }
    {
      const fc = 180;
      const omega = 2 * Math.PI * fc / sampleRate;
      const sinO = Math.sin(omega);
      const cosO = Math.cos(omega);
      const alpha = sinO / (2 * 0.7071);
      const b0 = (1 - cosO) / 2;
      const b1 = 1 - cosO;
      const b2 = (1 - cosO) / 2;
      const a0 = 1 + alpha;
      const a1 = -2 * cosO;
      const a2 = 1 - alpha;
      this._subLowpass = {
        b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
        a1: a1 / a0, a2: a2 / a0,
        x1: 0, x2: 0, y1: 0, y2: 0
      };
    }
  }

  _softLimit(x) {
    if (x > -0.92 && x < 0.92) return x;
    if (x >= 0.92) return 0.92 + 0.08 * Math.tanh((x - 0.92) / 0.08);
    return -0.92 + 0.08 * Math.tanh((x + 0.92) / 0.08);
  }

  getAudioLevels() {
    return this.audioLevels;
  }

  handleAudioProcess(event) {
    if (!this.isRunning) return;

    if (event.outputBuffer) {
      for (let ch = 0; ch < event.outputBuffer.numberOfChannels; ch++) {
        event.outputBuffer.getChannelData(ch).fill(0);
      }
    }

    const inputBuffer = event.inputBuffer;
    const leftChannel = inputBuffer.getChannelData(0);
    const rightChannel = inputBuffer.numberOfChannels > 1 ? inputBuffer.getChannelData(1) : leftChannel;
    const totalLen = inputBuffer.length;
    const chunkStartAudioTime = this.audioCtx.currentTime - (totalLen / this.sampleRate);

    this.handlePcmFrame(leftChannel, rightChannel, chunkStartAudioTime);
  }

  handlePcmFrame(leftChannel, rightChannel, chunkStartAudioTime) {
    if (!this.isRunning) return;

    const numSamples = leftChannel.length;
    const localNow = this.ntpSync ? this.ntpSync.getLocalTime() : Date.now();
    const ageMs = Math.max(0, (this.audioCtx.currentTime - chunkStartAudioTime) * 1000);

    if (this.streamAnchorLocalTime === null || this.streamAnchorAudioTime === null) {
      this.streamAnchorLocalTime = localNow - ageMs;
      this.streamAnchorAudioTime = chunkStartAudioTime;
      this.streamAnchorNtpOffset = this.ntpSync ? this.ntpSync.offset : 0;
      this.totalSamplesProcessed = 0;
    }

    const expectedAudioTime = this.streamAnchorAudioTime + (this.totalSamplesProcessed / this.sampleRate);
    if (Math.abs(chunkStartAudioTime - expectedAudioTime) > 0.150) {
      this.streamAnchorLocalTime = localNow - ageMs;
      this.streamAnchorAudioTime = chunkStartAudioTime;
      this.streamAnchorNtpOffset = this.ntpSync ? this.ntpSync.offset : 0;
      this.totalSamplesProcessed = 0;
      if (typeof AudioCodec !== 'undefined' && AudioCodec.resetState) {
        AudioCodec.resetState();
      }
    }

    if (this.ntpSync) {
      const offsetDiff = this.ntpSync.offset - this.streamAnchorNtpOffset;
      this.streamAnchorNtpOffset += Math.max(-0.02, Math.min(0.02, offsetDiff * 0.01));
    }

    const bufferMasterTime = this.streamAnchorLocalTime +
      ((this.totalSamplesProcessed / this.sampleRate) * 1000) +
      this.streamAnchorNtpOffset;
    const targetPlayTime = bufferMasterTime + this.broadcastDelayMs;
    this.totalSamplesProcessed += numSamples;

    this.sequence = (this.sequence + 1) & 0xffff;

    let lSumSq = 0;
    let rSumSq = 0;
    let lPeak = 0;
    let rPeak = 0;

    const isParty = this.currentMode === 'PARTY';

    if (isParty) {
      const partyBuf = this.pcmBuffers[255];
      for (let i = 0; i < numSamples; i++) {
        const l = leftChannel[i];
        const r = rightChannel[i];
        const absL = Math.abs(l);
        const absR = Math.abs(r);
        if (absL > lPeak) lPeak = absL;
        if (absR > rPeak) rPeak = absR;
        lSumSq += l * l;
        rSumSq += r * r;

        const mono = (l + r) * 0.5;
        const limited = this._softLimit(mono);
        partyBuf[i] = Math.max(-32768, Math.min(32767, (limited * 32767) | 0));
      }
      this.sendPcmPacket(targetPlayTime, this.sequence, 255, partyBuf, numSamples);
      this.audioLevels.channelEnergy[255] = Math.min(1.0, Math.sqrt((lSumSq + rSumSq) / (numSamples * 2)) * 1.4);
    } else {
      const active = this.activeChannels;
      const needFL = !active || active.has(1);
      const needFR = !active || active.has(2);
      const needC  = !active || active.has(3);
      const needSub = !active || active.has(4);
      const needSL = !active || active.has(5);
      const needSR = !active || active.has(6);

      const flBuf = this.pcmBuffers[1];
      const frBuf = this.pcmBuffers[2];
      const cBuf  = this.pcmBuffers[3];
      const subBuf = this.pcmBuffers[4];
      const slBuf = this.pcmBuffers[5];
      const srBuf = this.pcmBuffers[6];

      const hp = this._subHighpass;
      const lp = this._subLowpass;
      const ap = this._surroundAllpassState;
      const centerSubtract = needC ? 0.35 : 0;

      for (let i = 0; i < numSamples; i++) {
        const l = leftChannel[i];
        const r = rightChannel[i];
        const absL = Math.abs(l);
        const absR = Math.abs(r);
        if (absL > lPeak) lPeak = absL;
        if (absR > rPeak) rPeak = absR;
        lSumSq += l * l;
        rSumSq += r * r;

        if (needC || needFL || needFR) {
          const center = (l + r) * 0.55;
          if (needC)  cBuf[i]  = Math.max(-32768, Math.min(32767, (this._softLimit(center) * 32767) | 0));
          if (needFL) flBuf[i] = Math.max(-32768, Math.min(32767, (this._softLimit(l - center * centerSubtract) * 32767) | 0));
          if (needFR) frBuf[i] = Math.max(-32768, Math.min(32767, (this._softLimit(r - center * centerSubtract) * 32767) | 0));
        }

        if (needSL || needSR) {
          const diff = ((l - r) * 0.65) + ((l + r) * 0.15);
          const phaseShifted = ap.c * diff + ap.x1 - ap.c * ap.y1;
          ap.x1 = diff;
          ap.y1 = phaseShifted;

          const delayOut = this._surroundDelayBuf[this._surroundDelayIdx];
          this._surroundDelayBuf[this._surroundDelayIdx] = phaseShifted;
          this._surroundDelayIdx = (this._surroundDelayIdx + 1) % this._surroundDelaySize;

          if (needSL) slBuf[i] = Math.max(-32768, Math.min(32767, (this._softLimit(delayOut) * 32767) | 0));
          if (needSR) srBuf[i] = Math.max(-32768, Math.min(32767, (this._softLimit(-delayOut) * 32767) | 0));
        }

        if (needSub) {
          const monoSum = (l + r) * 0.5;
          const hOut = hp.b0 * monoSum + hp.b1 * hp.x1 + hp.b2 * hp.x2 - hp.a1 * hp.y1 - hp.a2 * hp.y2;
          hp.x2 = hp.x1; hp.x1 = monoSum;
          hp.y2 = hp.y1; hp.y1 = hOut;

          const lOut = lp.b0 * hOut + lp.b1 * lp.x1 + lp.b2 * lp.x2 - lp.a1 * lp.y1 - lp.a2 * lp.y2;
          lp.x2 = lp.x1; lp.x1 = hOut;
          lp.y2 = lp.y1; lp.y1 = lOut;

          subBuf[i] = Math.max(-32768, Math.min(32767, (this._softLimit(lOut * 1.2) * 32767) | 0));
        }
      }

      if (needFL)  this.sendPcmPacket(targetPlayTime, this.sequence, 1, flBuf, numSamples);
      if (needFR)  this.sendPcmPacket(targetPlayTime, this.sequence, 2, frBuf, numSamples);
      if (needC)   this.sendPcmPacket(targetPlayTime, this.sequence, 3, cBuf, numSamples);
      if (needSub) this.sendPcmPacket(targetPlayTime, this.sequence, 4, subBuf, numSamples);
      if (needSL)  this.sendPcmPacket(targetPlayTime, this.sequence, 5, slBuf, numSamples);
      if (needSR)  this.sendPcmPacket(targetPlayTime, this.sequence, 6, srBuf, numSamples);
    }

    const lRms = Math.sqrt(lSumSq / numSamples);
    const rRms = Math.sqrt(rSumSq / numSamples);
    this.audioLevels.leftRms = lRms;
    this.audioLevels.rightRms = rRms;
    this.audioLevels.leftPeak = lPeak;
    this.audioLevels.rightPeak = rPeak;
    this.audioLevels.energy = (lRms + rRms) * 0.5;
    if (!isParty) {
      this.audioLevels.channelEnergy[1] = Math.min(1.0, lRms * 1.4);
      this.audioLevels.channelEnergy[2] = Math.min(1.0, rRms * 1.4);
      this.audioLevels.channelEnergy[3] = Math.min(1.0, (lRms + rRms) * 0.7);
      this.audioLevels.channelEnergy[4] = Math.min(1.0, (lRms + rRms) * 0.7);
      this.audioLevels.channelEnergy[5] = Math.min(1.0, this.audioLevels.energy * 1.2);
      this.audioLevels.channelEnergy[6] = Math.min(1.0, this.audioLevels.energy * 1.2);
    }
  }

  /**
   * Sends binary audio frame directly over Peer-to-Peer WebRTC UDP DataChannels
   * (`ordered: false, maxRetransmits: 0`) for zero-HoL-blocking delivery, with
   * automatic WebSocket fallback for any receiver still completing ICE negotiation.
   */
  sendPcmPacket(targetPlayTime, seq, channelId, int16Samples, numSamples) {
    const headerSize = this.headerSize;
    const packetBuffer = this.packetBuffers[channelId];
    const packetView = this.packetViews[channelId];
    const packetBytes = this.packetBytes[channelId];

    let flags = 0;
    let payloadBytes;

    const useAdpcm = this._shouldUseAdpcm() && numSamples > 0 && (numSamples & 1) === 0;

    if (useAdpcm) {
      payloadBytes = AudioCodec.encodeImaAdpcm(int16Samples, packetBytes, headerSize, numSamples, channelId);
      flags |= 0x01;
    } else {
      payloadBytes = numSamples * 2;
      const srcBytes = new Uint8Array(int16Samples.buffer, int16Samples.byteOffset, payloadBytes);
      packetBytes.set(srcBytes, headerSize);
    }

    packetView.setFloat64(0, targetPlayTime, true);
    packetView.setUint16(8, seq, true);
    packetView.setUint8(10, channelId);
    packetView.setUint8(11, flags);
    packetView.setUint32(12, this.sampleRate, true);

    const frameSlice = packetBuffer.slice(0, headerSize + payloadBytes);

    // 1. Direct P2P WebRTC UDP transmission to all open peer data channels
    let openRtcPeers = 0;
    for (const peer of this.peerDataChannels.values()) {
      if (peer.dc && peer.dc.readyState === 'open') {
        openRtcPeers++;
        const chMatch = channelId === 255 ||
          peer.channelIndex === channelId ||
          (peer.channelIndex === -1 && (channelId === 1 || channelId === 2));
        if (chMatch && peer.dc.bufferedAmount < 16384) {
          try {
            peer.dc.send(frameSlice);
          } catch (e) {}
        }
      }
    }

    // 2. WebSocket fallback only when at least one connected receiver is not yet on P2P UDP
    if (openRtcPeers < this.connectedDeviceCount && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frameSlice);
    }
  }

  async playChannelTest(channelId, channelName) {
    await this.init();

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(channelName);
      utterance.rate = 1.0;
      utterance.pitch = 1.1;
      window.speechSynthesis.speak(utterance);
    }

    const osc = this.audioCtx.createOscillator();
    const oscGain = this.audioCtx.createGain();

    if (channelId === 4) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(95, this.audioCtx.currentTime);
    } else {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, this.audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, this.audioCtx.currentTime + 0.4);
    }

    oscGain.gain.setValueAtTime(0.5, this.audioCtx.currentTime);
    oscGain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.6);

    osc.connect(oscGain);
    oscGain.connect(this.masterGain);

    osc.start();
    osc.stop(this.audioCtx.currentTime + 0.6);

    this.streamChannelTestTone(channelId);
  }

  streamChannelTestTone(channelId) {
    const wireChannel = this.currentMode === 'PARTY' ? 255 : channelId;
    if (!this.packetBuffers[wireChannel]) return;

    if (typeof AudioCodec !== 'undefined' && AudioCodec.resetState) {
      AudioCodec.resetState(wireChannel);
    }

    const duration = 0.6;
    const freq = channelId === 4 ? 95 : 660;
    const totalSamples = Math.floor(this.sampleRate * duration) & ~1;
    const buf = this.testBuffer;
    const baseMaster = this.ntpSync ? this.ntpSync.now() : Date.now();
    let sent = 0;
    let seq = (this.sequence + 1) & 0xffff;

    while (sent < totalSamples) {
      const count = Math.min(384, totalSamples - sent);
      for (let i = 0; i < count; i++) {
        const t = (sent + i) / this.sampleRate;
        const fadeIn = Math.min(1, t / 0.02);
        const fadeOut = Math.min(1, (duration - t) / 0.05);
        const env = Math.max(0, Math.min(fadeIn, fadeOut));
        const sample = Math.sin(2 * Math.PI * freq * t) * 0.5 * env;
        buf[i] = Math.max(-32768, Math.min(32767, (sample * 32767) | 0));
      }

      const targetPlayTime = baseMaster + this.broadcastDelayMs + ((sent / this.sampleRate) * 1000);
      this.sendPcmPacket(targetPlayTime, seq, wireChannel, buf, count);
      seq = (seq + 1) & 0xffff;
      sent += count;
    }
    this.sequence = seq;
  }

  async startDemoAudio(type = 'synthwave') {
    await this.init();
    this.stopCurrentSource();

    this.demoType = type;
    this.activeSourceType = 'demo';

    const demoGain = this.audioCtx.createGain();
    demoGain.gain.value = 0.85;

    this.sourceNode = demoGain;
    this.setupProcessingGraph();

    if (type === 'synthwave') {
      this._startSynthwaveLoop(demoGain);
    } else if (type === 'spatial-orbit') {
      this._startSpatialOrbitLoop(demoGain);
    } else if (type === 'sync-pulse') {
      this._startSyncPulseLoop(demoGain);
    }

    return true;
  }

  _startSynthwaveLoop(destination) {
    const ctx = this.audioCtx;
    const bpm = 124;
    const stepTime = (60 / bpm) / 4;
    let currentStep = 0;
    let nextStepTime = ctx.currentTime + 0.05;

    const chords = [
      { bass: 55.0,  chord: [220.0, 261.63, 329.63] },
      { bass: 43.65, chord: [174.61, 220.0, 261.63] },
      { bass: 65.41, chord: [196.0, 261.63, 329.63] },
      { bass: 49.0,  chord: [196.0, 246.94, 293.66] }
    ];

    const scheduleDrumAndSynth = () => {
      if (!this.isRunning || this.demoType !== 'synthwave') return;

      while (nextStepTime < ctx.currentTime + 0.25) {
        const step = currentStep % 64;
        const bar = Math.floor(step / 16) % 4;
        const beatStep = step % 16;
        const chordData = chords[bar];

        if (beatStep % 4 === 0) {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(140, nextStepTime);
          osc.frequency.exponentialRampToValueAtTime(48, nextStepTime + 0.14);
          g.gain.setValueAtTime(0.85, nextStepTime);
          g.gain.exponentialRampToValueAtTime(0.001, nextStepTime + 0.22);
          osc.connect(g);
          g.connect(destination);
          osc.start(nextStepTime);
          osc.stop(nextStepTime + 0.24);
        }

        if (beatStep === 4 || beatStep === 12) {
          const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.15), ctx.sampleRate);
          const noiseData = noiseBuf.getChannelData(0);
          for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.04));
          const noiseSrc = ctx.createBufferSource();
          noiseSrc.buffer = noiseBuf;

          const filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.value = 1800;
          filter.Q.value = 1.2;

          const nGain = ctx.createGain();
          nGain.gain.setValueAtTime(0.42, nextStepTime);
          nGain.gain.exponentialRampToValueAtTime(0.001, nextStepTime + 0.16);

          noiseSrc.connect(filter);
          filter.connect(nGain);
          nGain.connect(destination);
          noiseSrc.start(nextStepTime);

          const bodyOsc = ctx.createOscillator();
          const bodyGain = ctx.createGain();
          bodyOsc.type = 'triangle';
          bodyOsc.frequency.setValueAtTime(185, nextStepTime);
          bodyOsc.frequency.exponentialRampToValueAtTime(85, nextStepTime + 0.12);
          bodyGain.gain.setValueAtTime(0.32, nextStepTime);
          bodyGain.gain.exponentialRampToValueAtTime(0.001, nextStepTime + 0.14);
          bodyOsc.connect(bodyGain);
          bodyGain.connect(destination);
          bodyOsc.start(nextStepTime);
          bodyOsc.stop(nextStepTime + 0.15);
        }

        if (beatStep % 2 === 1) {
          const hatBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate);
          const hatData = hatBuf.getChannelData(0);
          for (let i = 0; i < hatData.length; i++) hatData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.012));
          const hatSrc = ctx.createBufferSource();
          hatSrc.buffer = hatBuf;
          const hatGain = ctx.createGain();
          hatGain.gain.value = beatStep % 4 === 2 ? 0.20 : 0.11;
          hatSrc.connect(hatGain);
          hatGain.connect(destination);
          hatSrc.start(nextStepTime);
        }

        const bassOsc = ctx.createOscillator();
        const bassGain = ctx.createGain();
        const bassFilter = ctx.createBiquadFilter();

        bassOsc.type = 'sawtooth';
        const bassFreq = chordData.bass * 2;
        bassOsc.frequency.setValueAtTime(bassFreq, nextStepTime);

        bassFilter.type = 'lowpass';
        bassFilter.frequency.setValueAtTime(900, nextStepTime);
        bassFilter.frequency.exponentialRampToValueAtTime(160, nextStepTime + stepTime * 0.85);
        bassFilter.Q.value = 3.0;

        bassGain.gain.setValueAtTime(0.36, nextStepTime);
        bassGain.gain.exponentialRampToValueAtTime(0.001, nextStepTime + stepTime * 0.95);

        bassOsc.connect(bassFilter);
        bassFilter.connect(bassGain);
        bassGain.connect(destination);

        bassOsc.start(nextStepTime);
        bassOsc.stop(nextStepTime + stepTime);

        if (beatStep === 0) {
          chordData.chord.forEach((freq, idx) => {
            const padOsc = ctx.createOscillator();
            const padGain = ctx.createGain();
            padOsc.type = 'sawtooth';
            padOsc.frequency.value = freq * (idx === 1 ? 1.003 : 0.997);

            const padFilter = ctx.createBiquadFilter();
            padFilter.type = 'lowpass';
            padFilter.frequency.setValueAtTime(800, nextStepTime);
            padFilter.frequency.linearRampToValueAtTime(2200, nextStepTime + 0.8);
            padFilter.frequency.linearRampToValueAtTime(600, nextStepTime + stepTime * 15);

            padGain.gain.setValueAtTime(0.11, nextStepTime);
            padGain.gain.exponentialRampToValueAtTime(0.001, nextStepTime + stepTime * 15.5);

            padOsc.connect(padFilter);
            padFilter.connect(padGain);
            padGain.connect(destination);

            padOsc.start(nextStepTime);
            padOsc.stop(nextStepTime + stepTime * 16);
          });
        }

        currentStep++;
        nextStepTime += stepTime;
      }
    };

    this.demoTimer = setInterval(scheduleDrumAndSynth, 60);
    scheduleDrumAndSynth();
  }

  _startSpatialOrbitLoop(destination) {
    const ctx = this.audioCtx;
    let orbitStep = 0;

    const channelNames = [
      'Front Left',
      'Center',
      'Front Right',
      'Surround Right',
      'Surround Left',
      'Subwoofer'
    ];

    const merger = ctx.createChannelMerger(2);
    merger.connect(destination);

    const orbitTick = () => {
      if (!this.isRunning || this.demoType !== 'spatial-orbit') return;

      const chIdx = orbitStep % 6;
      const chName = channelNames[chIdx];
      const now = ctx.currentTime;

      if ('speechSynthesis' in window && !window.speechSynthesis.speaking) {
        const u = new SpeechSynthesisUtterance(chName);
        u.rate = 1.1;
        window.speechSynthesis.speak(u);
      }

      const oscL = ctx.createOscillator();
      const oscR = ctx.createOscillator();
      const gL = ctx.createGain();
      const gR = ctx.createGain();

      oscL.type = 'triangle';
      oscR.type = 'triangle';

      if (chIdx === 5) {
        oscL.type = 'sine';
        oscR.type = 'sine';
        oscL.frequency.setValueAtTime(130, now);
        oscL.frequency.exponentialRampToValueAtTime(75, now + 1.6);
        oscR.frequency.setValueAtTime(130, now);
        oscR.frequency.exponentialRampToValueAtTime(75, now + 1.6);
      } else {
        const baseFreq = 440 + chIdx * 65;
        oscL.frequency.setValueAtTime(baseFreq, now);
        oscL.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, now + 0.4);
        oscR.frequency.setValueAtTime(baseFreq, now);
        oscR.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, now + 0.4);
      }

      let leftGain = 0;
      let rightGain = 0;

      switch (chIdx) {
        case 0: leftGain = 0.8; rightGain = 0.05; break;
        case 1: leftGain = 0.6; rightGain = 0.6; break;
        case 2: leftGain = 0.05; rightGain = 0.8; break;
        case 3: leftGain = -0.5; rightGain = 0.7; break;
        case 4: leftGain = 0.7; rightGain = -0.5; break;
        case 5: leftGain = 0.7; rightGain = 0.7; break;
      }

      gL.gain.setValueAtTime(leftGain, now);
      gL.gain.exponentialRampToValueAtTime(0.001, now + 1.7);
      gR.gain.setValueAtTime(rightGain, now);
      gR.gain.exponentialRampToValueAtTime(0.001, now + 1.7);

      oscL.connect(gL);
      oscR.connect(gR);

      gL.connect(merger, 0, 0);
      gR.connect(merger, 0, 1);

      oscL.start(now);
      oscR.start(now);
      oscL.stop(now + 1.8);
      oscR.stop(now + 1.8);

      orbitStep++;
    };

    orbitTick();
    this.demoTimer = setInterval(orbitTick, 2000);
  }

  _startSyncPulseLoop(destination) {
    const ctx = this.audioCtx;

    const pulseTick = () => {
      if (!this.isRunning || this.demoType !== 'sync-pulse') return;

      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1400, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.015);

      g.gain.setValueAtTime(0.8, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

      osc.connect(g);
      g.connect(destination);

      osc.start(now);
      osc.stop(now + 0.04);

      const subOsc = ctx.createOscillator();
      const subGain = ctx.createGain();
      subOsc.type = 'sine';
      subOsc.frequency.setValueAtTime(120, now);
      subOsc.frequency.exponentialRampToValueAtTime(70, now + 0.04);

      subGain.gain.setValueAtTime(0.6, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

      subOsc.connect(subGain);
      subGain.connect(destination);

      subOsc.start(now);
      subOsc.stop(now + 0.065);
    };

    pulseTick();
    this.demoTimer = setInterval(pulseTick, 500);
  }

  stopCurrentSource() {
    this.isRunning = false;
    this.resetStreamAnchor();

    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    this.demoType = 'none';

    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {}
    }

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => {
        t.onended = null;
        t.stop();
      });
      this.mediaStream = null;
    }
    if (this.audioElement) {
      this.audioElement.onended = null;
      this.audioElement.pause();
      this.audioElement.src = '';
      this.audioElement = null;
    }
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    this.currentFileName = '';
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this.activeSourceType = 'none';
  }
}

window.HostAudioEngine = HostAudioEngine;
