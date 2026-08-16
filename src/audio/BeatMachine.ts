import type { AudioEngine } from './AudioEngine';
import { clap, hat, kick, openHat, snare, sub, subRootHz } from './drums';
import { hzFor, progressionFor, stab, triadSemitones } from './melody';

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
 * The Phase 2 beat machine — a third source on the master bus.
 *
 * Joins via engine.addSource(output, null), i.e. straight to the sum bus rather
 * than either side of the crossfader, so the beat keeps playing while a child
 * sweeps between songs. That nullable side on addSource is exactly why it exists.
 *
 * Tempo and downbeat come from the anchor deck, so the drums land on the song's
 * grid rather than near it, and the sub follows the song's detected key.
 */
export class BeatMachine {
  readonly output: GainNode;

  layers: Record<DrumLayer, boolean> = {
    kick: false,
    snare: false,
    hats: false,
    bass: false,
    melody: false,
  };
  grooveIndex = 0;
  /**
   * 0.66, not 0.85: the layered voices in drums.ts sum ~2.2 dB hotter than the
   * ones they replaced (the kick and sub now hold level long enough to sum
   * coherently). Without this trim the drum bus pushes the MASTER limiter, which
   * ducks the decks — the child's own song pumping on every downbeat. See the
   * LEVELS block in drums.ts for the measurements.
   */
  volume = 0.52;

  private engine: AudioEngine;
  private bus: GainNode;
  /** Bar counter, so the melody's chord can change from bar to bar. */
  private bar = 0;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    const ctx = engine.ctx;

    this.bus = ctx.createGain();
    this.output = ctx.createGain();
    this.output.gain.value = this.volume;
    this.bus.connect(this.output);

    engine.transport.onStep((step, time) => this.onStep(step, time));
  }

  get groove(): Groove {
    return GROOVES[this.grooveIndex];
  }

  get anyLayerOn(): boolean {
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

  stopAll(): void {
    for (const k of Object.keys(this.layers) as DrumLayer[]) this.layers[k] = false;
    this.syncClock();
    this.engine.notify();
  }

  /** Run the clock only while something is actually playing. */
  private syncClock(): void {
    if (this.anyLayerOn) this.engine.ensureBeatClock();
    else this.engine.transport.stop();
  }

  /** Key of whatever is playing, so generated notes never fight the music. */
  private key(): { pc: number; mode: 'major' | 'minor' } {
    const anchor = this.engine.decks.find((d) => d.analysis);
    return {
      pc: anchor?.analysis?.keyPc ?? 9,
      mode: anchor?.analysis?.keyMode ?? 'minor',
    };
  }

  private rootHz(): number {
    return subRootHz(this.key().pc);
  }

  private onStep(step: number, time: number): void {
    const g = this.groove;
    const ctx = this.engine.ctx;
    if (step === 0) this.bar++;

    if (this.layers.kick && g.kick.includes(step)) kick(ctx, this.bus, time);
    if (this.layers.snare && g.snare.includes(step)) {
      if (g.snareVoice === 'clap') clap(ctx, this.bus, time);
      else snare(ctx, this.bus, time);
    }
    if (this.layers.hats) {
      if (g.hats.includes(step)) hat(ctx, this.bus, time);
      if (g.openHats.includes(step)) openHat(ctx, this.bus, time);
    }
    if (this.layers.bass && g.bass.includes(step)) {
      sub(ctx, this.bus, time, this.rootHz());
    }
    if (this.layers.melody && g.melody.includes(step)) {
      // Chord changes each bar, following a diatonic progression in the key of
      // whatever is playing — so this lands on top of a child's own song.
      const { pc, mode } = this.key();
      const prog = progressionFor(mode);
      const triad = triadSemitones(mode, prog[this.bar % prog.length]);
      stab(
        ctx,
        this.bus,
        time,
        triad.map((s) => hzFor(pc, s, 4)),
        (60 / (this.engine.transport.bpm || 120)) * 0.45,
        0.16
      );
    }
  }
}
