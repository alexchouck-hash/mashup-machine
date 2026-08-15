# Mashup Machine

A browser-based live mashup / DJ performance tool. Load two tracks, beatmatch
them, perform, and record the master to a WAV. Phase 1 of the spec in
`docs/spec.md`.

Everything runs client-side. No backend, no accounts, no uploads — audio is
decoded locally and recordings save straight to your downloads.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173 and press **Start** (a user gesture is required
before any browser will let a page make sound).

`npm run build` type-checks and produces a static `dist/` you can host anywhere.

## What it does

**Decks (×2)** — drag-and-drop or Load a local file. Waveform overview plus a
zoomed strip with the detected beat grid drawn on it. Click the overview to
seek. Four hot cues each: tap to set, tap to jump, shift-tap *or* long-press to
clear. Tempo fader at ±8% (switchable to ±16%) that changes speed **without
changing pitch**. Per-deck 3-band EQ, a single filter knob (centre off, left
sweeps a low-pass down, right sweeps a high-pass up), and volume.

**Analysis** — on load, a Web Worker detects BPM, the beat-grid anchor, musical
key and loudness. The deck is playable immediately; the numbers fill in behind
it. Key is shown in both Camelot and note names, with a compatibility badge
between the decks.

**Mixer** — equal-power crossfader, master volume, level meter, and a soft
limiter with ~6 dB of headroom so live moves cannot clip the recording.

**Recording** — taps raw PCM off the master bus (after the limiter, so the file
is exactly what you heard) and writes a real 16-bit WAV. Deliberately not
MediaRecorder, which is lossy.

**Beat machine** (Phase 2) — a 16-step sequencer with three grooves and four
toggleable layers (kick, snare/clap, hats, 808 sub). It joins the master bus as
its own source, *outside* the crossfader, so the beat keeps playing while you
sweep between songs. Tempo and downbeat follow the anchor deck, and the sub is
tuned to the song's detected key, so the drums land on the song's grid and in
its key without anyone asking.

**FX and macros** — hold Filter, Echo (tempo-synced dotted eighth) and Stutter
(tempo-synced gate); tap Horn, Build (riser) or Drop. Drop cuts everything for
half a beat and slams back exactly on the next downbeat.

## Party Mode

The surface a child actually uses, and the reason Phase 2 exists. Pick it from
the opening screen, or switch at any time.

**It is never empty.** Four built-in jams — Sunbeam, Moonwalk, Rocket Fuel,
Bubblegum — are complete backing tracks (drums, bass, chords, arpeggio) rendered
on the fly through an OfflineAudioContext using the same synth voices as the
live beat machine. Nothing is downloaded and nothing is licensed. One tap loads
a jam, starts it, and loops it forever; measured **755 ms from tap to music**,
because Party Mode pre-renders all four in the background while the picker is on
screen. Their tempos and keys are spread apart on purpose, so mashing any two
together genuinely exercises tempo sync, phase lock and the harmonic nudge.

A spectrum visualizer runs across the top and the song tiles pulse on the beat,
so a child can *see* that their song and their drums are locked together.

No numbers anywhere — no BPM, no dB, no Camelot, no percentages. The whole song
tile is the play button, because it is the biggest target on screen and a
seven-year-old aims badly. Everything pulses on the beat, so a child can *see*
that their song and their drums are locked together. Every assist is forced on:
there is no way to make it sound wrong.

Five beat pads (Boom / Clap / Tss / Bass / Tune), six magic buttons (Swoosh,
Echo, Stutter, Horn, Build, Drop), one fat mix slider, one big record button.
The Tune pad plays diatonic chords derived from the key of whatever is currently
playing, so it lands on a child's own song without clashing.

### Smart assist

The layer that makes it sound good when the person at the controls is seven.
All default on, all defeatable, so the manual DJ path still works.

| Assist | What it prevents |
|---|---|
| **Beat lock** | Coming in off-beat. Play/cue nudges the playhead onto the other deck's grid and starts *instantly* — no waiting for the next bar, so a child's tap still feels immediate. |
| **Phase align** | Sync matching tempo but leaving downbeats offset. |
| **Auto gain** | One track burying the other, from the analysed loudness. |
| **Bass swap** | Two kick drums fighting. The outgoing deck's low band ducks across the crossfader — the single biggest cause of a mashup turning to mud. |
| **Harmonic nudge** | Clashing keys. Shifts deck B by at most ±2 semitones toward a compatible Camelot neighbour, and refuses larger shifts rather than mangling the audio. Deck A is always the anchor. |

## Architecture

```
decks ──────────> xfA/xfB ─┐
beat machine ──────────────┼─> sum ─> fxFilter ─> fxGate ─> master ─> limiter ─┬─> analyser ─> out
                           │              └─> delaySend ─> delay ─┘            └─> recorder
one-shots ─────────────────────────────────────────────────────> master
```

The beat machine attaches with `addSource(node, null)` — the sum bus rather than
either crossfader side — which is exactly why that argument is nullable.
One-shots (horn, drop impact) join *after* the gate on purpose: a drop cuts the
gate to silence, and the impact that sells it has to survive that.

- `src/audio/AudioEngine.ts` — the master bus. Every future source joins via
  `engine.addSource(node, side)`; Phase 2's beat machine and Phase 3's stem
  players plug in without touching it.
- `src/audio/Deck.ts` — one deck. Two exist, but nothing assumes exactly two.
- `public/worklets/stretch-processor.js` — **owns playback position**. Play,
  pause, seek, tempo and pitch are messages; the playhead is reported back at
  30 Hz. WSOLA time-stretch with an independent resampling stage for pitch.
- `public/worklets/recorder-processor.js` — PCM tap.
- `src/analysis/analysis.worker.ts` — BPM (onset autocorrelation) and key
  (chroma + Krumhansl-Schmuckler), off the main thread.

React mirrors the engine through `useSyncExternalStore`; the engine is the
source of truth. Playhead position deliberately never flows through React — the
canvas rAF loop reads `deck.positionFrames` directly, so animating waveforms
cost zero renders.

## Deviations from the spec

1. **WSOLA implemented inline instead of SoundTouch WASM.** An AudioWorklet is a
   classic script and cannot `import`, so using the library would have meant a
   separate bundle step, and `soundtouchjs` is LGPL, which is worth avoiding in
   something you may want to monetise. The algorithm is the same family with
   SoundTouch's own default parameters. `produce()`/`findOffset()` are the swap
   point — the message protocol is the interface.
2. **Self-contained BPM/key analysis instead of Essentia.js.** The spec already
   sanctions this fallback for BPM; it is extended to key for the same reason —
   a ~4 MB WASM payload for two numbers that take ~200 ms of plain JS. Same
   swap-point note applies.
3. **`useSyncExternalStore` instead of Zustand** (the spec allowed "or plain
   React context"). Zustand would duplicate engine state; this mirrors it.
4. **Automatic beat-grid phase alignment shipped, not deferred.** The spec lists
   it as a stretch goal. Tempo-matching alone does not save a child who taps
   play on the off-beat, so it ships.
5. **Drums are synthesized, not a sample pack.** The spec asks for a curated
   808/EDM pack. Shipping unlicensed samples would foreclose the monetization
   paths the project cares about, and there is no licensed pack to hand. Each
   voice is a `(ctx, dest, time, gain)` one-shot in `src/audio/drums.ts` — buying
   a pack later means replacing the bodies with buffer playback and nothing else.
6. **Own scheduler instead of Tone.js.** The spec allows Tone for transport
   where it saves time, but mixing its transport with this engine's clock costs
   more than the ~90-line lookahead scheduler in `Transport.ts`, and keeps the
   engine the single source of truth.

## Verified

Measured against synthesized test tracks with known ground truth:

- BPM: **119.7** detected vs 120 true; **100.4** vs 100 true.
- Key: A minor and D♭ major both identified correctly from their triads.
- Beat lock: phase error **0.427 → 0.0000 beats** on `play()`, with tempo
  auto-matched +19.22% to land on 119.70 vs 119.70.
- Bass swap: measured at five crossfader positions, symmetric, 0 → −15 dB.
- Harmonic nudge: picks the minimum shift, refuses shifts beyond ±2 semitones,
  never moves the anchor deck.
- Recording: valid RIFF/WAVE, stereo, 48 kHz, 16-bit; decodes back cleanly;
  peak 0.404 (headroom held, no clipping).
- Playback rate 1.000 with both decks running and phase-locked.
- Every keyboard shortcut, by dispatched key event: space, Q/W/E/R and U/I/O/P
  cues (set, then jump from elsewhere), Z/X and N/M nudge, arrow crossfader.

Phase 2:

- Beat machine locks to the song: transport 119.70 BPM against the deck's
  119.70, with the drum grid **2.7 ms** off the song's beat grid — an order of
  magnitude under the ~10 ms where a flam becomes audible.
- Sub root resolved to A against a track detected as A minor.
- Filter sweeps 20 kHz → 320 Hz and back on release; echo send 0 → 0.45 with the
  delay at 0.3759 s, a dotted eighth at 119.7 BPM; stutter gates and restores.
- Drop cuts the gate to 0 exactly half a beat before the next downbeat and
  returns to 1 on it, measured across a 22-sample trace.
- Party Mode pads verified through dispatched pointer events, not just the API:
  beat layers toggle, hold FX engage and release, groove chips switch.

Product pass:

- One tap to music: **755 ms** from tapping a jam to both decks loaded,
  analysed, looping and playing (was ~7 s before the render cache and pre-warm).
- Two jams tapped back to back auto-mashed: Moonwalk pulled +8.7% to land on
  100.00 BPM against Sunbeam's 100.00, phase error **0.0089 beats**, and 8B/8A
  correctly recognised as relative major/minor so no pitch nudge was applied.
- Melody pad generated C major chords against the C major jam, with the
  transport locked at the jam's 100 BPM.
- Layout: no horizontal overflow and no vertical scrolling at 375x812 (phone,
  pads 63x57) or 768x1024 (tablet, pads 113x76, song tiles 362x132).

## Vocals and hooks

Each deck can play the whole mix, **just the music** (centre cancelled) or
**just the vocals** (centre isolated, band-limited) — so you can loop the chorus
of one song over the instrumental of another. The 🔁 Hook button loops the
most-repeated section of a track.

**Finding the chorus needs no lyrics.** Choruses repeat, and repetition shows up
as self-similarity in the chroma sequence the key detector already computes. We
find the lag whose shifted sequence matches best (the section period), then the
window that matches best at that lag, then snap it to the beat grid. On a test
track with 8-bar A-B-A-B-A-B structure it returned a 16.04 s hook (8.02 bars)
starting at 15.31 s against a true section boundary of 16.0 s.

**Separation is currently mid-side, not a model.** Lead vocals are almost always
centre-panned, so the side signal (L−R) cancels them. Measured on a track with a
centre 440 Hz "vocal" and hard-panned 300/700 Hz "music", centre-cancel dropped
the vocal by **−40 dB** (0.2311 → 0.0023) while the music doubled. It is honest
about what it is: kick, snare and bass are centred too and go with the vocal, and
reverb stays behind. The isolate direction is cruder still — panned content
survives at about −6 dB, so it reads as "centre-emphasised" rather than a true
acapella.

The three paths sit behind one switch in `Deck.setVocalMode`, so replacing them
with an ONNX separation model (onnxruntime-web, MIT) changes nothing downstream —
not the EQ, the crossfader, the recorder or the UI.

## How to test this by ear

Every number in this README is measured, but nothing here has been *listened*
to. These are the things instruments cannot settle, roughly in order of what
would change the plan:

1. **Two jams together.** Party Mode, tap a jam on each tile. They should sound
   locked, not flanging or drifting. This exercises beat-lock and phase align.
2. **Time-stretch artefacts.** Mash a slow jam against Rocket Fuel (128 BPM) —
   that is a ~28% stretch, well past the ±8% the WSOLA parameters are tuned for.
   Listen for warbling or a "underwater" quality on the stretched deck. If ±8%
   is clean and only the extreme stretch warbles, that is expected and fine.
3. **Vocal removal on a real song.** Load an actual track, hit **No vox**. The
   question is whether it sounds like an instrumental or like a hollow, phasey
   mono version with the drums gutted. This decides whether the 108 MB ONNX
   model is worth adding — nothing else does.
4. **Does 🔁 Hook land on the chorus?** It finds the most-repeated section,
   which is usually but not always the chorus.
5. **Record something and play the WAV back.** It should match what you heard,
   including fader moves, with no clipping.

Real MP3/M4A files have never been through the decoder here — only synthesized
WAV. If something breaks on a real file, that is the first place to look.

## Known limitations

**Key detection is unreliable on dense percussive material.** Measured against
the four jams, whose keys are known exactly: 1 of 4 correct. Percussion is
broadband, so drum-heavy frames smear energy across all twelve pitch classes.
Normalizing chroma per frame (so a loud kick counts no more than a quiet chord)
fixed the pitch *collection* — Sunbeam moved from B minor to A minor, the
relative minor of the true C major — but the detector still tends to pick a
chord from the progression rather than the tonic. Distinguishing a key from its
relative major/minor is genuinely ambiguous from chroma alone.

Two consequences worth knowing:

- Built-in jams do not rely on detection at all. Their BPM, key and downbeat are
  authored facts passed in via `loadBuffer(..., { known })`, so they are exact.
  Loudness is still measured, because that one really is a property of the audio.
- For user-supplied files the key readout should be treated as a hint. The
  practical damage is limited: Camelot treats a key and its relative as
  compatible, so a relative-key error does not change mixing behaviour. A wrong
  *tonic* can cost an unnecessary harmonic nudge — worth turning that assist off
  if a mix sounds off-key. BPM detection, by contrast, measured within 0.5% on
  every track tested.

## Not yet verified

Stated plainly because these are real gaps, not oversights:

- **No listening test.** Time-stretch artefact quality at ±8% is unassessed by
  ear — the spec's acceptance check for this needs a human.
- Only synthesized WAV has been decoded. Real MP3/M4A/FLAC untested.
- Longest recording verified is 11.9 s, not the spec's 10 minutes.
- Frame rate and input latency are not instrumented; the 60 fps and ~30 ms
  targets are designed for but unmeasured.
- Backgrounded-tab behaviour and touch/iPad untested.

## Notes for whoever runs this next

Two config traps cost real time here, both now pinned in the repo:

- Tailwind's PostCSS plugin resolves `tailwind.config.js` from **`process.cwd()`**,
  not from the config's own location. Launch Vite from another directory and it
  silently falls back to an empty config: preflight still applies, so the page
  looks styled-ish and nothing errors, but no utility classes exist.
  `postcss.config.js` now passes the config path explicitly.
- Tailwind globs via fast-glob, which treats `\` as an escape character, so a
  Windows `path.join()` content glob matches nothing. The config builds its
  globs with forward slashes.

## Roadmap

- **Phase 2 — done.** Beat machine as a third source on the master bus, FX and
  build/drop macros, and Party Mode.
- **Phase 3** — stem separation via a Demucs backend; stems become deck-like sources.
- **Phase 4** — sound-mashing lab (envelope splicing) and a Capacitor wrap for
  iPhone/iPad.
