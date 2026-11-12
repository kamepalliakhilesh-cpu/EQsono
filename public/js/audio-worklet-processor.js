/**
 * AudioWorkletProcessor for low-latency, off-main-thread stereo frame capture.
 * Accumulates 128-sample Web Audio quanta into 1024-sample (~21ms @ 48kHz) packets.
 */
class SonoraCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 1024;
    this.leftBuf = new Float32Array(this.chunkSize);
    this.rightBuf = new Float32Array(this.chunkSize);
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
    while (offset < inLeft.length) {
      if (this.writeIndex === 0) {
        this.chunkStartTime = currentTime + (offset / sampleRate);
      }

      const toCopy = Math.min(this.chunkSize - this.writeIndex, inLeft.length - offset);
      this.leftBuf.set(inLeft.subarray(offset, offset + toCopy), this.writeIndex);
      this.rightBuf.set(inRight.subarray(offset, offset + toCopy), this.writeIndex);
      this.writeIndex += toCopy;
      offset += toCopy;

      if (this.writeIndex >= this.chunkSize) {
        const outL = this.leftBuf;
        const outR = this.rightBuf;
        this.port.postMessage(
          {
            left: outL,
            right: outR,
            audioTime: this.chunkStartTime
          },
          [outL.buffer, outR.buffer]
        );
        this.leftBuf = new Float32Array(this.chunkSize);
        this.rightBuf = new Float32Array(this.chunkSize);
        this.writeIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('sonora-capture-processor', SonoraCaptureProcessor);
