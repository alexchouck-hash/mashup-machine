import { clap, hat, kick, openHat, rim, snare, tom } from './drums';
import { assertKitNames, kitBuffer } from './sampleKit';
import { DEAD_HANDLE, makeExpression, type VoiceHandle } from './expression';

/**
 * The four beat-pad kits.
 *
 * SIX PADS, ROLES FIXED ACROSS ALL THREE PACKS. Pad 1 is always the boom
 * whatever pack is selected, so the labels never move under a child's finger.
 * A pack changes the SOUND in each role, never the layout.
 *
 * The packs are different in REGISTER and in DECAY LENGTH, not only in timbre:
 *  1 "Party" is bright and acoustic
 *  1 "808"     deep sub kick, electronic snare, cowbell
 *  2 "Trap"    fat kick, hard snare, the shortest tick in the kit for fast hats
 *  3 "Hip-Hop" round kick, dub snare, pedal hat, a snap instead of a bell
 *  4 "Rock"    a real acoustic kit: heavy kick, hard snare, crash and ride
 *
 * SWITCHING PACKS RE-VOICES EVERY TAKE, including committed ones. That is
 * deliberate — a pack is a kit swap, so a child's loops change kit instantly,
 * which is a real feature for free. Freezing the pack per take was rejected: it
 * is invisible state a child can neither see nor undo.
 *
 * Every slot names a SAMPLE and a synthesis FALLBACK. The fallback is not
 * decoration: it is why the app still works with the audio assets stripped from
 * a deployment, and why the first tap of a session makes a sound before the kit
 * has finished decoding.
 */

const FLOOR = 0.0001;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const fin = (v: number, fb: number): number => (Number.isFinite(v) ? v : fb);

/** Velocity -> amplitude, and -> tone/time, matching the curves in drums.ts. */
const velAmp = (v: number): number => 0.15 + 0.85 * v * v;
const velTone = (v: number): number => 0.35 + 0.65 * v;
const velTime = (v: number): number => 0.7 + 0.3 * v;

/** Gentle enough to darken without resonating. */
const TONE_Q = 0.7;

export type PadFallback = (
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  gain: number,
  accent: number
) => void;

export interface PadSpec {
  /** Kit name from sampleKit.ts. */
  sample: string;
  /** Played when the sample is missing — stripped assets, or still decoding. */
  fallback: PadFallback;
  /** Per-slot level. Part of the pack definition, so a pack cannot cost headroom. */
  gain: number;
  /**
   * Hard bound on the sample's length.
   *
   * NOT optional decoration. A ride or a crash rings for over a second, and a
   * pad retriggered at sixteenths smears into mush without this. It is the
   * reason a long-tailed pack (Boom's ride, Robot's crash) is safe to put under
   * a child's finger at all.
   */
  maxSec: number;
}

export interface DrumPack {
  name: string;
  /** Exactly PAD_COUNT entries, in PAD_LABELS order. */
  slots: PadSpec[];
}

/** Roles, fixed. Index is the TakeLooper payload for the drum surface. */
export const PAD_LABELS = ['BOOM', 'CLAP', 'TSS', 'OPEN', 'TOM', 'TING'] as const;
export const PAD_COUNT = PAD_LABELS.length;

/** The kick slot, which is what a sidechain wants to pump against. */
export const BOOM_SLOT = 0;

const tomAt =
  (hz: number): PadFallback =>
  (ctx, dest, time, gain, accent) =>
    tom(ctx, dest, time, hz, gain, accent);

/** Names referenced below, checked against the kit at startup in dev. */
function validatePacks(packs: DrumPack[]): DrumPack[] {
  assertKitNames(
    packs.flatMap((p) => p.slots.map((s) => s.sample)),
    'DRUM_PACKS'
  );
  return packs;
}

/**
 * The four packs the owner asked for: 808, Trap, Hip-Hop, Rock.
 *
 * On the name "808": the registered marks are TR-808 / TR-909 / TB-303, and the
 * concern was raised and ruled on — the owner chose the label knowingly. See the
 * Naming section of docs/SAMPLES.md. Note the FILE is still `kick_deep`; only the
 * user-facing pack label carries the number, so reversing it is this one string.
 *
 * Every slot's gain and maxSec is part of the pack rather than the player, so a
 * pack cannot cost headroom or smear a long tail at sixteenths.
 */
export const DRUM_PACKS: DrumPack[] = [
  {
    name: '808',
    slots: [
      // The deep sub kick this pack exists for. Long tail, so the bound matters.
      { sample: 'kick_deep', fallback: kick, gain: 0.9, maxSec: 0.9 },
      { sample: 'snare_elec', fallback: snare, gain: 0.85, maxSec: 0.6 },
      { sample: 'hat', fallback: hat, gain: 0.55, maxSec: 0.24 },
      { sample: 'hat_open', fallback: openHat, gain: 0.55, maxSec: 0.34 },
      { sample: 'tom_lo', fallback: tomAt(90), gain: 0.7, maxSec: 0.5 },
      { sample: 'cowbell', fallback: rim, gain: 0.6, maxSec: 0.3 },
    ],
  },
  {
    name: 'Trap',
    slots: [
      { sample: 'kick_fat', fallback: kick, gain: 0.9, maxSec: 0.9 },
      { sample: 'snare_hard', fallback: snare, gain: 0.85, maxSec: 0.6 },
      // Trap lives on fast hats, so the shortest tick in the kit takes the slot
      // and the bound is tighter still — ten of these a bar is normal here.
      { sample: 'tick', fallback: hat, gain: 0.55, maxSec: 0.18 },
      { sample: 'hat_open', fallback: openHat, gain: 0.55, maxSec: 0.34 },
      { sample: 'tom_hi', fallback: tomAt(170), gain: 0.7, maxSec: 0.5 },
      { sample: 'blip', fallback: rim, gain: 0.6, maxSec: 0.3 },
    ],
  },
  {
    name: 'Hip-Hop',
    slots: [
      { sample: 'kick', fallback: kick, gain: 0.9, maxSec: 0.9 },
      { sample: 'snare_dub', fallback: snare, gain: 0.85, maxSec: 0.6 },
      { sample: 'hat_pedal', fallback: hat, gain: 0.55, maxSec: 0.24 },
      { sample: 'hat_soft', fallback: openHat, gain: 0.55, maxSec: 0.34 },
      { sample: 'tom_mid', fallback: tomAt(130), gain: 0.7, maxSec: 0.5 },
      { sample: 'snap', fallback: clap, gain: 0.6, maxSec: 0.3 },
    ],
  },
  {
    name: 'Rock',
    slots: [
      // A real acoustic kit rather than the same kit filtered: heavy kick,
      // hard-hit snare, and cymbals instead of programmed hats.
      { sample: 'kick_heavy', fallback: kick, gain: 0.9, maxSec: 0.9 },
      { sample: 'snare_hard', fallback: snare, gain: 0.85, maxSec: 0.6 },
      { sample: 'hat_pedal', fallback: hat, gain: 0.55, maxSec: 0.24 },
      { sample: 'crash', fallback: openHat, gain: 0.5, maxSec: 0.4 },
      { sample: 'tom_lo', fallback: tomAt(100), gain: 0.7, maxSec: 0.5 },
      { sample: 'ride', fallback: rim, gain: 0.55, maxSec: 0.34 },
    ],
  },
];

// Runs once at import, dev only. A mistyped sample name is invisible to the
// compiler and degrades silently to synthesis, so it is checked out loud here.
validatePacks(DRUM_PACKS);

/**
 * Play a named kit sample, or report that there is none.
 *
 * This is the shape drums.ts's own voices use — `if (sample(...)) return;` then
 * synthesis — reproduced here because that file's `playSample` is private and
 * this change does not own it. THE ONE-LINE FIX when it does: export
 * `playSample` as `sampleVoice` from drums.ts, import it here, and delete this
 * function. The signature is identical on purpose so that is a pure deletion.
 *
 * Synchronous by construction. `kitBuffer` is a Map read that returns
 * AudioBuffer | null, so nothing async and nothing throwing goes near the
 * transport's step handler.
 */
/**
 * What a velocity SOUNDS like: how long, how loud, how dull.
 *
 * ONE place decides all three, because this file has TWO entry points — the
 * SCHEDULED `padVoice` and the LIVE `padVoiceLive` — and the second copy of
 * this arithmetic is precisely how a soft tap ends up brighter under the finger
 * than the identical hit is when the take loops it back. It was latent while
 * every live tap was velocity 1 (nothing filters at full velocity, so the two
 * chains agreed by accident); wiring strike height to the live path made the
 * disagreement audible on every tap below full. The melody surface had to learn
 * the same lesson — see `MelodyLooper.shape`.
 *
 * `toneHz` is null at full velocity rather than "wide open": a hard hit inserts
 * no biquad at all, which is what the scheduled path has always done.
 */
function padShape(
  ctx: BaseAudioContext,
  bufSec: number,
  gain: number,
  vel: number,
  maxSec: number
): { dur: number; peak: number; toneHz: number | null } {
  const v = clamp(fin(vel, 1), 0, 1);
  return {
    dur: Math.min(clamp(fin(maxSec, 0.3), 0.02, 4) * velTime(v), bufSec),
    peak: clamp(fin(gain, 1) * velAmp(v), FLOOR, 8),
    // A quiet hit is duller as well as softer — a drum struck gently excites
    // less of the top end. Without this a soft tap is merely a small loud tap.
    toneHz: v < 0.99 ? clamp(1200 + 14000 * velTone(v), 20, ctx.sampleRate / 2 - 100) : null,
  };
}

function toneFilter(ctx: BaseAudioContext, hz: number): BiquadFilterNode {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = hz;
  lp.Q.value = TONE_Q;
  return lp;
}

/**
 * Play a pad NOW and hand back a handle, so a finger still on the pad can bend
 * and swell the note it just struck.
 *
 * Separate from `padVoice` on purpose: a SCHEDULED hit has no gesture attached
 * and must not pay for a chain it will never use, while a LIVE hit needs the
 * gain and playbackRate to outlive the call. See expression.ts.
 *
 * Returns DEAD_HANDLE rather than null when the sample is missing, so the caller
 * still gets a sound (the synthesis fallback) and a handle whose methods are
 * simply inert — the level axis degrades to nothing rather than to a crash.
 */
export function padVoiceLive(
  ctx: BaseAudioContext,
  dest: AudioNode,
  spec: PadSpec,
  gain: number,
  vel: number
): VoiceHandle {
  const g = clamp(fin(gain, 1), 0, 4) * spec.gain;
  const v = clamp(fin(vel, 1), 0, 1);
  const t = ctx.currentTime;

  const buf = kitBuffer(ctx, spec.sample);
  if (!buf) {
    // Synthesised fallback: audible, but nothing here is modulatable.
    spec.fallback(ctx, dest, t, g, v);
    return DEAD_HANDLE;
  }

  const { dur, peak, toneHz } = padShape(ctx, buf.duration, g, v, spec.maxSec);
  // Same refusal the scheduled path makes: a degenerate length is not a quiet
  // hit, it is silence, and silence live where the loop synthesises is drift.
  if (!(dur > 0.02)) {
    spec.fallback(ctx, dest, t, g, v);
    return DEAD_HANDLE;
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const { input, handle } = makeExpression(ctx, dest, peak, src.playbackRate, 1);

  // The envelope lives on a node INSIDE the expression chain, so the gesture's
  // gain writes and the tail ride cannot fight over one param.
  const env = ctx.createGain();
  env.gain.setValueAtTime(1, t);
  env.gain.setValueAtTime(1, t + dur * 0.72);
  env.gain.exponentialRampToValueAtTime(FLOOR, t + dur);

  // source -> tone -> envelope, the same order the scheduled chain uses. A
  // biquad is linear so its position among the gains is acoustically free; the
  // point of matching is that one graph shape is one thing to reason about.
  if (toneHz !== null) src.connect(toneFilter(ctx, toneHz)).connect(env).connect(input);
  else src.connect(env).connect(input);
  src.start(t);
  src.stop(t + dur + 0.02);
  return handle;
}

function sampleVoice(
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

  const t = Math.max(0, fin(time, ctx.currentTime));
  // Length, level and tone come from `padShape`, not from a local copy of the
  // curves — that shared decision is the whole point of the helper.
  const { dur, peak, toneHz } = padShape(ctx, buf.duration, gain, accent, maxSec);
  if (!(dur > 0.02)) return false;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t);
  // Ride the tail down rather than cutting it: a hard stop on a decaying cymbal
  // is a click, and at sixteenths that click lands on every hit.
  g.gain.setValueAtTime(peak, t + dur * 0.72);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);

  if (toneHz !== null) src.connect(toneFilter(ctx, toneHz)).connect(g).connect(dest);
  else src.connect(g).connect(dest);

  src.start(t);
  src.stop(t + dur + 0.02);
  return true;
}

/**
 * Sound one pad. MUST NOT THROW — this is the drum surface's TakeVoice.play.
 *
 * `gain` is the take's stack trim (1 for a live tap); the slot's own gain is
 * part of the pack, so a pack cannot change how much headroom the bus needs.
 */
export function padVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  spec: PadSpec,
  gain: number,
  vel: number
): void {
  const g = clamp(fin(gain, 1), 0, 4) * spec.gain;
  const v = clamp(fin(vel, 1), 0, 1);
  if (sampleVoice(ctx, dest, time, spec.sample, g, v, spec.maxSec)) return;
  spec.fallback(ctx, dest, time, g, v);
}
