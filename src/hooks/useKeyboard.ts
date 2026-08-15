import { useEffect } from 'react';
import { engine } from '../audio/AudioEngine';
import type { CueIndex } from '../audio/Deck';

const CUE_KEYS_A = ['q', 'w', 'e', 'r'];
const CUE_KEYS_B = ['u', 'i', 'o', 'p'];
const NUDGE = 0.25;

/**
 * Spec shortcuts. Ignored while a control has focus so arrow keys still move
 * the slider you are actually holding.
 */
export function useKeyboard(enabled: boolean, focusedDeck: number): void {
  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      const [a, b] = engine.decks;
      const k = e.key.toLowerCase();

      if (e.code === 'Space') {
        e.preventDefault();
        engine.decks[focusedDeck]?.togglePlay();
        return;
      }

      const ia = CUE_KEYS_A.indexOf(k);
      if (ia >= 0 && a) {
        e.preventDefault();
        if (e.shiftKey) a.clearCue(ia as CueIndex);
        else a.jumpCue(ia as CueIndex);
        return;
      }

      const ib = CUE_KEYS_B.indexOf(k);
      if (ib >= 0 && b) {
        e.preventDefault();
        if (e.shiftKey) b.clearCue(ib as CueIndex);
        else b.jumpCue(ib as CueIndex);
        return;
      }

      switch (k) {
        case 'z':
          a?.nudgeTempo(-NUDGE);
          break;
        case 'x':
          a?.nudgeTempo(NUDGE);
          break;
        case 'n':
          b?.nudgeTempo(-NUDGE);
          break;
        case 'm':
          b?.nudgeTempo(NUDGE);
          break;
        case 'arrowleft':
          e.preventDefault();
          engine.setCrossfade(engine.crossfade - 0.02);
          break;
        case 'arrowright':
          e.preventDefault();
          engine.setCrossfade(engine.crossfade + 0.02);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, focusedDeck]);
}
