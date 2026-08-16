import type { AudioEngine } from './AudioEngine';
import type { Deck } from './Deck';
import type { DrumLayer } from './BeatMachine';
import type { VocalMode } from './types';
import { noiseBuffer, snare } from './drums';

/**
 * Performance macros — the moves that take a whole phrase to land.
 *
 * Fx is momentary: press, hold, release, all now-relative. These are the
 * opposite; each one is a small arrangement scheduled minutes-of-audio ahead on
 * the transport grid, so a single tap buys a riser, a cut, a silence and a slam
 * that all land on the beat.
 *
 * ONE WRITER PER PARAM. That rule is the whole design. Fx already owns
 * `fxGate.gain` (stutter parks its base at 0.5 and sums an oscillator into it;
 * drop writes absolutes on the same param), so a third writer there would
 * strand gains and click. Macros therefore writes only engine nodes that
 * nothing else touches — `macroGain`, `deckBus`, `deckDuck` and the drum
 * shaper — and multiplies with Fx's stage rather than fighting it. A drop under
 * a held stutter is still silent (0 x anything) and a lift under one peaks at
 * 1.35, not a runaway.
 *
 * Gain moves are absolute-time AudioParam automation, never timers, because
 * BeatMachine.syncClock() stops the shared transport the moment the last drum
 * layer goes off — which WILL happen mid-macro. Automation already on the
 * timeline does not care. Deck moves (seek, vocal mode, crossfade) do run from
 * timers, which is safe because `alignPhaseTo` corrects from the actual
 * playhead at the instant it runs: jitter is self-correcting, not cumulative.
 *
 * Decks are gated, never paused. A gated deck comes back exactly where it would
 * have been, so a drop reveals the song mid-phrase instead of rewinding it, and
 * no worklet resetStretch discontinuity is incurred.
 *
 * REQUIRES engine wiring (see AudioEngine): xfA/xfB -> deckDuck -> deckBus ->
 * sumBus, fxGate/delay -> macroGain -> masterGain, and beatMachine.output ->
 * drumLow -> drumDrive -> drumTrim -> sumBus.
 */

/** Exponential ramps cannot reach zero; ramp to this instead. */
const FLOOR = 0.0001;

/* ------------------------------------------------------------- big drop */
const DROP_RISE_BARS = 2;
/** Silence is quantised in BEATS, never seconds — 2 beats reads as intentional
 *  at 90 bpm and at 174, and the slam always lands on beat 3 of the bar. */
const DROP_SILENCE_BEATS = 2;
const DROP_LIFT_DB = 2.5;
/** Cut ramp: start just before the downbeat, reach zero just after it. */
const CUT_LEAD = 0.02;
const CUT_TAIL = 0.006;
const SLAM_FADE = 0.01;
/** Level the mix "inhales" to over the bar before the cut. */
const INHALE = 0.88;

/* --------------------------------------------------------------- bridge */
const BRIDGE_BARS = 4;

/* -------------------------------------------------------------- auto-mix */
const MIX_EASE_BARS = 2;
const EASE_TICK_MS = 100;
/** Fader position favouring the MUSIC deck. See `autoMix` for why that way. */
const MIX_XF_FAVOUR = 0.35;
const MIX_VOCAL_MID_DB = 5;
const MIX_MUSIC_MID_DB = -3;
/** Deeper scoop when the music deck is mono and cannot have its centre removed. */
const MIX_MONO_MID_DB = -6;
/** Shortest hook worth looping. Below this it reads as a stutter, not a chorus. */
const MIN_HOOK_SEC = 1;

/* ------------------------------------------------------------ bump boost */
const BUMP_SHELF_DB = 5;
/** -6 dB, paying back the drive's +7 dB of small-signal gain. */
const BUMP_TRIM = 0.5;
/** Sidechain floor 0.65, i.e. -3.7 dB under each kick. */
const BUMP_DEPTH = 0.35;
const DUCK_IN = 0.012;
/** tanh knee. */
const DRIVE_K = 2.2;
const DRIVE_POINTS = 1024;
/** Trim fade around the curve swap — an instant transfer-function change steps. */
const SWAP_FADE = 0.008;

const NOT_WIRED = 'Audio engine is not wired for macros yet';
const STILL_GOING = 'Hold on — that one is still going';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * clamp() is NOT NaN-safe — both comparisons are false for NaN, so it passes
 * straight through. Web Audio THROWS on a non-finite value or time, and a throw
 * here lands mid-schedule, AFTER the mute has been written and BEFORE the
 * watchdog is armed: the master gate parks at 0 and the whole app goes silent
 * until something happens to call releaseAll(). A DJ-surface number input
 * emptied to '' yields exactly this via parseFloat. Every caller-supplied number
 * goes through here first.
 */
const fin = (v: number | undefined, fb: number): number => (Number.isFinite(v) ? (v as number) : fb);

export type MacroName = 'drop' | 'mixAB' | 'mixBA' | 'bridge';
type MixName = 'mixAB' | 'mixBA';

/** What the tap did, in words a seven-year-old can read. No numbers, per KidsMode. */
export interface MacroResult {
  ok: boolean;
  note: string;
}

/** Everything auto-mix changes on a deck, so cancel can put it all back. */
interface DeckSnapshot {
  vocalMode: VocalMode;
  eqLowDb: number;
  eqMidDb: number;
  loop: boolean;
  loopStartSec: number | null;
  loopEndSec: number | null;
}

interface MixSnapshot {
  vocalDeck: Deck;
  musicDeck: Deck;
  vocal: DeckSnapshot;
  music: DeckSnapshot;
  crossfade: number;
  /** Drum layers the macro switched on, so it can switch them back off. */
  layers: DrumLayer[];
}

function snapshotDeck(deck: Deck): DeckSnapshot {
  return {
    vocalMode: deck.vocalMode,
    eqLowDb: deck.eqLowDb,
    eqMidDb: deck.eqMidDb,
    loop: deck.loop,
    loopStartSec: deck.loopStartSec,
    loopEndSec: deck.loopEndSec,
  };
}

export class Macros {
  /** The macro currently scheduled or latched, for lighting a button. */
  active: MacroName | null = null;
  bumpOn = false;
  /** Plain-language result of the last tap, for a toast or a caption. */
  lastNote = '';

  private engine: AudioEngine;
  /**
   * The latched auto-mix, kept apart from `active` so a one-shot fired on top of
   * a mix (a drop during a mix is the whole point) can hand `active` back
   * afterwards instead of silently un-latching the mix button.
   */
  private latch: MixName | null = null;
  private snap: MixSnapshot | null = null;

  private timers = new Set<number>();
  private easeTimer: number | null = null;
  /** Bump's curve-swap timer is deliberately OUTSIDE `timers`: cancel() clearing
   *  it would strand the drum trim at FLOOR, i.e. silent drums, forever. */
  private bumpTimer: number | null = null;
  private unsubSidechain: (() => void) | null = null;
  private bumpLayers: DrumLayer[] = [];
  private busyUntil = 0;
  /** Last crossfade value the ease itself set — anything else means a hand. */
  private expected = 0;
  /** Typed off WaveShaperNode so the Float32Array generic is not pinned here. */
  private driveCurve: WaveShaperNode['curve'] = null;
  private warned = false;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  private get ctx(): AudioContext {
    return this.engine.ctx;
  }

  /* --------------------------------------------------------------- state */

  /** True while a scheduled macro is still landing; the UI should grey the row. */
  get busy(): boolean {
    return this.engine.initialized && this.ctx.currentTime < this.busyUntil;
  }

  get mixActive(): 'AB' | 'BA' | null {
    if (this.latch === 'mixAB') return 'AB';
    if (this.latch === 'mixBA') return 'BA';
    return null;
  }

  /* ------------------------------------------------------------ big drop */

  /**
   * Tension into the next downbeat, a hole where the music was, then everything
   * back at once and slightly louder. The silence is what sells it — a half-beat
   * gate blink (what Fx.drop does) reads as a glitch, a whole musical bar of
   * nothing reads as the floor dropping out.
   */
  bigDrop(opts: { riseBars?: number; silenceBeats?: number; liftDb?: number } = {}): MacroResult {
    if (!this.wired()) return this.fail(NOT_WIRED);
    if (this.busy) return this.fail(STILL_GOING);

    const riseBars = clamp(Math.round(fin(opts.riseBars, DROP_RISE_BARS)), 1, 8);
    const silenceBeats = clamp(Math.round(fin(opts.silenceBeats, DROP_SILENCE_BEATS)), 1, 8);
    const lift = Math.pow(10, clamp(fin(opts.liftDb, DROP_LIFT_DB), 0, 4) / 20);

    // A grid to land on even with every drum layer off. Side effect worth
    // knowing: this starts the transport, so the KidsMode step dots wake up.
    this.engine.ensureBeatClock();

    const beat = this.beatSec();
    const bar = this.barSec();
    const now = this.ctx.currentTime + 0.02;
    const cut = this.downbeatAtLeast(riseBars * bar);
    const back = cut + silenceBeats * beat;

    // The analyser sits downstream of this gate, so the visualizer bars collapse
    // through the silence and slam back with the music. Free confirmation.
    const g = this.engine.macroGain.gain;
    // Armed BEFORE any mute-side automation: if anything below throws, the gate
    // still gets forced open. A stranded gate silences the entire app.
    this.watchdog(g, back + 0.4);
    this.holdAt(g, now);
    g.linearRampToValueAtTime(1, now + 0.02);
    g.setValueAtTime(1, Math.max(now + 0.03, cut - bar));
    g.linearRampToValueAtTime(INHALE, cut - CUT_LEAD);
    g.linearRampToValueAtTime(0, cut + CUT_TAIL);
    g.setValueAtTime(0, back - 0.004);
    this.slam(back, lift, null);

    // The lead time IS the ramp-in: a tap makes a sound immediately, so waiting
    // for a musical landing point never feels like a dead button.
    this.riser(now, cut);
    if (riseBars >= 2) this.fill(cut - 2 * beat, cut);
    this.downlifter(cut);

    this.active = 'drop';
    this.busyUntil = back + 0.05;
    this.after(back - this.ctx.currentTime + 0.06, () => {
      this.active = this.latch;
      this.engine.notify();
    });
    return this.ok('Here it comes…');
  }

  /* ------------------------------------------------------------ auto-mix */

  /** Deck A's chorus vocal over deck B's beats. */
  autoMixAOverB(): MacroResult {
    return this.autoMix(this.engine.decks[0], this.engine.decks[1], 'mixAB');
  }

  /** The mirror: deck B's chorus vocal over deck A's beats. */
  autoMixBOverA(): MacroResult {
    return this.autoMix(this.engine.decks[1], this.engine.decks[0], 'mixBA');
  }

  private autoMix(vocal: Deck | undefined, music: Deck | undefined, name: MixName): MacroResult {
    if (!this.wired()) return this.fail(NOT_WIRED);
    // Un-latch before every other guard: a second tap on a lit button has to be
    // able to undo it even while the ease is still moving.
    if (this.latch === name) {
      this.cancel();
      return this.ok('Back to normal');
    }
    if (this.busy) return this.fail(STILL_GOING);
    if (!vocal || !music || vocal === music) return this.fail('I need two decks');
    if (!vocal.loaded && !music.loaded) return this.fail('Load a song first');
    if (this.active || this.latch) this.cancel();

    // With a deck empty the beat machine stands in for it, so the button still
    // does the thing it promises rather than half of it.
    const layers = vocal.loaded && music.loaded ? [] : this.ensureDrums();

    this.snap = {
      vocalDeck: vocal,
      musicDeck: music,
      vocal: snapshotDeck(vocal),
      music: snapshotDeck(music),
      crossfade: this.engine.crossfade,
      layers,
    };

    const at = this.downbeatAtLeast(0.12);
    this.active = name;
    this.latch = name;
    this.busyUntil = at + 0.05;
    this.after(at - this.ctx.currentTime, () => this.applyMix(name));

    // applyMix replaces this with the final truth once it can see whether the
    // hook and the centre-cancel actually worked out.
    return this.ok(
      music.loaded
        ? 'Vocals on top, beats underneath'
        : 'No second song, so the drum machine is playing the beats'
    );
  }

  private applyMix(name: MixName): void {
    // Cancelled while we waited.
    if (this.latch !== name || !this.snap) return;
    const { vocalDeck: vocal, musicDeck: music, music: musicWas, vocal: vocalWas } = this.snap;
    const notes: string[] = [];

    if (music.loaded && !music.playing) music.play();

    if (vocal.loaded) {
      const a = vocal.analysis;
      const hookUsable =
        !!a &&
        Number.isFinite(a.hookStartSec) &&
        Number.isFinite(a.hookLengthSec) &&
        a.hookLengthSec >= MIN_HOOK_SEC;
      if (hookUsable) {
        vocal.playHook();
      } else {
        if (!vocal.playing) vocal.play();
        notes.push('That song has no chorus I can find, so it just plays');
      }
      // 'vocals' taps the MID (0.5L + 0.5R), which on a mono file is simply the
      // signal, band-limited. So unlike 'music' this direction is never blocked
      // and the vocal deck degrades to "a bit thin", not "silent".
      vocal.setVocalMode('vocals');
      vocal.setEq('mid', vocalWas.eqMidDb + MIX_VOCAL_MID_DB);
    }

    if (music.loaded) {
      if (music.canRemoveVocals) {
        music.setVocalMode('music');
        music.setEq('mid', musicWas.eqMidDb + MIX_MUSIC_MID_DB);
      } else {
        // Nothing to cancel, so carve the pocket with EQ instead — the vocal
        // still needs somewhere to sit.
        music.setEq('mid', musicWas.eqMidDb + MIX_MONO_MID_DB);
        notes.push('That song is mono, so I dipped its middle instead of taking the singing out');
      }
    }

    if (vocal.loaded && music.loaded) {
      // The button promises beat-locked, so lock regardless of the assist
      // toggle. matchTempo deliberately does neither of these itself.
      vocal.matchTempo(music);
      vocal.alignPhaseTo(music);
      this.engine.syncBeatTempo();
    }

    // Favour the MUSIC deck, which is the counter-intuitive half of this macro.
    // applyBassSwap ducks side A's lows above fader 0.35 and side B's below
    // 0.65, so pulling the fader toward the VOCAL deck would strip 15 dB of low
    // end off the deck we want the beats from. At 0.35/0.65 the music deck keeps
    // its whole kick and the vocal deck loses lows it does not have — pathVocals
    // is bandpassed at 1400 Hz. The vocal comes forward on mid gain instead.
    const front = music.loaded ? music : vocal;
    const target = front.crossfadeSide === 'A' ? MIX_XF_FAVOUR : 1 - MIX_XF_FAVOUR;
    this.easeCrossfade(target, MIX_EASE_BARS * this.barSec());

    notes.unshift(music.loaded ? 'Vocals on top, beats underneath' : 'Drums are carrying the beats');
    this.lastNote = notes.join('. ');
    this.engine.notify();
  }

  /* -------------------------------------------------------------- bridge */

  /**
   * Hand the room to the drums for a few bars and bring the songs back on a
   * downbeat. The decks are gated rather than paused, so they advance exactly
   * `bars` bars while they are away and the return is phrase-aligned by
   * construction — no seek, no guessing.
   */
  bridge(bars = BRIDGE_BARS): MacroResult {
    if (!this.wired()) return this.fail(NOT_WIRED);
    if (this.busy) return this.fail(STILL_GOING);

    const n = clamp(Math.round(fin(bars, BRIDGE_BARS)), 1, 16);
    // Turn drums on first: setLayer starts the transport, and every time below
    // is measured off that grid.
    const layers = this.ensureDrums();

    const beat = this.beatSec();
    const bar = this.barSec();
    const now = this.ctx.currentTime + 0.02;
    const out = this.downbeatAtLeast(0.12);
    const back = out + n * bar;

    if (out - now >= 0.25) this.riser(now, out);

    // Songs out on the deck bus only. The drums sit downstream of it, on the sum
    // bus, so they are untouched by this — that separation is the macro.
    const db = this.engine.deckBus.gain;
    // Armed before the mute, for the same reason as bigDrop: a throw between the
    // two would leave the songs ducked to silence with nothing to restore them.
    this.watchdog(db, back + 0.4);
    this.holdAt(db, now);
    db.linearRampToValueAtTime(1, now + 0.02);
    const from = Math.max(now + 0.03, out - 0.04);
    db.setValueAtTime(1, from);
    db.linearRampToValueAtTime(0, Math.max(out, from + 0.01));

    this.riser(Math.max(out, back - 2 * bar), back);
    this.fill(back - 2 * beat, back);
    this.slam(back, Math.pow(10, DROP_LIFT_DB / 20), db);

    this.active = 'bridge';
    this.busyUntil = back + 0.05;
    this.after(back - this.ctx.currentTime + 0.06, () => {
      this.active = this.latch;
      this.restoreLayers(layers);
      this.engine.notify();
    });
    return this.ok('Drums take over, then everyone comes back');
  }

  /* ---------------------------------------------------------- bump boost */

  /**
   * Makes the beats powerful: low shelf on the drum bus, soft-clip drive to give
   * the transients weight, and a kick-keyed duck on the songs so the beat punches
   * a hole rather than fighting for one.
   *
   * Peak-safe by construction — -6 dB of trim pays back the drive's small-signal
   * gain, so the peak level barely moves and the limiter is the net, not the
   * operating point.
   */
  setBump(on: boolean): void {
    // Already-there check first, so releaseAll()'s setBump(false) on a cold
    // engine is a silent no-op rather than a warning about nothing.
    if (on === this.bumpOn) return;
    if (!this.wired()) return;
    const e = this.engine;
    const t = this.ctx.currentTime;
    const trim = e.drumTrim.gain;

    e.drumLow.gain.setTargetAtTime(on ? BUMP_SHELF_DB : 0, t, 0.05);

    // Swapping a WaveShaper curve is an instantaneous change of transfer
    // function, i.e. a level step. Fade the trim through the swap instead.
    if (this.bumpTimer !== null) window.clearTimeout(this.bumpTimer);
    this.holdAt(trim, t + 0.001);
    trim.linearRampToValueAtTime(FLOOR, t + 0.001 + SWAP_FADE);
    this.bumpTimer = window.setTimeout(() => {
      this.bumpTimer = null;
      e.drumDrive.curve = on ? this.curve() : null;
      const t2 = this.ctx.currentTime;
      trim.setValueAtTime(FLOOR, t2);
      trim.linearRampToValueAtTime(on ? BUMP_TRIM : 1, t2 + SWAP_FADE);
    }, (0.002 + SWAP_FADE) * 1000);

    if (on) {
      // A button that does nothing is the worst failure this could have.
      this.bumpLayers = this.ensureDrums();
      this.unsubSidechain = e.transport.onStep(this.onSidechainStep);
      this.bumpOn = true;
    } else {
      // BeatMachine never unsubscribes from the transport; Macros must, or every
      // toggle leaks a handler.
      this.unsubSidechain?.();
      this.unsubSidechain = null;
      this.bumpOn = false;
      const layers = this.bumpLayers;
      this.bumpLayers = [];
      this.restoreLayers(layers);
      const duck = e.deckDuck.gain;
      this.holdAt(duck, t + 0.001);
      duck.linearRampToValueAtTime(1, t + 0.031);
    }
    e.notify();
  }

  toggleBump(): void {
    this.setBump(!this.bumpOn);
  }

  /**
   * Sidechain, keyed off the groove rather than an envelope follower — Web Audio
   * has no sidechain input on DynamicsCompressorNode, and the pattern is known
   * ahead of time anyway.
   *
   * Both ramps are scheduled atomically at kick time so the param returns to 1
   * on its own: stopping the transport mid-duck cannot strand the songs quiet.
   */
  private onSidechainStep = (step: number, time: number): void => {
    if (!this.bumpOn) return;
    const bm = this.engine.beatMachine;
    if (!bm.layers.kick || !bm.groove.kick.includes(step)) return;

    const stepDur = this.engine.transport.stepDuration;
    if (!(stepDur > 0.005 && stepDur < 0.5)) return; // nonsense bpm: skip, do not schedule garbage

    // The release has to finish before the NEXT kick ducks, or that duck's
    // anchoring setValueAtTime(1) lands mid-ramp and steps 3.7 dB in one block.
    // Trap at 174 bpm is the worst case: a 2-sixteenth gap leaves 23% margin.
    let gapSteps = 16;
    for (const k of bm.groove.kick) {
      const d = (((k - step) % 16) + 16) % 16;
      if (d > 0 && d < gapSteps) gapSteps = d;
    }
    const release = clamp(gapSteps * stepDur * 0.7, 0.05, 0.22);

    const g = this.engine.deckDuck.gain;
    g.setValueAtTime(1, time - 0.004);
    g.linearRampToValueAtTime(1 - BUMP_DEPTH, time + DUCK_IN);
    g.linearRampToValueAtTime(1, time + DUCK_IN + release);
    // Deliberately no notify() — this runs 4-16 times a second.
  };

  /** tanh soft clip, normalised so full scale stays full scale. Odd, so no DC. */
  private curve(): NonNullable<WaveShaperNode['curve']> {
    if (this.driveCurve) return this.driveCurve;
    const c = new Float32Array(DRIVE_POINTS);
    const norm = Math.tanh(DRIVE_K);
    const half = (DRIVE_POINTS - 1) / 2;
    for (let i = 0; i < DRIVE_POINTS; i++) {
      c[i] = Math.tanh(DRIVE_K * (i / half - 1)) / norm;
    }
    this.driveCurve = c;
    return c;
  }

  /* --------------------------------------------------------------- teardown */

  /** Stop and restore everything scheduled or latched. Leaves bump alone. */
  cancel(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.stopEase();

    this.active = null;
    this.latch = null;
    this.busyUntil = 0;
    if (!this.nodesWired()) {
      this.snap = null;
      return;
    }

    const t = this.ctx.currentTime + 0.005;
    for (const p of [
      this.engine.macroGain.gain,
      this.engine.deckBus.gain,
      this.engine.deckDuck.gain,
    ]) {
      this.holdAt(p, t);
      p.linearRampToValueAtTime(1, t + 0.03);
    }

    if (this.snap) {
      const s = this.snap;
      this.snap = null;
      this.restoreDeck(s.vocalDeck, s.vocal);
      this.restoreDeck(s.musicDeck, s.music);
      this.restoreLayers(s.layers);
      this.easeCrossfade(s.crossfade, this.barSec());
    }
    this.engine.notify();
  }

  /** cancel() plus the bump toggle — mirrors Fx.releaseAll's contract. */
  releaseAll(): void {
    this.cancel();
    this.setBump(false);
  }

  private restoreDeck(deck: Deck, s: DeckSnapshot): void {
    deck.setVocalMode(s.vocalMode);
    deck.setEq('low', s.eqLowDb);
    deck.setEq('mid', s.eqMidDb);
    // Region before flag: a region only bites while loop is true.
    deck.setLoopRegion(s.loopStartSec, s.loopEndSec);
    deck.setLoop(s.loop);
  }

  /* ---------------------------------------------------------------- timing */

  /**
   * bpm sanitised in exactly one place. A zero or NaN bpm would make every beat
   * length Infinity and schedule the slam at the end of time.
   */
  private bpm(): number {
    const b = this.engine.transport?.bpm;
    return Number.isFinite(b) && b >= 40 && b <= 220 ? b : 120;
  }

  private beatSec(): number {
    return 60 / this.bpm();
  }

  private barSec(): number {
    return this.beatSec() * 4;
  }

  /**
   * The next downbeat at least `minAheadSec` away.
   *
   * Never ask Transport.nextDownbeatTime for a long lead: it walks only two bars
   * of steps and then falls through to `now + minLeadSec`, which is NOT a
   * downbeat. Ask for the next one and add whole bars here instead.
   */
  private downbeatAtLeast(minAheadSec: number): number {
    const tr = this.engine.transport;
    const now = this.ctx.currentTime;
    const bar = this.barSec();
    let d = tr.running ? tr.nextDownbeatTime(0.06) : now + 0.06;
    for (let i = 0; i < 16 && d - now < minAheadSec; i++) d += bar;
    return d;
  }

  /**
   * Re-arm a param without a click. cancelScheduledValues alone reverts to the
   * previous event's value, which steps; cancelAndHold keeps where the ramp
   * actually is.
   *
   * The fallback reads `param.value`, which is only the value NOW — so every
   * caller must pass a `t` at or just after ctx.currentTime. Holding at a
   * distant future time would mis-anchor on browsers without cancelAndHold.
   */
  private holdAt(p: AudioParam, t: number): void {
    const q = p as AudioParam & { cancelAndHoldAtTime?: (when: number) => void };
    if (typeof q.cancelAndHoldAtTime === 'function') {
      q.cancelAndHoldAtTime(t);
    } else {
      const v = p.value;
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
    }
  }

  /** Tracked setTimeout, removed from the set as it fires. */
  private after(sec: number, fn: () => void): void {
    const id = window.setTimeout(
      () => {
        this.timers.delete(id);
        fn();
      },
      Math.max(0, sec) * 1000
    );
    this.timers.add(id);
  }

  /**
   * Silence is the worst thing this file could leave behind, so every scheduled
   * slam is checked afterwards and forced home if an exception got between the
   * cut and the return.
   */
  private watchdog(p: AudioParam, at: number): void {
    this.after(at - this.ctx.currentTime, () => {
      if (p.value >= 0.5) return;
      const t = this.ctx.currentTime + 0.005;
      this.holdAt(p, t);
      p.linearRampToValueAtTime(1, t + 0.03);
      console.warn('[macros] a gate was still down after a macro; forced back up');
    });
  }

  /* ------------------------------------------------------------- the parts */

  /**
   * The return, shared by the drop and the bridge so both land identically.
   * `gate` is whatever was holding the sound down — null for a drop, where
   * macroGain is already doing it and the caller owns the cut side.
   * Only ever writes events at or after `t`.
   */
  private slam(t: number, lift: number, gate: AudioParam | null): void {
    const beat = this.beatSec();
    const bar = this.barSec();
    const mg = this.engine.macroGain.gain;

    if (gate) {
      // A bridge gated the DECKS, so the master stage still needs arming here.
      gate.setValueAtTime(0, t - 0.004);
      gate.linearRampToValueAtTime(1, t + SLAM_FADE);
      this.holdAt(mg, this.ctx.currentTime + 0.005);
      mg.setValueAtTime(1, t - 0.004);
    }
    mg.linearRampToValueAtTime(lift, t + SLAM_FADE);
    mg.setValueAtTime(lift, t + 2 * beat); // hold the lift half a bar
    mg.exponentialRampToValueAtTime(1, t + 2 * bar); // then ease home
    this.impact(t);
  }

  /**
   * Tension from `t0` to `t1`. Fx.build does the same job but is now-relative;
   * a scheduled macro needs a future `when`, hence the private copy.
   */
  private riser(t0: number, t1: number): void {
    const dur = t1 - t0;
    if (dur < 0.25) return;
    const ctx = this.ctx;
    const dest = this.engine.oneShotBus;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3.2;
    bp.frequency.setValueAtTime(220, t0);
    bp.frequency.exponentialRampToValueAtTime(7800, t1);

    const g = ctx.createGain();
    g.gain.setValueAtTime(FLOOR, t0);
    g.gain.exponentialRampToValueAtTime(0.34, t1);
    g.gain.linearRampToValueAtTime(FLOOR, t1 + 0.1);

    src.connect(bp).connect(g).connect(dest);
    src.start(t0);
    src.stop(t1 + 0.15);

    // A rising sine under the noise: the noise is the texture, this is the pitch
    // the ear actually follows up.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(220, t0);
    o.frequency.exponentialRampToValueAtTime(880, t1);
    const og = ctx.createGain();
    og.gain.setValueAtTime(FLOOR, t0);
    og.gain.exponentialRampToValueAtTime(0.1, t1);
    og.gain.linearRampToValueAtTime(FLOOR, t1 + 0.03);
    o.connect(og).connect(dest);
    o.start(t0);
    o.stop(t1 + 0.05);
  }

  /** Eight accelerating snares into the hit — the last bar of a build. */
  private fill(t0: number, t1: number): void {
    const step = (t1 - t0) / 8;
    if (step < 0.01) return;
    for (let i = 0; i < 8; i++) {
      snare(this.ctx, this.engine.oneShotBus, t0 + i * step, 0.18 + i * 0.05);
    }
  }

  /**
   * Falling noise sweep on the cut. Without it the silence reads as a crash;
   * with it, as a decision. Short enough to leave real silence behind it even at
   * 174 bpm with the shortest gap.
   */
  private downlifter(t: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(5000, t);
    bp.frequency.exponentialRampToValueAtTime(220, t + 0.28);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + 0.28);

    src.connect(bp).connect(g).connect(this.engine.oneShotBus);
    src.start(t, Math.random());
    src.stop(t + 0.32);
  }

  /** Sub thump plus a noise crash. Fx.impact is private and now-relative. */
  private impact(t: number): void {
    const ctx = this.ctx;
    const dest = this.engine.oneShotBus;

    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
    og.gain.setValueAtTime(0.7, t);
    og.gain.exponentialRampToValueAtTime(FLOOR, t + 0.7);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + 0.75);

    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.32, t);
    ng.gain.exponentialRampToValueAtTime(FLOOR, t + 1.1);
    n.connect(hp).connect(ng).connect(dest);
    n.start(t, Math.random());
    n.stop(t + 1.15);
  }

  /* ------------------------------------------------------------- the fader */

  /**
   * Cosine ease through engine.setCrossfade rather than straight onto xfA/xfB.
   * Those are private, and more importantly `engine.crossfade` is the number the
   * on-screen fader mirrors — automating the nodes behind it would make the
   * fader lie about where the mix is.
   */
  private easeCrossfade(to: number, durSec: number): void {
    this.stopEase();
    const from = this.engine.crossfade;
    if (durSec <= 0 || Math.abs(to - from) < 0.002) {
      this.engine.setCrossfade(to);
      return;
    }
    const t0 = this.ctx.currentTime;
    this.expected = from;
    this.easeTimer = window.setInterval(() => {
      // Hands win. If the number moved without us, someone grabbed the fader.
      if (Math.abs(this.engine.crossfade - this.expected) > 0.01) {
        this.stopEase();
        this.lastNote = 'You took over the fader';
        this.engine.notify();
        return;
      }
      const u = clamp((this.ctx.currentTime - t0) / durSec, 0, 1);
      const k = 0.5 - 0.5 * Math.cos(Math.PI * u); // no velocity step at either end
      this.engine.setCrossfade(u >= 1 ? to : from + (to - from) * k);
      this.expected = this.engine.crossfade;
      if (u >= 1) this.stopEase();
    }, EASE_TICK_MS);
  }

  private stopEase(): void {
    if (this.easeTimer === null) return;
    window.clearInterval(this.easeTimer);
    this.easeTimer = null;
  }

  /* --------------------------------------------------------------- drums */

  /** Guarantee a beat and a running clock. Returns the layers it switched on. */
  private ensureDrums(): DrumLayer[] {
    const bm = this.engine.beatMachine;
    if (bm.anyLayerOn) {
      this.engine.ensureBeatClock();
      return [];
    }
    const added: DrumLayer[] = ['kick', 'snare', 'hats'];
    for (const l of added) bm.setLayer(l, true); // setLayer starts the transport
    return added;
  }

  private restoreLayers(layers: DrumLayer[]): void {
    // Bump needs a kick to duck against, so leave the drums up while it is on.
    if (!layers.length || this.bumpOn) return;
    for (const l of layers) this.engine.beatMachine.setLayer(l, false);
  }

  /* --------------------------------------------------------------- guards */

  private nodesWired(): boolean {
    const e = this.engine;
    return !!(
      e.initialized &&
      e.macroGain &&
      e.deckBus &&
      e.deckDuck &&
      e.drumLow &&
      e.drumDrive &&
      e.drumTrim
    );
  }

  /**
   * AudioEngine declares the macro nodes with definite assignment, so one that
   * was never created is `undefined` with no type error anywhere. This runtime
   * check is the only place that mistake can surface — hence the warning.
   */
  private wired(): boolean {
    if (this.nodesWired()) return true;
    if (!this.warned) {
      this.warned = true;
      console.warn(
        '[macros] AudioEngine is missing the macro nodes (macroGain / deckBus / deckDuck / drum bus) — macros are inert until they are wired.'
      );
    }
    return false;
  }

  /** Both of these notify, so "arm the macro, then tell React" is one thing. */
  private ok(note: string): MacroResult {
    this.lastNote = note;
    this.engine.notify();
    return { ok: true, note };
  }

  private fail(note: string): MacroResult {
    this.lastNote = note;
    this.engine.notify();
    return { ok: false, note };
  }
}
