export type StepHandler = (step: number, time: number) => void;

const STEPS_PER_BAR = 16;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
/** Per-beat phase correction ceiling. Below the flam threshold, so inaudible. */
const MAX_PHASE_CORRECTION = 0.004;
/** Past this the grid is audibly wrong, so snap onto it rather than creep. */
const SNAP_THRESHOLD = 0.025;
/** Floor on rateScale, so a stopped platter cannot divide the grid by zero. */
const MIN_RATE_SCALE = 0.05;

/**
 * 16th-note clock for the beat machine.
 *
 * The classic two-clock pattern: a coarse setInterval wakes up and schedules
 * events at precise AudioContext times ahead of the playhead. Drum voices are
 * one-shots started with exact `when` values, so jitter in the wakeup never
 * reaches the audio.
 *
 * start(atTime) exists so the grid can be aligned to a deck's downbeat rather
 * than to whenever the button happened to be pressed.
 */
export class Transport {
  bpm = 120;
  running = false;

  private ctx: AudioContext;
  private nextTime = 0;
  private step = 0;
  private timer: number | null = null;
  /**
   * Optional phase reference: returns the ctx time the next BEAT should land
   * on, or null when there is nothing to follow.
   *
   * Aligning once at start is not enough. The transport accumulates step times
   * from a BPM estimate while a deck plays back sample-accurately, so any error
   * in that estimate integrates into audible drift — and drums started before a
   * track were never aligned at all. This lets the clock keep tracking the
   * music instead of merely starting with it.
   */
  beatPhaseSource: (() => number | null) | null = null;

  private handlers = new Set<StepHandler>();
  /** Scheduled steps awaiting their moment, for driving beat-synced visuals. */
  private queue: Array<{ step: number; time: number }> = [];

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /**
   * Grid speed multiplier, driven by a scratch. 1 is normal, 0 is a stopped
   * platter. The beat machine has no playhead to drag, but it has a GRID — so
   * scaling that is what makes the drums wind down with the record instead of
   * marching on through a scratch.
   */
  rateScale = 1;

  get stepDuration(): number {
    return 60 / this.bpm / 4 / Math.max(MIN_RATE_SCALE, this.rateScale);
  }

  /** Below this the platter is stopped; the grid freezes rather than crawling. */
  get frozen(): boolean {
    return this.rateScale < MIN_RATE_SCALE;
  }

  get barDuration(): number {
    return this.stepDuration * STEPS_PER_BAR;
  }

  onStep(h: StepHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  start(atTime?: number): void {
    if (this.running) return;
    this.running = true;
    this.step = 0;
    this.queue = [];
    this.nextTime = Math.max(atTime ?? 0, this.ctx.currentTime + 0.04);
    this.timer = window.setInterval(() => this.tick(), LOOKAHEAD_MS);
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.queue = [];
  }

  private tick(): void {
    if (!this.running) return;
    if (this.frozen) {
      // A stopped platter stops the beat. Hold nextTime against the clock so the
      // grid resumes from where it stopped instead of firing a burst of catch-up
      // steps the moment the hand lets go.
      this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.02);
      return;
    }
    while (this.nextTime < this.ctx.currentTime + SCHEDULE_AHEAD) {
      // Once per beat, nudge the grid toward the music. The correction is
      // capped at 4 ms — far below the ~20 ms flam threshold, so it is
      // inaudible per beat, but at up to 8 ms/s it tracks any realistic drift.
      // Errors are folded to +/- half a beat: we lock to the BEAT grid, not to
      // a particular downbeat, which is what keeps drums sounding "in time".
      if (this.beatPhaseSource && this.step % 4 === 0) {
        const want = this.beatPhaseSource();
        if (want != null && Number.isFinite(want)) {
          const beat = this.stepDuration * 4;
          let err = want - this.nextTime;
          err -= Math.round(err / beat) * beat;

          if (Math.abs(err) > SNAP_THRESHOLD) {
            // ACQUIRE. A 4 ms-per-beat nudge is a drift tracker, not a way to
            // find the beat: half a beat out at 100 bpm is 300 ms, which would
            // take ~75 beats — 45 seconds — to walk off. Anything this far out
            // is already audibly wrong, so jump straight onto the grid and take
            // one discontinuity instead of a minute of being out of time.
            let target = this.nextTime + err;
            // Never schedule into the past; that would fire a burst of steps.
            while (target < this.ctx.currentTime + 0.005) target += beat;
            this.nextTime = target;
          } else {
            // TRACK. Small and inaudible, purely to cancel accumulating drift.
            this.nextTime += Math.max(-MAX_PHASE_CORRECTION, Math.min(MAX_PHASE_CORRECTION, err));
          }
        }
      }

      for (const h of this.handlers) h(this.step, this.nextTime);
      this.queue.push({ step: this.step, time: this.nextTime });
      this.nextTime += this.stepDuration;
      this.step = (this.step + 1) % STEPS_PER_BAR;
    }
    // Keep the visual queue from growing without bound.
    const now = this.ctx.currentTime;
    while (this.queue.length > 64 && this.queue[0].time < now - 1) this.queue.shift();
  }

  /** Latest step whose scheduled time has actually arrived — for UI pulses. */
  currentStep(): number {
    const now = this.ctx.currentTime;
    let step = -1;
    for (const e of this.queue) {
      if (e.time <= now) step = e.step;
      else break;
    }
    return step;
  }

  /** Time of the next step 0, so a macro can land on a downbeat. */
  nextDownbeatTime(minLeadSec = 0.05): number {
    const now = this.ctx.currentTime;
    if (!this.running) return now + minLeadSec;
    let t = this.nextTime;
    let s = this.step;
    // Walk forward from the next unscheduled step to the next step-0.
    for (let i = 0; i < STEPS_PER_BAR * 2; i++) {
      if (s === 0 && t >= now + minLeadSec) return t;
      t += this.stepDuration;
      s = (s + 1) % STEPS_PER_BAR;
    }
    return now + minLeadSec;
  }
}
