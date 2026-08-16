import { clap, hat, kick, openHat, rim, snare, tom } from './drums';
import { kitBuffer } from './sampleKit';

/**
 * The three beat-pad kits.
 *
 * SIX PADS, ROLES FIXED ACROSS ALL THREE PACKS. Pad 1 is always the boom
 * whatever pack is selected, so the labels never move under a child's finger.
 * A pack changes the SOUND in each role, never the layout.
 *
 * The packs are different in REGISTER and in DECAY LENGTH, not only in timbre:
 *  1 "Party" is bright and acoustic
 *  2 "Boom"  is deep and dark, with a ride where Party has an open hat
 *  3 "Robot" is short and electronic, with no acoustic tail anywhere
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

export const DRUM_PACKS: DrumPack[] = [
  {
    name: 'Party',
    slots: [
      { sample: 'kick', fallback: kick, gain: 0.9, maxSec: 0.9 },
      { sample: 'snap', fallback: clap, gain: 0.85, maxSec: 0.6 },
      { sample: 'hat', fallback: hat, gain: 0.55, maxSec: 0.24 },
      { sample: 'hat_open', fallback: openHat, gain: 0.55, maxSec: 0.34 },
      { sample: 'tom_mid', fallback: tomAt(130), gain: 0.7, maxSec: 0.5 },
      { sample: 'cowbell', fallback: rim, gain: 0.6, maxSec: 0.3 },
    ],
  },
  {
    name: 'Boom',
    slots: [
      { sample: 'kick_boom', fallback: kick, gain: 0.9, maxSec: 0.9 },
      { sample: 'snare_hard', fallback: snare, gain: 0.85, maxSec: 0.6 },
      { sample: 'hat_soft', fallback: hat, gain: 0.55, maxSec: 0.24 },
      // A ride, not an open hat — the one substitution that makes this pack read
      // as a different kit rather than as the same kit filtered.
      { sample: 'ride', fallback: openHat, gain: 0.55, maxSec: 0.34 },
      { sample: 'tom_lo', fallback: tomAt(90), gain: 0.7, maxSec: 0.5 },
      { sample: 'wood', fallback: rim, gain: 0.6, maxSec: 0.3 },
    ],
  },
  {
    name: 'Robot',
    slots: [
      { sample: 'kick_tek', fallback: kick, gain: 0.9, maxSec: 0.9 },
      { sample: 'snare_elec', fallback: snare, gain: 0.85, maxSec: 0.6 },
      { sample: 'tick', fallback: hat, gain: 0.55, maxSec: 0.24 },
      { sample: 'crash', fallback: openHat, gain: 0.55, maxSec: 0.34 },
      // `till` is a short percussive tick, so its fallback tom is pitched high
      // and reads as electronic rather than as a drum-kit tom.
      { sample: 'till', fallback: tomAt(170), gain: 0.7, maxSec: 0.5 },
      { sample: 'blip', fallback: rim, gain: 0.6, maxSec: 0.3 },
    ],
  },
];

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
  const v = clamp(fin(accent, 1), 0, 1);
  const dur = Math.min(clamp(fin(maxSec, 0.3), 0.02, 4) * velTime(v), buf.duration);
  if (!(dur > 0.02)) return false;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const g = ctx.createGain();
  const peak = clamp(fin(gain, 1) * velAmp(v), FLOOR, 8);
  g.gain.setValueAtTime(peak, t);
  // Ride the tail down rather than cutting it: a hard stop on a decaying cymbal
  // is a click, and at sixteenths that click lands on every hit.
  g.gain.setValueAtTime(peak, t + dur * 0.72);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);

  if (v < 0.99) {
    // A quiet hit is duller as well as softer.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(1200 + 14000 * velTone(v), 20, ctx.sampleRate / 2 - 100);
    lp.Q.value = 0.7;
    src.connect(lp).connect(g).connect(dest);
  } else {
    src.connect(g).connect(dest);
  }

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
