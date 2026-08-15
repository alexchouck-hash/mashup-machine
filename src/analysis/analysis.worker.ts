/// <reference lib="webworker" />
/**
 * Analysis worker — BPM, beat-grid anchor, musical key, loudness.
 *
 * Runs off the main thread so the deck is playable the instant the file decodes;
 * the numbers fill in behind it (spec: "Analysis must not block loading").
 *
 * BPM  : onset envelope -> autocorrelation with harmonic reinforcement.
 * Key  : chroma (FFT) -> Krumhansl-Schmuckler profile correlation.
 * Both are the spec's sanctioned self-contained path rather than Essentia.js —
 * a ~4 MB WASM payload for two numbers we can compute in ~200 ms of plain JS.
 * SWAP POINT: replace analyseBpm/analyseKey with Essentia calls; the message
 * protocol and AnalysisResult shape stay identical.
 */
import type { AnalysisRequest, AnalysisResponse, AnalysisResult, KeyMode } from '../audio/types';
import { camelotOf, keyNameOf } from '../audio/camelot';

declare const self: DedicatedWorkerGlobalScope;

const TARGET_SR = 11025;
const ANALYSIS_SECONDS = 150;

/* ------------------------------------------------------------------ FFT --- */

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const xr = re[i + j + half];
        const xi = im[i + j + half];
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + half] = ur - vr;
        im[i + j + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/* ------------------------------------------------------------ decimation --- */

/** Block-average decimation. The boxcar doubles as anti-alias filtering. */
function decimate(x: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return x;
  const n = Math.floor(x.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) s += x[base + j];
    out[i] = s / factor;
  }
  return out;
}

/* -------------------------------------------------------------------- BPM --- */

interface BpmResult {
  bpm: number;
  confidence: number;
  firstBeatSec: number;
}

function analyseBpm(x: Float32Array, sr: number, startSec: number): BpmResult {
  const HOP = 128;
  const WIN = 256;
  const fps = sr / HOP;

  const frames = Math.max(1, Math.floor((x.length - WIN) / HOP));
  const env = new Float32Array(frames);
  for (let k = 0; k < frames; k++) {
    let s = 0;
    const base = k * HOP;
    for (let i = 0; i < WIN; i++) s += Math.abs(x[base + i]);
    env[k] = s / WIN;
  }

  // Half-wave-rectified first difference = onset strength.
  const onset = new Float32Array(frames);
  for (let k = 1; k < frames; k++) {
    const d = env[k] - env[k - 1];
    onset[k] = d > 0 ? d : 0;
  }
  let mean = 0;
  for (let k = 0; k < frames; k++) mean += onset[k];
  mean /= Math.max(1, frames);
  for (let k = 0; k < frames; k++) onset[k] -= mean;

  const minLag = Math.max(2, Math.floor((fps * 60) / 200)); // 200 BPM
  const maxLag = Math.ceil((fps * 60) / 60); // 60 BPM
  const acMax = Math.min(frames - 1, maxLag * 3);

  const ac = new Float32Array(acMax + 1);
  for (let L = minLag; L <= acMax; L++) {
    let s = 0;
    for (let k = 0; k + L < frames; k++) s += onset[k] * onset[k + L];
    ac[L] = s / (frames - L);
  }

  // Reinforce with harmonics so a true beat beats its own subdivisions.
  let best = minLag;
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreN = 0;
  for (let L = minLag; L <= maxLag; L++) {
    let score = ac[L];
    if (2 * L <= acMax) score += 0.5 * ac[2 * L];
    if (3 * L <= acMax) score += 0.25 * ac[3 * L];
    scoreSum += score;
    scoreN++;
    if (score > bestScore) {
      bestScore = score;
      best = L;
    }
  }

  let bpm = (fps * 60) / best;
  while (bpm < 78) bpm *= 2;
  while (bpm > 156) bpm /= 2;

  const avg = scoreSum / Math.max(1, scoreN);
  const confidence = avg > 0 ? Math.max(0, Math.min(1, (bestScore / avg - 1) / 3)) : 0;

  // Beat phase: slide a pulse train at the final period across the onset curve.
  const period = (fps * 60) / bpm;
  let bestOffset = 0;
  let bestSum = -Infinity;
  const pulses = Math.floor(frames / period);
  for (let o = 0; o < Math.ceil(period); o++) {
    let s = 0;
    for (let m = 0; m < pulses; m++) {
      const idx = Math.round(o + m * period);
      if (idx < frames) s += onset[idx];
    }
    if (s > bestSum) {
      bestSum = s;
      bestOffset = o;
    }
  }

  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence,
    firstBeatSec: startSec + bestOffset / fps,
  };
}

/* -------------------------------------------------------------------- KEY --- */

// Krumhansl-Schmuckler key profiles.
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

interface KeyResult {
  pc: number;
  mode: KeyMode;
  confidence: number;
  /** Per-frame unit-length chroma, reused for structure analysis. */
  seq: Float32Array[];
  frameRate: number;
}

function analyseKey(x: Float32Array, sr: number): KeyResult {
  const N = 4096;
  const HOP = 2048;
  const chroma = new Array<number>(12).fill(0);
  const seq: Float32Array[] = [];

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const re = new Float32Array(N);
  const im = new Float32Array(N);

  const loBin = Math.max(1, Math.floor((55 * N) / sr));
  const hiBin = Math.min(N / 2 - 1, Math.ceil((2000 * N) / sr));

  const frames = Math.max(0, Math.floor((x.length - N) / HOP));
  const frameChroma = new Array<number>(12).fill(0);

  for (let f = 0; f < frames; f++) {
    const base = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = x[base + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);

    frameChroma.fill(0);
    let total = 0;
    for (let k = loBin; k <= hiBin; k++) {
      const mag = Math.hypot(re[k], im[k]);
      if (mag <= 0) continue;
      const freq = (k * sr) / N;
      const pc = ((Math.round(12 * Math.log2(freq / 440)) % 12) + 21) % 12; // A440 -> pc 9
      frameChroma[pc] += mag;
      total += mag;
    }

    // Normalize each frame before accumulating. Percussion is broadband and
    // loud, so summing raw magnitude lets kick/snare/hat frames smear energy
    // across all twelve classes and swamp the chords. Per-frame normalization
    // makes a drum hit contribute a roughly flat chroma (which the Pearson
    // correlation ignores) instead of drowning out the tonal frames.
    if (total < 1e-9) {
      seq.push(new Float32Array(12)); // keep the sequence time-aligned
      continue;
    }

    const unit = new Float32Array(12);
    let norm = 0;
    for (let p = 0; p < 12; p++) {
      const v = frameChroma[p] / total;
      unit[p] = v;
      norm += v * v;
      chroma[p] += v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let p = 0; p < 12; p++) unit[p] /= norm;
    seq.push(unit);
  }

  let bestPc = 0;
  let bestMode: KeyMode = 'major';
  let bestScore = -Infinity;
  let second = -Infinity;

  for (let t = 0; t < 12; t++) {
    const rotated = new Array<number>(12);
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(t + i) % 12];
    const maj = pearson(rotated, KS_MAJOR);
    const min = pearson(rotated, KS_MINOR);
    for (const [score, mode] of [
      [maj, 'major'] as const,
      [min, 'minor'] as const,
    ]) {
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        bestPc = t;
        bestMode = mode;
      } else if (score > second) {
        second = score;
      }
    }
  }

  const confidence = Math.max(0, Math.min(1, (bestScore - second) * 4));
  return { pc: bestPc, mode: bestMode, confidence, seq, frameRate: sr / HOP };
}

/* ------------------------------------------------------------------- HOOK --- */

/**
 * Find the most-repeated section — in practice, the chorus.
 *
 * No lyrics required: choruses repeat, and repetition is visible in the chroma
 * sequence as self-similarity at a fixed lag. We find the lag whose shifted
 * sequence matches best (the section period), then the window that matches best
 * at that lag (where the repeat lives). O(frames x lags), not a full matrix.
 */
function findHook(
  key: KeyResult,
  bpm: number,
  firstBeatSec: number,
  startSec: number
): { startSec: number; lengthSec: number } {
  const none = { startSec: 0, lengthSec: 0 };
  const { seq, frameRate } = key;
  const n = seq.length;
  if (n < 8 || bpm <= 0) return none;

  const barSec = (4 * 60) / bpm;
  const lagMin = Math.round(4 * barSec * frameRate);
  const lagMax = Math.round(32 * barSec * frameRate);
  if (lagMin < 2) return none;

  const dot = (a: Float32Array, b: Float32Array) => {
    let s = 0;
    for (let p = 0; p < 12; p++) s += a[p] * b[p];
    return s;
  };

  let bestLag = 0;
  let bestLagScore = -Infinity;
  for (let lag = lagMin; lag <= Math.min(lagMax, n - lagMin); lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += dot(seq[i], seq[i + lag]);
    s /= n - lag;
    if (s > bestLagScore) {
      bestLagScore = s;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return none;

  // Prefer an eight-bar hook, fall back to four when the track is short.
  let hookBars = 8;
  let win = Math.round(hookBars * barSec * frameRate);
  if (win + bestLag >= n) {
    hookBars = 4;
    win = Math.round(hookBars * barSec * frameRate);
  }
  if (win < 2 || win + bestLag >= n) return none;

  let bestStart = 0;
  let bestScore = -Infinity;
  for (let i = 0; i + win + bestLag < n; i++) {
    let s = 0;
    for (let w = 0; w < win; w++) s += dot(seq[i + w], seq[i + w + bestLag]);
    s /= win;
    if (s > bestScore) {
      bestScore = s;
      bestStart = i;
    }
  }

  // Snap to a downbeat so the loop lands musically.
  const raw = startSec + bestStart / frameRate;
  const bars = Math.round((raw - firstBeatSec) / barSec);
  const snapped = Math.max(0, firstBeatSec + bars * barSec);

  return { startSec: snapped, lengthSec: hookBars * barSec };
}

/* ------------------------------------------------------------------ main --- */

function analyse(mono: Float32Array, sampleRate: number): AnalysisResult {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_SR));
  const sr = sampleRate / factor;

  // Skip the first 5% (intros are often beatless) and cap the window.
  const startSample = Math.floor(mono.length * 0.05);
  const endSample = Math.min(mono.length, startSample + ANALYSIS_SECONDS * sampleRate);
  const slice = mono.subarray(startSample, endSample);
  const x = decimate(slice, factor);

  const startSec = startSample / sampleRate;
  const bpm = analyseBpm(x, sr, startSec);
  const key = analyseKey(x, sr);
  const hook = findHook(key, bpm.bpm, bpm.firstBeatSec, startSec);

  let sumSq = 0;
  for (let i = 0; i < x.length; i++) sumSq += x[i] * x[i];
  const rms = Math.sqrt(sumSq / Math.max(1, x.length));
  const loudnessDb = 20 * Math.log10(Math.max(rms, 1e-6));

  return {
    bpm: bpm.bpm,
    bpmConfidence: bpm.confidence,
    firstBeatSec: bpm.firstBeatSec,
    keyPc: key.pc,
    keyMode: key.mode,
    keyConfidence: key.confidence,
    keyName: keyNameOf(key.pc, key.mode),
    camelot: camelotOf(key.pc, key.mode),
    loudnessDb,
    hookStartSec: hook.startSec,
    hookLengthSec: hook.lengthSec,
  };
}

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { id, mono, sampleRate } = e.data;
  let response: AnalysisResponse;
  try {
    response = { id, ok: true, result: analyse(new Float32Array(mono), sampleRate) };
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
