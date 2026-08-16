import { Deck } from './Deck';
import { BeatMachine } from './BeatMachine';
import { Fx } from './Fx';
import { Macros } from './macros';
import { ensureKit } from './sampleKit';
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

/** How often the link re-checks the followers against the leader. */
const LINK_INTERVAL_MS = 200;
/** Beats of error past which a jump beats waiting for a rate offset to close it. */
const LINK_SNAP_BEATS = 0.25;
/**
 * Rate offset per beat of error.
 *
 * Sized from what has to be FIXED, not from what feels gentle: a loop wrap can
 * throw the follower ~30 ms out, which is right at the flam threshold and so
 * plainly audible. At 0.4 a 0.05-beat error asks for the full 2% trim and closes
 * in about 1.5 s. An earlier value of 0.02 asked for 0.1% and would have taken
 * THIRTY SECONDS — measured drifting at a steady −30 ms and never recovering,
 * which is indistinguishable from no sync at all.
 */
const LINK_GAIN = 0.4;

/**
 * The mixer. One master bus; every sound source is an input to it.
 *
 *   decks ─> xfA/xfB ─> deckDuck ─> deckBus ────┐
 *   beat machine ─> drumLow ─> drumDrive ─> drumTrim ─┤
 *                                                     └─> sum ─> fxFilter ─> fxGate
 *        ─> macroGain ─> master ─> limiter ─> analyser ─> out
 *                            fxGate ─> delaySend ─> delay ─> macroGain   └─> recorder
 *   one-shots ─────────────────────────────────────────────> master
 *
 * One-shots (air horn, riser, drop impact) join AFTER every gate on purpose: a
 * drop cuts the signal to silence, and the sounds that SELL the drop have to
 * survive it.
 *
 * The deck and drum paths are separate before the sum so a macro can duck the
 * songs while the beat carries on (auto-bridge) or thicken the drums alone
 * (bump boost). Echo still taps pre-macroGain, so the delay keeps being fed
 * through a drop's silence and returns time-coherent material on the slam.
 *
 * PARAM OWNERSHIP — a second writer on any of these is a stranded gain or a
 * click, which is why Macros does not simply reuse fxGate:
 *   fxGate.gain / fxFilter.frequency        -> Fx only
 *   macroGain.gain / deckBus.gain           -> Macros only
 *   deckDuck.gain / drum{Low,Drive,Trim}    -> Macros only
 *   deck.output.gain                        -> Deck.applyGain only
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

  /** Macro stages. Written by Macros only — see PARAM OWNERSHIP above. */
  deckDuck!: GainNode; // kick sidechain (bump boost)
  deckBus!: GainNode; // duck the songs while drums carry (bridge / auto-mix)
  macroGain!: GainNode; // drop gate + loudness lift
  drumLow!: BiquadFilterNode;
  drumDrive!: WaveShaperNode;
  drumTrim!: GainNode;

  transport!: Transport;
  beatMachine!: BeatMachine;
  fx!: Fx;
  macros!: Macros;

  decks: Deck[] = [];
  assist: AssistSettings = { ...DEFAULT_ASSIST };

  crossfade = 0.5;
  masterVolume = 1;
  /**
   * Sync: the follower deck is held continuously on the leader's beat grid.
   *
   * ON by default. Two songs drifting apart is the failure a child can neither
   * diagnose nor fix, and the assist layer's whole premise is that the app
   * should not be able to sound wrong unless someone deliberately turns a
   * safeguard off.
   */
  linkDecks = true;
  private linkTimer: number | null = null;

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

    this.deckDuck = this.ctx.createGain();
    this.deckDuck.gain.value = 1;
    this.deckBus = this.ctx.createGain();
    this.deckBus.gain.value = 1;
    this.macroGain = this.ctx.createGain();
    this.macroGain.gain.value = 1;

    this.drumLow = this.ctx.createBiquadFilter();
    this.drumLow.type = 'lowshelf';
    this.drumLow.frequency.value = 90;
    this.drumLow.gain.value = 0;
    // curve stays null (bypass) until Macros installs one for bump boost.
    this.drumDrive = this.ctx.createWaveShaper();
    this.drumDrive.oversample = '2x';
    this.drumTrim = this.ctx.createGain();
    this.drumTrim.gain.value = 1;

    this.masterGain.gain.value = MASTER_HEADROOM;

    // Soft limiter so a hand slamming faders cannot clip the recording.
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.analyser.fftSize = 2048;
    this.meterBuf = new Float32Array(this.analyser.fftSize);

    this.xfA.connect(this.deckDuck);
    this.xfB.connect(this.deckDuck);
    this.deckDuck.connect(this.deckBus);
    this.deckBus.connect(this.sumBus);

    this.sumBus.connect(this.fxFilter);
    this.fxFilter.connect(this.fxGate);
    this.fxGate.connect(this.macroGain);
    this.macroGain.connect(this.masterGain);

    this.fxGate.connect(this.delaySend);
    this.delaySend.connect(this.delay);
    this.delay.connect(delayDamp);
    delayDamp.connect(delayFeedback);
    delayFeedback.connect(this.delay);
    this.delay.connect(this.macroGain);

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

    // Fire and forget: a 35-file fetch+decode must not sit between the Start
    // tap and the first sound. Synthesis covers the first second or two, then
    // the voices switch over silently as buffers land.
    void ensureKit(this.ctx);

    this.transport = new Transport(this.ctx);
    // Keep the drum grid locked to whatever the room is listening to, instead
    // of merely starting aligned with it.
    this.transport.beatPhaseSource = () => this.anchorNextBeatTime();
    this.fx = new Fx(this);
    this.beatMachine = new BeatMachine(this);
    // Drums take their own path to the sum so bump boost can thicken them and
    // the bridge can duck the songs without touching the beat.
    this.beatMachine.output.connect(this.drumLow);
    this.drumLow.connect(this.drumDrive).connect(this.drumTrim).connect(this.sumBus);
    this.macros = new Macros(this);

    this.setCrossfade(this.crossfade);
    // The link defaults on, so its controller has to be running from the start —
    // setLink() is otherwise the only thing that ever starts it. Safe before any
    // deck exists: holdLink() no-ops until there is a leader to follow.
    if (this.linkDecks) this.startLinkLoop();
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

  /**
   * ctx time of the anchor deck's next beat — the transport's phase reference.
   * Null while nothing is playing or a platter is being scratched, since a
   * playhead under a hand is not a tempo reference.
   */
  anchorNextBeatTime(): number | null {
    const a = this.anchorDeck();
    if (!a?.analysis || !a.playing || a.scratching) return null;
    const phase = a.beatPhaseNow();
    if (phase == null) return null;
    const bpm = a.effectiveBpm || 120;
    return this.ctx.currentTime + (1 - phase) * (60 / bpm);
  }

  /**
   * Ride the beat grid on a scratch. The drums have no playhead to drag, so the
   * gesture scales their GRID instead — a stopped platter stops the beat, a slow
   * one slows it. Without this the drums march on through a scratch and the
   * whole gesture stops sounding like one performance.
   */
  setScratchVelocity(v: number): void {
    if (!this.ready) return;
    const mag = Math.abs(Number.isFinite(v) ? v : 1);
    this.transport.rateScale = Math.min(2, mag);
  }

  /**
   * Hand the grid back, but only once NO platter is still held — two decks
   * scratch together, and the first release must not restore the beat under a
   * hand that is still moving. Phase is not corrected here: the transport's own
   * snap re-acquires on the next beat, which is what makes it exit in sync.
   */
  releaseScratchVelocity(): void {
    if (!this.ready) return;
    if (this.decks.some((d) => d.scratching)) return;
    this.transport.rateScale = 1;
  }

  /** Follow the anchor deck's tempo while the beat is running. */
  syncBeatTempo(): void {
    if (!this.ready || !this.transport.running) return;
    const bpm = this.anchorDeck()?.effectiveBpm ?? 0;
    if (bpm > 0) this.transport.bpm = bpm;
  }

  /* ------------------------------------------------------------- deck link */

  /**
   * Sync toggle. On: the beats lock and both platters scratch as one. Off: the
   * decks are wholly independent, which is how a DJ expects two turntables to
   * behave.
   */
  setLink(on: boolean): void {
    this.linkDecks = on;
    if (on) {
      this.lockToLouder();
      this.startLinkLoop();
    } else {
      this.stopLinkLoop();
    }
    this.notify();
  }

  /**
   * Which deck leads. The owner's rule is that the QUIETER deck follows the
   * LOUDER one, so whatever the room is actually listening to never lurches.
   * "Louder" therefore has to mean audible level — fader, auto-gain and the
   * crossfader together — not which letter the deck was given.
   */
  louderDeck(): Deck | undefined {
    let best: Deck | undefined;
    let bestLevel = -Infinity;
    for (const d of this.decks) {
      if (!d.loaded) continue;
      const t = (this.crossfade * Math.PI) / 2;
      const xf = d.crossfadeSide === 'A' ? Math.cos(t) : d.crossfadeSide === 'B' ? Math.sin(t) : 1;
      // A stopped deck can never lead, however loud its fader is.
      const level = d.volume * Math.pow(10, d.autoGainApplied / 20) * xf * (d.playing ? 1 : 0);
      if (level > bestLevel) {
        bestLevel = level;
        best = d;
      }
    }
    return best;
  }

  /** Pull every other deck onto the leader's tempo and downbeat. */
  lockToLouder(): void {
    const leader = this.louderDeck();
    if (!leader?.analysis) return;
    for (const d of this.decks) {
      if (d === leader || !d.analysis) continue;
      d.matchTempo(leader);
      d.alignPhaseTo(leader);
    }
    this.syncBeatTempo();
  }

  /**
   * Decks a gesture on `deck` drives: ALWAYS every loaded deck.
   *
   * Owner's call, and it overrides the earlier "sync off means independent"
   * rule for scratching specifically — grabbing one record and having the other
   * carry on is the thing that sounds broken to everyone but a working DJ. Sync
   * still governs the BEAT lock; it no longer governs the platters.
   */
  scratchGroup(deck: Deck): Deck[] {
    const all = this.decks.filter((d) => d.loaded);
    return all.length ? all : [deck];
  }

  /* ------------------------------------------------------- continuous link */

  /**
   * Hold the followers on the leader's grid, continuously.
   *
   * setLink() aligning once is not sync, it is a starting gun: two decks running
   * off independently-estimated BPMs drift apart within seconds, and any seek,
   * scratch or hook jump breaks it outright. This runs while linked and keeps
   * pulling them back.
   *
   * Phase is corrected with a sub-percent RATE offset rather than a seek — 0.4%
   * is under a tenth of a semitone and inaudible, whereas seeking every few
   * seconds is a stutter. Only a gross error (over a quarter beat, i.e. already
   * audibly wrong) is worth the jump.
   */
  private holdLink(): void {
    if (!this.linkDecks || !this.ready) return;
    const leader = this.louderDeck();
    if (!leader?.analysis || !leader.playing) return;

    for (const d of this.decks) {
      // A platter under a hand owns itself; so does a deck with nothing to sync.
      if (d === leader || !d.analysis || !d.playing || d.scratching) {
        d.setPhaseTrim(0);
        continue;
      }
      if (leader.scratching) {
        d.setPhaseTrim(0);
        continue;
      }

      // Keep tempo matched, but only when it has actually drifted — writing it
      // every tick would fight a hand on the tempo fader.
      if (Math.abs(d.effectiveBpm - leader.effectiveBpm) > 0.05) d.matchTempo(leader);

      const lead = leader.beatPhaseNow();
      const follow = d.beatPhaseNow();
      if (lead == null || follow == null) continue;

      let err = lead - follow; // in beats
      if (err > 0.5) err -= 1;
      else if (err < -0.5) err += 1;

      if (Math.abs(err) > LINK_SNAP_BEATS) {
        d.alignPhaseTo(leader);
        d.setPhaseTrim(0);
      } else {
        // Proportional pull. Small errors close over a few seconds, silently.
        d.setPhaseTrim(err * LINK_GAIN);
      }
    }
  }

  private startLinkLoop(): void {
    if (this.linkTimer !== null) return;
    this.linkTimer = window.setInterval(() => this.holdLink(), LINK_INTERVAL_MS);
  }

  private stopLinkLoop(): void {
    if (this.linkTimer === null) return;
    window.clearInterval(this.linkTimer);
    this.linkTimer = null;
    for (const d of this.decks) d.setPhaseTrim(0);
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
