/**
 * AudioWorkletProcessor for ultra-low-latency, off-main-thread stereo frame capture.
 * Accumulates 3 x 128-sample Web Audio quanta into 384-sample (8.0ms @ 48kHz) frames.
 * A 384-sample packet is 784 bytes in 16-bit PCM (or 212 bytes in 4:1 ADPCM), fitting
 * cleanly inside a single WebRTC SCTP/UDP datagram (<1,200 bytes) with zero fragmentation.
 */
class SonoraCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 384; // Exact 3 * 128 Web Audio render quanta (8.0ms @ 48kHz)
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
