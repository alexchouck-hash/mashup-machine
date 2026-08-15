import { engine } from '../audio/AudioEngine';
import { useEngineVersion } from '../hooks/useEngine';
import type { AssistSettings } from '../audio/types';

const ITEMS: Array<{ key: keyof AssistSettings; name: string; blurb: string }> = [
  { key: 'beatLock', name: 'Beat lock', blurb: 'Play and cue snap onto the other deck’s grid — you cannot come in off-beat.' },
  { key: 'phaseAlign', name: 'Phase align', blurb: 'Sync lines up downbeats, not just tempos.' },
  { key: 'autoGain', name: 'Auto gain', blurb: 'Matches loudness so neither track buries the other.' },
  { key: 'bassSwap', name: 'Bass swap', blurb: 'Ducks the outgoing deck’s low end so two kicks never fight.' },
  { key: 'harmonicNudge', name: 'Harmonic nudge', blurb: 'Shifts deck B up to 2 semitones toward a key that fits deck A.' },
];

/**
 * The "sounds good even when a child does it" layer. Each of these removes one
 * specific way a live mashup goes wrong; all default on, all defeatable so the
 * manual DJ path in the spec still works.
 */
export function AssistPanel() {
  useEngineVersion();
  return (
    <section className="panel p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="lbl">Smart assist</span>
        <span className="text-[10px] text-slate-500">tap to toggle</span>
      </div>
      <div className="space-y-1.5">
        {ITEMS.map((it) => {
          const on = engine.assist[it.key];
          return (
            <button
              key={it.key}
              onClick={() => engine.setAssist(it.key, !on)}
              className={`w-full text-left px-2.5 py-2 rounded-lg border transition ${
                on
                  ? 'border-emerald-500/40 bg-emerald-500/10'
                  : 'border-edge bg-panel2 opacity-60'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${on ? 'bg-emerald-400' : 'bg-slate-600'}`}
                />
                <span className="text-xs font-semibold">{it.name}</span>
              </div>
              <p className="text-[10px] leading-snug text-slate-400 mt-0.5">{it.blurb}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
