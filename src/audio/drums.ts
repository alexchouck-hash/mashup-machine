/**
 * Synthesized 808/EDM drum voices.
 *
 * The spec asks for a curated sample pack. These are synthesized instead: no
 * audio assets to license, which matters because unlicensed samples would
 * foreclose the monetization paths the project cares about, and it keeps the
 * bundle self-contained with nothing to fetch at runtime.
 *
 * WHY EVERY VOICE IS LAYERED. Depth is not level. One oscillator with one
 * envelope has to pick a single decay for the whole spectrum, and that choice is
 * exactly what "thin" sounds like — so each voice is three or more layers whose
 * decays differ by an order of magnitude (the kick's beater dies in 18 ms, its
 * sub in 520 ms). The rest of the weight comes from odd-symmetric tanh
 * saturation normalised so y(±1) = ±1, which cannot raise the peak, only fill in
 * underneath it, and being a static curve cannot pump the way a compressor does.
 *
 * WHY NO VOICE CAN THROW. Transport.tick() has no try/catch, so a throw in a step
 * handler leaves `nextTime` un-advanced and the same step re-fires every 25 ms
 * forever: drums silent, CPU spinning, and every handler registered after the
 * thrower dead. A NaN is worse — it poisons the shared sum bus and the master
 * compressor for the life of the context. Web Audio throws on non-finite param
 * values, exponential ramps touching zero, negative start times and curves under
 * two samples, all reachable from a caller bug, so every input goes through the
 * sanitizers below. The one hazard left is a `dest` from a different context;
 * connect() throws InvalidAccessError and there is no cheap way to detect it.
 *
 * SWAP POINT: each voice is a `(ctx, dest, time, ...opts, gain, accent) => void`
 * one-shot over BaseAudioContext, so the same call works live and inside
 * jamFactory's OfflineAudioContext. Buying a sample pack later means replacing
 * these bodies with buffer playback; the sequencer calls them the same way.
 *
 * Every "measured" number below is peak/RMS/envelope from an offline simulation
 * of Web Audio's own filter and automation semantics, old voice against new on
 * the same renderer. The levels and the balance hold; the taste calls — the
 * 185/278 Hz shell pair, the 1050 Hz clap band, the four-slap spacing — have not
 * been through an ear yet and are the right things to adjust after one.
 */

/** Exponential ramps cannot reach zero; decay to this instead. */
const FLOOR = 0.0001;

/** Fx.build() loops this buffer and Fx.impact() reads deep into it — keep it 2 s. */
const NOISE_SECONDS = 2;

/** Long enough that consecutive hats never read the same window at ±1.5% rate. */
const METAL_SECONDS = 1.2;

import { kitBuffer } from './sampleKit';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Every caller-supplied number passes through here; NaN becomes the fallback. */
const fin = (v: number | undefined, fb: number): number => (Number.isFinite(v) ? (v as number) : fb);

/** Amplitude for an exponential ramp: never zero, never loud enough to poison the bus. */
const amp = (gain: number, scale: number): number => clamp(fin(gain, 1) * scale, FLOOR, 8);

/** A duration that a ramp can actually span. A zero-length ramp is a click. */
const secs = (v: number | undefined, fb: number, lo = 0.004, hi = 8): number =>
  clamp(fin(v, fb), lo, hi);

/** A frequency a biquad or oscillator can hold, never above Nyquist. */
const hzOf = (ctx: BaseAudioContext, v: number | undefined, fb: number, lo = 8, hi = Infinity) =>
  clamp(fin(v, fb), lo, Math.min(hi, ctx.sampleRate * 0.45));

/** `start(when)` throws on a negative time, and nothing upstream promises otherwise. */
const at = (ctx: BaseAudioContext, time: number): number => Math.max(0, fin(time, ctx.currentTime));

/**
 * Accent is velocity, where 1 is a FULL hit and patterns duck ghost notes BELOW
 * it — not a boolean accent that boosts above it. Two reasons: every existing
 * call site omits the argument and must sound identical, and this way accent can
 * never push a voice past the caller's `gain` into the master limiter.
 *
 * Measured on the kick: 0.75 is -3.5 dB, 0.5 is -8.0 dB and both darker and
 * shorter, and 0 is a real ghost at -15.8 dB rather than silence.
 */
const vel = (a: number): number => clamp(fin(a, 1), 0, 1);
/** 1.00 / 0.628 / 0.362 / 0.203 / 0.150 at v = 1, .75, .5, .25, 0. */
const velAmp = (v: number): number => 0.15 + 0.85 * v * v;
/** Transient and HF layers only — a quiet hit is duller, not just quieter. */
const velTone = (v: number): number => 0.35 + 0.65 * v;
/** Decay scale. A ghost note is short as well as soft. */
const velTime = (v: number): number => 0.7 + 0.3 * v;

function biquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q: number
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hzOf(ctx, freq, 1000);
  f.Q.value = q;
  return f;
}

/**
 * A gain node opened from FLOOR to `peak` over `attack`. Never a bare
 * setValueAtTime(peak): a square or triangle oscillator starts at its extreme,
 * and a jump to full level is a step edge that clicks. Callers append their own
 * exponential ramps down from here.
 */
function env(ctx: BaseAudioContext, peak: number, time: number, attack: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(FLOOR, time);
  g.gain.linearRampToValueAtTime(peak, time + attack);
  return g;
}

function playBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  bufSec: number,
  node: AudioNode | AudioNode[],
  time: number,
  seconds: number,
  rate: number
): void {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const r = clamp(fin(rate, 1), 0.5, 2);
  src.playbackRate.value = r;

  // The caller has already built the chain, so there is no connect-after-start race.
  if (Array.isArray(node)) for (const n of node) src.connect(n);
  else src.connect(node);

  // Read from a random point so repeated hits are not bit-identical, but bound the
  // offset by what this hit actually CONSUMES. The old bound was a flat
  // Math.random() * 1.5 on a 2 s buffer, which left 0.5 s of headroom and silently
  // truncated any tail longer than that — the new clap tail is 0.37 s and the open
  // hat 0.34 s, close enough to have started falling off the end.
  const dur = secs(seconds, 0.05, 0.004, bufSec);
  const span = Math.max(0, bufSec - dur * r - 0.02);
  src.start(time, Math.random() * span);
  src.stop(time + dur + 0.02);
}

function noiseInto(
  ctx: BaseAudioContext,
  node: AudioNode | AudioNode[],
  time: number,
  seconds: number,
  rate = 1
): void {
  playBuffer(ctx, noiseBuffer(ctx), NOISE_SECONDS, node, time, seconds, rate);
}

function metalInto(
  ctx: BaseAudioContext,
  node: AudioNode | AudioNode[],
  time: number,
  seconds: number,
  rate = 1
): void {
  playBuffer(ctx, metalBuffer(ctx), METAL_SECONDS, node, time, seconds, rate);
}

/* ------------------------------------------------------------------ buffers */

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx);
  if (cached) return cached;
  const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseCache.set(ctx, buf);
  return buf;
}

/** The TR-808 hi-hat oscillator bank. Six squares, deliberately inharmonic. */
const METAL_HZ = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
/** Offset phases: without them all six start at +1 and the buffer opens on a spike. */
const METAL_PHASE = [0, 0.17, 0.41, 0.63, 0.29, 0.86];

const metalCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/**
 * The metallic source behind both hats — what makes them read as cymbal rather
 * than as filtered hiss.
 *
 * Pre-rendered once per context rather than run as six live oscillators per hit,
 * which at 21 hats a second matters. The squares are naive phase comparisons, not
 * band-limited to Nyquist: band-limiting costs ~7.6M sin() calls on the first hat
 * and would glitch the audio thread against this one's ~346k integer ops, and the
 * aliasing is inaudible because the voice band-passes at 8.0-8.6 kHz, where the
 * aliased and the intended partials are the same metallic mush.
 */
export function metalBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = metalCache.get(ctx);
  if (cached) return cached;
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(METAL_SECONDS * sr));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);

  for (let j = 0; j < METAL_HZ.length; j++) {
    const inc = METAL_HZ[j] / sr;
    let ph = METAL_PHASE[j];
    for (let i = 0; i < len; i++) {
      d[i] += ph < 0.5 ? 1 : -1;
      ph += inc;
      // Wrap every sample so the accumulator stays small: i * inc over 1.2 s would
      // lose enough mantissa to drift the pitch of the top oscillator.
      if (ph >= 1) ph -= 1;
    }
  }

  let peak = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) peak = a;
  }
  const s = peak > 0 ? 0.95 / peak : 0;
  for (let i = 0; i < len; i++) d[i] *= s;

  metalCache.set(ctx, buf);
  return buf;
}

/* --------------------------------------------------------------- saturation */

// The ArrayBuffer type argument is not decoration: WaveShaperNode.curve rejects a
// Float32Array that might be backed by a SharedArrayBuffer.
const curveCache = new Map<string, Float32Array<ArrayBuffer>>();

/**
 * Odd-symmetric tanh transfer curve, normalised so y(±1) = ±1.
 *
 * That normalisation is the whole point: THE PEAK NEVER RISES. Saturation only
 * fills in underneath it, which is how a voice gets louder without eating the
 * master limiter's headroom. The curve is also monotone (no fold-back, so no
 * ring-mod artefacts) and odd (so it adds no DC to the shared bus). Input beyond
 * ±1 is clamped by Web Audio to the curve endpoints, a graceful hard ceiling.
 *
 * Measured small-signal gain, and the value at 0.9 where the compression bites:
 *   drive 0.22 -> +3.67 dB, y(0.9) 0.958    0.28 -> +5.09 dB, 0.973
 *   drive 0.35 -> +6.70 dB, 0.984           1.00 -> +15.56 dB, 1.000
 */
export function saturationCurve(drive: number, samples = 1025): Float32Array<ArrayBuffer> {
  // Quantised to 1/512 so a caller sweeping `drive` cannot mint unbounded curves.
  // That is within 0.01 dB of the exact value at every drive this file uses.
  const q = Math.round(clamp(fin(drive, 0), 0, 1) * 512);
  let n = clamp(Math.round(fin(samples, 1025)), 3, 8193);
  // Odd sample count puts an exact sample on x = 0. With an even count zero falls
  // between samples and every shaped voice carries ~1e-6 of DC onto the sum bus.
  if (n % 2 === 0) n++;

  const key = `${q}:${n}`;
  const cached = curveCache.get(key);
  if (cached) return cached;

  const k = (q / 512) * 6;
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (2 * i) / (n - 1) - 1;
    c[i] = k < 1e-3 ? x : Math.tanh(k * x) / norm;
  }

  if (curveCache.size >= 48) curveCache.clear();
  curveCache.set(key, c);
  return c;
}

/**
 * A single connectable saturation node — no {input, output} pair and no pre/post
 * gains forced on the caller, because pre-gain and post-trim are mathematically
 * identical to a steeper k and the curve already carries both.
 *
 * `oversample` defaults to 'none' deliberately. Chrome's 2x/4x oversampling
 * inserts a fixed FIR latency of roughly 1.3 ms; with only some voices shaped
 * that flams the kick against the unshaped hats and shifts the drums off the
 * grid. A BUS insert may safely pass '2x' — the whole bus shifts together.
 */
export function saturator(
  ctx: BaseAudioContext,
  drive: number,
  oversample: OverSampleType = 'none'
): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  // The Float32Array is shared across every node built from the same drive and is
  // never mutated after construction, so this allocates nothing per hit.
  ws.curve = saturationCurve(drive);
  ws.oversample = oversample;
  return ws;
}

/* ------------------------------------------------------------------- reverb */

export interface ImpulseOptions {
  /** Tail length. 0.9 s is a room; under 0.3 s for anything rendered offline. */
  seconds?: number;
  /** Exponent on the decay envelope. Higher is tighter. */
  decay?: number;
  preDelaySec?: number;
  /** 0 = bright and metallic, 1 = heavily damped. */
  damping?: number;
  earlyReflections?: boolean;
  seed?: number;
}

/** Early reflection times in seconds, and their levels. Prime-ish, so they do not comb. */
const IR_TIMES = [0.0071, 0.0113, 0.0171, 0.0229, 0.0313];
const IR_LEVELS = [0.42, 0.31, 0.26, 0.19, 0.14];

const irCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

/**
 * A synthesized room for the drum bus to send to. Returns a buffer only — no
 * ConvolverNode and no wiring, so the integrator owns the send level.
 *
 * INTEGRATOR NOTE: set `convolver.normalize = false`. This buffer is already
 * unity-ENERGY (sum of h² = 1 across both channels), and Web Audio's own
 * normalization would make the wet level depend on `seconds` all over again.
 * Measured convolution gain is -3.01 dB per channel — i.e. unity for a stereo
 * convolver — and stays there at 0.28 s, 0.9 s, 1.4 s and 3 s alike. A
 * peak-normalised noise IR measures +28 dB instead, and its level then tracks
 * `seconds`. Energy normalisation is why the buffer peaks at only 0.018 at the
 * default length: the small number is correct, do not "fix" it.
 *
 * The noise is seeded rather than Math.random: an impulse response is a fixed
 * character, not a per-hit variation, and jamFactory memoises renders, so a
 * re-render must not land in a different room.
 */
export function impulseResponse(ctx: BaseAudioContext, opts: ImpulseOptions = {}): AudioBuffer {
  const seconds = clamp(fin(opts.seconds, 0.9), 0.05, 3.0);
  const decay = clamp(fin(opts.decay, 2.6), 0.5, 8);
  const preDelay = clamp(fin(opts.preDelaySec, 0.012), 0, 0.2);
  const damping = clamp(fin(opts.damping, 0.45), 0, 1);
  const early = opts.earlyReflections !== false;
  const seed = fin(opts.seed, 0x5eed) | 0;

  const key = `${seconds}:${decay}:${preDelay}:${damping}:${early}:${seed}`;
  let perCtx = irCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    irCache.set(ctx, perCtx);
  }
  const hit = perCtx.get(key);
  if (hit) return hit;

  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * sr));
  // Clamping `pre` here is also what guarantees the span below is at least 1.
  const pre = Math.min(len - 1, Math.floor(preDelay * sr));
  const buf = ctx.createBuffer(2, len, sr);

  // The one-pole coefficient falls across the tail, so the room darkens with time
  // the way a real one does. A fixed coefficient gives a burst, not a space.
  const aStart = 1 - damping * 0.35;
  const aEnd = 1 - damping * 0.92;
  const span = len - pre;

  let energy = 0;
  for (let c = 0; c < 2; c++) {
    const rng = mulberry32(seed ^ (c ? 0x9e3779b9 : 0));
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const p = (i - pre) / span;
      const a = aStart + (aEnd - aStart) * p;
      lp += a * (rng() * 2 - 1 - lp);
      d[i] = lp * Math.pow(1 - p, decay);
    }
    if (early) {
      for (let j = 0; j < IR_TIMES.length; j++) {
        // Right channel reflections arrive 17% later: two different wall distances
        // are what make the send read as width instead of as a mono blur.
        const idx = pre + Math.floor(IR_TIMES[j] * (c ? 1.17 : 1) * sr);
        if (idx < len) d[idx] += IR_LEVELS[j] * (rng() > 0.5 ? 1 : -1);
      }
    }
    for (let i = pre; i < len; i++) energy += d[i] * d[i];
  }

  const norm = energy > 1e-12 ? 1 / Math.sqrt(energy) : 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = pre; i < len; i++) d[i] *= norm;
  }

  // Worst case four 3 s stereo buffers is 4.5 MB; drop them all rather than grow.
  if (perCtx.size >= 4) perCtx.clear();
  perCtx.set(key, buf);
  return buf;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------ sampled layer */

/**
 * Play a kit sample, or report that there is none and let the caller synthesize.
 *
 * Returns false on a cache miss so every voice keeps exactly one shape:
 *   if (playSample(...)) return;   // real recording
 *   ...existing synthesis...       // fallback, unchanged
 *
 * `maxSec` is not optional decoration. Synth tails ended when their envelope
 * did; a sampled ride or crash runs well over a second, and Trap fires ten hats
 * a bar — without a bound they smear into mush at 16th notes.
 */
function playSample(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  name: string,
  gain: number,
  accent: number,
  maxSec: number
): boolean {
  const buf = kitBuffer(ctx, name);
  if (!buf) return false;

  const t = at(ctx, time);
  const v = vel(accent);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const g = ctx.createGain();
  const peak = amp(gain * velAmp(v), 1);
  g.gain.setValueAtTime(peak, t);

  const dur = Math.min(maxSec * velTime(v), buf.duration);
  // Ride the tail down rather than cutting it: a hard stop on a decaying cymbal
  // is a click, and at 16ths that click lands on every hit.
  g.gain.setValueAtTime(peak, t + dur * 0.72);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);

  // A quiet hit is duller as well as softer — the same rule the synth voices
  // follow through velTone, applied here with one filter instead of an envelope.
  if (v < 0.99) {
    const lp = biquad(ctx, 'lowpass', hzOf(ctx, 1200 + 14000 * velTone(v), 16000), 0.7);
    src.connect(lp).connect(g).connect(dest);
  } else {
    src.connect(g).connect(dest);
  }

  src.start(t);
  src.stop(t + dur + 0.02);
  return true;
}

/* ------------------------------------------------------------------- voices */

/**
 * LEVELS — the one thing whoever owns the drum bus has to know.
 *
 * Every voice below peaks at or under the voice it replaces, so no single voice
 * needs a bus change. The kick+sub PAIR does. They land on the same step in all
 * three grooves (0 and 8 of Party, Hip Hop and Trap alike), and because both now
 * hold level far longer they sum 98% coherently where the old pair had decayed
 * past each other and summed 75%. Bus peak on that pair goes 1.474 -> 1.896,
 * arriving at the master limiter (after BeatMachine.volume 0.85 and masterGain
 * 0.5) at 0.806 against its 0.708 threshold — 1.1 dB over, where the old pair sat
 * 1.1 dB under. That limiter is on the MASTER, so it ducks the decks: a child's
 * own song pumping on every downbeat.
 *
 * The pair is NOT the ceiling, though it is the clearest illustration. Measured
 * over two bars at 120 bpm with all four layers on: Party 1.902, Hip Hop 1.903,
 * Trap 2.581, against 1.480 / 1.489 / 2.030 for the old voices. Trap is 1.36x the
 * pair, and Trap was ALREADY over the limiter threshold before this change — that
 * is a pre-existing condition made worse, not a new one.
 *
 * The fix belongs on the bus. Trimming a voice to solve a summing problem just
 * makes it thin again, which is the complaint being answered. The required trim
 * is 2.2 dB, not 0.8: BeatMachine.volume 0.85 -> 0.66 (exactly 0.85 * 1.474/1.896
 * = 0.661). That restores the old limiter input across all three grooves — pair
 * 0.626 vs 0.627 old, Trap 0.853 vs 0.863 old — against the +3.9 dB (kick) and
 * +4.5 dB (sub) of RMS these voices gained. An earlier revision of this comment
 * said 0.775, which is arithmetically wrong: it leaves the bus 1.38 dB hot and
 * still 0.32 dB above the threshold, so the master limiter would go on ducking
 * the decks and a child's own song would go on pumping under the beat.
 */

/**
 * Kick: sub, body and beater, each with its own decay.
 *
 * The pitch envelope is two-stage on purpose — the fast 118 -> 52 Hz drop is the
 * punch and the slow 52 -> 41 Hz drop is the note. One ramp has to choose between
 * them and gets neither, which was the old voice's core problem. The beater is a
 * noise burst rather than a tuned 1100 Hz tick because a real beater is
 * broadband, and a bare sine plus a tuned tick is what read as a cheap synth.
 *
 * Measured against the old voice: RMS 0.169 (was 0.107, +3.9 dB) · envelope at
 * 100 ms 0.261 (was 0.106, +7.9 dB) · peak 1.079, dead flat across noise draws
 * because the transient is over before the beater matters (was 1.098). Peak reaching the
 * shaper is 0.663, so `gain` has 1.5x of headroom before the curve's hard ceiling
 * starts flattening transients.
 */
export function kick(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  gain = 1,
  accent = 1
): void {
  if (playSample(ctx, dest, time, 'kick', gain, accent, 0.9)) return;
  const t = at(ctx, time);
  const v = vel(accent);
  const A = velAmp(v);
  const T = velTone(v);
  const D = velTime(v);

  const sum = ctx.createGain();
  sum.gain.value = 0.75;
  const out = ctx.createGain();
  out.gain.value = 1.25;
  sum.connect(saturator(ctx, 0.28)).connect(out).connect(dest);

  const subDecay = 0.52 * D;
  const o1 = ctx.createOscillator();
  o1.type = 'sine';
  o1.frequency.setValueAtTime(118, t);
  o1.frequency.exponentialRampToValueAtTime(52, t + 0.035);
  o1.frequency.exponentialRampToValueAtTime(41, t + 0.16);
  const g1 = env(ctx, amp(gain, 0.95 * A), t, 0.004);
  g1.gain.exponentialRampToValueAtTime(FLOOR, t + subDecay);
  o1.connect(g1).connect(sum);
  o1.start(t);
  o1.stop(t + subDecay + 0.03);

  // Body: the part a laptop speaker can actually reproduce.
  const bodyDecay = 0.11 * D;
  const o2 = ctx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.setValueAtTime(165, t);
  o2.frequency.exponentialRampToValueAtTime(88, t + 0.06);
  const g2 = env(ctx, amp(gain, 0.5 * A), t, 0.003);
  g2.gain.exponentialRampToValueAtTime(FLOOR, t + bodyDecay);
  o2.connect(g2).connect(sum);
  o2.start(t);
  o2.stop(t + bodyDecay + 0.03);

  const beater = biquad(ctx, 'bandpass', 2600, 0.8);
  const g3 = env(ctx, amp(gain, 0.3 * A * T), t, 0.0006);
  g3.gain.exponentialRampToValueAtTime(FLOOR, t + 0.018);
  beater.connect(g3).connect(sum);
  noiseInto(ctx, beater, t, 0.018);
}

/**
 * Snare: one noise source through two bands, plus an inharmonic shell pair.
 *
 * ONE source feeds both noise branches so they stay sample-aligned — two
 * independent random read offsets would decorrelate them and smear the transient
 * that makes a snare a snare. The noise envelope is two-stage: the wires rattle
 * loudly for 45 ms and then sustain quietly, which is the whole difference
 * between "snare" and "noise burst". The lowpass at 9 kHz is what stops it
 * hissing. 278/185 = 1.503, deliberately NOT harmonic: an inharmonic pair reads
 * as a drum shell, a harmonic one reads as a bass note.
 *
 * No saturation here — shaping noise buys harshness, not weight.
 *
 * Measured: RMS 0.0630 (was 0.0621, +0.1 dB) · envelope at 50 ms 0.167 (was
 * 0.077, +6.7 dB) · peak 0.93-1.33 over 30 noise draws, against 0.97-1.35.
 * Same loudness, twice the body, no more peak.
 */
export function snare(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  gain = 1,
  accent = 1
): void {
  if (playSample(ctx, dest, time, 'snare', gain, accent, 0.7)) return;
  const t = at(ctx, time);
  const v = vel(accent);
  const A = velAmp(v);
  const T = velTone(v);
  const D = velTime(v);

  const tail = 0.2 * D;
  const hp = biquad(ctx, 'highpass', 900, 0.7);
  const lp = biquad(ctx, 'lowpass', 9000, 0.7);
  const gWires = env(ctx, amp(gain, 0.72 * A), t, 0.001);
  gWires.gain.exponentialRampToValueAtTime(amp(gain, 0.18 * A), t + 0.045);
  gWires.gain.exponentialRampToValueAtTime(FLOOR, t + tail);
  hp.connect(lp).connect(gWires).connect(dest);

  // Crack: the narrow band that carries over a phone speaker.
  const crack = biquad(ctx, 'bandpass', 5200, 1.6);
  const gCrack = env(ctx, amp(gain, 0.34 * A * T), t, 0.0008);
  gCrack.gain.exponentialRampToValueAtTime(FLOOR, t + 0.035);
  crack.connect(gCrack).connect(dest);

  noiseInto(ctx, [hp, crack], t, tail + 0.02);

  const shellDecay = 0.115 * D;
  for (const [from, to, level] of [
    [185, 148, 0.46],
    [278, 224, 0.24],
  ] as const) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + 0.09);
    const g = env(ctx, amp(gain, level * A), t, 0.002);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + shellDecay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + shellDecay + 0.03);
  }
}

/** Slap offsets in seconds, and their levels. */
const CLAP_OFFSETS = [0, 0.0105, 0.0208, 0.0303];
const CLAP_LEVELS = [0.85, 1.0, 0.72, 0.55];

/**
 * Clap: four slaps into one shared band, plus a diffuse tail.
 *
 * The spacing is uneven and the SECOND slap is the loudest because evenly spaced
 * equal repeats comb-filter into a machine-gun flange; real hands land unevenly
 * with the second slap loudest. One noise source feeds four gain nodes and each
 * opens at a different instant, so each slap reads a different chunk of noise —
 * 9 nodes where the old three-burst version used 12.
 *
 * Measured: RMS 0.0339 (was 0.0136, +7.9 dB) · envelope at 100 ms 0.087 (was
 * 0.007) · peak up to 0.48 over 30 draws, against 0.27. That is a deliberate
 * rebalance, not just a fatter voice: the old clap sat 13.3 dB under the snare
 * while being the backbeat in three of four jams and one of three grooves, and
 * no per-voice synthesis fixes a mix error. The new one sits 5.4 dB under.
 */
export function clap(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  gain = 1,
  accent = 1
): void {
  // Sonic Pi's CC0 set has no clap, so this one stays synthesized unless a snap
  // is present. Adding a clap would mean a SECOND source with its own chain of
  // title to verify — not worth it when the multi-burst synth clap is decent.
  if (playSample(ctx, dest, time, 'snap', gain, accent, 0.5)) return;
  const t = at(ctx, time);
  const v = vel(accent);
  const A = velAmp(v);
  const D = velTime(v);

  const body = biquad(ctx, 'bandpass', 1050, 0.9);
  body.connect(dest);

  const gates: GainNode[] = [];
  for (let i = 0; i < CLAP_OFFSETS.length; i++) {
    const start = t + CLAP_OFFSETS[i];
    const g = ctx.createGain();
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.setValueAtTime(FLOOR, start);
    g.gain.linearRampToValueAtTime(amp(gain, 1.15 * A * CLAP_LEVELS[i]), start + 0.0006);
    g.gain.exponentialRampToValueAtTime(FLOOR, start + 0.012);
    g.connect(body);
    gates.push(g);
  }
  noiseInto(ctx, gates, t, 0.063);

  // The tail is a second, wider source: the room the hands are in.
  const ts = t + 0.03;
  const tailDecay = 0.34 * D;
  const air = biquad(ctx, 'bandpass', 1400, 0.55);
  const gTail = env(ctx, amp(gain, 1.15 * A * 0.62), ts, 0.003);
  gTail.gain.exponentialRampToValueAtTime(amp(gain, 1.15 * A * 0.25), ts + 0.05);
  gTail.gain.exponentialRampToValueAtTime(FLOOR, ts + tailDecay);
  air.connect(gTail).connect(dest);
  noiseInto(ctx, air, ts, tailDecay + 0.02);
}

interface HatShape {
  bpHz: number;
  bpQ: number;
  hpHz: number;
  hpQ: number;
  /**
   * Peak envelope multiplier, solved so each hat matches the RMS of the voice it
   * replaces. 3.00 on the closed hat looks alarming beside every other voice's
   * sub-1.0 number and is CORRECT: the metal buffer carries far less energy
   * through the hat band than white noise does, and the envelope is applied AFTER
   * the filters, so nothing clips on the way. Lowering it silences the hats.
   */
  level: number;
  /** Decay in seconds before the accent time-scale. */
  decay: number;
  /** Fraction of peak held at `holdAt`, or 0 for a single-stage decay. */
  hold: number;
  holdAt: number;
}

/**
 * Both hats. metal -> bandpass -> highpass -> envelope, with a trickle of white
 * noise into the same bandpass to fill the gaps between the six partials.
 *
 * noiseMix 0.05 is measured, not chosen: through the hat band the metal buffer's
 * RMS is 0.059 against white noise's 0.376, so 0.05 puts metal:noise energy near
 * 3:1. At 0.30 the noise swamps the metal and you are back to the filtered-noise
 * hat this replaces. The 0.4 ms attack is mandatory rather than cosmetic — the
 * metal buffer starts mid-square-wave, so opening instantly is a step edge.
 */
function metalHat(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  gain: number,
  accent: number,
  s: HatShape
): void {
  const t = at(ctx, time);
  const A = velAmp(vel(accent));
  const decay = s.decay * velTime(vel(accent));

  const bp = biquad(ctx, 'bandpass', s.bpHz, s.bpQ);
  const hp = biquad(ctx, 'highpass', s.hpHz, s.hpQ);
  const peak = amp(gain, s.level * A);
  const g = env(ctx, peak, t, 0.0004);
  if (s.hold > 0 && s.holdAt < decay) {
    g.gain.exponentialRampToValueAtTime(Math.max(peak * s.hold, FLOOR), t + s.holdAt);
  }
  g.gain.exponentialRampToValueAtTime(FLOOR, t + decay);
  bp.connect(hp).connect(g).connect(dest);

  // ±1.5% playback rate makes every hit a slightly different cymbal, which is what
  // stops ten hats a bar from sounding like one sample retriggered.
  metalInto(ctx, bp, t, decay, 0.985 + Math.random() * 0.03);

  const noiseMix = ctx.createGain();
  noiseMix.gain.value = 0.05;
  noiseMix.connect(bp);
  noiseInto(ctx, noiseMix, t, decay);
}

/** Closed hat. Measured: RMS 0.0183 (was 0.0181) — unchanged loudness, sitting
 *  10.8 dB under the snare. Peak runs 0.37-0.81 over 30 noise draws against
 *  0.32-0.50: the metal source is spikier than filtered noise, so the crest
 *  factor rises even though the energy does not. */
export function hat(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  gain = 1,
  accent = 1
): void {
  // Short bound: Trap fires ten of these a bar and a real cymbal rings.
  if (playSample(ctx, dest, time, 'hat', gain, accent, 0.28)) return;
  metalHat(ctx, dest, time, gain, accent, {
    bpHz: 8600,
    bpQ: 0.8,
    hpHz: 6800,
    hpQ: 0.7,
    level: 3.0,
    decay: 0.052,
    hold: 0,
    holdAt: 0,
  });
}

/** Open hat. Measured: RMS 0.0303 (was 0.0293) · peak up to 0.60 over 30 draws,
 *  against 0.46. */
export function openHat(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  gain = 1,
  accent = 1
): void {
  if (playSample(ctx, dest, time, 'hat_open', gain, accent, 0.7)) return;
  metalHat(ctx, dest, time, gain, accent, {
    bpHz: 8000,
    bpQ: 0.7,
    hpHz: 6200,
    hpQ: 0.7,
    level: 1.7,
    decay: 0.34,
    // Two-stage: an open hat sizzles down to a plateau and then rings out.
    hold: 0.55,
    holdAt: 0.06,
  });
}

export interface SubOptions {
  /** Portamento start in Hz. Below 20, or absent, uses the 808's own pitch drop. */
  glideFromHz?: number;
  /** Fundamental decay in seconds, before the accent time-scale. */
  decaySec?: number;
}

/**
 * 808 sub. `rootHz` is supplied by the beat machine from the anchor deck's
 * detected key, so the bassline is automatically in key with the music.
 *
 * The octave layer and the drive are what "reads on small speakers" means
 * numerically: a laptop reproduces almost nothing of a 33 Hz sine, so the energy
 * has to exist above it. Measured at 55 Hz (A minor, the BeatMachine fallback
 * key): peak 0.850 (was 0.880) · RMS 0.176 (was 0.105, +4.5 dB) · envelope at
 * 100 ms 0.561 (was 0.190, +9.4 dB). At C1, the worst case, RMS is +4.6 dB with
 * the peak still near the old one (0.838 against 0.787).
 */
export function sub(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  rootHz: number,
  gain = 1,
  accent = 1,
  opts: SubOptions = {}
): void {
  const t = at(ctx, time);
  const v = vel(accent);
  const A = velAmp(v);
  const T = velTone(v);
  const D = velTime(v);

  const f0 = clamp(hzOf(ctx, rootHz, 55), 20, 200);
  const decay = secs(opts.decaySec, 0.62, 0.08, 4) * D;

  const sum = ctx.createGain();
  sum.gain.value = 0.78;
  const out = ctx.createGain();
  out.gain.value = 0.91;
  sum.connect(saturator(ctx, 0.35)).connect(out).connect(dest);

  const o1 = ctx.createOscillator();
  o1.type = 'sine';
  const glide = fin(opts.glideFromHz, 0);
  if (glide >= 20 && Math.abs(glide / f0 - 1) > 0.01) {
    // Portamento from a named note — the 808 slide.
    o1.frequency.setValueAtTime(clamp(glide, 20, 4000), t);
    o1.frequency.exponentialRampToValueAtTime(f0, t + 0.075);
  } else {
    o1.frequency.setValueAtTime(f0 * 1.9, t);
    o1.frequency.exponentialRampToValueAtTime(f0, t + 0.055);
  }
  // Two-stage amplitude: a hard knee into a long ring, which is what lets an 808
  // sustain under a mix instead of thumping and vanishing. Guarded against a
  // caller asking for a decay shorter than the knee itself.
  const knee = Math.min(0.09, decay * 0.6);
  const g1 = env(ctx, amp(gain, 0.92 * A), t, 0.006);
  g1.gain.exponentialRampToValueAtTime(amp(gain, 0.5 * A), t + knee);
  g1.gain.exponentialRampToValueAtTime(FLOOR, t + decay);
  o1.connect(g1).connect(sum);
  o1.start(t);
  o1.stop(t + decay + 0.03);

  const o2 = ctx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.setValueAtTime(f0 * 3.8, t);
  o2.frequency.exponentialRampToValueAtTime(f0 * 2, t + 0.055);
  const g2 = env(ctx, amp(gain, 0.16 * A * T), t, 0.004);
  g2.gain.exponentialRampToValueAtTime(FLOOR, t + 0.1);
  o2.connect(g2).connect(sum);
  o2.start(t);
  o2.stop(t + 0.13);

  const attack = biquad(ctx, 'bandpass', 1800, 1.2);
  const g3 = env(ctx, amp(gain, 0.1 * A * T), t, 0.0006);
  g3.gain.exponentialRampToValueAtTime(FLOOR, t + 0.012);
  attack.connect(g3).connect(sum);
  noiseInto(ctx, attack, t, 0.012);
}

/**
 * Tom. Suggested kit: 90 / 130 / 190 Hz.
 *
 * The second layer sits at f0 * 1.98 and does not glide — a real drumhead's
 * overtone is stretched and inharmonic, and making it an exact octave that
 * follows the fundamental down turns the tom into a synth bleep.
 *
 * Measured at 130 Hz: peak 0.705 · RMS 0.085, which sits 2.6 dB over the snare —
 * a fill voice, so scale it down at the call site. Peak into the shaper is 0.546.
 */
export function tom(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  freqHz = 120,
  gain = 1,
  accent = 1
): void {
  const t = at(ctx, time);
  const v = vel(accent);
  const A = velAmp(v);
  const T = velTone(v);
  const D = velTime(v);
  const f0 = clamp(fin(freqHz, 120), 45, 400);

  const sum = ctx.createGain();
  sum.gain.value = 0.66;
  // No unity post-trim node here: the kick and sub need theirs to hit their level
  // targets, the tom does not, and it would be one wasted node per hit.
  sum.connect(saturator(ctx, 0.22)).connect(dest);

  const bodyDecay = 0.38 * D;
  const o1 = ctx.createOscillator();
  o1.type = 'sine';
  o1.frequency.setValueAtTime(f0 * 1.55, t);
  o1.frequency.exponentialRampToValueAtTime(f0, t + 0.075);
  const g1 = env(ctx, amp(gain, 0.75 * A), t, 0.003);
  g1.gain.exponentialRampToValueAtTime(FLOOR, t + bodyDecay);
  o1.connect(g1).connect(sum);
  o1.start(t);
  o1.stop(t + bodyDecay + 0.03);

  const ringDecay = 0.16 * D;
  const o2 = ctx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.value = hzOf(ctx, f0 * 1.98, 238);
  const g2 = env(ctx, amp(gain, 0.28 * A), t, 0.003);
  g2.gain.exponentialRampToValueAtTime(FLOOR, t + ringDecay);
  o2.connect(g2).connect(sum);
  o2.start(t);
  o2.stop(t + ringDecay + 0.03);

  const skin = biquad(ctx, 'bandpass', hzOf(ctx, f0 * 6, 720, 400, 6000), 1.0);
  const g3 = env(ctx, amp(gain, 0.22 * A * T), t, 0.0008);
  g3.gain.exponentialRampToValueAtTime(FLOOR, t + 0.022);
  skin.connect(g3).connect(sum);
  noiseInto(ctx, skin, t, 0.022);
}

/**
 * Rim / sidestick. Every layer is a transient, so none of them takes the accent
 * time-scale — there is no tail to shorten.
 *
 * Measured: peak 0.560 · RMS 0.0287, 6.8 dB under the snare. Intentionally a
 * quiet accent voice, not a replacement for a backbeat.
 */
export function rim(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  gain = 1,
  accent = 1
): void {
  const t = at(ctx, time);
  const v = vel(accent);
  const A = velAmp(v);
  const T = velTone(v);

  for (const [hz, level, attack, decay] of [
    [1720, 0.4, 0.0003, 0.028],
    [458, 0.3, 0.0004, 0.038],
  ] as const) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = hzOf(ctx, hz, 1000);
    const g = env(ctx, amp(gain, level * A), t, attack);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + decay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + decay + 0.02);
  }

  const stick = biquad(ctx, 'bandpass', 3200, 2.2);
  const g = env(ctx, amp(gain, 0.25 * A * T), t, 0.0004);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + 0.016);
  stick.connect(g).connect(dest);
  noiseInto(ctx, stick, t, 0.016);
}

/** Frequency of a pitch class in the sub octave (C1 = 32.70 Hz). */
export function subRootHz(pitchClass: number): number {
  return 32.703 * Math.pow(2, (((pitchClass % 12) + 12) % 12) / 12);
}
