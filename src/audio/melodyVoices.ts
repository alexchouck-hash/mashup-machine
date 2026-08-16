import { pluck, stab } from './melody';
import { assertKitNames, kitBuffer } from './sampleKit';

/**
 * The four keyboard voices: Guitar, Vocal, Synth, Xylo.
 *
 * Two are REAL RECORDINGS and two are synthesized, and the split is not
 * arbitrary. An electric guitar and a human voice cannot be convincingly
 * synthesized in a few hundred lines of Web Audio — the attempt is what makes a
 * toy sound like a toy. A synth lead and a bell, by contrast, ARE oscillators;
 * sampling them would buy nothing and cost a fetch.
 *
 * ONE SAMPLE, PLAYED ACROSS A KEYBOARD — and the honest limit that implies.
 * Transposing a recording by playback rate stretches it in time as well as
 * pitch, so an octave up is chipmunked and short, an octave down is sluggish and
 * dull. Past roughly a fifth in either direction it stops sounding like the
 * instrument. So instead of stretching, notes are FOLDED BY OCTAVES until they
 * sit within a fifth of the sample's own root: the pitch CLASS a child pressed
 * is always what sounds, and only the octave may differ. In a key-locked toy
 * that is inaudible as a mistake and audible as an instrument, which is the
 * right trade. `guitar` and `vocal` are the voices that need it.
 *
 * SWAPPING A VOICE RE-VOICES EVERY TAKE, including committed ones, exactly as a
 * drum pack does. A voice is an instrument change, not a property of the notes.
 */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Transposition bounds, as playback-rate limits: one octave either way.
 *
 * Chosen after getting this wrong. The first attempt folded every note by
 * octaves to sit within a fifth of the sample's root, reasoning that a small
 * stretch preserves the instrument's character. It does — and it also makes a
 * rising melody not rise, because octave folding preserves PITCH CLASS by
 * construction: with an E2 root, C2/C3/C4/C5/C6 all collapse onto C2. A
 * keyboard that plays one pitch per pitch class is not a keyboard.
 *
 * Contour beats timbre. Notes transpose DIRECTLY across two octaves, and only
 * beyond that do they fold back into range — where the alternative is a
 * chipmunk or a growl that no longer resembles the instrument at all.
 */
const RATE_MIN = 0.5;
const RATE_MAX = 2;

export interface MelodyVoice {
  name: string;
  emoji: string;
  /** Kit sample name, or null for a purely synthesized voice. */
  sample: string | null;
  /**
   * MIDI note the sample was recorded at. Only meaningful when `sample` is set.
   *
   * `vocal` is a judgement rather than a measurement: ambi_choir is a sustained
   * pad and its source states no root, so 60 (C4) is where it sits by ear. If
   * the choir sounds a consistent interval away from the song, this number is
   * the one to move.
   */
  rootMidi: number;
  /** Per-voice level, so a voice cannot cost headroom. */
  gain: number;
  /** Hard bound on a sampled note. A pad rings far longer than a melody wants. */
  maxSec: number;
  /** Note length as a fraction of one beat, before the bounds below. */
  holdBeats: number;
  /** Played when the sample is missing — stripped assets, or still decoding. */
  synth: (
    ctx: BaseAudioContext,
    dest: AudioNode,
    time: number,
    hz: number,
    dur: number,
    level: number
  ) => void;
}

/** A bell/mallet fallback: the fifth above rings with the note, briefly. */
const bellSynth: MelodyVoice['synth'] = (ctx, dest, time, hz, dur, level) => {
  stab(ctx, dest, time, [hz, hz * 2.0, hz * 2.997], Math.min(dur, 0.4), level * 0.7);
};

/** A choir-ish fallback: a soft triad rather than a single tone. */
const padSynth: MelodyVoice['synth'] = (ctx, dest, time, hz, dur, level) => {
  stab(ctx, dest, time, [hz, hz * 1.5], dur, level * 0.8);
};

export const MELODY_VOICES: MelodyVoice[] = [
  {
    name: 'Guitar',
    emoji: '🎸',
    // guit_e_fifths — real electric guitar. It is a FIFTHS voicing, not a single
    // string, so it reads as a power chord: excellent for stabs under a vocal,
    // and deliberately not sold as a lead line.
    sample: 'guitar',
    rootMidi: 40, // E2, the open low E the fifths are rooted on
    gain: 0.55,
    maxSec: 0.9,
    holdBeats: 0.9,
    synth: pluck,
  },
  {
    name: 'Vocal',
    emoji: '🎤',
    sample: 'choir',
    rootMidi: 60,
    gain: 0.5,
    // A choir pad rings for seconds. Bounded hard, or a melody becomes a drone
    // and every note smears into the next.
    maxSec: 1.1,
    holdBeats: 1.4,
    synth: padSynth,
  },
  {
    name: 'Synth',
    emoji: '🎹',
    // Pure synthesis: full keyboard range with no transposition artefacts at
    // all, which is exactly what a sampled voice cannot offer.
    sample: null,
    rootMidi: 60,
    gain: 0.62,
    maxSec: 0.6,
    holdBeats: 0.55,
    synth: pluck,
  },
  {
    name: 'Xylo',
    emoji: '🔔',
    sample: 'bell',
    rootMidi: 72, // C5
    gain: 0.5,
    maxSec: 0.5,
    holdBeats: 0.5,
    synth: bellSynth,
  },
];

assertKitNames(
  MELODY_VOICES.map((v) => v.sample).filter((s): s is string => s !== null),
  'MELODY_VOICES'
);

/**
 * Playback rate for `midi` against a sample recorded at `root`.
 *
 * Direct transposition, so a note played higher SOUNDS higher — the property a
 * melody instrument cannot do without. Only once the interval exceeds an octave
 * does it fold by octaves back into range, which flattens contour at the
 * extremes rather than everywhere.
 */
export function voiceRate(midi: number, root: number): number {
  let rate = Math.pow(2, (midi - root) / 12);
  let guard = 0;
  while (rate > RATE_MAX && guard++ < 12) rate /= 2;
  while (rate < RATE_MIN && guard++ < 12) rate *= 2;
  return clamp(rate, RATE_MIN, RATE_MAX);
}

/**
 * Play one note of `voice`. Returns false when there is no sample to play, so
 * the caller can fall through to synthesis with the same envelope decisions.
 */
export function playVoiceSample(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  voice: MelodyVoice,
  midi: number,
  level: number,
  durSec: number
): boolean {
  if (!voice.sample) return false;
  const buf = kitBuffer(ctx, voice.sample);
  if (!buf) return false;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = voiceRate(midi, voice.rootMidi);

  const g = ctx.createGain();
  const peak = clamp(level, 0.0001, 4);
  g.gain.setValueAtTime(peak, time);

  // The sample is stretched by 1/rate, so the bound has to be measured in the
  // stretched domain or a low note outruns it.
  const avail = buf.duration / src.playbackRate.value;
  const dur = Math.min(durSec, voice.maxSec, avail);
  // Ride the tail down. A hard stop on a ringing choir or bell is a click, and
  // at melody rates that click lands on every note.
  g.gain.setValueAtTime(peak, time + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  src.connect(g).connect(dest);
  src.start(time);
  src.stop(time + dur + 0.02);
  return true;
}
