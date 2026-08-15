import { engine } from '../audio/AudioEngine';
import { GROOVES, type DrumLayer } from '../audio/BeatMachine';
import { useEngineVersion } from '../hooks/useEngine';
import { Slider } from './Slider';

const LAYERS: Array<{ key: DrumLayer; label: string }> = [
  { key: 'kick', label: 'Kick' },
  { key: 'snare', label: 'Snare' },
  { key: 'hats', label: 'Hats' },
  { key: 'bass', label: '808' },
  { key: 'melody', label: 'Chords' },
];

/** DJ-mode view of the Phase 2 beat machine and performance FX. */
export function BeatMachinePanel() {
  useEngineVersion();
  const bm = engine.beatMachine;
  const fx = engine.fx;

  const hold = (press: () => void, release: () => void) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is an optimisation, not a requirement */
      }
      press();
    },
    onPointerUp: release,
    onPointerCancel: release,
  });

  return (
    <section className="panel p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="lbl">Beat machine</span>
        <span className="text-[10px] font-mono text-slate-500 ml-auto tabular-nums">
          {engine.transport.running ? `${engine.transport.bpm.toFixed(1)} bpm` : 'stopped'}
        </span>
      </div>

      <div className="flex gap-1">
        {GROOVES.map((g, i) => (
          <button
            key={g.name}
            onClick={() => bm.setGroove(i)}
            className={`btn flex-1 px-1 py-1 text-[10px] ${bm.grooveIndex === i ? 'btn-on' : ''}`}
          >
            {g.name}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1.5">
        {LAYERS.map((l) => (
          <button
            key={l.key}
            onClick={() => bm.toggleLayer(l.key)}
            className={`btn px-1 py-2 text-[11px] ${bm.layers[l.key] ? 'btn-on' : ''}`}
          >
            {l.label}
          </button>
        ))}
      </div>

      <Slider
        label="Beat level"
        value={bm.volume}
        min={0}
        max={1}
        step={0.01}
        display={`${Math.round(bm.volume * 100)}`}
        onChange={(v) => bm.setVolume(v)}
      />

      <div className="pt-1">
        <span className="lbl">FX</span>
        <div className="grid grid-cols-3 gap-1.5 mt-1">
          <button
            className={`btn px-1 py-2 text-[10px] ${fx.filterOn ? 'btn-on' : ''}`}
            {...hold(
              () => fx.setFilter(true),
              () => fx.setFilter(false)
            )}
          >
            Filter
          </button>
          <button
            className={`btn px-1 py-2 text-[10px] ${fx.echoOn ? 'btn-on' : ''}`}
            {...hold(
              () => fx.setEcho(true),
              () => fx.setEcho(false)
            )}
          >
            Echo
          </button>
          <button
            className={`btn px-1 py-2 text-[10px] ${fx.stutterOn ? 'btn-on' : ''}`}
            {...hold(
              () => fx.setStutter(true),
              () => fx.setStutter(false)
            )}
          >
            Stutter
          </button>
          <button className="btn px-1 py-2 text-[10px]" onClick={() => fx.horn()}>
            Horn
          </button>
          <button className="btn px-1 py-2 text-[10px]" onClick={() => fx.build()}>
            Build
          </button>
          <button className="btn px-1 py-2 text-[10px]" onClick={() => fx.drop()}>
            Drop
          </button>
        </div>
      </div>
    </section>
  );
}
