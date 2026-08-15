import { useRef, useState } from 'react';
import type { Deck, CueIndex } from '../audio/Deck';
import { engine } from '../audio/AudioEngine';
import { useEngineVersion } from '../hooks/useEngine';
import { compatibility } from '../audio/camelot';
import { Waveform } from './Waveform';
import { Slider } from './Slider';

interface Props {
  deck: Deck;
  color: string;
  focused: boolean;
  onFocus: () => void;
  cueKeys: string[];
}

function mmss(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const LONG_PRESS_MS = 600;

/**
 * Tap to set when empty, tap to jump when set, shift-tap OR long-press to clear.
 * Long-press matters because shift-tap does not exist on a touch screen, which
 * is where this ends up (Phase 4 wraps for iPad).
 */
function CueButton({ deck, index, hint }: { deck: Deck; index: CueIndex; hint: string }) {
  const timer = useRef<number | null>(null);
  const cleared = useRef(false);
  const isSet = deck.cues[index] != null;

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  return (
    <button
      className={`btn px-1 py-2 text-xs ${isSet ? 'btn-on' : ''}`}
      disabled={!deck.loaded}
      title={isSet ? 'Tap to jump · shift-tap or hold to clear' : 'Tap to set'}
      onPointerDown={() => {
        cleared.current = false;
        cancel();
        timer.current = window.setTimeout(() => {
          cleared.current = true;
          deck.clearCue(index);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onClick={(e) => {
        if (cleared.current) {
          cleared.current = false;
          return; // the long-press already handled this press
        }
        if (e.shiftKey) deck.clearCue(index);
        else deck.jumpCue(index);
      }}
    >
      <span className="block leading-tight">{isSet ? `Cue ${index + 1}` : `Set ${index + 1}`}</span>
      <span className="block text-[9px] opacity-50 uppercase">{hint}</span>
    </button>
  );
}

export function DeckPanel({ deck, color, focused, onFocus, cueKeys }: Props) {
  useEngineVersion();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const partner = engine.partnerOf(deck);
  const a = deck.analysis;

  const myCamelot = deck.effectiveCamelot;
  const theirCamelot = partner?.effectiveCamelot ?? null;
  const compat = myCamelot && theirCamelot ? compatibility(myCamelot, theirCamelot) : null;

  const openFile = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void deck.load(f).catch(() => undefined);
  };

  const assistBits: string[] = [];
  if (deck.autoGainApplied !== 0) assistBits.push(`GAIN ${deck.autoGainApplied > 0 ? '+' : ''}${deck.autoGainApplied.toFixed(1)}dB`);
  if (deck.assistLowApplied < -0.5) assistBits.push(`BASS ${deck.assistLowApplied.toFixed(0)}dB`);
  if (deck.nudgeSemitones !== 0) assistBits.push(`KEY ${deck.nudgeSemitones > 0 ? '+' : ''}${deck.nudgeSemitones}st`);

  return (
    <section
      onPointerDown={onFocus}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        openFile(e.dataTransfer.files);
      }}
      className={`panel p-3 space-y-3 transition ${
        dragging ? 'ring-2 ring-white/60' : focused ? 'ring-1 ring-white/25' : ''
      }`}
    >
      {/* header */}
      <div className="flex items-center gap-2">
        <span
          className="w-7 h-7 grid place-items-center rounded-md font-bold text-slate-900 text-sm"
          style={{ background: color }}
        >
          {deck.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {deck.fileName || <span className="text-slate-500">Drop a track, or Load…</span>}
          </div>
          <div className="text-[11px] font-mono text-slate-500 tabular-nums">
            {mmss(deck.positionSec)} / {mmss(deck.durationSec)}
          </div>
        </div>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Load
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => openFile(e.target.files)}
        />
      </div>

      {/* analysis readout */}
      <div className="flex items-center gap-2 text-[11px] font-mono flex-wrap">
        {deck.loading && <span className="text-slate-400">decoding…</span>}
        {deck.analyzing && <span className="text-slate-400">analysing…</span>}
        {a && (
          <>
            <span className="px-1.5 py-0.5 rounded bg-panel2 border border-edge tabular-nums">
              {deck.effectiveBpm.toFixed(1)} BPM
            </span>
            <span className="text-slate-500 tabular-nums">({a.bpm.toFixed(1)} orig)</span>
            <span className="px-1.5 py-0.5 rounded bg-panel2 border border-edge">
              {myCamelot} · {deck.effectiveKeyName}
            </span>
            {compat && (
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  compat === 'clash'
                    ? 'border-amber-500/50 text-amber-400 bg-amber-500/10'
                    : 'border-emerald-500/50 text-emerald-400 bg-emerald-500/10'
                }`}
              >
                {compat === 'perfect' ? 'key match' : compat === 'compatible' ? 'key ok' : 'key clash'}
              </span>
            )}
          </>
        )}
        {assistBits.length > 0 && (
          <span className="text-slate-500">assist: {assistBits.join(' · ')}</span>
        )}
      </div>

      <Waveform deck={deck} color={color} />

      {/* transport */}
      <div className="flex gap-2">
        <button
          className={`btn flex-1 ${deck.playing ? 'btn-on' : ''}`}
          disabled={!deck.loaded}
          onClick={() => deck.togglePlay()}
        >
          {deck.playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn" disabled={!deck.loaded || !partner?.analysis} onClick={() => deck.sync()}>
          Sync
        </button>
        <button className="btn" disabled={!deck.loaded} onClick={() => deck.seekSeconds(0, false)}>
          ⏮
        </button>
      </div>

      {/* vocal isolation + hook loop */}
      <div className="grid grid-cols-4 gap-2">
        {(
          [
            ['both', 'All'],
            ['music', 'No vox'],
            ['vocals', 'Vox'],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            className={`btn px-1 py-1.5 text-[11px] ${deck.vocalMode === m ? 'btn-on' : ''}`}
            disabled={!deck.loaded || (m === 'music' && !deck.canRemoveVocals)}
            title={
              m === 'music'
                ? deck.loaded && !deck.canRemoveVocals
                  ? 'Unavailable: this track is effectively mono, so cancelling the centre would leave silence'
                  : 'Cancel centre-panned content — removes most lead vocals, and centred kick/bass with them'
                : m === 'vocals'
                  ? 'Isolate centre-panned content, band-limited — a rough acapella'
                  : 'Play the track untouched'
            }
            onClick={() => deck.setVocalMode(m)}
          >
            {label}
          </button>
        ))}
        <button
          className={`btn px-1 py-1.5 text-[11px] ${deck.loopStartSec != null ? 'btn-on' : ''}`}
          disabled={!deck.loaded || !deck.analysis || deck.analysis.hookLengthSec <= 0}
          title="Loop the most-repeated section"
          onClick={() => {
            if (deck.loopStartSec != null) {
              deck.setLoopRegion(null, null);
              deck.setLoop(false);
            } else {
              deck.playHook();
            }
          }}
        >
          {deck.loopStartSec != null ? '◼ Loop' : '🔁 Hook'}
        </button>
      </div>

      {/* hot cues */}
      <div className="grid grid-cols-4 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <CueButton key={i} deck={deck} index={i as CueIndex} hint={cueKeys[i]} />
        ))}
      </div>

      {/* tempo */}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Slider
            label="Tempo"
            value={deck.tempoPercent}
            min={-deck.tempoRange}
            max={deck.tempoRange}
            step={0.01}
            color={color}
            disabled={!deck.loaded}
            resetTo={0}
            display={`${deck.tempoPercent >= 0 ? '+' : ''}${deck.tempoPercent.toFixed(2)}%`}
            onChange={(v) => deck.setTempoPercent(v)}
          />
        </div>
        <button
          className="btn px-2 py-1 text-[11px]"
          onClick={() => deck.setTempoRange(deck.tempoRange === 8 ? 16 : 8)}
        >
          ±{deck.tempoRange}%
        </button>
      </div>

      {/* eq + filter */}
      <div className="grid grid-cols-3 gap-2">
        <Slider
          label="Low"
          value={deck.eqLowDb}
          min={-26}
          max={6}
          step={0.5}
          resetTo={0}
          display={`${deck.eqLowDb.toFixed(0)}dB`}
          onChange={(v) => deck.setEq('low', v)}
        />
        <Slider
          label="Mid"
          value={deck.eqMidDb}
          min={-26}
          max={6}
          step={0.5}
          resetTo={0}
          display={`${deck.eqMidDb.toFixed(0)}dB`}
          onChange={(v) => deck.setEq('mid', v)}
        />
        <Slider
          label="High"
          value={deck.eqHighDb}
          min={-26}
          max={6}
          step={0.5}
          resetTo={0}
          display={`${deck.eqHighDb.toFixed(0)}dB`}
          onChange={(v) => deck.setEq('high', v)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Slider
          label="Filter"
          value={deck.filterKnob}
          min={-1}
          max={1}
          step={0.01}
          color={color}
          resetTo={0}
          display={
            deck.filterKnob < -0.01
              ? `LP ${Math.round(-deck.filterKnob * 100)}`
              : deck.filterKnob > 0.01
                ? `HP ${Math.round(deck.filterKnob * 100)}`
                : 'off'
          }
          onChange={(v) => deck.setFilter(v)}
        />
        <Slider
          label="Volume"
          value={deck.volume}
          min={0}
          max={1}
          step={0.01}
          color={color}
          display={`${Math.round(deck.volume * 100)}`}
          onChange={(v) => deck.setVolume(v)}
        />
      </div>
    </section>
  );
}
