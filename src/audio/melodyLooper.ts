import type { AudioEngine } from './AudioEngine';
import { hzFor, pluck, scaleOf } from './melody';
import { GridClock, TakeLooper, type Take, type TakeHooks, type TakeVoice, type Tap } from './takeLooper';
import type { KeyMode } from './types';

/**
 * The keyboard surface: the SAME loop pedal as the beat pad, configured with a
 * 5 s idle window, a pluck voice, and two assists the performer may refuse.
 *
 *   AUTO-TUNE       snaps a played note into the song's key
 *   AUTO-BEAT-MATCH snaps timing to the grid
 *
 * With both off it plays back exactly what was tapped, at the pitches that were
 * tapped, when they were tapped. The loop LENGTH is still a whole power-of-two
 * number of bars either way, because that is what keeps it lined up with the
 * song and with the drum takes — refusing the assists costs the assists, not the
 * phase lock.
 */

const NOTE_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Low / Mid / High. No numerals on a control a seven-year-old has to read. */
export const OCTAVE_LABELS = ['Low', 'Mid', 'High'] as const;
const OCTAVES = [3, 4, 5];

/** Idle silence that ends a melodic take. Longer than the drums': a phrase is longer. */
const KEYS_IDLE_SEC = 5;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export interface SongKey {
  pc: number;
  mode: KeyMode;
}

/**
 * The key the room is actually HEARING.
 *
 * Not `decks.find(d => d.analysis)` and not the raw analysis: the anchor deck is
 * the one the beat clock already follows, and `nudgeSemitones` is the harmonic
 * nudge that has ALREADY shifted its pitch, so a deck can sound in a different
 * key than it was analysed in. `Deck.effectivePc` is private and `Deck.ts` is
 * not ours to edit, so this recomputes the same formula `effectiveCamelot` uses
 * from the public `nudgeSemitones`.
 *
 * NO DECK, OR NO ANALYSIS: A minor. That is the exact fallback the beat
 * machine's sub bass already used, so the sub and the keyboard cannot disagree
 * about the key of a room with no song in it. The layout is identical in the
 * fallback, so nothing looks broken or disabled.
 */
export function anchorKey(engine: AudioEngine): SongKey {
  const deck = engine.anchorDeck();
  const analysis = deck?.analysis;
  if (!deck || !analysis) return { pc: 9, mode: 'minor' };
  return {
    pc: (((analysis.keyPc + deck.nudgeSemitones) % 12) + 12) % 12,
    mode: analysis.keyMode,
  };
}

/**
 * Snap a midi note to the nearest degree of the key.
 *
 * TIES GO DOWNWARD. They are real: in minor, rel = 1 sits one semitone from both
 * 0 and 2. "Prefer the lower degree" is deterministic and keeps a melody from
 * creeping upward over a long phrase.
 *
 * A diatonic scale has no gap wider than two semitones, so the snap never moves
 * a note by more than one semitone. It cannot transpose a melody; it can only
 * flatten or sharpen an accidental.
 */
export function snapToKey(midi: number, key: SongKey): number {
  if (!Number.isFinite(midi)) return midi;
  const scale = scaleOf(key.mode);
  const rel = (((midi - key.pc) % 12) + 12) % 12;
  const base = midi - rel;

  let best = scale[0];
  let bestD = Infinity;
  for (let i = 0; i < scale.length; i++) {
    for (const cand of [scale[i], scale[i] + 12]) {
      const d = Math.abs(rel - cand);
      if (d < bestD || (d === bestD && cand < best)) {
        bestD = d;
        best = cand;
      }
    }
  }
  return base + best;
}

/** One drawable key. `midi` is both the sound and the `flash` identity. */
export interface KeyCap {
  midi: number;
  pc: number;
  label: string;
  /** Scale degree 0..6 for an in-key cap; -1 for an accidental. */
  degree: number;
  inKey: boolean;
  /** Root and fifth — the two that cannot sound wrong. Lit brighter. */
  strong: boolean;
}

export interface BlackCap extends KeyCap {
  /**
   * Draw this cap on the boundary to the RIGHT of white key `afterIndex`.
   * 6 means the right-hand edge of the last white key, which is where the
   * leading tone of a minor key falls.
   */
  afterIndex: number;
}

export class MelodyLooper {
  readonly looper: TakeLooper<number>;
  /** Connect this to the drum bus. */
  readonly output: GainNode;

  /** Snap played notes into the song's key. Applied at TAP time. */
  autoTune = true;
  /** Snap timing to the grid. Off keeps the exact moments that were played. */
  beatMatch = true;
  /** Index into OCTAVE_LABELS. */
  octaveIndex = 1;

  private engine: AudioEngine;

  constructor(engine: AudioEngine, clock: GridClock, hooks: TakeHooks) {
    this.engine = engine;

    const voice: TakeVoice<number> = {
      play: (ctx, dest, time, midi, gain, vel) => {
        if (!Number.isFinite(midi)) return;
        // hzFor's own midi arithmetic, fed the note's own octave, so there is no
        // second copy of the equal-temperament formula in this repo.
        const hz = hzFor(((midi % 12) + 12) % 12, 0, Math.floor(midi / 12) - 1);
        const beat = 60 / (this.engine.transport.bpm || 120);
        // Notes shorten as the tempo rises, so a fast song does not turn a
        // melody into a drone.
        const dur = clamp(beat * 0.55, 0.12, 0.5);
        const level = 0.3 * clamp(gain, 0, 4) * (0.4 + 0.6 * clamp(vel, 0, 1));
        pluck(ctx, dest, time, hz, dur, level);
      },
      // The note IS the identity: two takes playing the same note at the same
      // instant merge, but a chord across takes survives.
      keyOf: (midi) => midi,
    };

    this.looper = new TakeLooper<number>(
      engine.ctx,
      engine.transport,
      clock,
      {
        idleSec: KEYS_IDLE_SEC,
        quantiseSteps: 1,
        maxBars: 8,
        maxTakes: 6,
        maxVoicesPerStep: 4,
        // Small-signal +3.67 dB. Quieter drive than the drums because a pluck is
        // already a sustained tone and hard saturation on one buzzes.
        drive: 0.22,
        // Half the drums' ceiling. See the LEVELS block in BeatMachine.
        trim: 0.5,
        quantised: () => this.beatMatch,
        voice,
      },
      hooks
    );
    this.output = this.looper.output;
  }

  /* ---------------------------------------------------------------- theory */

  key(): SongKey {
    return anchorKey(this.engine);
  }

  keyName(): string {
    const k = this.key();
    return `${NOTE_NAMES[k.pc]} ${k.mode}`;
  }

  get octave(): number {
    return OCTAVES[clamp(this.octaveIndex, 0, OCTAVES.length - 1)];
  }

  /**
   * The seven big keys: the scale degrees of the current key, root at the far
   * left. KEY-RELATIVE, not chromatic, and that is what makes the keyboard
   * playable at 330 px — seven 44 px keys fit where twelve do not, and the notes
   * that fit are exactly the ones that cannot sound wrong.
   */
  whiteCaps(): KeyCap[] {
    const k = this.key();
    const scale = scaleOf(k.mode);
    const base = 12 * (this.octave + 1) + k.pc;
    const caps: KeyCap[] = [];
    for (let i = 0; i < scale.length; i++) {
      const midi = base + scale[i];
      caps.push({
        midi,
        pc: ((midi % 12) + 12) % 12,
        label: NOTE_NAMES[((midi % 12) + 12) % 12],
        degree: i,
        inKey: true,
        strong: i === 0 || i === 4,
      });
    }
    return caps;
  }

  /**
   * The five chromatic in-betweens, drawn small and dim like black keys.
   *
   * The highlight the owner asked for is therefore STRUCTURAL as well as
   * coloured: the in-key notes are the big ones, so bad aim lands on a note that
   * works.
   */
  blackCaps(): BlackCap[] {
    const k = this.key();
    const scale = scaleOf(k.mode);
    const base = 12 * (this.octave + 1) + k.pc;
    const caps: BlackCap[] = [];
    for (let s = 1; s < 12; s++) {
      if (scale.indexOf(s) >= 0) continue;
      let below = 0;
      for (let i = 0; i < scale.length; i++) if (scale[i] < s) below++;
      const midi = base + s;
      caps.push({
        midi,
        pc: ((midi % 12) + 12) % 12,
        label: NOTE_NAMES[((midi % 12) + 12) % 12],
        degree: -1,
        inKey: false,
        strong: false,
        afterIndex: below - 1,
      });
    }
    return caps;
  }

  /* --------------------------------------------------------------- control */

  /**
   * Play a note.
   *
   * AUTO-TUNE IS APPLIED HERE, AT TAP TIME, NOT AT COMMIT. The note heard the
   * instant a key goes down is the same note that gets stored and looped, so the
   * loop is never a surprise. Two consequences, both on purpose:
   *  - the toggle means "for the notes I play next"; it does not re-tune takes
   *    that have already committed;
   *  - with auto-tune on, an accidental and its neighbour can sound identical.
   *    The key that ACTUALLY sounded is the one that flashes, so a child sees
   *    that their press was moved.
   *
   * Returns the midi note that sounded, or -1 if the tap was swallowed by the
   * retrigger guard.
   */
  tap(midi: number, vel = 1): number {
    const note = this.autoTune ? snapToKey(midi, this.key()) : midi;
    return this.looper.tap(note, vel) ? note : -1;
  }

  setAutoTune(on: boolean): void {
    this.autoTune = on;
    this.engine.notify();
  }

  setBeatMatch(on: boolean): void {
    this.beatMatch = on;
    this.engine.notify();
  }

  setOctave(i: number): void {
    this.octaveIndex = clamp(Math.round(i), 0, OCTAVES.length - 1);
    this.engine.notify();
  }

  /* -------------------------------------------------------------- delegates */

  clearLast(): boolean {
    return this.looper.clearLast();
  }

  resetAll(): boolean {
    return this.looper.resetAll();
  }

  onStep(step: number, time: number): void {
    this.looper.onStep(step, time);
  }

  phase01(): number {
    return this.looper.phase01();
  }

  openRemaining01(): number {
    return this.looper.openRemaining01();
  }

  loopSteps(): number {
    return this.looper.loopSteps();
  }

  glow(midi: number, now: number, decaySec?: number): number {
    return this.looper.glow(midi, now, decaySec);
  }

  get flash(): Map<number, number> {
    return this.looper.flash;
  }

  get takes(): readonly Take<number>[] {
    return this.looper.takes;
  }

  get openTaps(): readonly Tap<number>[] {
    return this.looper.openTaps;
  }

  get hasTakes(): boolean {
    return this.looper.hasTakes;
  }

  get isOpen(): boolean {
    return this.looper.isOpen;
  }

  get notice(): string {
    return this.looper.notice;
  }

  dispose(): void {
    this.looper.dispose();
  }
}
