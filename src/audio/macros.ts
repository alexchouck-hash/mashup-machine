import type { AudioEngine } from './AudioEngine';
import type { Deck } from './Deck';
import type { PlatterLease } from './platter';
import type { DrumLayer } from './BeatMachine';
import type { VocalMode } from './types';
import { metalBuffer, noiseBuffer, snare } from './drums';

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
 * ── WHAT THE BUILD AND THE DROPS DO TO THE MUSIC ──────────────────────────
 * The owner's complaint was that the build was "useless" and the drop was not
 * cool enough, and both had the same cause: they were LAYERS OVER unchanged
 * music. A riser on top of a track that never changes is a sound effect, not
 * tension. So everything here now acts on the tracks themselves:
 *
 *   build   — the decks' own high-pass climbs until the low end has evaporated
 *             (Deck.setFilter), a snare roll doubles every bar, a noise riser
 *             and a reverse-cymbal swell come up under it, and the last two
 *             beats push the decks 1.5% faster. All of it lands on a downbeat.
 *   classic — the build, then the master gate cuts to a hole and the mix slams
 *             back louder. The decks additionally duck and filter on the way in,
 *             so the hole is something the MUSIC fell into.
 *   tapestop— the records physically wind down to a halt, pitch falling with
 *             speed, then slam back at full speed.
 *   reverse — the records are pulled BACKWARDS into the downbeat, accelerating,
 *             then slam forward.
 *
 * THE LAST TWO REUSE THE SCRATCH ENGINE. stretch-processor.js is a general
 * signed-rate player: a tape stop is `velocity -> 0`, a suck-back is
 * `velocity -> negative`. There is no second engine here, only an envelope
 * posted at 50 Hz into the one that already exists. What we do own is the
 * bookkeeping the platter cannot do for itself — a stranded platter is a deck
 * that reads as playing and makes no sound, so every grab is released by a
 * scheduled timer, by a redundant safety timer 1 s later, and by cancel().
 *
 * REQUIRES engine wiring (see AudioEngine): xfA/xfB -> deckDuck -> deckBus ->
 * sumBus, fxGate/delay -> macroGain -> masterGain, and beatMachine.output ->
 * drumLow -> drumDrive -> drumTrim -> sumBus.
 *
 * OPTIONAL engine wiring, detected at runtime: deckLow -> deckPre -> deckDrive
 * ahead of deckDuck gives bump boost a low shelf and a saturator on the SONGS as
 * well as the drums. Absent, bump still lifts and pumps the deck path through
 * deckDuck alone — see `setBump`.
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
/** How far the SONGS recede under the roll before the classic cut. -2.8 dB. */
const DROP_DECK_DIP = 0.72;

/* ---------------------------------------------------------------- build */
const BUILD_BARS = 4;
/**
 * Top of the deck high-pass sweep as a `Deck.setFilter` knob position.
 * setFilter maps the knob exponentially over 20 Hz - 4 kHz, so 0.86 is
 * 20 * 200^0.86 = 1.9 kHz: the low end is gone and the track is still there.
 * A full 1.0 (4 kHz) leaves a telephone, which reads as broken rather than tense.
 */
const BUILD_HP_TOP = 0.86;
/** Tension accelerates. u^1.6 puts two thirds of the sweep in the last bar. */
const BUILD_HP_SHAPE = 1.6;
/**
 * Sweep tick. Deck.setFilter glides each write with a 10 ms setTargetAtTime, so
 * 50 ms steps merge into a continuous sweep (each step is a 3.4% frequency move
 * over a 4-bar build, well under the 10 ms glide). It is also a fifth of the
 * React churn a 60 Hz sweep would cost — setFilter notifies, and Deck.scratchMove
 * documents why per-frame notifies are the thing to avoid here.
 */
const SWEEP_TICK_MS = 50;
/** Accelerando into the landing. 1.5% is under a quarter semitone of tempo. */
const BUILD_TEMPO_PCT = 1.5;
/** Fraction of the build over which that accelerando happens. */
const RISE_FROM = 0.82;
/** Snare-roll level at the start and the end. fill() runs 0.18 - 0.53 into the
 *  same bus with the same voice, so this is the range already proven safe. */
const ROLL_GAIN_LO = 0.16;
const ROLL_GAIN_HI = 0.46;
/** Extra trim on the 1/32 bar, where ~5 snare tails overlap (see `rollBar`). */
const ROLL_DENSE_TRIM = 0.85;
/** Hits per beat, bar by bar: 1/4 -> 1/8 -> 1/16 -> 1/32. */
const ROLL_DIVISIONS = [1, 2, 4, 8];
/** Peak of the reverse swell's noise bed and of its cymbal layer. */
const SWELL_NOISE_PEAK = 0.16;
const SWELL_METAL_PEAK = 0.12;
/** Hands win: how far a knob may drift from what we wrote before we let go. */
const HAND_EPS_FILTER = 0.02;
const HAND_EPS_TEMPO = 0.05;

/* ----------------------------------------------- tape stop / suck-back */
/** Beats the records take to wind down, and to be pulled back. */
const STOP_BEATS = 2;
const REV_BEATS = 2;
/** v = rate * (1-u)^1.6. The worklet's own gate closes under |v| = 0.02, which
 *  this curve reaches at u = 0.913 — the record is silent for the last 9% of the
 *  wind-down, so the downbeat arrives on real silence rather than on a drone. */
const STOP_SHAPE = 1.6;
/** v = rate * (1 - 2.4 * u^0.8): forward, through zero at u = 0.333, then
 *  accelerating backwards to -1.4x. Speed rising IS the pitch rising. */
const REV_DEPTH = 2.4;
const REV_SHAPE = 0.8;
/** Velocity tick. The worklet smooths velTarget with a 12 ms one-pole while a
 *  "finger" is down, so 20 ms steps arrive already-smoothed and never zipper. */
const SCRATCH_TICK_MS = 20;
/** Spin-up lead. vel is that same 12 ms one-pole: 45 ms is 97.6% of full speed. */
const SPIN_LEAD = 0.045;
/** Track seconds a platter covers during it, R*[T - tau*(1-e^-T/tau)] / R. The
 *  catch-up seek subtracts this so the record arrives at the RIGHT BAR. */
const SPIN_ADVANCE = 0.0333;
/** Hand the platter back to WSOLA once it is up to speed, not before. */
const SPIN_TAIL = 0.06;
/** A suck-back needs somewhere to go; the head of a track is a wall. */
const REV_MIN_POS = 2;

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
const DUCK_IN = 0.012;
/** tanh knee, shared by the drum and the deck shaper. */
const DRIVE_K = 2.2;
const DRIVE_POINTS = 1024;
/** Trim fade around the curve swap — an instant transfer-function change steps. */
const SWAP_FADE = 0.008;
/**
 * BUMP ON THE TRACKS — the headroom maths, derived the way drums.ts derives its.
 *
 * The budget is exact and small: masterGain is MASTER_HEADROOM 0.5 and the
 * limiter threshold is -3 dBFS (0.708), so a deck peaking at full scale arrives
 * at 0.5 — 3.0 dB under the limiter. That 3.0 dB is the entire allowance, and
 * spending more of it means the master limiter starts ducking the songs on every
 * kick, which is the exact failure drums.ts's LEVELS block exists to prevent.
 *
 * Chain, when AudioEngine provides it: deckLow -> deckPre -> deckDrive -> deckDuck.
 *   deckLow   +4.0 dB lowshelf at 80 Hz. An RBJ lowshelf with S = 1 is monotone,
 *             so its steady-state magnitude never exceeds the shelf gain: worst
 *             case peak factor 1.585, on bass-dominated material.
 *   deckPre   0.5 (-6.0 dB). Pays back the shelf's 4 dB and keeps 2 dB spare for
 *             a transient, whose peak gain through a filter exceeds the
 *             steady-state bound. Worst case into the shaper: 1.0 x 1.585 x 0.5
 *             = 0.792 steady, 0.951 with a 1.2x transient overshoot — under 1.0,
 *             which is the number that matters, because Web Audio CLAMPS a
 *             WaveShaper input past +-1 and that is the only hard edge here.
 *   deckDrive the same normalised tanh (k = 2.2) the drums use. y(+-1) = +-1, so
 *             THE PEAK CANNOT RISE; it only fills in underneath. Small-signal
 *             +7.06 dB, which is what pays the -6 dB pre back at listening level.
 *   deckDuck  base 1.25 (+1.94 dB makeup), sidechained to 0.66 on each kick —
 *             a 5.55 dB pump, against 3.61 dB below unbumped unity.
 *
 * It sits AFTER the shaper deliberately: ducking into a saturator would make the
 * saturator fight the duck and flatten the pump, which is the whole effect.
 *
 * Net at the limiter, worst case: 1.0 x 1.585 x 0.5 -> 0.792 -> shaper 0.964 ->
 * x1.25 = 1.205 -> x0.5 master = 0.603 against 0.708. **1.40 dB of margin**, and
 * 1.13 dB on the 1.2x transient case (0.621). On the kick itself it is 7.0 dB.
 * At listening level (0.3) the low band comes out +6.23 dB and the mids +2.67 dB.
 *
 * WITHOUT those nodes only deckDuck exists, so bump gives the songs the makeup
 * and the pump and nothing else: peak 1.0 x 1.25 x 0.5 = 0.625, 1.08 dB under
 * the limiter. Both paths are safe on the same arithmetic, which is why the same
 * two constants serve both.
 *
 * KNOWN EDGE: auto-gain may add up to +12 dB, so a quiet, dynamic track can leave
 * the deck above full scale. It is already over the limiter there; with bump on
 * it additionally saturates into the shaper's flat region — d/dx of the
 * normalised tanh at x = 1 is k(1 - tanh²k)/tanh k = 0.108, a twentieth of its
 * small-signal 2.255, so it is graceful compression rather than a hard corner.
 * That is drive doing its job on a signal that was already too hot, not a new
 * failure.
 */
const DECK_SHELF_DB = 4;
const DECK_SHELF_HZ = 80;
const DECK_PRE = 0.5;
/** Top of the sidechain, i.e. the songs between kicks. +1.9 dB. */
const BUMP_BASE = 1.25;
/** Bottom of it. -5.6 dB under the base, -3.6 dB under unbumped unity. */
const BUMP_FLOOR = 0.66;
/**
 * The deck shaper's curve swap dips the songs instead of muting them. The drums
 * can be muted for 10 ms because they are percussive; sustained music cannot,
 * so it ducks 20 dB instead.
 *
 * What is left is a transfer-function step of the shaper's small-signal gain,
 * +7.06 dB, landing on a signal already 20 dB down — so the artifact itself sits
 * ~13 dB under nominal, and the drums are stepping at that same instant to mask
 * it. Either side of the dip the change is far smaller: DECK_PRE (-6.02 dB)
 * against that +7.06 dB is a net 1.04 dB, which is the whole reason the pre-trim
 * is there.
 */
const SWAP_DIP = 0.1;

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

export type MacroName = 'drop' | 'build' | 'mixAB' | 'mixBA' | 'bridge';
type MixName = 'mixAB' | 'mixBA';

/** The three drops. `bigDrop()` is kept as an alias for 'classic'. */
export type DropKind = 'classic' | 'tapestop' | 'reverse';

export interface DropOptions {
  riseBars?: number;
  silenceBeats?: number;
  liftDb?: number;
  /** Beats the records spend winding down or being pulled back. */
  grabBeats?: number;
}

const DROP_NOTE: Record<DropKind, string> = {
  classic: 'Here it comes…',
  tapestop: 'Winding the records down…',
  reverse: 'Sucking it backwards…',
};

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

/**
 * A deck under a build. `wrote` is what WE last set; if the live value has moved
 * away from it, a hand is on the control and restore leaves it alone.
 */
interface TensionSnapshot {
  deck: Deck;
  filterKnob: number;
  tempoPercent: number;
  wroteFilter: number;
  wroteTempo: number;
}

/**
 * A platter this macro is holding, and the clock it was grabbed against.
 *
 * `rate` used to live here too and is gone: the lease speaks in SPIN FRACTION —
 * a multiple of each deck's own normal speed — so the wind-down envelope already
 * IS a fraction and each deck multiplies by its own nominalRate at the door.
 * spinUp's virtual playhead reads `deck.nominalRate` live instead, which is also
 * more honest, since a tempo fader can move during a two-beat wind-down.
 */
interface HeldDeck {
  deck: Deck;
  /** Playhead at the grab, and the ctx time of that reading. Together they are a
   *  virtual playhead the stalled record can be caught back up to. */
  posAtGrab: number;
  grabAt: number;
}

/** The optional deck-path shaper. See the headroom block above. */
interface DeckShaper {
  deckLow: BiquadFilterNode;
  deckPre: GainNode;
  deckDrive: WaveShaperNode;
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
  /** Which drop is landing, so three pads can light independently. */
  dropKind: DropKind | null = null;
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
  /**
   * Build timers live apart from `timers` so a drop can end the BUILD's
   * scheduled work (it replaces it) without cancelling the drop it is part of.
   */
  private tensionTimers = new Set<number>();
  /** The one armed silence-check per param. See `watchdog` for why only one. */
  private watchdogs = new Map<AudioParam, number>();
  private easeTimer: number | null = null;
  private sweepTimer: number | null = null;
  private scratchTimer: number | null = null;
  /** Bump's curve-swap timer is deliberately OUTSIDE `timers`: cancel() clearing
   *  it would strand the drum trim at FLOOR, i.e. silent drums, forever. */
  private bumpTimer: number | null = null;
  private unsubSidechain: (() => void) | null = null;
  private bumpLayers: DrumLayer[] = [];
  private busyUntil = 0;
  /** Last crossfade value the ease itself set — anything else means a hand. */
  private expected = 0;
  private tensed: TensionSnapshot[] = [];
  private held: HeldDeck[] = [];
  /** Our claim on the platters. Null means we may not move a record at all. */
  private lease: PlatterLease | null = null;
  /** True once the wind-down envelope is finished and spinUp owns the velocity. */
  private parked = false;
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

  /* ---------------------------------------------------------------- build */

  /**
   * A real build: the MUSIC does the work.
   *
   * Four things climb together and all of them land on the same downbeat — the
   * decks' high-pass (so the low end evaporates), a snare roll that doubles
   * every bar (1/4, 1/8, 1/16, 1/32), a noise riser with a reverse-cymbal swell
   * under it, and a 1.5% tempo push over the last stretch. Then it RESOLVES:
   * the filters snap open on the downbeat and the mix lifts. A build that just
   * stops is the "useless" one this replaces.
   *
   * A second tap cancels it — a child who changes their mind should not have to
   * wait four bars.
   */
  build(opts: { bars?: number; rise?: boolean } = {}): MacroResult {
    if (!this.wired()) return this.fail(NOT_WIRED);
    if (this.active === 'build') {
      this.endTension();
      // endTension only owns the decks. The landing lift is already on the
      // macroGain timeline and would fire into a build that no longer exists.
      const g = this.engine.macroGain.gain;
      const t = this.ctx.currentTime + 0.005;
      this.holdAt(g, t);
      g.linearRampToValueAtTime(1, t + 0.05);
      return this.ok('Never mind');
    }
    if (this.busy) return this.fail(STILL_GOING);

    const bars = clamp(Math.round(fin(opts.bars, BUILD_BARS)), 1, 8);
    this.engine.ensureBeatClock();

    const bar = this.barSec();
    const now = this.ctx.currentTime + 0.02;
    const land = this.downbeatAtLeast(bars * bar);
    const lift = Math.pow(10, DROP_LIFT_DB / 20);

    this.tension(now, land, bars, {
      sweepUntil: land,
      roll: true,
      cymbal: true,
      rise: opts.rise !== false,
    });

    // The landing. Anchored the same way bigDrop anchors its cut: a bare
    // linearRamp with no preceding event ramps from wherever the param happens
    // to be when automation starts, which is not a value we control.
    const mg = this.engine.macroGain.gain;
    this.watchdog(mg, land + 2 * bar + 0.4);
    this.holdAt(mg, now);
    mg.linearRampToValueAtTime(1, now + 0.02);
    mg.setValueAtTime(1, Math.max(now + 0.03, land - 0.004));
    this.slam(land, lift, null);

    this.active = 'build';
    this.busyUntil = land + 0.05;
    this.afterIn(this.tensionTimers, land - this.ctx.currentTime + 0.02, () => this.endTension());
    return this.ok('Building it up…');
  }

  /* ----------------------------------------------------------- the drops */

  /**
   * Three drops, one door. Each one manipulates the tracks that are playing;
   * none of them is only a gate on the master.
   *
   *  classic  — build, hole, slam. The decks duck and high-pass into the cut so
   *             the hole is something the music fell into, not a mute over it.
   *  tapestop — the records wind down to a halt over half a bar, pitch falling
   *             with speed, a beat of nothing, then back at full speed.
   *  reverse  — the records are pulled backwards into the downbeat, accelerating
   *             (so the pitch rises), under a reverse-cymbal swell.
   *
   * The last two need a loaded, playing, un-held deck. With none available they
   * fall back to classic and say so, because a pad that does nothing is the
   * worst outcome available to this file.
   */
  drop(kind: DropKind = 'classic', opts: DropOptions = {}): MacroResult {
    if (!this.wired()) return this.fail(NOT_WIRED);
    // A drop ON a running build is the move the build exists for, so it replaces
    // the build instead of being refused by it.
    if (this.active === 'build') this.endTension();
    if (this.busy) return this.fail(STILL_GOING);

    let k: DropKind = kind === 'tapestop' || kind === 'reverse' ? kind : 'classic';
    let victims = k === 'classic' ? [] : this.grabbable(k);
    let note = DROP_NOTE[k];
    if (k !== 'classic' && !victims.length) {
      k = 'classic';
      victims = [];
      note = 'Nothing playing to grab — here is a big one instead';
    }

    // A grid to land on even with every drum layer off. Side effect worth
    // knowing: this starts the transport, so the KidsMode step dots wake up.
    this.engine.ensureBeatClock();

    const beat = this.beatSec();
    const bar = this.barSec();
    const now = this.ctx.currentTime + 0.02;
    // The wind-down and the suck-back ARE the tension, so they need less runway.
    const riseBars = clamp(
      Math.round(fin(opts.riseBars, k === 'classic' ? DROP_RISE_BARS : 1)),
      1,
      8
    );
    const silenceBeats = clamp(
      Math.round(fin(opts.silenceBeats, k === 'classic' ? DROP_SILENCE_BEATS : 1)),
      1,
      8
    );
    const grabBeats = clamp(
      Math.round(fin(opts.grabBeats, k === 'reverse' ? REV_BEATS : STOP_BEATS)),
      1,
      8
    );
    const lift = Math.pow(10, clamp(fin(opts.liftDb, DROP_LIFT_DB), 0, 4) / 20);

    const cut = this.downbeatAtLeast(riseBars * bar);
    const back = cut + silenceBeats * beat;
    const grabAt = Math.max(now + 0.05, cut - grabBeats * beat);

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

    // Classic gets the deck dip; the other two have the platter itself receding,
    // and ducking a record that is already winding down just hides the effect.
    if (k === 'classic') this.deckDip(now, cut, back);

    // The lead time IS the ramp-in: a tap makes a sound immediately, so waiting
    // for a musical landing point never feels like a dead button.
    const sweepUntil = k === 'classic' ? cut : grabAt;
    this.tension(now, cut, riseBars, {
      sweepUntil,
      roll: true,
      cymbal: k !== 'classic',
      rise: k === 'classic',
    });
    this.afterIn(this.tensionTimers, sweepUntil - this.ctx.currentTime + 0.01, () =>
      this.endSweep()
    );
    this.downlifter(cut);

    if (k !== 'classic' && victims.length) {
      this.afterIn(this.timers, grabAt - this.ctx.currentTime, () =>
        this.grab(victims, k, grabAt, cut)
      );
      this.afterIn(this.timers, back - SPIN_LEAD - this.ctx.currentTime, () => this.spinUp());
      this.afterIn(this.timers, back + SPIN_TAIL - this.ctx.currentTime, () => this.release());
      // The redundant safety release at back + 1.0 is GONE, and it is the one
      // deletion here that had to be traded rather than taken for free. It is now
      // actively hazardous: `lease` is a single field, so a stale timer from drop
      // N firing during drop N+1 would release N+1's platters mid-effect. Three
      // deadlines cover what it covered — the scheduled release above, the
      // registry's idle sweep, and the worklet's own TTL, which is the only one
      // that works with the main thread gone entirely.
    }

    this.active = 'drop';
    this.dropKind = k;
    // Stay busy past the release timer, KEPT at the full second against the
    // design's proposal to shrink it. It is what makes "two macro leases on one
    // deck" unreachable, and equal rank loses: a second tap that got through
    // would be declined on every platter, acquireMacro would return null, and the
    // gate would cut and slam with no records moving and nothing to explain it.
    // The main thread janking a setTimeout by a few hundred ms is routine on a
    // tablet; the deleted second was cosmetic and the failure is not.
    this.busyUntil = back + (k === 'classic' ? 0.05 : 1.05);
    this.after(back - this.ctx.currentTime + 0.06, () => {
      this.active = this.latch;
      this.dropKind = null;
      this.engine.notify();
    });
    return this.ok(note);
  }

  /** The old name. Kept so every existing caller and key binding still works. */
  bigDrop(opts: DropOptions = {}): MacroResult {
    return this.drop('classic', opts);
  }

  /**
   * Loaded, playing, and not already under somebody's finger.
   *
   * A SCHEDULE-TIME estimate, two bars early; `acquireMacro` decides for real at
   * fire time. A child grabbing a platter in between means the drop's spoken note
   * over-promises slightly while the gate and the slam still play out — cosmetic,
   * and the honest place for the imprecision.
   */
  private grabbable(kind: DropKind): Deck[] {
    return this.engine.decks.filter((d) => {
      if (!d.loaded || !d.playing || d.platterBusy) return false;
      // A suck-back needs somewhere to go. Near the head of a track the platter
      // would pin at frame 0 and gate itself silent, which is not an effect.
      if (kind === 'reverse' && !d.loop && d.positionSecNow < REV_MIN_POS) return false;
      return true;
    });
  }

  /** The songs recede under the roll, then come back with the slam. */
  private deckDip(now: number, cut: number, back: number): void {
    const bar = this.barSec();
    const db = this.engine.deckBus.gain;
    this.watchdog(db, back + 0.4);
    this.holdAt(db, now);
    db.linearRampToValueAtTime(1, now + 0.02);
    db.setValueAtTime(1, Math.max(now + 0.03, cut - bar));
    db.linearRampToValueAtTime(DROP_DECK_DIP, cut - CUT_LEAD);
    db.setValueAtTime(DROP_DECK_DIP, back - 0.004);
    db.linearRampToValueAtTime(1, back + SLAM_FADE);
  }

  /* ---------------------------------------------------- the tension parts */

  /**
   * Everything that climbs. `tHit` is where the roll and the riser land;
   * `sweepUntil` is where the deck filters stop climbing, which for a tape stop
   * is EARLIER — a record winding down should do it with its bass intact.
   */
  private tension(
    t0: number,
    tHit: number,
    bars: number,
    opts: { sweepUntil: number; roll: boolean; cymbal: boolean; rise: boolean }
  ): void {
    this.riser(t0, tHit);
    if (opts.cymbal) this.reverseSwell(t0, tHit);
    if (opts.roll) this.rollIn(tHit - bars * this.barSec(), tHit, bars);
    this.startSweep(t0, opts.sweepUntil, opts.rise);
  }

  /**
   * The accelerating snare roll — the part of a build a listener actually counts.
   * Each bar doubles: 1/4, 1/8, 1/16, 1/32 into the hit.
   *
   * Scheduled a bar at a time rather than all at once. Four bars is ~60 hits and
   * each snare() builds ~10 nodes, so building them together is a 600-node
   * main-thread spike at exactly the moment the mix has thinned out and any
   * glitch is naked.
   */
  private rollIn(t0: number, t1: number, bars: number): void {
    const bar = this.barSec();
    const beat = this.beatSec();
    if (bar < 0.4 || t1 - t0 < 0.2) return;
    // Where the ladder ENDS. 1/32 is only earned by a roll long enough to have
    // climbed to it — at 174 bpm it is a hit every 43 ms, 23 a second, which
    // over a single bar is not an accelerating roll, it is a machine gun.
    const top = ROLL_DIVISIONS.length - (bars >= 3 ? 1 : 2);
    for (let i = 0; i < bars; i++) {
      const barAt = t0 + i * bar;
      const idx = clamp(top - (bars - 1 - i), 0, ROLL_DIVISIONS.length - 1);
      const div = ROLL_DIVISIONS[idx];
      this.afterIn(this.tensionTimers, barAt - bar - this.ctx.currentTime, () =>
        this.rollBar(barAt, div, beat, t0, t1)
      );
    }
  }

  private rollBar(barAt: number, div: number, beat: number, t0: number, t1: number): void {
    const step = beat / div;
    if (!(step > 0.005)) return;
    const span = t1 - t0;
    for (let j = 0; j < 4 * div; j++) {
      const at = barAt + j * step;
      // A bar that was scheduled and then partly overtaken still plays the rest
      // of itself; hits already in the past are simply skipped.
      if (at < this.ctx.currentTime + 0.005 || at >= t1) continue;
      const u = span > 0 ? clamp((at - t0) / span, 0, 1) : 1;
      // Level climbs (a roll crescendos) while density buys a trim on the
      // busiest bar: snare's tail is 0.2 s at full accent, so at 174 bpm the
      // 43 ms 1/32 spacing leaves ~5 of them sounding at once (~6 at the 220 bpm
      // ceiling `bpm()` clamps to).
      const gain =
        (ROLL_GAIN_LO + (ROLL_GAIN_HI - ROLL_GAIN_LO) * u) * (div >= 8 ? ROLL_DENSE_TRIM : 1);
      // Accent is velocity: quiet hits are also shorter and duller, which is
      // what stops the dense bars turning into one continuous hiss.
      snare(this.ctx, this.engine.oneShotBus, at, gain, 0.5 + 0.5 * u);
    }
  }

  /**
   * Reverse cymbal — a swell that arrives rather than decays.
   *
   * Two layers because one cannot be both. A looped noise bed under a lowpass
   * climbing 700 Hz -> 13 kHz gives the length; a single unlooped pass of
   * drums.ts's metal buffer, playbackRate rising, gives the CYMBAL. The metal
   * buffer is deliberately not looped: six inharmonic squares splice with a step
   * edge, and 1.15 s is all of it that is audible anyway.
   */
  private reverseSwell(t0: number, t1: number): void {
    if (t1 - t0 < 0.4) return;
    const ctx = this.ctx;
    const dest = this.engine.oneShotBus;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(700, t0);
    lp.frequency.exponentialRampToValueAtTime(13000, t1);

    const g = ctx.createGain();
    g.gain.setValueAtTime(FLOOR, t0);
    g.gain.exponentialRampToValueAtTime(SWELL_NOISE_PEAK, t1);
    g.gain.linearRampToValueAtTime(FLOOR, t1 + 0.06);
    g.connect(dest);

    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    n.loop = true;
    n.connect(lp).connect(g);
    n.start(t0);
    n.stop(t1 + 0.1);

    const mStart = Math.max(t0, t1 - 1.15);
    const m = ctx.createBufferSource();
    m.buffer = metalBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(FLOOR, mStart);
    mg.gain.exponentialRampToValueAtTime(SWELL_METAL_PEAK, t1);
    mg.gain.linearRampToValueAtTime(FLOOR, t1 + 0.06);
    m.connect(hp).connect(mg).connect(dest);
    // Below 1x the 1.2 s buffer lasts 1.46 s, so it covers the window it starts in.
    m.playbackRate.setValueAtTime(0.82, mStart);
    m.playbackRate.exponentialRampToValueAtTime(1.35, t1);
    m.start(mStart);
    m.stop(t1 + 0.1);
  }

  /**
   * The decks' own high-pass climbing, plus the optional accelerando.
   *
   * Deck.setFilter is the only handle on the deck path we can move without
   * stealing a param someone else owns, and it is the right one: the sweep is
   * per-deck and the on-screen knob follows it, so the surface tells the truth
   * about what the build did. See integration notes for the engine-level filter
   * that would make this a scheduled AudioParam ramp instead of a timer.
   */
  private startSweep(t0: number, t1: number, rise: boolean): void {
    this.stopSweep();
    // Cleared before the early return, not only in endSweep: a stale snapshot
    // would restore a filter position from two macros ago.
    this.tensed = [];
    const decks = this.engine.decks.filter((d) => d.loaded);
    if (!decks.length) return;
    this.tensed = decks.map((d) => ({
      deck: d,
      filterKnob: d.filterKnob,
      tempoPercent: d.tempoPercent,
      wroteFilter: d.filterKnob,
      wroteTempo: d.tempoPercent,
    }));

    const span = t1 - t0;
    if (span < 0.3) return;
    this.sweepTimer = window.setInterval(() => {
      const u = clamp((this.ctx.currentTime - t0) / span, 0, 1);
      const shaped = Math.pow(u, BUILD_HP_SHAPE);
      for (const s of this.tensed) {
        // Hands win, exactly as easeCrossfade treats the fader: if the live
        // value is not what we last wrote, somebody grabbed the knob.
        if (Math.abs(s.deck.filterKnob - s.wroteFilter) <= HAND_EPS_FILTER) {
          // From wherever the knob was, not from zero — a deck already filtered
          // by hand keeps that as its starting point.
          s.deck.setFilter(clamp(s.filterKnob + (BUILD_HP_TOP - s.filterKnob) * shaped, -1, 1));
          s.wroteFilter = s.deck.filterKnob;
        }
        if (rise && u > RISE_FROM && Math.abs(s.deck.tempoPercent - s.wroteTempo) <= HAND_EPS_TEMPO) {
          const w = (u - RISE_FROM) / (1 - RISE_FROM);
          s.deck.setTempoPercent(s.tempoPercent + BUILD_TEMPO_PCT * w);
          s.wroteTempo = s.deck.tempoPercent;
        }
      }
      if (u >= 1) this.stopSweep();
    }, SWEEP_TICK_MS);
  }

  private stopSweep(): void {
    if (this.sweepTimer === null) return;
    window.clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Put the decks back exactly, unless a hand moved them while we were away. */
  private endSweep(): void {
    this.stopSweep();
    const tensed = this.tensed;
    this.tensed = [];
    for (const s of tensed) {
      if (
        Math.abs(s.deck.filterKnob - s.wroteFilter) <= HAND_EPS_FILTER &&
        s.deck.filterKnob !== s.filterKnob
      ) {
        s.deck.setFilter(s.filterKnob);
      }
      if (
        Math.abs(s.deck.tempoPercent - s.wroteTempo) <= HAND_EPS_TEMPO &&
        s.deck.tempoPercent !== s.tempoPercent
      ) {
        s.deck.setTempoPercent(s.tempoPercent);
      }
    }
  }

  /** endSweep plus the build's own bookkeeping. */
  private endTension(): void {
    for (const id of this.tensionTimers) window.clearTimeout(id);
    this.tensionTimers.clear();
    this.endSweep();
    if (this.active === 'build') {
      this.active = this.latch;
      this.busyUntil = 0;
    }
    this.engine.notify();
  }

  /* ------------------------------------------------- the platter engines */

  /**
   * Take hold of the playing records and drive their velocity.
   *
   * The lease opens at `spin: 1` — this record's own normal speed — so there is
   * no dead stop to recover from. The old two-step (scratchStart seeding
   * velocity ZERO, then a scratchRate 4 ms later re-pointing it at the deck's
   * speed) is gone along with the comment explaining why that gap was survivable.
   *
   * The per-deck `if (!d.loaded || d.scratching) continue` re-check is gone too,
   * and NOT because it was wrong: it is now `tryClaim`, which decides the same
   * question at the same instant but with the answer recorded where the writes
   * actually happen. A child who grabbed a platter in the two bars since this was
   * scheduled simply outranks us and keeps their record.
   */
  private grab(decks: Deck[], kind: DropKind, t0: number, t1: number): void {
    // Kept deliberately, against the design's proposal to drop it. This is the
    // only thing that kills an interval belonging to a lease we are about to
    // replace or fail to acquire, and an orphaned interval is now MORE likely,
    // not less: it survives past the wind-down to hold the lease alive.
    this.stopScratchTimer();

    const lease = this.engine.platters.acquireMacro(decks, {
      spin: 1,
      onRevoked: (d) => {
        // A finger took this platter. Drop it from the bookkeeping so spinUp
        // does not try to catch up a record it no longer drives, and tear the
        // whole thing down once nothing is left.
        this.held = this.held.filter((h) => h.deck !== d);
        if (!this.lease?.live) {
          this.stopScratchTimer();
          this.lease = null;
        }
      },
    });
    if (!lease) {
      // Every platter is under a finger. The gain automation is already on the
      // timeline and will play out as a plain cut-and-slam, which is the honest
      // degradation — but say so, because a drop with no moving records is
      // otherwise indistinguishable from a bug.
      console.warn('[macros] no platter granted; the drop lands without the records');
      return;
    }
    this.lease = lease;
    this.parked = false;

    const now = this.ctx.currentTime;
    for (const d of lease.decks) this.held.push({ deck: d, posAtGrab: d.positionSecNow, grabAt: now });

    const span = Math.max(0.05, t1 - t0);
    this.scratchTimer = window.setInterval(() => {
      const l = this.lease;
      if (!l?.live) {
        this.stopScratchTimer();
        return;
      }
      const u = clamp((this.ctx.currentTime - t0) / span, 0, 1);
      if (u >= 1) {
        // PAST THE WIND-DOWN THE ENVELOPE STOPS WRITING VELOCITY. The interval
        // keeps running only to hold the lease alive across the silence: the gap
        // from u >= 1 (at `cut`) to spinUp (at `back - SPIN_LEAD`) is
        // `silenceBeats * beat - 0.045 s`, which at 60 bpm with silenceBeats up
        // to 8 runs to seconds — long enough for the worklet to yield the platter
        // mid-silence, after which spinUp's catch-up seek is declined and the
        // record lands off the grid.
        //
        // But it must NOT keep writing spin(0). At least five ticks land between
        // spinUp (back - 0.045) and release (back + 0.06), and every one of them
        // would overwrite spinUp's spin(1) within 20 ms — the record would climb
        // to ~81% of rate on the 12 ms constant, be dragged straight back down,
        // and arrive at the downbeat at roughly 0.2x with the gate half open.
        // That is a wrong-pitch smear exactly where SPIN_LEAD's 45 ms was
        // engineered to deliver 97.6% of full speed, and it would freeze the drum
        // grid through the slam as well, since applyGrid follows |workletVel|.
        if (!this.parked) {
          // The master gate is already at zero here, so parking is silent and
          // only matters for where the record is when we catch it back up.
          l.spin(0);
          this.parked = true;
        }
        l.keepAlive();
        return;
      }
      const f =
        kind === 'reverse'
          ? 1 - REV_DEPTH * Math.pow(u, REV_SHAPE)
          : Math.pow(1 - u, STOP_SHAPE);
      l.spin(f);
      l.keepAlive();
    }, SCRATCH_TICK_MS);
  }

  /**
   * Catch the record up and spin it back to full speed.
   *
   * The seek target is computed from the clock AT THE INSTANT THIS FIRES, not
   * from the scheduled slam time, so main-thread jitter changes WHEN the record
   * comes back and never WHERE. That is the same self-correcting property
   * alignPhaseTo relies on, and it is what keeps a tape stop from leaving the
   * song half a bar behind the drums for the rest of the night.
   */
  private spinUp(): void {
    // FIRST LINE, and unconditional. This makes "spinUp is the last writer
    // before release" true regardless of tick jitter, rather than true because
    // the `u >= 1` branch above happens to behave. Belt and braces on the same
    // failure, and the cheap half of it.
    this.stopScratchTimer();
    const lease = this.lease;
    if (!lease?.live) return;
    const now = this.ctx.currentTime;
    for (const h of this.held) {
      const rate = clamp(fin(h.deck.nominalRate, 1), 0.25, 4);
      const virtual = h.posAtGrab + (now + SPIN_LEAD - h.grabAt) * rate;
      lease.seek(h.deck, this.wrapInto(h.deck, virtual - SPIN_ADVANCE * rate), true);
    }
    // One write, in fractions: every record goes back to its OWN full speed.
    lease.spin(1);
  }

  /**
   * Hand every platter back to the stretch engine. Idempotent by construction —
   * the door refuses a lease that no longer holds the deck, so a hand that took
   * over mid-drop is not yanked out from under the child.
   *
   * `true` is not a leftover, it is the drop's CONTRACT: the record comes back at
   * the slam. A bare release resolves from live transport state, and a child who
   * tapped the record graphic during the wind-down has set `playing` false
   * underneath us — the worklet would then brake into the downbeat, hold the
   * platter for the full hand-back deadline with the gate wide open, and cut
   * dead, leaving the song silent for the rest of the session.
   */
  private release(): void {
    this.stopScratchTimer();
    this.held = [];
    this.lease?.release(true);
    this.lease = null;
  }

  private stopScratchTimer(): void {
    if (this.scratchTimer === null) return;
    window.clearInterval(this.scratchTimer);
    this.scratchTimer = null;
  }

  /** A catch-up target has to respect a hook loop, or it lands outside it. */
  private wrapInto(deck: Deck, sec: number): number {
    const v = fin(sec, 0);
    const s = deck.loopStartSec;
    const e = deck.loopEndSec;
    if (deck.loop && s != null && e != null && e - s > 0.05) {
      const span = e - s;
      const r = (v - s) % span;
      return s + (r < 0 ? r + span : r);
    }
    return clamp(v, 0, Math.max(0, deck.durationSec - 0.05));
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
    // Armed before the mute, for the same reason as the drop: a throw between
    // the two would leave the songs ducked to silence with nothing to restore
    // them.
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
   * Makes the whole thing hit harder — the DRUMS and the SONGS, which is the
   * half that used to be missing.
   *
   * Drums: low shelf, soft-clip drive, trim.
   * Songs: the same shelf-and-drive treatment on the deck path when AudioEngine
   *        provides deckLow/deckPre/deckDrive, plus makeup and a deeper kick-keyed
   *        duck on deckDuck either way. See the headroom block at the top of this
   *        file for why every one of those numbers is what it is; the short
   *        version is that the master limiter has 3.0 dB of room and this spends
   *        1.5 dB of it.
   *
   * The sidechain stays: the beat punching a hole in the songs is what makes the
   * songs sound louder in the gaps, and it is free.
   */
  setBump(on: boolean): void {
    // Already-there check first, so releaseAll()'s setBump(false) on a cold
    // engine is a silent no-op rather than a warning about nothing.
    if (on === this.bumpOn) return;
    if (!this.wired()) return;
    const e = this.engine;
    const t = this.ctx.currentTime;
    const trim = e.drumTrim.gain;
    const sh = this.shaper();

    e.drumLow.gain.setTargetAtTime(on ? BUMP_SHELF_DB : 0, t, 0.05);
    if (sh) {
      sh.deckLow.frequency.setValueAtTime(DECK_SHELF_HZ, t);
      sh.deckLow.gain.setTargetAtTime(on ? DECK_SHELF_DB : 0, t, 0.05);
    }

    // Swapping a WaveShaper curve is an instantaneous change of transfer
    // function, i.e. a level step. Fade the trims through the swap instead.
    if (this.bumpTimer !== null) window.clearTimeout(this.bumpTimer);
    this.holdAt(trim, t + 0.001);
    trim.linearRampToValueAtTime(FLOOR, t + 0.001 + SWAP_FADE);
    if (sh) {
      // The songs DIP rather than mute: 10 ms of silence is inaudible on a
      // percussive bus and very audible on a sustained one.
      this.holdAt(sh.deckPre.gain, t + 0.001);
      sh.deckPre.gain.linearRampToValueAtTime(SWAP_DIP, t + 0.001 + SWAP_FADE);
    }
    this.bumpTimer = window.setTimeout(() => {
      this.bumpTimer = null;
      e.drumDrive.curve = on ? this.curve() : null;
      const t2 = this.ctx.currentTime;
      trim.setValueAtTime(FLOOR, t2);
      trim.linearRampToValueAtTime(on ? BUMP_TRIM : 1, t2 + SWAP_FADE);
      if (sh) {
        sh.deckDrive.curve = on ? this.curve() : null;
        sh.deckPre.gain.setValueAtTime(SWAP_DIP, t2);
        sh.deckPre.gain.linearRampToValueAtTime(on ? DECK_PRE : 1, t2 + SWAP_FADE);
      }
    }, (0.002 + SWAP_FADE) * 1000);

    if (on) {
      // Bump does NOT switch drums on. It boosts what is already playing — the
      // deck path as well as the drum bus — so a bump with no beats running is
      // still a real low-end lift on the songs, not a dead button. Forcing
      // layers on made the pad start music the user had not asked for, which is
      // a far worse surprise than a subtler effect.
      this.unsubSidechain = e.transport.onStep(this.onSidechainStep);
      this.bumpOn = true;
      // Lift the songs now rather than waiting for the first kick, or the pad
      // sounds like it did nothing until the beat comes round.
      const duck = e.deckDuck.gain;
      this.holdAt(duck, t + 0.001);
      duck.linearRampToValueAtTime(BUMP_BASE, t + 0.031);
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
   * The deck-path shaper, if AudioEngine has it. Structural rather than declared
   * on AudioEngine so this file compiles and runs either way: without the nodes
   * bump still lifts and pumps the songs through deckDuck, it just cannot shelf
   * or saturate them.
   */
  private shaper(): DeckShaper | null {
    const e = this.engine as AudioEngine & Partial<DeckShaper>;
    if (!e.deckLow || !e.deckPre || !e.deckDrive) return null;
    return { deckLow: e.deckLow, deckPre: e.deckPre, deckDrive: e.deckDrive };
  }

  /**
   * Sidechain, keyed off the groove rather than an envelope follower — Web Audio
   * has no sidechain input on DynamicsCompressorNode, and the pattern is known
   * ahead of time anyway.
   *
   * Both ramps are scheduled atomically at kick time so the param returns to its
   * base on its own: stopping the transport mid-duck cannot strand the songs
   * quiet.
   */
  private onSidechainStep = (step: number, time: number): void => {
    if (!this.bumpOn) return;
    const bm = this.engine.beatMachine;
    if (!bm.layers.kick || !bm.groove.kick.includes(step)) return;

    const stepDur = this.engine.transport.stepDuration;
    if (!(stepDur > 0.005 && stepDur < 0.5)) return; // nonsense bpm: skip, do not schedule garbage

    // The release has to finish before the NEXT kick ducks, or that duck's
    // anchoring setValueAtTime lands mid-ramp and steps 5.6 dB in one block.
    // Trap at 174 bpm is the worst case: a 2-sixteenth gap leaves 23% margin.
    let gapSteps = 16;
    for (const k of bm.groove.kick) {
      const d = (((k - step) % 16) + 16) % 16;
      if (d > 0 && d < gapSteps) gapSteps = d;
    }
    const release = clamp(gapSteps * stepDur * 0.7, 0.05, 0.22);

    const g = this.engine.deckDuck.gain;
    g.setValueAtTime(BUMP_BASE, time - 0.004);
    g.linearRampToValueAtTime(BUMP_FLOOR, time + DUCK_IN);
    g.linearRampToValueAtTime(BUMP_BASE, time + DUCK_IN + release);
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
    // Those ids are dead now; leaving them in the map would make the next
    // watchdog clear a timeout some later macro has been handed by the browser.
    this.watchdogs.clear();
    this.stopEase();
    // Before the param restores: a platter left holding velocity 0 is a deck
    // that reads as playing and makes no sound, and clearing the timers above
    // just removed the thing that would have freed it.
    this.release();
    this.endTension();

    this.active = null;
    this.dropKind = null;
    this.latch = null;
    this.busyUntil = 0;
    if (!this.nodesWired()) {
      this.snap = null;
      return;
    }

    const t = this.ctx.currentTime + 0.005;
    for (const p of [this.engine.macroGain.gain, this.engine.deckBus.gain]) {
      this.holdAt(p, t);
      p.linearRampToValueAtTime(1, t + 0.03);
    }
    // The duck's home is not 1 while bump is on; sending it there would drop the
    // songs 1.9 dB until the next kick re-anchored them.
    const duck = this.engine.deckDuck.gain;
    this.holdAt(duck, t);
    duck.linearRampToValueAtTime(this.bumpOn ? BUMP_BASE : 1, t + 0.03);

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

  /**
   * Tracked setTimeout, removed from its set as it fires. Returns the id so a
   * caller that must retire its own earlier timer can find it again.
   */
  private afterIn(set: Set<number>, sec: number, fn: () => void): number {
    const id = window.setTimeout(
      () => {
        set.delete(id);
        fn();
      },
      Math.max(0, sec) * 1000
    );
    set.add(id);
    return id;
  }

  private after(sec: number, fn: () => void): void {
    this.afterIn(this.timers, sec, fn);
  }

  /**
   * Silence is the worst thing this file could leave behind, so every scheduled
   * slam is checked afterwards and forced home if an exception got between the
   * cut and the return.
   *
   * ONE ARMED CHECK PER PARAM, NEWEST WINS. A check left over from a FINISHED
   * macro is not merely useless, it is destructive: it wakes up, finds a param
   * that the NEXT macro has legitimately pulled to zero, and forces the gate
   * open in the middle of that macro's hole — and because it holds the param
   * first, it also wipes the slam still sitting on the timeline, so the mix
   * never comes back louder. It is reachable on the DEFAULTS: at 120 bpm a
   * 4-bar build lands at 10.0 s and arms its check for 14.4 s, and a tapestop
   * tapped a beat later cuts at 14.0 s and returns at 14.5 s, putting the stale
   * check 400 ms inside a 500 ms silence. Re-arming on a param therefore
   * retires whatever was already watching it.
   *
   * Scoped per PARAM rather than by a global generation, because a macro that
   * never touches deckBus must not disarm the bridge's check on it.
   */
  private watchdog(p: AudioParam, at: number): void {
    const prev = this.watchdogs.get(p);
    if (prev !== undefined) {
      window.clearTimeout(prev);
      this.timers.delete(prev);
    }
    let id = 0;
    id = this.afterIn(this.timers, at - this.ctx.currentTime, () => {
      // Only vacate the slot if it is still ours; a re-arm owns it now.
      if (this.watchdogs.get(p) === id) this.watchdogs.delete(p);
      if (p.value >= 0.5) return;
      const t = this.ctx.currentTime + 0.005;
      this.holdAt(p, t);
      p.linearRampToValueAtTime(1, t + 0.03);
      console.warn('[macros] a gate was still down after a macro; forced back up');
    });
    this.watchdogs.set(p, id);
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

  /** Eight accelerating snares into the hit — the last bar of a bridge. */
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
