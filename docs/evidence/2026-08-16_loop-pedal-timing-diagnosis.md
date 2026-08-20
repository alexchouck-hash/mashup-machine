# Loop-pedal timing: diagnosis

Four independent lenses, workflow `wf_12c0f729-4d4`, 2026-08-16.

The design, implement and verify phases died on a session limit. This is
DIAGNOSIS ONLY - no code was changed. Evidence doc: written once, never edited.

Reported by the owner, verbatim, in the first real listening test:

1. "successive beat layers move from where I play the beats"
2. "the first layer is difficult to loop too with a consistent beat because the silence after the last beat is long typically"
3. "It needs to auto crop or I need to be able to crop. It needs to fit to measures."
4. "let's say I play 3 regular beats or a pattern. I need that pattern to repeat on beat"


---

## Lens 1

Lens 4 of 4 — the crop control and the UI surface. What loop-pedal controls exist today, where a length/crop control can go, and whether re-lengthing a committed take is possible with the current data model without breaking the rAF loop.

### Worked example

```
120 bpm: 1 step = 125 ms, 1 beat = 4 steps = 500 ms, 1 bar = 16 steps = 2.000 s. maxBars = 8 (BeatMachine.ts:303).

CROP TRACE — child taps five quarter notes over 1 bar + 1 beat (2.500 s of playing), landing after quantise on pos = [0, 4, 8, 12, 16].
  build() line 842-850: lo = 0, hi = 16, span = hi - lo + 1 = 17.
  ceil(17 / 16) = 2 -> pow2AtLeast(2, 8) = 2 bars -> L = 32 steps.
  Placement line 867: steps 0, 4, 8, 12, 16.
  Playback: last hit at step 16, loop restarts at step 32.
  TAIL = 32 - 16 = 16 steps = 2.000 s of dead air after a 2.500 s phrase. 50% of the loop is the hole, and the hole is not a musical rest the child played — it is the gap between "where the last hit fell" and "the next power-of-two bar line". That is report (2) verbatim: "the silence after the last beat is long typically."
  UI CONSEQUENCE, which is my lens: drawStrip (KidsMode.tsx:749-758) now draws L = 32 as beats = round(32/4) = 8 ticks with bright lines at i = 4 only, and the take-bar (KidsMode.tsx:1021-1070) renders the word "Looping", a "Clear last" button, a "Reset beats" button, and ONE 20x12px colour chip. Nowhere on screen is the number 2, the word "bars", or any control that can make it 1. The child's only recourse is "Clear last" and play it again — which is the entire content of report (3).

QUANTISE TRACE, same take, showing why the crop control cannot be the only fix — four quarter notes played at raw grid 0.00, 4.35, 7.60, 12.10 (i.e. +/-60 ms of human error, well inside normal):
  phaseShift(grid, q=1) line 326-342: circular mean of frac {0.00, 0.35, 0.60, 0.10} -> sumCos = 0.412, sumSin = 0.809 -> centre = atan2(0.202, 0.103)/2pi = 0.175.
  residuals = wrapTo(grid - 0.175, 1) = [-0.175, +0.175, +0.425, -0.075]; sorted median = (-0.075 + 0.175)/2 = 0.050.
  shift = wrapTo(0.175 + 0.050, 1) = 0.225.
  pos = round((grid - 0.225)) = [0, 4, 7, 12].
  The third beat commits to step 7 (875 ms), not step 8 (1000 ms). Intervals 4, 3, 5 steps = 500, 375, 625 ms. Four beats a child played evenly come back LIMPING by 125 ms, and no length control can repair that — it is fixed upstream in the snap grid. Report (4).
```

### Findings

**[certain]** There is no loop-length or crop control anywhere in the app, and no readout of a committed take's length — LoopSurface's entire control set is 'Clear last', 'Reset', and decorative colour chips.

- `C:\Users\houck\mashup-machine\src\components\KidsMode.tsx:1021`
- explains: (3) "It needs to auto crop or I need to be able to crop. It needs to fit to measures." — the 'or I need to be able to crop' half has no surface at all today.
- evidence: The take-bar is the whole control surface: `<span className="take-hint">` (rAF-written text: 'Tap, then wait' / 'Listening…' / 'Looping'), then `<span className="take-acts">` holding exactly two buttons — `onClick={() => { looper.clearLast(); disarm(); }}` and the armed reset `onReset` — then the chip row. The legend-bar above it (1096-1141 drums, 1268-1334 keys) holds mute, drum pack / instrument, octave, Tune, Beat, Auto-beat: not one of them touches take length. BeatMachinePanel.tsx (the DJ-mode surface) renders grooves, layers, level and FX and never references `bm.drums` or `bm.keys` at all, so the loop pedal UI exists ONLY here. A grep for `looper|clearLast|resetAll|loopSteps` across src/components returns hits in KidsMode.tsx only. The child has no way to see that their loop became 2 bars, and no way to make it 1.

**[certain]** Re-lengthing a committed take IS possible and non-destructive with the current data model: `Take.raw` holds every unquantised tap with its grid position already resolved and written back at commit, so a take can be REBUILT at a new length rather than resampled.

- `C:\Users\houck\mashup-machine\src\audio\takeLooper.ts:128`
- explains: (3) — this is what makes a crop control implementable at all.
- evidence: `Take.raw: Tap<S>[]` — "The unquantised taps, kept so the UI can animate the snap at commit." build() line 820 does `taps[i].grid = safe` and line 895 stores `raw: taps` — the SAME array — so after commit every `take.raw[i].grid` is the exact fractional absolute step that produced the committed hit. A new length L' therefore needs no interpolation of `byStep`: recompute pos/frac from `raw[*].grid` and re-bucket, exactly as build() lines 826-886 do. Crucially this makes length REVERSIBLE — shrinking may discard hits from `byStep`, but `raw` is untouched, so doubling back restores them bit-exact. That is the property that lets a child mash a bar-count chip with no undo anxiety.

**[certain]** build() cannot be reused verbatim for a rebuild: its epoch-staleness branch re-derives tap positions through the CURRENT stepDuration, so a bpm change between commit and re-length silently rescales the take's rhythm.

- `C:\Users\houck\mashup-machine\src\audio\takeLooper.ts:805`
- explains: none — this is a defect a naive implementation of the crop control would introduce, not one the user reported.
- evidence: Lines 805-821: `const epoch = this.clock.epoch; ... if (taps[i].epoch !== epoch) stale = true` then `const g = stale ? this.clock.gridAt(taps[i].at) : taps[i].grid`. Any transport stop/start bumps the epoch (GridClock.observe line 273), so a rebuild after a restart takes the `stale` branch. gridAt (line 283-287) is `absStep + (t - stepTime) / sd`. Trace: take committed at 120 bpm (sd = 0.125) from ctx times 100.0 / 100.5 / 101.0 -> grid spacing 4 steps. Transport restarts, bpm now 90 (sd = 0.1667), stepTime = 200.0, absStep = 0. gridAt gives -600.0 / -597.0 / -594.0 — spacing 3 steps. After the `- lo` normalise at line 867 the take commits as 0, 3, 6: three quarter notes become three dotted eighths. The fix must read `raw[i].grid` verbatim and never call gridAt again. Note the origin shift alone is harmless (line 867 subtracts lo), so this fails ONLY on a tempo change — which is exactly the failure that looks fine in testing and wrong at a party.

**[certain]** `Take` records no quantise flag, so a rebuild re-reads `config.quantised()` live and would retroactively un-quantise a keyboard take that was committed with Beat ON.

- `C:\Users\houck\mashup-machine\src\audio\takeLooper.ts:823`
- explains: none — a defect the crop control would introduce.
- evidence: `const quantised = this.config.quantised();` — on the melody surface that is `() => this.beatMatch` (melodyLooper.ts:179), a LIVE toggle the child can flip from the legend bar (KidsMode.tsx:1325-1333). Nothing in the `Take` interface (lines 118-129: id, steps, byStep, gain, color, raw) remembers which branch ran. A child who loops a phrase with Beat on, turns Beat off to noodle, then taps the length chip gets their committed loop re-scattered off the grid — a length control silently becoming a timing control. Same hazard for `q` if a coarser snap is ever added. `Take` needs a stored `quantised: boolean` (and `q`) in the same change; per the repo's own rule this is a schema change, and the two readers outside takeLooper.ts are BeatMachine.collectBoomSteps (BeatMachine.ts:440-450) and KidsMode's drawStrip/buildSlide, neither of which caches anything derived from `steps`.

**[certain]** The position strip draws the LONGEST take's length, not the newest take's, so a 1-bar take inside a 4-bar strip is drawn four times and is visually indistinguishable from a genuine 4-bar take — the child cannot verify what auto-crop decided.

- `C:\Users\houck\mashup-machine\src\components\KidsMode.tsx:749`
- explains: (3) — the 'auto crop' half needs a visible readout or the child cannot tell it happened.
- evidence: `const L = Math.max(16, l.loopSteps() || 16);` where loopSteps() (takeLooper.ts:486-492) returns `max(take.steps)` over the whole stack. Then line 789 `const reps = Math.max(1, Math.round(L / steps));` and 794-796 draw each hit `reps` times. So a 1-bar take on a 4-bar strip paints its marks at 0.00, 0.25, 0.50, 0.75 of the strip — identical to a child who genuinely played the same figure four times. This is why auto-crop alone does not close report (3): the child gets no feedback about the length that was chosen, which is precisely the condition under which they reported the machine 'moving' their beats. A bar-count readout adds information the canvas structurally cannot.

**[certain]** The take chips are the natural per-take affordance but cannot carry the control: they are aria-hidden non-interactive spans at 20x12px, far under the 44px target every other control in this file uses.

- `C:\Users\houck\mashup-machine\src\components\KidsMode.tsx:1058`
- explains: none — a design constraint on the fix.
- evidence: `<span className="take-chips" aria-hidden="true">` containing `<span className="take-chip" data-newest=... style={{'--c': t.color}} />` — plain spans, no onClick, hidden from assistive tech, and the file's own comment calls them "Decoration". index.css .take-chip is `width: 20px; height: 12px`. Against .key at 44px (index.css ~429 area, .key--sm is 34px and carries a comment apologising for being under WCAG's 44px on the ONE route back to the picker), a 20x12 tap target for a seven-year-old is a miss. A per-take length control therefore has to be a `.key--text` button, not a chip — which in turn means it acts on ONE take, and the only take the UI already has an unambiguous referent for is the newest (that is what 'Clear last' means, and what `data-newest='true'` outlines).

**[certain]** A length change needs exactly ONE React notify and zero rAF changes: everything length-dependent on the canvas is already recomputed per frame, and the take-bar's React content re-renders on the same discrete-change path commit already uses.

- `C:\Users\houck\mashup-machine\src\components\KidsMode.tsx:892`
- explains: none — this is the answer to 'does a length change break the rAF loop': no.
- evidence: drawStrip recomputes `L` (749), `beats` (753) and `reps` (789) on every call, so a new `take.steps` is on screen on the next frame with no React involvement — the strip is fully derived. paintSurface's only cached length-adjacent state is `f.takes = l.takes.length` (892). The React half (the chip row at 1058, and any new label) re-renders through `useEngineVersion` -> `engine.notify()`, which the looper already fires on every discrete change via `hooks.changed()` (takeLooper.ts:631, 650, 660 -> BeatMachine.onTakesChanged:453 -> engine.notify). So a re-length reuses that exact path: one notify, same as a commit, and the file's stated rule "React re-renders only on discrete events" (KidsMode.tsx:33-37) is preserved. A length READOUT must therefore be React-rendered from `takes[takes.length-1].steps`, never polled in the rAF loop.

**[certain]** An in-flight commit animation would animate to stale positions if a length change lands inside its 200 ms window; the fix must null `f.slide`.

- `C:\Users\houck\mashup-machine\src\components\KidsMode.tsx:895`
- explains: none — a defect the crop control would introduce.
- evidence: `f.slide = grew ? buildSlide(l, now) : null;` fires only when `l.takes.length !== f.takes` AND grew. A re-length changes neither count, so an existing slide survives — and buildSlide computed its `to[]` against the OLD L (`const L = Math.max(16, l.loopSteps() || 16)` at 691, `dest.push((h.step + h.frac + r*steps)/L)` at 699). Meanwhile drawStrip line 787 skips the take being slid, so for up to SLIDE_SEC = 0.2 s the child sees the take's marks easing toward positions from the previous length. Small, but it lands exactly on the frame a child taps the new control, which is the worst possible moment for the strip to lie. Cheapest correct fix: track a signature (`take.id * 1e4 + take.steps`) instead of the bare count at 892, which both kills the stale slide and gives a free re-snap animation on the length change.

**[likely]** The smallest control with real power is one bar-count button in `.take-acts` that cycles the newest take 1 -> 2 -> 4 -> 8 -> 1; it needs no explaining because it shows a number that changes and the strip redraws under it.

- `C:\Users\houck\mashup-machine\src\components\KidsMode.tsx:1033`
- explains: (3) "or I need to be able to crop" — the manual half. The auto half belongs in build() and this chip is the escape hatch, which keeps the invariant that the default path is right with zero input.
- evidence: Exact insertion point is inside `<span className="take-acts">` (1033), immediately before the Clear last button (1034). It reuses the `.key key--text` chassis (index.css 919-928: `width:auto; min-height:40px; padding:0 11px`) so it is the same moulded key as its two neighbours, at a 40px target rather than 12px. It acts on the NEWEST take — the referent 'Clear last' already establishes and `data-newest='true'` already outlines — so it introduces zero new concepts. CYCLE, not halve-only: a child who overshoots gets back with the same finger, and the cap must read `config.maxBars` (8, BeatMachine.ts:303) rather than a literal. It must never be `disabled` — the file's own comment at 1028-1031 explains why (open-take state changes on a tap, which does not re-render React) — so with an empty stack it reads a dash and no-ops. A refusal at the cap can reuse the existing `notice` channel (takeLooper.ts:610-611, painted at 856-868), which expires on its own ctx clock. WIDTH BUDGET, stated as a fact not a blocker: at 360px the take-bar's inner width is ~320px and hint + two buttons already total ~300px, so a third button pushes `.take-acts` (flex:0 0 auto, margin-left:auto) onto its own line — the wrap index.css 857-860 already documents and designs for. It degrades, it does not clip. Do NOT put it in the legend-bar: that is `display:flex` with NO flex-wrap and no scroll container (index.css 156-161) and already carries legend + mute + 4-voice seg + 3-octave seg + Tune + Beat on the keys row, so a new child there squeezes the existing ones.

**[certain]** Shrinking a take FOLDS rather than crops with the current placement arithmetic, which is not what a child means by 'crop' — the control forces this semantic decision explicitly.

- `C:\Users\houck\mashup-machine\src\audio\takeLooper.ts:867`
- explains: (3) — 'crop' and 'fold' are different operations and the code currently only has fold.
- evidence: `const step = (((pos[i] - lo) % L) + L) % L;` with the comment at 856-860 stating the intent: "Past maxBars the take folds mod L. Nothing is discarded: later material overlays earlier at its true position in the loop." Halving a 2-bar take from L=32 to L=16 therefore stacks bar 2 on top of bar 1 — the child asked for a shorter loop and got a DENSER one. Correct behaviour for the maxBars overflow it was written for; wrong behaviour for a crop control. Crop = drop hits where `pos[i] - lo >= L`. That is safe precisely because of the `raw` finding above: the taps survive, so cycling back to 2 bars restores them exactly, and the destructive-looking operation is fully reversible. Worth noting the reverse direction is free: DOUBLING a take never loses anything, it just stops folding, so 1 -> 2 bars on an over-long phrase is a pure repair.

**[certain]** `LooperView` is the UI's structural contract with the engine, and MelodyLooper hand-delegates every member — a new length method must be added in both places or the keyboard surface silently loses it.

- `C:\Users\houck\mashup-machine\src\components\KidsMode.tsx:598`
- explains: none — an integration constraint for the fix.
- evidence: `interface LooperView` (598-612) declares takes/openTaps/flash/isOpen/notice/loopSteps/phase01/openRemaining01/clearLast/resetAll, and the file comment at 572-577 says it is deliberately structural so "the UI never imports the class". `bm.drums` is a raw `TakeLooper<number>` (BeatMachine.ts:296) but `bm.keys` is a `MelodyLooper` WRAPPER that re-declares each member by hand (melodyLooper.ts:330-380: clearLast, resetAll, onStep, phase01, openRemaining01, loopSteps, glow, flash, takes, openTaps, hasTakes, isOpen, notice). A new `setBars`/`bars` on TakeLooper alone would satisfy `bm.drums` and fail structurally for `bm.keys` — which is the good outcome, because it is a compile error at the `<LoopSurface looper={bm.keys}>` call site (1265) rather than a dead button on the keyboard. Adding the delegate is a one-liner; forgetting it is loud.


---

## Lens 2

LENS 1 — CROSS-TAKE PHASE / ORIGIN. Verdict: the orchestrator's DEFECT A is CONFIRMED, and it is worse than stated — it damages the FIRST take too, not only successive ones, and when two layers share a pad the second layer is not merely displaced but silently deleted. One sub-claim of the prior is REFUTED: phase01() and loopSteps() are not independently broken, and different-length takes DO still line up.

WHERE THE NUMBER COMES FROM AND WHERE IT IS READ BACK. Capture: tap() at takeLooper.ts:578 stores `grid: this.clock.gridAt(now)` — a fractional ABSOLUTE step. Commit: build() at :813-821 collects those absolute values, :824-840 phase-shifts and rounds them (still absolute), :842-850 derives lo/hi/span/L, then :867 does `step = (((pos[i] - lo) % L) + L) % L` — the ONLY place a take-relative coordinate is created. Read back: onStep() at :680 takes `abs = this.clock.absStep` and gather() at :727 indexes `take.byStep[((abs % L) + L) % L]`. There is no per-take origin anywhere — the Take interface (:118-129) has id/steps/byStep/gain/color/raw and nothing else. So the whole origin model is one subtraction at :867, and its inverse is never applied at playback. A take is replayed at `pos - lo` where it was played at `pos`: the entire layer is translated by `-(lo mod L)` steps, permanently.

WHAT A CORRECT ORIGIN MODEL MUST CHANGE.

MODEL A (minimal, recommended) — anchor to the absolute grid: :867 becomes `const step = ((pos[i] % L) + L) % L;`. Because L is always a power-of-two multiple of 16 and gather() already indexes `abs % L`, this needs ZERO change in gather(), onStep() or phase01(): a hit sounds at exactly the absolute step it was played on, mod L. It also fixes the UI for free — KidsMode.tsx already draws raw taps (:708) and open taps (:812) in ABSOLUTE coordinates while drawing committed hits (:699, :796) in take-relative ones, so the two coordinate systems currently differ by exactly `lo mod L`. Costs: the comment at :861-866 ("the loop starts at the left, where the child started playing") becomes false and must be deleted; a phrase whose first hit is a pickup before a bar line will wrap around the loop end, which is musically correct and which the strip already renders correctly through `mod()`.

MODEL B (full per-take origin) — add `origin: number` to Take and make gather() index `byStep[(((abs - take.origin) % L) + L) % L]`. This is the ONLY version that forces changes outside build(): gather() subtracts per take, and phase01()/loopSteps() must publish a reference origin (the longest take's) so KidsMode can draw every take AND every open tap relative to it, or the strip and the audio disagree. It buys nothing over Model A unless origins are allowed to be non-multiples of L — and allowing that breaks the cross-length lock-up invariant, because a 1-bar take at origin 6 against a 4-bar take at origin 0 no longer holds a fixed relation to the bar line. Constrain origin to a multiple of L and Model B collapses into Model A. Recommend A.

WHAT NEITHER MODEL FIXES: GridClock.observe():274 re-bases absStep across a transport stop/start to `(floor(abs/16)+1)*16 + step`, which preserves `abs % 16` but not `abs % 64` or `abs % 128`. Every committed 2/4/8-bar take rotates by a whole number of bars across a restart. Under Model A this is inherited unchanged; under Model B every stored origin must be shifted by the same delta. Proper fix: have GridClock publish the re-base delta, or snap the re-base to a multiple of maxBars*16 = 128.

### Worked example

```
120 bpm, stepDuration = 60/120/4 = 0.125 s, bar = 2.000 s. T0 = ctx time of absolute step 0. Drums config: quantiseSteps 1, idleSec 3.0, maxBars 8.

--- TAKE 1: taps at abs 6, 10, 14 (ctx T0+0.750, T0+1.250, T0+1.750), pad BOOM.
build(): q=1. phaseShift([6,10,14],1): all theta = 2*pi*integer, so sumSin=0, sumCos=3, centre = atan2(0,1)*1/(2pi) = 0; residuals wrapTo(6,1)=0, wrapTo(10,1)=0, wrapTo(14,1)=0; median 0; shift = 0.
pos = [6,10,14], frac = [0,0,0]. lo=6, hi=14, span = 14-6+1 = 9. bars = pow2AtLeast(ceil(9/16)=1, 8) = 1, so L = 16.
Line 867: step = (6-6)%16 = 0, (10-6)%16 = 4, (14-6)%16 = 8. byStep[0], [4], [8] filled; the other 13 buckets empty.
Commit fires ~3.0 s after the last tap = ctx T0+4.75, i.e. around abs 38.
Playback: gather(abs) reads byStep[abs mod 16], so hits fire at abs = 0,4,8 (mod 16). First scheduled sound: abs 40 (40 mod 16 = 8) at T0+5.000; then abs 48 -> T0+6.000, abs 52 -> T0+6.500, abs 56 -> T0+7.000.
PERFORMED bar-phases: 6, 10, 14.  REPLAYED bar-phases: 0, 4, 8.
The layer moved -6 steps = -750 ms. That is on the FIRST take, before any stacking. It also lands the first hit exactly on the canned kick: all three GROOVES (Party [0,4,8,12], Hip Hop [0,3,8,10], Trap [0,6,8,14]) have a kick on step 0.

--- TAKE 2: the child now HEARS take 1 on 0,4,8 and plays a counter-rhythm in the gap. Taps at abs 22, 26, 30 (bar-phases 6, 10, 14; phase 6 sits between take 1's audible 4 and 8).
(Caveat on the literal numbers: for these to be a SEPARATE take they must fall at least 24 steps after take 1's last tap, so in a real session they would be e.g. abs 86/90/94. The arithmetic below is identical, because line 867 only ever sees pos - lo.)
build(): pos = [22,26,30], lo=22, hi=30, span = 9, bars = 1, L = 16.
Line 867: step = (22-22)%16 = 0, (26-22)%16 = 4, (30-22)%16 = 8.
byStep[0], [4], [8] — BIT-FOR-BIT THE SAME TABLE AS TAKE 1.
Playback: fires at abs = 0,4,8 (mod 16) — simultaneous with take 1, forever.
PERFORMED relationship: take 2's first hit sat 2 steps = 250 ms after take 1's audible hit at phase 4. AFTER COMMIT that gap is 0. The counter-rhythm is gone; the two layers are in unison.
WORSE, if take 2 used the same pad: gather() at abs=0 loads take 1's hit (key = slot, frac 0), then meets take 2's hit with the same key and frac 0 — |0 - 0| = 0 <= MERGE_WINDOW_STEPS 0.25 — and keeps only the LOUDER of the two (takeLooper.ts:736-744). Layer 2 is not displaced, it is inaudible. Clear-last then changes nothing the child can hear.

--- THE GENERAL FORM. Line 867 subtracts the take's own minimum, so the committed table is INVARIANT under translation of the whole take: two takes with the same internal intervals produce identical byStep tables however far apart in the bar they were played. And since the hit at pos == lo maps to (lo-lo) = 0 always, byStep[0] is non-empty for EVERY take that ever commits. Every layer therefore has a hit pinned to abs = 0 (mod 16) — the downbeat, on top of the kick, on top of every other layer's first hit.

--- DIFFERENT LENGTHS (loopSteps()). Take A: L=16, hits at 0,4,8. Take B: 7 s of playing -> span 57 steps -> ceil(57/16)=4 -> bars 4, L=64, hits at 0,20,41,56. gather() uses each take's OWN L against the same absStep, and 16 divides 64, so A repeats exactly 4x inside B and their phase relation is fixed for the whole session. loopSteps() = 64; phase01() = (g mod 64)/64; drawStrip draws A four times at (step + r*16)/64 for r=0..3, which is exactly where it fires. All consistent. So YES, the shorter take still lines up — the alignment machinery is sound. What it aligns is wrong: both takes still carry a hit at step 0, so their first hits collide at abs = 0 (mod 64) and A's first hit lands on every bar line regardless of where in the bar it was played.
```

### Findings

**[certain]** build() normalises every take to its own first hit, so a committed layer is replayed translated by -(lo mod L) steps from where it was performed — pinning every take's opening hit to the downbeat and destroying the phase relationship between layers.

- `C:\Users\houck\mashup-machine\src\audio\takeLooper.ts:867`
- explains: (1) "successive beat layers move from where I play the beats" — and it also explains why layer ONE moves, which the report does not separate out.
- evidence: `const step = (((pos[i] - lo) % L) + L) % L;` creates the ONLY take-relative coordinate in the file, and nothing ever inverts it: gather() at :727 reads `take.byStep[((abs % L) + L) % L]` straight off the absolute clock, onStep() at :680 passes `this.clock.absStep` unmodified, and the Take interface at :118-129 (id/steps/byStep/gain/color/raw) has no origin field to invert with. Numerically: taps at abs 6,10,14 give pos [6,10,14], lo=6, span=9, L=16, steps 0/4/8 — performed at bar-phases 6,10,14, replayed at 0,4,8, a permanent -6 step = -750 ms translation at 120 bpm. Because the subtraction uses the take's own minimum, the table is invariant under translation: taps at abs 22,26,30 produce steps 0/4/8 as well — the identical table. Two layers a child deliberately interleaved come out in unison.

**[certain]** byStep[0] is non-empty for EVERY take that ever commits, so every layer's first hit fires on abs mod 16 == 0 — the same downbeat the canned groove's kick is on in all three grooves.

- `C:\Users\houck\mashup-machine\src\audio\takeLooper.ts:867`
- explains: (1) "successive beat layers move from where I play the beats" — the mechanism by which all layers converge to one point rather than merely drifting.
- evidence: The hit whose pos equals lo maps to `(lo - lo) % L` = 0 by construction, unconditionally. Since L is always a whole number of bars (`L = bars * STEPS_PER_BAR` at :850) and playback is `abs % L`, step 0 is always a transport bar line. GROOVES in BeatMachine.ts:32-63 put a kick on step 0 in Party [0,4,8,12], Hip Hop [0,3,8,10] and Trap [0,6,8,14], and onGrooveStep fires it at :496. So a child who plays a syncopated pickup gets it slammed onto the kick, and stacking six layers stacks six first-hits on the same instant — where gather()'s dedupe then thins them.

**[certain]** When a displaced layer collides with an earlier layer on the same pad, gather() deletes it rather than sounding it — the second take becomes completely inaudible, not just misplaced.

- `C:\Users\houck\mashup-machine\src\audio\takeLooper.ts:736`
- explains: (1) "successive beat layers move from where I play the beats" — the strongest form of it; the layer does not move, it disappears.
- evidence: `if (Math.abs(this.slotFrac[si] - h.frac) > MERGE_WINDOW_STEPS) continue;` with MERGE_WINDOW_STEPS = 0.25 (:45). On the quantised path build() writes `frac.push(0)` at :831 for every hit, so two takes colliding on one step have frac 0 and 0, |0-0| = 0 <= 0.25 — they merge, and :739-744 keeps only the louder (`h.vel * gain > this.slotVel[si] * this.slotGain[si]`). Combined with the previous finding (every take has a hit at step 0, and identically-spaced takes produce identical tables), a child who plays the same pad twice in two takes hears the second take vanish entirely. Pressing clear-last then produces no audible change, which reads as the app ignoring the control.

**[certain]** KidsMode already assumes the absolute-anchor origin model: it draws raw and open taps in ABSOLUTE grid coordinates but committed hits in take-relative ones, so the two disagree by exactly `lo mod L` and the commit animation renders the defect as a teleport.

- `C:\Users\houck\mashup-machine\src\components\KidsMode.tsx:708`
- explains: (1) "successive beat layers move from where I play the beats" — the child watches the move happen on the position strip at commit.
- evidence: buildSlide computes the source position as `const x = mod(tp.grid, L) / L;` where TapView.grid is documented at :587 as "Fractional ABSOLUTE step at which the tap was played", but the destination set at :699 is `(h.step + h.frac + r * steps) / L` in take-relative coordinates. drawStrip repeats the mismatch: committed hits at :796 take-relative, open taps at :812 `mark(mod(tp.grid, L) / L, ...)` absolute. In the worked example the marks slide 6/16 = 37.5% of the strip width, and the nearest-destination matcher at :710-718 (circular distance over all dest) can pair a tap with the wrong hit at that magnitude. The comment at :683 claims this animation shows "auto-adjust to be on beat" — under the absolute-anchor fix the from and to positions coincide within half a sixteenth and the claim becomes true. That the UI was written in absolute coordinates is evidence the `- lo` normalisation broke an invariant the rest of the app already assumed.

**[certain]** REFUTATION of part of the prior: phase01() and loopSteps() are not independently defective, and takes of different lengths DO still line up correctly — the alignment machinery is sound and only build()'s coordinate choice is wrong.

- `C:\Users\houck\mashup-machine\src\audio\takeLooper.ts:496`
- explains: none — this narrows the fix surface to one line and refutes the prior's claim that phase01 is a separate defect.
- evidence: `phase01()` returns `(((g % L) + L) % L) / L` with L = loopSteps() = the longest take's steps (:486-492). Under build()'s current normalisation every take's step 0 is at abs = 0 mod (its own steps), so for the longest take step 0 is at abs = 0 mod L and the playhead origin is genuinely consistent with the audio — it is coupled to :867, not separately broken. Cross-length: gather() applies each take's own L to the same absStep and 16 | 32 | 64 | 128, so a 1-bar take (L=16, hits 0/4/8) repeats exactly four times inside a 4-bar take (L=64, hits 0/20/41/56) with a phase relation fixed for the session; drawStrip's `(hit.step + hit.frac + r * steps) / L` with `reps = round(L / steps)` at :789-796 draws it in exactly the places it fires. Fixing :867 to `((pos[i] % L) + L) % L` requires no change in phase01(), loopSteps(), gather() or onStep(). Adopting a per-take origin field instead WOULD force changes in all four.

**[likely]** A transport stop/restart rotates every committed 2/4/8-bar take by a whole number of bars, because GridClock re-bases absStep in a way that preserves abs mod 16 but not abs mod 64 or 128.

- `C:\Users\houck\mashup-machine\src\audio\takeLooper.ts:274`
- explains: (1) "successive beat layers move from where I play the beats" — a secondary contributor, observable only after a stop/start and only for multi-bar takes.
- evidence: `this.absStep = (Math.floor(this.absStep / STEPS_PER_BAR) + 1) * STEPS_PER_BAR + step;` — the comment at :271-273 states the invariant it keeps is `absStep % 16 === step`, which is a BAR-level invariant only. Concretely: stop at absStep 100, restart, first observed step 0 -> absStep jumps to (floor(100/16)+1)*16 + 0 = 112, a delta of 12 steps. 12 is not a multiple of 64, so a 4-bar take whose hits sit at steps 0/20/41/56 now presents its four bars in a different order against the song. The epoch bump at :273 only re-derives OPEN takes (build() :805-812 checks `taps[i].epoch !== epoch`); committed byStep tables carry no epoch and are never re-based. Both takes shift by the same delta, so cross-take relations survive — what breaks is the relation to the music. Note this must be handled explicitly under any per-take-origin model, or stored origins and absStep drift apart.

**[certain]** Committing a keyboard take with no drum takes and no canned layers STOPS the transport, so a melody-only loop never plays back.

- `C:\Users\houck\mashup-machine\src\audio\BeatMachine.ts:352`
- explains: none of the four verbatim reports — but it silences the keyboard loop entirely, and a child would report it as the keyboard "not looping".
- evidence: `anyLayerOn` is `this.anyGrooveLayerOn || this.drums.hasTakes` — `keys.hasTakes` is deliberately excluded (comment :348-351), and the separate `hasTakes` getter at :407-409 that DOES include keys is only used for the groove duck at :466. syncClock() at :460-463 reads the narrow one: `if (this.anyLayerOn) ensureBeatClock(); else this.engine.transport.stop();`. commitNow() runs `this.safely(() => this.hooks.ensureClock())` at takeLooper.ts:630 and THEN `this.safely(() => this.hooks.changed())` at :631, and changed -> onTakesChanged (:453-457) -> syncClock -> stop(). The stop wins because it is second. Same path fires when clearLast() pops the last DRUM take while melody takes remain. A stopped transport means no absStep advances and no origin exists at all, which is the degenerate case of this lens.


---

## Lens 3

Lens 2 of 4 — loop length and trailing silence. Read src/audio/takeLooper.ts in full, confirmed configs in BeatMachine.ts (idleSec 3, quantiseSteps 1, maxBars 8) and melodyLooper.ts (idleSec 2, quantiseSteps 1, maxBars 8). Extracted build()'s length math (lines 842-850) and pow2AtLeast (345-349) into node and evaluated them (a) on the five named cases, (b) exhaustively over every span 0..200, and (c) against each candidate repair rule. No browser, no dev server, no preview tool touched.

VERDICT ON THE ORCHESTRATOR'S DEFECT B: confirmed, but the mechanism is one character narrower and one order of magnitude worse than stated. The prior says "loop length stops at the last hit" and cites case (a) 0,4,8 as the example. Case (a) is NOT the defect — 0,4,8 in a 16-step loop is three quarters and a rest on beat 4, which is what a musician would write, and every candidate rule I tested leaves it exactly there. The real defect is the `+ 1` on line 848. `span = hi - lo + 1` charges the loop one extra sixteenth for a phrase that has already ended, and that single step is enough to push ceil(span/16) over a bar line. Exhaustively, dropping the +1 changes the answer on exactly three spans out of 201: hi-lo = 16, 32 and 64 — phrases exactly 1, 2 or 4 bars long from first onset to last. Each one DOUBLES the loop. Those three are not edge cases; they are what a child plays when they count "1,2,3,4" and land on the next "1", which is the most natural way there is to end a phrase.

The severity ranking is the reverse of the prior's: hi-lo = 64 is the single worst point in the entire domain — L becomes 128 steps with 64 steps of dead air, 8.00 seconds, 50% of the loop silent.

TWO OF THE PROPOSED REPAIRS ARE DEAD, AND I CAN PROVE IT.

(1) "Round the span up to the nearest whole BEAT before the pow2-bar step" is a PROVABLE NO-OP. Zero differences across all 201 spans 0..200. The reason is structural: 4 divides 16, so rounding a span up to a multiple of 4 can never carry it across a multiple of 16 that it had not already crossed. ceil(span/16) absorbs it completely. It fixes nothing in (a)-(e), it does not fix the downbeat case, and it costs a line of code and a false sense of having addressed report (3). Do not ship it.

(2) "Add the median inter-onset interval to the span" is a no-op in five of the five named cases AND it actively breaks the case that matters. Three half-notes at 0,8,16: median IOI 8, span 16+8=24, ceil→2 bars, L=32, heard intervals 8,8,16 — an uneven limp. Dropping the +1 instead gives L=16 with the hit at 16 folding onto step 0, heard 8,8 — a clean half-note pulse. Median-IOI and "the last hit closes the loop" are in direct tension: adding a note-length past a hit that IS the loop point is exactly the wrong move. The prompt's worry about (c) and (d) turns out to be misplaced for a different reason than expected: median-IOI is safe on the fast double (0,1 → span 2 → still 1 bar) and on the single hit (median([]) returns 0 at line 297, span 0 → still 1 bar) ONLY because pow2AtLeast floors at one bar. The 1-bar floor is the load-bearing safety property, not the median. Any rule phrased as "loop = last hit + median IOI" WITHOUT that floor yields L=2 steps = 250 ms for the fast double: a machine-gun.

WHAT ACTUALLY FIXES IT: delete the `+ 1`. span = hi - lo. Then L is the smallest power-of-two bar count with L >= hi-lo, and a hit sitting exactly L steps after the first is placed by the existing line 867 at `(L % L) = 0` — it lands on the downbeat it actually was. Every invariant survives untouched: L is still bars*16, still a power of two, still locked to the transport's bar lines, no per-take state added, nothing in the tap path, nothing in onStep. Verified over 0..200 that L never falls below hi-lo except past maxBars (hi-lo > 128), which is the existing documented fold and is unchanged. The collision at step 0 is already handled: lines 870-886 merge same-voice hits within MERGE_WINDOW_STEPS and keep the louder, and in the quantised path every frac is 0, so the folded hit merges cleanly with no doubled sample and no +6 dB.

THE ONE HONEST COST of dropping the +1: on the melody surface with auto-beat-match OFF (quantised() false, melodyLooper.ts:179), pos is floor(grid) and frac is preserved, so a folded last hit can survive alongside the first with fracs more than 0.25 apart — a ~60 ms flam at the loop point. Rare, small, and confined to the unquantised path. The second real cost is a judgment call: for hits at 0, 5, 16 the new rule produces "0 and 5, every bar" where today produces "0, 5, 16 over two bars", discarding the information that the child did not replay the +5 in bar two. I think a loop pedal should do the former, but it is a taste call and worth naming rather than hiding.

WHAT DROPPING THE +1 DOES NOT FIX, and I want to be clear about it because it is most of case (e): the residual dead air is the power-of-two constraint itself, not the span formula. Case (e), hits spanning 0..40, is 2.56 bars of genuine material; pow2 offers 2 bars or 4 bars and nothing between, so 4 bars with 24 steps (3.00 s) of silence is what any correct span formula returns. A fold-down rule (take the next power of two DOWN when the overshoot is under ~25%) fixes it beautifully when the material repeats — case (e) collapses to a clean 32-step loop of steady quarters with ZERO dead air — but when bar 3 carries different material it folds hits onto steps 1 and 5 next to the hits at 0 and 4, producing 125 ms flams. It is invariant-safe (still a pow2 bar count, still bar-locked) but it is a taste change, not a bug fix, and it should be considered SECOND and separately from the +1, which is unambiguous.

AND ONE HYPOTHESIS I EXPECTED TO CONFIRM AND HAD TO REFUTE: the 3.0 s idle window is NOT baked into the loop length. lo and hi come only from `pos`, derived from `taps[i].grid` captured at tap time (lines 813-821, 842-847); the silence after the last tap contributes nothing to span. That was the obvious suspect for report (2) and the code clears it. What idleSec DOES do is subtler and still real — see finding 5.

### Worked example

```
THE HEADLINE CASE, 120 bpm, step = 125 ms, bar = 16 steps = 2.000 s.

A child taps a steady quarter-note phrase and resolves it on the next downbeat — "one, two, three, four, ONE". Five taps, 500 ms apart. Say the transport is at absolute step 100 when the first lands, and the child has realistic jitter:

  tap 1  ctx t+0.000  grid 100.0
  tap 2  ctx t+0.500  grid 104.1
  tap 3  ctx t+1.000  grid 107.9
  tap 4  ctx t+1.500  grid 112.2
  tap 5  ctx t+2.000  grid 115.9

Then 3.0 s of silence and maybeCommit (line 589) fires build().

q = 1 (BeatMachine.ts:302). quantised() is `() => true` (BeatMachine.ts:310).
phaseShift(grid, 1) computes the circular median residual, about +0.02, well inside its |shift| <= q/2 guarantee.
Line 830, pos[i] = Math.round(grid[i] - shift):

  pos = [100, 104, 108, 112, 116]

Line 842-847:  lo = 100, hi = 116.

Line 848:  span = hi - lo + 1 = 116 - 100 + 1 = 17
Line 849:  17 / 16 = 1.0625 -> Math.ceil = 2 -> pow2AtLeast(2, 8): p=1, (1<2 && 1<8) so p=2, (2<2) false, returns 2
Line 850:  L = 2 * 16 = 32 steps = 4.000 s

Line 867 places them at ((pos - 100) % 32 + 32) % 32:

  step 0, 4, 8, 12, 16   in a 32-step table

WHAT THE CHILD HEARS, inter-onset intervals including the wrap back to loop start:

  4, 4, 4, 4, 16 steps
  = 500 ms, 500 ms, 500 ms, 500 ms, 2000 ms

Five perfectly even beats go in. Four beats and a full bar of dead air come out, and it repeats that way forever. The pattern does not repeat on beat — the beat that should follow the fourth hit arrives 500 ms late every single cycle, because the loop restarts at step 32 instead of step 16.

Delete the `+ 1` on line 848 and nothing else:

Line 848:  span = hi - lo = 16
Line 849:  16 / 16 = 1.0 -> ceil = 1 -> pow2AtLeast(1, 8) = 1
Line 850:  L = 16 steps = 2.000 s
Line 867:  tap 5 lands at ((116 - 100) % 16 + 16) % 16 = 0, on the downbeat it actually was, and merges with tap 1 at lines 870-886 (same voice key, both frac 0, |0-0| <= MERGE_WINDOW_STEPS 0.25, louder kept — one hit, no doubled sample, no +6 dB).

  steps 0, 4, 8, 12 in a 16-step table
  heard: 4, 4, 4, 4 = 500, 500, 500, 500 ms, seamless across the wrap.

THE SAME BUG AT ITS WORST POINT. The child plays four bars and resolves on the downbeat of bar five, so hi - lo = 64:

  today:  span = 65, 65/16 = 4.0625, ceil = 5, pow2AtLeast(5,8) walks 1,2,4,8 -> 8, L = 128 steps = 16.000 s
          last hit at step 64, steps 64..127 empty
          trailing silence = 64 steps x 125 ms = 8.00 SECONDS, exactly half the loop
  fixed:  span = 64, ceil = 4, L = 64 steps = 8.000 s, last hit folds to step 0, trailing silence 0.00 s

I checked every hi-lo from 0 to 200: the +1 changes the answer on exactly three of them — 16, 32 and 64 — and hi-lo = 64 is the single worst point in the entire domain.
```

### Findings

**[certain]** The `+ 1` in `span = hi - lo + 1` doubles the loop length for any phrase that resolves on a downbeat, inserting a full power-of-two block of silence — up to 8.00 seconds, half the loop.

- `src/audio/takeLooper.ts:848`
- explains: (2) "the silence after the last beat is long typically" and (4) "I need that pattern to repeat on beat" — both, and this is the dominant cause of both.
- evidence: Line 848-850:
    const span = hi - lo + 1;
    const bars = pow2AtLeast(Math.ceil(span / STEPS_PER_BAR), Math.max(1, this.config.maxBars));
    const L = bars * STEPS_PER_BAR;

I evaluated this against `span = hi - lo` for every hi-lo in 0..200. It differs on EXACTLY THREE values, and each one is a doubling:
  hi-lo=16 (1 bar) : L 32 -> 16
  hi-lo=32 (2 bars): L 64 -> 32
  hi-lo=64 (4 bars): L 128 -> 64
Arithmetic at hi-lo=16: span = 17, 17/16 = 1.0625, ceil = 2, pow2AtLeast(2,8) = 2, L = 32. With the +1 gone: span = 16, ceil(1) = 1, L = 16, and line 867 places the last hit at ((16-0) % 16) = step 0, which is the downbeat it actually was.
Arithmetic at hi-lo=64 (the worst point in the whole domain): span = 65, 65/16 = 4.0625, ceil = 5, pow2AtLeast(5,8) walks 1,2,4,8 and returns 8, L = 128 steps. The last hit sits at step 64, so steps 64..127 are empty: 64 steps x 125 ms = 8.00 SECONDS of silence, 50% of the loop. Without the +1: ceil(64/16) = 4, L = 64, dead air 0.00 s.
The three affected lengths are 1, 2 and 4 bars — the only phrase lengths a child is likely to play. Nothing else in 0..200 is touched, so the fix is surgical.
Note the loop stays a legal power-of-two bar count either way, so this does NOT break take-to-take alignment. It purely inserts silence and halves the repetition rate.

**[certain]** Rounding the span up to the nearest whole BEAT before the pow2-bar step is a provable no-op — zero effect on any input — because 4 divides 16 and ceil(span/16) already absorbs it.

- `src/audio/takeLooper.ts:849`
- explains: none — this is a negative result about a proposed repair, not a defect in shipped behaviour.
- evidence: Candidate rule under test: span' = Math.ceil((hi-lo+1)/4)*4, then bars = pow2AtLeast(ceil(span'/16), 8).
I compared it to line 849 as written for every hi-lo in 0..200. Result: 0 differences out of 201.
The reason is structural, not empirical: rounding x up to a multiple of 4 adds at most 3, and because 4 | 16, x and ceil(x/4)*4 always lie in the same half-open block [16k, 16(k+1)). So ceil(ceil(x/4)*4/16) === ceil(x/16) identically.
It does nothing on any of the five named cases: (a) 9->12, (b) 13->16, (c) 2->4, (d) 1->4, (e) 41->44 — all four map to the same bar count they already had. It also does not touch the real defect: the downbeat-resolution case goes 17 -> 20, ceil(20/16) = 2, still L = 32, still 2.00 s of dead air.
This matters because it is the intuitive fix for report (3) "it needs to fit to measures" and it would ship, look reasonable in review, and change literally nothing.

**[certain]** Extending the span by the median inter-onset interval is a no-op on all five named cases and actively regresses the downbeat-resolution case, because it adds a note-length past a hit that is already the loop point.

- `src/audio/takeLooper.ts:848`
- explains: none — negative result about a proposed repair. It would create a new symptom, not cure one.
- evidence: Rule under test: span = (hi - lo) + median(successive differences), then the existing pow2-bar step.
On the five named cases it returns L = 16, 16, 16, 16, 64 — identical to today in every one. It buys nothing.
Where it differs, it is worse. Three half-notes at steps 0, 8, 16 (a child playing a slow 1-2-3 pulse):
  median IOI = 8, span = 16 + 8 = 24, ceil(24/16) = 2, L = 32.
  Heard intervals including the wrap: 8, 8, 16 -> 1000 ms, 1000 ms, 2000 ms. A limp.
  Dropping the +1 instead: span = 16, L = 16, hit at 16 folds to step 0 via line 867.
  Heard: 8, 8 -> 1000 ms, 1000 ms. A clean half-note pulse, which is what was played.
So median-IOI and "the last hit closes the loop" are in direct tension and must not be combined naively.
On the prompt's two worry cases the rule is safe, but NOT for the reason expected. Fast double at 0,1: median IOI = 1, span = 2, ceil(2/16) = 1, L = 16. Single hit: median([]) returns 0 at line 297 (`if (xs.length === 0) return 0`), span = 0, pow2AtLeast(0,8) enters `while (1 < 0)` false and returns 1, L = 16. Both survive ONLY because pow2AtLeast floors at one bar. The absurd outcome the prompt anticipates is real if that floor is ever bypassed: "loop = last hit + median IOI" on the fast double gives L = 2 steps = 250 ms, a machine-gun. The 1-bar floor at line 345-349 is the load-bearing safety property here and should be commented as such.

**[likely]** idleSec = 3.0 s absorbs a mid-phrase hesitation of up to 24 steps (1.5 bars at 120 bpm) into a single take, inflating hi and pushing span across a power-of-two boundary — an independent cause of long trailing silence that no span formula can fix.

- `src/audio/BeatMachine.ts:301`
- explains: (2) "the first layer is difficult to loop to ... the silence after the last beat is long typically" — a second, independent contributor alongside the +1 bug.
- evidence: BeatMachine.ts:301 `idleSec: 3,`. maybeCommit (takeLooper.ts:587-591) closes a take only after `ctx.currentTime - lastTapAt >= idleSec`, so ANY pause shorter than 3.0 s keeps accumulating into `this.taps` and therefore into lo/hi.
3.0 s / 0.125 s = 24 steps = 1.5 bars at 120 bpm.
Worked case — a child plays four quarters, thinks for 2.0 s, plays three more:
  pos = [0, 4, 8, 12, 28, 32, 36]   (the 2.0 s pause is 16 steps)
  span = 36 - 0 + 1 = 37, ceil(37/16) = 3, pow2AtLeast(3,8) = 4, L = 64.
  Trailing silence = 64 - 36 = 28 steps = 3.50 s, on top of a 2.00 s hole sitting INSIDE the loop between steps 12 and 28.
The take is 4 bars long and more than half of it is silence, from a child who played seven notes.
I checked and must refute the more obvious version of this hypothesis: the idle window itself is NOT baked into the length. lo/hi at lines 842-847 derive only from `pos`, which derives from `taps[i].grid` captured at tap time (lines 813-821). The 3 s of silence after the LAST tap contributes nothing to span. It is only hesitations BETWEEN taps that inflate it.
This is why report (2) singles out the first layer: with nothing looping yet there is no pulse to keep a child moving, so mid-phrase hesitation is at its most likely exactly there.

**[likely]** After the +1 is fixed, the residual dead air in a 2.5-bar phrase is the power-of-two constraint itself; a fold-down rule cures it when material repeats but introduces 125 ms flams when it does not.

- `src/audio/takeLooper.ts:849`
- explains: (2) and (3) — the residual portion of "silence after the last beat" and "it needs to auto crop", after the certain defect is removed.
- evidence: Case (e), hits spanning steps 0..40, is 41 steps = 2.5625 bars of genuine material. pow2 offers 32 or 64 and nothing between. With the +1 removed: ceil(40/16) = 3, pow2AtLeast(3,8) = 4, L = 64, trailing silence 24 steps = 3.00 s. That is the correct output of a correct span formula under a power-of-two constraint — the formula is not what is wrong here.
Candidate fold-down rule (take the next power of two DOWN when hi-lo <= (bars/2)*16*1.25):
  (e) steady quarters 0..40 -> L = 32, steps [0,4,8,12,16,20,24,28], heard intervals all 4, dead air 0.00 s. The hits at 32,36,40 fold onto 0,4,8 and merge with them at lines 870-886 (same voice, frac 0, louder kept). A perfect 2-bar groove.
  (e2) same span but bar 3 carries different material, hits at 33 and 37 -> they fold to steps 1 and 5, landing beside the existing hits at 0 and 4. Result steps [0,1,4,5,8,12,16,20,24,28]: two 125 ms flams. Muddy on drums, potentially dissonant on the keyboard where maxVoicesPerStep is only 4.
  Cases (a)(b)(c)(d) and the downbeat case are all untouched by it.
It is invariant-safe — L stays a power-of-two bar count, still bar-locked, no per-take origin — but it is a taste change, not a bug fix. It should land second and separately, and case (e2) is the argument for gating it on whether the folded material actually collides.

**[certain]** pow2AtLeast returns a non-power-of-two whenever `cap` is not itself a power of two, silently voiding the documented "loop lengths are 1/2/4/8 bars" invariant that makes every take line up with every other.

- `src/audio/takeLooper.ts:345`
- explains: none today — latent. It would surface as reported symptom (1), layers drifting against each other, and it would be extremely hard to trace back.
- evidence: Lines 344-349:
    /** Smallest power of two >= n, capped. Loop lengths are 1, 2, 4 or 8 bars. */
    function pow2AtLeast(n: number, cap: number): number {
      let p = 1;
      while (p < n && p < cap) p *= 2;
      return Math.min(p, cap);
    }
The final Math.min(p, cap) clamps to `cap` without asking whether cap is a power of two. Measured outputs for n = 1..10:
  cap=6  -> [1,2,4,4,6,6,6,6,6,6]
  cap=12 -> [1,2,4,4,8,8,8,8,12,12]
A 6-bar take against a 4-bar take has lcm 12 and walks through it every 12 bars — precisely the failure the comment at lines 790-797 exists to prevent.
This is inert TODAY: BeatMachine.ts:303 and melodyLooper.ts:171 both set maxBars: 8. But the only thing asserting the requirement is prose — takeLooper.ts:164, "Longest loop, in bars. Must be a power of two." A constant that must stay true is stated in a comment and nowhere else, so the day someone sets maxBars: 6 to shorten loops for younger kids, every take silently stops lining up and nothing errors. Either clamp to the largest power of two <= cap, or assert it at construction.

**[certain]** The TakeConfig doc comment states the keyboard idle window is 5 s; the shipped value is 2 s.

- `src/audio/takeLooper.ts:160`
- explains: none — documentation drift, but on the constant that drives finding 5.
- evidence: takeLooper.ts:160 — `/** Silence that ends a take. 3 s for drums, 5 s for the keyboard. */`
melodyLooper.ts:35 — `const KEYS_IDLE_SEC = 2;`, consumed at melodyLooper.ts:169 as `idleSec: KEYS_IDLE_SEC`.
Off by 3 seconds, in the one comment a reader would consult when reasoning about how much hesitation a take absorbs — which is exactly finding 5's mechanism. I read this line while working that finding and had to go check the config to catch it, which is the cost this kind of drift imposes on every future reader.


---

## Lens 4

LENS 3: QUANTISE RESOLUTION VS HUMAN TIMING — verdict on Defect C: CONFIRMED, and it is the largest single contributor to report (4). But the orchestrator's prior needs two corrections, one of which changes the fix.

VERIFIED MECHANICS (read, not trusted): STEPS_PER_BAR=16; step = 60000/bpm/4 ms (Transport.ts:60). quantiseSteps=1 at BeatMachine.ts:302 and melodyLooper.ts:170 — the ONLY two call sites, no UI exposure, so q is a compile-time constant with no per-take path. build() (takeLooper.ts:799) computes shift=phaseShift(grid,q) once for the whole take (824), then pos=Math.round((grid[i]-shift)/q)*q (830) with frac=0 — the shift is subtracted and never added back, and no sub-step information survives when quantised.

=== 1. HOW BIG IS A CHILD'S ERROR, IN GRID CELLS ===
The prior says "+/- 60 ms at 120 bpm, which is +/- 0.5 step". That is right at 120 and WRONG in its implication that 90 bpm is safer. Human timing error is proportional to the interval produced (Weber; generalised form SD = sqrt((k*IOI)^2 + c^2), k~0.11 and c~20 ms for a 5-8 y/o, vs k~0.03/c~10 ms for a trained adult). So the error scales with the grid:

  120 bpm, step=125 ms: quarters IOI=500 ms -> SD 58.5 ms = 0.468 step
   90 bpm, step=167 ms: quarters IOI=667 ms -> SD 76.0 ms = 0.456 step
   70 bpm -> 0.45 step   140 bpm -> 0.48 step

SD/q is FLAT at 0.45-0.48 across 70-140 bpm. The sixteenth grid is not "worse at fast tempos" — it is equally broken at every tempo, because both the cell and the human scale together. Slowing the song down does not help the child at all. The only thing that changes SD/q is q.

The same table for what the child is actually playing at 120 bpm:
  plays quarters   SD 0.468 step -> SD/q = 0.468 at q=1, 0.117 at q=4
  plays eighths    SD 0.272 step -> SD/q = 0.272 at q=1, 0.136 at q=2
  plays sixteenths SD 0.194 step -> SD/q = 0.194 at q=1

Quantisation only regularises when the cell is large relative to the performer's SD. Because human error is proportional to the interval performed, that condition holds exactly when q equals the subdivision performed — SD/q collapses to ~k=0.12 whatever the child plays. Fixed q=1 satisfies it only for a child playing genuine sixteenths, which is the rarest thing a small child does.

=== 2. WHAT q=1 ACTUALLY PRODUCES (20,000-take MC through the real build() math) ===
Child aims at four even quarter notes, n=4:
  P(all three gaps come out equal) = 21.6% at 120 bpm, 22.9% at 90 bpm.
  IOI histogram: 3 steps 22.1% | 4 steps 53.3% | 5 steps 21.8% | 2 or 6 steps 2.7%.
So 44-47% of gaps are wrong by a whole sixteenth = 125 ms = 25% of a beat. The file's own comments call 112 ms of injected error unacceptable (line 311) and 31 ms inaudible (line 36) — by its own standard 125 ms is grossly audible. At n=6 (5 gaps) an even loop survives only 9% of the time.
  With q=4 the same takes come out even 99.8% of the time.

=== 3. THIS IS NOT phaseShift's FAULT — AND THAT MATTERS FOR THE FIX ===
Ablation, oracle phase (shift set to the child's true offset, unknowable in practice):
  q=1: phaseShift 21.6%   ORACLE 24.6%   no shift at all 18.0%
  q=4: phaseShift 99.8%   ORACLE 99.9%   no shift at all 76.0%
A perfect whole-take shift buys 3 pp at q=1 and cannot exceed 25%. A constant offset cannot reduce per-hit variance — structurally, no phase estimator can rescue a grid whose cell is 2x the SD. The fix must be q, not the estimator. Conversely at q=4 phaseShift earns 24 pp, so it is doing real work exactly where the grid is right.

=== 4. phaseShift() INTERACTION — THE PART THAT SURPRISED ME ===
Read at takeLooper.ts:326. It computes a circular mean over exp(2*pi*i*g/q), then the median of residuals, then wraps to a residue mod q. Two consequences:

(a) ITS ESTIMATOR IS DEAD AT q=1 FOR THE COMMON CASE. For a wrapped normal the mean resultant length is R = exp(-2*pi^2*SD^2/q^2). Child playing quarters, q=1: R = 0.013. Measured estimate error (|shift - true offset|, 6000 draws, n=6): 0.237q against a 0.250q random-guess baseline. It is a coin flip. The same function at q=4 scores 0.038q, and for an ADULT at q=1 scores 0.047q. So phaseShift is correct by design and was validated at adult precision; it silently degenerates to a random dither of up to +/-62 ms at child precision. Practical effect today is small only because build() then subtracts lo (Defect A) — but it does mean the borderline hits in a take are re-diced unpredictably.

(b) ITS OWN INTERNAL STATISTIC IS THE GRID-FIT TEST. sumSin/sumCos already give R. R is high exactly when the onsets lie on a q-lattice, and near zero when they do not — a child playing eighths scores R=0.14 at q=4 (the two residue classes are antipodal and cancel) and 0.73 at q=2. So the concentration that selects the grid is the same number that says whether phaseShift's answer is meaningful at that grid. phaseShift is degenerate precisely when q is wrong, and the test detects that condition for free. No new maths, ~6 lines.

(c) ITS SAFETY PROPERTY IS q-DEPENDENT AND MUST BE RE-DOCUMENTED. The comment at 322-324 says |shift| <= q/2 = 31 ms so "the take cannot be moved onto a different beat". At 120 bpm that bound becomes 125 ms at q=2, 250 ms at q=4, 500 ms at q=8. Coarsening relaxes the guarantee in exact proportion. Today that is invisible because Defect A destroys absolute placement anyway; the moment Lens 1 restores a per-take origin, a q=4 or q=8 phase shift can move the phrase up to half or a whole beat against the bar. That is usually what you want (it pulls a phrase onto the beat, and at coarse q the estimate is genuinely good) but it is no longer a "cannot move onto a different beat" guarantee, and if a deliberate pickup/off-beat entry is ever to be respected, the take's ORIGIN must become a separate decision from the internal lattice. Flag for whoever merges Lens 1 and Lens 3.

=== 5. SECOND, DETERMINISTIC MECHANISM: DRIFT TOLERANCE ===
Independent of noise. Zero motor noise, child tapping at a tempo that is tau off the song's. First interval that lands wrong = ceil(q / (2*tau*subdivision)). Measured, 120 bpm, quarters:
  tau = 2%  (10 ms/beat): q=1 slips at tap 9 | q=2 none in 16 | q=4 none in 16
  tau = 5%  (25 ms/beat): q=1 slips at tap 4 | q=2 tap 9      | q=4 none in 16
  tau = 10% (50 ms/beat): q=1 slips at tap 3 | q=2 tap 4      | q=4 tap 9
A 5% tempo mismatch is nothing — a child is trivially that far off — and it makes the sixteenth grid insert a hiccup by the FOURTH tap, every time, with no noise involved. The quarter grid absorbs 250 ms of accumulated drift instead of 62.5 ms. This is a clean second explanation of "I need that pattern to repeat on beat".

=== 6. THE DECISION RULE (implementable as written) ===
Runs inside build(), on `grid` (takeLooper.ts:813-821), BEFORE line 824. Only when config.quantised() is true — the beat-match-off branch (832-839) is untouched.

  CANDIDATES: q in [8, 4, 2], tried coarsest first, fallback config.quantiseSteps (=1).
    Every candidate must DIVIDE STEPS_PER_BAR so residue classes are bar-stable;
    that rules out 3, 5, 6 and keeps the power-of-two bar invariant intact.
  MINIMUM TAPS: n >= 2. (n=1: skip inference entirely, use the fallback — see below.)
  STATISTIC: for candidate q, C = mean cos(2*pi*g_j/q), S = mean sin(2*pi*g_j/q),
    Rhat^2 = C^2 + S^2, and the small-sample-corrected Rayleigh form
      Rbar2 = (n*Rhat^2 - 1) / (n - 1).
    The correction is mandatory: E[Rhat^2] = 1/n under the null, so an uncorrected
    threshold accepts everything at n=4.
  TOLERANCE: accept if Rbar2 >= 0.30.
  COLLISION GUARD: let k(q) = number of distinct snapped positions at q.
    Reject q if k(q) < ceil(0.8 * k(1)).  Prevents notes vanishing into each other.
  Take the first (coarsest) q passing BOTH; else fallback.
Then feed that q to phaseShift and to line 830. Everything downstream — span, pow2AtLeast, bucketing, gather, playback — is unchanged, and pos stays a multiple of q so `lo` is too.

Why 0.30: measured Rbar2 by ground truth at 120 bpm — true quarters 0.573, true eighths 0.472, true half-notes similar; worst confuser (triplet-swung eighths) 0.083 at q=4 and 0.050 at q=2. 0.30 sits ~2x above the largest confuser mean and ~0.55x below the smallest true-positive mean. Sensitivity: THR 0.25 / 0.30 / 0.35 give quarters recall 92/89/85% and triplet-swing leakage 17/13/10%. Anything below 0.25 starts flattening triplet swing, which sits at Rbar2 0.25 by construction — that is the hard floor on the threshold.

MEASURED BEHAVIOUR (6,000 takes each, exact-pattern reproduction, today vs rule):
  quarters n=4        22% -> 84%      quarters n=8         4% -> 93%
  straight eighths    52% -> 75%      half notes n=4        4% -> 86%
  half notes n=6       1% -> 92%      backbeat (2 and 4)    4% -> 86%
  gallop (8+2x16)     82% -> 82%      syncopated           23% -> 23%
  clave 3-2           30% -> 26%      quarters + 2-note fill 41% -> 36%
  triplet swing        0% ->  0%

=== 7. q=8 IS REQUIRED, AND I NEARLY MISSED IT ===
My first pass used candidates [4,2] on the reasoning that q=4 REPRESENTS half notes exactly so q=8 is unnecessary. True for representation, false for noise suppression: a child tapping one hit per two beats is producing a 1000 ms interval, so SD = 112 ms = 0.89 step, which is 0.22 of a q=4 cell — R = 0.37, below threshold, and one tap in five still lands on the wrong quarter. Measured: half notes 4% -> 28% with [4,2], 4% -> 86% with [8,4,2]; n=6 1% -> 22% vs 1% -> 92%. And q=8 leaked into ZERO of the other ten patterns (quarters score R~0 at q=8 — antipodal again — so it is self-protecting). Adding 8 is strictly dominant. It is also the candidate with the ugliest phase bound (+/-500 ms), so it is the one that must be re-examined when Lens 1 lands.

=== 8. SMALL n ===
n=1: no IOI and no ring — R = 1 identically at every q and Rbar2 = 0/0 = NaN. Guard n>=2 before computing it. Note phaseShift itself is well-defined at n=1 (the comment at 319-321 is correct: the median IS that tap's own residual, so the hit lands exactly on the lattice). Recommend fallback q=1 for n=1 and let Lens 1 decide where a lone hit sits, because the only thing q changes at n=1 is absolute placement, which is Lens 1's variable, not this lens's.
n=2: the statistic degenerates gracefully — with two points Rbar2 = cos(2*pi*d/q), i.e. a direct test of whether the single gap is a multiple of q. It works: intended quarter gap commits as an exact 4-step gap 54% of the time at q=1 vs 99.6% at q=4, and an intended eighth gap correctly refuses q=4 (0%) because cos(pi) = -1. Measured note-loss at n=2 is 0.0% for quarters and eighths. So n>=2 is defensible on the evidence; if you want a conservative first ship, set the floor at n>=4 (quarters recall 83%, and it removes all judgement calls about two exploratory pokes).

=== 9. WHEN COARSENING DESTROYS SOMETHING THE CHILD MEANT ===
The rule declines by itself in most of these, because a wrong q shows up as low concentration:
  * DELIBERATE SWING (3:1, steps 0,3,4,7...). Onsets split evenly across residues mod 2 -> Rbar2 ~ -0.07 at q=2, refused. At q=4 the concentration statistic is NOT enough — it reads 0.355 and would accept. The COLLISION GUARD is what saves it: pairs collapse, k(4)=5 vs k(1)=8, refused. Ablation proves the guard is load-bearing and nothing else is: with the guard, swing goes to q=4 3% of the time; WITHOUT it, 64%. Do not ship the rule without the guard. Residual risk: at short takes (n=6) the guard is weaker and 22% still leak to q=4. Swing survives better the longer the take.
  * TRIPLET SWING. Refused at both q=4 and q=2 (Rbar2 0.083 / 0.050). But it is already unrepresentable — 16 steps per bar has no triplet lattice — so it commits as 0,3,4,7 today and will continue to. Not a coarsening problem; 0% exact both ways.
  * SYNCOPATION on the eighth grid ("and-of-2"). Refused 94% of the time, 23% exact before and after. No harm.
  * DRUM ROLL / machine-gunning one pad. Collision guard refuses at every q, 100% -> q=1. (TAP_GUARD_SEC=0.04 makes the shortest representable IOI 0.32 step at 120 bpm, well under q=1, so the guard has real work at every candidate.)
  * BACKBEAT / off-beat quarters. NOT destroyed — q is a modulus, not an alignment to beat 1, so hits on 2 and 4 concentrate just as well as hits on 1 and 3 and are preserved exactly (4% -> 86%). Coarsening only ever destroys SUB-quarter placement.
  * DOTTED RHYTHMS. Refused at q=4 (antipodal), accepted at q=2 where they are exactly representable — the coarsest-first search stops at the right rung on its own.
  The two REAL costs, both measured and both small: clave 3-2 loses 4 pp (30% -> 26%) and a MIXED take — three quarters then a fast two-note fill — loses 5 pp (41% -> 36%). The mixed case is the honest structural limitation: q is one decision for a phrase that contains two subdivisions, and per-region q is far past what a party toy should carry.

=== 10. WHAT THIS LENS DOES NOT FIX ===
Nothing here touches Defect A (line 867 still normalises to the take's own lo) or Defect B (line 848 still measures span to the LAST HIT, so three quarters at 0,4,8 still give span 9 -> 1 bar with a 1000 ms hole). Coarsening makes the gaps that DO exist even; it does not make the loop the right length or put it in the right place. One interaction worth handing to Lens 2: once q is known, the musically right span is hi - lo + (the take's characteristic IOI, which is now a well-defined multiple of q), not hi - lo + 1. And a take that is internally regular but at a tempo the song does not share is not fixable by any snap — the rule will simply decline to coarsen it, which is the correct refusal but leaves that child unhelped.

### Worked example

```
CONCRETE TRACE, 120 bpm (step = 125 ms), run through the actual takeLooper.ts build() arithmetic.

A child intends four even quarter notes and enters 0.42 of a step after the bar-3 line (abs step 48). Their asynchronies are drawn from the measured distribution N(0, 58.5 ms) = N(0, 0.468 step): -0.31, +0.44, -0.52, +0.19 step — i.e. 39 ms early, 55 ms late, 65 ms early, 24 ms late. Every one of those is an ordinary tap for a 5-8 year old; none is a mistake.

  taps, as fractional absolute steps : 48.11   52.86   55.90   60.61
  = ms after the bar-3 line         : 14      607     987     1576
  (intended                         : 52      552     1052    1552)

TODAY, q = 1 (BeatMachine.ts:302 / melodyLooper.ts:170):
  Rbar2 at q=1 = -0.005  ->  the ring is uniform; there is no phase information here
  phaseShift(grid, 1)   = -0.120 step (-15 ms)     [line 824]
  pos = Math.round((g - shift)/1)*1                 [line 830]
      = 48, 53, 56, 61
  lo = 48, so step = (pos - lo) mod L               [line 867]
      = 0, 5, 8, 13
  span = 61 - 48 + 1 = 14 -> ceil(14/16) = 1 bar -> L = 16   [lines 848-850]

  WHAT THE CHILD HEARS:
    gap 1 = 5 steps = 625 ms
    gap 2 = 3 steps = 375 ms
    gap 3 = 5 steps = 625 ms
    wrap back to step 0 = 3 steps = 375 ms
  Four evenly-tapped beats commit as 625 / 375 / 625 / 375 ms. Gap 2 is 40% shorter
  than gap 1. Nothing the child did produced that — the largest single error they
  made was 65 ms, and the loop reports a 250 ms disparity. It is not a subtle
  imperfection; it lurches, and it lurches the SAME WAY on every repeat forever.

WITH THE INFERRED GRID (candidates [8,4,2], Rbar2 >= 0.30, collision guard):
  Rbar2 at q=8 = (antipodal, refused)   at q=4 = 0.577 PASS   -> q = 4 selected
  distinct positions at q=4 = 4, at q=1 = 4; 4 >= ceil(0.8*4) = 4, guard passes
  phaseShift(grid, 4)   = 0.360 step (45 ms)  — now a real estimate, not a dither
  pos = 48, 52, 56, 60      step = 0, 4, 8, 12      span = 13 -> L = 16

  WHAT THE CHILD HEARS:
    gap 1 = gap 2 = gap 3 = 4 steps = 500 ms, and the wrap back to step 0 is also
    4 steps = 500 ms. Four even beats, looping exactly on the beat.

The only thing that changed is q. The same phaseShift, the same rounding, the same
span/pow2/bucket code, the same playback. Across 20,000 such draws this is 21.6%
correct at q=1 and 99.8% correct at q=4.
```

### Findings

**[certain]** quantiseSteps=1 makes the grid cell smaller than a child's timing SD, so quantising cannot regularise timing and instead injects a full sixteenth (125 ms at 120 bpm) of error into 44% of gaps.

- `src/audio/takeLooper.ts:800`
- explains: (4) 'let's say I play 3 regular beats or a pattern. I need that pattern to repeat on beat' — the 'regular beats' half.
- evidence: `const q = Math.max(1, this.config.quantiseSteps);` with quantiseSteps literal 1 at BeatMachine.ts:302 and melodyLooper.ts:170 (the only two call sites; no UI exposure). One step = 60000/bpm/4 ms = 125 ms at 120 bpm. A 5-8 y/o producing a 500 ms interval has an asynchrony SD of sqrt((0.11*500)^2 + 20^2) = 58.5 ms = 0.468 step — the cell is smaller than 2 SD, so rounding at line 830 has no averaging power. 20,000-take Monte Carlo through the real build() math: a child aiming at four even quarters commits with all three gaps equal only 21.6% of the time; the IOI histogram is 3 steps 22.1% / 4 steps 53.3% / 5 steps 21.8%. With q=4 the same takes come out even 99.8% of the time. The file's own comments call 112 ms of injected error unacceptable (line 311) while treating 31 ms as inaudible (line 36) — 125 ms is unambiguously audible by its own standard.

**[certain]** The sixteenth grid tolerates only 62.5 ms of accumulated tempo mismatch before it inserts a wrong-length gap, so a 5%-off child gets a hiccup by the fourth tap deterministically, with no timing noise involved at all.

- `src/audio/takeLooper.ts:830`
- explains: (4) 'I need that pattern to repeat on beat' — the 'on beat' half.
- evidence: `pos.push(Math.round((grid[i] - shift) / q) * q)` snaps each hit to its own nearest cell, so a systematic tempo error tau accumulates until it exceeds q/2 and one interval slips. Closed form: first wrong interval at ceil(q / (2*tau*subdivision)). Verified noise-free at 120 bpm, child tapping quarters: tau=2% (10 ms/beat) q=1 slips at tap 9, q=4 never in 16; tau=5% (25 ms/beat) q=1 slips at tap 4, q=2 at tap 9, q=4 never in 16; tau=10% q=1 slips at tap 3, q=4 at tap 9. `shift` cannot help — it is a single constant for the whole take (line 824), so it removes offset, never drift. This is a second, independent mechanism from the noise argument and it fires on every take by a child whose internal tempo is even slightly off the song's.

**[certain]** No phase estimator can rescue q=1: with an ORACLE shift set to the child's true offset, even quarters still commit correctly only 24.6% of the time, so the fix is q and not phaseShift.

- `src/audio/takeLooper.ts:824`
- explains: none directly — this is the negative result that constrains the fix for (4).
- evidence: `const shift = quantised ? phaseShift(grid, q) : 0;` applies one constant to the whole take. A constant cannot reduce per-hit variance — structurally it can only remove the mean. Ablation over 20,000 takes at 120 bpm, four intended quarters: q=1 gives phaseShift 21.6% / ORACLE phase 24.6% / no shift at all 18.0%; q=4 gives phaseShift 99.8% / ORACLE 99.9% / no shift 76.0%. So the phase shift is worth 3 pp at q=1 and 24 pp at q=4. Recorded here to stop anyone 'fixing' Defect C by improving the estimator — the ceiling at q=1 is 25%.

**[likely]** phaseShift's circular-mean estimator carries essentially zero information at q=1 for the dominant case (a child playing quarters): its estimate error is 0.237q against a 0.250q random-guess baseline, so the documented 'characteristic lateness' is a random dither of up to +/-62 ms.

- `src/audio/takeLooper.ts:336`
- explains: (4) — contributes, but its practical cost today is masked by Defect A's normalise-to-lo at line 867.
- evidence: `const centre = (Math.atan2(sumSin / grid.length, sumCos / grid.length) * q) / (2 * Math.PI);` — for a wrapped normal the mean resultant length is R = exp(-2*pi^2*SD^2/q^2). At SD=0.468 step and q=1 that is R=0.013, i.e. the ring is indistinguishable from uniform. Measured over 6000 takes at n=6, |shift - true offset| as a fraction of q: child/quarters/q=1 = 0.237q (random baseline 0.250q); child/quarters/q=4 = 0.038q; ADULT/quarters/q=1 = 0.047q. The function is correct by design and works as its comment claims at adult precision — it degrades to a coin flip at child precision on a sixteenth grid, which the comment block at 304-325 does not say. Same measurement also shows child/eighths/q=4 = 0.250q (antipodal cancellation), which is the property that makes the resultant length a valid grid-fit test.

**[certain]** The safety property documented for phaseShift ('|shift| <= q/2 = 31 ms, the take cannot be moved onto a different beat') is a function of q and silently relaxes to +/-250 ms at q=4 and +/-500 ms at q=8, which becomes load-bearing the moment Lens 1 restores a per-take origin.

- `src/audio/takeLooper.ts:322`
- explains: none — a latent interaction between this lens's fix and Lens 1's fix.
- evidence: Comment: 'the result is wrapped to a residue mod one quantise step, so |shift| <= q/2 = 31 ms at 120 bpm. The take cannot be moved onto a different beat.' The wrap at line 341 (`return wrapTo(centre + median(residuals), q)`) is correct, but q/2 in ms at 120 bpm is 63 / 125 / 250 / 500 for q = 1 / 2 / 4 / 8 (83 / 167 / 333 / 667 at 90 bpm). Today this is invisible because line 867 subtracts `lo` and destroys absolute placement anyway. Once a take keeps its bar position, a q=8 phase shift can move a phrase a full beat against the song. Usually desirable (it pulls the phrase onto the beat, and the estimator is genuinely good at coarse q — 0.038q error at q=4) but it must be re-documented, and a deliberate pickup entry would need the take's ORIGIN decided separately from its internal lattice.

**[likely]** The candidate grid set must include q=8 (half notes), not just {4,2}: a child tapping one hit per two beats has SD 0.89 step, which is still 0.22 of a quarter-note cell, and the take stays uneven.

- `src/audio/takeLooper.ts:163`
- explains: (4), for the specific case of a child tapping slowly — one hit per two beats is a very common first thing a small child does.
- evidence: `quantiseSteps: number;` is a static config field with no per-take path, so the grid is a compile-time constant today. Weber gives SD = sqrt((0.11*1000)^2 + 20^2) = 112 ms = 0.894 step for a 1000 ms interval; at q=4 that is SD/q = 0.224, giving R = 0.37 and Rbar2 = 0.139, below any usable threshold. Measured exact-pattern reproduction, 6000 takes: half notes [0,8,16,24] today 4% -> 28% with candidates [4,2] -> 86% with [8,4,2]; at n=6, 1% -> 22% -> 92%; backbeat [4,12,20,28] 4% -> 86%. q=8 leaked into zero of the other ten test patterns (quarters are antipodal mod 8, so they score R~0 there and are refused). I initially excluded q=8 on the reasoning that q=4 represents half notes exactly — true for representation, false for noise suppression.

**[certain]** The collision guard is load-bearing, not decorative: without it 64% of deliberately swung takes get flattened onto quarters, and the concentration statistic alone does not catch them.

- `src/audio/takeLooper.ts:799`
- explains: none — this is the guard that stops the fix for (4) from breaking a child who meant to swing.
- evidence: Ablation over 4000 takes per arm at 120 bpm. A 3:1 swing pattern [0,3,4,7,8,11,12,15] scores Rbar2 = 0.355 at q=4 — ABOVE a 0.30 threshold, so the concentration test accepts it. What refuses it is that snapping to q=4 collapses the pairs: 5 distinct positions survive out of 8. With the guard `distinctAt(q) >= ceil(0.8 * distinctAt(1))`, swing goes to q=4 3% of the time; without the guard, 64%. The guard also correctly does NOT veto on a single stray double-tap (quarters plus one 0.35-step double still pick q=4 88% of the time), which a naive min-IOI guard would — TAP_GUARD_SEC=0.04 permits a 0.32-step IOI at 120 bpm, so stray sub-step pairs are reachable. Rolls are refused at every q, 100% -> q=1.

**[certain]** The corrected Rayleigh statistic is 0/0 = NaN at n=1 and unusably biased at small n without the correction, so any implementation must guard n>=2 and must not threshold the raw resultant length.

- `src/audio/takeLooper.ts:326`
- explains: none — implementation hazard in the fix for (4).
- evidence: `function phaseShift(grid: number[], q: number)` already computes sumSin/sumCos, so the grid-fit statistic is free — but Rhat = 1 identically for a single point, and Rbar2 = (n*Rhat^2 - 1)/(n - 1) evaluates to 0/0 at n=1 (verified: NaN). E[Rhat^2] = 1/n under the null, so an uncorrected threshold on Rhat accepts everything at n=4 — measured mean Rhat at q=1 for a child playing quarters is 0.371 at n=6 purely from small-sample bias, against a true R of 0.013. phaseShift itself is fine at n=1 (the comment at 319-321 is correct — the median is that tap's own residual, so the hit lands exactly on the lattice); it is only the new statistic that degenerates.

