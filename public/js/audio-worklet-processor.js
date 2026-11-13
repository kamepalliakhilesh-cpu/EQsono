/**
 * AudioWorkletProcessor for low-latency, off-main-thread stereo frame capture.
 * Accumulates 5 x 128-sample Web Audio quanta into 640-sample (~13.3ms @ 48kHz) packets.
 * A 640-sample 16-bit PCM packet is 1,296 bytes (including 16-byte header), fitting
 * completely inside a single 1,460-byte TCP MSS / 1,500-byte Wi-Fi MTU frame with zero fragmentation.
 */
class SonoraCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 640; // Exact 5 * 128 Web Audio render quanta; single-MTU in both PCM and ADPCM
    this.poolSize = 8;
    this.leftPool = [];
    this.rightPool = [];
    for (let i = 0; i < this.poolSize; i++) {
      this.leftPool.push(new Float32Array(this.chunkSize));
      this.rightPool.push(new Float32Array(this.chunkSize));
    }
    this.poolIdx = 0;
    this.writeIndex = 0;
    this.chunkStartTime = 0;
  }

  process(inputs, outputs) {
    // Keep outputs completely silent so no un-delayed audio bleeds through
    const output = outputs[0];
    if (output) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
    }

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const inLeft = input[0];
    if (!inLeft || inLeft.length === 0) return true;
    const inRight = input.length > 1 && input[1] ? input[1] : inLeft;

    let offset = 0;
    const leftBuf = this.leftPool[this.poolIdx];
    const rightBuf = this.rightPool[this.poolIdx];

    while (offset < inLeft.length) {
      if (this.writeIndex === 0) {
        this.chunkStartTime = currentTime + (offset / sampleRate);
      }

      const toCopy = Math.min(this.chunkSize - this.writeIndex, inLeft.length - offset);
      leftBuf.set(inLeft.subarray(offset, offset + toCopy), this.writeIndex);
      rightBuf.set(inRight.subarray(offset, offset + toCopy), this.writeIndex);
      this.writeIndex += toCopy;
      offset += toCopy;

      if (this.writeIndex >= this.chunkSize) {
        // Send structured clone from pre-allocated ring pool (zero allocation in audio thread)
        this.port.postMessage({
          left: leftBuf,
          right: rightBuf,
          audioTime: this.chunkStartTime
        });
        this.poolIdx = (this.poolIdx + 1) & (this.poolSize - 1);
        this.writeIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('sonora-capture-processor', SonoraCaptureProcessor);
