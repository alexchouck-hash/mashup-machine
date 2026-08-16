import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { engine } from '../audio/AudioEngine';
import type { Deck } from '../audio/Deck';
import { DRUM_PACKS, type DrumPack } from '../audio/drumPacks';
import { scaleOf } from '../audio/melody';
import { anchorKey } from '../audio/melodyLooper';
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
 * in index.css (.rack / .pad / .seg / .key / .well / .link-rail / .kid-slider);
 * this file only says which class and which colour.
 *
 * Nothing here animates through React. The visualizer, the beat pulse, the step
 * dots, the platter and BOTH loop surfaces each own a rAF loop that reads the
 * engine directly. React re-renders only on discrete events (a take commits, a
 * loop is cleared, a pack or a toggle changes) via engine.notify().
 */

const COLORS = ['#22d3ee', '#f472b6'];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Saturating 0..1, NaN-safe. Everything read out of the engine per frame goes
 * through this: `NaN > 0` is false, so a not-yet-started clock or a divide by a
 * zero loop length lands on 0 instead of poisoning a transform or a gradient.
 */
const sat = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/** Positive modulo — JS `%` keeps the sign of the dividend, which wraps wrong. */
const mod = (v: number, m: number) => (m > 0 ? ((v % m) + m) % m : 0);

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

/* ========================================================================
   THE LOOP PEDAL — beat pad and keyboard

   Two surfaces, ONE machine. In the engine they are two configurations of a
   single TakeLooper; here they are two calls to a single <LoopSurface>, which
   owns the well, the countdown, the position strip, the layer chips and the
   two undo buttons. The caller supplies only the legend and the thing you
   actually play, so nothing about capture, commit, undo or lighting is written
   twice.
   ===================================================================== */

/**
 * What this file reads off a TakeLooper. Declared STRUCTURALLY on purpose: the
 * UI never imports the class, so the surface cannot break when the looper's
 * generics or internals move, and this block is an exact, checkable statement
 * of the engine API the UI depends on. `bm.drums` and `bm.keys` satisfy it by
 * shape.
 */
interface HitView {
  /** Bucket within the take's own loop, 0..steps-1. */
  readonly step: number;
  /** Sub-step offset, 0 when the hit was quantised. */
  readonly frac: number;
  readonly vel: number;
}
interface TapView {
  /** Fractional ABSOLUTE step at which the tap was played. */
  readonly grid: number;
  readonly vel: number;
}
interface TakeView {
  readonly id: number;
  readonly steps: number;
  readonly color: string;
  readonly byStep: readonly (readonly HitView[])[];
  readonly raw: readonly TapView[];
}
interface LooperView {
  readonly takes: readonly TakeView[];
  readonly openTaps: readonly TapView[];
  /** keyOf(payload) -> ctx time the hit is scheduled to SOUND. */
  readonly flash: ReadonlyMap<number, number>;
  loopSteps(): number;
  phase01(): number;
  openRemaining01(): number;
  clearLast(): void;
  resetAll(): void;
}

/** How long a pad stays lit after its hit sounds. */
const FLASH_SEC = 0.18;
/** The commit animation: raw marks slide onto the grid. */
const SLIDE_SEC = 0.2;
/** Mirrors TakeConfig.maxTakes. Used for one hint string, nothing else. */
const MAX_TAKES = 6;

const REC_COLOR = '#ef4444';
const DRUM_ACCENT = '#a3e635';
const KEY_ACCENT = '#c084fc';

/**
 * Six pads, roles fixed across all three packs — pad 1 is always the boom
 * whatever kit is selected, so the labels never move under a child's finger.
 * The pad's payload is its slot index; the pack decides how a slot SOUNDS.
 */
const PADS = [
  { emoji: '💥', label: 'Boom' },
  { emoji: '👏', label: 'Clap' },
  { emoji: '✨', label: 'Tss' },
  { emoji: '🌟', label: 'Open' },
  { emoji: '🥁', label: 'Tom' },
  { emoji: '🔔', label: 'Ting' },
];

/** Low / Mid / High rather than 3 / 4 / 5 — Party Mode shows no numerals. */
const OCTAVES = [
  { octave: 3, label: 'Low' },
  { octave: 4, label: 'Mid' },
  { octave: 5, label: 'High' },
];

/** The commit animation's held state: where each raw tap was, and where it goes. */
interface Slide {
  id: number;
  from: number[];
  to: number[];
  vel: number[];
  color: string;
  until: number;
}

/** Per-surface scratch state for the rAF loop. Never touched by React. */
interface Frame {
  /** element keyed by keyOf(payload): pad slot, or MIDI note. */
  lit: Map<number, HTMLElement>;
  litLast: Map<number, number>;
  slide: Slide | null;
  takes: number;
  rec: boolean | null;
  hint: string | null;
}

const newFrame = (): Frame => ({
  lit: new Map(),
  litLast: new Map(),
  slide: null,
  takes: -1,
  rec: null,
  hint: null,
});

/**
 * Glow for one key. `t` is the time the hit is scheduled to SOUND, and the
 * transport schedules up to 120 ms ahead, so a flash in the future is worth
 * exactly zero light: the pad lights WITH the sound, never before it.
 */
function glowAt(now: number, t: number | undefined): number {
  if (t === undefined || now < t) return 0;
  return sat(1 - (now - t) / FLASH_SEC);
}

/**
 * Build the commit animation. We hold the raw taps AND the snapped hits, so
 * showing the phrase slide onto the grid costs one lerp — and that 200 ms is
 * the child SEEING "auto-adjust to be on beat" happen, which is what teaches
 * them what the pause did.
 */
function buildSlide(l: LooperView, now: number): Slide | null {
  const take = l.takes[l.takes.length - 1];
  // Long rambles are not worth animating, and the O(raw x hits) match below
  // has to stay trivial: it runs once, on the frame a take commits.
  if (!take || take.raw.length === 0 || take.raw.length > 160) return null;

  const L = Math.max(16, l.loopSteps() || 16);
  const steps = Math.max(1, take.steps);
  const reps = Math.max(1, Math.round(L / steps));

  const dest: number[] = [];
  for (const bucket of take.byStep) {
    if (!bucket) continue;
    for (const h of bucket) {
      for (let r = 0; r < reps; r++) dest.push((h.step + h.frac + r * steps) / L);
    }
  }
  if (dest.length === 0) return null;

  const from: number[] = [];
  const to: number[] = [];
  const vel: number[] = [];
  for (const tp of take.raw) {
    const x = mod(tp.grid, L) / L;
    let best = dest[0];
    let bd = 2;
    for (const d of dest) {
      const raw = Math.abs(d - x);
      const circ = raw > 0.5 ? 1 - raw : raw;
      if (circ < bd) {
        bd = circ;
        best = d;
      }
    }
    // Take the short way round the loop, then wrap at draw time. Without this
    // a mark near the end snaps to the start by sweeping the whole strip.
    let target = best;
    if (target - x > 0.5) target -= 1;
    else if (x - target > 0.5) target += 1;
    from.push(x);
    to.push(target);
    vel.push(tp.vel);
  }
  return { id: take.id, from, to, vel, color: take.color, until: now + SLIDE_SEC };
}

/**
 * The position strip: bar ticks, one mark per hit in its take's colour, the
 * open take's loose marks in red, and the playhead. Canvas rather than DOM
 * because a 4-bar loop of six stacked takes is a few hundred marks and this
 * runs at frame rate.
 */
function drawStrip(cv: HTMLCanvasElement, l: LooperView, f: Frame, now: number): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const g = cv.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, w, h);

  const L = Math.max(16, l.loopSteps() || 16);

  // One tick per beat, bright on bar lines — this is where a child sees that
  // an 8-second phrase became four bars.
  const beats = Math.max(4, Math.round(L / 4));
  const tick = Math.max(1, Math.round(dpr));
  for (let i = 1; i < beats; i++) {
    g.fillStyle = i % 4 === 0 ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.06)';
    g.fillRect(Math.round((i / beats) * w), 0, tick, h);
  }

  const mw = Math.max(2, Math.round(2.5 * dpr));
  const mark = (x01: number, vel: number, color: string, alpha: number) => {
    const hh = h * (0.34 + 0.52 * sat(vel));
    const x = mod(x01, 1) * w;
    g.globalAlpha = alpha;
    g.fillStyle = color;
    const rx = Math.round(x - mw / 2);
    const ry = Math.round((h - hh) / 2);
    if (typeof g.roundRect === 'function') {
      g.beginPath();
      g.roundRect(rx, ry, mw, hh, mw / 2);
      g.fill();
    } else {
      g.fillRect(rx, ry, mw, hh);
    }
    g.globalAlpha = 1;
  };

  const sliding = f.slide !== null && now < f.slide.until;

  // Committed takes. A 1-bar take against a 4-bar strip is drawn four times,
  // because that is where its pads will actually light.
  let drawn = 0;
  for (const take of l.takes) {
    if (sliding && f.slide && take.id === f.slide.id) continue;
    const steps = Math.max(1, take.steps);
    const reps = Math.max(1, Math.round(L / steps));
    for (const bucket of take.byStep) {
      if (!bucket) continue;
      for (const hit of bucket) {
        for (let r = 0; r < reps; r++) {
          if (drawn++ > 400) break;
          mark((hit.step + hit.frac + r * steps) / L, hit.vel, take.color, 0.95);
        }
      }
    }
  }

  // The commit animation, easing raw -> quantised.
  if (sliding && f.slide) {
    const e = 1 - Math.pow(1 - sat(1 - (f.slide.until - now) / SLIDE_SEC), 3);
    for (let i = 0; i < f.slide.from.length; i++) {
      const x = f.slide.from[i] + (f.slide.to[i] - f.slide.from[i]) * e;
      mark(x, f.slide.vel[i], f.slide.color, 0.95);
    }
  }

  // The open take, exactly where it was played — loose, red, off the grid.
  for (const tp of l.openTaps) mark(mod(tp.grid, L) / L, tp.vel, REC_COLOR, 0.9);

  // Playhead, with a short trail so the direction of travel is obvious.
  const px = sat(l.phase01()) * w;
  const trailW = 26 * dpr;
  const trail = g.createLinearGradient(px - trailW, 0, px, 0);
  trail.addColorStop(0, 'rgba(226,232,240,0)');
  trail.addColorStop(1, 'rgba(226,232,240,0.20)');
  g.fillStyle = trail;
  g.fillRect(px - trailW, 0, trailW, h);
  g.fillStyle = 'rgba(240,248,255,0.95)';
  g.fillRect(Math.round(px - dpr), 0, Math.max(2, Math.round(2 * dpr)), h);
}

/**
 * One frame of one surface. Everything here reads engine state directly and
 * writes DOM directly — no React, no allocation beyond the commit frame.
 */
function paintSurface(
  l: LooperView,
  f: Frame,
  well: HTMLElement | null,
  fill: HTMLElement | null,
  hintEl: HTMLElement | null,
  canvas: HTMLCanvasElement | null,
  octaveGhost: boolean
): void {
  const now = engine.ctx.currentTime;
  const open = l.openTaps.length > 0;

  // A take opening is NOT a notify-worthy event (it happens on a tap), so the
  // recording border and its countdown are driven from here. Both writes are
  // cached against their last value so an idle surface writes nothing.
  if (well && open !== f.rec) {
    f.rec = open;
    well.dataset.rec = open ? 'true' : 'false';
  }
  if (fill) fill.style.transform = `scaleX(${(open ? sat(l.openRemaining01()) : 0).toFixed(3)})`;

  if (hintEl) {
    const takes = l.takes.length;
    const hint = open
      ? 'Listening…'
      : takes === 0
        ? 'Tap, then wait'
        : takes >= MAX_TAKES
          ? 'Full — clear one'
          : 'Looping';
    if (hint !== f.hint) {
      f.hint = hint;
      hintEl.textContent = hint;
      hintEl.dataset.rec = open ? 'true' : 'false';
    }
  }

  // Pad / key light. Scheduled, not immediate: the step handler wrote the time
  // the hit will SOUND, so the light lands with it rather than 120 ms early.
  for (const [key, el] of f.lit) {
    let g = glowAt(now, l.flash.get(key));
    if (octaveGhost && g < 1) {
      // A loop recorded an octave away still shows on the visible keybed, at a
      // third of the brightness, so the keyboard never looks dead while it is
      // clearly playing.
      for (const [k, t] of l.flash) {
        if (k === key || mod(k - key, 12) !== 0) continue;
        const gg = glowAt(now, t) * 0.34;
        if (gg > g) g = gg;
      }
    }
    const q = Math.round(g * 20) / 20;
    if (f.litLast.get(key) !== q) {
      f.litLast.set(key, q);
      el.style.setProperty('--lit', String(q));
    }
  }

  if (l.takes.length !== f.takes) {
    const grew = f.takes >= 0 && l.takes.length > f.takes;
    f.takes = l.takes.length;
    f.slide = grew ? buildSlide(l, now) : null;
  }

  if (canvas) drawStrip(canvas, l, f, now);
}

/**
 * The chassis shared by both loop surfaces: legend, well, countdown, position
 * strip, layer chips, clear-last and reset.
 *
 * Each surface owns its OWN clear/reset pair. One shared pair would be
 * ambiguous about which surface it clears, which for a seven-year-old is worse
 * than two extra buttons.
 */
function LoopSurface({
  looper,
  legend,
  resetLabel,
  octaveGhost,
  children,
}: {
  looper: LooperView;
  legend: ReactNode;
  resetLabel: string;
  octaveGhost: boolean;
  children: ReactNode;
}) {
  const wellRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const hintRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frame = useRef<Frame>(newFrame());
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);

  // Rebuild the key -> element map after every render. Cheap (at most twelve
  // nodes) and immune to the ordering hazard a ref callback has when the same
  // MIDI note moves from one element to another on an octave change.
  useLayoutEffect(() => {
    const f = frame.current;
    f.lit.clear();
    f.litLast.clear();
    const root = wellRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-lit-key]')) {
      const k = Number(el.dataset.litKey);
      if (Number.isFinite(k)) f.lit.set(k, el);
    }
  });

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      // Re-arm FIRST. A throw inside the paint then costs one frame instead of
      // stopping the surface for the rest of the party.
      raf = requestAnimationFrame(loop);
      paintSurface(
        looper,
        frame.current,
        wellRef.current,
        fillRef.current,
        hintRef.current,
        canvasRef.current,
        octaveGhost
      );
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [looper, octaveGhost]);

  useEffect(() => () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
  }, []);

  const disarm = () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmed(false);
  };

  // Reset asks twice. Clear-last is one tap because it removes one loop; reset
  // wipes everything a child has built, and a stray finger must not be able to.
  const onReset = () => {
    if (armed) {
      looper.resetAll();
      disarm();
      return;
    }
    setArmed(true);
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => {
      armTimer.current = null;
      setArmed(false);
    }, 2600);
  };

  const takes = looper.takes;

  return (
    <div className="rack-row">
      <div className="legend-bar">{legend}</div>

      {/* data-rec is written by the rAF loop: a take OPENS on a tap, and a tap
          is not a notify-worthy event. */}
      <div className="well" ref={wellRef}>
        {children}
      </div>

      <div className="take-count">
        <span className="take-count-fill" ref={fillRef} />
      </div>

      <div className="take-strip">
        <canvas ref={canvasRef} />
      </div>

      <div className="take-bar">
        <span className="take-hint" ref={hintRef} />
        <span className="take-chips">
          {takes.map((t, i) => (
            <span
              key={t.id}
              className="take-chip"
              data-newest={i === takes.length - 1 ? 'true' : 'false'}
              style={{ '--c': t.color } as CSSProperties}
              aria-hidden="true"
            />
          ))}
        </span>
        {/* Never disabled: whether a take is open changes on a tap, which does
            not re-render React, so a disabled state here would go stale exactly
            when a child reaches for undo. Both are harmless no-ops when empty. */}
        <button
          className="key key--text"
          onClick={() => {
            looper.clearLast();
            disarm();
          }}
          title="Remove the last loop"
        >
          Clear last
        </button>
        <button
          className="key key--text key--danger"
          data-armed={armed ? 'true' : 'false'}
          onClick={onReset}
          onBlur={disarm}
          title={resetLabel}
        >
          {armed ? 'Sure?' : resetLabel}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- beat pad */

function BeatsRow() {
  const bm = engine.beatMachine;
  // The one legacy layer control left in Party Mode: "fun in one tap" for a
  // child who cannot yet play a beat. It drives the canned groove exactly as
  // before — takes stack on top of it.
  const autoBeat = bm.layers.kick && bm.layers.snare && bm.layers.hats;

  const padStyle = {
    '--pad': DRUM_ACCENT,
    '--pad-soft': `${DRUM_ACCENT}22`,
    '--pad-glow': `${DRUM_ACCENT}66`,
  } as CSSProperties;

  return (
    <LoopSurface
      looper={bm.drums}
      resetLabel="Reset beats"
      octaveGhost={false}
      legend={
        <>
          <span className="legend">Beats</span>
          <div className="seg" role="group" aria-label="Drum pack">
            {DRUM_PACKS.map((p: DrumPack, i: number) => (
              <button
                key={p.name}
                onClick={() => bm.setPack(i)}
                data-on={bm.packIndex === i ? 'true' : 'false'}
                aria-pressed={bm.packIndex === i}
                className="seg-btn seg-btn--wide"
              >
                {p.name}
              </button>
            ))}
          </div>
          <button
            className="key"
            data-on={autoBeat ? 'true' : 'false'}
            aria-pressed={autoBeat}
            aria-label="Auto beat"
            title="Play a beat for me"
            onClick={() => {
              bm.setLayer('kick', !autoBeat);
              bm.setLayer('snare', !autoBeat);
              bm.setLayer('hats', !autoBeat);
            }}
          >
            🥁
          </button>
        </>
      }
    >
      <div className="rack-scroll">
        <div className="beatpad">
          {PADS.map((p, slot) => (
            <button
              key={p.label}
              className="pad"
              data-lit-key={slot}
              style={padStyle}
              aria-label={p.label}
              onPointerDown={() => bm.drums.tap(slot, 1)}
              onKeyDown={(e) => {
                if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
                e.preventDefault();
                bm.drums.tap(slot, 1);
              }}
            >
              <span className="pad-led">
                <span className="pad-led-on" />
              </span>
              <span className="pad-emoji">{p.emoji}</span>
              <span className="pad-label">{p.label}</span>
            </button>
          ))}
        </div>
      </div>
    </LoopSurface>
  );
}

/* -------------------------------------------------------------- keyboard */

function KeysRow() {
  const bm = engine.beatMachine;
  const [octave, setOctave] = useState(4);
  const dragging = useRef(false);
  const lastMidi = useRef(-1);

  // What is actually being HEARD, not the raw analysis: anchorKey() folds in
  // the anchor deck's harmonic nudge, and falls back to A minor so the layout
  // is identical — never disabled, never empty — in a room with no song yet.
  const { pc, mode } = anchorKey(engine);
  const scale = scaleOf(mode);

  // The five chromatic in-betweens, each parked on the boundary between the
  // two scale degrees it sits between. `i` counts the degrees below it, which
  // is exactly the gap index the CSS positions against.
  const blacks: Array<{ off: number; i: number }> = [];
  for (let off = 1; off < 12; off++) {
    if (scale.indexOf(off) >= 0) continue;
    let i = 0;
    for (const s of scale) if (s < off) i++;
    blacks.push({ off, i });
  }

  const midiOf = (off: number) => 12 * (octave + 1) + pc + off;

  // One path for tap and glissando, mouse and touch. elementFromPoint rather
  // than pointerenter because a touch pointer is implicitly captured by the
  // key it started on and never enters its neighbours.
  const fireAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    const key = el instanceof Element ? el.closest<HTMLElement>('[data-midi]') : null;
    if (!key) return;
    const midi = Number(key.dataset.midi);
    if (!Number.isFinite(midi) || midi === lastMidi.current) return;
    lastMidi.current = midi;
    // Auto-tune is applied inside tapKey, at TAP time, so the note a child
    // hears the instant they press is the note that gets looped.
    bm.tapKey(midi, 1);
  };

  const keyStyle = {
    '--k': KEY_ACCENT,
    '--k-glow': `${KEY_ACCENT}88`,
  } as CSSProperties;

  return (
    <LoopSurface
      looper={bm.keys}
      resetLabel="Reset all"
      octaveGhost
      legend={
        <>
          <span className="legend">Keys</span>
          <div className="seg" role="group" aria-label="How high">
            {OCTAVES.map((o) => (
              <button
                key={o.octave}
                onClick={() => setOctave(o.octave)}
                data-on={octave === o.octave ? 'true' : 'false'}
                aria-pressed={octave === o.octave}
                className="seg-btn seg-btn--wide"
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            className="key key--text key--key"
            data-on={bm.autoTune ? 'true' : 'false'}
            aria-pressed={bm.autoTune}
            title="Auto-tune — snap what you play into the song's key"
            onClick={() => bm.setAutoTune(!bm.autoTune)}
          >
            Tune
          </button>
          <button
            className="key key--text key--key"
            data-on={bm.beatMatch ? 'true' : 'false'}
            aria-pressed={bm.beatMatch}
            title="Auto beat-match — snap what you play onto the beat"
            onClick={() => bm.setBeatMatch(!bm.beatMatch)}
          >
            Beat
          </button>
        </>
      }
    >
      {/* Key-relative, not piano-relative: the seven BIG keys are the seven
          notes of the song's key with the root on the left, and the five small
          ones are the in-betweens. Bad aim therefore lands on a note that
          works — the highlight is structural, not just coloured. */}
      <div className="rack-scroll">
        <div
          className="keybed"
          style={keyStyle}
          onPointerDown={(e) => {
            dragging.current = true;
            lastMidi.current = -1;
            fireAt(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            if (e.pointerType === 'mouse' && e.buttons === 0) {
              dragging.current = false;
              return;
            }
            fireAt(e.clientX, e.clientY);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onPointerLeave={() => {
            dragging.current = false;
          }}
        >
          <div className="keybed-blacks">
            {blacks.map((b) => (
              <button
                key={b.off}
                className="keybed-black"
                data-midi={midiOf(b.off)}
                data-lit-key={midiOf(b.off)}
                style={{ '--kb-i': b.i } as CSSProperties}
                aria-label="In-between note"
                onKeyDown={(e) => {
                  if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
                  e.preventDefault();
                  bm.tapKey(midiOf(b.off), 1);
                }}
              >
                <span className="keybed-glow" />
              </button>
            ))}
          </div>
          <div className="keybed-whites">
            {scale.map((off, i) => (
              <button
                key={off}
                className="keybed-key"
                data-midi={midiOf(off)}
                data-lit-key={midiOf(off)}
                data-role={off === 0 ? 'root' : off === 7 ? 'fifth' : 'in'}
                aria-label={`Note ${i + 1}`}
                onKeyDown={(e) => {
                  if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
                  e.preventDefault();
                  bm.tapKey(midiOf(off), 1);
                }}
              >
                <span className="keybed-glow" />
                {off === 0 && <span className="keybed-home" />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </LoopSurface>
  );
}

/* ------------------------------------------------------------------- main */

export function KidsMode({ onExit }: { onExit: () => void }) {
  useEngineVersion();
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

        {/* --------------------------------------------- loop pedal, twice */}
        <BeatsRow />
        <KeysRow />

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
