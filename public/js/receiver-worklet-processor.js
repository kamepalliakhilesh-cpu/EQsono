/**
 * SonoraReceiverProcessor - NetEQ-Inspired Adaptive Jitter Buffer & Continuous Ring Buffer
 * Measures real-time inter-packet arrival jitter (σ) to dynamically size the target buffer
 * down to 20ms on clean UDP WebRTC / 5GHz / USB links, starts playing after 16ms pre-roll,
 * and uses 4-point Hermite cubic fractional interpolation with a smooth PI PLL.
 */
class SonoraReceiverProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.RING_SIZE = 131072;
    this.RING_MASK = this.RING_SIZE - 1;
    this.ring = new Float32Array(this.RING_SIZE);

    this.writeSamples = 0;
    this.readSamples = 0;
    this.isPlaying = false;

    this.streamSampleRate = sampleRate;
    this.lastSeq = null;
    this.latestEndPlayTimeMs = 0;
    this.latestWriteAnchor = 0;

    // Adaptive Jitter Estimator (RFC 3550 / NetEQ style)
    this.lastArrivalTimeSec = null;
    this.jitterMs = 4.0; // Smoothed inter-arrival jitter in ms

    // Clock & calibration parameters
    this.ntpOffsetMs = 0;
    this.ntpSynced = false;
    this.perSpeakerDelayMs = 0;
    this.outputLatencyMs = 0;
    this.contextBaseEpochMs = Date.now() - (currentTime * 1000);

    // PLL & crossfade state
    this.smoothedErrorMs = 0;
    this.driftIntegral = 0;
    this.lastOutSample = 0;
    this.fadeRemaining = 0;
    this.fadeTotal = 96;
    this.fadeStartSample = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'PACKET') {
        this.ingestPacket(msg.samples, msg.numSamples, msg.targetPlayTime, msg.seq, msg.sampleRate);
      } else if (msg.type === 'SYNC_CONFIG') {
        if (Number.isFinite(msg.ntpOffsetMs)) this.ntpOffsetMs = msg.ntpOffsetMs;
        if (typeof msg.ntpSynced === 'boolean') this.ntpSynced = msg.ntpSynced;
        if (Number.isFinite(msg.perSpeakerDelayMs)) this.perSpeakerDelayMs = msg.perSpeakerDelayMs;
        if (Number.isFinite(msg.outputLatencyMs)) this.outputLatencyMs = msg.outputLatencyMs;
        if (Number.isFinite(msg.contextBaseEpochMs)) this.contextBaseEpochMs = msg.contextBaseEpochMs;
      } else if (msg.type === 'RESET') {
        this.resetStream();
      }
    };
  }

  resetStream() {
    this.writeSamples = 0;
    this.readSamples = 0;
    this.isPlaying = false;
    this.lastSeq = null;
    this.lastArrivalTimeSec = null;
    this.smoothedErrorMs = 0;
    this.driftIntegral = 0;
    this.fadeStartSample = this.lastOutSample;
    this.fadeRemaining = this.fadeTotal;
  }

  ingestPacket(samples, numSamples, targetPlayTimeMs, seq, pktSampleRate) {
    if (!samples || numSamples <= 0) return;

    if (pktSampleRate && pktSampleRate !== this.streamSampleRate) {
      this.streamSampleRate = pktSampleRate;
      this.resetStream();
    }

    const nominalFrameMs = (numSamples / this.streamSampleRate) * 1000;
    if (this.lastArrivalTimeSec !== null) {
      const arrivalDeltaMs = (currentTime - this.lastArrivalTimeSec) * 1000;
      const instJitter = Math.abs(arrivalDeltaMs - nominalFrameMs);
      if (instJitter < 120) {
        this.jitterMs = (this.jitterMs * 0.92) + (instJitter * 0.08);
      }
    }
    this.lastArrivalTimeSec = currentTime;

    if (this.lastSeq !== null) {
      const seqDelta = (seq - this.lastSeq) & 0xffff;
      if (seqDelta === 0 || seqDelta > 60000) {
        return; // Ignore duplicate or late out-of-order UDP/WS frame
      }
      if (seqDelta > 1 && seqDelta <= 4) {
        // Packet Loss Concealment (PLC): bridge 1-3 lost UDP frames smoothly
        const missingPackets = seqDelta - 1;
        const missingSamples = missingPackets * numSamples;
        const prevIdx = (this.writeSamples - 1) & this.RING_MASK;
        const baseVal = this.writeSamples > 0 ? this.ring[prevIdx] : 0;
        for (let m = 0; m < missingSamples; m++) {
          const decay = Math.exp(-m / (numSamples * 0.45));
          this.ring[(this.writeSamples + m) & this.RING_MASK] = baseVal * decay;
        }
        this.writeSamples += missingSamples;
      } else if (seqDelta > 4) {
        this.resetStream();
      }
    }

    this.lastSeq = seq;

    for (let i = 0; i < numSamples; i++) {
      this.ring[(this.writeSamples + i) & this.RING_MASK] = samples[i];
    }
    this.writeSamples += numSamples;
    this.latestWriteAnchor = this.writeSamples;
    this.latestEndPlayTimeMs = targetPlayTimeMs + nominalFrameMs;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outCh = output[0];
    const len = outCh.length;

    const ratio = this.streamSampleRate / sampleRate;
    // Ultra-fast 16ms pre-roll (2 frames of 384 samples)
    const minPreRollSamples = Math.floor(this.streamSampleRate * 0.016);
    // Adaptive target buffer: 20ms base + 1.8x measured jitter (clamped to 20ms..65ms) + user speaker delay
    const adaptiveCushionMs = Math.max(20, Math.min(65, 20 + (this.jitterMs * 1.8))) + this.perSpeakerDelayMs;
    const desiredBufferedSamples = Math.floor((adaptiveCushionMs / 1000) * this.streamSampleRate);

    if (!this.isPlaying) {
      if (this.writeSamples < minPreRollSamples) {
        outCh.fill(0);
        this.lastOutSample = 0;
        return true;
      }
      const startOffset = Math.min(this.writeSamples - 1, Math.max(minPreRollSamples, desiredBufferedSamples));
      this.readSamples = Math.max(1, this.writeSamples - startOffset);
      this.isPlaying = true;
      this.smoothedErrorMs = 0;
      this.driftIntegral = 0;
      this.fadeStartSample = this.lastOutSample;
      this.fadeRemaining = this.fadeTotal;
    }

    const availableSamples = this.writeSamples - this.readSamples;
    if (availableSamples < len * ratio + 4) {
      for (let i = 0; i < len; i++) {
        this.lastOutSample *= 0.88;
        outCh[i] = this.lastOutSample;
      }
      this.isPlaying = false;
      return true;
    }

    const rawErrorSamples = availableSamples - desiredBufferedSamples;
    const rawErrorMs = (rawErrorSamples / this.streamSampleRate) * 1000;
    this.smoothedErrorMs = (this.smoothedErrorMs * 0.85) + (rawErrorMs * 0.15);

    // Tight anti-lag clamp: if buffer ever exceeds adaptive target by >38ms, skip ahead immediately with crossfade
    if (this.smoothedErrorMs > 38 || this.smoothedErrorMs < -30) {
      this.readSamples = Math.max(1, this.writeSamples - desiredBufferedSamples);
      this.smoothedErrorMs = 0;
      this.driftIntegral = 0;
      this.fadeStartSample = this.lastOutSample;
      this.fadeRemaining = this.fadeTotal;
    }

    // Smooth PI controller within ±0.5% range
    let rateAdj = 0;
    if (Math.abs(this.smoothedErrorMs) > 0.5) {
      this.driftIntegral = Math.max(-0.0015, Math.min(0.0015, this.driftIntegral + this.smoothedErrorMs * 0.0000015));
      rateAdj = (this.smoothedErrorMs * 0.00022) + this.driftIntegral;
      rateAdj = Math.max(-0.005, Math.min(0.005, rateAdj));
    }

    const step = ratio * (1.0 + rateAdj);
    const ring = this.ring;
    const mask = this.RING_MASK;
    let rPos = this.readSamples;

    for (let i = 0; i < len; i++) {
      const idx = rPos | 0;
      const frac = rPos - idx;

      const s0 = ring[(idx - 1) & mask];
      const s1 = ring[idx & mask];
      const s2 = ring[(idx + 1) & mask];
      const s3 = ring[(idx + 2) & mask];

      const c0 = s1;
      const c1 = 0.5 * (s2 - s0);
      const c2 = s0 - 2.5 * s1 + 2.0 * s2 - 0.5 * s3;
      const c3 = 0.5 * (s3 - s0) + 1.5 * (s1 - s2);
      let sample = ((c3 * frac + c2) * frac + c1) * frac + c0;

      if (this.fadeRemaining > 0) {
        const alpha = 1.0 - (this.fadeRemaining / this.fadeTotal);
        const w = 0.5 * (1.0 - Math.cos(Math.PI * alpha));
        sample = (this.fadeStartSample * (1.0 - w)) + (sample * w);
        this.fadeRemaining--;
      }

      outCh[i] = sample;
      this.lastOutSample = sample;
      rPos += step;
    }

    this.readSamples = rPos;
    return true;
  }
}

registerProcessor('sonora-receiver-processor', SonoraReceiverProcessor);
