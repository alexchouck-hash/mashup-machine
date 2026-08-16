import type { AudioEngine } from './AudioEngine';
import { impulseResponse, noiseBuffer, saturator, subRootHz } from './drums';

const FLOOR = 0.0001;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** Missing analysis and a paused transport both arrive as NaN. Neither is a Hz. */
const fin = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/* ---------------------------------------------------------------------- horn */

/**
 * Saw partials for the fanfare, as [frequency multiplier, level].
 *
 * 1.0041 and 0.9956 are ±7 cents: two detuned unisons beat against the root at
 * ~1.5 Hz and 1.6 Hz, which is what turns a saw into a horn SECTION rather than
 * one synth. The stabs get a thinner stack than the held note on purpose — a
 * pickup should read as punctuation, not as the arrival.
 */
const HORN_STAB_PARTIALS: readonly (readonly [number, number])[] = [
  [1, 0.5],
  [1.0041, 0.46],
  [2, 0.18],
];
const HORN_LONG_PARTIALS: readonly (readonly [number, number])[] = [
  [1, 0.5],
  [1.0041, 0.44],
  [0.9956, 0.44],
  [2, 0.2],
  [2.994, 0.1],
];
/** Perfect fifth. Consonant against major and minor alike, unlike a third. */
const FIFTH = 1.49831;

/* ---------------------------------------------------------------------- echo */

export type EchoDiv = '1/4' | '1/8d' | '1/8' | '1/16';

/** Delay time as a multiple of one beat. */
const ECHO_MULT: Record<EchoDiv, number> = { '1/4': 1, '1/8d': 0.75, '1/8': 0.5, '1/16': 0.25 };

const ECHO_DAMP_OPEN = 4200;
const ECHO_DAMP_HELD = 1500;
/** Feedback ceiling. Below 1 by construction — see FB_TRIM and BUTTERWORTH_Q. */
const ECHO_FB_MAX = 0.84;

/**
 * Maximally flat Q for a lowpass or highpass — MEASURED, not assumed.
 *
 * Web Audio takes `Q` in DECIBELS for lowpass and highpass (and linearly for
 * every other type), so the textbook non-resonant 0.707 is a +1.74 dB resonance
 * here, and even Q = 0 peaks by +1.25 dB. Inside a feedback loop that is not a
 * flavour, it is the difference between a delay and a howl: at Q = 0.5 the two
 * damping filters alone put this loop's gain at 0.84 x 1.20^2 = 1.21, which
 * measured as +1.1 dB of growth per round trip with the input already gone.
 * -3.01 dB is linear Q = 0.7071, whose measured peak response is exactly 1.0000.
 */
const BUTTERWORTH_Q = -3.01;

/**
 * Feedback-path saturation, and the trim that makes it provably safe.
 *
 * `saturationCurve` maps drive to k = drive * 6 and normalises so y(±1) = ±1,
 * which leaves the SMALL-SIGNAL slope at k/tanh(k) — +4.8 dB at k = 1.6. Inside
 * a feedback loop that is a howl, not a character, so FB_TRIM cancels it
 * exactly: the loop's small-signal gain is then the feedback gain and nothing
 * else, and the tanh can only ever compress LARGE signals further. That is the
 * no-runaway guarantee, and it doubles as "every repeat degrades".
 *
 * Two details that are not decoration. `drive` is clamped to 0..1 by the curve,
 * so the k we want has to be requested as k/6 — asking for 1.6 directly would
 * silently build k = 6 and leave the loop at gain 2.9. And k is read back
 * through the curve's own 1/512 quantisation rather than assumed, because
 * trimming for a k the curve did not build leaves the loop hot by the rounding.
 */
const FB_DRIVE = 1.6 / 6;
const FB_K = (Math.round(FB_DRIVE * 512) / 512) * 6;
const FB_TRIM = Math.tanh(FB_K) / FB_K;

interface EchoNet {
  send: GainNode;
  dlyL: DelayNode;
  dlyR: DelayNode;
  dampL: BiquadFilterNode;
  dampR: BiquadFilterNode;
  fb: GainNode;
}

/* ------------------------------------------------------------------- scratch */

/** Both sides of a reversal must be moving this fast for a chirp to be real. */
const CHIRP_MIN_V = 0.8;
/** Without a lockout a hand wobbling over zero machine-guns the needle. */
const CHIRP_LOCKOUT_MS = 55;

interface ScratchVoice {
  src: AudioBufferSourceNode;
  bp: BiquadFilterNode;
  res: BiquadFilterNode;
  vg: GainNode;
  lastV: number;
  lastSigned: number;
  lastChirpMs: number;
}

/**
 * Performance FX and the build/drop macros.
 *
 * Hold FX (filter, echo, stutter) act on the master FX stage between the sum bus
 * and the master gain, so they hit the decks and the beat machine alike.
 * One-shots (horn, riser, drop impact) are routed POST-gate, so a drop's impact
 * and an air horn still land while the gate is cutting everything else.
 *
 * Two networks are built here rather than taken from the engine. The ECHO is
 * ours because the engine's delay hides its feedback gain and damping filter in
 * locals — reachable code cannot open them, so a real DJ echo cannot be built on
 * that path; `engine.delaySend` stays pinned at 0 and we tap the same two points
 * it did. The SCRATCH crackle bed joins at the sum bus through `addSource`, so
 * the swoosh filters it and the stutter chops it exactly as they would real
 * surface noise coming off a record.
 */
export class Fx {
  private engine: AudioEngine;
  private stutterOsc: OscillatorNode | null = null;
  private stutterDepth: GainNode | null = null;
  private echo: EchoNet | null = null;
  private scratchBus: GainNode | null = null;
  private scratchVoices = new Map<string, ScratchVoice>();

  filterOn = false;
  echoOn = false;
  stutterOn = false;
  echoDiv: EchoDiv = '1/8d';
  /** ctx time by which the released echo tail has fully drained. */
  private echoTailUntil = 0;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  private get ctx(): AudioContext {
    return this.engine.ctx;
  }

  /** Low-pass swoosh. Hold to close the filter, release to open it. */
  setFilter(on: boolean): void {
    this.filterOn = on;
    const t = this.ctx.currentTime;
    const f = this.engine.fxFilter.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(Math.max(f.value, 40), t);
    f.exponentialRampToValueAtTime(on ? 320 : 20000, t + 0.25);
    this.engine.notify();
  }

  /* ---------------------------------------------------------------- DJ echo */

  /**
   * Build the echo network. Lazy and idempotent, so it costs nothing until the
   * button is first pressed and cannot be broken by engine init ordering.
   *
   * Ping-pong: the send feeds the LEFT line only, and left feeds right, so taps
   * land at D, 2D, 3D… alternating sides — repeat spacing D, with the width
   * arriving for free. The feedback tap is taken after the RIGHT line, so one
   * trip round the loop is 2D.
   *
   * Loop gain is bounded by construction: FB_TRIM cancels the shaper's
   * small-signal slope and every filter in the loop is flat-to-unity at
   * BUTTERWORTH_Q, so small-signal loop gain is exactly `fb` ≤ 0.84 < 1 — a
   * strict contraction, measured at 0.84 per round trip on an impulse. tanh is
   * odd so it generates no DC, and the 130 Hz highpass removes any that leaks
   * in from the source material.
   */
  private ensureEcho(): EchoNet {
    if (this.echo) return this.echo;
    const ctx = this.ctx;

    const send = ctx.createGain();
    send.gain.value = 0;

    const dlyL = ctx.createDelay(2);
    const dlyR = ctx.createDelay(2);
    dlyL.delayTime.value = 0.375;
    dlyR.delayTime.value = 0.375;

    const dampL = ctx.createBiquadFilter();
    dampL.type = 'lowpass';
    dampL.frequency.value = ECHO_DAMP_OPEN;
    dampL.Q.value = BUTTERWORTH_Q;
    const dampR = ctx.createBiquadFilter();
    dampR.type = 'lowpass';
    dampR.frequency.value = ECHO_DAMP_OPEN;
    dampR.Q.value = BUTTERWORTH_Q;

    const panL = ctx.createStereoPanner();
    panL.pan.value = -0.65;
    const panR = ctx.createStereoPanner();
    panR.pan.value = 0.65;

    const wet = ctx.createGain();
    wet.gain.value = 0.7;

    const fb = ctx.createGain();
    fb.gain.value = 0;
    const fbSat = saturator(ctx, FB_DRIVE, '2x');
    const fbTrim = ctx.createGain();
    fbTrim.gain.value = FB_TRIM;
    const fbHP = ctx.createBiquadFilter();
    fbHP.type = 'highpass';
    fbHP.frequency.value = 130;
    fbHP.Q.value = BUTTERWORTH_Q;

    // Tape wow: opposite signs so the two lines drift apart as well as wobble,
    // which is what stops a long hold sounding like a digital ring buffer.
    // Bounds: base time is clamped to [0.03, 1.60], so delayTime stays inside
    // [0.0289, 1.6011] — never ≤ 0, never past the 2 s line length.
    const wowOsc = ctx.createOscillator();
    wowOsc.frequency.value = 0.27;
    const wowL = ctx.createGain();
    wowL.gain.value = 0.0011;
    const wowR = ctx.createGain();
    wowR.gain.value = -0.0011;

    this.engine.fxGate.connect(send);
    send.connect(dlyL);
    dlyL.connect(dampL);
    dampL.connect(panL).connect(wet);
    dampL.connect(dlyR);
    dlyR.connect(dampR);
    dampR.connect(panR).connect(wet);
    dampR.connect(fb);
    fb.connect(fbSat).connect(fbTrim).connect(fbHP).connect(dlyL);
    wet.connect(this.engine.macroGain);

    wowOsc.connect(wowL).connect(dlyL.delayTime);
    wowOsc.connect(wowR).connect(dlyR.delayTime);
    wowOsc.start();

    this.echo = { send, dlyL, dlyR, dampL, dampR, fb };
    return this.echo;
  }

  /**
   * DJ echo. Hold for repeats that bloom and darken; release freezes the send
   * and lets the tail decay out instead of cutting it dead.
   *
   * `engine.delaySend` is deliberately never written — see the class doc.
   */
  setEcho(on: boolean, div?: EchoDiv): void {
    // A release that was never pressed — a cancelled pointer, releaseAll on a
    // fresh engine — must not be what builds the network.
    if (!on && !this.echo) return;
    const e = this.ensureEcho();
    const t = this.ctx.currentTime;
    const wasOn = this.echoOn;
    const divChanged = div !== undefined && div !== this.echoDiv;
    if (div !== undefined) this.echoDiv = div;

    if (on) {
      if (!wasOn) {
        // The lines are silent here, so jump the time rather than smearing from
        // whatever the last press left behind, and reopen the damping.
        this.retimeEcho();
        for (const f of [e.dampL.frequency, e.dampR.frequency]) {
          f.cancelScheduledValues(t);
          f.setValueAtTime(ECHO_DAMP_OPEN, t);
        }
      }
      this.echoOn = true;
      if (wasOn && divChanged) this.retimeEcho();

      e.send.gain.cancelScheduledValues(t);
      e.send.gain.setValueAtTime(e.send.gain.value, t);
      e.send.gain.linearRampToValueAtTime(0.42, t + 0.02);

      // Feedback rises under the hand: snappy at first, near self-oscillation by
      // a few seconds of hold. That climb is the gesture — a fixed value gives
      // you an effect, a rising one gives you a performance.
      e.fb.gain.cancelScheduledValues(t);
      e.fb.gain.setValueAtTime(e.fb.gain.value, t);
      e.fb.gain.linearRampToValueAtTime(0.58, t + 0.05);
      e.fb.gain.setTargetAtTime(ECHO_FB_MAX, t + 0.05, 1.1);

      // Each pass through the loop is another trip through these, so closing
      // them while held is what makes repeat n darker than repeat n-1.
      for (const f of [e.dampL.frequency, e.dampR.frequency]) {
        f.cancelScheduledValues(t);
        f.setValueAtTime(ECHO_DAMP_OPEN, t);
        f.setTargetAtTime(ECHO_DAMP_HELD, t + 0.05, 1.6);
      }
    } else {
      this.echoOn = false;
      // The feedback schedule below drains the lines over ~5 s. Until then the
      // delay still holds signal, so retimeEcho must glide rather than jump.
      this.echoTailUntil = t + 5.5;

      e.send.gain.cancelScheduledValues(t);
      e.send.gain.setValueAtTime(e.send.gain.value, t);
      e.send.gain.linearRampToValueAtTime(0, t + 0.06);

      // Freeze the input, not the loop. Feedback eases to a decaying 0.30 so the
      // repeats wash out over several more taps, then to zero — which also
      // guarantees the lines are drained before the next press.
      e.fb.gain.cancelScheduledValues(t);
      e.fb.gain.setValueAtTime(e.fb.gain.value, t);
      e.fb.gain.setTargetAtTime(0.3, t, 0.35);
      e.fb.gain.setTargetAtTime(0, t + 3.0, 0.6);
      // Damping is NOT reset: the tail keeps darkening as it dies.
    }
    this.engine.notify();
  }

  /** Change the repeat division. Live-safe while the echo is held. */
  setEchoDiv(div: EchoDiv): void {
    this.echoDiv = div;
    this.ensureEcho();
    this.retimeEcho();
    this.engine.notify();
  }

  /**
   * Recompute the delay times from the transport. Public because the tempo can
   * move under a held echo — call this when it does.
   *
   * While held the move is a 100 ms glide, which pitch-smears the repeats the
   * way a tape machine does. While silent it is instant, because a glide on an
   * empty line is a wasted 100 ms of wrong timing on the next press.
   */
  retimeEcho(): void {
    const e = this.echo;
    if (!e) return;
    const t = this.ctx.currentTime;
    const beat = 60 / clamp(fin(this.engine.transport.bpm, 120), 40, 220);
    const d = clamp(beat * ECHO_MULT[this.echoDiv], 0.03, 1.6);
    // "Not held" is not the same as "empty": the tail rings for seconds after
    // release, and an instant delayTime jump on a line that still holds signal
    // moves the read pointer discontinuously — an audible click and a pitch
    // lurch on the tail. Glide whenever anything could still be in there.
    const ringing = this.echoOn || t < this.echoTailUntil;
    for (const p of [e.dlyL.delayTime, e.dlyR.delayTime]) {
      p.cancelScheduledValues(t);
      if (ringing) p.setTargetAtTime(d, t, 0.1);
      else p.setValueAtTime(d, t);
    }
  }

  /**
   * Gate the master with a tempo-synced square LFO. The oscillator is summed
   * into the gate's gain param, whose base sits at 0.5, so the swing is 0..1.
   */
  setStutter(on: boolean): void {
    this.stutterOn = on;
    const t = this.ctx.currentTime;
    const gain = this.engine.fxGate.gain;

    if (on && !this.stutterOsc) {
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = ((this.engine.transport.bpm || 120) / 60) * 4; // 16ths
      const depth = this.ctx.createGain();
      depth.gain.value = 0.5;
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(0.5, t);
      osc.connect(depth).connect(gain);
      osc.start(t);
      this.stutterOsc = osc;
      this.stutterDepth = depth;
    } else if (!on && this.stutterOsc) {
      this.stutterOsc.stop(t);
      this.stutterOsc.disconnect();
      this.stutterDepth?.disconnect();
      this.stutterOsc = null;
      this.stutterDepth = null;
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(1, t);
    }
    this.engine.notify();
  }

  /* --------------------------------------------------------------- air horn */

  /**
   * The stadium air horn: bah-bah-bah BAHHHH.
   *
   * Three short stabs as a PICKUP and a held note that lands exactly on the
   * downbeat. The downbeat is what is locked, and the stabs are placed backwards
   * from it — a pickup reads as a pickup at any spacing, but a late arrival is
   * just wrong, so when the tempo would make eighths sloppy the stab gap is
   * clamped and the hit stays on the grid.
   *
   * The horn tunes itself to the anchor deck: stabs on the key's root, the held
   * note a fifth above. A fanfare in the wrong key is a mistake you can hear
   * from across the room.
   */
  horn(): void {
    const ctx = this.ctx;
    const tr = this.engine.transport;
    const dest = this.engine.oneShotBus;

    const bpm = clamp(fin(tr.bpm, 120), 60, 200);
    const beat = 60 / bpm;
    const gap = clamp(beat / 2, 0.16, 0.3);
    const down = tr.nextDownbeatTime(3 * gap + 0.1);
    // With the transport idle there is no grid to land on, so play it free
    // rather than delay the sound a child just asked for.
    const long =
      tr.running && down - 3 * gap >= ctx.currentTime + 0.02
        ? down
        : ctx.currentTime + 0.03 + 3 * gap;
    const t0 = long - 3 * gap;
    const hold = clamp(beat * 1.4, 0.55, 1.1);
    const endAt = long + hold + 0.45 + 0.6;

    const pc = this.engine.anchorDeck()?.analysis?.keyPc;
    // Sub octave × 8 puts the root in the 261-494 Hz range a real horn lives in.
    const rootHz = subRootHz(fin(pc ?? 5, 5)) * 8;

    /* Shared tone chain. Built per call and torn down after — a horn is rare
       enough that a permanent convolver would be idle CPU for nothing. */
    const hornBus = ctx.createGain();
    const pre = ctx.createGain();
    pre.gain.value = 1.9;
    // Full drive on a bus insert: the curve's k = 6 flattens the saw tops into
    // the brassy square-ish honk, and its peak-preserving normalisation means
    // all that extra harmonic content costs the limiter nothing.
    const sat = saturator(ctx, 1, '2x');
    const form = ctx.createBiquadFilter();
    form.type = 'peaking';
    form.frequency.value = 1900;
    form.Q.value = 1.1;
    form.gain.value = 6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 220;
    hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    lp.Q.value = 0.6;
    // MEASURED, not guessed: at 0.42 the fanfare alone peaked at 0.80 on the
    // post-limiter analyser with nothing else playing, which means it slams the
    // master limiter and ducks the whole mix out from under itself. 0.24 lands
    // it near 0.45 — loud enough to cut a full mix, quiet enough to sit in one.
    const trim = ctx.createGain();
    trim.gain.value = 0.24;
    const send = ctx.createGain();
    send.gain.value = 0.28;
    const conv = ctx.createConvolver();
    // Required by impulseResponse: the buffer is already unity-energy, and Web
    // Audio's own normalisation would make the wet level track the tail length.
    conv.normalize = false;
    conv.buffer = impulseResponse(ctx, {
      seconds: 0.55,
      decay: 3.4,
      damping: 0.25,
      preDelaySec: 0.008,
      seed: 0x0417,
    });

    hornBus.connect(pre).connect(sat).connect(form).connect(hp).connect(lp).connect(trim);
    trim.connect(dest);
    trim.connect(send).connect(conv).connect(dest);

    /* One vibrato for the whole fanfare, gated to bloom only on the held note.
       Stabs are too short to wobble; the long one sounds synthetic without it. */
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.6;
    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, t0);
    vibDepth.gain.setValueAtTime(0, long);
    vibDepth.gain.linearRampToValueAtTime(7, long + 0.35);
    vib.connect(vibDepth);
    vib.start(t0);
    vib.stop(long + hold + 0.5);

    const voice = (o: {
      at: number;
      hz: number;
      partials: readonly (readonly [number, number])[];
      /** Pitch scoop: start this far under and slide up. Brass never starts in tune. */
      scoop: number;
      scoopSec: number;
      /** End-of-note droop, as a ratio. 1 = none. */
      sag: number;
      sagAt: number;
      peak: number;
      attack: number;
      sustainUntil: number;
      releaseSec: number;
      stopAt: number;
    }): void => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(FLOOR, o.at);
      g.gain.linearRampToValueAtTime(o.peak, o.at + o.attack);
      g.gain.setValueAtTime(o.peak, o.sustainUntil);
      g.gain.exponentialRampToValueAtTime(FLOOR, o.sustainUntil + o.releaseSec);
      g.connect(hornBus);

      for (const [mult, level] of o.partials) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const target = o.hz * mult;
        osc.frequency.setValueAtTime(target * o.scoop, o.at);
        osc.frequency.exponentialRampToValueAtTime(target, o.at + o.scoopSec);
        if (o.sag !== 1) {
          // Anchor pitch at target first. Without this event the sag ramp starts
          // from the END of the scoop, so the whole held note bends slowly flat
          // instead of sitting on pitch and drooping into the release — the
          // difference between a fanfare and something out of tune.
          osc.frequency.setValueAtTime(target, o.sustainUntil);
          osc.frequency.exponentialRampToValueAtTime(target * o.sag, o.sagAt);
        }
        vibDepth.connect(osc.frequency);

        const og = ctx.createGain();
        og.gain.value = level;
        osc.connect(og).connect(g);
        osc.start(o.at);
        osc.stop(o.stopAt);
      }
    };

    // Stabs crescendo into the hit, so the pickup pushes rather than repeats.
    const stabPeaks = [0.34, 0.36, 0.38];
    for (let i = 0; i < 3; i++) {
      const at = t0 + i * gap;
      voice({
        at,
        hz: rootHz,
        partials: HORN_STAB_PARTIALS,
        scoop: 0.94387, // a semitone under
        scoopSec: 0.035,
        sag: 1,
        sagAt: 0,
        peak: stabPeaks[i],
        attack: 0.012,
        sustainUntil: at + 0.1,
        releaseSec: 0.07,
        stopAt: at + 0.2,
      });
    }

    voice({
      at: long,
      hz: rootHz * FIFTH,
      partials: HORN_LONG_PARTIALS,
      scoop: 0.8909, // a whole tone under: the big note gets the bigger scoop
      scoopSec: 0.085,
      sag: 0.965,
      sagAt: long + hold + 0.45,
      peak: 0.5,
      attack: 0.018,
      sustainUntil: long + hold,
      releaseSec: 0.45,
      stopAt: long + hold + 0.5,
    });

    // The only two nodes touching the shared bus; everything upstream becomes
    // unreachable once its sources have stopped and is collected on its own.
    window.setTimeout(
      () => {
        trim.disconnect();
        conv.disconnect();
      },
      Math.max(0, (endAt - ctx.currentTime + 0.3) * 1000)
    );
  }

  /** Riser over `bars` bars — the tension before a drop. */
  build(bars = 4): void {
    const t = this.ctx.currentTime + 0.02;
    const dur = (this.engine.transport.barDuration || 2) * bars;

    const src = this.ctx.createBufferSource();
    src.buffer = noiseBuffer(this.ctx);
    src.loop = true;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(9000, t + dur);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + dur);
    g.gain.linearRampToValueAtTime(FLOOR, t + dur + 0.12);

    src.connect(bp).connect(g).connect(this.engine.oneShotBus);
    src.start(t);
    src.stop(t + dur + 0.2);
  }

  /**
   * Cut everything just before the next downbeat, then slam back in on it with
   * an impact. Silence before the drop is what makes the drop land.
   */
  drop(): void {
    const tr = this.engine.transport;
    const down = tr.nextDownbeatTime(0.2);
    const beat = 60 / (tr.bpm || 120);
    const cutAt = Math.max(this.ctx.currentTime + 0.02, down - beat * 0.5);

    const gate = this.engine.fxGate.gain;
    gate.cancelScheduledValues(cutAt);
    gate.setValueAtTime(1, cutAt);
    gate.linearRampToValueAtTime(0, cutAt + 0.012);
    gate.setValueAtTime(0, down - 0.006);
    gate.linearRampToValueAtTime(1, down + 0.006);

    this.impact(down);
    this.engine.notify();
  }

  /** Sub thump plus a noise crash, for the moment of the slam. */
  private impact(t: number): void {
    const dest = this.engine.oneShotBus;

    const o = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
    og.gain.setValueAtTime(0.7, t);
    og.gain.exponentialRampToValueAtTime(FLOOR, t + 0.7);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + 0.75);

    const n = this.ctx.createBufferSource();
    n.buffer = noiseBuffer(this.ctx);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.32, t);
    ng.gain.exponentialRampToValueAtTime(FLOOR, t + 1.1);
    n.connect(hp).connect(ng).connect(dest);
    n.start(t, Math.random());
    n.stop(t + 1.15);
  }

  /* ------------------------------------------------- scratch sweetening */

  /**
   * Where the vinyl noise joins the mix: the SUM bus, not the one-shot bus.
   *
   * Surface noise comes off the record, so it has to be filtered by the swoosh
   * and chopped by the stutter along with everything else — a crackle bed that
   * survived a drop's silence would announce itself as fake.
   */
  private ensureScratchBus(): GainNode {
    if (this.scratchBus) return this.scratchBus;
    const bus = this.ctx.createGain();
    bus.gain.value = 1;
    this.engine.addSource(bus, null);
    this.scratchBus = bus;
    return bus;
  }

  /**
   * Put the needle down. One voice per gesture, built on the grab and torn down
   * on the release, so there is no permanent hiss bed and nothing running
   * between gestures.
   *
   * Idempotent: an unpaired start ends the previous voice first, so a missed
   * `scratchNoiseEnd` can strand a bed for one gesture at worst.
   */
  scratchNoiseStart(deckId: string): void {
    this.scratchNoiseEnd(deckId);
    const ctx = this.ctx;
    const bus = this.ensureScratchBus();

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.9;
    // The lift that makes a scratch cut through a full mix. It opens with speed,
    // so it is inaudible at rest and present exactly when the hand is working.
    const res = ctx.createBiquadFilter();
    res.type = 'peaking';
    res.frequency.value = 2600;
    res.Q.value = 2.2;
    res.gain.value = 0;
    const vg = ctx.createGain();
    vg.gain.value = 0;

    src.connect(bp).connect(res).connect(vg).connect(bus);
    // Random offset into the loop: two decks grabbed together must not play the
    // same noise, or the bed collapses to the middle and reads as one source.
    src.start(ctx.currentTime, Math.random() * 1.5);

    // lastV = -1 guarantees the first move writes, whatever the velocity is.
    this.scratchVoices.set(deckId, { src, bp, res, vg, lastV: -1, lastSigned: 0, lastChirpMs: 0 });
  }

  /**
   * Track the platter. Runs at pointer rate — up to ~60/s per deck — so it is
   * three param writes on a changed velocity and nothing at all otherwise, and
   * it NEVER calls notify(): a React render per pointer frame is exactly the
   * work the canvas rAF loops exist to avoid (see Deck.scratchMove).
   */
  scratchNoise(deckId: string, velocity: number): void {
    const v0 = this.scratchVoices.get(deckId);
    if (!v0) return;
    const vs = clamp(fin(velocity, 0), -8, 8);
    const v = Math.abs(vs);
    const t = this.ctx.currentTime;

    // Most pointer samples are near-duplicates of the last one.
    if (Math.abs(v - v0.lastV) >= 0.06) {
      // Silent below a crawl: a hand resting on a stopped platter makes no noise.
      const level = v < 0.08 ? 0 : 0.115 * Math.pow(Math.min(1, v / 2.6), 0.8);
      // Self-decaying, because the emit that would silence it may never arrive.
      // Turntable only fires onScratchMove when the platter has actually MOVED,
      // so a hand that grabs, flings, then holds still sends no further update
      // and a level-only write would leave the crackle bed running forever.
      // Each arriving move pushes the decay out; a stopped hand fades in ~150ms,
      // which is also what a real platter does.
      v0.vg.gain.cancelScheduledValues(t);
      v0.vg.gain.setTargetAtTime(level, t, 0.035);
      v0.vg.gain.setTargetAtTime(0, t + 0.09, 0.05);
      v0.src.playbackRate.setTargetAtTime(clamp(0.35 + 0.55 * v, 0.35, 3.0), t, 0.035);
      v0.bp.frequency.setTargetAtTime(clamp(900 + 950 * v, 900, 6500), t, 0.035);
      v0.res.gain.setTargetAtTime(clamp(v * 2.2, 0, 7), t, 0.035);
      v0.lastV = v;
    }

    // The needle chirp on a genuine reversal — the transient a stylus makes when
    // it stops and goes the other way. Both sides of the flip have to be moving,
    // or a hand wobbling across zero fires it dozens of times a second.
    const now = performance.now();
    if (
      Math.sign(vs) !== Math.sign(v0.lastSigned) &&
      Math.abs(v0.lastSigned) >= CHIRP_MIN_V &&
      v >= CHIRP_MIN_V &&
      now - v0.lastChirpMs >= CHIRP_LOCKOUT_MS
    ) {
      const ctx = this.ctx;
      const peak = 0.1 * Math.min(1, (v + Math.abs(v0.lastSigned)) / 7);
      const cn = ctx.createBufferSource();
      cn.buffer = noiseBuffer(ctx);
      const cbp = ctx.createBiquadFilter();
      cbp.type = 'bandpass';
      cbp.frequency.value = 4200;
      cbp.Q.value = 3.4;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(FLOOR, t);
      cg.gain.linearRampToValueAtTime(peak, t + 0.0015);
      cg.gain.exponentialRampToValueAtTime(FLOOR, t + 0.018);
      cn.connect(cbp).connect(cg).connect(this.ensureScratchBus());
      cn.start(t, Math.random() * 1.5);
      cn.stop(t + 0.035);
      cn.onended = () => {
        cn.disconnect();
        cbp.disconnect();
        cg.disconnect();
      };
      v0.lastChirpMs = now;
    }
    v0.lastSigned = vs;
  }

  /** Lift the needle. The bed coasts down rather than cutting with the hand. */
  scratchNoiseEnd(deckId: string): void {
    const voice = this.scratchVoices.get(deckId);
    if (!voice) return;
    // Deleted immediately, so a re-grab inside the fade builds a fresh voice
    // instead of writing to one that is already stopping.
    this.scratchVoices.delete(deckId);

    const t = this.ctx.currentTime;
    voice.vg.gain.cancelScheduledValues(t);
    voice.vg.gain.setTargetAtTime(0, t, 0.055);
    voice.src.stop(t + 0.3);
    voice.src.onended = () => {
      voice.src.disconnect();
      voice.bp.disconnect();
      voice.res.disconnect();
      voice.vg.disconnect();
    };
  }

  /** Release every held effect — used when leaving a mode or stopping. */
  releaseAll(): void {
    if (this.filterOn) this.setFilter(false);
    if (this.echoOn) this.setEcho(false);
    if (this.stutterOn) this.setStutter(false);
    for (const id of [...this.scratchVoices.keys()]) this.scratchNoiseEnd(id);
  }
}
