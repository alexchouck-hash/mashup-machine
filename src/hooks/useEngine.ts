import { useSyncExternalStore } from 'react';
import { engine } from '../audio/AudioEngine';

/**
 * The engine is the source of truth; React mirrors it. Components call this to
 * re-render when discrete engine state changes (loaded, playing, cues, faders).
 *
 * Playhead position deliberately does NOT flow through here — it moves at 30 Hz
 * and is read straight off the deck inside the canvas rAF loop.
 */
export function useEngineVersion(): number {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
}
