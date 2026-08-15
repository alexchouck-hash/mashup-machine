import { useCallback, useEffect, useMemo, useState } from 'react';
import { engine } from './audio/AudioEngine';
import { useEngineVersion } from './hooks/useEngine';
import { useKeyboard } from './hooks/useKeyboard';
import { DeckPanel } from './components/DeckPanel';
import { Mixer } from './components/Mixer';
import { AssistPanel } from './components/AssistPanel';
import { BeatMachinePanel } from './components/BeatMachinePanel';
import { KidsMode } from './components/KidsMode';
import { downloadBlob, recordingFilename } from './audio/wav';

const DECK_COLORS = ['#22d3ee', '#f472b6'];
const ALL_ASSISTS = ['beatLock', 'phaseAlign', 'autoGain', 'bassSwap', 'harmonicNudge'] as const;

type Mode = 'menu' | 'kids' | 'dj';

/**
 * Why audio cannot start here, or null if it can.
 *
 * AudioWorklet is gated behind a secure context, so on http:// served from a LAN
 * IP `ctx.audioWorklet` is simply undefined and init throws. localhost is
 * exempt, which is exactly why this never showed up in local testing. Checked up
 * front so the buttons explain themselves instead of doing nothing.
 */
function audioBlocker(): string | null {
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return 'This browser does not support Web Audio, so the app cannot make sound.';
  if (!window.isSecureContext) {
    return `Sound needs a secure connection. This page is served over http:// from ${location.host}, and browsers only allow the audio engine on https:// or localhost. Open it on the computer that is running it, at http://localhost:5173.`;
  }
  return null;
}

function StartScreen({
  onStart,
  blocker,
  error,
}: {
  onStart: (mode: 'kids' | 'dj') => void;
  blocker: string | null;
  error: string | null;
}) {
  const problem = blocker ?? error;
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="max-w-lg text-center space-y-6">
        <h1 className="text-4xl font-black tracking-tight">Mashup Machine</h1>
        <p className="text-slate-400 leading-relaxed">
          Load two songs, mash them together, and record it. Smart assist keeps you on
          beat, in key and out of the red — so it sounds good even when the person at the
          controls is seven.
        </p>
        {problem && (
          <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-left">
            <p className="text-amber-300 font-bold text-sm mb-1">Can’t start audio here</p>
            <p className="text-amber-200/80 text-[13px] leading-relaxed">{problem}</p>
          </div>
        )}
        <div className={`grid sm:grid-cols-2 gap-3 ${problem ? 'opacity-40 pointer-events-none' : ''}`}>
          <button
            onClick={() => onStart('kids')}
            className="px-6 py-6 rounded-2xl bg-white text-slate-900 font-black text-lg
                       hover:bg-slate-100 active:scale-95 transition"
          >
            <span className="block text-3xl mb-1">🎉</span>
            Party Mode
            <span className="block text-[11px] font-semibold opacity-60 mt-1">
              Big buttons. Made for kids.
            </span>
          </button>
          <button
            onClick={() => onStart('dj')}
            className="px-6 py-6 rounded-2xl border-2 border-edge bg-panel2 font-black text-lg
                       hover:bg-[#232b3d] active:scale-95 transition"
          >
            <span className="block text-3xl mb-1">🎛</span>
            DJ Mode
            <span className="block text-[11px] font-semibold opacity-60 mt-1">
              Cues, EQ, tempo, key.
            </span>
          </button>
        </div>
        <p className="text-[11px] text-slate-600 leading-relaxed">
          Your music never leaves this device — files are decoded locally and nothing is
          uploaded. Recordings save straight to your downloads.
        </p>
      </div>
    </div>
  );
}

function RecordControls() {
  useEngineVersion();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!engine.recording) {
      setElapsed(0);
      return;
    }
    const id = window.setInterval(() => setElapsed(engine.recordedSeconds()), 200);
    return () => window.clearInterval(id);
  }, [engine.recording]);

  const toggle = () => {
    if (engine.recording) {
      const blob = engine.stopRecording();
      if (blob) downloadBlob(blob, recordingFilename());
    } else {
      engine.startRecording();
    }
  };

  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed % 60);

  return (
    <div className="flex items-center gap-2">
      {engine.recording && (
        <span className="font-mono text-sm text-red-400 tabular-nums">
          {m}:{String(s).padStart(2, '0')}
        </span>
      )}
      <button
        onClick={toggle}
        className={`btn ${engine.recording ? 'bg-red-500 border-red-500 text-white hover:bg-red-400' : ''}`}
        title="Records the master bus to a WAV file"
      >
        {engine.recording ? '■ Stop & save' : '● Record'}
      </button>
    </div>
  );
}

export default function App() {
  useEngineVersion();
  const [mode, setMode] = useState<Mode>('menu');
  const [focusedDeck, setFocusedDeck] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);
  const blocker = useMemo(audioBlocker, []);

  const start = useCallback(async (target: 'kids' | 'dj') => {
    try {
      await engine.init();
      if (engine.decks.length === 0) {
        engine.createDeck('A', 'A', 'A');
        engine.createDeck('B', 'B', 'B');
      }
      if (target === 'kids') for (const k of ALL_ASSISTS) engine.setAssist(k, true);
      setMode(target);
    } catch (err) {
      // A button that does nothing is the worst possible failure. Say why.
      console.error('[engine] init failed', err);
      setStartError(
        `The audio engine did not start: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, []);

  const enterKids = useCallback(() => {
    engine.fx.releaseAll();
    for (const k of ALL_ASSISTS) engine.setAssist(k, true);
    setMode('kids');
  }, []);

  useKeyboard(mode === 'dj', focusedDeck);

  if (mode === 'menu') {
    return <StartScreen onStart={(m) => void start(m)} blocker={blocker} error={startError} />;
  }

  if (mode === 'kids') {
    return (
      <KidsMode
        onExit={() => {
          engine.fx.releaseAll();
          setMode('dj');
        }}
      />
    );
  }

  const [deckA, deckB] = engine.decks;

  return (
    <div className="min-h-full p-3 space-y-3">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-black tracking-tight">Mashup Machine</h1>
        <span className="text-[11px] text-slate-500 font-mono hidden lg:inline">
          space play · qwer / uiop cues · z x / n m tempo · ← → crossfader
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn text-[11px]" onClick={enterKids}>
            🎉 Party mode
          </button>
          <RecordControls />
        </div>
      </header>

      <main className="grid gap-3 lg:grid-cols-[1fr_20rem_1fr] items-start">
        {deckA && (
          <DeckPanel
            deck={deckA}
            color={DECK_COLORS[0]}
            focused={focusedDeck === 0}
            onFocus={() => setFocusedDeck(0)}
            cueKeys={['Q', 'W', 'E', 'R']}
          />
        )}

        <div className="space-y-3 order-last lg:order-none">
          <Mixer />
          <BeatMachinePanel />
          <AssistPanel />
        </div>

        {deckB && (
          <DeckPanel
            deck={deckB}
            color={DECK_COLORS[1]}
            focused={focusedDeck === 1}
            onFocus={() => setFocusedDeck(1)}
            cueKeys={['U', 'I', 'O', 'P']}
          />
        )}
      </main>
    </div>
  );
}
