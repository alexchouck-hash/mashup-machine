import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/AudioEngine';
import type { Deck } from '../audio/Deck';
import { GROOVES, type DrumLayer } from '../audio/BeatMachine';
import { JAMS, prewarmJams, renderJam, type JamSpec } from '../audio/jamFactory';
import { downloadBlob, recordingFilename } from '../audio/wav';
import { useEngineVersion } from '../hooks/useEngine';
import { Turntable } from './Turntable';

/**
 * Party Mode — the surface a child actually uses.
 *
 * Design rules, all deliberate:
 *  - Fun in one tap. Built-in jams mean the app is never silent waiting for
 *    someone to supply a file, which a child cannot do.
 *  - No numbers anywhere. No BPM, no dB, no Camelot, no percentages.
 *  - The whole song tile is the play button, because it is the biggest target
 *    on screen and a seven-year-old aims badly.
 *  - It moves. The visualizer and the beat pulses make it obvious that the
 *    song and the drums are locked together.
 *  - Every assist is forced on. There is no way to make it sound wrong.
 */

const COLORS = ['#22d3ee', '#f472b6'];

/* ------------------------------------------------------------- visualizer */

function Visualizer() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    let bins = new Uint8Array(Math.max(32, engine.spectrumBins));

    const loop = () => {
      const c = ref.current;
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(c.clientWidth * dpr));
        const h = Math.max(1, Math.floor(c.clientHeight * dpr));
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        const g = c.getContext('2d');
        if (g) {
          if (bins.length !== engine.spectrumBins && engine.spectrumBins > 0) {
            bins = new Uint8Array(engine.spectrumBins);
          }
          engine.masterFrequencies(bins);

          g.clearRect(0, 0, w, h);
          const BARS = 44;
          // Most musical energy sits low; skip the top of the spectrum and
          // space bars roughly logarithmically so bass does not hog the width.
          const usable = Math.floor(bins.length * 0.5);
          const bw = w / BARS;

          for (let i = 0; i < BARS; i++) {
            const t0 = Math.floor(Math.pow(i / BARS, 1.7) * usable);
            const t1 = Math.max(t0 + 1, Math.floor(Math.pow((i + 1) / BARS, 1.7) * usable));
            let m = 0;
            for (let k = t0; k < t1 && k < bins.length; k++) if (bins[k] > m) m = bins[k];
            const v = m / 255;

            const bh = Math.max(3 * dpr, v * h * 0.94);
            const x = i * bw + bw * 0.16;
            const y = (h - bh) / 2;
            const ww = bw * 0.68;
            const hue = 188 + (i / BARS) * 145; // cyan -> pink, matching the decks
            g.fillStyle = `hsl(${hue} 88% ${44 + v * 22}%)`;
            if (typeof g.roundRect === 'function') {
              g.beginPath();
              g.roundRect(x, y, ww, bh, Math.min(ww / 2, bh / 2));
              g.fill();
            } else {
              g.fillRect(x, y, ww, bh);
            }
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="w-full h-16 sm:h-20 block" />;
}

/* ------------------------------------------------------------------- pads */

interface PadProps {
  emoji: string;
  label: string;
  color: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  onRelease?: () => void;
}

function BigPad({ emoji, label, color, active, disabled, onPress, onRelease }: PadProps) {
  return (
    <button
      disabled={disabled}
      onPointerDown={(e) => {
        // Capture so a finger sliding off still delivers the release. Guarded:
        // an invalid pointer id throws, and that must not swallow the press.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* capture is an optimisation, not a requirement */
        }
        onPress();
      }}
      onPointerUp={() => onRelease?.()}
      onPointerCancel={() => onRelease?.()}
      className="rounded-2xl border-2 font-black uppercase tracking-wide transition-transform
                 active:scale-95 disabled:opacity-30 disabled:pointer-events-none
                 flex flex-col items-center justify-center gap-0.5 py-2.5 sm:py-3
                 select-none touch-none"
      style={{
        borderColor: active ? color : '#2a3244',
        background: active ? `${color}26` : '#161b27',
        color: active ? color : '#94a3b8',
        boxShadow: active ? `0 0 22px ${color}55` : 'none',
      }}
    >
      <span className="text-xl sm:text-2xl leading-none">{emoji}</span>
      <span className="text-[9px] sm:text-[11px] leading-tight">{label}</span>
    </button>
  );
}

/* -------------------------------------------------------------- song tile */

function SongTile({ deck, color }: { deck: Deck; color: string }) {
  useEngineVersion();
  const fileRef = useRef<HTMLInputElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Beat pulse, driven straight off the deck's grid — no React renders.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = tileRef.current;
      if (el) {
        const phase = deck.playing ? deck.beatPhaseNow() : null;
        const pop = phase == null ? 0 : Math.pow(1 - phase, 4);
        el.style.transform = `scale(${1 + pop * 0.03})`;
        el.style.boxShadow = deck.playing ? `0 0 ${16 + pop * 40}px ${color}55` : 'none';
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [deck, color]);

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void deck.load(f).catch(() => undefined);
  };

  const chooseJam = async (spec: JamSpec) => {
    setRendering(spec.id);
    setFailed(false);
    try {
      const buf = await renderJam(spec, engine.ctx.sampleRate);
      await deck.loadBuffer(buf, `${spec.emoji} ${spec.name}`, {
        loop: true,
        // We authored this jam, so its tempo, key and downbeat are facts, not
        // estimates. The first beat is exactly at zero by construction.
        known: { bpm: spec.bpm, keyPc: spec.keyPc, keyMode: spec.mode, firstBeatSec: 0 },
      });
      deck.play(); // one tap to music: load it and start it
    } catch (err) {
      // Never swallow this: a silent failure here looks like a dead button.
      console.error('[jam] could not build', spec.id, err);
      setFailed(true);
    } finally {
      setRendering(null);
    }
  };

  const busy = deck.loading || deck.analyzing || rendering !== null;

  return (
    <div
      ref={tileRef}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        pick(e.dataTransfer.files);
      }}
      className="rounded-3xl border-2 overflow-hidden flex flex-col min-h-0"
      style={{ borderColor: deck.playing ? color : '#2a3244', background: '#12161f' }}
    >
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => pick(e.target.files)}
      />

      {!deck.loaded ? (
        <div className="flex-1 p-2 sm:p-3 flex flex-col">
          <div className="text-[10px] uppercase font-black tracking-wider text-slate-500 mb-1.5 text-center">
            {busy ? 'Making it…' : failed ? 'Hmm — try again' : 'Pick a jam'}
          </div>
          <div className="grid grid-cols-2 gap-1.5 flex-1">
            {JAMS.map((j) => (
              <button
                key={j.id}
                disabled={busy}
                onClick={() => void chooseJam(j)}
                className="rounded-xl border-2 border-edge bg-[#161b27] flex flex-col items-center
                           justify-center gap-0.5 py-2 transition active:scale-95
                           disabled:opacity-40 disabled:pointer-events-none"
                style={rendering === j.id ? { borderColor: j.color, background: `${j.color}22` } : undefined}
              >
                <span className="text-xl sm:text-2xl leading-none">
                  {rendering === j.id ? '⏳' : j.emoji}
                </span>
                <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-wide text-slate-400">
                  {j.name}
                </span>
              </button>
            ))}
          </div>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="mt-1.5 text-[10px] uppercase font-black tracking-wider text-slate-500
                       hover:text-slate-300 py-1.5 disabled:opacity-40"
          >
            ＋ Use my own song
          </button>
        </div>
      ) : (
        <>
          {/* The platter is the play surface. Turntable swallows the click that
              ends a grab, so a scratch never also toggles playback. */}
          <button
            onClick={() => deck.togglePlay()}
            className="flex-1 w-full flex flex-col items-center justify-center gap-1 py-2 sm:py-3 px-3 transition"
          >
            <Turntable
              deck={deck}
              color={color}
              onScratchStart={(e) => {
                for (const d of engine.scratchGroup(e.deck)) d.scratchStart();
              }}
              onScratchMove={(e) => {
                for (const d of engine.scratchGroup(e.deck)) {
                  // The grabbed deck follows the finger's absolute position; a
                  // linked partner follows only its SPEED, since its own
                  // playhead is somewhere else entirely in a different track.
                  if (d === e.deck) d.scratchMove(e.positionSec, e.rate);
                  else d.scratchRate(e.rate);
                }
              }}
              onScratchEnd={(e) => {
                for (const d of engine.scratchGroup(e.deck)) {
                  d.scratchEnd(d === e.deck ? e.wasPlaying : undefined);
                }
              }}
            />
            <span
              className="font-black uppercase tracking-wide text-[11px] sm:text-xs"
              style={{ color: deck.playing ? color : '#94a3b8' }}
            >
              {deck.playing ? 'Playing — spin me' : 'Tap to play'}
            </span>
          </button>
          <div className="px-2 pb-1.5 grid grid-cols-4 gap-1">
            {(
              [
                ['both', '🎵', 'All'],
                ['music', '🎸', 'No vox'],
                ['vocals', '🎤', 'Vox'],
              ] as const
            ).map(([m, icon, label]) => (
              <button
                key={m}
                onClick={() => deck.setVocalMode(m)}
                disabled={m === 'music' && !deck.canRemoveVocals}
                title={
                  m === 'music' && !deck.canRemoveVocals
                    ? 'This track is mono, so there is no centre to cancel'
                    : undefined
                }
                className={`rounded-lg border py-1.5 flex flex-col items-center leading-none gap-0.5 transition
                            disabled:opacity-30 disabled:pointer-events-none ${
                              deck.vocalMode === m
                                ? 'border-slate-100 bg-slate-100 text-slate-900'
                                : 'border-edge bg-panel2 text-slate-400'
                            }`}
              >
                <span className="text-sm">{icon}</span>
                <span className="text-[8px] font-black uppercase tracking-wide">{label}</span>
              </button>
            ))}
            <button
              disabled={!deck.analysis || deck.analysis.hookLengthSec <= 0}
              onClick={() => deck.playHook()}
              title="Loop the catchiest repeated bit"
              className={`rounded-lg border py-1.5 flex flex-col items-center leading-none gap-0.5 transition
                          disabled:opacity-30 disabled:pointer-events-none ${
                            deck.loopStartSec != null
                              ? 'border-lime-400 bg-lime-400/20 text-lime-300'
                              : 'border-edge bg-panel2 text-slate-400'
                          }`}
            >
              <span className="text-sm">🔁</span>
              <span className="text-[8px] font-black uppercase tracking-wide">Hook</span>
            </button>
          </div>
          <div className="px-3 pb-2.5 flex items-center gap-2">
            <span className="truncate text-[11px] text-slate-400 flex-1">
              {busy ? 'Getting ready…' : deck.fileName.replace(/\.[^.]+$/, '')}
            </span>
            <button
              onClick={() => deck.unload()}
              className="text-[10px] uppercase font-black tracking-wide text-slate-500 hover:text-slate-300 px-1.5 py-1"
            >
              Swap
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- main */

const LAYERS: Array<{ key: DrumLayer; emoji: string; label: string }> = [
  { key: 'kick', emoji: '💥', label: 'Boom' },
  { key: 'snare', emoji: '👏', label: 'Clap' },
  { key: 'hats', emoji: '✨', label: 'Tss' },
  { key: 'bass', emoji: '🔊', label: 'Bass' },
  { key: 'melody', emoji: '🎹', label: 'Tune' },
];

export function KidsMode({ onExit }: { onExit: () => void }) {
  useEngineVersion();
  const bm = engine.beatMachine;
  const fx = engine.fx;
  const macros = engine.macros;
  const [a, b] = engine.decks;
  const stepRef = useRef<HTMLDivElement>(null);

  // Render the jams while the picker is on screen, so tapping one is instant.
  useEffect(() => {
    void prewarmJams(engine.ctx.sampleRate);
  }, []);

  // Four dots showing the bar position, so the beat is visible even in silence.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = stepRef.current;
      if (el) {
        const step = engine.transport.running ? engine.transport.currentStep() : -1;
        const beat = step < 0 ? -1 : Math.floor(step / 4);
        for (let i = 0; i < el.children.length; i++) {
          const dot = el.children[i] as HTMLElement;
          const on = i === beat;
          dot.style.opacity = on ? '1' : '0.25';
          dot.style.transform = `scale(${on ? 1.35 : 1})`;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toggleRecord = () => {
    if (engine.recording) {
      const blob = engine.stopRecording();
      if (blob) downloadBlob(blob, recordingFilename());
    } else {
      engine.startRecording();
    }
  };

  return (
    <div className="min-h-full flex flex-col gap-2 sm:gap-3 p-2 sm:p-3 max-w-5xl mx-auto">
      <header className="flex items-center gap-2">
        <h1 className="text-base sm:text-xl font-black tracking-tight whitespace-nowrap">
          🎉 <span className="hidden sm:inline">Party Mode</span>
        </h1>
        <div ref={stepRef} className="flex gap-1.5 ml-1">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="w-2.5 h-2.5 rounded-full bg-white transition-transform" />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={toggleRecord}
            className={`rounded-xl px-3 sm:px-4 py-2.5 font-black uppercase text-[11px] tracking-wide border-2 transition ${
              engine.recording
                ? 'bg-red-500 border-red-500 text-white'
                : 'border-edge bg-panel2 text-slate-300'
            }`}
          >
            {engine.recording ? '■ Save' : '● Rec'}
          </button>
          <button
            onClick={onExit}
            className="rounded-xl px-2.5 py-2.5 text-[10px] uppercase font-black tracking-wide
                       border border-edge bg-panel2 text-slate-500 hover:text-slate-300"
          >
            DJ
          </button>
        </div>
      </header>

      <div className="panel overflow-hidden">
        <Visualizer />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        {a && <SongTile deck={a} color={COLORS[0]} />}
        {b && <SongTile deck={b} color={COLORS[1]} />}
      </div>

      {/* mix */}
      <div className="panel px-3 sm:px-4 py-2.5">
        <div className="flex items-center justify-between mb-1 text-[11px] font-black uppercase tracking-wide">
          <span style={{ color: COLORS[0] }}>Song 1</span>
          <span className="text-slate-500 text-[10px]">Mix</span>
          <span style={{ color: COLORS[1] }}>Song 2</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={engine.crossfade}
          onChange={(e) => engine.setCrossfade(parseFloat(e.target.value))}
          onDoubleClick={() => engine.setCrossfade(0.5)}
          className="kid-slider"
        />
      </div>

      {/* beats */}
      <div className="panel p-2.5 sm:p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="lbl">Beats</span>
          <div className="ml-auto flex gap-1">
            {GROOVES.map((g, i) => (
              <button
                key={g.name}
                onClick={() => bm.setGroove(i)}
                className={`px-2 sm:px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide border transition ${
                  bm.grooveIndex === i
                    ? 'bg-slate-100 text-slate-900 border-slate-100'
                    : 'border-edge bg-panel2 text-slate-400'
                }`}
              >
                {g.name}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
          {LAYERS.map((l) => (
            <BigPad
              key={l.key}
              emoji={l.emoji}
              label={l.label}
              color="#a3e635"
              active={bm.layers[l.key]}
              onPress={() => bm.toggleLayer(l.key)}
            />
          ))}
        </div>
      </div>

      {/* fx */}
      <div className="panel p-2.5 sm:p-3 space-y-2">
        <span className="lbl">Magic buttons</span>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 sm:gap-2">
          <BigPad
            emoji="🌊"
            label="Swoosh"
            color="#38bdf8"
            active={fx.filterOn}
            onPress={() => fx.setFilter(true)}
            onRelease={() => fx.setFilter(false)}
          />
          <BigPad
            emoji="🔁"
            label="Echo"
            color="#818cf8"
            active={fx.echoOn}
            onPress={() => fx.setEcho(true)}
            onRelease={() => fx.setEcho(false)}
          />
          <BigPad
            emoji="⚡"
            label="Stutter"
            color="#facc15"
            active={fx.stutterOn}
            onPress={() => fx.setStutter(true)}
            onRelease={() => fx.setStutter(false)}
          />
          <BigPad emoji="📣" label="Horn" color="#fb923c" onPress={() => fx.horn()} />
          <BigPad emoji="🚀" label="Build" color="#f472b6" onPress={() => fx.build()} />
          <BigPad emoji="💥" label="Big drop" color="#ef4444" onPress={() => macros.bigDrop()} />
        </div>
      </div>

      {/* auto-mix and the link toggle */}
      <div className="panel p-2.5 sm:p-3 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="lbl">Do it for me</span>
          {macros.lastNote && (
            <span className="text-[10px] text-slate-400 truncate ml-2">{macros.lastNote}</span>
          )}
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5 sm:gap-2">
          <BigPad
            emoji="🎤"
            label="1 over 2"
            color="#22d3ee"
            active={macros.mixActive === 'AB'}
            onPress={() => macros.autoMixAOverB()}
          />
          <BigPad
            emoji="🎤"
            label="2 over 1"
            color="#f472b6"
            active={macros.mixActive === 'BA'}
            onPress={() => macros.autoMixBOverA()}
          />
          <BigPad
            emoji="🥁"
            label="Bridge"
            color="#a3e635"
            disabled={macros.busy}
            onPress={() => macros.bridge()}
          />
          <BigPad
            emoji="🔊"
            label="Bump"
            color="#facc15"
            active={macros.bumpOn}
            onPress={() => macros.toggleBump()}
          />
          <BigPad
            emoji="🔗"
            label="Sync"
            color="#c084fc"
            active={engine.linkDecks}
            onPress={() => engine.setLink(!engine.linkDecks)}
          />
        </div>
      </div>
    </div>
  );
}
