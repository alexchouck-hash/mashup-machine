import { Deck } from './Deck';
import { BeatMachine } from './BeatMachine';
import { Fx } from './Fx';
import { Transport } from './Transport';
import { DEFAULT_ASSIST, type AssistSettings } from './types';
import { encodeWav, floatToInt16 } from './wav';

const WORKLET_STRETCH = '/worklets/stretch-processor.js';
const WORKLET_RECORDER = '/worklets/recorder-processor.js';

export type CrossfadeAssign = 'A' | 'B' | null;

/** Master headroom, per spec: sit ~6 dB below clipping so live moves have room. */
const MASTER_HEADROOM = 0.5;
/** How far the bass-swap assist ducks the outgoing deck's low band. */
const BASS_SWAP_MAX_DB = 15;

/**
 * The mixer. One master bus; every sound source is an input to it.
 *
 *   decks ──> xfA/xfB ─┐
 *   beat machine ──────┼─> sum ─> fxFilter ─> fxGate ─> master ─> limiter ─> analyser ─> out
 *                      │              └─> delaySend ─> delay ─┘        └─> recorder
 *   one-shots ─────────────────────────────────────────> master
 *
 * One-shots (air horn, drop impact) join AFTER the gate on purpose: a drop cuts
 * the gate to silence, and the impact that sells the drop has to survive it.
 */
export class AudioEngine {
  ctx!: AudioContext;

  private sumBus!: GainNode;
  private xfA!: GainNode;
  private xfB!: GainNode;
  private masterGain!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private analyser!: AnalyserNode;
  private recorderNode: AudioWorkletNode | null = null;

  /** Master FX stage — public so Fx can automate it. */
  fxFilter!: BiquadFilterNode;
  fxGate!: GainNode;
  delaySend!: GainNode;
  delay!: DelayNode;
  oneShotBus!: GainNode;

  transport!: Transport;
  beatMachine!: BeatMachine;
  fx!: Fx;

  decks: Deck[] = [];
  assist: AssistSettings = { ...DEFAULT_ASSIST };

  crossfade = 0.5;
  masterVolume = 1;

  recording = false;
  recordStartedAt = 0;

  private ready = false;
  private recChunks: Int16Array[] = [];
  private meterBuf = new Float32Array(1024);
  private listeners = new Set<() => void>();
  private version = 0;

  /* ------------------------------------------------------------- lifecycle */

  get initialized(): boolean {
    return this.ready;
  }

  /** Must be called from a user gesture (autoplay policy). */
  async init(): Promise<void> {
    if (this.ready) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });

    await this.ctx.audioWorklet.addModule(WORKLET_STRETCH);
    await this.ctx.audioWorklet.addModule(WORKLET_RECORDER);

    this.sumBus = this.ctx.createGain();
    this.xfA = this.ctx.createGain();
    this.xfB = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();
    this.limiter = this.ctx.createDynamicsCompressor();
    this.analyser = this.ctx.createAnalyser();

    this.fxFilter = this.ctx.createBiquadFilter();
    this.fxFilter.type = 'lowpass';
    this.fxFilter.frequency.value = 20000;
    this.fxFilter.Q.value = 1.1;

    this.fxGate = this.ctx.createGain();
    this.fxGate.gain.value = 1;

    this.delaySend = this.ctx.createGain();
    this.delaySend.gain.value = 0;
    this.delay = this.ctx.createDelay(2);
    this.delay.delayTime.value = 0.375;
    const delayFeedback = this.ctx.createGain();
    delayFeedback.gain.value = 0.38;
    const delayDamp = this.ctx.createBiquadFilter();
    delayDamp.type = 'lowpass';
    delayDamp.frequency.value = 3200;

    this.oneShotBus = this.ctx.createGain();

    this.masterGain.gain.value = MASTER_HEADROOM;

    // Soft limiter so a hand slamming faders cannot clip the recording.
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.analyser.fftSize = 2048;
    this.meterBuf = new Float32Array(this.analyser.fftSize);

    this.xfA.connect(this.sumBus);
    this.xfB.connect(this.sumBus);

    this.sumBus.connect(this.fxFilter);
    this.fxFilter.connect(this.fxGate);
    this.fxGate.connect(this.masterGain);

    this.fxGate.connect(this.delaySend);
    this.delaySend.connect(this.delay);
    this.delay.connect(delayDamp);
    delayDamp.connect(delayFeedback);
    delayFeedback.connect(this.delay);
    this.delay.connect(this.masterGain);

    this.oneShotBus.connect(this.masterGain);

    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Recorder taps AFTER the limiter so the file is exactly what was heard.
    this.recorderNode = new AudioWorkletNode(this.ctx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.recorderNode.port.onmessage = (e) => {
      if (e.data?.type === 'pcm' && this.recording) {
        this.recChunks.push(floatToInt16(e.data.data as Float32Array));
      }
    };
    this.limiter.connect(this.recorderNode);
    // The processor never writes its outputs, so this connection is silent; it
    // exists because a node must be pulled by the graph for process() to run.
    this.recorderNode.connect(this.ctx.destination);

    this.transport = new Transport(this.ctx);
    this.fx = new Fx(this);
    this.beatMachine = new BeatMachine(this);
    this.addSource(this.beatMachine.output, null);

    this.setCrossfade(this.crossfade);
    this.ready = true;
    this.notify();
  }

  createDeck(id: string, label: string, assign: CrossfadeAssign): Deck {
    const deck = new Deck(this, id, label);
    deck.crossfadeSide = assign;
    this.addSource(deck.output, assign);
    this.decks.push(deck);
    this.notify();
    return deck;
  }

  /** The extension seam: any node can join the master bus. */
  addSource(node: AudioNode, assign: CrossfadeAssign): void {
    if (assign === 'A') node.connect(this.xfA);
    else if (assign === 'B') node.connect(this.xfB);
    else node.connect(this.sumBus);
  }

  deckById(id: string): Deck | undefined {
    return this.decks.find((d) => d.id === id);
  }

  /** The other deck, for sync / phase-align / bass-swap decisions. */
  partnerOf(deck: Deck): Deck | undefined {
    return this.decks.find((d) => d !== deck);
  }

  /* ----------------------------------------------------------- beat clock */

  /** Deck whose grid the beat machine follows: a playing analysed deck first. */
  anchorDeck(): Deck | undefined {
    return (
      this.decks.find((d) => d.playing && d.analysis) ?? this.decks.find((d) => d.analysis)
    );
  }

  /**
   * Start the step clock on the anchor deck's next beat, so the drums land on
   * the song's grid instead of wherever the button happened to be pressed.
   */
  ensureBeatClock(): void {
    if (!this.ready) return;
    const anchor = this.anchorDeck();

    if (anchor?.analysis) {
      const bpm = anchor.effectiveBpm;
      if (bpm > 0) this.transport.bpm = bpm;
    }
    if (this.transport.running) return;

    let lead = 0.05;
    if (anchor?.analysis && anchor.playing) {
      const phase = anchor.beatPhaseNow();
      const beatOut = 60 / (anchor.effectiveBpm || 120);
      if (phase != null) lead = (1 - phase) * beatOut;
    }
    this.transport.start(this.ctx.currentTime + Math.max(lead, 0.04));
    this.notify();
  }

  /** Follow the anchor deck's tempo while the beat is running. */
  syncBeatTempo(): void {
    if (!this.ready || !this.transport.running) return;
    const bpm = this.anchorDeck()?.effectiveBpm ?? 0;
    if (bpm > 0) this.transport.bpm = bpm;
  }

  /* -------------------------------------------------------------- crossfade */

  setCrossfade(x: number): void {
    this.crossfade = Math.max(0, Math.min(1, x));
    if (!this.ready) return;

    // Equal power: constant perceived loudness through the sweep.
    const t = (this.crossfade * Math.PI) / 2;
    this.xfA.gain.setTargetAtTime(Math.cos(t), this.ctx.currentTime, 0.01);
    this.xfB.gain.setTargetAtTime(Math.sin(t), this.ctx.currentTime, 0.01);

    this.applyBassSwap();
    this.notify();
  }

  /**
   * Bass swap: the deck being faded away loses its low band, so two kicks never
   * occupy the same space. This is the single biggest cause of a mashup turning
   * to mud, and it is entirely automatic.
   */
  applyBassSwap(): void {
    if (!this.ready) return;
    const t = this.crossfade;
    for (const deck of this.decks) {
      let duckDb = 0;
      if (this.assist.bassSwap) {
        const outgoing =
          deck.crossfadeSide === 'A'
            ? Math.min(1, Math.max(0, (t - 0.35) / 0.3))
            : Math.min(1, Math.max(0, (0.65 - t) / 0.3));
        duckDb = -BASS_SWAP_MAX_DB * outgoing;
      }
      deck.setAssistLowDb(duckDb);
    }
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.ready) {
      this.masterGain.gain.setTargetAtTime(
        this.masterVolume * MASTER_HEADROOM,
        this.ctx.currentTime,
        0.01
      );
    }
    this.notify();
  }

  setAssist<K extends keyof AssistSettings>(key: K, value: AssistSettings[K]): void {
    this.assist[key] = value;
    if (key === 'bassSwap') this.applyBassSwap();
    if (key === 'autoGain') for (const d of this.decks) d.applyGain();
    if (key === 'harmonicNudge') for (const d of this.decks) d.applyHarmonicNudge();
    this.notify();
  }

  /* ----------------------------------------------------------------- meters */

  /** Number of spectrum bins the visualizer should allocate. */
  get spectrumBins(): number {
    return this.ready ? this.analyser.frequencyBinCount : 0;
  }

  /** Byte spectrum of the master, filled in place to avoid per-frame garbage. */
  masterFrequencies(into: Uint8Array): void {
    // Cast via the method's own parameter type: TS 5.7+ types typed arrays over
    // ArrayBufferLike, and spelling the generic here would pin the TS version.
    if (this.ready) {
      this.analyser.getByteFrequencyData(
        into as Parameters<AnalyserNode['getByteFrequencyData']>[0]
      );
    } else {
      into.fill(0);
    }
  }

  /** Peak and RMS of the master, read straight off the analyser for the meter. */
  masterLevel(): { peak: number; rms: number } {
    if (!this.ready) return { peak: 0, rms: 0 };
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i]);
      if (v > peak) peak = v;
      sumSq += v * v;
    }
    return { peak, rms: Math.sqrt(sumSq / this.meterBuf.length) };
  }

  /* -------------------------------------------------------------- recording */

  startRecording(): void {
    if (!this.ready || this.recording) return;
    this.recChunks = [];
    this.recording = true;
    this.recordStartedAt = this.ctx.currentTime;
    this.recorderNode?.port.postMessage({ type: 'start' });
    this.notify();
  }

  stopRecording(): Blob | null {
    if (!this.recording) return null;
    this.recorderNode?.port.postMessage({ type: 'stop' });
    this.recording = false;
    const blob = this.recChunks.length ? encodeWav(this.recChunks, this.ctx.sampleRate, 2) : null;
    this.recChunks = [];
    this.notify();
    return blob;
  }

  recordedSeconds(): number {
    if (!this.recording || !this.ready) return 0;
    return this.ctx.currentTime - this.recordStartedAt;
  }

  /* --------------------------------------------------- React mirror plumbing */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): number => this.version;

  /** Bump the version so mirrored React views re-read the engine. */
  notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

export const engine = new AudioEngine();
