import type { AudioEngine } from './AudioEngine';
import { noiseBuffer } from './drums';

const FLOOR = 0.0001;

/**
 * Performance FX and the build/drop macros.
 *
 * Hold FX (filter, echo, stutter) act on the master FX stage between the sum bus
 * and the master gain, so they hit the decks and the beat machine alike.
 * One-shots (horn, riser, drop impact) are routed POST-gate, so a drop's impact
 * and an air horn still land while the gate is cutting everything else.
 */
export class Fx {
  private engine: AudioEngine;
  private stutterOsc: OscillatorNode | null = null;
  private stutterDepth: GainNode | null = null;

  filterOn = false;
  echoOn = false;
  stutterOn = false;

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

  /** Tempo-synced dotted-eighth delay send. */
  setEcho(on: boolean): void {
    this.echoOn = on;
    const t = this.ctx.currentTime;
    const bpm = this.engine.transport.bpm || 120;
    this.engine.delay.delayTime.setTargetAtTime((60 / bpm) * 0.75, t, 0.05);
    this.engine.delaySend.gain.setTargetAtTime(on ? 0.45 : 0, t, 0.05);
    this.engine.notify();
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

  /** Air horn. */
  horn(): void {
    const t = this.ctx.currentTime + 0.01;
    const dest = this.engine.oneShotBus;

    const body = this.ctx.createGain();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    body.connect(lp).connect(dest);

    body.gain.setValueAtTime(FLOOR, t);
    body.gain.linearRampToValueAtTime(0.42, t + 0.03);
    body.gain.setValueAtTime(0.42, t + 0.85);
    body.gain.exponentialRampToValueAtTime(FLOOR, t + 1.15);

    const vib = this.ctx.createOscillator();
    vib.frequency.value = 6;
    const vibDepth = this.ctx.createGain();
    vibDepth.gain.value = 7;
    vib.connect(vibDepth);

    for (const [mult, level] of [
      [1, 0.5],
      [1.006, 0.5],
      [1.5, 0.28],
      [2, 0.16],
    ] as const) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      const og = this.ctx.createGain();
      og.gain.value = level;
      o.frequency.setValueAtTime(300 * mult, t);
      o.frequency.linearRampToValueAtTime(440 * mult, t + 0.06);
      vibDepth.connect(o.frequency);
      o.connect(og).connect(body);
      o.start(t);
      o.stop(t + 1.2);
    }
    vib.start(t);
    vib.stop(t + 1.2);
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

  /** Release every held effect — used when leaving a mode or stopping. */
  releaseAll(): void {
    if (this.filterOn) this.setFilter(false);
    if (this.echoOn) this.setEcho(false);
    if (this.stutterOn) this.setStutter(false);
  }
}
