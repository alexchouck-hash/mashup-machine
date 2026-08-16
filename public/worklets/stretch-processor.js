/**
 * stretch-processor.js — deck playback engine, WSOLA time-stretch + pitch shift,
 * plus a second engine for scratching.
 *
 * Per the spec, THIS OWNS PLAYBACK POSITION. play / pause / seek / rate / pitch
 * are messages; the playhead is reported back to the UI at ~30 Hz (60 Hz while
 * scratching, because the on-screen record has to track the hand).
 *
 * Two independent axes:
 *   rate  — tempo, pitch preserved (WSOLA overlap-add)
 *   pitch — frequency ratio, tempo preserved (resampled grain reads)
 * `pitch` exists for the harmonic-nudge assist: shift a deck a semitone or two
 * to stop two clashing keys grinding against each other.
 *
 * WSOLA (waveform-similarity overlap-add) is the same algorithm family as
 * SoundTouch, implemented inline because an AudioWorklet is a classic script and
 * cannot `import` a library — vendoring one would mean a separate bundle step.
 * Parameters are SoundTouch's defaults (40 ms sequence / 15 ms seek / 8 ms
 * overlap), which is what makes +/-8% clean on dance material.
 *
 * SWAP POINT: replace produce()/findOffset() with a SoundTouch WASM kernel and
 * nothing else in the app changes — the message protocol is the interface.
 *
 * At rate === 1 and pitch === 1 both stages are bypassed and playback is
 * bit-transparent.
 *
 * ── THE SCRATCH ENGINE ────────────────────────────────────────────────────
 * Scratching needs the exact opposite of WSOLA. Pitch MUST bend with hand speed
 * (that IS the sound of a scratch) and the playhead must be able to run
 * backwards. So there is a second render path — direct linear-interpolated
 * resampling at a SIGNED velocity — that takes ownership of the output only
 * while `scratchActive`. WSOLA's code is not touched by it: `lerp`,
 * `findOffset` and `produce` are unmodified, and with `scratchActive === false`
 * and no handover tail in flight every expression below collapses to exactly
 * what this file did before scratching existed.
 *
 * Three ideas carry the design:
 *
 *  1. ONE crossfade buffer, used in both directions. At every handover the
 *     RETIRING engine's next ~11.6 ms is rendered once into `xfBuf`, then the
 *     INCOMING engine writes the block normally and the stored tail is mixed
 *     over the top on a 0->1 ramp. Entering, the tail is free (already in the
 *     WSOLA FIFO); leaving, it is 512 frames of platter render. No interleaved
 *     dual-engine bookkeeping, and nothing allocates on the audio thread.
 *
 *  2. Scratch mode covers the RELEASE, not just the finger. `scratchOff` only
 *     re-points the velocity target; a one-pole inertia model carries `vel`
 *     there over ~0.55 s. That spin-up is the effect, and by the time the exit
 *     threshold trips the two engines are playing near-identical audio, so the
 *     crossfade back is trivially clean. Releasing a paused deck targets 0
 *     instead, which gives the turntable brake through the same path.
 *
 *  3. Latency parity prevents the position jump. WSOLA's AUDIBLE frame is
 *     `pos - fifoLen*rate`, not `pos`. Scratch entry seeds `scratchPos` from
 *     the audible frame and the scratch engine has no FIFO, so the playhead is
 *     continuous across both handovers.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Linear-interpolated read, for fractional (pitch-shifted) source positions. */
function lerp(x, pos) {
  const i = pos | 0;
  const f = pos - i;
  const a = x[i];
  const b = x[i + 1];
  return a + (b - a) * f;
}

// ── Scratch constants ───────────────────────────────────────────────────────

/** Handover crossfade: 11.61 ms @44.1k. Long enough to hide a pitch step. */
const XF_FRAMES = 512;
/** Jog/seek splice: 2.90 ms @44.1k. Short enough to read as a scrape, not a fade. */
const SPLICE_FRAMES = 128;
/** Linear interpolation has no anti-alias filter; past ~8x it is only noise. */
const VEL_MAX = 8;
/** |vel| at which the platter is fully audible. Below it the record is stopping. */
const STALL_KNEE = 0.02;
/** Hand back within 2% of `rate` — 0.34 semitone, under the audible step. */
const EXIT_EPS = 0.02;
/** Watchdog. An exponential never arrives, so scratch mode must have a deadline. */
const SPIN_MAX_SEC = 1.5;
/** Fraction of a small position error corrected per jog message. */
const DRIFT_SERVO = 0.25;
/** Velocity smoothing while a finger is down: kills 60 Hz pointer zipper. */
const HELD_TAU = 0.012;
/** Amplitude gate. */
const GATE_TAU = 0.004;
/** Release inertia, overridable per surface via 'scratchInertia'. */
const DEFAULT_RELEASE_TAU = 0.14;

/**
 * A HELD PLATTER IS A LEASE, NOT A LATCH.
 *
 * process() gates the hand-back on !scratchHeld, so scratchHeld === true is an
 * UNBOUNDED lease by construction: a main thread that never runs again — a
 * backgrounded tab, a swallowed pointercancel, a driver that threw — leaves this
 * deck silent, reporting playing:true, forever, and nothing else in the app can
 * reach it. That is the eight-second freeze, with no upper bound.
 *
 * "No message for N seconds" is NOT a valid staleness test here: Turntable
 * deliberately stops emitting when the finger stops moving, and a hand resting on
 * a stopped platter is legitimately silent. Hence an explicit keepalive at 5 Hz.
 *
 * THE NUMBER IS SET BY BACKGROUND TIMER CLAMPING, not by the ping rate — do not
 * tighten it to "five misses at 5 Hz". Macros' 20 ms interval is the only
 * keepalive a macro lease has, and every major engine throttles a background
 * interval to roughly 1 Hz while this worklet keeps running at full rate; at 1.0 s
 * the margin in the exact case this exists for (tap Tape stop, lock the phone) is
 * approximately zero. 3.0 s still bounds a stranded platter an order of magnitude
 * under the freeze it replaces.
 *
 * The clock is currentTime, so a suspended context freezes the TTL with the audio
 * and it fires on resume, which is what you want.
 */
const LEASE_TTL_SEC = 3.0;

/** One-pole coefficient for a time constant in seconds. */
function poleK(tau) {
  return 1 - Math.exp(-1 / (Math.max(tau, 0.001) * sampleRate));
}

/**
 * Linear-interpolated read that survives a position at the very last frame.
 * `lerp` reads x[i+1] unguarded because WSOLA's caller has already reserved a
 * grain's worth of headroom; the platter has no such margin — it can be parked
 * exactly on the final sample with the hand still moving.
 */
function readAt(x, pos) {
  // The caller guarantees 0 <= pos <= x.length-1, and a Float32Array cannot
  // exceed 2^29 elements (~3.4 h at 44.1 kHz), so `|0` truncation is exact.
  const i = pos | 0;
  const f = pos - i;
  const a = x[i];
  const b = i + 1 < x.length ? x[i + 1] : a;
  return a + (b - a) * f;
}

/** Two-sided wrap: a fling of several region-lengths either way lands inside. */
function wrapPos(p, s, span) {
  const r = (p - s) % span;
  return s + (r < 0 ? r + span : r);
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.channels = [];
    this.numCh = 2;
    this.length = 0;

    this.playing = false;
    this.pos = 0; // playhead, in source frames (float)
    this.rate = 1;
    this.pitch = 1;
    this.loop = false;
    // Loop region in source frames. loopEnd <= loopStart means "whole buffer".
    this.loopStart = 0;
    this.loopEnd = 0;

    // WSOLA parameters, in frames.
    this.overlap = Math.round(sampleRate * 0.008);
    this.seq = Math.round(sampleRate * 0.04);
    this.seekLen = Math.round(sampleRate * 0.015);
    this.flat = this.seq - this.overlap; // frames emitted per iteration

    this.tail = [new Float32Array(this.overlap), new Float32Array(this.overlap)];
    this.hasTail = false;

    // Output FIFO. One iteration emits `flat` frames; the graph consumes 128 at
    // a time, so we buffer the remainder.
    this.fifoCap = Math.max(sampleRate, this.flat * 4);
    this.fifo = [new Float32Array(this.fifoCap), new Float32Array(this.fifoCap)];
    this.fifoLen = 0;

    this.lastPost = 0;

    // ── Scratch state ──────────────────────────────────────────────────────
    // `playing` keeps its meaning: THE TRANSPORT IS RUNNING, which is what the
    // UI shows. scratchOn never sets it, so a paused deck can be scratched (it
    // makes sound and still reads paused) and the worklet never posts
    // playing:true back at a Deck that just called pause().
    this.scratchActive = false;
    this.scratchHeld = false; // a finger is down; false during spin-up/down
    this.playingBeforeScratch = false;
    this.wantPlayAfter = false;
    this.scratchPos = 0; // the platter's own playhead, source frames (float)
    this.vel = 0; // source frames per output frame, SIGNED
    this.velTarget = 0;
    this.gate = 0; // amplitude envelope: stalled/out-of-bounds platter is silent
    this.splicePos = 0;
    this.spliceLeft = 0;
    this.releaseAt = 0;
    /** currentTime of the last message from whoever holds this platter. */
    this.leaseAt = 0;

    // Coefficients are per-instance because they depend on sampleRate; computing
    // them here is what keeps the per-sample loop to one multiply-add.
    this.kHeld = poleK(HELD_TAU);
    this.kGate = poleK(GATE_TAU);
    this.releaseTau = DEFAULT_RELEASE_TAU;
    this.kRelease = poleK(DEFAULT_RELEASE_TAU);
    // Below 50 ms of error, a jog is a servo nudge rather than a splice — the
    // pointer feed is noisy and every splice costs a scrape.
    this.driftSoft = Math.round(sampleRate * 0.05);

    // The ONLY new allocation, 4 KB, made once. Both handover directions and
    // both channels share it; nothing on the audio thread allocates.
    this.xfBuf = [new Float32Array(XF_FRAMES), new Float32Array(XF_FRAMES)];
    this.xfLen = 0;
    this.xfPos = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load': {
        // BEFORE the buffers change: a scratch that outlived its buffer would
        // index `undefined` inside process(), and Chrome stops calling
        // process() for the life of a node that throws — the deck would go
        // silent forever with nothing surfaced.
        this.resetScratch();
        this.channels = m.channels.map((buf) => new Float32Array(buf));
        this.numCh = this.channels.length;
        this.length = this.numCh > 0 ? this.channels[0].length : 0;
        this.pos = 0;
        this.playing = false;
        this.resetStretch();
        this.port.postMessage({ type: 'loaded', length: this.length });
        break;
      }
      case 'play':
        if (this.scratchActive) {
          this.wantPlayAfter = true;
          this.playing = true;
          // Only re-point the platter if no one is holding it; overriding a
          // hand mid-gesture would fight the finger.
          if (!this.scratchHeld) this.velTarget = this.rate;
          break;
        }
        if (this.length > 0) this.playing = true;
        break;
      case 'pause':
        if (this.scratchActive) {
          // Brake, not a cut: reuse the spin-down path so pausing under the
          // hand sounds like a turntable powering off instead of clicking.
          this.wantPlayAfter = false;
          this.playing = false;
          // A finger still down OWNS the velocity — braking is the release's
          // job. Clearing scratchHeld here would swap the 12 ms held-velocity
          // constant for the 140 ms release one under a moving hand, and park
          // maybeHandBack() waiting for a gate that the finger keeps re-opening
          // until the watchdog fires.
          if (!this.scratchHeld) {
            this.velTarget = 0;
            this.releaseAt = currentTime;
          }
          break;
        }
        this.playing = false;
        this.resetStretch();
        break;
      case 'seek':
        if (this.scratchActive) {
          // Do NOT leave scratch — a cue jump under the hand is a needle drop.
          // It also proves the driver is alive: macros' catch-up seek is the last
          // thing that reaches this platter before the slam.
          this.leaseAt = currentTime;
          this.splicePos = this.scratchPos;
          this.spliceLeft = SPLICE_FRAMES;
          this.scratchPos = clamp(m.frame, 0, Math.max(0, this.length - 1));
          if (m.play === true) {
            this.wantPlayAfter = true;
            this.playing = true;
          }
          break;
        }
        this.pos = clamp(m.frame, 0, Math.max(0, this.length - 1));
        this.resetStretch();
        if (m.play === true && this.length > 0) this.playing = true;
        break;
      case 'rate':
        this.rate = clamp(m.value, 0.25, 4);
        // A tempo change during spin-up has to land on the NEW speed, or the
        // platter hands back at a velocity WSOLA is no longer playing at.
        if (this.scratchActive && !this.scratchHeld && this.wantPlayAfter) {
          this.velTarget = this.rate;
        }
        break;
      case 'pitch':
        this.pitch = clamp(m.value, 0.5, 2);
        this.resetStretch();
        break;
      case 'loop':
        this.loop = !!m.enabled;
        break;
      case 'loopRegion':
        this.loopStart = Math.max(0, Math.round(m.start || 0));
        this.loopEnd = Math.max(0, Math.round(m.end || 0));
        break;
      case 'unload':
        this.resetScratch(); // see 'load' — must precede clearing `channels`
        this.channels = [];
        this.length = 0;
        this.playing = false;
        this.pos = 0;
        this.resetStretch();
        break;

      // ── Scratch protocol ───────────────────────────────────────────────
      case 'scratchOn': {
        if (this.length === 0) break;
        this.leaseAt = currentTime;
        const hasFrame = Number.isFinite(m.frame);
        const hasVel = Number.isFinite(m.velocity);
        if (this.scratchActive) {
          // Re-grabbing a platter that is still spinning down, or one whose
          // previous owner was preempted. Idempotent on purpose: a swallowed
          // pointercancel followed by a fresh press must not trigger a second
          // handover, which is the one path that clicks.
          //
          // NOT a hard splice. The main thread's positionSecNow now extrapolates
          // at the platter's REAL velocity, so the incoming driver seeds within a
          // few frames of where the record actually is; forcing the 2.9 ms splice
          // here would buy a scrape for an error near zero. Let it servo.
          this.scratchHeld = true;
          if (hasFrame) this.applyJog(m.frame, false);
          if (hasVel) this.velTarget = clamp(m.velocity, -VEL_MAX, VEL_MAX);
          break;
        }
        this.playingBeforeScratch = this.playing;
        // Seed from the AUDIBLE frame, not `pos` — the FIFO holds audio the
        // listener has not heard yet, and the platter has no FIFO. Getting this
        // wrong steps the playhead by up to 32 ms at the grab.
        const seed = hasFrame ? m.frame : this.pos - this.fifoLen * this.rate;
        this.scratchPos = clamp(seed, 0, Math.max(0, this.length - 1));
        this.captureWsolaTail();
        this.resetStretch(); // the rest of the FIFO is superseded
        const v0 = clamp(
          hasVel ? m.velocity : this.playingBeforeScratch ? this.rate : 0,
          -VEL_MAX,
          VEL_MAX,
        );
        this.vel = v0;
        this.velTarget = v0;
        this.gate = this.playingBeforeScratch ? 1 : 0;
        this.spliceLeft = 0;
        this.scratchHeld = true;
        this.scratchActive = true;
        this.wantPlayAfter = this.playingBeforeScratch;
        break;
      }
      case 'scratchRate':
        // Signed, in source frames per output frame: 1 = normal forward,
        // -1 = normal reverse, 0 = stopped. `scratchHeld` is owned by
        // scratchOn/scratchOff, never by a velocity update.
        if (!this.scratchActive || !Number.isFinite(m.value)) break;
        this.leaseAt = currentTime;
        this.velTarget = clamp(m.value, -VEL_MAX, VEL_MAX);
        break;
      case 'scratchJog':
        if (!this.scratchActive || !Number.isFinite(m.frame)) break;
        this.leaseAt = currentTime;
        this.applyJog(m.frame, m.hard === true);
        break;
      // "Still here." The one message that carries no intent: a hand resting on
      // a stopped platter is legitimately silent, so liveness has to be stated
      // rather than inferred from traffic.
      case 'scratchKeepAlive':
        this.leaseAt = currentTime;
        break;
      case 'scratchOff':
        if (!this.scratchActive) break;
        this.releaseScratch(m.play);
        break;
      // The reconciler's hammer, and genuinely unrefusable — see abortScratch.
      case 'scratchAbort':
        this.abortScratch(m.play);
        break;
      case 'scratchInertia':
        // A DJ surface may want 0.05 s; a kids surface a lazier 0.4 s.
        if (!Number.isFinite(m.releaseSec)) break;
        // Upper bound is what the 4 s hand-back ceiling can actually service
        // (7 tau); promising a lazier release than that would be a lie.
        this.releaseTau = clamp(m.releaseSec, 0.02, 0.55);
        this.kRelease = poleK(this.releaseTau);
        break;
      default:
        break;
    }
  }

  /**
   * THE ONE WAY A PLATTER IS HANDED BACK. Shared by scratchOff and the lease TTL,
   * and factored precisely so the TTL provably takes the NORMAL exit rather than
   * a parallel one.
   *
   * `play` omitted resolves from LIVE transport state, not from the entry
   * snapshot: 'play', 'pause' and an idempotent re-grab can all change what the
   * deck is while scratchActive is still true, and a bare release must restore
   * what the deck IS, not what it was when the finger landed.
   *
   * Clearing scratchHeld ALONE would be a bug. maybeHandBack gates on
   * `late = currentTime - releaseAt > limit`, so with releaseAt stale (zero, or
   * seconds old) that is true immediately and the platter hands back at whatever
   * velocity it happens to be at — a pitch snap, exactly what the 2%-of-rate exit
   * threshold exists to prevent. Stamping releaseAt here is what makes the TTL
   * spin the record UP over the normal 0.98 s instead of cutting it.
   *
   * `vel` is deliberately not reset: the momentum at release is the throw.
   */
  releaseScratch(play) {
    this.scratchHeld = false;
    this.wantPlayAfter = play !== undefined ? !!play : this.playing;
    this.velTarget = this.wantPlayAfter ? this.rate : 0;
    this.releaseAt = currentTime;
    // The UI's transport state settles now; the AUDIO settles over the spin-up.
    this.playing = this.wantPlayAfter;
  }

  /**
   * Force the platter back NOW, for a main thread that has decided the two sides
   * genuinely disagree.
   *
   * Distinct from releaseScratch, and the distinction is the whole point: a
   * second scratchOff at a platter that is scratchActive && !scratchHeld RE-STAMPS
   * releaseAt and pushes the `late` deadline out by another full window, so the
   * "unrefusable hammer" would extend the disagreement it was written to end. This
   * takes maybeHandBack's exit unconditionally. It may cost a pitch step; that is
   * the correct price for a state that should not exist.
   */
  abortScratch(play) {
    if (!this.scratchActive) return;
    this.scratchHeld = false;
    this.wantPlayAfter = play !== undefined ? !!play : this.playing;
    this.velTarget = this.wantPlayAfter ? this.rate : 0;
    this.playing = this.wantPlayAfter;
    this.maybeHandBack(true);
  }

  resetStretch() {
    this.fifoLen = 0;
    this.hasTail = false;
  }

  /** Source frames consumed by one grain of `n` output frames at current pitch. */
  grainSpan(n) {
    return Math.ceil(n * this.pitch) + 2;
  }

  /**
   * Search +/- seekLen/2 around `base` for the offset whose waveform best
   * continues the previous tail. Coarse stride + subsampled correlation keeps
   * this ~30k ops per iteration (~31 iterations/sec at 44.1 kHz).
   */
  findOffset(base) {
    const x = this.channels[0];
    const t = this.tail[0];
    const ov = this.overlap;
    const p = this.pitch;
    const half = this.seekLen >> 1;

    const lo = Math.max(-half, -base);
    const hi = Math.min(half, this.length - base - this.grainSpan(this.flat + ov) - 1);
    if (hi <= lo) return 0;

    let best = 0;
    let bestScore = -Infinity;
    for (let o = lo; o < hi; o += 2) {
      let corr = 0;
      let norm = 0;
      const p0 = base + o;
      for (let i = 0; i < ov; i += 4) {
        const v = p === 1 ? x[p0 + i] : lerp(x, p0 + i * p);
        corr += t[i] * v;
        norm += v * v;
      }
      const score = corr / Math.sqrt(norm + 1e-9);
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }

  /** One WSOLA iteration: appends `flat` frames to the FIFO. */
  produce() {
    const ov = this.overlap;
    const flat = this.flat;
    const p = this.pitch;

    if (this.fifoLen + flat > this.fifoCap) return false;

    let base = Math.round(this.pos);
    if (base < 0) base = 0;

    const span = this.grainSpan(flat + ov);
    // A loop region lets a deck repeat just the chorus. It only constrains
    // playback while looping; without loop the deck plays to the end as usual.
    const useRegion = this.loop && this.loopEnd > this.loopStart;
    const regionStart = useRegion ? this.loopStart : 0;
    const regionEnd = useRegion ? Math.min(this.loopEnd, this.length) : this.length;

    if (base + span + 1 >= regionEnd) {
      // Wrapping to the region start keeps the loop in time when the region is
      // a whole number of bars. Drop the tail so the seam is not correlated
      // against audio from the other end of the region.
      if (!this.loop || regionEnd - regionStart <= span + 2) return false;
      this.pos = regionStart;
      base = regionStart;
      this.hasTail = false;
    }

    const offset = this.hasTail && (this.rate !== 1 || p !== 1) ? this.findOffset(base) : 0;
    const src = clamp(base + offset, 0, this.length - span - 1);

    for (let c = 0; c < this.numCh; c++) {
      const x = this.channels[c];
      const f = this.fifo[c];
      const t = this.tail[c];
      const w = this.fifoLen;

      if (p === 1) {
        if (this.hasTail) {
          for (let i = 0; i < ov; i++) {
            const g = i / ov;
            f[w + i] = t[i] * (1 - g) + x[src + i] * g;
          }
        } else {
          for (let i = 0; i < ov; i++) f[w + i] = x[src + i];
        }
        for (let i = ov; i < flat; i++) f[w + i] = x[src + i];
        for (let i = 0; i < ov; i++) t[i] = x[src + flat + i];
      } else {
        if (this.hasTail) {
          for (let i = 0; i < ov; i++) {
            const g = i / ov;
            f[w + i] = t[i] * (1 - g) + lerp(x, src + i * p) * g;
          }
        } else {
          for (let i = 0; i < ov; i++) f[w + i] = lerp(x, src + i * p);
        }
        for (let i = ov; i < flat; i++) f[w + i] = lerp(x, src + i * p);
        for (let i = 0; i < ov; i++) t[i] = lerp(x, src + (flat + i) * p);
      }
    }

    this.fifoLen += flat;
    this.hasTail = true;
    this.pos += this.rate * flat;
    return true;
  }

  // ── Scratch engine ─────────────────────────────────────────────────────────

  resetScratch() {
    this.scratchActive = false;
    this.scratchHeld = false;
    this.wantPlayAfter = false;
    this.scratchPos = 0;
    this.vel = 0;
    this.velTarget = 0;
    this.gate = 0;
    this.spliceLeft = 0;
    this.splicePos = 0;
    this.xfLen = 0;
    this.xfPos = 0;
  }

  /**
   * The same region definition WSOLA uses, read live so a loop toggled mid-
   * scratch bites immediately. Called once per block, never per sample.
   * A region narrower than 2 frames degenerates to the clamp path, which is
   * what keeps wrapPos from ever dividing by zero.
   */
  regionBounds() {
    const useRegion = this.loop && this.loopEnd > this.loopStart;
    const s = useRegion ? Math.max(0, this.loopStart) : 0;
    const e = useRegion ? Math.min(this.loopEnd, this.length) : this.length;
    const span = e - s;
    return { s, e, span, wrap: this.loop && span > 1 };
  }

  /**
   * Absolute position from the pointer. Small errors are servoed away below
   * perception; a genuine jump gets a 2.9 ms splice. Driving position directly
   * at pointer rate instead would stair-step the pitch, which is why velocity
   * and position arrive as separate messages.
   */
  applyJog(frame, hard) {
    let target = clamp(frame, 0, Math.max(0, this.length - 1));
    const r = this.regionBounds();
    if (r.wrap) target = wrapPos(target, r.s, r.span);
    const err = target - this.scratchPos;
    if (hard || Math.abs(err) > this.driftSoft) {
      this.splicePos = this.scratchPos;
      this.spliceLeft = SPLICE_FRAMES;
      this.scratchPos = target;
    } else {
      this.scratchPos += err * DRIFT_SERVO;
    }
  }

  /** Cheap insurance against a NaN reaching the render loop. Once per block. */
  sanitizeScratch() {
    if (!Number.isFinite(this.vel)) this.vel = 0;
    if (!Number.isFinite(this.velTarget)) this.velTarget = 0;
    if (!Number.isFinite(this.scratchPos)) this.scratchPos = 0;
    if (!Number.isFinite(this.gate)) this.gate = 0;
    if (!Number.isFinite(this.splicePos)) {
      this.splicePos = 0;
      this.spliceLeft = 0;
    }
  }

  /** Direct signed resampling. Pitch and rate are one axis here — that is the point. */
  renderScratch(out, n) {
    const nc = this.numCh;
    if (nc === 0 || !this.channels[0] || this.length === 0) return; // stays silent
    const xL = this.channels[0];
    const xR = this.channels[nc > 1 ? 1 : 0]; // a mono load feeds both, as WSOLA does
    const r = this.regionBounds();
    const s = r.s;
    const span = r.span;
    const wrap = r.wrap;
    const maxPos = this.length - 1;
    // Two time constants: tight under the hand so the pointer feed does not
    // zipper, loose on release so the record spins up over ~0.55 s.
    const kv = this.scratchHeld ? this.kHeld : this.kRelease;
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : out[0];

    for (let i = 0; i < n; i++) {
      // One-pole relaxation: cannot overshoot, needs no end-time bookkeeping,
      // and is what slipmat friction actually does.
      this.vel += (this.velTarget - this.vel) * kv;

      // Bounds are re-established BEFORE every read. This is the invariant that
      // keeps process() from ever throwing, and throwing is unrecoverable.
      let p = this.scratchPos;
      let pinned = false;
      if (wrap) {
        p = wrapPos(p, s, span);
      } else if (p < 0) {
        p = 0;
        pinned = true;
      } else if (p > maxPos) {
        p = maxPos;
        pinned = true;
      }

      // One envelope, three jobs: a stopped platter reads as DC rather than
      // silence, the end of a groove would hold a sample forever, and the fade
      // back in when the hand reverses comes free. Continuous in vel, so no
      // hysteresis is needed.
      const target = pinned ? 0 : Math.min(1, Math.abs(this.vel) / STALL_KNEE);
      this.gate += (target - this.gate) * this.kGate;
      const g = this.gate;

      if (this.spliceLeft > 0) {
        let q = this.splicePos;
        if (wrap) q = wrapPos(q, s, span);
        else q = q < 0 ? 0 : q > maxPos ? maxPos : q;
        const mix = this.spliceLeft / SPLICE_FRAMES; // 1 -> 0: the old groove out
        oL[i] = (readAt(xL, p) * (1 - mix) + readAt(xL, q) * mix) * g;
        oR[i] = (readAt(xR, p) * (1 - mix) + readAt(xR, q) * mix) * g;
        this.splicePos = q + this.vel;
        this.spliceLeft--;
      } else {
        oL[i] = readAt(xL, p) * g;
        oR[i] = readAt(xR, p) * g;
      }

      this.scratchPos = p + this.vel; // signed: a negative vel reads backwards
    }
  }

  /** Entry handover: the fade-out material is already sitting in the FIFO. */
  captureWsolaTail() {
    this.xfLen = 0;
    this.xfPos = 0;
    if (!this.playing || this.numCh < 1) return; // nothing audible to fade from
    let guard = 0;
    while (this.fifoLen < XF_FRAMES && guard++ < 4) {
      if (!this.produce()) break;
    }
    const k = Math.min(XF_FRAMES, this.fifoLen);
    if (k <= 0) return;
    this.xfBuf[0].set(this.fifo[0].subarray(0, k));
    this.xfBuf[1].set(this.fifo[Math.min(1, this.numCh - 1)].subarray(0, k));
    this.xfLen = k;
  }

  /** Exit handover: render the platter's next 11.6 ms, then retire it. */
  captureScratchTail() {
    this.xfLen = 0;
    this.xfPos = 0;
    const nc = this.numCh;
    if (nc === 0 || !this.channels[0] || this.length === 0) return;
    const xL = this.channels[0];
    const xR = this.channels[nc > 1 ? 1 : 0];
    const r = this.regionBounds();
    const s = r.s;
    const span = r.span;
    const wrap = r.wrap;
    const maxPos = this.length - 1;
    let p = this.scratchPos;
    // Frozen for the duration: a fade-out is a snapshot, and freezing keeps the
    // live state clean for whatever the incoming engine does next.
    const v = this.vel;
    const g = this.gate;
    for (let i = 0; i < XF_FRAMES; i++) {
      if (wrap) p = wrapPos(p, s, span);
      else p = p < 0 ? 0 : p > maxPos ? maxPos : p;
      this.xfBuf[0][i] = readAt(xL, p) * g;
      this.xfBuf[1][i] = readAt(xR, p) * g;
      p += v;
    }
    this.xfLen = XF_FRAMES;
  }

  /**
   * Exit is a THRESHOLD on |vel - rate|, not an event on finger-up: an
   * exponential never arrives, and 2% is 0.34 semitone — under the audible
   * step. The watchdog exists so scratch mode can never latch.
   */
  maybeHandBack(force) {
    // The deadline has to scale with the time constant it guards. A one-pole
    // needs ~7 tau to cover a full-scale fling (ln(9/EXIT_EPS) = 6.1), so a
    // fixed 1.5 s truncates the spin-up the moment a surface asks for a lazier
    // release — handing back at the WRONG velocity, which is a pitch snap, and
    // defeating the inertia model that is the whole point of the feature.
    const limit = Math.min(4, Math.max(SPIN_MAX_SEC, 7 * this.releaseTau));
    const late = force === true || currentTime - this.releaseAt > limit;
    if (this.wantPlayAfter) {
      const tol = EXIT_EPS * Math.max(1, Math.abs(this.rate));
      if (Math.abs(this.vel - this.rate) > tol && !late) return;
      this.captureScratchTail();
      // Rounding keeps `pos` integral, so the "bit-transparent at rate 1 and
      // pitch 1" property survives a scratch.
      this.pos = Math.round(clamp(this.scratchPos, 0, Math.max(0, this.length - 1)));
      this.playing = true;
    } else {
      if (this.gate > 0.02 && !late) return;
      // Braked to silence, so there is nothing to fade — only crossfade if the
      // watchdog cut the spin-down short.
      if (this.gate > 0.05) {
        this.captureScratchTail();
      } else {
        this.xfLen = 0;
        this.xfPos = 0;
      }
      this.pos = Math.round(clamp(this.scratchPos, 0, Math.max(0, this.length - 1)));
      this.playing = false;
    }
    this.scratchActive = false;
    this.scratchHeld = false;
    this.vel = 0;
    this.velTarget = 0;
    this.spliceLeft = 0;
    this.resetStretch();
  }

  /**
   * Mix the retiring engine's stored tail over what the incoming engine just
   * wrote. LINEAR, not equal-power: the two streams are the same audio at
   * nearly the same position and speed, so they sum coherently and equal-power
   * would put a +3 dB bump in the middle of every release.
   */
  mixHandoverTail(out, n) {
    const k = Math.min(n, this.xfLen - this.xfPos);
    const denom = this.xfLen; // > 0, guaranteed by the caller
    for (let c = 0; c < out.length; c++) {
      const t = this.xfBuf[Math.min(c, 1)];
      const o = out[c];
      for (let i = 0; i < k; i++) {
        const g = (this.xfPos + i) / denom; // 0 -> 1: the incoming engine in
        o[i] = o[i] * g + t[this.xfPos + i] * (1 - g);
      }
    }
    this.xfPos += k;
    if (this.xfPos >= this.xfLen) {
      this.xfLen = 0;
      this.xfPos = 0;
    }
  }

  maybePostPosition() {
    // 60 Hz while scratching: the record graphic is tracking a hand, and 30 Hz
    // of position under a finger reads as lag.
    if (currentTime - this.lastPost < (this.scratchActive ? 1 / 60 : 1 / 30)) return;
    this.lastPost = currentTime;
    // The FIFO holds already-produced audio, so the audible playhead lags `pos`.
    // The platter has no FIFO, so its position is already the audible one.
    const heard = this.scratchActive ? this.scratchPos : this.pos - this.fifoLen * this.rate;
    this.port.postMessage({
      type: 'pos',
      frame: clamp(heard, 0, this.length),
      playing: this.playing,
      // Reported in BOTH modes so the record widget spins off one field and
      // never needs a mode branch.
      vel: this.scratchActive ? this.vel : this.playing ? this.rate : 0,
      scratching: this.scratchActive,
    });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const n = out[0].length;

    if (this.scratchActive) {
      this.sanitizeScratch();
      if (this.scratchHeld && currentTime - this.leaseAt > LEASE_TTL_SEC) {
        // A REAL release, not a flag clear: it spins the record up over the
        // normal window rather than cutting it at whatever velocity it is at.
        this.releaseScratch(undefined);
        // The only new worklet->main message, and it exists purely so a false
        // timeout is observable in the console rather than inferred from a
        // complaint. Every other transition is already carried by pos.scratching
        // within 33 ms. Worst case on a false positive: the record spins up and
        // the still-live driver re-acquires on its next keepAlive, which by the
        // rules above is a servo, not a splice. Compare the case this replaces:
        // silent, frozen, playing:true, unbounded.
        this.port.postMessage({ type: 'platterYield' });
      }
      if (!this.scratchHeld) this.maybeHandBack(false); // may clear scratchActive
    }

    // Identical to the original `!this.playing || this.length === 0` whenever
    // no scratch and no tail are in flight (`0 >= 0`). The tail term matters
    // because a braked release finishes AFTER the transport has stopped, and
    // returning early there would end it on a hard cut.
    if (
      this.length === 0 ||
      (!this.playing && !this.scratchActive && this.xfPos >= this.xfLen)
    ) {
      this.maybePostPosition();
      return true; // outputs stay zero-filled = silence
    }

    if (this.scratchActive) {
      this.renderScratch(out, n);
    } else if (this.playing) {
      let ended = false;
      while (this.fifoLen < n) {
        if (!this.produce()) {
          ended = true;
          break;
        }
      }

      const avail = Math.min(n, this.fifoLen);
      for (let c = 0; c < out.length; c++) {
        const srcCh = this.fifo[Math.min(c, this.numCh - 1)];
        out[c].set(srcCh.subarray(0, avail));
      }

      if (avail > 0) {
        for (let c = 0; c < this.numCh; c++) {
          this.fifo[c].copyWithin(0, avail, this.fifoLen);
        }
        this.fifoLen -= avail;
      }

      if (ended && this.fifoLen === 0) {
        this.playing = false;
        this.resetStretch();
        this.port.postMessage({ type: 'ended' });
      }
    }
    // else: the transport stopped with a tail still pending. Outputs stay
    // zero-filled and the tail below fades out against silence, which is
    // exactly what a record powering down should do.

    if (this.xfPos < this.xfLen) this.mixHandoverTail(out, n);

    this.maybePostPosition();
    return true;
  }
}

registerProcessor('stretch-processor', StretchProcessor);
