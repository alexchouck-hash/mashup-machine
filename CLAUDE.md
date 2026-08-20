# Mashup Machine

A browser-based **live music performance tool**. Two decks of the user's own audio, beatmatched
and mixed in real time, plus a Party Mode with scratchable platters, a loop pedal and a beat
machine. React 18 + TypeScript + Vite + Tailwind, raw Web Audio, no backend, no dependencies
beyond `react` and `react-dom`.

Everything is real-time. Recording is a tap on the master bus, not a timeline editor.

## Hard product constraints — do not violate

1. **No streaming-service audio.** Spotify / Apple Music / YouTube do not expose raw audio and
   must never be used as sources. Audio comes from user-imported local files only.
2. **Recording is export-only.** WAV to the user's own device. No upload, no sharing, no accounts.
3. **All processing is client-side.** No backend.
4. **Audio starts only from a user gesture.** `engine.init()` has exactly one call site:
   `App.start()` behind the Start button.
5. **Audio never leaves the device.** Files are decoded locally and never uploaded.

## Running and verifying

```bash
npm run dev
```

Port 5173, pinned in `vite.config.ts` and `.claude/launch.json` (preview name: `mashup-machine`).
`npm run build` runs `tsc --noEmit` first, so a type error fails the build. `npm run typecheck`
runs that check alone. **There is no test runner and no linter.** Verification is by ear plus
`npm run typecheck`; see `README.md` § "How to test this by ear".

Audio only works on `https://` or `localhost` — AudioWorklet is gated behind a secure context, so
a LAN IP silently has no sound. `App.audioBlocker()` checks this up front.

### The browser-tab rule

**Never start playback in a preview tab and leave it running.** This app makes real sound out of
the user's speakers, and it is loud, looping and unattended by design — a scratch gesture, a
committed loop take or a beat-machine groove will keep going forever. Before ending a turn or
moving on: pause transport, and stop the preview server (`preview_stop`) or navigate the tab away.
The same applies to `computer` clicks that hit a pad, a platter or the Start button. If you must
leave something playing to observe it, say so explicitly in your reply so the user can kill it.

Prefer `read_page`, `read_console_messages` and `javascript_tool` for verification. A screenshot of
the UI is cheap; audible playback is not.

## Architecture

```
Deck (stretch worklet) ─> mid/side split ─> EQ ─> HPF/LPF ─> deck.output ─┐
                                                                          ├─> xfA|xfB ─> deckDuck ─> deckBus ─┐
BeatMachine.output ─> drumLow ─> drumDrive ─> drumTrim ────────────────────────────────────────────────────────┤
                                                                                                               ├─> sumBus
                                                                                                               │
sumBus ─> fxFilter ─> fxGate ─> macroGain ─> masterGain ─> limiter ─> analyser ─> destination
                       └─> Fx ping-pong delay ─> macroGain          └─> recorder worklet
oneShotBus ─────────────────────────────────────> masterGain   (joins AFTER every gate, on purpose)
```

- `export const engine = new AudioEngine()` in `src/audio/AudioEngine.ts` is a **module singleton**.
  No context, no provider, no Zustand. Components import it directly.
- The **engine is the source of truth; React mirrors it** through a monotonic version counter and
  `useSyncExternalStore` (`src/hooks/useEngine.ts`, 13 lines — that is the whole bridge).
  Components call `useEngineVersion()` then read engine fields as plain property accesses, and
  write by calling engine methods. **Components never call `engine.notify()`** — the engine method
  does it as its last statement.
- `useState` is for UI-local state only (mode, focused deck, drag highlight). Never mirror engine
  state into React state.

Deep docs, all worth reading before touching their area:

| Doc | Covers |
| --- | --- |
| `README.md` | What it does, Party Mode, deviations from spec, what is verified, known limitations |
| `docs/PLATTER_OWNERSHIP.md` | The full platter design, review findings, five release paths |
| `docs/spec.md` | Original Phase-1 spec — **historical**, the code is well past it |
| `docs/SAMPLES.md` | Sample kit sourcing and licensing |
| `docs/evidence/` | Investigation write-ups; written once, never edited |

## Audio invariants

Break these and the app degrades in ways that are hard to hear and harder to trace.

- **No `engine.notify()` on per-frame paths.** Platter move/spin, `Platters.tick`, the `'pos'`
  worklet echo, `TakeLooper.tap`, sidechain steps — all explicitly forbidden. Only
  `Platters.settle()` notifies, on acquire and release.
- **`Deck.positionFrames` is a plain mutable field** read directly by canvas rAF loops. It must
  never flow through React.
- **Nothing allocates in `process()`.** The one deliberate exception is the recorder's per-block
  `Float32Array`, which is transferred rather than copied.
- **Nothing may throw into a step handler.** `Transport.tick` has no try/catch, so one throw stops
  the clock forever *and* kills every handler registered after it. Handlers wrap themselves and
  mark themselves dead after repeated failures. Register handlers separately, never as one.
- **A step handler must not light UI** — it runs up to 120 ms early. Write the intended time into
  state and let rAF turn it into a glow when the moment arrives.
- **Gain moves are absolute-time AudioParam automation, never timers.** The shared transport can
  stop mid-macro; automation already on the timeline does not care.
- **Gain staging is derived, not tuned by ear.** `MASTER_HEADROOM = 0.5`, `BeatMachine.volume =
  0.52`, the bump-boost margins — each is a worked calculation in a comment above it. If the master
  limiter ducks, it ducks the *decks*, which sounds like a child's song pumping on every downbeat.
  Change a level only by redoing the arithmetic in the comment.
- **The recorder taps the limiter output**, so the WAV is exactly what was heard, post-volume and
  post-limiter. Moving the tap to `masterGain` or `analyser` breaks that guarantee. Its
  `connect(destination)` is silent but required — a node must be pulled for `process()` to run.
- **Param ownership is exclusive** (table at the top of `AudioEngine.ts`): `fxGate`/`fxFilter` are
  Fx's alone, `macroGain`/`deckBus`/`deckDuck`/`drum*` are Macros' alone, `deck.output.gain` is
  `Deck.applyGain`'s alone. Two writers on one param is the bug you will not find by listening.
- `new Deck(...)` dereferences `engine.ctx`, so **`createDeck` is only legal after `await
  engine.init()`**.
- `clamp()` is not NaN-safe. Every caller-supplied number goes through `fin()` first — Web Audio
  throws on non-finite values, and a throw mid-schedule parks the master gate at 0.

## Platter ownership

The scratchable record. The full design is `docs/PLATTER_OWNERSHIP.md`; this is the part you must
not violate without reading it.

- **One door.** `Deck.platterPost(lease, msg)` is the only place a scratch message is posted, and
  `if (this.heldBy !== lease) return;` is the entire ownership guarantee. It is per-deck.
- **Ranked claims:** `{ primary: 3, secondary: 2, macro: 1 }`. Higher wins, **equal loses** (the
  test is `<=`).
- **Owner's ruling: preempt — the finger always wins.** A record that ignores a child's hand
  because a macro is mid-automation reads as broken. Safe-but-dead is the worse failure.
- **Only two acquire call sites exist:** `KidsMode.tsx` (`acquireFinger`) and `macros.ts`
  (`acquireMacro`). `Deck` has no scratch methods any more. Do not add a third door.
- **Ordering is the design.** Preemption is synchronous and happens before the new owner exists;
  `loseClaim` clears the claim *before* calling `onRevoked`; `revoke(this, 'unloaded')` must be the
  first line of `adopt()` and `unload()`; `scratchOn` is posted unconditionally on claim.
- **The 3.0 s lease deadlines are sized for background timer clamping**, not for a miss count. Both
  the main-thread sweep and the worklet TTL say so in comments. Do not tighten them.
- There is deliberately **no keepalive interval in the registry** — the ping must be a side effect
  of the driver's own loop, or a macro that throws mid-gesture renews the TTL forever.

## Timing

`Transport` owns the clock: a 16th-note grid, `LOOKAHEAD_MS = 25`, `SCHEDULE_AHEAD = 0.12`,
scheduling against `AudioContext.currentTime`. Once per beat it consults the anchor deck and either
snaps (error > 25 ms) or tracks (±4 ms of drift authority). A deck under a hand is never a tempo
reference — `platterBusy` suppresses correction.

`Transport.rateScale` has **exactly one writer**, `Platters.applyGrid`, derived from the worklet's
echoed velocity normalised by `nominalRate`. Adding a second writer reintroduces a fixed unit bug.

Loop takes quantise to sixteenths and snap to a power-of-two number of bars, capped at 8. Playback
position is `absStep mod L` with no per-take origin — that is what keeps takes of different lengths
locked together forever.

## UI conventions

- **Pointer Events only.** No `touchstart`/`mousedown` anywhere. `setPointerCapture` is wrapped in
  try/catch — "capture is an optimisation, not a requirement" is a repo idiom, verbatim, in four
  places.
- **Anything that moves at frame rate is canvas or a direct DOM style write inside an rAF loop.**
  Seven such loops exist, each with `cancelAnimationFrame` cleanup. Static art is rendered once
  into an offscreen canvas and blitted.
- **Runtime-variable styling goes through CSS custom properties** (`--pad`, `--lit`, `--thumb`),
  never generated class names. **Element state is `data-*` attributes styled in CSS**, not
  conditional classes — rAF loops write them directly.
- Tailwind utilities inline for layout and colour; `.panel`/`.btn`/`.btn-on`/`.lbl` from
  `@layer components` instead of repeating utility stacks; hand-written CSS in `index.css` for the
  Party Mode hardware surface and anything Tailwind cannot express. Two specificity workarounds in
  `index.css` are commented "do not simplify" — believe them.
- Named exports for components (only `App` is default). `import type` for type-only imports.
  Module-level config as `SCREAMING_SNAKE` consts at the top of the file, each with a comment
  explaining the number.
- `tsconfig` is `strict` plus `noUnusedLocals`/`noUnusedParameters`. `React.StrictMode` is on, so
  every effect double-mounts in dev — rAF loops and gestures must be idempotent.
- KidsMode ("Party Mode") is a whole alternative tree, not a route or overlay: `mode` state in
  `App.tsx`, all assists forced on, keyboard shortcuts disabled, no numbers anywhere on screen.
  Both modes share the same engine and deck instances.

## Writing code here

**Match the comment idiom — it is the most distinctive convention in the repo.** Comments explain
*why*, name the failure mode avoided, and cite measurement or an owner decision. Not "clamp the
value" but "at dpr 3 a 220 px platter is a 1.7 MB texture resampled 60 times a second for detail
nobody can see." A comment that restates the code will read as foreign here.

Errors that could look like a dead button are logged with a bracketed tag and never swallowed:
`console.error('[engine] init failed', err)`. A button that does nothing is the worst possible
failure — say why.

Commit subjects are sentence-case and descriptive, no prefixes or Conventional Commits:
"Platter ownership: one door, ranked claims, finger always wins".

## Known stale spots and open work

- `BeatMachine`'s docstring claims it joins via `engine.addSource(output, null)`. It does not — the
  engine hand-wires it through `drumLow → drumDrive → drumTrim` so the drum path can be shaped.
- `macros.ts` detects an optional `deckLow`/`deckPre`/`deckDrive` shaper at runtime. `AudioEngine`
  never creates those nodes, so it is null today and bump boost degrades gracefully. Adding them
  changes the headroom arithmetic.
- `PlatterEvent` has no subscriber, and `Fx.scratchNoise*` has never been called.
- **The loop-pedal timing defects are diagnosed but not fixed.** Four confirmed problems — takes
  drifting from where they were played, long dead air after the last beat, no crop/fit-to-measures
  control, and evenly played beats coming back limping because of the quantise snap. Full evidence
  with worked traces: `docs/evidence/2026-08-16_loop-pedal-timing-diagnosis.md`. Read it before
  attempting a fix; the quantise defect is upstream of the crop defect and a length control alone
  will not repair it.
