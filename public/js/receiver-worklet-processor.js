/**
 * SonoraReceiverProcessor - NetEQ-Inspired Adaptive Jitter Buffer & Continuous Ring Buffer
 * Dynamically measures transit-time arrival jitter (RFC 3550) to adapt buffer depth (45ms - 240ms),
 * performs pitch-synchronous waveform packet loss concealment (PLC) with overlap-add (OLA),
 * and uses 4-point Hermite cubic fractional interpolation with smooth PI PLL clock tracking.
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
    this.isStarved = false;

    this.streamSampleRate = sampleRate;
    this.lastSeq = null;
    this.lastSenderTimeMs = null;
    this.lastArrivalSec = null;
    this.latestEndPlayTimeMs = 0;
    this.latestWriteAnchor = 0;

    // Adaptive Jitter Estimator (RFC 3550 transit-time difference)
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
    this.fadeTotal = 480; // 10ms smooth crossfade at 48kHz
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
    this.isStarved = false;
    this.lastSeq = null;
    this.lastSenderTimeMs = null;
    this.lastArrivalSec = null;
    this.smoothedErrorMs = 0;
    this.driftIntegral = 0;
    this.fadeStartSample = this.lastOutSample;
    this.fadeRemaining = this.fadeTotal;
  }

  // Fast autocorrelation pitch estimator for smooth periodic waveform repetition
  findPitchLag(maxLag = 400, minLag = 36) {
    if (this.writeSamples < maxLag + minLag) return 0;
    const mask = this.RING_MASK;
    const anchor = this.writeSamples;
    let bestLag = 0;
    let maxCorr = -1;

    const corrLen = 192;
    for (let lag = minLag; lag <= maxLag; lag += 2) {
      let corr = 0;
      let energy = 0;
      for (let i = 0; i < corrLen; i += 2) {
        const s1 = this.ring[(anchor - 1 - i) & mask];
        const s2 = this.ring[(anchor - 1 - i - lag) & mask];
        corr += s1 * s2;
        energy += s2 * s2;
      }
      const normCorr = energy > 0.001 ? corr / Math.sqrt(energy) : 0;
      if (normCorr > maxCorr) {
        maxCorr = normCorr;
        bestLag = lag;
      }
    }
    return maxCorr > 0.4 ? bestLag : 0;
  }

  ingestPacket(samples, numSamples, targetPlayTimeMs, seq, pktSampleRate) {
    if (!samples || numSamples <= 0) return;

    if (pktSampleRate && pktSampleRate !== this.streamSampleRate) {
      this.streamSampleRate = pktSampleRate;
      this.resetStream();
    }

    const nowSec = currentTime;
    const nominalFrameMs = (numSamples / this.streamSampleRate) * 1000;

    // RFC 3550 transit-time jitter calculation
    if (this.lastArrivalSec !== null && this.lastSenderTimeMs !== null) {
      const arrivalDeltaMs = (nowSec - this.lastArrivalSec) * 1000;
      const sendDeltaMs = targetPlayTimeMs - this.lastSenderTimeMs;
      const transitDelta = arrivalDeltaMs - sendDeltaMs;
      const instJitter = Math.min(300, Math.abs(transitDelta));
      // Fast attack on jitter spikes to protect buffer; slow decay when stable
      if (instJitter > this.jitterMs) {
        this.jitterMs = (this.jitterMs * 0.65) + (instJitter * 0.35);
      } else {
        this.jitterMs = (this.jitterMs * 0.985) + (instJitter * 0.015);
      }
    }
    this.lastArrivalSec = nowSec;
    this.lastSenderTimeMs = targetPlayTimeMs;

    if (this.lastSeq !== null) {
      const seqDelta = (seq - this.lastSeq) & 0xffff;
      if (seqDelta === 0 || seqDelta > 60000) {
        return; // Stale, duplicate, or very late out-of-order UDP/WS frame
      }

      if (seqDelta > 1 && seqDelta <= 16) {
        // High-Quality Waveform Pitch-Synchronous Packet Loss Concealment (PLC)
        const missingPackets = seqDelta - 1;
        const missingSamples = missingPackets * numSamples;
        const mask = this.RING_MASK;

        let pitchPeriod = this.findPitchLag(Math.min(480, numSamples * 2), 32);
        if (pitchPeriod <= 0) pitchPeriod = numSamples;

        const lastSample = this.writeSamples > 0 ? this.ring[(this.writeSamples - 1) & mask] : 0;
        const olaInLen = Math.min(32, missingSamples);

        for (let m = 0; m < missingSamples; m++) {
          const srcIdx = (this.writeSamples - pitchPeriod + (m % pitchPeriod)) & mask;
          let wave = this.ring[srcIdx];

          // Boundary crossfade at beginning of concealment (smooth phase transition)
          if (m < olaInLen) {
            const w = 0.5 * (1.0 - Math.cos((Math.PI * (m + 1)) / olaInLen));
            wave = (lastSample * (1.0 - w)) + (wave * w);
          }

          // Gentle exponential decay over missing duration
          const decay = Math.exp(-m / (numSamples * 2.0));
          this.ring[(this.writeSamples + m) & mask] = wave * decay;
        }
        this.writeSamples += missingSamples;
      } else if (seqDelta > 16 && seqDelta <= 250) {
        // Prolonged Wi-Fi dropout (120ms - 2000ms): advance timeline cleanly with silence
        const missingSamples = (seqDelta - 1) * numSamples;
        const mask = this.RING_MASK;
        for (let m = 0; m < missingSamples; m++) {
          this.ring[(this.writeSamples + m) & mask] = 0;
        }
        this.writeSamples += missingSamples;
      } else if (seqDelta > 250) {
        this.resetStream();
      }
    }

    // Overlap-Add crossfade between concealment tail and incoming new packet
    const isPostLoss = (this.lastSeq !== null && ((seq - this.lastSeq) & 0xffff) > 1);
    const olaLen = Math.min(48, numSamples);
    const mask = this.RING_MASK;
    const lastConcealedSample = isPostLoss ? this.ring[(this.writeSamples - 1) & mask] : 0;

    for (let i = 0; i < numSamples; i++) {
      let s = samples[i];
      if (isPostLoss && i < olaLen) {
        const w = 0.5 * (1.0 - Math.cos((Math.PI * (i + 1)) / olaLen));
        s = (lastConcealedSample * (1.0 - w)) + (s * w);
      }
      this.ring[(this.writeSamples + i) & mask] = s;
    }
    this.writeSamples += numSamples;
    this.lastSeq = seq;
    this.latestWriteAnchor = this.writeSamples;
    this.latestEndPlayTimeMs = targetPlayTimeMs + nominalFrameMs;

    // If stream was paused due to starvation, check if we've accumulated enough buffer to resume
    if (this.isStarved) {
      const available = this.writeSamples - this.readSamples;
      const minResumeSamples = Math.floor(this.streamSampleRate * 0.050); // 50ms cushion to resume
      if (available >= minResumeSamples) {
        this.isStarved = false;
        this.isPlaying = true;
        this.fadeStartSample = 0;
        this.fadeRemaining = this.fadeTotal;
      }
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outCh = output[0];
    const len = outCh.length;

    const ratio = this.streamSampleRate / sampleRate;
    // Adaptive target buffer based on real measured jitter (45ms base up to 240ms on unstable Wi-Fi)
    const adaptiveCushionMs = Math.max(45, Math.min(240, 45 + (this.jitterMs * 2.0))) + this.perSpeakerDelayMs;
    const desiredBufferedSamples = Math.floor((adaptiveCushionMs / 1000) * this.streamSampleRate);

    if (!this.isPlaying) {
      const available = this.writeSamples - this.readSamples;
      if (available < desiredBufferedSamples) {
        outCh.fill(0);
        this.lastOutSample = 0;
        return true;
      }
      this.readSamples = Math.max(1, this.writeSamples - desiredBufferedSamples);
      this.isPlaying = true;
      this.isStarved = false;
      this.smoothedErrorMs = 0;
      this.driftIntegral = 0;
      this.fadeStartSample = 0;
      this.fadeRemaining = this.fadeTotal;
    }

    const availableSamples = this.writeSamples - this.readSamples;

    // Buffer starvation / underrun protection
    if (availableSamples < len * ratio + 4) {
      this.isStarved = true;
      for (let i = 0; i < len; i++) {
        this.lastOutSample *= 0.88;
        outCh[i] = this.lastOutSample;
      }
      return true;
    }

    const rawErrorSamples = availableSamples - desiredBufferedSamples;
    const rawErrorMs = (rawErrorSamples / this.streamSampleRate) * 1000;
    this.smoothedErrorMs = (this.smoothedErrorMs * 0.90) + (rawErrorMs * 0.10);

    // Resampling adjustment up to ±1.8% to smoothly eliminate lag without hard jumps
    let rateAdj = 0;
    if (Math.abs(this.smoothedErrorMs) > 1.0) {
      this.driftIntegral = Math.max(-0.005, Math.min(0.005, this.driftIntegral + this.smoothedErrorMs * 0.000003));
      rateAdj = (this.smoothedErrorMs * 0.00035) + this.driftIntegral;
      rateAdj = Math.max(-0.018, Math.min(0.018, rateAdj));
    }

    // Hard-clamp only on extreme network shifts (>240ms or <-100ms)
    if (this.smoothedErrorMs > 240 || this.smoothedErrorMs < -100) {
      this.readSamples = Math.max(1, this.writeSamples - desiredBufferedSamples);
      this.smoothedErrorMs = 0;
      this.driftIntegral = 0;
      this.fadeStartSample = this.lastOutSample;
      this.fadeRemaining = this.fadeTotal;
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

      // 4-Point Hermite cubic interpolation
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
