/**
 * High-Performance Stateful IMA-ADPCM Audio Codec
 * Compresses 16-bit linear PCM down to 4 bits per sample (4:1 compression ratio).
 * Maintains continuous per-channel predictor state (valprev & step index) across
 * consecutive packets while embedding the exact starting predictor state in each
 * 4-byte packet header so lost packets never corrupt downstream decoding.
 */

(function (global) {
  const stepTable = new Int16Array([
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
    12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
  ]);

  const indexTable = new Int8Array([
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8
  ]);

  // Persistent per-channel encoder predictor state: channelId -> { valprev, index, initialized }
  const channelEncoderState = new Map();

  const AudioCodec = {
    resetState(channelId) {
      if (channelId === undefined) {
        channelEncoderState.clear();
      } else {
        channelEncoderState.delete(channelId);
      }
    },

    /**
     * Encodes 16-bit linear PCM into IMA-ADPCM bytes with stateful cross-frame continuity.
     * @param {Int16Array} samples - Input PCM samples.
     * @param {Uint8Array} outBytes - Pre-allocated output buffer.
     * @param {number} outOffset - Byte offset into outBytes to start writing.
     * @param {number} length - Sample count (must be even).
     * @param {number} channelId - Channel identifier for persistent predictor state.
     * @returns {number} Number of bytes written (4 bytes header + length / 2).
     */
    encodeImaAdpcm(samples, outBytes, outOffset = 0, length = samples.length, channelId = 255) {
      const len = Math.min(length, samples.length) & ~1;
      if (len <= 0) return 0;

      let state = channelEncoderState.get(channelId);
      if (!state || !state.initialized) {
        const initialVal = samples[0] || 0;
        // Estimate initial step index from the maximum sample-to-sample derivative in the first 16 samples
        let maxDelta = 0;
        const scanLen = Math.min(len, 16);
        for (let k = 1; k < scanLen; k++) {
          const d = Math.abs(samples[k] - samples[k - 1]);
          if (d > maxDelta) maxDelta = d;
        }
        let lo = 0;
        let hi = 88;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (stepTable[mid] < maxDelta) lo = mid + 1;
          else hi = mid;
        }
        state = {
          valprev: initialVal,
          index: Math.max(0, Math.min(88, lo)),
          initialized: true
        };
        channelEncoderState.set(channelId, state);
      }

      let statePrev = state.valprev;
      let index = state.index;

      // Write exact pre-loop predictor state into the 4-byte packet header so the receiver
      // starts decoding sample 0 from this exact state (self-healing on packet drops).
      const view = new DataView(outBytes.buffer, outBytes.byteOffset + outOffset, 4);
      view.setInt16(0, statePrev, true);
      view.setUint8(2, index);
      view.setUint8(3, 0);

      let outIdx = outOffset + 4;
      let buffer = 0;
      let bufferstep = false;

      for (let i = 0; i < len; i++) {
        const val = samples[i];
        let diff = val - statePrev;
        let sign = 0;
        if (diff < 0) {
          sign = 8;
          diff = -diff;
        }

        let step = stepTable[index];
        let delta = 0;
        let vpdiff = (step >> 3);

        if (diff >= step) {
          delta |= 4;
          diff -= step;
          vpdiff += step;
        }
        step >>= 1;
        if (diff >= step) {
          delta |= 2;
          diff -= step;
          vpdiff += step;
        }
        step >>= 1;
        if (diff >= step) {
          delta |= 1;
          vpdiff += step;
        }

        if (sign) {
          statePrev -= vpdiff;
        } else {
          statePrev += vpdiff;
        }

        if (statePrev > 32767) statePrev = 32767;
        else if (statePrev < -32768) statePrev = -32768;

        delta |= sign;
        index += indexTable[delta];
        if (index < 0) index = 0;
        else if (index > 88) index = 88;

        if (bufferstep) {
          outBytes[outIdx++] = (delta << 4) | (buffer & 0x0f);
          bufferstep = false;
        } else {
          buffer = delta & 0x0f;
          bufferstep = true;
        }
      }

      state.valprev = statePrev;
      state.index = index;

      return 4 + (len >> 1);
    },

    /**
     * Decodes IMA-ADPCM bytes into Float32 normalized audio samples [-1.0, 1.0].
     * @param {Uint8Array} inBytes - Input ADPCM packet buffer.
     * @param {number} inOffset - Byte offset where ADPCM header starts.
     * @param {number} numSamples - Number of output samples to reconstruct.
     * @param {Float32Array} outSamples - Pre-allocated Float32Array to write to.
     */
    decodeImaAdpcm(inBytes, inOffset, numSamples, outSamples) {
      const view = new DataView(inBytes.buffer, inBytes.byteOffset + inOffset, 4);
      let valprev = view.getInt16(0, true);
      let index = view.getUint8(2);
      if (index > 88) index = 88;

      let inIdx = inOffset + 4;
      let buffer = 0;
      let bufferstep = false;
      const invScale = 1.0 / 32768.0;

      for (let i = 0; i < numSamples; i++) {
        let delta;
        if (bufferstep) {
          delta = (buffer >> 4) & 0x0f;
          bufferstep = false;
        } else {
          buffer = inBytes[inIdx++];
          delta = buffer & 0x0f;
          bufferstep = true;
        }

        const step = stepTable[index];
        let vpdiff = (step >> 3);
        if (delta & 4) vpdiff += step;
        if (delta & 2) vpdiff += (step >> 1);
        if (delta & 1) vpdiff += (step >> 2);

        if (delta & 8) {
          valprev -= vpdiff;
        } else {
          valprev += vpdiff;
        }

        if (valprev > 32767) valprev = 32767;
        else if (valprev < -32768) valprev = -32768;

        index += indexTable[delta];
        if (index < 0) index = 0;
        else if (index > 88) index = 88;

        outSamples[i] = valprev * invScale;
      }
    }
  };

  global.AudioCodec = AudioCodec;
})(typeof window !== 'undefined' ? window : global);
