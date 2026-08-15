export type StepHandler = (step: number, time: number) => void;

const STEPS_PER_BAR = 16;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

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
  private handlers = new Set<StepHandler>();
  /** Scheduled steps awaiting their moment, for driving beat-synced visuals. */
  private queue: Array<{ step: number; time: number }> = [];

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get stepDuration(): number {
    return 60 / this.bpm / 4;
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
    while (this.nextTime < this.ctx.currentTime + SCHEDULE_AHEAD) {
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
