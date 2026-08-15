# Live Mashup App — Project Spec (Phase 1 Prototype)

## What this is

A browser-based **live music performance tool**. The user loads their own audio files onto two decks, beatmatches them, performs a live mashup with a crossfader and cue points, and can record the master output to a WAV file. Later phases add a beat machine, stem separation, and a sound-mashing lab, then wrap the app for iPhone/iPad with Capacitor. Phase 1 is browser-only.

This is live-first: everything is real-time. Recording is just a tap on the master bus, not a timeline editor.

## Hard constraints (do not violate)

1. **No streaming-service audio.** Apple Music / YouTube / Spotify APIs do not expose raw audio and must not be used as audio sources. Audio comes from user-imported local files only (MP3, WAV, M4A, FLAC where the browser supports it).
2. **Recording is export-only.** Recordings save to the user's own device. No sharing, uploading, or social features for recordings.
3. **All audio processing is client-side** in Phase 1. No backend.
4. **Audio starts only after a user gesture** (browser autoplay policy). Create/resume the AudioContext on first user interaction.

## Tech stack

- **Framework:** React + TypeScript, Vite
- **Audio:** Web Audio API directly for the graph; Tone.js is allowed for transport/scheduling/effects where it saves time, but the deck playback path should be raw Web Audio + AudioWorklets for latency control
- **Time-stretch / pitch-shift:** SoundTouch compiled to WASM, running inside an AudioWorkletProcessor (the `soundtouchjs` / `@soundtouchjs/audio-worklet` ecosystem is a good starting point)
- **BPM / key detection:** Essentia.js (WASM). Run analysis in a Web Worker so the UI never blocks. Fallback: a simple onset-autocorrelation BPM detector if Essentia integration stalls
- **Recording:** custom AudioWorklet capturing raw PCM from the master bus, encoded to 16-bit or 24-bit WAV on stop, downloaded via blob URL. Do NOT use MediaRecorder (lossy)
- **State:** Zustand or plain React context; keep audio engine state outside React (the engine is the source of truth, React mirrors it)
- **Styling:** Tailwind. Dark UI, DJ-app aesthetic

## Audio graph architecture

```
Deck A ── file → decode → AudioWorklet (SoundTouch stretch) → Deck A gain ──┐
                                                                            ├─ Crossfader (equal-power) ─ Master gain ─┬─ AnalyserNode (meters) ─ destination
Deck B ── file → decode → AudioWorklet (SoundTouch stretch) → Deck B gain ──┘                                          └─ Recorder AudioWorklet (PCM tap)
```

Design rules:

- **One master bus.** Every future sound source (beat machine, stem players, sample pads) will be another input into the crossfader/master stage. Build the bus and mixer as its own module (`AudioEngine`) with an API like `engine.addSource(node)`, so Phase 2+ plugs in without rework.
- **Decks are instances of a `Deck` class**, not hardcoded A/B. Two instances in Phase 1, but nothing should assume exactly two.
- **The stretch worklet owns playback position.** Play/pause/seek/tempo are messages posted to the worklet. The worklet reports playhead position back at ~30 Hz for the UI.
- Decode files fully into an AudioBuffer up front (tracks are minutes long, memory is fine). Transfer the channel data into the worklet.

## Phase 1 features

### 1. Deck (×2)
- Load a local audio file (file picker + drag-and-drop onto the deck)
- Waveform overview rendered from the decoded buffer (canvas; downsampled min/max peaks), with playhead and a zoomed strip near the playhead
- Transport: play/pause, seek by clicking the waveform
- Pitch/tempo fader: ±8% default range (switchable to ±16%), changing **tempo without changing pitch** (time-stretch). Display current effective BPM
- **Sync button:** one press matches this deck's tempo to the other deck's effective BPM. Phase 1 sync is tempo-match only; automatic phase/beat alignment is a stretch goal
- **Cue points:** 4 hot cues per deck. Tap to set when empty, tap to jump when set, shift-tap (or long-press) to clear. Jumping to a cue while playing continues playing from the cue instantly
- Per-deck: volume fader, 3-band EQ (low/mid/high shelving+peaking filters), and a low/high-pass filter knob (single knob: center = off, left = LPF sweep, right = HPF sweep). The filter knob matters for performing transitions and drops

### 2. Analysis
- On file load: detect BPM and musical key in a Web Worker, show results on the deck (e.g. "126.0 BPM · 8A / A minor"). Use Camelot notation alongside the key name
- Show a compatibility hint between decks (same/adjacent Camelot = green, clash = amber)
- Analysis must not block loading; the deck is playable immediately and the BPM/key fill in when ready

### 3. Mixer
- Crossfader between Deck A and Deck B (equal-power curve)
- Master volume and a master level meter (from the AnalyserNode)
- Headroom: keep ~6 dB below clipping by default; add a soft limiter (WaveShaper or DynamicsCompressor) on the master so live moves don't clip the recording

### 4. Recording
- Record button arms/starts capture on the master bus; timer shows elapsed time
- Stop produces a WAV and triggers a download (`mashup-YYYY-MM-DD-HHmm.wav`)
- Recording must capture exactly what the master outputs, including EQ, filters, and crossfades

### 5. Keyboard shortcuts
- Space: play/pause focused deck · Q/W/E/R and U/I/O/P: hot cues for decks A/B · Z/X and N/M: nudge tempo · arrow keys: crossfader

## Non-goals for Phase 1 (do not build)

- Beat machine / step sequencer (Phase 2)
- Stem separation and any backend (Phase 3)
- Sound-mashing lab / layered sample designer (Phase 4)
- Capacitor / iOS packaging (Phase 4)
- Library management, playlists, cloud anything, accounts, sharing
- Automatic beat-grid phase alignment (stretch goal only; tempo sync ships first)

## Quality bar and acceptance checks

- Deck responds to play/cue/filter input in under ~30 ms perceived latency on a desktop browser
- Time-stretch at ±8% has no obvious artifacts on a typical 120–130 BPM dance track
- 10-minute recording plays back clean (no dropouts, no clipping) and matches what was heard live
- Loading a 7-minute 320 kbps MP3 shows a playable deck in under ~2 s on a modern laptop, with analysis completing in the background
- UI stays at 60 fps while both decks play and waveforms animate (do waveform drawing on canvas with rAF, not React re-renders)
- No audio glitches when the tab is backgrounded and refocused

## Suggested build order

1. `AudioEngine` skeleton: context, master bus, limiter, meters, recorder worklet, WAV export. Prove record/export with a test oscillator
2. `Deck` class with plain (non-stretched) playback, waveform render, transport, cues
3. SoundTouch worklet integration: tempo fader, then sync button
4. EQ + filter knob + crossfader
5. BPM/key analysis worker + Camelot display + compatibility hint
6. Keyboard shortcuts, polish, latency and recording QA

## Phase roadmap (context for architecture decisions)

- **Phase 2:** beat machine (Tone.js sequencer, curated 808/EDM sample pack, build/drop macros) as a third source on the master bus
- **Phase 3:** stem separation via a Python/Demucs backend with a job queue; stem players become additional deck-like sources
- **Phase 4:** sound-mashing lab (envelope splicing: attack of one sample + decay of another + pitch contour of a third) and Capacitor wrap for iPhone/iPad (AVAudioSession low-latency config; test pad latency on real hardware)
