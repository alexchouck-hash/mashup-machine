import { useEffect, useRef } from 'react';
import { engine } from '../audio/AudioEngine';
import { useEngineVersion } from '../hooks/useEngine';
import { Slider } from './Slider';

/** Master level meter. Driven by rAF off the AnalyserNode, never React state. */
function LevelMeter() {
  const peakRef = useRef<HTMLDivElement>(null);
  const rmsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let held = 0;
    const loop = () => {
      const { peak, rms } = engine.masterLevel();
      held = Math.max(peak, held * 0.94);
      if (peakRef.current) {
        peakRef.current.style.width = `${Math.min(100, held * 100)}%`;
        peakRef.current.style.background = held > 0.98 ? '#ef4444' : held > 0.85 ? '#f59e0b' : '#38bdf8';
      }
      if (rmsRef.current) rmsRef.current.style.width = `${Math.min(100, rms * 140)}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="space-y-1">
      <span className="lbl">Master level</span>
      <div className="h-2 rounded-full bg-panel2 overflow-hidden">
        <div ref={peakRef} className="h-full w-0 transition-[width] duration-75" />
      </div>
      <div className="h-1 rounded-full bg-panel2 overflow-hidden">
        <div ref={rmsRef} className="h-full w-0 bg-slate-500 transition-[width] duration-75" />
      </div>
    </div>
  );
}

export function Mixer() {
  useEngineVersion();
  const a = engine.decks[0];
  const b = engine.decks[1];

  return (
    <section className="panel p-3 space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="lbl" style={{ color: '#22d3ee' }}>
            A
          </span>
          <span className="lbl">Crossfader</span>
          <span className="lbl" style={{ color: '#f472b6' }}>
            B
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={engine.crossfade}
          onChange={(e) => engine.setCrossfade(parseFloat(e.target.value))}
          onDoubleClick={() => engine.setCrossfade(0.5)}
        />
        <div className="flex justify-between text-[10px] font-mono text-slate-500">
          <span>{a ? `${Math.round(Math.cos((engine.crossfade * Math.PI) / 2) * 100)}%` : ''}</span>
          <span>{b ? `${Math.round(Math.sin((engine.crossfade * Math.PI) / 2) * 100)}%` : ''}</span>
        </div>
      </div>

      <Slider
        label="Master"
        value={engine.masterVolume}
        min={0}
        max={1}
        step={0.01}
        display={`${Math.round(engine.masterVolume * 100)}`}
        onChange={(v) => engine.setMasterVolume(v)}
      />

      <LevelMeter />
    </section>
  );
}
