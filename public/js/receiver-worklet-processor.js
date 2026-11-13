/**
 * SonoraReceiverProcessor - Dedicated Off-Main-Thread Continuous Ring Buffer AudioWorklet
 * Eliminates per-packet AudioBufferSourceNode creation, boundary clicks, and main-thread jitter.
 * Uses a 131,072-sample circular buffer (~2.73s @ 48kHz) with 4-point Hermite cubic fractional
 * interpolation and a smooth Proportional-Integral Phase-Locked Loop (PLL) for sub-millisecond
 * multi-device synchronization.
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

    // Clock & calibration parameters updated from main thread
    this.ntpOffsetMs = 0;
    this.perSpeakerDelayMs = 0;
    this.outputLatencyMs = 0;
    this.timeOriginMs = 0;
    this.contextStartPerfMs = 0;

    // PLL & crossfade state
    this.smoothedErrorMs = 0;
    this.driftIntegral = 0;
    this.lastOutSample = 0;
    this.fadeRemaining = 0;
    this.fadeTotal = 128;
    this.fadeStartSample = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'PACKET') {
        this.ingestPacket(msg.samples, msg.numSamples, msg.targetPlayTime, msg.seq, msg.sampleRate);
      } else if (msg.type === 'SYNC_CONFIG') {
        if (Number.isFinite(msg.ntpOffsetMs)) this.ntpOffsetMs = msg.ntpOffsetMs;
        if (Number.isFinite(msg.perSpeakerDelayMs)) this.perSpeakerDelayMs = msg.perSpeakerDelayMs;
        if (Number.isFinite(msg.outputLatencyMs)) this.outputLatencyMs = msg.outputLatencyMs;
        if (Number.isFinite(msg.contextBaseEpochMs)) this.contextBaseEpochMs = msg.contextBaseEpochMs;
      } else if (msg.type === 'RESET') {
        this.resetStream();
      }
    };
    this.contextBaseEpochMs = Date.now() - (currentTime * 1000);
  }

  resetStream() {
    this.writeSamples = 0;
    this.readSamples = 0;
    this.isPlaying = false;
    this.lastSeq = null;
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

    if (this.lastSeq !== null) {
      const seqDelta = (seq - this.lastSeq) & 0xffff;
      if (seqDelta === 0 || seqDelta > 60000) {
        return; // Ignore duplicate or late out-of-order frame
      }
      if (seqDelta > 1 && seqDelta <= 5) {
        // Packet Loss Concealment (PLC): fill missing frames with damped continuation
        const missingPackets = seqDelta - 1;
        const missingSamples = missingPackets * numSamples;
        const prevIdx = (this.writeSamples - 1) & this.RING_MASK;
        const baseVal = this.writeSamples > 0 ? this.ring[prevIdx] : 0;
        for (let m = 0; m < missingSamples; m++) {
          const decay = Math.exp(-m / (numSamples * 0.5));
          this.ring[(this.writeSamples + m) & this.RING_MASK] = baseVal * decay;
        }
        this.writeSamples += missingSamples;
      } else if (seqDelta > 5) {
        this.resetStream();
      }
    }

    this.lastSeq = seq;

    // Prevent ring overflow if reader stalled
    if (this.writeSamples - this.readSamples > this.RING_SIZE - numSamples - 2048) {
      this.readSamples = this.writeSamples - Math.floor(this.streamSampleRate * 0.18);
      this.smoothedErrorMs = 0;
      this.driftIntegral = 0;
    }

    for (let i = 0; i < numSamples; i++) {
      this.ring[(this.writeSamples + i) & this.RING_MASK] = samples[i];
    }
    this.writeSamples += numSamples;
    this.latestWriteAnchor = this.writeSamples;
    this.latestEndPlayTimeMs = targetPlayTimeMs + ((numSamples / this.streamSampleRate) * 1000);
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outCh = output[0];
    const len = outCh.length;

    const available = this.writeSamples - this.readSamples;
    const ratio = this.streamSampleRate / sampleRate;
    const minPreRollSamples = Math.floor(this.streamSampleRate * 0.045); // 45ms minimum jitter cushion

    // Current synchronized master clock in epoch ms
    const nowLocalMs = this.contextBaseEpochMs + (currentTime * 1000);
    const nowMasterMs = nowLocalMs + this.ntpOffsetMs;
    const desiredPlayTimeMs = nowMasterMs + this.outputLatencyMs - this.perSpeakerDelayMs;

    const idealReadSamples = this.latestWriteAnchor -
      (((this.latestEndPlayTimeMs - desiredPlayTimeMs) / 1000) * this.streamSampleRate);

    if (!this.isPlaying) {
      if (this.writeSamples < minPreRollSamples || idealReadSamples < 0) {
        outCh.fill(0);
        this.lastOutSample = 0;
        return true;
      }
      const availableFromIdeal = this.writeSamples - idealReadSamples;
      if (availableFromIdeal < minPreRollSamples) {
        outCh.fill(0);
        this.lastOutSample = 0;
        return true;
      }
      this.readSamples = Math.max(1, idealReadSamples);
      this.isPlaying = true;
      this.smoothedErrorMs = 0;
      this.driftIntegral = 0;
      this.fadeStartSample = this.lastOutSample;
      this.fadeRemaining = this.fadeTotal;
    }

    if (this.writeSamples - this.readSamples < len * ratio + 4) {
      // Graceful underrun decay without harsh clicks
      for (let i = 0; i < len; i++) {
        this.lastOutSample *= 0.92;
        outCh[i] = this.lastOutSample;
      }
      this.isPlaying = false;
      return true;
    }

    const rawErrorSamples = idealReadSamples - this.readSamples;
    const rawErrorMs = (rawErrorSamples / this.streamSampleRate) * 1000;
    this.smoothedErrorMs = (this.smoothedErrorMs * 0.92) + (rawErrorMs * 0.08);

    // Hard resync with crossfade only if drift exceeds 120ms
    if (Math.abs(this.smoothedErrorMs) > 120) {
      const targetRead = Math.max(1, Math.min(this.writeSamples - minPreRollSamples, idealReadSamples));
      this.readSamples = targetRead;
      this.smoothedErrorMs = 0;
      this.driftIntegral = 0;
      this.fadeStartSample = this.lastOutSample;
      this.fadeRemaining = this.fadeTotal;
    }

    // Smooth PI controller within ±0.35% pitch-imperceptible range
    let rateAdj = 0;
    if (Math.abs(this.smoothedErrorMs) > 0.8) {
      this.driftIntegral = Math.max(-0.001, Math.min(0.001, this.driftIntegral + this.smoothedErrorMs * 0.0000005));
      rateAdj = (this.smoothedErrorMs * 0.00012) + this.driftIntegral;
      rateAdj = Math.max(-0.0035, Math.min(0.0035, rateAdj));
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

      // 4-point Hermite cubic interpolation for crystal-clear high-frequency fidelity
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
