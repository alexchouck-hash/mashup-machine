import type { Transport } from './Transport';
import { saturator } from './drums';

/**
 * THE LOOP PEDAL. One mechanism, two surfaces.
 *
 * A TAKE is a phrase somebody plays. Every tap sounds IMMEDIATELY and
 * unquantised, so it feels human. Taps accumulate. After `idleSec` of silence
 * the take COMMITS: it is pulled onto the grid, becomes a layer, and loops with
 * the track from then on. Takes stack. Clear-last removes the whole newest take;
 * reset-all removes every take.
 *
 * This file is SURFACE-AGNOSTIC on purpose: no DOM, no React, no key theory, no
 * kit names. The drum pad and the keyboard are two CONFIGURATIONS of it plus two
 * voice tables — there is no second implementation of capture, idle, commit,
 * quantise, stack, clear or schedule anywhere in the app.
 *
 * WHAT THE UI READS, AND HOW. Nothing here calls back into React per frame. The
 * caller's rAF loop reads `flash`, `phase01()`, `openRemaining01()` and
 * `openTaps` directly and writes CSS itself, the same way the visualizer and the
 * turntable already do. `hooks.changed()` fires only on discrete events —
 * commit, clear, reset — which are safe to re-render on.
 *
 * NOTHING HERE MAY THROW INTO A STEP HANDLER. `Transport.tick` has no try/catch,
 * so one throw stops the clock forever AND kills every handler registered after
 * this one. `onStep` is wrapped end to end; after MAX_STEP_ERRORS failures the
 * looper marks itself dead and schedules nothing further, so a single bad take
 * costs its own surface and not the whole app.
 */

const STEPS_PER_BAR = 16;

/**
 * Two hits of the same voice closer than a quarter-step (31 ms at 120 bpm) are
 * one hit: below the flam threshold they do not read as two events, they read as
 * one event 6 dB louder. Merging them is what bounds coherent summation on the
 * bus to zero — see the LEVELS note in BeatMachine.
 *
 * When a surface is quantised every `frac` is 0, so this reduces exactly to
 * "one hit per (step, voice)". It only has work to do on the keyboard with
 * auto-beat-match OFF, where hits keep the sub-step offsets they were played at
 * and a fast repeat inside one step is a real musical event worth keeping.
 */
const MERGE_WINDOW_STEPS = 0.25;

/**
 * Live taps are SCHEDULED this far ahead so envelopes open on a block boundary
 * rather than mid-block. 4 ms is a fifth of the flam threshold and reads as
 * instant.
 *
 * It is a scheduling artefact, NOT part of the recorded timing: the tap stores
 * the moment the finger landed, so a take played with auto-beat-match off
 * reproduces exactly what was played rather than what the scheduler did with it.
 */
const LIVE_LEAD_SEC = 0.004;

/**
 * Per-voice retrigger guard. Pointer events double-fire (pointerdown + click,
 * touchstart + mousedown), and a child machine-gunning one pad produces N
 * coherent copies of one sample.
 *
 * DELIBERATELY PER-VOICE, NOT PER-SURFACE: a single global guard would make a
 * two-finger chord impossible, and the keyboard's whole point is that a chord
 * across takes survives. Burst DENSITY is bounded separately, by
 * `maxVoicesPerStep`, which applies to the live path too.
 */
const TAP_GUARD_SEC = 0.04;

/** How long a refusal ("no room for a seventh take") stays readable. */
const NOTICE_SEC = 2.5;

/** Errors inside the step handler before this looper gives up scheduling. */
const MAX_STEP_ERRORS = 3;

/** Idle-commit poll. Coarse on purpose: it decides nothing, it only asks. */
const COMMIT_POLL_MS = 150;

/**
 * One colour per take, so its chip in the layer row, its marks on the position
 * strip and its pad glow all agree. Indexed by take id, not by stack position,
 * so clearing take 3 does not recolour takes 4 and 5 under a child's eyes.
 */
export const TAKE_COLORS = ['#ff6b6b', '#ffd166', '#5ddb8c', '#4ea8ff', '#c77dff', '#ff9f45'];

/** Shared empty bucket. Never mutated after commit, so one instance serves all. */
const NO_HITS: never[] = [];

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** What one tap carries. `S` is the surface's payload: a pad slot, or a midi note. */
export interface Tap<S> {
  /** Exact ctx time the tap SOUNDED. The timing datum; everything else derives. */
  at: number;
  /** Fractional absolute step, captured at tap time so a scratch is tracked. */
  grid: number;
  /** Grid epoch the `grid` value belongs to. A mismatch at commit re-derives. */
  epoch: number;
  vel: number;
  p: S;
}

/** A committed hit. `step` is the bucket 0..L-1; `frac` is the sub-step offset. */
export interface Hit<S> {
  step: number;
  frac: number;
  vel: number;
  p: S;
}

export interface Take<S> {
  id: number;
  /** Loop length in steps: a whole power-of-two number of bars, 16..maxBars*16. */
  steps: number;
  /** Pre-bucketed by step, so the step handler is an index lookup. */
  byStep: Hit<S>[][];
  /** Stack trim, recomputed for every take whenever the stack changes. */
  gain: number;
  color: string;
  /** The unquantised taps, kept so the UI can animate the snap at commit. */
  raw: Tap<S>[];
}

export interface TakeVoice<S> {
  /**
   * Sound ONE hit at an exact ctx time. MUST NOT THROW — this runs inside the
   * transport's step handler. `gain` is a multiplier on the voice's nominal
   * level (the take's stack trim, or 1 for a live tap); `vel` is 0..1.
   */
  play(ctx: BaseAudioContext, dest: AudioNode, time: number, p: S, gain: number, vel: number): void;
  /**
   * Collision identity. Two hits with the same key at the same instant merge to
   * one, and it is also the key the UI lights: `flash` is keyed by this.
   */
  keyOf(p: S): number;
}

export interface TakeConfig<S> {
  /** Silence that ends a take. 3 s for drums, 5 s for the keyboard. */
  idleSec: number;
  /** Snap resolution in steps. 1 = sixteenths on both surfaces. */
  quantiseSteps: number;
  /** Longest loop, in bars. Must be a power of two. */
  maxBars: number;
  maxTakes: number;
  maxVoicesPerStep: number;
  /** Bus saturator drive — the hard ceiling, not a tone control. */
  drive: number;
  /** Bus ceiling. The output cannot exceed this however many voices sum. */
  trim: number;
  /** Drums: `() => true`. Keyboard: `() => this.beatMatch`. */
  quantised: () => boolean;
  voice: TakeVoice<S>;
}

export interface TakeHooks {
  /**
   * A take committed, was cleared, or the stack was reset. DISCRETE — this is
   * where `engine.notify()` belongs, and the caller also re-evaluates the clock
   * and the groove duck here.
   */
  changed(): void;
  /**
   * Guarantee a running, music-aligned clock. Called on the first tap of a take
   * and again at commit, because a take captured while the clock was stopped
   * must still start it.
   */
  ensureClock(): void;
}

/**
 * Where we are, in absolute steps. THE ONLY THING THAT KNOWS.
 *
 * `observe` is idempotent per (step, time), so it does not matter which of the
 * three step handlers reaches it first — whoever gets there sets the position
 * and the others no-op.
 *
 * `gridAt(t)` reads `transport.stepDuration`, which already folds in
 * `rateScale`. That is the whole scratch story: a frozen platter freezes the
 * grid and a fast scratch races it, and taps captured during either land where
 * the performer heard them, because they are measured against the same grid the
 * drums are riding.
 */
export class GridClock {
  /** Bumped whenever the transport restarts. Taps carry it; commit checks it. */
  epoch = 0;
  /** Absolute step index of the most recently observed step. */
  absStep = 0;
  /** ctx time that step was scheduled for. */
  stepTime = 0;

  private transport: Transport;
  private ctx: BaseAudioContext;
  private lastStep = -1;
  private started = false;
  /** A seeded origin is provisional: the first real step re-bases and re-epochs. */
  private provisional = false;
  /** The transport was seen stopped; the next step observed is a restart. */
  private stopped = false;

  constructor(ctx: BaseAudioContext, transport: Transport) {
    this.ctx = ctx;
    this.transport = transport;
  }

  get absBar(): number {
    return Math.floor(this.absStep / STEPS_PER_BAR);
  }

  /**
   * Provisional origin, so `gridAt` means something for the very first tap of a
   * session — the one made a beat or two before the transport has fired a step.
   * Those taps get re-derived at commit off the real grid, which is exactly what
   * the epoch is for.
   */
  seed(): void {
    if (this.started) return;
    this.absStep = 0;
    this.stepTime = this.ctx.currentTime;
    this.provisional = true;
  }

  /**
   * Watch for the transport stopping. Cheap, and called from each looper's
   * commit poll.
   *
   * A broken step sequence catches most restarts, but NOT the one-in-sixteen
   * where the clock stops on step 15 and restarts on step 0 — that reads as
   * perfectly continuous while real time has jumped. Asking the transport
   * directly closes it, and it cannot false-positive on a scratch: a frozen
   * platter also produces a long gap between consecutive steps, but the
   * transport is still `running` throughout.
   */
  pollRunning(): void {
    if (!this.transport.running) this.stopped = true;
  }

  observe(step: number, time: number): void {
    if (this.started && step === this.lastStep && time === this.stepTime) return;

    if (!this.started || this.provisional) {
      if (this.provisional) this.epoch++;
      this.started = true;
      this.provisional = false;
      this.absStep = step;
    } else if (!this.stopped && step === (this.lastStep + 1) % STEPS_PER_BAR) {
      this.absStep++;
    } else {
      // The transport was stopped and started again. Re-base onto the next bar
      // keeping the invariant absStep % 16 === step, and bump the epoch so any
      // take open across the restart is re-derived rather than trusted.
      this.epoch++;
      this.absStep = (Math.floor(this.absStep / STEPS_PER_BAR) + 1) * STEPS_PER_BAR + step;
    }

    this.stopped = false;
    this.lastStep = step;
    this.stepTime = time;
  }

  /** Fractional absolute step for any ctx time, past or future. */
  gridAt(t: number): number {
    const sd = this.transport.stepDuration;
    if (!(sd > 0.0005) || !Number.isFinite(t)) return this.absStep;
    return this.absStep + (t - this.stepTime) / sd;
  }
}

/* ------------------------------------------------------------------ quantise */

/** Wrap x into [-m/2, +m/2). Used for circular offsets, never for rotation. */
function wrapTo(x: number, m: number): number {
  return x - m * Math.round(x / m);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * THE WHOLE-TAKE PHASE SHIFT — the part that preserves the groove.
 *
 * Snapping each hit independently SCATTERS a phrase. Worked case at 120 bpm
 * (step = 125 ms), hits played at grid 4.50 and 8.40, a gap of 3.90 steps:
 *   independent rounding -> 5 and 8, gap 3 steps.  112 ms of error INJECTED
 *                                                  into a phrase played right.
 *   shift-then-snap      -> 4 and 8, gap 4 steps.   13 ms of error.
 *
 * The centre must be computed CIRCULARLY or it fails on exactly that case: the
 * raw offsets are {-0.50, +0.40}, whose median is -0.05 — essentially no shift,
 * and the scatter survives. The circular mean puts the centre at 0.45 and the
 * phrase lands where it was played.
 *
 * MEDIAN, NOT MEAN, of the residuals: one stray tap drags a mean; the median is
 * the phrase's characteristic lateness. At n = 1 the median IS that tap's own
 * error, so a single tap lands exactly on the nearest sixteenth, which is right.
 *
 * SAFETY PROPERTY: the result is wrapped to a residue mod one quantise step, so
 * |shift| <= q/2 = 31 ms at 120 bpm. The take cannot be moved onto a different
 * beat. Nothing rotates, ever.
 */
function phaseShift(grid: number[], q: number): number {
  let sumSin = 0;
  let sumCos = 0;
  for (let i = 0; i < grid.length; i++) {
    const theta = (2 * Math.PI * grid[i]) / q;
    sumSin += Math.sin(theta);
    sumCos += Math.cos(theta);
  }
  // A perfectly balanced ring (atan2(0,0)) has no characteristic phase; 0 is the
  // right answer there and is what atan2 returns anyway.
  const centre = (Math.atan2(sumSin / grid.length, sumCos / grid.length) * q) / (2 * Math.PI);

  const residuals: number[] = [];
  for (let i = 0; i < grid.length; i++) residuals.push(wrapTo(grid[i] - centre, q));

  return wrapTo(centre + median(residuals), q);
}

/** Smallest power of two >= n, capped. Loop lengths are 1, 2, 4 or 8 bars. */
function pow2AtLeast(n: number, cap: number): number {
  let p = 1;
  while (p < n && p < cap) p *= 2;
  return Math.min(p, cap);
}

/* --------------------------------------------------------------------- unit */

export class TakeLooper<S> {
  /** voices -> saturator(drive) -> trim -> caller's bus. Connect this. */
  readonly output: GainNode;

  /**
   * Voice key -> ctx time that voice is scheduled to SOUND.
   *
   * The step handler runs up to 120 ms ahead of the sound, so it must not light
   * anything; it writes the intended time here instead and the caller's rAF loop
   * turns that into a glow when the moment actually arrives. A live tap writes
   * through the same path, so a pad lights identically whether a finger or the
   * loop struck it.
   */
  readonly flash = new Map<number, number>();

  private ctx: BaseAudioContext;
  private clock: GridClock;
  private transport: Transport;
  private config: TakeConfig<S>;
  private hooks: TakeHooks;

  /** Voices land here, upstream of the saturator. */
  private dest: WaveShaperNode;

  private stack: Take<S>[] = [];
  private taps: Tap<S>[] = [];
  private lastTapAt = -1;
  private nextId = 0;

  private lastVoiceAt = new Map<number, number>();
  private timer: number | null = null;
  private onVisible: (() => void) | null = null;

  /**
   * CONSECUTIVE failures, cleared by any clean step — not a lifetime tally.
   *
   * As a lifetime counter, three unrelated hiccups spread across a whole party
   * permanently silenced the surface with no way back short of a reload. The
   * guard exists to stop a genuinely broken take from wedging Transport.tick
   * (which has no try/catch), and three failures IN A ROW is what broken looks
   * like; three across an hour is just a long party.
   */
  /**
   * Whether committed loops PLAY. Off keeps every take intact — this is a mute,
   * not a clear, so a child can drop the loops out for a chorus and bring the
   * same ones back rather than rebuilding them.
   */
  enabled = true;

  private errs = 0;
  private dead = false;

  private noticeText = '';
  private noticeUntil = 0;

  // Per-step scratch. Parallel primitive arrays reused every step, so the hot
  // path allocates nothing once it has warmed up.
  private slotP: S[] = [];
  private slotFrac: number[] = [];
  private slotVel: number[] = [];
  private slotGain: number[] = [];
  private slotKey: number[] = [];
  private slotN = 0;

  constructor(
    ctx: BaseAudioContext,
    transport: Transport,
    clock: GridClock,
    config: TakeConfig<S>,
    hooks: TakeHooks
  ) {
    this.ctx = ctx;
    this.transport = transport;
    this.clock = clock;
    this.config = config;
    this.hooks = hooks;

    // The saturator's curve is normalised so y(+/-1) = +/-1 and Web Audio clamps
    // its input beyond +/-1, so THE OUTPUT CANNOT EXCEED `trim` no matter how
    // many voices sum. That is why the worst case here is a constant and not a
    // conjunction over takes, pads and layers. oversample stays 'none': 2x
    // inserts ~1.3 ms of FIR latency, and 1.3 ms between this kick and a groove
    // kick is a comb notch at 385 Hz.
    this.dest = saturator(ctx, config.drive, 'none');
    this.output = ctx.createGain();
    this.output.gain.value = config.trim;
    this.dest.connect(this.output);

    // Three idempotent paths to the same question, because any one of them can
    // be late: a coarse poll, the step handler, and the tab coming back. All
    // three read ctx.currentTime — never a wall clock, never the timer's own
    // firing time, both of which lie when the tab is throttled.
    if (typeof window !== 'undefined') {
      this.timer = window.setInterval(() => {
        this.clock.pollRunning();
        this.maybeCommit();
      }, COMMIT_POLL_MS);
    }
    if (typeof document !== 'undefined') {
      this.onVisible = () => this.maybeCommit();
      document.addEventListener('visibilitychange', this.onVisible);
    }
  }

  /* ------------------------------------------------------------ read-only */

  get takes(): readonly Take<S>[] {
    return this.stack;
  }

  get hasTakes(): boolean {
    return this.stack.length > 0;
  }

  /** The taps of the take currently being played, for drawing loose marks. */
  get openTaps(): readonly Tap<S>[] {
    return this.taps;
  }

  get isOpen(): boolean {
    return this.taps.length > 0;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** A refusal worth showing, or ''. Expires on its own. */
  get notice(): string {
    return this.ctx.currentTime < this.noticeUntil ? this.noticeText : '';
  }

  /** Loop length the position strip should draw: the longest take, else one bar. */
  loopSteps(): number {
    let n = STEPS_PER_BAR;
    for (let i = 0; i < this.stack.length; i++) {
      if (this.stack[i].steps > n) n = this.stack[i].steps;
    }
    return n;
  }

  /** Playhead position, 0..1 across `loopSteps()`. Read this from rAF. */
  phase01(): number {
    const L = this.loopSteps();
    const g = this.transport.running ? this.clock.gridAt(this.ctx.currentTime) : this.clock.absStep;
    return (((g % L) + L) % L) / L;
  }

  /** Countdown to commit, 1 at the last tap draining to 0. 0 when nothing is open. */
  openRemaining01(): number {
    if (this.taps.length === 0) return 0;
    const left = this.config.idleSec - (this.ctx.currentTime - this.lastTapAt);
    return clamp(left / this.config.idleSec, 0, 1);
  }

  /**
   * Convenience for the rAF loop: 1 at the hit, fading to 0 over `decaySec`.
   *
   * A hit still in the FUTURE glows 0. That is the whole point of scheduling the
   * light rather than lighting it in the step handler — without this guard a pad
   * lights up to 120 ms before its own sound, which is the lookahead made
   * visible.
   */
  glow(key: number, now: number, decaySec = 0.18): number {
    const t = this.flash.get(key);
    if (t === undefined || now < t) return 0;
    return clamp(1 - (now - t) / decaySec, 0, 1);
  }

  /* ------------------------------------------------------------------ play */

  /**
   * A tap. Sounds NOW and unquantised — the whole feel of a loop pedal is that
   * the instrument never waits for the grid.
   *
   * Returns false when the guard swallowed it (a pointer double-fire, or a burst
   * denser than the per-step voice cap), so a caller can decline to light a pad
   * that did not actually sound.
   */
  tap(p: S, vel = 1): boolean {
    if (this.dead) return false;

    const key = this.config.voice.keyOf(p);
    const now = this.ctx.currentTime;

    const last = this.lastVoiceAt.get(key);
    if (last !== undefined && now - last < TAP_GUARD_SEC) return false;

    // Density cap on the live path, matching the one playback obeys: a palm on
    // six pads is six voices, a palm on six pads twice in 40 ms is still six.
    let live = 0;
    for (const t of this.lastVoiceAt.values()) if (now - t < TAP_GUARD_SEC) live++;
    if (live >= this.config.maxVoicesPerStep) return false;

    const opening = this.taps.length === 0;
    if (opening) {
      // First tap of a take starts the clock, so a child who taps before loading
      // anything is still tapping against a real grid.
      this.clock.seed();
      this.safely(() => this.hooks.ensureClock());
    }

    const soundAt = now + LIVE_LEAD_SEC;
    const v = clamp(vel, 0, 1);
    this.lastVoiceAt.set(key, now);
    this.flash.set(key, soundAt);
    this.safely(() => this.config.voice.play(this.ctx, this.dest, soundAt, p, 1, v));

    // `at` is when the FINGER landed, not when the voice was scheduled.
    this.taps.push({ at: now, grid: this.clock.gridAt(now), epoch: this.clock.epoch, vel: v, p });
    this.lastTapAt = now;

    // Deliberately no changed() here. A take opening is a per-tap event and the
    // rAF loop already shows it through openRemaining01() and openTaps.
    return true;
  }

  /** Commit if the idle window has elapsed. Idempotent; safe to call from anywhere. */
  maybeCommit(): void {
    if (this.taps.length === 0) return;
    if (this.ctx.currentTime - this.lastTapAt < this.config.idleSec) return;
    this.commitNow();
  }

  /**
   * Close the open take: quantise it, bucket it, push it on the stack.
   *
   * The test is `taps.length > 0`, never `> 1` — a single tap then silence is a
   * sparse one-bar loop, and nothing a child played is ever lost.
   */
  commitNow(): boolean {
    if (this.taps.length === 0) return false;

    if (this.stack.length >= this.config.maxTakes) {
      // Refuse rather than silently evict the oldest loop. A child who has built
      // six layers did not ask for one of them to disappear.
      //
      // Checked BEFORE draining, and the ordering is the whole point: draining
      // first threw away the phrase they had just spent eight seconds playing,
      // so a full stack ate the take AND kept the loop. Now the take survives —
      // clear a loop and the pending phrase commits on the next idle window.
      this.noticeText = 'FULL';
      this.noticeUntil = this.ctx.currentTime + NOTICE_SEC;
      this.safely(() => this.hooks.changed());
      return false;
    }

    const taps = this.taps;
    this.taps = [];
    this.lastTapAt = -1;

    let take: Take<S>;
    try {
      take = this.build(taps);
    } catch {
      // A malformed take is dropped, never allowed to reach the scheduler.
      return false;
    }

    this.stack.push(take);
    this.restack();
    this.safely(() => this.hooks.ensureClock());
    this.safely(() => this.hooks.changed());
    return true;
  }

  /**
   * What a child means by "clear last" while still playing is "undo what I am
   * doing now", so an OPEN take is discarded first. Only once nothing is open
   * does this pop a committed layer.
   */
  clearLast(): boolean {
    if (this.taps.length > 0) {
      this.taps = [];
      this.lastTapAt = -1;
    } else if (this.stack.length > 0) {
      this.stack.pop();
      this.restack();
    } else {
      return false;
    }
    this.hooks.changed();
    return true;
  }

  resetAll(): boolean {
    if (this.taps.length === 0 && this.stack.length === 0) return false;
    this.taps = [];
    this.lastTapAt = -1;
    this.stack = [];
    this.flash.clear();
    this.hooks.changed();
    return true;
  }

  /* -------------------------------------------------------------- schedule */

  /**
   * The transport step handler. Runs ahead of the sound, schedules at exact
   * times, lights nothing, allocates nothing, and cannot throw out of itself.
   */
  onStep(step: number, time: number): void {
    if (this.dead) return;
    try {
      this.clock.observe(step, time);
      // Committing still runs while muted: a take in progress must finish and be
      // kept, or turning the loop off mid-phrase would quietly bin it.
      this.maybeCommit();
      if (!this.enabled) return;
      if (this.stack.length === 0) return;

      const abs = this.clock.absStep;
      this.gather(abs);
      if (this.slotN === 0) return;

      const sd = this.transport.stepDuration;
      const voice = this.config.voice;
      for (let i = 0; i < this.slotN; i++) {
        // frac scales with stepDuration, so an unquantised hit rides a scratch
        // exactly as a quantised one does.
        const at = time + this.slotFrac[i] * sd;
        this.flash.set(this.slotKey[i], at);
        voice.play(this.ctx, this.dest, at, this.slotP[i], this.slotGain[i], this.slotVel[i]);
      }
      // A step that scheduled cleanly proves the surface is not wedged.
      this.errs = 0;
    } catch {
      this.errs++;
      if (this.errs >= MAX_STEP_ERRORS) this.dead = true;
    }
  }

  dispose(): void {
    if (this.timer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.onVisible && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisible);
      this.onVisible = null;
    }
    this.stack = [];
    this.taps = [];
  }

  /* -------------------------------------------------------------- internals */

  /**
   * Collect everything due on this absolute step, across every take, deduped and
   * capped. No allocation: the slot arrays are reused and grow once.
   */
  private gather(abs: number): void {
    this.slotN = 0;
    const voice = this.config.voice;

    for (let ti = 0; ti < this.stack.length; ti++) {
      const take = this.stack[ti];
      const L = take.steps;
      const bucket = take.byStep[((abs % L) + L) % L];
      for (let hi = 0; hi < bucket.length; hi++) {
        const h = bucket[hi];
        const key = voice.keyOf(h.p);
        const gain = take.gain;

        let merged = false;
        for (let si = 0; si < this.slotN; si++) {
          if (this.slotKey[si] !== key) continue;
          if (Math.abs(this.slotFrac[si] - h.frac) > MERGE_WINDOW_STEPS) continue;
          // Same voice at effectively the same instant. Keep the louder, never
          // both: two identical samples at one moment is +6 dB of nothing.
          if (h.vel * gain > this.slotVel[si] * this.slotGain[si]) {
            this.slotP[si] = h.p;
            this.slotFrac[si] = h.frac;
            this.slotVel[si] = h.vel;
            this.slotGain[si] = gain;
          }
          merged = true;
          break;
        }
        if (merged) continue;

        const si = this.slotN++;
        this.slotP[si] = h.p;
        this.slotFrac[si] = h.frac;
        this.slotVel[si] = h.vel;
        this.slotGain[si] = gain;
        this.slotKey[si] = key;
      }
    }

    // Cap for CPU and for coherence, not for level — the bus ceiling is the
    // saturator's job. Drop the quietest, which is the one nobody will miss.
    const cap = this.config.maxVoicesPerStep;
    while (this.slotN > cap) {
      let worst = 0;
      let worstAmp = Infinity;
      for (let si = 0; si < this.slotN; si++) {
        const a = this.slotVel[si] * this.slotGain[si];
        if (a < worstAmp) {
          worstAmp = a;
          worst = si;
        }
      }
      const last = --this.slotN;
      if (worst !== last) {
        this.slotP[worst] = this.slotP[last];
        this.slotFrac[worst] = this.slotFrac[last];
        this.slotVel[worst] = this.slotVel[last];
        this.slotGain[worst] = this.slotGain[last];
        this.slotKey[worst] = this.slotKey[last];
      }
    }
  }

  /**
   * Quantise a finished take and bucket it.
   *
   * LOOP LENGTH is the smallest POWER-OF-TWO number of bars containing the
   * phrase, 1 to `maxBars`. Not one folded bar: at 120 bpm a bar is 2 s, so a
   * child tapping for eight seconds has played FOUR bars, and folding those onto
   * each other returns a dense clump that sounds nothing like what they did.
   *
   * Power-of-two is what makes "every take lines up with every other" true
   * rather than hopeful. Playback position is `absStep mod L` — there is no
   * per-take origin at all — and because every length divides every longer one
   * (16 | 32 | 64 | 128), a one-bar take and a four-bar take hold a fixed
   * relationship for the life of the session. A three-bar take against a
   * four-bar take has lcm 192: they would walk through each other every twelve
   * bars and never agree with the song's own four-bar phrasing.
   */
  private build(taps: Tap<S>[]): Take<S> {
    const q = Math.max(1, this.config.quantiseSteps);

    // Grid positions were captured at TAP time, which is what tracks a scratch.
    // They are only re-derived when the transport restarted mid-take, because
    // the grid those numbers referred to no longer exists.
    const epoch = this.clock.epoch;
    let stale = false;
    for (let i = 0; i < taps.length; i++) {
      if (taps[i].epoch !== epoch) {
        stale = true;
        break;
      }
    }
    const grid: number[] = [];
    for (let i = 0; i < taps.length; i++) {
      const g = stale ? this.clock.gridAt(taps[i].at) : taps[i].grid;
      const safe = Number.isFinite(g) ? g : this.clock.absStep;
      grid.push(safe);
      // Write it back so `raw` agrees with what actually committed — the UI
      // animates the marks from these positions to the snapped ones.
      taps[i].grid = safe;
    }

    const quantised = this.config.quantised();
    const shift = quantised ? phaseShift(grid, q) : 0;

    const pos: number[] = [];
    const frac: number[] = [];
    for (let i = 0; i < grid.length; i++) {
      if (quantised) {
        pos.push(Math.round((grid[i] - shift) / q) * q);
        frac.push(0);
      } else {
        // Auto-beat-match off is not a second scheduler; it is this branch not
        // running. The hit keeps the exact moment it was played, carried as a
        // sub-step offset that playback adds back.
        const f = Math.floor(grid[i]);
        pos.push(f);
        frac.push(clamp(grid[i] - f, 0, 0.999));
      }
    }

    let lo = pos[0];
    let hi = pos[0];
    for (let i = 1; i < pos.length; i++) {
      if (pos[i] < lo) lo = pos[i];
      if (pos[i] > hi) hi = pos[i];
    }
    const span = hi - lo + 1;
    const bars = pow2AtLeast(Math.ceil(span / STEPS_PER_BAR), Math.max(1, this.config.maxBars));
    const L = bars * STEPS_PER_BAR;

    const byStep: Hit<S>[][] = new Array(L);
    for (let i = 0; i < L; i++) byStep[i] = NO_HITS;

    const voice = this.config.voice;
    for (let i = 0; i < pos.length; i++) {
      // Past maxBars the take folds mod L. Nothing is discarded: later material
      // overlays earlier at its true position in the loop. Past eight bars a
      // child has stopped performing a loop and started noodling, and a
      // non-repeating 32-bar "loop" is not a loop.
      // NORMALISED TO THE FIRST HIT: the loop starts at the left, where the
      // child started playing, rather than wherever in the bar they happened to
      // begin. Because L is a whole number of bars and playback is
      // `absStep mod L`, step 0 always lands on a transport bar line — so
      // starting at the left and having the beats line up are the same change,
      // and the end is clipped to a whole bar by construction.
      const step = (((pos[i] - lo) % L) + L) % L;
      const key = voice.keyOf(taps[i].p);

      let bucket = byStep[step];
      let merged = false;
      for (let j = 0; j < bucket.length; j++) {
        if (voice.keyOf(bucket[j].p) !== key) continue;
        if (Math.abs(bucket[j].frac - frac[i]) > MERGE_WINDOW_STEPS) continue;
        if (taps[i].vel > bucket[j].vel) bucket[j] = { step, frac: frac[i], vel: taps[i].vel, p: taps[i].p };
        merged = true;
        break;
      }
      if (merged) continue;

      if (bucket === NO_HITS) {
        bucket = [];
        byStep[step] = bucket;
      }
      bucket.push({ step, frac: frac[i], vel: taps[i].vel, p: taps[i].p });
    }

    const id = this.nextId++;
    return {
      id,
      steps: L,
      byStep,
      gain: 1,
      color: TAKE_COLORS[id % TAKE_COLORS.length],
      raw: taps,
    };
  }

  /**
   * Stack trim: 1 / (1 + 0.15(n-1)), so 0.57 at six layers.
   *
   * Not a level safety measure — the saturator already makes the bus ceiling a
   * constant. This is so a SIXTH layer still adds audible detail instead of
   * adding only clamp distortion.
   */
  private restack(): void {
    const n = this.stack.length;
    const g = 1 / (1 + 0.15 * Math.max(0, n - 1));
    for (let i = 0; i < n; i++) this.stack[i].gain = g;
  }

  /**
   * Run a side effect that reaches outside the audio engine — a React notify, a
   * clock start — without letting it reach the scheduler. A broken view must not
   * be able to kill the beat.
   */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // Intentionally swallowed. See the class comment.
    }
  }
}
