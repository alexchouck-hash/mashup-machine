import type { KeyMode } from './types';

const PC_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// Camelot wheel number for each pitch class, indexed by pitch class (C = 0).
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const MINOR_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

export function camelotOf(pc: number, mode: KeyMode): string {
  const n = mode === 'major' ? MAJOR_CAMELOT[pc % 12] : MINOR_CAMELOT[pc % 12];
  return `${n}${mode === 'major' ? 'B' : 'A'}`;
}

export function keyNameOf(pc: number, mode: KeyMode): string {
  return `${PC_NAMES[pc % 12]} ${mode}`;
}

export type Compatibility = 'perfect' | 'compatible' | 'clash';

/**
 * Harmonic-mixing rules on the Camelot wheel: identical is perfect; +/-1 on the
 * same letter (adjacent) or the same number on the other letter (relative
 * major/minor) is compatible; anything else clashes.
 */
export function compatibility(a: string, b: string): Compatibility {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return 'clash';
  if (pa.n === pb.n && pa.letter === pb.letter) return 'perfect';
  if (pa.n === pb.n) return 'compatible'; // relative major/minor
  if (pa.letter === pb.letter) {
    const d = Math.abs(pa.n - pb.n);
    if (d === 1 || d === 11) return 'compatible'; // wheel wraps 12 -> 1
  }
  return 'clash';
}

function parseCamelot(s: string): { n: number; letter: string } | null {
  const m = /^(\d{1,2})([AB])$/.exec(s);
  if (!m) return null;
  return { n: parseInt(m[1], 10), letter: m[2] };
}

/**
 * Smallest pitch shift (in semitones) applied to `moving` that lands it in a
 * compatible key with `anchor`. Returns 0 if already compatible, or null if no
 * shift within +/-2 semitones works — beyond that the artefacts cost more than
 * the clash does.
 */
export function harmonicNudgeSemitones(
  anchor: { pc: number; mode: KeyMode },
  moving: { pc: number; mode: KeyMode }
): number | null {
  const target = camelotOf(anchor.pc, anchor.mode);
  const order = [0, -1, 1, -2, 2];
  for (const s of order) {
    const shifted = ((((moving.pc + s) % 12) + 12) % 12);
    if (compatibility(target, camelotOf(shifted, moving.mode)) !== 'clash') return s;
  }
  return null;
}

/** Frequency ratio for a shift in semitones. */
export function semitonesToRatio(s: number): number {
  return Math.pow(2, s / 12);
}
