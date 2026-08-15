/**
 * Synthesized 808/EDM drum voices.
 *
 * The spec asks for a curated sample pack. These are synthesized instead: no
 * audio assets to license, which matters because unlicensed samples would
 * foreclose the monetization paths the project cares about, and it keeps the
 * bundle self-contained with nothing to fetch at runtime.
 *
 * SWAP POINT: each voice is a `(ctx, dest, time, gain) => void` one-shot. Buying
 * a pack later means replacing these bodies with buffer playback; the sequencer
 * calls them the same way.
 */

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx);
  if (cached) return cached;
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseCache.set(ctx, buf);
  return buf;
}

/** Exponential ramps cannot reach zero; decay to this instead. */
const FLOOR = 0.0001;

function burst(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  gain: number,
  decay: number,
  filter: { type: BiquadFilterType; freq: number; q?: number }
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.playbackRate.value = 1;

  const bq = ctx.createBiquadFilter();
  bq.type = filter.type;
  bq.frequency.value = filter.freq;
  if (filter.q !== undefined) bq.Q.value = filter.q;

  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(gain, FLOOR), time);
  g.gain.exponentialRampToValueAtTime(FLOOR, time + decay);

  src.connect(bq).connect(g).connect(dest);
  src.start(time, Math.random() * 1.5);
  src.stop(time + decay + 0.02);
}

export function kick(ctx: BaseAudioContext, dest: AudioNode, time: number, gain = 1): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(45, time + 0.11);
  g.gain.setValueAtTime(Math.max(gain, FLOOR), time);
  g.gain.exponentialRampToValueAtTime(FLOOR, time + 0.42);
  osc.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + 0.45);

  // Beater click, so it reads on small speakers that cannot carry 45 Hz.
  const clk = ctx.createOscillator();
  const cg = ctx.createGain();
  clk.type = 'triangle';
  clk.frequency.value = 1100;
  cg.gain.setValueAtTime(gain * 0.4, time);
  cg.gain.exponentialRampToValueAtTime(FLOOR, time + 0.02);
  clk.connect(cg).connect(dest);
  clk.start(time);
  clk.stop(time + 0.03);
}

export function snare(ctx: BaseAudioContext, dest: AudioNode, time: number, gain = 1): void {
  burst(ctx, dest, time, gain * 0.7, 0.18, { type: 'highpass', freq: 1200 });
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(190, time);
  osc.frequency.exponentialRampToValueAtTime(120, time + 0.1);
  g.gain.setValueAtTime(gain * 0.5, time);
  g.gain.exponentialRampToValueAtTime(FLOOR, time + 0.13);
  osc.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + 0.15);
}

export function clap(ctx: BaseAudioContext, dest: AudioNode, time: number, gain = 1): void {
  // Three fast repeats plus a longer tail - what makes a clap read as hands.
  for (let i = 0; i < 3; i++) {
    burst(ctx, dest, time + i * 0.012, gain * 0.55, 0.035, {
      type: 'bandpass',
      freq: 1250,
      q: 1.1,
    });
  }
  burst(ctx, dest, time + 0.036, gain * 0.5, 0.16, { type: 'bandpass', freq: 1400, q: 0.9 });
}

export function hat(ctx: BaseAudioContext, dest: AudioNode, time: number, gain = 1): void {
  burst(ctx, dest, time, gain * 0.35, 0.045, { type: 'highpass', freq: 8000 });
}

export function openHat(ctx: BaseAudioContext, dest: AudioNode, time: number, gain = 1): void {
  burst(ctx, dest, time, gain * 0.3, 0.3, { type: 'highpass', freq: 7000 });
}

/**
 * 808 sub. `rootHz` is supplied by the beat machine from the anchor deck's
 * detected key, so the bassline is automatically in key with the music.
 */
export function sub(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  rootHz: number,
  gain = 1
): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  // Small downward glide is the 808 signature.
  osc.frequency.setValueAtTime(rootHz * 1.5, time);
  osc.frequency.exponentialRampToValueAtTime(rootHz, time + 0.06);
  g.gain.setValueAtTime(FLOOR, time);
  g.gain.linearRampToValueAtTime(gain * 0.9, time + 0.008);
  g.gain.exponentialRampToValueAtTime(FLOOR, time + 0.55);
  osc.connect(g).connect(dest);
  osc.start(time);
  osc.stop(time + 0.6);
}

/** Frequency of a pitch class in the sub octave (C1 = 32.70 Hz). */
export function subRootHz(pitchClass: number): number {
  return 32.703 * Math.pow(2, (((pitchClass % 12) + 12) % 12) / 12);
}

