import type { KeyMode } from './types';

/**
 * Pitched voices and the small amount of music theory behind them.
 *
 * Everything here derives its notes from a key, so melodic content is generated
 * in the key of whatever is playing rather than fixed at authoring time. That is
 * what lets the melody pad sit on top of a child's own song without clashing.
 */

const FLOOR = 0.0001;

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

export function scaleOf(mode: KeyMode): number[] {
  return mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
}

/** Semitones above the key root for the diatonic triad on a scale degree. */
export function triadSemitones(mode: KeyMode, degree: number): number[] {
  const s = scaleOf(mode);
  const step = (i: number) => s[((i % 7) + 7) % 7] + 12 * Math.floor(i / 7);
  return [step(degree), step(degree + 2), step(degree + 4)];
}

/** Chord progressions that sound good and resolve, per mode. */
export function progressionFor(mode: KeyMode): number[] {
  // I - V - vi - IV in major; i - VI - III - VII in minor.
  return mode === 'major' ? [0, 4, 5, 3] : [0, 5, 2, 6];
}

export function hzFor(rootPc: number, semitones: number, octave = 4): number {
  const midi = 12 * (octave + 1) + rootPc + semitones;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Warm detuned chord stab with a filter envelope. */
export function stab(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  freqs: number[],
  dur = 0.35,
  gain = 0.18
): void {
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.2;
  lp.frequency.setValueAtTime(900, time);
  lp.frequency.exponentialRampToValueAtTime(2600, time + 0.06);
  lp.frequency.exponentialRampToValueAtTime(700, time + dur);

  g.gain.setValueAtTime(FLOOR, time);
  g.gain.linearRampToValueAtTime(gain, time + 0.012);
  g.gain.exponentialRampToValueAtTime(FLOOR, time + dur);
  g.connect(lp).connect(dest);

  for (const f of freqs) {
    for (const detune of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = detune;
      const og = ctx.createGain();
      og.gain.value = 1 / (freqs.length * 2);
      o.connect(og).connect(g);
      o.start(time);
      o.stop(time + dur + 0.05);
    }
  }
}

/** Short plucked note for arpeggios. */
export function pluck(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  freq: number,
  dur = 0.22,
  gain = 0.16
): void {
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = freq;

  const bp = ctx.createBiquadFilter();
  bp.type = 'lowpass';
  bp.frequency.setValueAtTime(4200, time);
  bp.frequency.exponentialRampToValueAtTime(900, time + dur);

  const g = ctx.createGain();
  g.gain.setValueAtTime(FLOOR, time);
  g.gain.linearRampToValueAtTime(gain, time + 0.006);
  g.gain.exponentialRampToValueAtTime(FLOOR, time + dur);

  o.connect(bp).connect(g).connect(dest);
  o.start(time);
  o.stop(time + dur + 0.03);
}

/** Round bass note, one octave below the chord. */
export function bassNote(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  freq: number,
  dur = 0.4,
  gain = 0.3
): void {
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = freq;

  const sine = ctx.createOscillator();
  sine.type = 'sine';
  sine.frequency.value = freq;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;

  const g = ctx.createGain();
  g.gain.setValueAtTime(FLOOR, time);
  g.gain.linearRampToValueAtTime(gain, time + 0.01);
  g.gain.setValueAtTime(gain, time + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(FLOOR, time + dur);

  const mix = ctx.createGain();
  mix.gain.value = 0.5;
  o.connect(mix);
  sine.connect(mix);
  mix.connect(lp).connect(g).connect(dest);

  o.start(time);
  o.stop(time + dur + 0.03);
  sine.start(time);
  sine.stop(time + dur + 0.03);
}
