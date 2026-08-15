export type KeyMode = 'major' | 'minor';

/** Everything the analysis worker returns for one loaded track. */
export interface AnalysisResult {
  bpm: number;
  bpmConfidence: number; // 0..1
  /** Seconds from file start to the first detected beat — the beat grid anchor. */
  firstBeatSec: number;
  keyPc: number; // 0..11, C = 0
  keyMode: KeyMode;
  keyConfidence: number; // 0..1
  keyName: string; // "A minor"
  camelot: string; // "8A"
  /** Integrated RMS in dBFS. Drives the auto-gain assist. */
  loudnessDb: number;
  /** Start of the most-repeated section — the hook. Seconds from file start. */
  hookStartSec: number;
  /** Length of the hook loop, snapped to whole bars. 0 if none was found. */
  hookLengthSec: number;
}

/**
 * What part of a track to play.
 *  both   - untouched stereo
 *  music  - centre cancelled, so centred vocals largely disappear
 *  vocals - centre isolated and band-limited, a rough acapella
 */
export type VocalMode = 'both' | 'music' | 'vocals';

export interface AnalysisRequest {
  id: string;
  sampleRate: number;
  mono: ArrayBuffer; // transferred Float32 mono downmix
}

export type AnalysisResponse =
  | { id: string; ok: true; result: AnalysisResult }
  | { id: string; ok: false; error: string };

/** Min/max envelope for waveform drawing, at a fixed buckets-per-second rate. */
export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  bucketsPerSecond: number;
}

export interface AssistSettings {
  /** Launch and cue-jump snap to the other deck's beat grid. */
  beatLock: boolean;
  /** Sync aligns downbeats, not just tempo. */
  phaseAlign: boolean;
  /** Match perceived loudness across decks from analysis. */
  autoGain: boolean;
  /** Duck the outgoing deck's low band across the crossfader. */
  bassSwap: boolean;
  /** Nudge pitch toward a compatible Camelot key. */
  harmonicNudge: boolean;
}

export const DEFAULT_ASSIST: AssistSettings = {
  beatLock: true,
  phaseAlign: true,
  autoGain: true,
  bassSwap: true,
  harmonicNudge: true,
};
