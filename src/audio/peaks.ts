import type { Peaks } from './types';

/**
 * Min/max envelope for waveform drawing.
 *
 * Computed once at load. The overview is drawn by further downsampling this
 * array rather than touching the AudioBuffer again, which keeps the rAF draw
 * loop cheap enough to hold 60 fps with both decks animating.
 */
export function computePeaks(buffer: AudioBuffer, bucketsPerSecond = 400): Peaks {
  const total = Math.max(1, Math.ceil((buffer.length / buffer.sampleRate) * bucketsPerSecond));
  const per = buffer.length / total;

  const min = new Float32Array(total);
  const max = new Float32Array(total);

  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));

  for (let b = 0; b < total; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(buffer.length, Math.floor((b + 1) * per));
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end; i++) {
      // Mono sum for the envelope; stereo detail is not legible at this scale.
      let v = 0;
      for (let c = 0; c < chans.length; c++) v += chans[c][i];
      v /= chans.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }

  return { min, max, bucketsPerSecond };
}

/** Mono downmix as a fresh Float32Array, for transfer to the analysis worker. */
export function monoDownmix(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const out = new Float32Array(n);
  const ch = buffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
  return out;
}
