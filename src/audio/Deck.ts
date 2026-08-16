import type { AudioEngine, CrossfadeAssign } from './AudioEngine';
import type { AnalysisResult, Peaks, VocalMode } from './types';
import { computePeaks, monoDownmix } from './peaks';
import { analyzeTrack } from '../analysis/analyzer';
import { camelotOf, harmonicNudgeSemitones, keyNameOf, semitonesToRatio } from './camelot';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Exponential sweep, so filter knobs feel linear to the ear. */
const expMap = (t: number, from: number, to: number) => from * Math.pow(to / from, t);

/**
 * How long a nominally-playing deck may sit motionless before we assume the
 * platter is stranded. Long enough that a legitimately paused-then-played deck
 * or a slow scratch release never trips it; short enough that a child does not
 * stand there wondering why the record stopped.
 */
const STALL_SEC = 0.6;

/** Auto-gain target, dBFS. Roughly streaming-service loudness. */
const TARGET_LOUDNESS_DB = -14;

/**
 * The only hard limit on tempo. `tempoRange` bounds the FADER, not the model:
 * Sync must be able to reach a distant BPM (a 100 -> 120 match is +19.2%, well
 * past the ±8% fader), and once there, a nudge must move relative to where it
 * is. Clamping the model to the fader range instead made the first nudge after
 * a sync snap the deck back to ±8% and break the beatmatch.
 */
const MAX_TEMPO_PERCENT = 50;

export type CueIndex = 0 | 1 | 2 | 3;

/**
 * One deck. Two exist in Phase 1 but nothing here assumes that — the engine
 * hands out partners by lookup, not by an A/B constant.
 *
 * Audio chain:
 *   stretch worklet -> low -> mid -> high -> HPF -> LPF -> gain -> crossfader
 */
export class Deck {
  readonly id: string;
  readonly label: string;
  crossfadeSide: CrossfadeAssign = null;

  private engine: AudioEngine;
  private node: AudioWorkletNode;
  private eqLow: BiquadFilterNode;
  private eqMid: BiquadFilterNode;
  private eqHigh: BiquadFilterNode;
  private hpf: BiquadFilterNode;
  private lpf: BiquadFilterNode;
  readonly output: GainNode;

  fileName = '';
  loading = false;
  analyzing = false;
  peaks: Peaks | null = null;
  analysis: AnalysisResult | null = null;
  durationSec = 0;
  lengthFrames = 0;

  /**
   * Updated ~30 Hz from the worklet. Deliberately a plain mutable field: the
   * canvas rAF loop reads it directly so the playhead never costs a React
   * render (spec: 60 fps with both decks animating).
   */
  positionFrames = 0;
  playing = false;
  /** ctx time when positionFrames last changed, for extrapolating between posts. */
  private posUpdatedAt = 0;

  cues: Array<number | null> = [null, null, null, null];

  tempoPercent = 0;
  tempoRange: 8 | 16 = 8;
  volume = 1;
  eqLowDb = 0;
  eqMidDb = 0;
  eqHighDb = 0;
  filterKnob = 0; // -1 = full LPF sweep, 0 = off, +1 = full HPF sweep
  nudgeSemitones = 0;
  loop = false;
  loopStartSec: number | null = null;
  loopEndSec: number | null = null;
  vocalMode: VocalMode = 'both';
  /** RMS of the side signal relative to mid. 0 = mono, so nothing to cancel. */
  stereoWidth = 0;
  /** A finger is on this platter. Set at the gesture boundaries only. */
  scratching = false;
  /** ctx time the playhead stopped moving while nominally playing, or 0. */
  private stalledSince = 0;

  private pathBoth: GainNode;
  private pathMusic: GainNode;
  private pathVocals: GainNode;

  private assistLowDb = 0;
  private autoGainDb = 0;

  constructor(engine: AudioEngine, id: string, label: string) {
    this.engine = engine;
    this.id = id;
    this.label = label;

    const ctx = engine.ctx;

    this.node = new AudioWorkletNode(ctx, 'stretch-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => this.onWorkletMessage(e.data);

    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 120;

    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.9;

    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 5000;

    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 20;
    this.hpf.Q.value = 0.9;

    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 20000;
    this.lpf.Q.value = 0.9;

    this.output = ctx.createGain();

    // Vocal isolate / remove via mid-side. Lead vocals are almost always panned
    // to the centre, so the side signal (L-R) has them largely cancelled and the
    // mid signal (L+R) is mostly centre content. Crude — it also cancels kick,
    // snare and bass, which are centred too — but instant, local and free.
    //
    // SWAP POINT: a real separation model replaces these three paths. Everything
    // downstream (EQ, filters, crossfader, recorder) is unchanged by that.
    const splitter = ctx.createChannelSplitter(2);
    this.node.connect(splitter);

    const mid = ctx.createGain();
    const side = ctx.createGain();
    const tap = (channel: number, into: GainNode, gain: number) => {
      const g = ctx.createGain();
      g.gain.value = gain;
      splitter.connect(g, channel);
      g.connect(into);
    };
    tap(0, mid, 0.5);
    tap(1, mid, 0.5);
    tap(0, side, 0.5);
    tap(1, side, -0.5);

    this.pathBoth = ctx.createGain();
    this.pathBoth.gain.value = 1;
    this.node.connect(this.pathBoth);

    this.pathMusic = ctx.createGain();
    this.pathMusic.gain.value = 0;
    side.connect(this.pathMusic);

    // Band-limit the isolated centre: kick and bass live there as well, and
    // cutting them makes what is left read as a voice.
    const vocalBand = ctx.createBiquadFilter();
    vocalBand.type = 'bandpass';
    vocalBand.frequency.value = 1400;
    vocalBand.Q.value = 0.5;
    this.pathVocals = ctx.createGain();
    this.pathVocals.gain.value = 0;
    mid.connect(vocalBand).connect(this.pathVocals);

    for (const p of [this.pathBoth, this.pathMusic, this.pathVocals]) p.connect(this.eqLow);

    this.eqLow
      .connect(this.eqMid)
      .connect(this.eqHigh)
      .connect(this.hpf)
      .connect(this.lpf)
      .connect(this.output);
  }

  /** Play the whole mix, just the music, or just the (rough) vocals. */
  setVocalMode(mode: VocalMode): void {
    this.vocalMode = mode;
    const t = this.engine.ctx.currentTime;
    const ramp = (g: GainNode, v: number) => g.gain.setTargetAtTime(v, t, 0.02);
    // The mid/side taps halve the signal, so the isolated paths are boosted back.
    ramp(this.pathBoth, mode === 'both' ? 1 : 0);
    ramp(this.pathMusic, mode === 'music' ? 2 : 0);
    ramp(this.pathVocals, mode === 'vocals' ? 1.4 : 0);
    this.engine.notify();
  }

  /** Constrain looping to a section. Pass null to loop the whole track. */
  setLoopRegion(startSec: number | null, endSec: number | null): void {
    if (startSec == null || endSec == null || endSec <= startSec) {
      this.loopStartSec = null;
      this.loopEndSec = null;
      this.node.port.postMessage({ type: 'loopRegion', start: 0, end: 0 });
    } else {
      this.loopStartSec = startSec;
      this.loopEndSec = endSec;
      this.node.port.postMessage({
        type: 'loopRegion',
        start: Math.round(startSec * this.sampleRate),
        end: Math.round(endSec * this.sampleRate),
      });
    }
    this.engine.notify();
  }

  /**
   * Loop the detected hook — the most-repeated section, which is almost always
   * the chorus. Beat-locked to the other deck like any other launch.
   */
  playHook(): void {
    const a = this.analysis;
    if (!a || a.hookLengthSec <= 0) return;
    this.setLoopRegion(a.hookStartSec, a.hookStartSec + a.hookLengthSec);
    this.setLoop(true);
    this.seekSeconds(a.hookStartSec, true);
    this.playing = true;
    const partner = this.engine.partnerOf(this);
    if (this.engine.assist.beatLock && partner?.playing) {
      this.matchTempo(partner);
      this.alignPhaseTo(partner);
    }
    this.engine.notify();
  }

  /* --------------------------------------------------------------- getters */

  get sampleRate(): number {
    return this.engine.ctx.sampleRate;
  }

  get positionSec(): number {
    return this.positionFrames / this.sampleRate;
  }

  /**
   * Playhead extrapolated to right now. The worklet reports at 30 Hz, so the
   * raw value can be up to ~33 ms stale — enough to hear as a flam when the
   * beat machine aligns its grid to this. Extrapolating removes most of it.
   */
  get positionSecNow(): number {
    if (!this.playing) return this.positionSec;
    const elapsed = Math.max(0, this.engine.ctx.currentTime - this.posUpdatedAt);
    const rate = 1 + this.tempoPercent / 100;
    return Math.min(this.durationSec, this.positionSec + elapsed * rate);
  }

  get loaded(): boolean {
    return this.lengthFrames > 0;
  }

  /** BPM after the tempo fader — what actually has to match to beatmatch. */
  get effectiveBpm(): number {
    if (!this.analysis) return 0;
    return this.analysis.bpm * (1 + this.tempoPercent / 100);
  }

  /**
   * Whether centre-cancel can produce anything. Below this the side signal is
   * so far down that "music only" would be near-silence, not an instrumental.
   */
  get canRemoveVocals(): boolean {
    return this.loaded && this.stereoWidth > 0.02;
  }

  /** Deck A is the harmonic anchor; only the other deck ever gets nudged. */
  get isAnchor(): boolean {
    return this.engine.decks[0] === this;
  }

  /* ---------------------------------------------------------------- loading */

  async load(file: File): Promise<void> {
    this.loading = true;
    this.fileName = file.name;
    this.engine.notify();
    try {
      const bytes = await file.arrayBuffer();
      const buffer = await this.engine.ctx.decodeAudioData(bytes);
      await this.adopt(buffer, file.name, false);
    } catch (err) {
      this.loading = false;
      this.analyzing = false;
      this.fileName = `${file.name} — could not decode`;
      this.engine.notify();
      throw err;
    }
  }

  /**
   * Load already-decoded audio — a built-in jam rendered offline, for example.
   *
   * `known` overrides analysis for facts the caller already holds exactly.
   * Built-in jams are authored at a specific BPM and key with the first beat at
   * zero, so detecting those would be guessing at something we already know,
   * and detection is imperfect on dense percussive material.
   */
  async loadBuffer(
    buffer: AudioBuffer,
    name: string,
    opts: { loop?: boolean; known?: Partial<AnalysisResult> } = {}
  ): Promise<void> {
    this.loading = true;
    this.fileName = name;
    this.engine.notify();
    await this.adopt(buffer, name, opts.loop ?? false, opts.known);
  }

  private async adopt(
    buffer: AudioBuffer,
    name: string,
    loop: boolean,
    known?: Partial<AnalysisResult>
  ): Promise<void> {
    try {
      this.fileName = name;
      this.durationSec = buffer.duration;
      this.lengthFrames = buffer.length;
      this.peaks = computePeaks(buffer);
      this.positionFrames = 0;
      this.playing = false;
      this.cues = [null, null, null, null];
      this.analysis = null;
      this.tempoPercent = 0;
      this.pushRate();

      const mono = monoDownmix(buffer);

      const chans: Float32Array[] = [];
      const n = Math.min(2, buffer.numberOfChannels);
      for (let c = 0; c < n; c++) chans.push(new Float32Array(buffer.getChannelData(c)));
      if (chans.length === 1) chans.push(new Float32Array(chans[0])); // dual mono

      // Stereo width, measured BEFORE the buffers are transferred away.
      // Centre-cancel is L-R, so a mono file (or one whose channels are
      // identical) cancels to digital silence — and the mono path above
      // duplicates the channel, guaranteeing exactly that. Measure it so the
      // UI can refuse the mode instead of playing nothing.
      {
        const [l, r] = chans;
        const stride = Math.max(1, Math.floor(l.length / 200_000));
        let midSq = 0;
        let sideSq = 0;
        for (let i = 0; i < l.length; i += stride) {
          const m = (l[i] + r[i]) * 0.5;
          const s = (l[i] - r[i]) * 0.5;
          midSq += m * m;
          sideSq += s * s;
        }
        this.stereoWidth = Math.sqrt(sideSq / Math.max(midSq, 1e-12));
      }

      const buffers = chans.map((a) => a.buffer);
      this.node.port.postMessage({ type: 'load', channels: buffers }, buffers);
      this.setLoop(loop);
      // The AudioBuffer is now redundant: the worklet owns the audio and the
      // canvas draws from `peaks`. Dropping it here halves memory per deck.

      this.loading = false;
      this.analyzing = true;
      this.engine.notify();

      const result = await analyzeTrack(mono, this.engine.ctx.sampleRate);
      // Analysis still runs even when `known` is supplied: loudness for the
      // auto-gain assist is measured, not authored.
      const merged: AnalysisResult = { ...result, ...known };
      if (known?.keyPc !== undefined || known?.keyMode !== undefined) {
        merged.camelot = camelotOf(merged.keyPc, merged.keyMode);
        merged.keyName = keyNameOf(merged.keyPc, merged.keyMode);
        merged.keyConfidence = 1;
      }
      if (known?.bpm !== undefined) merged.bpmConfidence = 1;
      this.analysis = merged;
      this.analyzing = false;
      this.computeAutoGain();
      this.applyGain();
      // Both decks re-evaluate: the nudge depends on the pair, not one track.
      for (const d of this.engine.decks) d.applyHarmonicNudge();
      this.engine.notify();
    } catch (err) {
      this.loading = false;
      this.analyzing = false;
      this.engine.notify();
      throw err;
    }
  }

  /** Return the deck to empty, so the picker comes back. */
  unload(): void {
    this.pause();
    this.node.port.postMessage({ type: 'unload' });
    this.fileName = '';
    this.durationSec = 0;
    this.lengthFrames = 0;
    this.positionFrames = 0;
    this.peaks = null;
    this.analysis = null;
    this.cues = [null, null, null, null];
    this.loop = false;
    this.tempoPercent = 0;
    this.nudgeSemitones = 0;
    this.pushRate();
    this.engine.notify();
  }

  setLoop(on: boolean): void {
    this.loop = on;
    this.node.port.postMessage({ type: 'loop', enabled: on });
    this.engine.notify();
  }

  private onWorkletMessage(m: { type: string; frame?: number; playing?: boolean; length?: number }): void {
    switch (m.type) {
      case 'pos': {
        const prev = this.positionFrames;
        this.positionFrames = m.frame ?? 0;
        this.posUpdatedAt = this.engine.ctx.currentTime;

        // Stall watchdog. A deck that reads as playing, is not under a finger,
        // and has not moved for STALL_SEC is stuck — the worklet is holding a
        // platter nobody is going to release. Free it rather than leave a dead
        // deck on screen; a spurious scratchOff on a healthy deck is a no-op.
        if (this.playing && !this.scratching && Math.abs(this.positionFrames - prev) < 2) {
          if (this.stalledSince === 0) this.stalledSince = this.engine.ctx.currentTime;
          else if (this.engine.ctx.currentTime - this.stalledSince > STALL_SEC) {
            this.stalledSince = 0;
            console.warn('[deck] stalled while playing — forcing the platter back');
            this.node.port.postMessage({ type: 'scratchOff', play: true });
            this.node.port.postMessage({ type: 'play' });
          }
        } else {
          this.stalledSince = 0;
        }
        if (m.playing !== undefined && m.playing !== this.playing) {
          this.playing = m.playing;
          this.engine.notify();
        }
        break;
      }
      case 'ended':
        this.playing = false;
        this.engine.notify();
        break;
      case 'loaded':
        this.lengthFrames = m.length ?? this.lengthFrames;
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------------- transport */

  play(): void {
    if (!this.loaded) return;
    const partner = this.engine.partnerOf(this);
    // Beat-lock: rather than waiting for the next beat (which would add latency
    // to a child's tap), nudge the playhead so we are ALREADY on the partner's
    // grid, then start instantly. Response is immediate and always in time.
    if (this.engine.assist.beatLock && partner?.playing) {
      this.matchTempo(partner);
      this.alignPhaseTo(partner);
    }
    this.node.port.postMessage({ type: 'play' });
    this.playing = true;
    // A deck starting or stopping can change WHICH deck the drums should
    // follow, so the beat clock re-reads its anchor here rather than only when
    // a tempo fader moves.
    this.engine.syncBeatTempo();
    this.engine.notify();
  }

  pause(): void {
    this.node.port.postMessage({ type: 'pause' });
    this.playing = false;
    this.engine.syncBeatTempo();
    this.engine.notify();
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seekSeconds(sec: number, keepPlaying = this.playing): void {
    if (!this.loaded) return;
    const frame = clamp(Math.round(sec * this.sampleRate), 0, Math.max(0, this.lengthFrames - 1));
    this.positionFrames = frame;
    this.posUpdatedAt = this.engine.ctx.currentTime;
    this.node.port.postMessage({ type: 'seek', frame, play: keepPlaying });
    this.engine.notify();
  }

  /* ------------------------------------------------------------- hot cues */

  setCue(i: CueIndex): void {
    if (!this.loaded) return;
    this.cues[i] = this.positionFrames;
    this.engine.notify();
  }

  jumpCue(i: CueIndex): void {
    const frame = this.cues[i];
    if (frame == null) {
      this.setCue(i);
      return;
    }
    this.seekSeconds(frame / this.sampleRate, this.playing);
    const partner = this.engine.partnerOf(this);
    if (this.engine.assist.beatLock && partner?.playing) this.alignPhaseTo(partner);
  }

  clearCue(i: CueIndex): void {
    this.cues[i] = null;
    this.engine.notify();
  }

  /* ----------------------------------------------------------------- tempo */

  setTempoPercent(p: number): void {
    this.tempoPercent = clamp(p, -MAX_TEMPO_PERCENT, MAX_TEMPO_PERCENT);
    this.pushRate();
    this.engine.syncBeatTempo();
    this.engine.notify();
  }

  /** Fader bounds only — changing it must not move a synced deck off its match. */
  setTempoRange(r: 8 | 16): void {
    this.tempoRange = r;
    this.engine.notify();
  }

  nudgeTempo(delta: number): void {
    this.setTempoPercent(this.tempoPercent + delta);
  }

  private pushRate(): void {
    this.node.port.postMessage({ type: 'rate', value: 1 + this.tempoPercent / 100 });
  }

  /** Match the partner's effective BPM. May exceed the fader range; readout shows it. */
  matchTempo(other: Deck): void {
    if (!this.analysis || !other.analysis) return;
    const target = other.effectiveBpm;
    if (!target) return;
    this.tempoPercent = clamp(
      (target / this.analysis.bpm - 1) * 100,
      -MAX_TEMPO_PERCENT,
      MAX_TEMPO_PERCENT
    );
    this.pushRate();
  }

  /** Spec's Sync button: tempo match, plus downbeat alignment when assist is on. */
  sync(): void {
    const other = this.engine.partnerOf(this);
    if (!other || !other.analysis || !this.analysis) return;
    this.matchTempo(other);
    if (this.engine.assist.phaseAlign) this.alignPhaseTo(other);
    this.engine.notify();
  }

  /** Position within the current beat, 0..1, from the analysed grid anchor. */
  beatPhaseNow(): number | null {
    if (!this.analysis) return null;
    const beat = 60 / this.analysis.bpm;
    const rel = this.positionSecNow - this.analysis.firstBeatSec;
    return (((rel / beat) % 1) + 1) % 1;
  }

  /* --------------------------------------------------------------- scratch */

  /**
   * Grab the platter. The worklet swaps to its scratch engine — signed-rate
   * resampled playback, so pitch bends with the hand and reverse works.
   *
   * Note what does NOT happen here: no pause(). The worklet keeps `playing`
   * meaningful across a gesture on purpose, so a paused deck can still be
   * scratched and a bare scratchEnd() restores whatever the deck actually is.
   */
  scratchStart(): void {
    if (!this.loaded) return;
    this.scratching = true;
    this.node.port.postMessage({
      type: 'scratchOn',
      frame: this.positionSecNow * this.sampleRate,
      velocity: 0,
    });
    this.engine.notify();
  }

  /**
   * Mid-gesture update. DELIBERATELY SILENT — no engine.notify().
   *
   * A gesture emits up to ~60 of these a second, and two children means ~120.
   * Notifying would re-render KidsMode and both song tiles on every one, which
   * is exactly the per-frame React work the canvas rAF loops exist to avoid.
   * Nothing UI-visible changes mid-gesture anyway; the platter draws itself from
   * deck.positionSecNow.
   */
  scratchMove(positionSec: number, rate: number): void {
    if (!this.scratching) return;
    this.node.port.postMessage({ type: 'scratchJog', frame: positionSec * this.sampleRate });
    this.node.port.postMessage({ type: 'scratchRate', value: rate });
  }

  /**
   * Rate-only update, for a deck linked to a platter someone else is holding.
   * It follows the hand's SPEED but keeps its own playhead — jogging it to the
   * grabbed deck's absolute position would be meaningless across two tracks.
   */
  scratchRate(rate: number): void {
    if (!this.scratching) return;
    this.node.port.postMessage({ type: 'scratchRate', value: rate });
  }

  /**
   * Release. `play` omitted means "restore whatever the deck is now".
   *
   * Posts UNCONDITIONALLY, even when this side already believes it is not
   * scratching. That guard used to be an early return, and it turned a
   * transient disagreement between this flag and the worklet into a permanent
   * one: a macro and a finger overlapping can leave the worklet holding a
   * dead-stopped platter while `scratching` reads false here, and then the only
   * call that could free it refuses to send. The deck sits frozen, silent, and
   * reporting `playing: true`, with nothing in the UI able to recover it.
   * An extra scratchOff is free — the worklet drops it when not scratching.
   */
  scratchEnd(play?: boolean): void {
    const wasScratching = this.scratching;
    this.scratching = false;
    this.node.port.postMessage({ type: 'scratchOff', play });
    if (wasScratching) this.engine.notify();
  }

  /** How lazily the platter spins back up after a release, in seconds. */
  setScratchInertia(seconds: number): void {
    this.node.port.postMessage({ type: 'scratchInertia', releaseSec: seconds });
  }

  /** Shift by less than half a beat so our grid sits on theirs. */
  alignPhaseTo(other: Deck): void {
    if (!this.analysis || !other.analysis) return;
    const mine = this.beatPhaseNow();
    const theirs = other.beatPhaseNow();
    if (mine == null || theirs == null) return;

    let d = theirs - mine;
    if (d > 0.5) d -= 1;
    else if (d < -0.5) d += 1;

    const beatSrc = 60 / this.analysis.bpm;
    this.seekSeconds(this.positionSecNow + d * beatSrc, this.playing);
  }

  /* ------------------------------------------------------------- mixer bits */

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.applyGain();
    this.engine.notify();
  }

  applyGain(): void {
    const auto = this.engine.assist.autoGain ? this.autoGainDb : 0;
    const lin = this.volume * Math.pow(10, auto / 20);
    this.output.gain.setTargetAtTime(lin, this.engine.ctx.currentTime, 0.01);
  }

  private computeAutoGain(): void {
    if (!this.analysis) {
      this.autoGainDb = 0;
      return;
    }
    this.autoGainDb = clamp(TARGET_LOUDNESS_DB - this.analysis.loudnessDb, -12, 12);
  }

  get autoGainApplied(): number {
    return this.engine.assist.autoGain ? this.autoGainDb : 0;
  }

  setEq(band: 'low' | 'mid' | 'high', db: number): void {
    const v = clamp(db, -26, 6);
    if (band === 'low') this.eqLowDb = v;
    else if (band === 'mid') this.eqMidDb = v;
    else this.eqHighDb = v;
    this.applyEq();
    this.engine.notify();
  }

  /** Bass-swap duck rides on top of the user's low knob rather than replacing it. */
  setAssistLowDb(db: number): void {
    this.assistLowDb = db;
    this.applyEq();
  }

  get assistLowApplied(): number {
    return this.assistLowDb;
  }

  private applyEq(): void {
    const t = this.engine.ctx.currentTime;
    this.eqLow.gain.setTargetAtTime(clamp(this.eqLowDb + this.assistLowDb, -40, 6), t, 0.02);
    this.eqMid.gain.setTargetAtTime(this.eqMidDb, t, 0.02);
    this.eqHigh.gain.setTargetAtTime(this.eqHighDb, t, 0.02);
  }

  setFilter(v: number): void {
    this.filterKnob = clamp(v, -1, 1);
    const t = this.engine.ctx.currentTime;
    if (this.filterKnob < -0.01) {
      this.lpf.frequency.setTargetAtTime(expMap(-this.filterKnob, 20000, 200), t, 0.01);
      this.hpf.frequency.setTargetAtTime(20, t, 0.01);
    } else if (this.filterKnob > 0.01) {
      this.hpf.frequency.setTargetAtTime(expMap(this.filterKnob, 20, 4000), t, 0.01);
      this.lpf.frequency.setTargetAtTime(20000, t, 0.01);
    } else {
      this.lpf.frequency.setTargetAtTime(20000, t, 0.01);
      this.hpf.frequency.setTargetAtTime(20, t, 0.01);
    }
    this.engine.notify();
  }

  /** Small pitch shift toward a key that does not fight the anchor deck. */
  applyHarmonicNudge(): void {
    let semis = 0;
    if (!this.isAnchor && this.engine.assist.harmonicNudge && this.analysis) {
      const other = this.engine.partnerOf(this);
      if (other?.analysis) {
        const s = harmonicNudgeSemitones(
          { pc: other.analysis.keyPc, mode: other.analysis.keyMode },
          { pc: this.analysis.keyPc, mode: this.analysis.keyMode }
        );
        if (s != null) semis = s;
      }
    }
    this.nudgeSemitones = semis;
    this.node.port.postMessage({ type: 'pitch', value: semitonesToRatio(semis) });
  }

  /**
   * Camelot after the harmonic nudge — what the deck actually sounds like now.
   * Always recomputed from keyPc rather than reading the cached string when the
   * nudge is zero, so the two can never disagree.
   */
  get effectiveCamelot(): string | null {
    if (!this.analysis) return null;
    return camelotOf(this.effectivePc, this.analysis.keyMode);
  }

  /** Key name after the nudge, so it can never disagree with the Camelot code. */
  get effectiveKeyName(): string | null {
    if (!this.analysis) return null;
    return keyNameOf(this.effectivePc, this.analysis.keyMode);
  }

  private get effectivePc(): number {
    if (!this.analysis) return 0;
    return (((this.analysis.keyPc + this.nudgeSemitones) % 12) + 12) % 12;
  }
}
