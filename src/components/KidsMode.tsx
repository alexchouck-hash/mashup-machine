import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
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
 *
 * The chrome is hardware, not software: the decks sit on top, joined by a patch
 * cable, and everything below them is ONE rack chassis — silkscreen legends,
 * recessed wells, moulded keys with real LEDs, a console fader. That look lives
 * in index.css (.rack / .pad / .seg / .key / .link-rail / .kid-slider); this
 * file only says which class and which colour.
 *
 * Nothing here animates through React. The visualizer, the beat pulse, the step
 * dots and the platter each own a rAF loop that reads the engine directly.
 */

const COLORS = ['#22d3ee', '#f472b6'];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Fader cap glow, lerped cyan -> pink with the crossfader's travel. Hex in, hex
 * out: CSS cannot add an alpha channel to a var() colour, and color-mix() is
 * too new to bet a tablet on.
 */
function mixHex(a: string, b: string, t: number): string {
  const part = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const at = clamp01(t);
  const chan = (i: number) => Math.round(part(a, i) + (part(b, i) - part(a, i)) * at);
  return `#${[0, 1, 2].map((i) => chan(i).toString(16).padStart(2, '0')).join('')}`;
}

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
  // Exactly one release per press, whatever swallows the pointerup. A pad that
  // becomes disabled while held gets pointer-events:none and never sees the up,
  // which would strand a held effect (Swoosh stuck closed for the rest of the
  // party). lostpointercapture fires after a normal pointerup too, so the latch
  // is what keeps that from double-releasing.
  const held = useRef(false);
  const release = () => {
    if (!held.current) return;
    held.current = false;
    onRelease?.();
  };

  return (
    <button
      disabled={disabled}
      data-on={active ? 'true' : 'false'}
      className="pad"
      // The one colour the call site passes drives the border, the label, the
      // wash, the LED and the glow. Custom properties, so a pad added later
      // inherits the whole hardware look by passing what it already passes.
      style={
        {
          '--pad': color,
          '--pad-soft': `${color}22`,
          '--pad-glow': `${color}66`,
        } as CSSProperties
      }
      onPointerDown={(e) => {
        // Capture so a finger sliding off still delivers the release. Guarded:
        // an invalid pointer id throws, and that must not swallow the press.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* capture is an optimisation, not a requirement */
        }
        held.current = true;
        onPress();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <span className="pad-led" />
      <span className="pad-emoji">{emoji}</span>
      <span className="pad-label">{label}</span>
    </button>
  );
}

/* -------------------------------------------------------------- song tile */

/** Vocal isolation, as three segments of one switch. Icons always; words when
 *  there is room for them. */
const VOCAL_MODES = [
  ['both', '🎵', 'All'],
  ['music', '🎸', 'No vox'],
  ['vocals', '🎤', 'Vox'],
] as const;

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
  const hookReady = !!deck.analysis && deck.analysis.hookLengthSec > 0;

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
          {/* Module label strip: lit LED when this deck is playing, what is
              loaded, and eject. Above the platter so that everything BELOW the
              turntable is one row of controls, and so eject is nowhere near
              the grab annulus a scratch starts in. */}
          <div className="deck-head">
            <span
              className="deck-led"
              style={deck.playing ? { background: color, boxShadow: `0 0 9px ${color}` } : undefined}
            />
            <span className="truncate flex-1 text-[11px] text-slate-400" title={deck.fileName}>
              {busy ? 'Getting ready…' : deck.fileName.replace(/\.[^.]+$/, '')}
            </span>
            <button
              onClick={() => deck.unload()}
              aria-label="Swap song"
              title="Swap song"
              className="key key--ghost key--sm"
            >
              ⏏
            </button>
          </div>
          {/* The platter is the play surface. Turntable swallows the click that
              ends a grab, so a scratch never also toggles playback. Everything
              in here is phrasing content: a <div> inside a <button> is not. */}
          <button
            onClick={() => deck.togglePlay()}
            className="flex-1 w-full flex flex-col items-center justify-center py-1.5 sm:py-2.5 px-3 transition"
          >
            <span className="relative block w-full">
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
              {/* The instruction a child needs, moved onto the record so it
                  costs no row. pointer-events:none in CSS — it sits over the
                  play target and the scratch surface and must catch neither. */}
              <span className="platter-hint">{deck.playing ? 'Spin me' : 'Tap to play'}</span>
            </span>
          </button>

          <div className="deck-strip px-2 pb-2">
            <div className="seg" role="group" aria-label="Vocals">
              {VOCAL_MODES.map(([mode, icon, label]) => (
                <button
                  key={mode}
                  onClick={() => deck.setVocalMode(mode)}
                  disabled={mode === 'music' && !deck.canRemoveVocals}
                  data-on={deck.vocalMode === mode ? 'true' : 'false'}
                  aria-pressed={deck.vocalMode === mode}
                  aria-label={label}
                  title={
                    mode === 'music' && !deck.canRemoveVocals
                      ? 'This track is mono, so there is no centre to cancel'
                      : label
                  }
                  className="seg-btn"
                >
                  <span className="text-[13px] sm:text-[15px]">{icon}</span>
                  <span className="hidden sm:inline text-[8px]">{label}</span>
                </button>
              ))}
            </div>
            <button
              disabled={!hookReady}
              // A toggle, not a one-way trip. It lit up to say the loop was on
              // and then had no path back, so the catchiest bit could be started
              // and never stopped.
              onClick={() => {
                if (deck.loopStartSec != null) {
                  deck.setLoopRegion(null, null);
                  deck.setLoop(false);
                } else {
                  deck.playHook();
                }
              }}
              data-on={deck.loopStartSec != null ? 'true' : 'false'}
              aria-pressed={deck.loopStartSec != null}
              aria-label={deck.loopStartSec != null ? 'Stop looping the hook' : 'Loop the hook'}
              title={
                deck.loopStartSec != null
                  ? 'Stop looping — play the rest of the song'
                  : 'Loop the catchiest repeated bit'
              }
              className="key"
            >
              {/* Repeat-ONE, not repeat. Echo's pad is 🔁, and two identical
                  glyphs meaning different things is unreadable to a child who
                  cannot read the labels either. */}
              🔂
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

  // A non-finite crossfade would make this a React-uncontrolled input AND emit
  // "#NaNNaNNaN" from the lerp below, which kills the whole box-shadow.
  const mix = Number.isFinite(engine.crossfade) ? clamp01(engine.crossfade) : 0.5;

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

      {/* Sync lives here, not in a grid of pads: it is the one control that
          describes BOTH decks, so it is drawn as the cable between them. */}
      <div className="link-rail" data-on={engine.linkDecks ? 'true' : 'false'}>
        <span className="link-wire" />
        <button
          onClick={() => engine.setLink(!engine.linkDecks)}
          aria-pressed={engine.linkDecks}
          title="Lock both songs together — one scratch spins both"
          className="link-btn"
        >
          <span className="link-led" />
          <span>🔗 Sync</span>
        </button>
        <span className="link-wire" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        {a && <SongTile deck={a} color={COLORS[0]} />}
        {b && <SongTile deck={b} color={COLORS[1]} />}
      </div>

      {/* One chassis for the whole lower half. Four floating cards read as
          software; a single bezel with grooves, legends and screws reads as a
          soundboard, which is what this is meant to be. */}
      <section className="rack">
        {/* ------------------------------------------------------------ mix */}
        <div className="rack-row">
          <div className="legend">Mix</div>
          <div className="fader-ends">
            <span style={{ color: COLORS[0] }}>Song 1</span>
            <span style={{ color: COLORS[1] }}>Song 2</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={mix}
            onChange={(e) => engine.setCrossfade(parseFloat(e.target.value))}
            onDoubleClick={() => engine.setCrossfade(0.5)}
            aria-label="Mix between Song 1 and Song 2"
            className="kid-slider"
            style={{ '--cap-glow': `${mixHex(COLORS[0], COLORS[1], mix)}88` } as CSSProperties}
          />
        </div>

        {/* ---------------------------------------------------------- beats */}
        <div className="rack-row">
          <div className="legend-bar">
            <span className="legend">Beats</span>
            <div className="seg" role="group" aria-label="Groove">
              {GROOVES.map((g, i) => (
                <button
                  key={g.name}
                  onClick={() => bm.setGroove(i)}
                  data-on={bm.grooveIndex === i ? 'true' : 'false'}
                  aria-pressed={bm.grooveIndex === i}
                  className="seg-btn seg-btn--wide"
                >
                  {g.name}
                </button>
              ))}
            </div>
          </div>
          <div className="well">
            {/* 52px keeps all five drum keys on one row on a 360px phone. */}
            <div className="pad-grid" style={{ '--pad-min': '52px' } as CSSProperties}>
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
        </div>

        {/* ------------------------------------------------------------- fx */}
        <div className="rack-row">
          <div className="legend">Magic buttons</div>
          <div className="well">
            {/* auto-fit at 84px: three across on a phone, six on a tablet, and
                a seventh pad added later re-flows instead of breaking a row. */}
            <div className="pad-grid" style={{ '--pad-min': '84px' } as CSSProperties}>
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
              {/* macros.build sweeps the SONGS' own filters with an accelerating
                  roll. fx.build only layered noise over unchanged music, which
                  is why it read as useless. Not greyed off `busy` — the second
                  tap is how you cancel it. */}
              <BigPad
                emoji="🚀"
                label="Build"
                color="#f472b6"
                active={macros.active === 'build'}
                onPress={() => macros.build()}
              />
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------------- drops */}
        <div className="rack-row">
          <div className="legend">Drops</div>
          <div className="well">
            <div className="pad-grid" style={{ '--pad-min': '84px' } as CSSProperties}>
              <BigPad
                emoji="💥"
                label="Drop"
                color="#ef4444"
                disabled={macros.busy}
                onPress={() => macros.drop('classic')}
              />
              <BigPad
                emoji="🛑"
                label="Tape stop"
                color="#fb7185"
                disabled={macros.busy}
                onPress={() => macros.drop('tapestop')}
              />
              <BigPad
                emoji="⏪"
                label="Rewind"
                color="#a78bfa"
                disabled={macros.busy}
                onPress={() => macros.drop('reverse')}
              />
            </div>
          </div>
        </div>

        {/* ---------------------------------------------------------- macros */}
        <div className="rack-row">
          <div className="legend-bar">
            <span className="legend">Do it for me</span>
            {macros.lastNote && <span className="note-readout">{macros.lastNote}</span>}
          </div>
          <div className="well">
            {/* 68px: four across even on a phone, and they stretch to fill on a
                tablet because auto-fit collapses the tracks nobody used. */}
            <div className="pad-grid" style={{ '--pad-min': '68px' } as CSSProperties}>
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
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
