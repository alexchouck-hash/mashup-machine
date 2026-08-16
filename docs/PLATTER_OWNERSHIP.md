# Platter ownership — design

Status: **designed, NOT yet implemented.** Adversarial review returned
`needs-fixes`. The findings at the end are part of the design, not optional.

## Why this exists

Three drivers — a finger, a macro, and several passive readers — all consulted
one boolean that nobody owned. It was patched three times (an unconditional
`scratchOff`, a 0.6 s stall watchdog, and the deck link deferring on
`d.scratching`), each a guard on a symptom. The measured failure was a deck
frozen for EIGHT SECONDS while still reporting `playing: true`.

Owner ruling on the central question: **preempt — the finger always wins.**

## Judge's verdict (merge of two independent designs)

A has the right MECHANISM, B has the right TOPOLOGY, and each has one concrete defect the other fixes.

A's one door â€” `platterPost(lease, msg) { if (this.heldBy !== lease) return; ... }` â€” is the entire guarantee in one line, and it is enough. B's epoch buys nothing on top of it: the main thread is single-threaded and `postMessage` is ordered per port, so a preempted driver cannot post after the synchronous preemption, and its in-flight messages are legitimately ordered *before* it. The epoch is threaded through eight message types and is the single hardest thing in either design to hold in your head, in exchange for a guarantee the door already provides. Cut it.

But A's single global lease slot is wrong, and its own justification is the tell: "any two leases would always overlap totally". They do not. Two children on a tablet, one per SongTile, is the exact case â€” child B's *primary* intent is deck B while only the *fan-out* wants deck A. A's answer (last grab wins, child A's gesture aborts) puts a live finger on a dead platter, which is the failure this codebase already names as the worst available. B's primary/secondary rank split resolves it correctly with no special case: each child keeps their own record and the fan-out yields to a direct touch.

Two defects found by reading the code, one per design, and both are load-bearing:

1. **A's worklet TTL is broken.** Clearing `scratchHeld` alone drops into `maybeHandBack()` with `releaseAt` stale (0 or seconds old), so `late` is true immediately and the platter hands back at whatever velocity it is at â€” a pitch snap, which is exactly the thing the exit threshold at worklet L644-651 exists to prevent. B's version performs a real release (sets `wantPlayAfter`, `velTarget`, `releaseAt`) and spins up properly. Take B's.

2. **B's keepalive is broken.** Its 5 Hz interval is owned by the registry and pings for every live lease, so a macro that throws between `grab()` and `release()` leaves a lease object that renews the worklet TTL forever â€” L5 does not cover the failure it was written for. A's shape is right: the *driver* calls `keepAlive()`, and a lease not kept alive expires. That also removes the interval entirely (the ping is a throttled side effect of `keepAlive`), so there is no timer to leak.

3. **Neither noticed** that `Macros.grab`'s interval clears itself at `u >= 1`, leaving a silent gap to `spinUp` of `silenceBeats * beat - 0.045 s`. At the default 1 beat / 120 bpm that is 0.455 s â€” under the 1.0 s TTL. At 60 bpm it is 0.955 s, and `opts.silenceBeats` accepts up to 8. The platter times out mid-silence, `spinUp`'s catch-up seek is then declined, and the record lands off the grid. A's "keep ticking `spin(0)` through the silence" is required, not stylistic.

On the two judged criteria that separate them: A's `rateScale` from `lease.lastSpin` snaps the grid to 1 at finger-up while the record is still spinning up at 0.2x; B's derivation from the echoed `vel`, normalised by `nominalRate`, winds the drums back up *with* the record and fixes the +19%-tempo unit bug in the same expression. Take B's. And on legibility, the merged model is one sentence â€” *a claim on a deck, ranked; the only way to reach the port is a lease that still holds the claim* â€” which is A's sentence with B's noun.

---

# Platter ownership â€” final design

## The model, in one paragraph

A **claim** is a rank stamped on a deck: `deck.heldBy` (a `PlatterLease`) plus `deck.heldRank`. A **lease** is the only object in the app with methods that move a platter; it holds a set of claims captured at acquire and never recomputed. Every scratch message goes through one door on `Deck`, and that door's whole body is `if (this.heldBy !== lease) return`. A driver whose claim was taken has no way to express a write. `Deck.scratching` ceases to exist; the main thread's per-deck scratch state is a **mirror** of the `pos` echo the worklet already posts at 30â€“60 Hz, plus the claim this side issued. Passive readers ask exactly one question, `deck.platterBusy`, and never ask who.

Three deck states replace one boolean:

| state | means | `platterBusy` |
|---|---|---|
| FREE | no claim, echo says `scratching:false` | false |
| HELD | a live lease claims it | true |
| SETTLING | no claim, but the echo still says `scratching:true` â€” the up-to-1.5 s `maybeHandBack` spin-up | true |

SETTLING is the fix for a bug that is independent of ownership: `scratching` covered the *gesture*, while the worklet keeps the platter for `min(4, max(1.5, 7Â·releaseTau))` = **1.5 s** afterwards (worklet L644-651), and `holdLink` ticks through that whole window today on a deck it believes is free.

---

## 1. NEW FILE â€” `src/audio/platter.ts`

```ts
import type { Deck } from './Deck';
import type { AudioEngine } from './AudioEngine';

export type DriverKind = 'finger' | 'macro';

/**
 * Higher wins; equal loses. A finger's PRIMARY claim â€” the deck actually under
 * the hand â€” outranks the same gesture's fan-out onto the other platter, and
 * that one distinction is what makes two children come out right without a
 * special case. Child A grabs A: primary A (3), secondary B (2). Child B grabs
 * B: primary B (3) beats A's secondary and takes deck B; secondary A (2) loses
 * to A's primary (3) and is declined. Each child drives their own record, and
 * nobody's platter dead-stops.
 *
 * Equal rank LOSES (`>` not `>=`) so two fingers cannot thrash each other's
 * partner deck â€” the older secondary claim keeps it. Two primary claims on one
 * deck cannot occur: each deck has exactly one Turntable, and Turntable.onDown
 * already refuses a second pointer.
 */
const RANK = { primary: 3, secondary: 2, macro: 1 } as const;
type ClaimKind = keyof typeof RANK;

export type RevokeReason = 'preempted' | 'expired' | 'stale' | 'unloaded' | 'teardown';

/** Deadlines. See the header note on why there are three and not one. */
const KEEPALIVE_MS = 200;      // ping cadence -> 5 misses before the worklet TTL
const LEASE_IDLE_SEC = 1.0;    // main-thread sweep: a driver that stopped calling keepAlive
/** Must exceed the worklet's 1.5 s hand-back ceiling, or a legitimate spin-up
 *  reads as a disagreement. */
export const PLATTER_GRACE_SEC = 2.0;

export interface PlatterGrab {
  /** Seed the PRIMARY at this position, seconds. Omit to seed from the deck. */
  positionSec?: number;
  /** Opening speed as a fraction of each deck's OWN normal speed. Default 0 â€”
   *  a hand landing on a record stops it, which is what happens today. */
  spin?: number;
  /** Release laziness, seconds. Omit for the worklet's own default (0.14). */
  inertiaSec?: number;
  /** Per DECK, fired synchronously inside acquire/revoke. `deck === lease.primary`
   *  means this gesture is over; any other deck means the lease shrank. */
  onRevoked?: (deck: Deck, reason: RevokeReason) => void;
}

export type PlatterEvent =
  | { type: 'grab'; deck: Deck; kind: DriverKind }
  | { type: 'spin'; deck: Deck; fraction: number }
  | { type: 'free'; deck: Deck };

export class PlatterLease {
  readonly kind: DriverKind;
  /** The deck whose ABSOLUTE position this lease drives. null for a macro. */
  readonly primary: Deck | null;
  /** Claims still held. Captured at acquire, only ever shrinks. */
  get decks(): readonly Deck[];
  /** False once every claim is gone. Every method below is then a no-op. */
  get live(): boolean;
  /** Last fraction written â€” the grid reads this only as a fallback. */
  get spinNow(): number;

  /** FINGER path. `handRate` is source-seconds per wall-second, straight from
   *  Turntable. Converted ONCE here against the primary's own nominal rate. */
  move(positionSec: number, handRate: number): void;
  /** MACRO path. `fraction` is a multiple of each deck's OWN normal speed. */
  spin(fraction: number): void;
  /** Needle drop under the hand. Skips decks this lease no longer holds. */
  seek(deck: Deck, positionSec: number, play?: boolean): void;
  /** "still here". Free â€” call it per frame. Renews BOTH deadlines. */
  keepAlive(): void;
  /** Hand back every remaining claim. Idempotent. */
  release(): void;
}

export class Platters {
  constructor(engine: AudioEngine);
  /** One finger on `deck`: primary there, secondary on the rest of the group. */
  acquireFinger(deck: Deck, grab?: PlatterGrab): PlatterLease | null;
  /** A macro over `decks`: equal rank on all, no primary. Null if none granted. */
  acquireMacro(decks: Deck[], grab?: PlatterGrab): PlatterLease | null;
  /** A deck left the world. Drops it from whatever lease holds it. */
  revoke(deck: Deck, reason: RevokeReason): void;
  /** Mode switch, pagehide, tab hidden. Order-independent. */
  panicRelease(reason: RevokeReason): void;
  /** Called from Deck's 'pos' handler: sweeps deadlines, drives the drum grid. */
  tick(deck: Deck): void;
  /** Fx's seam. Returns an unsubscribe. No subscriber today â€” see step 9. */
  onEvent(fn: (e: PlatterEvent) => void): () => void;
}
```

### `acquire`, precisely

```
acquireFinger(deck, grab):
  if (!deck.loaded) return null          // scratchOn at length 0 is dropped silently
                                          // by the worklet (L284); a lease over a
                                          // platter it refused would be a lie from birth
  lease = new PlatterLease('finger', primary = deck)
  claim(deck, 'primary')                  // always granted; nothing outranks it
  for (d of engine.scratchGroup(deck))    // <- the ONLY call site, evaluated ONCE
    if (d !== deck) tryClaim(d, 'secondary')
  applyGrid(); engine.notify()
  return lease

acquireMacro(decks, grab):
  lease = new PlatterLease('macro', primary = null)
  for (d of decks) if (d.loaded) tryClaim(d, 'macro')
  if (!lease.live) return null            // every deck under a finger -> drop() degrades
  applyGrid(); engine.notify()
  return lease

tryClaim(d, kind):
  if (d.heldBy && RANK[kind] <= d.heldRank) return false   // declined
  if (d.heldBy) d.heldBy.loseClaim(d, 'preempted')          // fires onRevoked SYNCHRONOUSLY
  d.heldBy = lease; d.heldRank = RANK[kind]
  lease.claims.add(d)
  post the opening message (below)
  emit {type:'grab', deck:d, kind}
```

**The opening message, and why preemption is silent.** If the worklet ALREADY has this platter (`d.workletScratching`), the claim posts **nothing at all** â€” it only moves `heldBy`. Nothing dead-stops, nothing splices, no crossfade re-runs. That is safe because two pieces land together:

1. The incumbent stops writing *by contract*, synchronously, inside `tryClaim`. Today the fight is two envelopes on one velocity â€” a macro at 50 Hz against a finger at 60 Hz. After this, the loser physically has nowhere to write.
2. The new owner lands on the platter's REAL position and speed, because `positionSecNow` now extrapolates at `workletVel` (step 3). `Turntable.onDown` seeds `g.anchorSec` from it, so the finger's first jog error is ~0, `applyJog` takes the SERVO branch instead of the 2.9 ms hard splice, and `velTarget` walks from the macro's wind-down speed to the hand's speed over the 12 ms `kHeld` one-pole.

What a child hears landing mid-tapestop: the record is winding down, they put a finger on it, and it is under their finger at the speed it was already going. No dead stop, no scrape, no cancelled envelope fighting a hand. Nothing had to be refused to make that safe.

On a **fresh** claim (worklet idle) post `scratchOn { frame, velocity: spin * d.nominalRate }`, plus `scratchInertia` if `grab.inertiaSec` was given. `frame` comes from `grab.positionSec` for the primary and from `d.positionSecNow` for partners â€” a partner's playhead is its own.

**Do not add a `hard` splice on a re-grab.** Change worklet L292 `applyJog(m.frame, true)` â†’ `applyJog(m.frame, false)`: with a truthful `positionSecNow` the error is near zero, so forcing a splice there buys a scrape for nothing.

### `move` / `spin` â€” units, fixed once

The lease speaks in **spin fraction**: `1` = this record's own normal speed, `0` stopped, `-1` normal reverse. Each deck multiplies by its own `nominalRate` on the way out.

```ts
move(positionSec, handRate) {
  if (!this.live || !this.primary) return;
  // nominalRate is structurally in [0.49, 1.53] (tempoPercent is clamped to
  // +/-50, phaseTrim to +/-0.02), so this cannot divide by zero.
  this.spin(handRate / this.primary.nominalRate);
  this.primary.platterPost(this, { type: 'scratchJog',
                                   frame: positionSec * this.primary.sampleRate });
}
spin(fraction) {
  this.last = fraction;
  for (const d of this.claims)
    d.platterPost(this, { type: 'scratchRate', value: fraction * d.nominalRate });
  // NO engine.notify(). See the per-frame note carried over from Deck.scratchMove.
}
```

This is one bug in two costumes, ended by one unit choice. Today `KidsMode` passes the raw hand rate to both the grabbed deck and its partner, while `macros.grab` computes `1 + tempoPercent/100` â€” two conventions on one message. A partner at +19% tempo runs 19% slow for the whole gesture and comes out of beatmatch. As a fraction, both records bend by the same *ratio*, which is what keeps them locked. It also deletes `HeldDeck.rate` from macros (a wind-down envelope already IS a fraction) and makes the grid scale trivially derivable.

### `keepAlive` â€” the driver's own liveness, not the registry's

```ts
keepAlive() {
  if (!this.live) return;
  this.aliveAt = ctx.currentTime;                       // main-thread deadline
  if (now - this.pingedAt < KEEPALIVE_MS / 1000) return;
  this.pingedAt = now;
  for (const d of this.claims) d.platterPost(this, { type: 'scratchKeepAlive' });
}
```

There is deliberately **no interval in the registry**. If the registry pinged on behalf of every live lease, a macro that threw between `grab()` and `release()` would leave a lease object renewing the worklet's TTL forever â€” the deadline would never fire for the exact failure it exists to catch. The ping must be a side effect of the driver still running its own loop. No idle timer, nothing to leak.

### `release` / `loseClaim`

```ts
release() {
  if (!this.live) return;
  for (const d of [...this.claims]) {
    d.platterPost(this, { type: 'scratchOff' });   // NOTE: no `play` â€” see Race 7
    d.heldBy = null; d.heldRank = 0;
    emit {type:'free', deck:d};
  }
  this.claims.clear();
  platters.applyGrid(); engine.notify();
}
```

`scratchOff` carries **no `play` field**, so the worklet resolves from LIVE transport state â€” which its own comment at L332-336 says is the entire point of the bare form. `KidsMode` defeats that today by passing `e.wasPlaying`, snapshotted at pointerdown: grab the annulus, toggle play, lift, and the toggle is silently undone. Drop the field and the bug cannot be written. (Note the asymmetry already visible in today's code â€” the partner deck gets `undefined` and is correct; the grabbed deck gets the stale snapshot and is not.)

---

## 2. `public/worklets/stretch-processor.js`

Four edits, no new allocation, still a classic script.

```js
/**
 * A held platter is a LEASE, not a latch.
 *
 * process() gates the hand-back on !scratchHeld, so scratchHeld === true is an
 * UNBOUNDED lease by construction: a main thread that never runs again â€” a
 * backgrounded tab, a swallowed pointercancel, a driver that threw â€” leaves
 * this deck silent, reporting playing:true, forever, and nothing else in the
 * app can reach it. That is the eight-second freeze, with no upper bound.
 *
 * "No message for N seconds" is NOT a valid staleness test here: Turntable
 * deliberately stops emitting when the finger stops moving, and a hand resting
 * on a stopped platter is legitimately silent. Hence an explicit keepalive at
 * 5 Hz â€” five consecutive misses before this fires. The clock is currentTime,
 * so a suspended context freezes the TTL with the audio and it fires on resume,
 * which is what you want.
 */
const LEASE_TTL_SEC = 1.0;
```

**Constructor** (beside L159-160): `this.leaseAt = 0;`

**Factor the release** so the TTL provably takes the normal exit rather than a parallel one:

```js
  /** The one way a platter is handed back. Shared by scratchOff and the TTL. */
  releaseScratch(play) {
    this.scratchHeld = false;
    this.wantPlayAfter = play !== undefined ? !!play : this.playing;
    this.velTarget = this.wantPlayAfter ? this.rate : 0;
    this.releaseAt = currentTime;
    this.playing = this.wantPlayAfter;
  }
```
`case 'scratchOff'` (L329-343) becomes `if (!this.scratchActive) break; this.releaseScratch(m.play);` â€” its comment moves onto the method.

**Stamp and check.** `scratchOn`, `scratchRate`, `scratchJog` each set `this.leaseAt = currentTime`, plus:
```js
      case 'scratchKeepAlive':
        this.leaseAt = currentTime;
        break;
```
and in `process()` (L729-732):
```js
    if (this.scratchActive) {
      this.sanitizeScratch();
      if (this.scratchHeld && currentTime - this.leaseAt > LEASE_TTL_SEC) {
        this.releaseScratch(undefined);   // a real release: it spins up, it does not cut
        this.port.postMessage({ type: 'platterYield' });
      }
      if (!this.scratchHeld) this.maybeHandBack();
    }
```

Clearing `scratchHeld` alone would be a bug: `maybeHandBack` gates on `late = currentTime - this.releaseAt > limit`, and with `releaseAt` stale that is true immediately, so the platter hands back at whatever velocity it is at â€” a pitch snap, exactly what the 2%-of-rate exit threshold exists to prevent. `releaseScratch` sets `releaseAt`, so the TTL spins the record up over the normal 0.98 s instead.

**`platterYield` is the only new workletâ†’main message**, and it exists purely so a false timeout is observable in the console rather than inferred from a complaint. Every other transition is already carried by `pos.scratching` within 33 ms.

Worst case on a false timeout: the record spins up and the still-live driver re-acquires on its next `keepAlive`, which by the rules above is a servo, not a splice. Compare today's worst case: silent, frozen, `playing:true`, unbounded.

---

## 3. `src/audio/Deck.ts`

**Delete:** `STALL_SEC` (L17), `scratching` (L99), `stalledSince` (L101), `scratchStart` (L624-635), `scratchMove` (L646-651), `scratchRate` (L658-662), `scratchEnd` (L676-685, including its 12-line comment about why it posts unconditionally â€” the disagreement it was patching around cannot occur), `setScratchInertia` (L688-690, dead; folded into `PlatterGrab.inertiaSec`).

Deleting `scratching` breaks the build in **eight** places on purpose. This project has twice paid for a removed field whose consumers were never enumerated (`p1_toughness`, `best_of_5`); both deletions were correct and the enumeration was the missing step. Here the compiler does it.

**Add:**
```ts
  /** @internal The lease driving this platter, and its rank. Written ONLY by platter.ts. */
  heldBy: PlatterLease | null = null;
  heldRank = 0;
  /** Mirrored from 'pos' â€” the audio thread's own answer, at 30-60 Hz. */
  workletScratching = false;
  /** Signed, source frames per output frame. The platter's TRUE speed. */
  workletVel = 0;
  private disagreeSince = 0;

  /** Under a driver, or still settling back to the stretch engine. ASK THIS. */
  get platterBusy(): boolean { return this.heldBy !== null || this.workletScratching; }
  /** This record's own normal speed, in the worklet's velocity units. */
  get nominalRate(): number { return (1 + this.tempoPercent / 100) * (1 + this.phaseTrim); }

  /**
   * THE ONE DOOR. Every scratch message in the app is posted here and nowhere
   * else, and this line is the entire ownership guarantee.
   *
   * The old guards asked the wrong question: `if (!this.scratching) return`
   * asks "is ANYONE scratching" where the caller meant "may *I* drive this".
   * That is why a transient disagreement became permanent â€” the only call that
   * could free the platter refused to send. This asks the right question, once,
   * in the only place it matters, and it is per-DECK, so a lease that holds A
   * but lost B is refused on B even if its own claim list is stale.
   *
   * @internal â€” reachable only with a PlatterLease, which only Platters mints.
   */
  platterPost(lease: PlatterLease, msg: ScratchMsg): void {
    if (this.heldBy !== lease) return;
    this.node.port.postMessage(msg);
  }

  /** Unrefusable. The reconciler's hammer, and nothing else. @internal */
  platterForceOff(): void {
    this.node.port.postMessage({ type: 'scratchOff', play: this.playing });
  }
```

**`positionSecNow` (L266-271) becomes truthful under a scratch:**
```ts
  get positionSecNow(): number {
    // Extrapolate at what the platter is ACTUALLY doing. The old form used the
    // tempo-fader rate regardless, so during a scratch it reported a playhead
    // running forward at 1.0x while the record was under a hand at -0.4x.
    const vel = this.platterBusy ? this.workletVel : this.playing ? this.nominalRate : 0;
    if (vel === 0) return this.positionSec;
    const elapsed = Math.max(0, this.engine.ctx.currentTime - this.posUpdatedAt);
    // Two-sided: a reverse scratch extrapolates NEGATIVE, which the old
    // Math.min(durationSec, ...) did not bound.
    return clamp(this.positionSec + elapsed * vel, 0, this.durationSec);
  }
```
Its readers are `Turntable.onDown`'s anchor seed, Turntable's drawing and progress ring, `macros.grab`'s `posAtGrab`, `macros.grabbable`'s reverse-headroom test, `beatPhaseNow`, and through that `holdLink` and `alignPhaseTo`. All fixed at once, and this is what makes preemption seamless.

**`onWorkletMessage` (L437) â€” stop discarding what the audio thread already tells us.** `maybePostPosition` posts `vel` and `scratching` 30â€“60 times a second and the parameter type drops both on the floor. Widening it is the cheapest seam in the design and costs nothing at runtime.
```ts
  private onWorkletMessage(m: { type: string; frame?: number; playing?: boolean;
                                length?: number; vel?: number; scratching?: boolean }): void {
    switch (m.type) {
      case 'pos': {
        this.positionFrames = m.frame ?? 0;
        this.posUpdatedAt = this.engine.ctx.currentTime;
        this.workletScratching = m.scratching === true;
        this.workletVel = m.vel ?? (this.playing ? this.nominalRate : 0);
        this.checkPlatterAgreement();
        this.checkStalled();
        this.engine.platters.tick(this);      // deadline sweep + drum grid
        if (m.playing !== undefined && m.playing !== this.playing) { ... }   // unchanged
        break;
      }
      case 'platterYield':
        console.warn('[deck] platter lease expired on the audio thread', this.id);
        break;
      ...
```

**`unload()` (L414):** first line becomes `this.engine.platters.revoke(this, 'unloaded');`. The worklet's own `unload` handler already calls `resetScratch()` (L274), so no message is needed.

**`pushRate()` (L562-565):** use `this.nominalRate` â€” that expression is currently written out twice.

### What the stall watchdog becomes â€” split in two

Its current predicate `playing && !scratching && |Î”frame| < 2` is the exact **complement** of the state that strands a platter: disarmed in every stale-TRUE case (the one it was written for), armed in every stale-FALSE case, where it can fire a spurious `scratchOff{play:true}` at a platter a driver legitimately holds.

**The ownership half becomes a genuine disagreement detector.** It is kept, not because ownership is still racy, but because the two threads are joined by a channel that can lose a grab or a release with no driver at fault: `load` and `unload` clear the worklet's scratch state silently (L197, L274), `scratchOn` at length 0 is dropped (L284), and `postMessage` is not a delivery guarantee. Explicit ownership removes the *races*; it does not make the channel reliable.

```ts
  /**
   * The audio thread is the real owner; this side holds a claim on it. We check
   * the DISAGREEMENT itself rather than guessing at it from playhead motion â€”
   * a platter is allowed to sit still under a hand for a minute, and that motion
   * test was the old watchdog's whole false-positive surface.
   *
   * PLATTER_GRACE_SEC covers both the message round trip and the settling
   * window: after a release the worklet legitimately keeps the platter for up
   * to 1.5 s (maybeHandBack's ceiling), so no separate "settling" flag is
   * needed â€” the grace IS the settling allowance.
   */
  private checkPlatterAgreement(): void {
    const now = this.engine.ctx.currentTime;
    if ((this.heldBy !== null) === this.workletScratching) { this.disagreeSince = 0; return; }
    if (this.disagreeSince === 0) { this.disagreeSince = now; return; }
    if (now - this.disagreeSince <= PLATTER_GRACE_SEC) return;
    this.disagreeSince = 0;
    if (this.workletScratching) {
      // Nobody claims it and the worklet still has it. A release was lost.
      console.warn('[deck] platter held with no claim â€” forcing it back', this.id);
      this.platterForceOff();
    } else {
      // We claim a platter the worklet is not scratching â€” it refused or lost
      // the grab. Driving it would be writing into nothing; give it up loudly.
      console.warn('[deck] claim over a platter the worklet does not hold', this.id);
      this.engine.platters.revoke(this, 'stale');
    }
  }
```

**The motion half is kept, re-keyed, and demoted.** It is not provably unnecessary â€” a node can be disconnected, a context suspended, `produce()` can wedge â€” and none of those are ownership failures, so nothing above catches them.

```ts
  /**
   * A deck that is FREE, reads as playing, and is not advancing is wedged for a
   * reason that has nothing to do with ownership. Keyed on platterBusy, not on
   * a scratch flag, so it is disarmed for the whole settle window. The
   * scratchOff is a no-op at the worklet when nothing is scratching (L330), so
   * the effective remedy here is the 'play' â€” which is the right lever for
   * "playing but stopped".
   *
   * With the claim model this should never fire for a scratch reason. If it
   * does, that is a bug report, not routine self-healing â€” hence the distinct
   * message.
   */
  private checkStalled(): void { ... console.warn('[deck] wedged while playing (NOT a scratch)'); }
```

---

## 4. `src/audio/AudioEngine.ts`

```ts
  readonly platters = new Platters(this);
```
**Delete** `setScratchVelocity` (L346-350) and `releaseScratchVelocity` (L358-362). The `decks.some(d => d.scratching)` test in the latter is a permanent-poison hazard today â€” one stranded true flag freezes the drum grid for the rest of the party. There is nothing left to poison.

**`transport.rateScale` gets a single writer**, in `Platters.applyGrid()`, called from `tick()`:
```
governing deck =
  the `primary` of the most-recently-acquired live lease that has one;
  else, among that lease's claims, the deck with the largest |workletVel| / nominalRate;
  else, among SETTLING decks, the same;
  else none.
rateScale = none ? 1 : clamp(|d.workletVel| / d.nominalRate, 0, 2)
```
Two things fall out of deriving it from the ECHO rather than from the hand:
- The drums wind back **up** with the record across the spin-up, instead of snapping to full speed at finger-up while the record is still at 0.2x.
- The normalisation fixes the unit bug in the same expression: a deck at +19% tempo playing normally has `vel = 1.19`, which today reads as a 19% grid speed-up.

Cost is one echo period (~16 ms) of latency against a step duration of ~125 ms. Inaudible. Guard with an early-out when the value is unchanged, and keep the existing `if (!this.ready) return`.

One leader, not an aggregate: the drum grid is a solo instrument and should follow the hand that is performing. With one gesture this is byte-for-byte today's behaviour.

**Changed reads** (the compiler will find these):
- `anchorNextBeatTime()` L333: `a.scratching` â†’ `a.platterBusy`
- `holdLink()` L459 and L463: â†’ `d.platterBusy` / `leader.platterBusy`

**`scratchGroup` (L432-435) goes `private`**, called from exactly one place: `Platters.acquireFinger`. The view layer stops knowing a group exists.

**`init()`** registers, once:
```ts
    // The only lifecycle listeners in the app. Today the sole one anywhere in
    // src/ or public/ is Turntable's per-gesture window.blur, so an iOS home
    // press mid-gesture strands both platters with no main-thread bound at all.
    addEventListener('pagehide', () => this.platters.panicRelease('teardown'));
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.platters.panicRelease('teardown');
    });
```

---

## 5. `src/components/KidsMode.tsx` (L327-343)

The three fan-out loops collapse. `leaseRef` lives in `SongTile`, which is instantiated per deck â€” a ref in `KidsMode` would collide.

```tsx
  const leaseRef = useRef<PlatterLease | null>(null);
  const ttRef = useRef<TurntableHandle>(null);
  ...
  <Turntable
    ref={ttRef}
    deck={deck}
    color={color}
    onScratchStart={(e) => {
      leaseRef.current = engine.platters.acquireFinger(e.deck, {
        positionSec: e.positionSec,
        // Losing the deck under the hand means this gesture is over; losing the
        // fan-out partner to another child's finger does not.
        onRevoked: (d) => { if (d === e.deck) ttRef.current?.abort(); },
      });
    }}
    onScratchMove={(e) => {
      const l = leaseRef.current;
      if (!l) return;
      l.keepAlive();
      l.move(e.positionSec, e.rate);
    }}
    onScratchEnd={() => { leaseRef.current?.release(); leaseRef.current = null; }}
  />
```

---

## 6. `src/components/Turntable.tsx`

Three changes, all small.

1. **Heartbeat.** The emit gate (L442) requires â‰¥16 ms AND â‰¥0.5 ms of movement, so a hand that grabs, flings and holds still stops emitting entirely â€” and then nothing renews either deadline. Add a floor:
   ```ts
   const stale = now - g.lastEmitMs >= HEARTBEAT_MS;   // 200
   if (now - g.lastEmitMs >= EMIT_MIN_MS && (Math.abs(dSec) >= EMIT_MIN_SEC || stale)) {
   ```
   The re-emitted position is identical, so `applyJog`'s error is zero and it takes the servo branch â€” audibly free. This is also the honest fix for the thing Fx's crackle bed documents at length at L718 (a motionless hand sends no further update), replacing a self-decaying envelope with a heartbeat.

2. **`forwardRef` + `useImperativeHandle(ref, () => ({ abort: () => liveRef.current.end() }), [])`.** `abort()` is literally the existing `endGesture`, so it still fires `onScratchEnd` and the documented "exactly one end per start" invariant is preserved untouched â€” the release lands on a dead lease and is a no-op through the door. This is cheap insurance, not load-bearing: every path that revokes a *primary* claim today (mode switch, tab hidden, idle expiry) also ends the gesture by another route. It exists so the picture cannot lie about the sound, rather than relying on four separate accidents.

3. **Drop `wasPlaying`** from `ScratchStart` (L199) and `ScratchEnd` (L220). No consumer remains, and its only use was the Race 7 snapshot.

---

## 7. `src/audio/macros.ts` â€” where the code gets shorter

- `interface HeldDeck` (L319) â†’ `{ deck; posAtGrab; grabAt }`. **`rate` is deleted** â€” the envelope is already a fraction, and `spinUp`'s virtual playhead reads `h.deck.nominalRate` live.
- `private held: HeldDeck[]` (L385) keeps the virtual-playhead bookkeeping; add `private lease: PlatterLease | null = null`.
- **`grab()` (L834-865):**
  ```ts
    const lease = this.engine.platters.acquireMacro(decks, {
      spin: 1,
      onRevoked: (d) => {
        this.held = this.held.filter((h) => h.deck !== d);
        if (!this.lease?.live) { this.stopScratchTimer(); this.lease = null; }
      },
    });
    if (!lease) return;   // every platter is under a finger; nothing to hold
  ```
  **Deleted:** the defensive `stopScratchTimer()` first line; the per-deck `if (!d.loaded || d.scratching) continue` re-check; the `scratchStart`-then-`scratchRate` two-step and the six-line comment explaining why the 4 ms gap between them is survivable (`PlatterGrab.spin: 1` opens at the right speed); `HeldDeck.rate`.
- **The 20 ms interval no longer clears itself at `u >= 1`.** It keeps ticking `lease.spin(0)` + `lease.keepAlive()` until release. This is required, not stylistic: the gap from `u >= 1` (at `cut`) to `spinUp` (at `back - SPIN_LEAD`) is `silenceBeats Â· beat - 0.045 s`. At the default 1 beat / 120 bpm that is 0.455 s and safe, but at 60 bpm it is 0.955 s, and `opts.silenceBeats` accepts up to 8. Past the 1.0 s TTL the worklet yields mid-silence, `spinUp`'s catch-up seek is then declined, and the record lands off the drums â€” Race 4's failure mode reintroduced by the deadline meant to prevent worse. `spin(0)` is idempotent and near-free; `stopScratchTimer` survives only on the release path.
- **`spinUp()` (L876-883):** `this.lease?.seek(h.deck, ...)`. The one platter write in this file that forgot its guard (L880) now cannot be made without a live claim.
- **`release()` (L886-893):** `this.stopScratchTimer(); this.lease?.release(); this.lease = null; this.held = [];`. The "scratchEnd is a no-op on a deck that is not scratching" comment goes with it â€” it described a hope, not a mechanism.
- **Delete the redundant safety release at `back + 1.0`** (L573) and shrink `busyUntil` (L580) from `back + 1.05` to `back + 0.1`. Three deadlines now cover it, and the pads re-enable a second sooner.
- **`grabbable()` (L595-603):** `d.scratching` â†’ `!d.platterBusy`. This is a *schedule-time* estimate two bars early; `acquireMacro` decides at fire time. A child grabbing a platter in between means the drop's spoken note over-promises slightly while the gate and slam still play out â€” cosmetic, and the honest place for the imprecision.
- **`cancel()` (L1234-1276)** keeps its release-before-params ordering and its comment; the body becomes the two-line release.

Five pieces of defensive scaffolding go, and it is worth naming why they were all correct and all useless: every one is on the RELEASE side, while every remaining hole was on the ACQUIRE side. `Deck.scratchStart` had no re-entrancy guard and `scratchEnd` from any caller released the platter for everyone, so no amount of macro-side discipline could have helped. That is the evidence for structure over discipline.

---

## 8. `src/App.tsx`

`engine.platters.panicRelease('teardown')` as the FIRST line of both `enterKids` (L162-167) and `onExit` (L178-183). Ordering is no longer load-bearing â€” today `macros.releaseAll()` runs before React unmounts KidsMode, so the macro frees a platter the child is still holding and only afterwards does unmount end the gesture. With one claim per deck and idempotent release, whoever is asked first is correct.

---

## 9. Deferred on purpose â€” two audible changes, not in this change

`Fx.scratchNoiseStart/scratchNoise/scratchNoiseEnd` (L669-785) have **zero callers**; the crackle bed, the speed-tracked resonance and the reversal chirp have never made a sound. `Platters.onEvent` is the seam for them, and the wiring is ~10 lines against the `grab`/`spin`/`free` events. `setScratchInertia` likewise (folded into `PlatterGrab.inertiaSec`, with no caller setting it, so the worklet keeps its 0.14 s default).

Both are **excluded from this change**, and that is a hard sequencing rule, not a preference. This refactor's entire value proposition is *no audible change, structurally safer*. Shipping a never-before-heard crackle bed and a new release feel in the same commit makes it impossible to A/B whether the ownership rework changed the sound â€” which is the one question anyone will actually want answered.

---

## Where the token lives, and its lifetime

- **The claim lives on `Deck`** (`heldBy` + `heldRank`), because the guard has to be checkable at the door with no lookup, on the hot path, per deck.
- **The lease and the arbitration live in `src/audio/platter.ts`**, minted by `engine.platters`. The registry owns the rank table, the deadline sweep, and the single `rateScale` write.
- **Lifetime:** acquire â†’ last claim dropped. A lease with zero claims is dead and every method is a no-op.
- **`scratchGroup` interaction:** the group is evaluated **once**, inside `acquireFinger`, and the resulting claims are captured. Today acquire iterates `scratchGroup()` at t0 and release iterates a freshly recomputed one at t1; anything loading or unloading in between makes the two sets differ. An eject mid-gesture (the â button sits live and tappable during a gesture on the other platter, KidsMode L307-314) leaves an acquired-never-released deck whose stale-true flag permanently freezes the drum grid, permanently disables sync on that deck, and permanently degrades Tape stop to a classic drop. **A captured claim set has no second set to disagree with.**
- A deck that finishes loading mid-gesture does **not** join the lease. Duller than the alternative, and it cannot strand anything.
- When a child lifts and their partner-deck claim is released, it does **not** revert to the other child's earlier secondary claim. Claims only shrink. Predictable beats clever.

## The five release paths, and what each alone covers

| # | path | covers |
|---|---|---|
| 1 | `lease.release()` â€” idempotent, per remaining claim | the normal case; a stale lease cannot free a platter someone else now owns, because the door refuses it |
| 2 | captured claims | eject / load mid-gesture |
| 3 | preemption â€” `onRevoked` fires synchronously inside `tryClaim` | two drivers, two children |
| 4 | `panicRelease` â€” mode switch, `pagehide`, `visibilitychange` | teardown, order-independent |
| 5 | **two deadlines**: main-thread idle sweep (1.0 s, from the `pos` handler) and the worklet TTL (1.0 s, `currentTime`) | a throwing macro, a swallowed `pointercancel`, a backgrounded tab. The worklet TTL is **the only one that works with the main thread gone entirely** |

## Honest limits

- **Convergent, not atomic.** The two threads are never simultaneously consistent â€” they cannot be, across a message port. What is guaranteed is that any disagreement is *bounded*: 2.0 s main-thread grace, 1.0 s worklet TTL, 1.5 s legitimate hand-back. Today's equivalent bounds are infinity in one direction and permanent in the other. Acquire is optimistic and posts in the same tick, so no touch ever waits for a confirmation; only the bookkeeping is late, and it is biased toward "busy", which is the fail-safe direction.
- **SETTLING counts as busy, so `holdLink` will not correct a deck for up to 1.5 s after a scratch.** A real regression in sync responsiveness, and the right trade â€” during that window `holdLink` was previously computing phase from an extrapolation at the fader rate while the record ran at a hand's velocity, then needle-dropping it or re-pointing `velTarget` mid-spin-up. Correcting with garbage is worse than not correcting.
- **Not a net line reduction.** `platter.ts` is ~200 lines (half of it the header) against ~155 deleted. The win is *concentration*: five defensive sites, four of them provably on the wrong side of the problem, collapse into one invariant a reader can hold in their head.
- **A preempted macro's drop is compromised by design.** The wind-down stops being written and the catch-up seek is skipped for that deck, so the record may land off the drums. Refusing the finger would protect the effect and produce a dead control, which fails the owner's bar harder â€” "must feel right" and "must not sound wrong" are one requirement.
- **Not fixed, and deliberately not conflated:** (a) `cancel()` destroys `spinUp()`'s catch-up along with everything else, so a latched mix pad cancelling a drop mid-wind-down leaves the records `grabBeats` behind â€” a macro *scheduling* bug needing either `spinUp()` before `release()` in `cancel()`, or the `disabled={macros.busy}` the mix pads lack (KidsMode L670-683) and Drop/Tape stop/Rewind/Bridge already carry. (b) `Transport.stepDuration` divides by `rateScale` while `Macros.beatSec()`/`barSec()` (L1299-1310) compute from `60/bpm` with no `rateScale` term, so a scratch moves the transport's downbeats while leaving already-scheduled AudioParam automation where it is. This design does not change the *values* written to `rateScale` â€” only who may write them, turning 100+ writes/second from uncoordinated sources into one writer â€” but whoever lands it should know those two are one subsystem.

---

# Review findings — fold in before shipping

## [CRITICAL]

**Scenario.** Child scratches deck A, lifts, re-grabs within ~550 ms (the 'chika-chika' pattern, and also the exact moment after a tapestop's release when the record is visibly spinning back up). Calls: Turntable pointerup -> KidsMode.onScratchEnd -> lease.release() -> Deck.platterPost({type:'scratchOff'}) -> worklet L329-343 sets scratchHeld=false, wantPlayAfter=true, velTarget=rate; scratchActive STAYS true for the spin-up (from vel=0 that is ln(1/0.02)*0.14 = 0.548 s). Turntable pointerdown -> KidsMode.onScratchStart -> Platters.acquireFinger(A) -> tryClaim sees d.workletScratching === true and, per the design, POSTS NOTHING AT ALL. Child moves finger -> lease.move() -> scratchRate/scratchJog.

**Problem.** scratchHeld is still FALSE on the audio thread. The worklet's `scratchOn` handler (L283-316) is the only code anywhere that sets scratchHeld = true, and the design's acquire path skips it in exactly the case where the worklet has the platter but nobody holds it (SETTLING). Two consequences, both audible: (1) renderScratch L546 picks kv = kRelease (140 ms) instead of kHeld (12 ms), so the platter lags the hand by 140 ms and feels rubbery; (2) process() L731 keeps calling maybeHandBack() every 2.9 ms block, and the moment the child's hand velocity crosses within EXIT_EPS of `rate` â€” which a forward scratch does constantly â€” the platter hands back to WSOLA UNDER THE LIVE FINGER (scratchActive=false, playing=true). Every subsequent scratchJog/scratchRate is then dropped by the worklet's own `if (!this.scratchActive) break`, so the record just plays normally while the finger moves. 2.0 s later checkPlatterAgreement sees heldBy!==null && !workletScratching, calls revoke(A,'stale'), and the gesture aborts and the drawn platter snaps. The one-line 'silent preemption' optimisation is the whole failure: it is correct for macro->finger (scratchHeld is genuinely true there) and wrong for SETTLING->finger, and SETTLING is the common case.

**Fix.** Do not branch on workletScratching when opening a claim. Always post `scratchOn {frame, velocity}` â€” the worklet's re-grab branch (L287-295) is ALREADY idempotent by construction and its comment says so explicitly ('a swallowed pointercancel followed by a fresh press must not trigger a second handover'). It sets scratchHeld=true, applies the jog and re-points velTarget without a second handover or crossfade, which is precisely the seamless behaviour the design wants. Keep the L292 `applyJog(m.frame, true)` -> `false` change so the re-grab servos instead of splicing. If you insist on knowing the audio thread's held state, echo it: add `held: this.scratchHeld` to maybePostPosition (L713-721) and mirror it as deck.workletHeld â€” but the unconditional post is one line and needs no new field.

## [CRITICAL]

**Scenario.** Tap Tape stop (or Rewind) in Party Mode with both decks playing. Macros.drop('tapestop') schedules grab at grabAt, spinUp at back-SPIN_LEAD (back-0.045), release at back+SPIN_TAIL (back+0.06). Under the design, grab()'s 20 ms interval (SCRATCH_TICK_MS) 'no longer clears itself at u >= 1' and 'keeps ticking lease.spin(0) + lease.keepAlive() until release'. spinUp() fires at back-0.045, does the catch-up seek and lease.spin(1).

**Problem.** At least five interval ticks land between back-0.045 and back+0.06, and every one of them posts spin(0) -> scratchRate{value: 0}. spinUp's spin(1) is overwritten within 20 ms. With kHeld tau = 12 ms the record climbs to ~81% of rate and is dragged straight back down, so at the downbeat the platter is at roughly 0.2x with the gate half open â€” a wrong-pitch smear exactly where SPIN_LEAD's 45 ms was engineered to deliver 97.6% of full speed. Then release() at back+0.06 restarts the spin-up on kRelease (tau 0.14), reaching speed at ~back+0.60. The catch-up seek in spinUp() was computed for `now + SPIN_LEAD`, so the record also lands ~0.6 s of audio behind the grid â€” the exact failure the SPIN_ADVANCE arithmetic and the 'arrives at the RIGHT BAR' comment exist to prevent. The change intended to close the keepalive gap destroys the drop it was protecting. Note this also poisons the drum grid: applyGrid derives rateScale from |workletVel|/nominalRate, so with the record stuck near 0 the transport stays frozen (rateScale < MIN_RATE_SCALE) straight through the slam.

**Fix.** Split the two jobs the interval is doing. Past u >= 1 it must stop writing velocity and only keep the lease alive: `if (u >= 1) { this.spunDown = true; lease.keepAlive(); return; } ... lease.spin(rate*f); lease.keepAlive();` â€” or, simpler, keep today's stopScratchTimer() at u>=1 and start a separate bare keepalive interval at KEEPALIVE_MS. Either way spinUp() must be the last writer before release(). Cheapest of all: have spinUp() call stopScratchTimer() as its first line, which makes the ordering unconditional regardless of tick jitter.

## [MAJOR]

**Scenario.** Any drop where the deck's transport state changes during the hold. Concretely: tap Tape stop; while the records are winding down, a child taps the record graphic. In KidsMode the platter sits inside `<button onClick={() => deck.togglePlay()}>` (L320-350) and Turntable only swallows the click when swallowClick was set by a real grab, so a plain tap during a macro drop goes straight through to deck.pause(). Worklet L218-233: scratchActive so playing=false, wantPlayAfter=false, velTarget untouched because scratchHeld. Then Macros.release() fires and, per the design, posts `scratchOff` with NO `play` field.

**Problem.** The design deletes the `play` argument entirely (PlatterLease.release() takes none) on the strength of KidsMode's stale `wasPlaying` snapshot â€” but the only OTHER caller in the codebase, macros.ts L892 `h.deck.scratchEnd(true)`, passes `true` deliberately, and that `true` is the drop's contract: the record comes back at the slam. With the bare form the worklet resolves wantPlayAfter = this.playing = false and BRAKES. The song does not return on the downbeat and stays silent for the rest of the session until someone taps play. It is worse than a lost slam: spinUp() already set velTarget = rate, so the gate is wide open, and maybeHandBack's !wantPlayAfter branch (L661) waits for gate <= 0.02 â€” which never happens â€” so the platter is held for the full `late` deadline, min(4, max(1.5, 7*releaseTau)) = 1.5 s, playing at full speed while Deck.playing reads false, and then cuts dead. Deck.checkStalled cannot catch it either, because it is gated on this.playing.

**Fix.** Keep an explicit intent on the release. `PlatterLease.release(play?: boolean)`, defaulting to undefined (bare, live-state) for the finger path and passed `true` from Macros.release(). The KidsMode bug the design is actually fixing is the stale SNAPSHOT, not the existence of the field â€” dropping wasPlaying from ScratchStart/ScratchEnd fixes that on its own. Alternatively let PlatterGrab record `restorePlaying: boolean` at acquire and have release() use it, so a macro states its intent once where it is legible.

## [MAJOR]

**Scenario.** Two cases on the same mechanism. (a) Deck A is paused. Child grabs A's platter, wiggles it, lifts, while deck B plays and the drums run. (b) Child flings A's platter backwards at ~3x and lifts. In both, Platters.applyGrid() picks the SETTLING deck as governing ('else, among SETTLING decks, the same') and writes rateScale = clamp(|d.workletVel| / d.nominalRate, 0, 2) on every 'pos' echo.

**Problem.** (a) A paused deck releases with wantPlayAfter=false, so the worklet brakes toward 0 with tau 0.14; workletVel decays through MIN_RATE_SCALE (0.05) almost immediately and rateScale sits near 0 for ~0.57 s. Transport.frozen goes true and tick() returns early â€” the beat machine literally stops for half a second every time a child lets go of a paused record, on a deck that is not even the one making the drums. (b) On a backward fling, |workletVel|/nominalRate = 3 clamps to 2, so the drums run DOUBLE TIME for the ~0.3 s it takes vel to cross back through, instead of snapping to 1 as releaseScratchVelocity() does today. The design's stated cost â€” 'one echo period (~16 ms) of latency... Inaudible' â€” is wrong by two orders of magnitude: the real cost is the entire hand-back window, up to the 1.5 s maybeHandBack ceiling. Deriving from the echo is right DURING a hold; extending it through SETTLING is what breaks it.

**Fix.** Govern from live CLAIMS only, never from SETTLING decks: `if (no live lease has a claim) rateScale = 1`. Everything the design wanted from the echo â€” the drums winding up with the record across a macro's spinUp, the +19%-tempo unit fix â€” is preserved, because during spinUp the macro's lease still holds the platter. It only costs the wind-up on a finger release, which today does not exist anyway. Keep SETTLING in platterBusy for holdLink/anchorNextBeatTime, where 'busy' is genuinely the fail-safe answer; do not let it steer the grid.

## [MAJOR]

**Scenario.** Child is scratching deck A. An adult drags an MP3 onto deck A's SongTile â€” the onDragOver/onDrop handlers are on the outer tile div (KidsMode L243-247) and are live whether or not the deck is loaded. pick() -> deck.load(file) -> adopt() -> `this.node.port.postMessage({type:'load', channels})`. Worklet L192-197 calls resetScratch() FIRST, clearing scratchActive and scratchHeld silently.

**Problem.** The design revokes on unload() only ('unload()'s first line becomes platters.revoke(this,"unloaded")'). Nothing revokes on load/adopt. So the lease keeps its claim over a platter the worklet has already reset. deck.workletScratching goes false on the next 'pos'; checkPlatterAgreement takes the 'we claim a platter the worklet is not scratching' branch and does nothing for the full PLATTER_GRACE_SEC = 2.0 s. For those two seconds the child's finger drives a dead port (platterPost succeeds, the worklet drops every message at `if (!this.scratchActive) break`), positionSecNow extrapolates at a stale workletVel, and applyGrid governs from a deck with workletVel = 0 -> rateScale = 0 -> the drums freeze. Then revoke('stale') aborts the gesture and the drawn record snaps. The design's own captured-claim-set argument names eject as the case it fixes; load is the same case through a door it did not check.

**Fix.** Call `this.engine.platters.revoke(this, 'unloaded')` as the first line of adopt() as well as unload() â€” both are the point where the worklet's scratch state is reset behind the main thread's back. Worth a grep for every `port.postMessage({type:'load'|'unload'})` site and a one-line assertion that a revoke precedes each.

## [MAJOR]

**Scenario.** Tap Tape stop. Its release() timer is scheduled for back+0.06 via window.setTimeout. The main thread janks â€” prewarmJams/renderJam or analyzeTrack running on a tablet is enough to delay a timeout by a few hundred ms. busyUntil, which the design shrinks from back+1.05 to back+0.1, expires; a child taps Tape stop again at back+0.15. Macros.drop() passes the busy gate, schedules a new grab, and grab() calls acquireMacro(decks).

**Problem.** The first lease is still live and holds both decks at RANK.macro = 1. tryClaim's rule is `if (d.heldBy && RANK[kind] <= d.heldRank) return false`, and 1 <= 1, so the second macro is DECLINED on every deck. acquireMacro returns null, `if (!lease) return;` â€” the platters do nothing. But the second drop's macroGain automation is already on the audio timeline: the mix cuts to silence at `cut` and slams at `back` with no wind-down, no records moving, and no note explaining it. The design removed BOTH nets that made this impossible today: the redundant safety release at back+1.0 (macros.ts L573) and the `busyUntil = back + 1.05` that L578-580 documents as existing for exactly this ('so a second tap cannot push a deck onto `held` that the first drop's release timer is about to let go of'). Deleting stopScratchTimer() from the top of grab() compounds it â€” today that line kills an orphaned interval, and the design removes it while making an orphaned interval more likely, not less.

**Fix.** Either keep busyUntil at back + 1.05 (the deleted second is cosmetic; the failure is not), or make same-rank preemption legal for macros specifically â€” a newer macro lease taking a stale one is always the right answer because Macros is single-instance and its own onRevoked already tears down held/scratchTimer. Do not delete stopScratchTimer() from grab(); it is one line and it is the only thing that kills an interval whose lease acquisition failed.

## [MAJOR]

**Scenario.** tryClaim's pseudocode is `if (d.heldBy) d.heldBy.loseClaim(d, 'preempted'); d.heldBy = lease;` and the design states onRevoked 'fires synchronously inside acquire/revoke' without pinning it relative to the claim mutation. Sequence: a lease holds decks A and B; something preempts or revokes A; that lease's onRevoked handler calls a path that ends in release() â€” which is exactly what KidsMode's handler does today via `ttRef.current?.abort()` -> Turntable.endGesture() -> onScratchEnd -> leaseRef.current?.release().

**Problem.** If loseClaim fires onRevoked BEFORE removing d from this.claims and clearing d.heldBy, then release()'s loop `for (const d of [...this.claims]) d.platterPost(this, {type:'scratchOff'})` still sees d.heldBy === this and the door OPENS â€” the retiring lease posts scratchOff into the platter tryClaim is one line away from handing to the new owner, and sets d.heldBy = null underneath it. tryClaim then overwrites heldBy with the new lease, which (per the design) posts nothing because workletScratching is still true, so the incoming driver inherits a platter that is already spinning back up and un-held: Hole 1 again, but reached deterministically through preemption rather than through a re-grab. The whole guarantee is the single line `if (this.heldBy !== lease) return`, and its correctness rests on an ordering the design never states.

**Fix.** Make loseClaim's order explicit and comment WHY: remove d from claims and null d.heldBy/heldRank FIRST, then invoke onRevoked. State it as an invariant on the callback contract â€” 'onRevoked is called with the claim already gone; calling release() from inside it can never touch the revoked deck' â€” because every future implementer of onRevoked will otherwise reason the other way.

## [MINOR]

**Scenario.** Any caller passes PlatterGrab.inertiaSec above ~0.29 â€” the field the design newly exposes, clamped by the worklet at L349 to [0.02, 0.55]. Say acquireFinger(deck, {inertiaSec: 0.4}). Child flings the platter to -3x and lifts. maybeHandBack's limit becomes min(4, max(1.5, 7*0.4)) = 2.8 s, and the spin-up from vel=-3 to rate=1 takes ln(4/0.02)*0.4 = 2.12 s.

**Problem.** PLATTER_GRACE_SEC is 2.0 s and its comment asserts the worklet's ceiling is 1.5 s as a fact ('Must exceed the worklet's 1.5 s hand-back ceiling'). That fact is true only for the DEFAULT releaseTau of 0.14, and the same design adds the knob that falsifies it. checkPlatterAgreement then fires during a perfectly legitimate spin-up and calls platterForceOff(), which posts scratchOff into a worklet that is scratchActive && !scratchHeld â€” L329-343 runs releaseScratch again and RESETS this.releaseAt = currentTime, pushing the `late` deadline out by another 2.8 s. The 'unrefusable hammer' extends the disagreement it was written to end; it only terminates because vel happens to converge on its own. This is also the shape CLAUDE.md warns about: a constant asserted in prose, with the thing that breaks it shipped in the same change and no check.

**Fix.** Derive the grace instead of asserting it: export the worklet's own formula, `graceSec = min(4, max(1.5, 7*releaseTau)) + roundTripMargin`, and have Platters recompute it whenever inertiaSec is set. And make platterForceOff genuinely unrefusable by giving the worklet a distinct message (e.g. `scratchAbort`) that calls maybeHandBack's exit path directly rather than re-entering releaseScratch and re-stamping releaseAt.

## [MINOR]

**Scenario.** Tap Tape stop, then switch apps / lock the phone before the drop lands, in a browser that does not fire visibilitychange (or fires it after the throttle takes effect). Macros' 20 ms SCRATCH_TICK_MS interval â€” the sole source of keepAlive for a macro lease under the merged design â€” is throttled by every major engine to roughly 1 Hz in a background tab, while the AudioWorklet keeps running at full rate.

**Problem.** LEASE_TTL_SEC is 1.0 s, so 'five consecutive misses before this fires' is a foreground-only margin; in the background the margin is approximately zero and the TTL becomes a coin flip on timer jitter. The worklet yields mid-wind-down, posts platterYield, spins the record up during what should be the silence, and spinUp()'s catch-up seek then arrives at a platter the lease no longer effectively drives. The outcome is better than today's permanent freeze, so this is not a safety hole â€” but the design's stated margin is not the margin that exists in the case the TTL was written for.

**Fix.** Size the TTL off the ping cadence with real headroom against 1 Hz throttling â€” LEASE_TTL_SEC = 3.0 with KEEPALIVE_MS = 200 still bounds a stranded platter far below the 8 s freeze this whole exercise is about, and survives a backgrounded interval. Say in the comment that the number is set by background timer clamping, not by the ping rate, so nobody tightens it later.

## [MINOR]

**Scenario.** A deck's worklet node is disconnected, or produce() wedges, with no lease anywhere â€” the non-ownership wedge that checkStalled is explicitly retained for. checkStalled fires and, per the design, 'the scratchOff is a no-op at the worklet when nothing is scratching (L330), so the effective remedy here is the play'.

**Problem.** platterForceOff() is the only method the design gives that reaches the port, and it posts only `{type:'scratchOff', play: this.playing}`. The worklet's handler breaks immediately on `if (!this.scratchActive)`, so nothing at all is sent. Today's watchdog posts BOTH scratchOff and `{type:'play'}` (Deck.ts L453-454) and the second one is the remedy. The design names the remedy in prose and then removes the only line that delivers it, leaving checkStalled as a console.warn.

**Fix.** Give the reconciler an explicit `platterKick()` that posts `{type:'play'}`, and have checkStalled call it. Keep them as two named methods so the distinct intents â€” 'force the platter back' vs 'this deck is wedged for a non-scratch reason' â€” stay legible, which is the point of splitting the watchdog in the first place.

# Confirmed correct by review

- The one-door guarantee is sound in shape. `platterPost(lease, msg) { if (this.heldBy !== lease) return; ... }` is per-DECK, which is the right granularity: a lease holding A but preempted on B is refused on B even with a stale claim list. Cutting B's epoch is correct â€” the main thread is single-threaded and postMessage is ordered per port, so a synchronously-preempted driver genuinely cannot post afterwards.
- The primary/secondary rank split is the right topology and the two-children walkthrough checks out against the real code. Child A grabs deck A (primary 3 / secondary 2), child B grabs deck B: primary 3 beats the secondary 2 and takes B, while B's secondary 2 loses to A's primary 3 and is declined. Each child keeps their own record and neither platter dead-stops. Equal-rank-loses also correctly protects the older secondary.
- Turntable.onDown cannot produce two simultaneous primary claims: `if (g.pointerId !== null) return` at L334 plus `if (!e.isPrimary) return` at L335, one Turntable instance per deck, and onUp gated on pointerId (L405-407) so a second finger's pointerup cannot end the first gesture. The design's justification for making the primary claim unconditional holds.
- Making positionSecNow extrapolate at workletVel is a real bug fix, not just a preemption enabler. Today's L266-271 extrapolates at the tempo-fader rate regardless, so during a scratch it reports a playhead running forward at 1.0x while the record is under a hand at -0.4x â€” and that value feeds Turntable's anchor seed, the progress ring, macros.grab's posAtGrab, macros.grabbable's reverse-headroom test, beatPhaseNow, holdLink and alignPhaseTo. The two-sided clamp also fixes a genuine gap: Math.min(durationSec, ...) never bounded a reverse extrapolation below zero.
- The 'pos' message already carries `vel` and `scratching` (worklet L713-721) and onWorkletMessage's parameter type drops both on the floor (Deck.ts L437). Widening it is free at runtime and is the cheapest seam available; the design is right that the audio thread is already telling us what we need.
- SETTLING is a real, independent bug that predates the ownership question. holdLink's `d.scratching` test (L459/L463) covers only the gesture, while the worklet keeps the platter for the full maybeHandBack window â€” up to min(4, max(1.5, 7*releaseTau)) = 1.5 s at the default tau â€” so the link currently ticks through a spin-up on a deck it believes is free, computing phase from an extrapolation at the fader rate. Suppressing holdLink there is the right trade.
- The unit fix is real and correctly diagnosed. KidsMode L335-336 passes the raw hand rate to both the grabbed deck and its partner while macros.ts L844 computes `1 + tempoPercent/100` â€” two conventions on one message. A partner at +19% tempo (which matchTempo genuinely reaches; MAX_TEMPO_PERCENT is 50 and the comment at Deck L32-39 says a 100->120 match is +19.2%) runs 19% slow for the whole gesture. Expressing the lease in spin fraction and multiplying by each deck's own nominalRate is the correct fix, and nominalRate is structurally bounded to [0.49, 1.53] so the division in move() is safe.
- Capturing the claim set once at acquire is right, and the eject hazard is real: the â button lives in .deck-head (KidsMode L307-314) and stays tappable during a gesture on the other platter, so today's acquire-at-t0 / release-over-a-recomputed-scratchGroup-at-t1 genuinely leaves an acquired-never-released deck.
- Deleting AudioEngine.releaseScratchVelocity is correct on its own terms: `if (this.decks.some(d => d.scratching)) return` (L358-362) is a permanent-poison hazard today â€” one stranded true flag freezes transport.rateScale for the rest of the session with no path back.
- The macro-side scaffolding really can go, with one exception. The per-deck `if (!d.loaded || d.scratching) continue` re-check (L843) is genuinely replaced by tryClaim; the scratchStart-then-scratchRate two-step (L846-847) is genuinely replaced by opening at `scratchOn {velocity: spin * nominalRate}`, since the worklet sets vel = velTarget = v0 directly at L309-310; HeldDeck.rate is genuinely redundant. The exception is stopScratchTimer() at the top of grab(), which should stay â€” see the busyUntil finding.
- The finger-lands-mid-drop feel is right, and for the correct reason: with a truthful positionSecNow the finger's first jog error is near zero, so applyJog (L507-519) takes the DRIFT_SERVO branch rather than the 128-frame splice, and velTarget walks from the macro's wind-down speed to the hand's speed over the 12 ms kHeld one-pole. Refusing the finger to protect the effect would be the worse answer and the design says so.
- panicRelease on pagehide/visibilitychange closes a real gap â€” today the only lifecycle listener anywhere in src/ or public/ is Turntable's per-gesture window.blur (L268-274, L370), so an iOS home press mid-gesture has no main-thread bound at all. The return path is also clean: endGesture sets g.pointerId = null, so the deferred pointerup hits `e.pointerId === gRef.current.pointerId` as null and cannot produce an unpaired end.
- Making scratchGroup private with acquireFinger as its single call site is correct and enforceable â€” grep confirms Turntable is used only in KidsMode.tsx, so there is no DJ-mode scratch surface to migrate.
- Deferring the Fx crackle bed is the right call. Fx.scratchNoiseStart/scratchNoise/scratchNoiseEnd (L669-785) have zero callers anywhere in src/, so wiring them in this change would ship a never-before-heard sound alongside a refactor whose entire claim is 'no audible change'.

