/**
 * Expressive taps: velocity from where you hit, then bend and swell while held.
 *
 * The owner's ask: "the volume should be louder if a pad is hit higher on the
 * screen and softer if lower. You should be able to hold then slide your mouse
 * left / right to bend. up / down to make louder or softer."
 *
 * WHY THIS FILE EXISTS AT ALL. Every voice in drums.ts and melodyVoices.ts is a
 * fire-and-forget one-shot: `kick(ctx, dest, time, gain, accent)` builds its
 * oscillators, schedules an envelope and returns void. Nothing survives the call,
 * so nothing can be bent or swelled afterwards. That is the right shape for a
 * sequencer — a scheduled hit needs no handle — and the wrong shape for a finger
 * that is still on the pad. So a LIVE tap plays through a per-tap expression
 * chain that outlives the call and hands back the two params a gesture needs.
 *
 *   voice -> rate (samples only) -> gain -> dest
 *
 * WHAT BENDS, HONESTLY. Pitch bend is `playbackRate` on a buffer source, so it
 * works on any SAMPLED voice — which is every drum pad and three of the four
 * keyboard voices once the kit has decoded. It does NOT work on the synthesized
 * fallbacks or on the Synth keyboard voice, whose oscillators are built and
 * scheduled inside the voice function with no exposed frequency param. Rather
 * than thread a detune param through nine voice signatures for a case that only
 * arises before the kit loads, `canBend` reports the truth and the UI can dim the
 * horizontal axis. Level always works, because the gain node is ours.
 *
 * A handle is deliberately NOT a recording. The take stores the velocity the pad
 * was struck at, because that is one number and it is what "hit higher, louder"
 * means. A continuous bend curve is a per-hit automation lane, which is a
 * different feature and a much larger one; live gestures shape the sounding note
 * and are not played back.
 */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const fin = (v: number, fb: number): number => (Number.isFinite(v) ? v : fb);

/** Exponential ramps cannot reach zero. */
const FLOOR = 0.0001;

/** Bend range at full horizontal travel. A whole tone each way. */
export const BEND_SEMITONES = 2;

/**
 * Smoothing for live gesture writes.
 *
 * 25 ms: short enough that a fast slide feels attached to the finger, long
 * enough that the ~60 Hz stream of pointermove values does not zipper. Both
 * params use setTargetAtTime rather than setValueAtTime for exactly that reason.
 */
const GESTURE_TAU = 0.025;

export interface VoiceHandle {
  /** True when this voice can actually bend. See the header. */
  readonly canBend: boolean;
  /** Semitones, signed. Clamped to +/- BEND_SEMITONES. */
  bend(semitones: number): void;
  /** Multiplier on the tap's own level, 0..2. 1 is as struck. */
  level(mul: number): void;
  /** Let go. The voice's own envelope still finishes it. */
  release(): void;
}

/** A handle for a voice that cannot be modulated — every method a no-op. */
export const DEAD_HANDLE: VoiceHandle = {
  canBend: false,
  bend: () => {},
  level: () => {},
  release: () => {},
};

/**
 * Build the chain a live tap plays through.
 *
 * `rate` is the buffer source's playbackRate when the voice is sampled, and null
 * when it is synthesized. The caller connects its voice to `input` and hands the
 * handle to whoever is holding the pad.
 */
export function makeExpression(
  ctx: BaseAudioContext,
  dest: AudioNode,
  baseLevel: number,
  rate: AudioParam | null,
  baseRate: number
): { input: GainNode; handle: VoiceHandle } {
  const g = ctx.createGain();
  const level0 = clamp(fin(baseLevel, 1), FLOOR, 4);
  g.gain.setValueAtTime(level0, ctx.currentTime);
  g.connect(dest);

  const handle: VoiceHandle = {
    canBend: rate !== null,
    bend(semitones: number) {
      if (!rate) return;
      const s = clamp(fin(semitones, 0), -BEND_SEMITONES, BEND_SEMITONES);
      // Ratio, not addition: a bend is a musical interval, and doing it in Hz
      // would bend low notes further than high ones.
      const target = clamp(baseRate * Math.pow(2, s / 12), 0.06, 8);
      rate.setTargetAtTime(target, ctx.currentTime, GESTURE_TAU);
    },
    level(mul: number) {
      const m = clamp(fin(mul, 1), 0, 2);
      g.gain.setTargetAtTime(Math.max(level0 * m, FLOOR), ctx.currentTime, GESTURE_TAU);
    },
    release() {
      // Deliberately does NOT stop the voice. A drum hit is a decay, not a note
      // held under a finger, and cutting it on pointerup would turn every pad
      // into a gate. The voice's own envelope ends it.
    },
  };

  return { input: g, handle };
}

/**
 * Velocity from where the pad was struck.
 *
 * `y01` is 0 at the TOP of the control and 1 at the bottom, which is how DOM
 * coordinates arrive, so it is inverted here rather than at every call site.
 * The floor is 0.35, not 0: the bottom edge of a pad must still make a sound a
 * child can hear, or the control reads as broken rather than as quiet.
 */
export function velocityFromY(y01: number): number {
  const y = clamp(fin(y01, 0.5), 0, 1);
  return 0.35 + 0.65 * (1 - y);
}

/**
 * Gesture deltas to expression, in pad-widths and pad-heights.
 *
 * Both axes are deliberately generous — a child's slide is short and imprecise,
 * and a control that needs a confident 200 px drag to do anything reads as
 * doing nothing.
 */
export function gestureToBend(dxPadWidths: number): number {
  return clamp(dxPadWidths * 2, -1, 1) * BEND_SEMITONES;
}

export function gestureToLevel(dyPadHeights: number): number {
  // Up is louder, and up is NEGATIVE dy in screen coordinates.
  return clamp(1 - dyPadHeights * 1.2, 0, 2);
}
