/**
 * The sampled drum kit.
 *
 * Synthesis has a ceiling, and the owner heard it. These are real recordings —
 * every one CC0 1.0, from Sonic Pi's bundled sample directory. See
 * docs/SAMPLES.md for the per-file chain of title; that provenance is the whole
 * reason this source was chosen over the dozens of "free 808 packs", which are
 * free to USE and silent or negative on REDISTRIBUTION.
 *
 * ONE-SHOTS ONLY. Not one `loop_*` file is here, and that is not fastidiousness:
 * `loop_amen` in that same CC0 directory is a copy of The Winstons' 1969
 * recording, and no uploader can dedicate a 1969 commercial phonogram to the
 * public domain. A CC0 stamp is only as good as the chain behind it.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. LOOKUP IS SYNCHRONOUS. Transport's step handler runs on a 25 ms timer and
 *    drums.ts voices must never throw or await — so `kitBuffer` is a Map read
 *    that returns AudioBuffer | null, and a missing sample plays the existing
 *    synthesis instead. Nothing async goes anywhere near the scheduler.
 *
 * 2. THE CACHE IS KEYED BY SAMPLE RATE, NOT BY CONTEXT. decodeAudioData
 *    resamples to the DECODING context's rate, so a buffer decoded at 44.1 kHz
 *    played inside a 48 kHz context is detuned and off-grid — and nothing
 *    throws. Keying by rate also stops jamFactory re-decoding the whole kit for
 *    each of its OfflineAudioContexts.
 *
 * 3. LOADING NEVER BLOCKS THE FIRST TAP. ensureKit() is fired and forgotten
 *    after the worklets resolve; synthesis covers the first second or two.
 *    jamFactory is the exception and must await, because its renders are
 *    memoised for the session — a jam rendered with synth drums stays that way.
 */

/** Vite emits each of these as a content-hashed asset URL at build time. */
const FILES = import.meta.glob('./kit/*.flac', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/**
 * Our name -> source file. Deliberately indirect: `bd_808` ships as `kick_deep`
 * because Roland holds registered trademarks on TR-808/909/303. The audio is
 * CC0 and fine to use; the NAME is not ours to put on a button or a filename.
 */
const KIT: Record<string, string> = {
  kick: 'bd_haus',
  kick_deep: 'bd_808',
  kick_tek: 'bd_tek',
  kick_fat: 'bd_fat',
  kick_boom: 'bd_boom',

  snare: 'sn_dolf',
  snare_dub: 'sn_dub',
  snare_hard: 'drum_snare_hard',
  snare_soft: 'drum_snare_soft',
  snare_elec: 'elec_snare',

  hat: 'drum_cymbal_closed',
  hat_pedal: 'drum_cymbal_pedal',
  hat_open: 'drum_cymbal_open',
  hat_soft: 'drum_cymbal_soft',
  crash: 'drum_splash_hard',
  ride: 'drum_cymbal_hard',

  tom_lo: 'drum_tom_lo_hard',
  tom_mid: 'drum_tom_mid_hard',
  tom_hi: 'drum_tom_hi_hard',

  cowbell: 'drum_cowbell',
  snap: 'perc_snap',
  snap2: 'perc_snap2',
  till: 'perc_till',
  tick: 'elec_tick',
  blip: 'elec_blip',
  wood: 'elec_wood',

  // No `impact` here on purpose. Sonic Pi's two impact one-shots are covered
  // only by the directory-wide CC0 line, with no per-file source — strictly
  // weaker provenance, and weak provenance is exactly where loop_amen hid. The
  // synthesized impact in macros.ts covers the job. See docs/SAMPLES.md.
  swoosh: 'perc_swoosh',
  swash: 'perc_swash',
  boom: 'misc_cineboom',

  vinyl_scratch: 'vinyl_scratch',
  vinyl_backspin: 'vinyl_backspin',
  vinyl_rewind: 'vinyl_rewind',
  vinyl_hiss: 'vinyl_hiss',
};

function urlFor(sourceName: string): string | null {
  return FILES[`./kit/${sourceName}.flac`] ?? null;
}

/** rate -> (our name -> buffer). Rate-keyed; see rule 2 above. */
const cache = new Map<number, Map<string, AudioBuffer>>();
const inFlight = new Map<number, Promise<void>>();

function bucket(rate: number): Map<string, AudioBuffer> {
  let m = cache.get(rate);
  if (!m) {
    m = new Map();
    cache.set(rate, m);
  }
  return m;
}

/**
 * Synchronous lookup for the audio path. Null means "not loaded, not decodable,
 * or not in the kit" — every caller treats all three the same way, by playing
 * the synthesized voice instead.
 */
export function kitBuffer(ctx: BaseAudioContext, name: string): AudioBuffer | null {
  return bucket(ctx.sampleRate).get(name) ?? null;
}

export function kitReady(ctx: BaseAudioContext): boolean {
  return bucket(ctx.sampleRate).size > 0;
}

/**
 * Fetch and decode the kit for this context's sample rate. Idempotent and
 * deduplicated, so calling it from several places costs one load.
 *
 * A file that 404s or fails to decode is skipped, not thrown: a browser without
 * FLAC support in decodeAudioData degrades to the synthesized kit rather than
 * to silence. That is also the only reason this app still works if the assets
 * are stripped from a deployment.
 */
export function ensureKit(ctx: BaseAudioContext): Promise<void> {
  const rate = ctx.sampleRate;
  const existing = inFlight.get(rate);
  if (existing) return existing;

  const target = bucket(rate);
  const job = (async () => {
    const entries = Object.entries(KIT);
    await Promise.all(
      entries.map(async ([name, source]) => {
        const url = urlFor(source);
        if (!url) return;
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const bytes = await res.arrayBuffer();
          const buf = await ctx.decodeAudioData(bytes);
          target.set(name, buf);
        } catch {
          // Skipped, not fatal — synthesis covers it.
        }
      })
    );
  })();

  inFlight.set(rate, job);
  return job;
}

/** How much of the kit actually decoded, for diagnostics. */
export function kitStatus(ctx: BaseAudioContext): { loaded: number; total: number } {
  return { loaded: bucket(ctx.sampleRate).size, total: Object.keys(KIT).length };
}
