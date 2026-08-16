import { clap, hat, kick, openHat, snare } from './drums';
import { ensureKit } from './sampleKit';
import { bassNote, hzFor, pluck, progressionFor, stab, triadSemitones } from './melody';
import type { KeyMode } from './types';

/**
 * Built-in starter jams.
 *
 * The single biggest product problem this solves: without these, the app is
 * silent until someone supplies audio files, which a child cannot do. These are
 * complete backing tracks — drums, bass, chords, arpeggio — rendered through an
 * OfflineAudioContext using the same synth voices the live beat machine uses.
 * Nothing is fetched and nothing is licensed.
 *
 * Their BPMs and keys are deliberately spread out so that mashing any two of
 * them together actually exercises tempo sync, phase lock and the harmonic
 * nudge rather than getting a free pass.
 */

export interface JamGroove {
  kick: number[];
  snare: number[];
  hats: number[];
  openHats: number[];
  snareVoice: 'snare' | 'clap';
}

export interface JamSpec {
  id: string;
  name: string;
  emoji: string;
  color: string;
  bpm: number;
  keyPc: number;
  mode: KeyMode;
  groove: JamGroove;
  bassSteps: number[];
  stabSteps: number[];
  arpSteps: number[];
}

export const JAMS: JamSpec[] = [
  {
    id: 'sunbeam',
    name: 'Sunbeam',
    emoji: '🌞',
    color: '#fbbf24',
    bpm: 100,
    keyPc: 0, // C major
    mode: 'major',
    groove: {
      kick: [0, 4, 8, 12],
      snare: [4, 12],
      hats: [2, 6, 10, 14],
      openHats: [14],
      snareVoice: 'clap',
    },
    bassSteps: [0, 8],
    stabSteps: [2, 6, 10, 14],
    arpSteps: [1, 5, 9, 13],
  },
  {
    id: 'moonwalk',
    name: 'Moonwalk',
    emoji: '🌙',
    color: '#818cf8',
    bpm: 92,
    keyPc: 9, // A minor
    mode: 'minor',
    groove: {
      kick: [0, 3, 8, 10],
      snare: [4, 12],
      hats: [0, 2, 4, 6, 8, 10, 12, 14],
      openHats: [],
      snareVoice: 'snare',
    },
    bassSteps: [0, 6, 8],
    stabSteps: [4, 12],
    arpSteps: [],
  },
  {
    id: 'rocket',
    name: 'Rocket Fuel',
    emoji: '🚀',
    color: '#f472b6',
    bpm: 128,
    keyPc: 5, // F minor
    mode: 'minor',
    groove: {
      kick: [0, 4, 8, 12],
      snare: [4, 12],
      hats: [2, 6, 10, 14],
      openHats: [6, 14],
      snareVoice: 'clap',
    },
    bassSteps: [0, 3, 6, 8, 11, 14],
    stabSteps: [0, 8],
    arpSteps: [2, 4, 10, 12],
  },
  {
    id: 'bubblegum',
    name: 'Bubblegum',
    emoji: '🍬',
    color: '#22d3ee',
    bpm: 112,
    keyPc: 7, // G major
    mode: 'major',
    groove: {
      kick: [0, 6, 8, 12],
      snare: [4, 12],
      hats: [0, 2, 4, 6, 8, 10, 12, 14],
      openHats: [15],
      snareVoice: 'clap',
    },
    bassSteps: [0, 8, 14],
    stabSteps: [0, 3, 8, 11],
    arpSteps: [5, 7, 13, 15],
  },
];

/**
 * Eight bars = two full turns of the four-bar progression, with the fill landing
 * on the last bar right before the seam.
 *
 * Kept deliberately short because render cost is what the user waits through:
 * offline rendering measured ~145 ms per bar on this material, so 24 bars meant
 * a 3-10 second stare at a spinner after tapping a jam. The buffer loops, so
 * short costs nothing musically and buys a near-instant tap-to-music.
 */
export const DEFAULT_JAM_BARS = 8;

/**
 * Render a jam to an AudioBuffer. Offline rendering runs faster than realtime,
 * so a ~60 second track costs well under a second of wall clock.
 */
const cache = new Map<string, Promise<AudioBuffer>>();

/**
 * Cached render. Offline rendering measured 2.3-3.2 s for eight bars on this
 * material, which is far too long to stare at after tapping a button, so the
 * result is memoised and Party Mode pre-warms all four in the background while
 * the picker is on screen. Decks copy channel data on load, so handing the same
 * buffer to both decks is safe.
 */
export function renderJam(
  spec: JamSpec,
  sampleRate: number,
  bars = DEFAULT_JAM_BARS
): Promise<AudioBuffer> {
  const key = `${spec.id}:${sampleRate}:${bars}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = renderJamUncached(spec, sampleRate, bars).catch((err) => {
      cache.delete(key); // a failed render must not be cached forever
      throw err;
    });
    cache.set(key, pending);
  }
  return pending;
}

/** Render every jam ahead of time so tapping one is instant. */
export async function prewarmJams(sampleRate: number, bars = DEFAULT_JAM_BARS): Promise<void> {
  for (const spec of JAMS) {
    try {
      await renderJam(spec, sampleRate, bars);
    } catch {
      /* one bad jam should not stop the rest warming */
    }
  }
}

async function renderJamUncached(
  spec: JamSpec,
  sampleRate: number,
  bars: number
): Promise<AudioBuffer> {
  const beat = 60 / spec.bpm;
  const step = beat / 4;
  const bodySec = bars * 16 * step;
  // Keep the tail short: the buffer loops, and long tails would smear the seam.
  const frames = Math.ceil((bodySec + 0.35) * sampleRate);

  const off = new OfflineAudioContext(2, frames, sampleRate);

  // AWAITED here, unlike the live engine's fire-and-forget. Jam renders are
  // memoised for the session, so a jam rendered before the kit lands would keep
  // its synthesized drums for as long as the app stays open.
  await ensureKit(off);

  const master = off.createGain();
  master.gain.value = 0.9;
  const glue = off.createDynamicsCompressor();
  glue.threshold.value = -12;
  glue.knee.value = 6;
  glue.ratio.value = 3;
  glue.attack.value = 0.005;
  glue.release.value = 0.2;
  master.connect(glue).connect(off.destination);

  const drumBus = off.createGain();
  drumBus.gain.value = 0.95;
  drumBus.connect(master);

  const musicBus = off.createGain();
  musicBus.gain.value = 0.9;
  musicBus.connect(master);

  const prog = progressionFor(spec.mode);

  for (let bar = 0; bar < bars; bar++) {
    const degree = prog[bar % prog.length];
    const triad = triadSemitones(spec.mode, degree);
    const chordHz = triad.map((s) => hzFor(spec.keyPc, s, 4));
    const rootHz = hzFor(spec.keyPc, triad[0], 2);
    const barT = bar * 16 * step;
    const isFill = bar % 8 === 7;

    for (let s = 0; s < 16; s++) {
      const t = barT + s * step;

      if (spec.groove.kick.includes(s)) kick(off, drumBus, t, 1);
      if (spec.groove.snare.includes(s)) {
        (spec.groove.snareVoice === 'clap' ? clap : snare)(off, drumBus, t, 0.9);
      }
      if (spec.groove.hats.includes(s)) hat(off, drumBus, t, 0.85);
      if (spec.groove.openHats.includes(s)) openHat(off, drumBus, t, 0.7);

      if (spec.bassSteps.includes(s)) bassNote(off, musicBus, t, rootHz, step * 1.8, 0.32);
      if (spec.stabSteps.includes(s)) stab(off, musicBus, t, chordHz, step * 1.6, 0.15);
      if (spec.arpSteps.includes(s)) {
        const note = triad[(s >> 1) % triad.length];
        pluck(off, musicBus, t, hzFor(spec.keyPc, note, 5), 0.2, 0.11);
      }

      // A fill every eight bars, so a loop does not feel like a loop.
      if (isFill && s >= 12) snare(off, drumBus, t, 0.35 + (s - 12) * 0.16);
    }
  }

  return off.startRendering();
}
