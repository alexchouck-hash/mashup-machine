import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Deck } from '../audio/Deck';

/**
 * A spinning record you can grab.
 *
 * Three separations make this tractable, and every one of them is load-bearing:
 *
 *  - ANGLE COMES FROM AUDIO POSITION, never from the finger. Idle we draw
 *    deck.positionSecNow, so the platter slows, stops and reverses exactly as
 *    the audio does. During a grab we draw our own clamped target instead (zero
 *    latency, guaranteed 1:1 with the finger) and cross-fade the two angles on
 *    release. If the integrator wires the callbacks to seekSeconds the two
 *    agree and the blend is invisible; if it wires nothing, the record eases
 *    back to the truth instead of snapping.
 *  - UNWRAP PER POINTER EVENT, EMIT PER FRAME. The ±π seam has to be fixed on
 *    every raw sample (a fast flick between two frames can exceed π), so
 *    pointermove only unwraps and accumulates. The rAF loop is the only thing
 *    that clamps, differentiates and calls back — which bounds the callback
 *    rate to the display refresh and gives the derivative one uniform dt.
 *  - POINTER MATH IN CSS px, DRAWING IN DEVICE px. They never mix.
 *
 * Like Waveform and the Party visualizer, nothing here flows through React:
 * one rAF loop reads the deck directly, and there is no useState at all.
 */

const TAU = Math.PI * 2;

/**
 * 33⅓ rpm: one turn is 1.8 s of audio at rate 1. This is the single scale
 * constant — 1 rad/s of platter is 0.286× playback, and a full turn in 1.8 s
 * is exactly normal speed, which is what makes the control feel like vinyl
 * rather than like a scrubber.
 */
const SEC_PER_REV = 1.8;
const SEC_PER_RAD = SEC_PER_REV / TAU;

/** Report cap on `rate` only. Position is never capped — the record must not lag the finger. */
const MAX_REPORTED_RATE = 8;

/** Dead zone, as a fraction of platter radius. The label is 0.30R; atan2 near
 *  the spindle is numerically meaningless, and on a real deck you grab the
 *  vinyl, not the label. */
const DEAD_FRAC = 0.32;
const DEAD_MIN_PX = 12;

/** Per-event clamp after unwrap (0.45 s of audio). A real flick peaks near
 *  0.3 rad/event, so this only bites when the main thread has stalled — and a
 *  bounded lag is far better than a half-second position jump from one sample. */
const MAX_STEP_RAD = Math.PI / 2;

const MIN_DT = 0.004;
/** A backgrounded tab must not come back and integrate five seconds at once. */
const MAX_DT = 0.1;
const RATE_TAU = 0.045;

/** Each emit becomes a worklet seek, and seek costs a FIFO flush. Cap the rate. */
const EMIT_MIN_MS = 16;
const EMIT_MIN_SEC = 0.0005;

/**
 * Floor on the emit rate, independent of movement.
 *
 * The movement gate above is right about bandwidth and wrong about liveness: a
 * hand that grabs, flings and then HOLDS STILL stops emitting entirely, and a
 * platter driver whose liveness is inferred from traffic would then lose the
 * record under a stationary finger — which is legitimate, common, and exactly
 * what a scratch pause is. The re-emitted position is identical, so applyJog's
 * error is zero and it takes the servo branch: audibly free.
 *
 * It is also the honest fix for the thing Fx's crackle bed documents at length —
 * a motionless hand sends no further update — replacing a self-decaying envelope
 * with a heartbeat.
 */
const HEARTBEAT_MS = 200;

/** Spin-up / re-sync blend after release. */
const RELEASE_MS = 140;

const GROOVES = 26;

const VINYL = '#0d1018';
const GROOVE = 'rgba(255,255,255,0.045)';
const GROOVE_ACCENT = 'rgba(255,255,255,0.10)';
const SHEEN = 'rgba(255,255,255,0.075)';
const RIM_IDLE = '#2a3244';
const RIM_GRAB = '#e2e8f0';
const TRACK = '#232b3d';
/** Same lime as Waveform's loop region, so the two read as one system. */
const LOOP = 'rgba(163,230,53,0.85)';
const HEAD = '#ffffff';
const LABEL_TEXT = '#0a0d14';
const MARKER = 'rgba(255,255,255,0.82)';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Wrap to (-π, π]. The ONE place the seam is handled — used by both the
 *  pointer unwrap and the release blend. */
const wrapPi = (x: number) => ((((x + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

/**
 * SIGN CONVENTION, agreed by construction so nothing anywhere needs a flip:
 * canvas rotate(+θ) is clockwise (y is down), atan2(dy, dx) increases clockwise
 * for the same reason, vinyl spins clockwise, and forward audio increases θ.
 * Dragging clockwise therefore scrubs FORWARD.
 */
const angleOf = (sec: number) => ((TAU * (Number.isFinite(sec) ? sec : 0)) / SEC_PER_REV) % TAU;

/**
 * The loop region, but only when it describes THIS track. Deck.unload() clears
 * `loop` and leaves loopStartSec/loopEndSec pointing into the previous track,
 * so an unguarded read draws a region past the end of a shorter new one.
 */
function loopRegion(deck: Deck): { start: number; end: number } | null {
  const s = deck.loopStartSec;
  const e = deck.loopEndSec;
  const d = deck.durationSec;
  if (s == null || e == null || !(d > 0)) return null;
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (!(e > s) || s < 0 || e > d) return null;
  return { start: s, end: e };
}

/** Clamp a scratch target to the playable span — the loop region when one bites. */
function clampTarget(deck: Deck, sec: number): number {
  const reg = loopRegion(deck);
  const lo = deck.loop && reg ? reg.start : 0;
  const hi = deck.loop && reg ? reg.end : Math.max(0, deck.durationSec);
  return clamp(Number.isFinite(sec) ? sec : 0, lo, hi);
}

/**
 * The static vinyl body, rendered once and blitted rotated every frame. Only
 * the position marker is drawn live — redrawing 26 grooves and a radial
 * gradient per frame per deck would not hold 60 fps on a tablet.
 */
function buildPlatter(diameter: number, dpr: number, color: string, label: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const side = Math.max(2, Math.ceil(diameter));
  c.width = side;
  c.height = side;
  const g = c.getContext('2d');
  if (!g) return c;

  const r = side / 2;

  g.fillStyle = VINYL;
  g.beginPath();
  g.arc(r, r, r, 0, TAU);
  g.fill();

  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.lineWidth = dpr;
  g.beginPath();
  g.arc(r, r, r - dpr, 0, TAU);
  g.stroke();

  for (let i = 0; i < GROOVES; i++) {
    const rr = r * (0.345 + 0.61 * (i / (GROOVES - 1)));
    g.strokeStyle = i % 6 === 0 ? GROOVE_ACCENT : GROOVE;
    g.lineWidth = dpr;
    g.beginPath();
    g.arc(r, r, rr, 0, TAU);
    g.stroke();
  }

  // An off-centre sheen rotating with the platter is what keeps rotation
  // legible when a finger is covering the marker. A conic gradient would look
  // better still, but createConicGradient is late in Safari and this file has a
  // no-dependency, no-fetch budget.
  g.save();
  g.beginPath();
  g.arc(r, r, r, 0, TAU);
  g.clip();
  const sx = r - 0.45 * r;
  const grad = g.createRadialGradient(sx, sx, 0, sx, sx, 1.25 * r);
  grad.addColorStop(0, SHEEN);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, side, side);
  g.restore();

  g.fillStyle = color;
  g.beginPath();
  g.arc(r, r, 0.3 * r, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 1.5 * dpr;
  g.stroke();

  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = dpr;
  g.beginPath();
  g.arc(r, r, 0.22 * r, 0, TAU);
  g.stroke();

  g.fillStyle = LABEL_TEXT;
  g.font = `900 ${0.2 * r}px ui-sans-serif, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, r, r - 0.02 * r);

  g.fillStyle = '#0a0d14';
  g.beginPath();
  g.arc(r, r, 0.045 * r, 0, TAU);
  g.fill();

  return c;
}

/**
 * Absolute position at the grab.
 *
 * `wasPlaying` is deliberately NOT here. It was a snapshot taken at pointerdown
 * and handed back at pointerup, so grabbing the annulus, toggling play and
 * lifting silently undid the toggle. A release resolves from live transport
 * state instead; a driver that genuinely has an intent (a macro's slam) states
 * it at the release, where it is legible.
 */
export interface ScratchStart {
  deck: Deck;
  positionSec: number;
}

/**
 * `positionSec` is absolute and already clamped — the primary field. Absolute
 * positions are self-correcting: a dropped or throttled emit costs smoothness,
 * never accumulated drift. `rate` and `dtSec` exist so an integrator that later
 * gains a real scrub message can drive a signed read rate instead of seeking.
 */
export interface ScratchMove {
  deck: Deck;
  positionSec: number;
  deltaSec: number;
  rate: number;
  dtSec: number;
}

export interface ScratchEnd {
  deck: Deck;
  positionSec: number;
  rate: number;
}

interface Props {
  deck: Deck;
  color: string;
  onScratchStart?: (e: ScratchStart) => void;
  onScratchMove?: (e: ScratchMove) => void;
  onScratchEnd?: (e: ScratchEnd) => void;
}

/**
 * What an owner of this platter can do to the PICTURE when it loses the record.
 *
 * `abort` is literally the existing endGesture, so it still fires onScratchEnd
 * and the "exactly one end per start" invariant is untouched — the release lands
 * on a dead lease and is a no-op through the door. This is cheap insurance, not
 * load-bearing: every path that revokes a primary claim today (mode switch, tab
 * hidden, idle expiry) also ends the gesture by another route. It exists so the
 * drawn record cannot keep tracking a finger that no longer moves the audio.
 */
export interface TurntableHandle {
  abort: () => void;
}

export const Turntable = forwardRef<TurntableHandle, Props>(function Turntable(
  { deck, color, onScratchStart, onScratchMove, onScratchEnd },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<{ img: HTMLCanvasElement; key: string } | null>(null);

  // Callers pass inline arrows. Without this indirection the rAF effect would
  // tear down and rebuild on every parent render — and abort a live gesture.
  const cbRef = useRef({ onScratchStart, onScratchMove, onScratchEnd });

  const gRef = useRef({
    pointerId: null as number | null,
    cx: 0,
    cy: 0,
    r: 0,
    dead: 0,
    lastAngle: 0,
    /** False while inside the dead zone: the next sample re-seeds instead of deltaing. */
    seeded: false,
    accumRad: 0,
    anchorSec: 0,
    targetSec: 0,
    lastEmitMs: 0,
    lastEmitSec: 0,
    lastFrameMs: 0,
    rate: 0,
    releaseAtMs: 0,
    releaseAngle: 0,
    swallowClick: false,
  });

  // The window listeners must keep a stable identity to be removable, but their
  // bodies close over `deck`. Register a fixed wrapper, redirect it per render.
  const liveRef = useRef<{ reMeasure: () => void; end: () => void }>({
    reMeasure: () => {},
    end: () => {},
  });
  const onWindowGeometry = useRef(() => liveRef.current.reMeasure()).current;
  const onWindowBlur = useRef(() => liveRef.current.end()).current;

  useImperativeHandle(ref, () => ({ abort: () => liveRef.current.end() }), []);

  const detachWindow = () => {
    window.removeEventListener('scroll', onWindowGeometry, true);
    window.removeEventListener('resize', onWindowGeometry);
    window.removeEventListener('blur', onWindowBlur);
  };

  /**
   * Geometry in CSS px, captured at pointerdown and refreshed only on
   * scroll/resize — never per frame. Party Mode's tile writes a beat-pulse
   * transform every frame, so a per-frame getBoundingClientRect() would
   * oscillate the measured centre with the kick and inject angular jitter into
   * a live drag.
   */
  const measure = (): boolean => {
    const el = canvasRef.current;
    if (!el) return false;
    const g = gRef.current;
    const rect = el.getBoundingClientRect();
    g.cx = rect.left + rect.width / 2;
    g.cy = rect.top + rect.height / 2;
    g.r = Math.min(rect.width, rect.height) / 2 - 5;
    g.dead = Math.max(DEAD_MIN_PX, DEAD_FRAC * g.r);
    return g.r >= 12;
  };

  const reMeasure = () => {
    if (gRef.current.pointerId === null) return;
    measure();
    // The centre moved under the finger, so the next raw angle is not
    // comparable with the last one. Re-seed rather than emit that difference.
    gRef.current.seeded = false;
  };

  /**
   * Exactly one onScratchEnd per onScratchStart, guaranteed across pointerup,
   * pointercancel, lostpointercapture, window blur, the deck being unloaded
   * mid-gesture, and effect cleanup. An unpaired end would leave a paused deck
   * silent for the rest of the party.
   */
  const endGesture = () => {
    const g = gRef.current;
    if (g.pointerId === null) return;
    detachWindow();
    g.releaseAtMs = performance.now();
    g.releaseAngle = angleOf(g.targetSec);
    g.pointerId = null;
    g.seeded = false;
    if (canvasRef.current) canvasRef.current.style.cursor = '';
    cbRef.current.onScratchEnd?.({ deck, positionSec: g.targetSec, rate: g.rate });
  };

  useEffect(() => {
    cbRef.current = { onScratchStart, onScratchMove, onScratchEnd };
    liveRef.current.reMeasure = reMeasure;
    liveRef.current.end = endGesture;
  });

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gRef.current;
    if (g.pointerId !== null) return; // a second finger on the same platter
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Gate here and nowhere else, so start and end can never unpair.
    if (!deck.loaded || !cbRef.current.onScratchMove) return;
    if (!measure()) return;

    const dx = e.clientX - g.cx;
    const dy = e.clientY - g.cy;
    const r = Math.hypot(dx, dy);
    // A label tap, or a corner of the square canvas: let the parent have it.
    if (r < g.dead || r > g.r + 4) return;

    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }

    g.pointerId = e.pointerId;
    g.lastAngle = Math.atan2(dy, dx);
    g.seeded = true;
    g.accumRad = 0;
    // Seeded from the platter's REAL position, which now extrapolates at what
    // the record is actually doing — so landing on a platter a macro is winding
    // down produces a first jog error near zero and a servo, not a splice.
    g.anchorSec = g.targetSec = clampTarget(deck, deck.positionSecNow);
    g.rate = 0;
    g.releaseAtMs = 0;
    g.swallowClick = true;
    g.lastEmitMs = g.lastFrameMs = performance.now();
    g.lastEmitSec = g.targetSec;

    window.addEventListener('scroll', onWindowGeometry, true);
    window.addEventListener('resize', onWindowGeometry);
    // Alt-tabbing mid-drag swallows the pointerup.
    window.addEventListener('blur', onWindowBlur);
    e.currentTarget.style.cursor = 'grabbing';

    cbRef.current.onScratchStart?.({ deck, positionSec: g.targetSec });
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gRef.current;
    if (e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.cx;
    const dy = e.clientY - g.cy;
    if (Math.hypot(dx, dy) < g.dead) {
      g.seeded = false; // inside the spindle atan2 is noise
      return;
    }
    const a = Math.atan2(dy, dx);
    if (!g.seeded) {
      // Re-seed on leaving the dead zone: crossing it must not produce a delta.
      g.lastAngle = a;
      g.seeded = true;
      return;
    }
    let d = wrapPi(a - g.lastAngle);
    d = clamp(d, -MAX_STEP_RAD, MAX_STEP_RAD);
    g.lastAngle = a;
    g.accumRad += d;
  };

  /**
   * Gate on the pointer id. A second finger landing on the platter is refused by
   * onDown, but touch still grants it implicit capture, so ITS pointerup would
   * otherwise end the first finger's live gesture — leaving the primary finger
   * down, every further move dropped, and the deck resuming under a held hand.
   * Two fingers on a big circle is the first thing a seven-year-old tries.
   */
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId === gRef.current.pointerId) endGesture();
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Swallow our own click so a grab inside a song tile does not also toggle play.
    if (gRef.current.swallowClick) {
      gRef.current.swallowClick = false;
      e.stopPropagation();
    }
  };

  useEffect(() => {
    let raf = 0;

    const frame = () => {
      const g = gRef.current;
      const now = performance.now();
      const dt = clamp((now - g.lastFrameMs) / 1000, MIN_DT, MAX_DT);
      g.lastFrameMs = now;

      // Another surface hit Swap while a finger was down.
      if (g.pointerId !== null && !deck.loaded) liveRef.current.end();

      if (g.pointerId !== null) {
        const raw = g.anchorSec + g.accumRad * SEC_PER_RAD;
        const t = clampTarget(deck, raw);
        if (t !== raw) {
          // ANTI-WINDUP. Re-anchor at the stop, or a child who scratches into
          // the end of the track has to unwind all that surplus rotation before
          // anything responds — which reads as a broken control.
          g.anchorSec = t;
          g.accumRad = 0;
        }
        const rawRate = (t - g.targetSec) / dt;
        const a = 1 - Math.exp(-dt / RATE_TAU);
        g.rate += (clamp(rawRate, -MAX_REPORTED_RATE, MAX_REPORTED_RATE) - g.rate) * a;
        g.targetSec = t;

        const dSec = t - g.lastEmitSec;
        const stale = now - g.lastEmitMs >= HEARTBEAT_MS;
        if (now - g.lastEmitMs >= EMIT_MIN_MS && (Math.abs(dSec) >= EMIT_MIN_SEC || stale)) {
          cbRef.current.onScratchMove?.({
            deck,
            positionSec: t,
            deltaSec: dSec,
            rate: g.rate,
            dtSec: clamp((now - g.lastEmitMs) / 1000, MIN_DT, MAX_DT),
          });
          g.lastEmitMs = now;
          g.lastEmitSec = t;
        }
      }

      const grabbed = g.pointerId !== null;
      let theta: number;
      if (grabbed) {
        theta = angleOf(g.targetSec);
      } else if (g.releaseAtMs) {
        const u = (now - g.releaseAtMs) / RELEASE_MS;
        if (u >= 1) {
          g.releaseAtMs = 0;
          theta = angleOf(deck.positionSecNow);
        } else {
          // Shortest arc, so a release never unwinds through a whole turn.
          const s = u * u * (3 - 2 * u);
          theta = g.releaseAngle + wrapPi(angleOf(deck.positionSecNow) - g.releaseAngle) * s;
        }
      } else {
        theta = angleOf(deck.positionSecNow);
      }

      draw(theta, grabbed);
      raf = requestAnimationFrame(frame);
    };

    const draw = (theta: number, grabbed: boolean) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Clamped to 2 for this component only: it is the one cached bitmap we
      // rotate every frame, and at dpr 3 a 220 px platter is a 1.7 MB texture
      // resampled 60 times a second for detail nobody can see.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (w < 48 || h < 48) return; // not laid out yet, or display:none

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const S = Math.min(w, h);
      const R = S / 2 - 5 * dpr;
      const cx = w / 2;
      const cy = h / 2;

      const key = `${w}x${h}:${color}:${deck.label}`;
      if (cacheRef.current?.key !== key) {
        cacheRef.current = { img: buildPlatter(2 * R, dpr, color, deck.label), key };
      }

      const empty = !deck.loaded;
      const phase = deck.playing ? deck.beatPhaseNow() : null;
      const pop = phase == null ? 0 : Math.pow(1 - phase, 4);

      ctx.clearRect(0, 0, w, h);
      if (empty) ctx.globalAlpha = 0.38;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(theta);
      ctx.drawImage(cacheRef.current.img, -R, -R, 2 * R, 2 * R);
      if (!empty) {
        // Live, not baked: it is the one thing that must read as "this is where
        // the needle is", and it brightens under the finger.
        ctx.fillStyle = grabbed ? '#ffffff' : MARKER;
        ctx.fillRect(-1.6 * dpr, -0.965 * R, 3.2 * dpr, 0.65 * R);
        ctx.beginPath();
        ctx.arc(0, -0.88 * R, 0.05 * R, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      ctx.lineWidth = (grabbed ? 3 : 2) * dpr;
      ctx.strokeStyle = grabbed ? RIM_GRAB : deck.playing ? color : RIM_IDLE;
      if (deck.playing && !empty) {
        ctx.shadowColor = `${color}99`;
        ctx.shadowBlur = (10 + pop * 20) * dpr;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      // Leaking shadow state onto the rings below is the classic canvas bug here.
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';

      // The rotating disc reads SPEED; this static ring reads TRACK POSITION
      // and the loop. An angular loop marker on the disc would be meaningless
      // at 1.8 s per revolution.
      if (!empty && deck.durationSec > 0) {
        const Rp = R + 3.5 * dpr;
        const ang = (t: number) => -Math.PI / 2 + TAU * (t / deck.durationSec);

        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = TRACK;
        ctx.beginPath();
        ctx.arc(cx, cy, Rp, 0, TAU);
        ctx.stroke();

        // Drawn under the played arc and wider, so the lime shows either side.
        const reg = loopRegion(deck);
        if (reg) {
          ctx.lineWidth = 5 * dpr;
          ctx.strokeStyle = LOOP;
          ctx.beginPath();
          ctx.arc(cx, cy, Rp, ang(reg.start), ang(reg.end));
          ctx.stroke();
        }

        const frac = clamp(deck.positionSecNow / deck.durationSec, 0, 1);
        if (frac > 0) {
          ctx.lineWidth = 3 * dpr;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.arc(cx, cy, Rp, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
          ctx.stroke();
        }

        ctx.fillStyle = HEAD;
        ctx.beginPath();
        ctx.arc(
          cx + Rp * Math.cos(ang(deck.positionSecNow)),
          cy + Rp * Math.sin(ang(deck.positionSecNow)),
          2.2 * dpr,
          0,
          TAU
        );
        ctx.fill();
      }

      ctx.globalAlpha = 1;
    };

    gRef.current.lastFrameMs = performance.now();
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      liveRef.current.end();
    };
  }, [deck, color]);

  // Unmount safety net: the gesture also holds window listeners.
  useEffect(() => detachWindow, []);

  const interactive = deck.loaded && !!onScratchMove;

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
      onClick={onClick}
      aria-label={`Deck ${deck.label} record — drag to scratch`}
      // touch-none is load-bearing: without touch-action:none a vertical
      // scratch scrolls the Party page out from under the finger.
      className={`w-full aspect-square block select-none touch-none ${
        interactive ? 'cursor-grab' : ''
      }`}
    />
  );
});
