import type { AudioEngine } from './AudioEngine';
import type { Deck } from './Deck';

/**
 * PLATTER OWNERSHIP — who is allowed to move a record, and for how long.
 *
 * The thing this replaces was one boolean, `Deck.scratching`, consulted by three
 * drivers (a finger via Turntable/KidsMode, macros.ts, and several passive
 * readers) and owned by none of them. It was patched three times — an
 * unconditional scratchOff, a 0.6 s stall watchdog, and the deck link deferring
 * on `d.scratching` — each a guard on a symptom. The measured failure was a deck
 * frozen for EIGHT SECONDS while still reporting `playing: true`.
 *
 * The model is one sentence: A CLAIM ON A DECK, RANKED; THE ONLY WAY TO REACH
 * THE PORT IS A LEASE THAT STILL HOLDS THE CLAIM. `Deck.platterPost` is the
 * whole guarantee and its entire body is `if (this.heldBy !== lease) return`.
 *
 * The old guards asked the wrong question. `if (!this.scratching) return` asks
 * "is ANYONE scratching" where the caller meant "may *I* drive this" — which is
 * why a transient disagreement became permanent: the only call that could have
 * freed the platter was the one that refused to send.
 *
 * Owner's ruling on the central question: PREEMPT — THE FINGER ALWAYS WINS. A
 * record that ignores a child's hand because a macro is mid-automation reads as
 * broken, and safe-but-dead is the worse failure. A preempted macro's drop is
 * compromised by design; that is the trade, taken deliberately.
 */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export type DriverKind = 'finger' | 'macro';

/**
 * Higher wins; equal LOSES. A finger's PRIMARY claim — the deck actually under
 * the hand — outranks the same gesture's fan-out onto the other platter, and
 * that one distinction is what makes two children come out right with no special
 * case. Child A grabs A: primary A (3), secondary B (2). Child B grabs B:
 * primary B (3) beats A's secondary and takes deck B; B's secondary on A (2)
 * loses to A's primary (3) and is declined. Each child drives their own record
 * and nobody's platter dead-stops.
 *
 * Equal rank loses (`<=`, not `<`) so two fingers cannot thrash each other's
 * partner deck — the older secondary keeps it. Two PRIMARY claims on one deck
 * cannot occur: each deck has exactly one Turntable, and Turntable.onDown
 * already refuses a second pointer (`g.pointerId !== null`, plus `e.isPrimary`).
 *
 * Two MACRO claims on one deck cannot occur either, and that is load-bearing
 * rather than incidental: Macros is single-instance and `busyUntil` stays armed
 * past the drop's own release timer, precisely so a second tap cannot arrive
 * while the first lease is still live. Were it to happen, equal-rank-loses means
 * the second drop is declined on every deck and `acquireMacro` returns null —
 * see the warn in Macros.grab.
 */
const RANK = { primary: 3, secondary: 2, macro: 1 } as const;
type ClaimKind = keyof typeof RANK;

export type RevokeReason = 'preempted' | 'expired' | 'stale' | 'unloaded' | 'teardown';

/** Ping cadence. Deliberately far under the deadline — see LEASE_IDLE_SEC. */
const KEEPALIVE_MS = 200;

/**
 * Main-thread deadline: a driver that stopped calling `keepAlive` loses the
 * platter. This number is set by BACKGROUND TIMER CLAMPING, not by the ping
 * rate, and nobody should tighten it back toward "5 misses at 5 Hz".
 *
 * Macros' 20 ms interval is the sole keepalive for a macro lease, and every
 * major engine throttles a background interval to roughly 1 Hz while the
 * AudioWorklet keeps running at full rate. At a 1.0 s deadline the margin in the
 * exact case the deadline exists for — tap Tape stop, then lock the phone — is
 * approximately zero, and the deadline becomes a coin flip on timer jitter.
 * 3.0 s still bounds a stranded platter an order of magnitude below the eight
 * seconds this whole exercise is about, and it survives the clamp.
 */
export const LEASE_IDLE_SEC = 3.0;

/** Ceiling on the drum grid, matching what the old setScratchVelocity allowed. */
const MAX_GRID_SCALE = 2;

export interface PlatterGrab {
  /** Seed the PRIMARY at this position, seconds. Omit to seed from the deck. */
  positionSec?: number;
  /** Opening speed as a fraction of each deck's OWN normal speed. Default 0 —
   *  a hand landing on a record stops it, which is what happens today. */
  spin?: number;
  /** Release laziness, seconds. Omit for the worklet's own default (0.14). */
  inertiaSec?: number;
  /**
   * Per DECK, fired synchronously from acquire/revoke. `deck === lease.primary`
   * means this gesture is over; any other deck means the lease merely shrank.
   *
   * CONTRACT, and the whole one-door guarantee leans on it: onRevoked is called
   * with the claim ALREADY GONE. Calling release() from inside it can never
   * touch the revoked deck — the door is shut before you are told.
   */
  onRevoked?: (deck: Deck, reason: RevokeReason) => void;
}

/** Everything the door will carry. Nothing else may be posted to a platter. */
export type ScratchMsg =
  | { type: 'scratchOn'; frame: number; velocity: number }
  | { type: 'scratchRate'; value: number }
  | { type: 'scratchJog'; frame: number }
  | { type: 'scratchKeepAlive' }
  | { type: 'scratchInertia'; releaseSec: number }
  | { type: 'scratchOff'; play?: boolean }
  | { type: 'seek'; frame: number; play: boolean };

/**
 * The seam Fx's crackle bed will hang off. NO SUBSCRIBER TODAY, deliberately:
 * Fx.scratchNoiseStart/scratchNoise/scratchNoiseEnd have never made a sound, and
 * shipping a never-before-heard noise layer inside a refactor whose entire claim
 * is "no audible change, structurally safer" would make it impossible to A/B
 * whether the ownership rework changed the sound.
 */
export type PlatterEvent =
  | { type: 'grab'; deck: Deck; kind: DriverKind }
  | { type: 'spin'; deck: Deck; fraction: number }
  | { type: 'free'; deck: Deck };

/**
 * The only object in the app with methods that move a platter.
 *
 * It holds a SET OF CLAIMS captured at acquire, which only ever shrinks. The
 * group is evaluated once, inside `acquireFinger`, and never recomputed:
 * previously acquire iterated `scratchGroup()` at t0 and release iterated a
 * freshly recomputed one at t1, so an eject mid-gesture (the ⏏ button sits live
 * and tappable during a gesture on the other platter) left an
 * acquired-never-released deck whose stale-true flag permanently froze the drum
 * grid. A captured claim set has no second set to disagree with.
 */
export class PlatterLease {
  readonly kind: DriverKind;
  /** The deck whose ABSOLUTE position this lease drives. null for a macro. */
  readonly primary: Deck | null;

  private readonly owner: Platters;
  private readonly grab: PlatterGrab;
  private readonly claims = new Set<Deck>();
  private last = 0;
  private pingedAt = -Infinity;
  /** ctx time of the last keepAlive. Read by the registry's idle sweep. */
  aliveAt = 0;

  /** @internal Minted by Platters and nowhere else. */
  constructor(owner: Platters, kind: DriverKind, primary: Deck | null, grab: PlatterGrab) {
    this.owner = owner;
    this.kind = kind;
    this.primary = primary;
    this.grab = grab;
    this.aliveAt = owner.now();
  }

  /** Claims still held. Captured at acquire; only ever shrinks. */
  get decks(): readonly Deck[] {
    return [...this.claims];
  }

  /** False once every claim is gone. Every method below is then a no-op. */
  get live(): boolean {
    return this.claims.size > 0;
  }

  /** Last fraction written. The grid reads the ECHO, not this — see applyGrid. */
  get spinNow(): number {
    return this.last;
  }

  holds(deck: Deck): boolean {
    return this.claims.has(deck);
  }

  /**
   * FINGER path. `handRate` is source-seconds per wall-second, straight off
   * Turntable, and is converted ONCE here against the primary's own nominal
   * rate.
   *
   * DELIBERATELY SILENT — no engine.notify(). A gesture emits up to ~60 of these
   * a second and two children means ~120; notifying would re-render KidsMode and
   * both song tiles on every one, which is exactly the per-frame React work the
   * canvas rAF loops exist to avoid.
   */
  move(positionSec: number, handRate: number): void {
    const p = this.primary;
    if (!this.live || !p) return;
    // nominalRate is structurally in [0.49, 1.53] (tempoPercent clamps to +/-50,
    // phaseTrim to +/-0.02), so this cannot divide by zero.
    this.spin(handRate / p.nominalRate);
    p.platterPost(this, { type: 'scratchJog', frame: positionSec * p.sampleRate });
  }

  /**
   * MACRO path. `fraction` is a multiple of each deck's OWN normal speed:
   * 1 = this record's normal speed, 0 stopped, -1 normal reverse.
   *
   * The unit choice is a bug fix, not a preference. KidsMode used to pass the
   * raw hand rate to both the grabbed deck and its partner while macros computed
   * `1 + tempoPercent/100` — two conventions on one message, so a partner at
   * +19% tempo (which matchTempo genuinely reaches) ran 19% slow for the whole
   * gesture and came out of beatmatch. As a fraction both records bend by the
   * same RATIO, which is what keeps them locked.
   */
  spin(fraction: number): void {
    if (!this.live) return;
    this.last = fraction;
    // The event object is allocated only when somebody is listening: this runs
    // 50–60 times a second per deck, and per-frame garbage on the audio control
    // path is the thing the rAF loops in this app exist to avoid.
    const watched = this.owner.watched;
    for (const d of this.claims) {
      d.platterPost(this, { type: 'scratchRate', value: fraction * d.nominalRate });
      if (watched) this.owner.emit({ type: 'spin', deck: d, fraction });
    }
  }

  /** Needle drop under the hand. Skips decks this lease no longer holds. */
  seek(deck: Deck, positionSec: number, play = true): void {
    if (!this.live) return;
    deck.platterSeek(this, positionSec, play);
  }

  /**
   * "Still here". Free — call it per frame.
   *
   * There is deliberately NO INTERVAL IN THE REGISTRY. If the registry pinged on
   * behalf of every live lease, a macro that threw between grab() and release()
   * would leave a lease object renewing the worklet's TTL forever — the deadline
   * would never fire for the exact failure it exists to catch. The ping must be
   * a side effect of the driver still running its own loop. No idle timer,
   * nothing to leak.
   */
  keepAlive(): void {
    if (!this.live) return;
    const now = this.owner.now();
    this.aliveAt = now;
    if (now - this.pingedAt < KEEPALIVE_MS / 1000) return;
    this.pingedAt = now;
    for (const d of this.claims) d.platterPost(this, { type: 'scratchKeepAlive' });
  }

  /**
   * Hand back every remaining claim. Idempotent, and a stale lease cannot free a
   * platter someone else now owns because the door refuses it.
   *
   * `play` is an EXPLICIT INTENT, not a snapshot. Omitted, the worklet resolves
   * from live transport state, which is the entire point of the bare form:
   * KidsMode used to defeat that by passing `wasPlaying` captured at pointerdown,
   * so grabbing the annulus, toggling play and lifting silently undid the toggle.
   * Macros passes `true` because "the record comes back at the slam" is the
   * drop's contract — and a child who taps the record graphic mid-wind-down has
   * set `playing` false underneath it, which the bare form would honour by
   * braking into the downbeat and never coming back.
   */
  release(play?: boolean): void {
    if (!this.live) return;
    for (const d of [...this.claims]) this.clear(d, true, play);
    this.owner.settle();
  }

  /**
   * @internal Drop ONE claim on someone else's say-so.
   *
   * THE ORDER IS THE GUARANTEE. The claim is removed and `deck.heldBy` nulled
   * BEFORE onRevoked runs, because every realistic handler ends in a release():
   * KidsMode's goes ttRef.abort() -> endGesture -> onScratchEnd -> release(). Were
   * the callback to fire first, that release would still see `d.heldBy === this`,
   * the door would OPEN, and the retiring lease would post scratchOff into the
   * platter tryClaim is one line away from handing to its new owner — Hole 1
   * reached deterministically through preemption instead of through a re-grab.
   */
  loseClaim(deck: Deck, reason: RevokeReason): void {
    // Hand the platter back only where nothing else is about to take it. On
    // 'preempted' the incoming claim posts its own scratchOn; on 'unloaded' and
    // 'stale' the worklet has already dropped its scratch state (load/unload
    // call resetScratch, and 'stale' IS "the worklet is not scratching"), so a
    // scratchOff would be dropped at `if (!this.scratchActive) break` anyway.
    // 'expired' and 'teardown' are the two where the worklet may genuinely still
    // be holding a record nobody is going to release.
    const handBack = reason === 'expired' || reason === 'teardown';
    if (!this.clear(deck, handBack, undefined)) return;
    this.grab.onRevoked?.(deck, reason);
  }

  /** @internal Open the claim. Called from Platters.tryClaim only. */
  takeClaim(deck: Deck, rank: number): void {
    deck.heldBy = this;
    deck.heldRank = rank;
    this.claims.add(deck);
  }

  private clear(deck: Deck, handBack: boolean, play: boolean | undefined): boolean {
    if (!this.claims.has(deck)) return false;
    // Through the door like everything else: posted while the claim still
    // stands, cleared immediately after.
    if (handBack) deck.platterPost(this, { type: 'scratchOff', play });
    this.claims.delete(deck);
    if (deck.heldBy === this) {
      deck.heldBy = null;
      deck.heldRank = 0;
    }
    this.owner.emit({ type: 'free', deck });
    if (!this.live) this.owner.retire(this);
    return true;
  }
}

/**
 * The registry: the rank table, the deadline sweep, and the single writer on
 * `transport.rateScale`.
 */
export class Platters {
  private engine: AudioEngine;
  /** Live leases in ACQUISITION order — the drum grid follows the newest. */
  private leases: PlatterLease[] = [];
  private listeners = new Set<(e: PlatterEvent) => void>();
  private lastGrid = 1;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  /** @internal ctx time, or 0 before the engine exists. */
  now(): number {
    return this.engine.initialized ? this.engine.ctx.currentTime : 0;
  }

  /** One finger on `deck`: primary there, secondary on the rest of the group. */
  acquireFinger(deck: Deck, grab: PlatterGrab = {}): PlatterLease | null {
    // scratchOn at length 0 is dropped silently by the worklet, so a lease over
    // a platter it refused would be a lie from birth.
    if (!deck.loaded) return null;
    const lease = new PlatterLease(this, 'finger', deck, grab);
    this.leases.push(lease);
    // The ONLY call site of scratchGroup, evaluated ONCE. One finger moves BOTH
    // platters, always, regardless of the sync toggle — that is the owner's call
    // and it lives in AudioEngine.scratchGroup, not here.
    this.tryClaim(lease, deck, 'primary', grab, deck);
    for (const d of this.engine.scratchGroup(deck)) {
      if (d !== deck) this.tryClaim(lease, d, 'secondary', grab, deck);
    }
    if (!lease.live) {
      this.retire(lease);
      return null;
    }
    this.settle();
    return lease;
  }

  /** A macro over `decks`: equal rank on all, no primary. Null if none granted. */
  acquireMacro(decks: Deck[], grab: PlatterGrab = {}): PlatterLease | null {
    const lease = new PlatterLease(this, 'macro', null, grab);
    this.leases.push(lease);
    for (const d of decks) if (d.loaded) this.tryClaim(lease, d, 'macro', grab, null);
    if (!lease.live) {
      // Every platter is under a finger. The caller degrades; it must not drive.
      this.retire(lease);
      return null;
    }
    this.settle();
    return lease;
  }

  /**
   * A claim has to go: the deck left the world, or the two threads disagree.
   * Also the reconciler's route for 'stale'.
   */
  revoke(deck: Deck, reason: RevokeReason): void {
    const holder = deck.heldBy;
    if (!holder) return;
    holder.loseClaim(deck, reason);
    this.settle();
  }

  /** Mode switch, pagehide, tab hidden. Order-independent, idempotent. */
  panicRelease(reason: RevokeReason): void {
    for (const lease of [...this.leases]) {
      for (const d of lease.decks) lease.loseClaim(d, reason);
    }
    this.settle();
  }

  /**
   * Called from every deck's 'pos' echo, 30–60 Hz. Sweeps the main-thread
   * deadline and re-derives the drum grid. NO engine.notify() on this path.
   */
  tick(): void {
    const now = this.now();
    for (const lease of [...this.leases]) {
      if (!lease.live) continue;
      if (now - lease.aliveAt <= LEASE_IDLE_SEC) continue;
      console.warn('[platter] lease idle past its deadline — taking it back', lease.kind);
      for (const d of lease.decks) lease.loseClaim(d, 'expired');
    }
    this.applyGrid();
  }

  onEvent(fn: (e: PlatterEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** @internal Lets the per-frame path skip building an event nobody reads. */
  get watched(): boolean {
    return this.listeners.size > 0;
  }

  /** @internal */
  emit(e: PlatterEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** @internal A lease with no claims is dead; nothing may resurrect it. */
  retire(lease: PlatterLease): void {
    const i = this.leases.indexOf(lease);
    if (i >= 0) this.leases.splice(i, 1);
  }

  /** @internal Grid plus one React notify — the acquire/release path only. */
  settle(): void {
    this.applyGrid();
    this.engine.notify();
  }

  /**
   * `transport.rateScale` has exactly ONE writer, and this is it.
   *
   * Two things fall out of deriving it from the worklet's ECHO rather than from
   * the hand. The drums wind back UP with the record across a macro's spinUp
   * instead of snapping to full speed while the record is still at 0.2x; and
   * normalising by nominalRate fixes a unit bug in the same expression, since a
   * deck at +19% tempo playing normally echoes vel = 1.19, which the old
   * setScratchVelocity read as a 19% grid speed-up.
   *
   * GOVERNED BY LIVE CLAIMS ONLY, never by a SETTLING deck. Extending the echo
   * through the hand-back window is where deriving-from-the-echo breaks: a
   * PAUSED deck releases with wantPlayAfter false and brakes toward zero, so its
   * vel decays through MIN_RATE_SCALE almost immediately and the beat machine
   * would literally stop for half a second every time a child let go of a paused
   * record — on a deck that is not even making the drums. A backward fling would
   * likewise clamp to 2 and run the drums double-time for ~0.3 s. Everything the
   * echo was wanted for happens while a lease still HOLDS the platter.
   *
   * One leader, not an aggregate: the drum grid is a solo instrument and should
   * follow the hand that is performing. With one gesture this is byte-for-byte
   * the old behaviour.
   */
  private applyGrid(): void {
    if (!this.engine.initialized) return;
    const gov = this.governingDeck();
    const next = gov ? clamp(Math.abs(gov.workletVel) / gov.nominalRate, 0, MAX_GRID_SCALE) : 1;
    if (Math.abs(next - this.lastGrid) < 1e-4) return;
    this.lastGrid = next;
    this.engine.transport.rateScale = next;
  }

  private governingDeck(): Deck | null {
    for (let i = this.leases.length - 1; i >= 0; i--) {
      const lease = this.leases[i];
      if (!lease.live) continue;
      // The deck under the hand, when there is one.
      if (lease.primary && lease.holds(lease.primary)) return lease.primary;
      // Otherwise (a macro, or a finger whose primary was taken) the fastest
      // platter this lease still holds is the one performing.
      let best: Deck | null = null;
      let bestMag = -1;
      for (const d of lease.decks) {
        const mag = Math.abs(d.workletVel) / d.nominalRate;
        if (mag > bestMag) {
          bestMag = mag;
          best = d;
        }
      }
      return best;
    }
    return null;
  }

  /**
   * The opening message, and why preemption still sounds seamless.
   *
   * scratchOn is posted UNCONDITIONALLY, including when the worklet already has
   * the platter. Skipping it as an optimisation is correct for macro->finger and
   * WRONG for the common SETTLING->finger case — a re-grab within the ~550 ms
   * spin-up, which is both the 'chika-chika' pattern and the moment right after
   * a tapestop. There `scratchActive` is true but `scratchHeld` is FALSE, and
   * scratchOn is the only code anywhere that sets it back to true. Without it the
   * platter runs on the 140 ms release constant instead of the 12 ms held one
   * (rubbery under the finger), and process() keeps calling maybeHandBack every
   * block — so the instant the hand's velocity passes within EXIT_EPS of `rate`,
   * which a forward scratch does constantly, the platter hands back to WSOLA
   * UNDER THE LIVE FINGER and every later jog is dropped at `if
   * (!this.scratchActive)`.
   *
   * The worklet's re-grab branch is already idempotent BY CONSTRUCTION and its
   * comment says so: it re-points velTarget and applies the jog without a second
   * handover or crossfade. Posting always costs one message and removes a whole
   * class of failure.
   *
   * What a child hears landing mid-tapestop: the record is winding down, they put
   * a finger on it, and it is under their finger at the speed it was already
   * going. That works because `positionSecNow` now extrapolates at the platter's
   * REAL velocity, so the first jog error is near zero and applyJog takes the
   * servo branch rather than the 2.9 ms splice.
   */
  private tryClaim(
    lease: PlatterLease,
    d: Deck,
    kind: ClaimKind,
    grab: PlatterGrab,
    primary: Deck | null
  ): boolean {
    if (d.heldBy && RANK[kind] <= d.heldRank) return false;
    // Synchronously, before the new owner exists: the incumbent stops writing BY
    // CONTRACT rather than by discipline. The old fight was two envelopes on one
    // velocity — a macro at 50 Hz against a finger at 60 Hz. After this the loser
    // physically has nowhere to write.
    if (d.heldBy) d.heldBy.loseClaim(d, 'preempted');
    lease.takeClaim(d, RANK[kind]);

    if (grab.inertiaSec !== undefined) {
      d.releaseTauSec = clamp(grab.inertiaSec, 0.02, 0.55);
      d.platterPost(lease, { type: 'scratchInertia', releaseSec: grab.inertiaSec });
    }
    // The primary opens at the position the gesture reported; a partner's
    // playhead is its own and has nothing to do with the hand's absolute frame.
    const seedSec =
      d === primary && grab.positionSec !== undefined ? grab.positionSec : d.positionSecNow;
    d.platterPost(lease, {
      type: 'scratchOn',
      frame: seedSec * d.sampleRate,
      velocity: (grab.spin ?? 0) * d.nominalRate,
    });
    this.emit({ type: 'grab', deck: d, kind: lease.kind });
    return true;
  }
}
