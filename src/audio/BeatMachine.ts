import type { AudioEngine } from './AudioEngine';
import { clap, hat, kick, openHat, snare, sub, subRootHz } from './drums';
import { BOOM_SLOT, DRUM_PACKS, PAD_COUNT, PAD_LABELS, padVoice, type DrumPack } from './drumPacks';
import { hzFor, progressionFor, stab, triadSemitones } from './melody';
import { MelodyLooper, anchorKey } from './melodyLooper';
import { GridClock, TakeLooper, type Take, type TakeHooks, type TakeVoice } from './takeLooper';

export type DrumLayer = 'kick' | 'snare' | 'hats' | 'bass' | 'melody';

export interface Groove {
  name: string;
  /** Step indices within a 16-step bar. */
  kick: number[];
  snare: number[];
  hats: number[];
  openHats: number[];
  bass: number[];
  melody: number[];
  snareVoice: 'snare' | 'clap';
}

export const GROOVES: Groove[] = [
  {
    name: 'Party',
    kick: [0, 4, 8, 12],
    snare: [4, 12],
    hats: [2, 6, 10, 14],
    openHats: [14],
    bass: [0, 6, 8, 14],
    melody: [2, 6, 10, 14],
    snareVoice: 'clap',
  },
  {
    name: 'Hip Hop',
    kick: [0, 3, 8, 10],
    snare: [4, 12],
    hats: [0, 2, 4, 6, 8, 10, 12, 14],
    openHats: [],
    bass: [0, 8, 11],
    melody: [0, 10],
    snareVoice: 'snare',
  },
  {
    name: 'Trap',
    kick: [0, 6, 8, 14],
    snare: [8],
    hats: [0, 2, 4, 6, 8, 9, 10, 12, 14, 15],
    openHats: [7],
    bass: [0, 8],
    melody: [0, 6, 8],
    snareVoice: 'snare',
  },
];

/**
 * Duck applied to the CANNED groove voices while any take exists.
 *
 * On the groove path only, and nothing else writes this node — see PARAM
 * OWNERSHIP in AudioEngine. With no takes it is exactly 1.0, so a session that
 * never touches the beat pad is bit-identical to the one that shipped before.
 */
const GROOVE_DUCK = 0.4;

/**
 * The Phase 2 beat machine — a third source on the master bus, and now also the
 * host of the two LOOP PEDAL surfaces.
 *
 * Joins via engine.addSource(output, null), i.e. straight to the sum bus rather
 * than either side of the crossfader, so the beat keeps playing while a child
 * sweeps between songs.
 *
 * Tempo and downbeat come from the anchor deck, so the drums land on the song's
 * grid rather than near it, and the sub follows the song's detected key.
 *
 * ---------------------------------------------------------------------------
 * LEVELS — derived, not chosen. `volume` STAYS 0.52; it is not retuned.
 *
 * The master limiter's threshold is -3 dBFS = 0.7079 and masterGain is 0.5, so
 * the drum-bus peak that lands exactly ON the threshold is
 *
 *     P_ref = 0.7079 / (0.52 * 0.5) = 2.723
 *
 * and that is what the measured 0.52 means: the densest legacy case (Trap, all
 * five layers, peak 2.581 - 2.723) sits at the threshold with 0.00 dB of limiter
 * reduction. Anything hotter makes the MASTER limiter duck the DECKS, which is a
 * child's own song pumping on every downbeat.
 *
 * Stacked takes plus a melody layer can be arbitrarily denser than a fixed
 * groove, and no arithmetic over "6 takes x 6 pads x live taps x Trap" produces a
 * number that is both safe and audible. So each take surface's bus peak is made
 * a CONSTANT by construction rather than a conjunction:
 *
 *     voices -> saturator(drive) -> trim -> bus
 *
 * The curve from drums.ts is normalised so y(+/-1) = +/-1 and Web Audio CLAMPS
 * its input beyond +/-1, so the output cannot exceed `trim` however many voices
 * sum. Drums trim 1.00, keys trim 0.50. Therefore
 *
 *     worst-case bus peak = 2.723 * 0.40 + 1.00 + 0.50
 *                         = 1.089 + 1.500 = 2.589   against a budget of 2.723
 *                         -> 0.44 dB of margin, limiter reduction 0.00 dB.
 *
 * THE DECKS NEVER DUCK, and because the total never exceeds the legacy worst
 * case, every downstream number in macros.ts and drums.ts — bump's +5 dB shelf,
 * BUMP_TRIM 0.5, the 3.0 dB master allowance — remains valid without
 * re-derivation.
 *
 * It is loud ENOUGH, which is the other half of the job. One kick at slot gain
 * 0.90 through drive 0.28 gives y(0.9) = 0.973 x trim 1.00 = 0.973, against the
 * groove kick's measured peak 1.079: -0.90 dB. A keyboard note at 0.30 through
 * drive 0.22 (+3.67 dB small-signal) is ~0.458 x trim 0.50 = 0.229, against the
 * melody layer's stab at 0.16: +3.1 dB, which is correct for a lead voice.
 * Density adds thickness and harmonics, not level — the same argument drums.ts
 * makes for its per-voice saturation.
 *
 * ---------------------------------------------------------------------------
 * COMPATIBILITY — macros.ts calls into this class and is NOT edited.
 *
 *   bm.layers        UNCHANGED. The five canned groove layers, still a plain
 *                    record, still what BeatMachinePanel toggles in DJ mode.
 *   bm.setLayer      UNCHANGED, except syncClock() now stops the transport only
 *                    when there are no layers AND no takes.
 *   bm.anyLayerOn    WIDENED — see the getter.
 *   bm.groove/.name  UNCHANGED. Literally GROOVES[grooveIndex].
 *   GROOVES          UNCHANGED export, unchanged contents.
 *   bm.volume        UNCHANGED at 0.52. Takes sit UPSTREAM of `output`, so the
 *                    DJ drum fader now controls the loops too, which is right.
 *
 * ONE DOCUMENTED GAP. macros.onSidechainStep gates bump's pump on
 * `bm.layers.kick && bm.groove.kick.includes(step)`. With take-only beats
 * `layers.kick` is false, so bump shelves and drives but does not pump. Faking
 * layers.kick would break ensureDrums / restoreLayers / stopAll / the DJ panel,
 * so the state is not lied about; `kickSteps` is exposed instead, so whoever
 * next owns macros.ts closes this in one line.
 */
export class BeatMachine {
  readonly output: GainNode;

  /** The canned groove layers. NOT a proxy for the take stack — see anyLayerOn. */
  layers: Record<DrumLayer, boolean> = {
    kick: false,
    snare: false,
    hats: false,
    bass: false,
    melody: false,
  };
  grooveIndex = 0;
  /**
   * 0.52, solved by measurement against the MASTER limiter's own reduction with
   * sampled voices (-1.61 dB at 0.66 became 0.00 dB at 0.52). See the LEVELS
   * block above for why the take surfaces did not move it.
   */
  volume = 0.52;

  /** Which of DRUM_PACKS the six pads are currently voiced from. */
  packIndex = 0;

  /** Where we are, in absolute steps. Shared by both surfaces and the groove. */
  readonly clock: GridClock;
  /** The beat pad. Payload is a pad slot, 0..PAD_COUNT-1. */
  readonly drums: TakeLooper<number>;
  /** The keyboard, with its auto-tune and auto-beat-match toggles. */
  readonly keys: MelodyLooper;

  /* --------------------------------------------------------- keyboard façade
   *
   * The UI reaches the keyboard through these rather than through `.keys`
   * directly, so the two assists have ONE writer that also notifies. Setting
   * `keys.autoTune` from a component would change the model without telling
   * React, and the toggle would light a frame late or not at all.
   */

  /** Play a note now and record it into the open take. */
  tapKey(midi: number, velocity = 1): number {
    return this.keys.tap(midi, velocity);
  }

  get autoTune(): boolean {
    return this.keys.autoTune;
  }

  setAutoTune(on: boolean): void {
    this.keys.autoTune = on;
    this.engine.notify();
  }

  get beatMatch(): boolean {
    return this.keys.beatMatch;
  }

  setBeatMatch(on: boolean): void {
    this.keys.beatMatch = on;
    this.engine.notify();
  }

  private engine: AudioEngine;
  private bus: GainNode;
  /** Canned groove voices only, so takes can duck the groove without ducking themselves. */
  private grooveTrim: GainNode;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    const ctx = engine.ctx;

    this.bus = ctx.createGain();
    this.output = ctx.createGain();
    this.output.gain.value = this.volume;
    this.bus.connect(this.output);

    this.grooveTrim = ctx.createGain();
    this.grooveTrim.gain.value = 1;
    this.grooveTrim.connect(this.bus);

    this.clock = new GridClock(ctx, engine.transport);

    const hooks: TakeHooks = {
      changed: () => this.onTakesChanged(),
      ensureClock: () => this.engine.ensureBeatClock(),
    };

    const padVoiceTable: TakeVoice<number> = {
      play: (c, dest, time, slot, gain, vel) => {
        // Read the pack LIVE, never captured: switching packs re-voices every
        // take, including committed ones. A pack is a kit swap, so a child's
        // loops change kit instantly. Freezing the pack per take was rejected —
        // it is invisible state a child can neither see nor undo.
        const spec = this.pack.slots[slot];
        if (!spec) return;
        padVoice(c, dest, time, spec, gain, vel);
      },
      keyOf: (slot) => slot,
    };

    this.drums = new TakeLooper<number>(
      ctx,
      engine.transport,
      this.clock,
      {
        idleSec: 3,
        quantiseSteps: 1,
        maxBars: 8,
        maxTakes: 6,
        // One per pad slot: a chord of all six is the honest ceiling here.
        maxVoicesPerStep: PAD_COUNT,
        drive: 0.28,
        trim: 1,
        // Always beat-matched. That is what a drum loop is FOR.
        quantised: () => true,
        voice: padVoiceTable,
      },
      hooks
    );
    this.drums.output.connect(this.bus);

    this.keys = new MelodyLooper(engine, this.clock, hooks);
    this.keys.output.connect(this.bus);

    // Three independent handlers rather than one. Transport.tick has no
    // try/catch, so a throw anywhere kills the clock AND every handler after it;
    // each of these three is internally sealed, and clock.observe is idempotent
    // per (step, time) so it does not matter which of them reaches it first.
    engine.transport.onStep((step, time) => this.onGrooveStep(step, time));
    engine.transport.onStep((step, time) => this.drums.onStep(step, time));
    engine.transport.onStep((step, time) => this.keys.onStep(step, time));
  }

  /* ------------------------------------------------------------- legacy API */

  get groove(): Groove {
    return GROOVES[this.grooveIndex];
  }

  /**
   * "IS THERE A BEAT?" — canned groove layers ON, **or any take committed**.
   *
   * WIDENED DELIBERATELY, and this is the question macros.ensureDrums is
   * actually asking. With takes playing, ensureDrums now returns [] and only
   * guarantees the clock, so a bridge or an auto-mix rides the CHILD's own loops
   * instead of forcing the canned Party groove over the top — better music, and
   * restoreLayers([]) then correctly does nothing.
   *
   * A reader who assumes this still means "a canned layer is on" will be wrong.
   * Use `Object.values(bm.layers).some(Boolean)` if that is what you want.
   */
  get anyLayerOn(): boolean {
    return this.anyGrooveLayerOn || this.hasTakes;
  }

  /** The narrow question, for anyone who needs the pre-widening meaning. */
  get anyGrooveLayerOn(): boolean {
    return Object.values(this.layers).some(Boolean);
  }

  setLayer(layer: DrumLayer, on: boolean): void {
    this.layers[layer] = on;
    this.syncClock();
    this.engine.notify();
  }

  toggleLayer(layer: DrumLayer): void {
    this.setLayer(layer, !this.layers[layer]);
  }

  setGroove(i: number): void {
    this.grooveIndex = ((i % GROOVES.length) + GROOVES.length) % GROOVES.length;
    this.engine.notify();
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.output.gain.setTargetAtTime(this.volume, this.engine.ctx.currentTime, 0.01);
    this.engine.notify();
  }

  /** Clear the canned layers. Takes are a performance and are NOT touched. */
  stopAll(): void {
    for (const k of Object.keys(this.layers) as DrumLayer[]) this.layers[k] = false;
    this.syncClock();
    this.engine.notify();
  }

  /* ------------------------------------------------------------ take surface */

  get pack(): DrumPack {
    return DRUM_PACKS[this.packIndex] ?? DRUM_PACKS[0];
  }

  get packs(): DrumPack[] {
    return DRUM_PACKS;
  }

  get padLabels(): readonly string[] {
    return PAD_LABELS;
  }

  setPack(i: number): void {
    this.packIndex = ((i % DRUM_PACKS.length) + DRUM_PACKS.length) % DRUM_PACKS.length;
    this.engine.notify();
  }

  get hasTakes(): boolean {
    return this.drums.hasTakes || this.keys.hasTakes;
  }

  /**
   * Every step within a bar that a kick lands on: the union of the canned
   * groove's kick steps (when that layer is on) and the BOOM-slot steps of every
   * committed drum take.
   *
   * This exists for macros.onSidechainStep, which cannot see take-only beats
   * because it reads `bm.layers.kick`. It is the seam, exposed now, so that fix
   * is one line for whoever owns that file next.
   */
  get kickSteps(): number[] {
    const seen = new Set<number>();
    if (this.layers.kick) for (const s of this.groove.kick) seen.add(s);
    for (const take of this.drums.takes) this.collectBoomSteps(take, seen);
    return Array.from(seen).sort((a, b) => a - b);
  }

  /** Clear both surfaces. What "reset everything" means at the rack level. */
  resetTakes(): void {
    this.drums.resetAll();
    this.keys.resetAll();
  }

  dispose(): void {
    this.drums.dispose();
    this.keys.dispose();
  }

  /* -------------------------------------------------------------- internals */

  private collectBoomSteps(take: Take<number>, into: Set<number>): void {
    for (let i = 0; i < take.byStep.length; i++) {
      const bucket = take.byStep[i];
      for (let j = 0; j < bucket.length; j++) {
        if (bucket[j].p === BOOM_SLOT) {
          into.add(i % 16);
          break;
        }
      }
    }
  }

  /** A take committed, was cleared, or the stack was reset. Discrete. */
  private onTakesChanged(): void {
    this.syncClock();
    this.updateGrooveDuck();
    this.engine.notify();
  }

  /** Run the clock only while something is actually playing — layers OR takes. */
  private syncClock(): void {
    if (this.anyLayerOn) this.engine.ensureBeatClock();
    else this.engine.transport.stop();
  }

  private updateGrooveDuck(): void {
    const target = this.hasTakes ? GROOVE_DUCK : 1;
    this.grooveTrim.gain.setTargetAtTime(target, this.engine.ctx.currentTime, 0.05);
  }

  /**
   * Key of whatever is playing, so generated notes never fight the music.
   *
   * BEHAVIOUR CHANGE, called out rather than slipped in: this used to be
   * `decks.find(d => d.analysis)` and ignored `nudgeSemitones`, so the sub bass
   * could sit a semitone or two off the key the room was actually hearing. It
   * now uses the shared `anchorKey`, which is the same source the new keyboard
   * highlights against — so the sub and the keyboard cannot disagree.
   */
  private key(): { pc: number; mode: 'major' | 'minor' } {
    return anchorKey(this.engine);
  }

  private rootHz(): number {
    return subRootHz(this.key().pc);
  }

  private onGrooveStep(step: number, time: number): void {
    try {
      this.clock.observe(step, time);
      if (!this.anyGrooveLayerOn) return;

      const g = this.groove;
      const ctx = this.engine.ctx;
      const dest = this.grooveTrim;

      if (this.layers.kick && g.kick.includes(step)) kick(ctx, dest, time);
      if (this.layers.snare && g.snare.includes(step)) {
        if (g.snareVoice === 'clap') clap(ctx, dest, time);
        else snare(ctx, dest, time);
      }
      if (this.layers.hats) {
        if (g.hats.includes(step)) hat(ctx, dest, time);
        if (g.openHats.includes(step)) openHat(ctx, dest, time);
      }
      if (this.layers.bass && g.bass.includes(step)) {
        sub(ctx, dest, time, this.rootHz());
      }
      if (this.layers.melody && g.melody.includes(step)) {
        // Chord changes each bar, following a diatonic progression in the key of
        // whatever is playing — so this lands on top of a child's own song.
        const { pc, mode } = this.key();
        const prog = progressionFor(mode);
        const triad = triadSemitones(mode, prog[this.clock.absBar % prog.length]);
        stab(
          ctx,
          dest,
          time,
          triad.map((s) => hzFor(pc, s, 4)),
          (60 / (this.engine.transport.bpm || 120)) * 0.45,
          0.16
        );
      }
    } catch {
      // Transport.tick has no try/catch: a throw here would stop the clock
      // forever and take both loop surfaces down with it.
    }
  }
}
