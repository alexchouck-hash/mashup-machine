/**
 * stretch-processor.js — deck playback engine, WSOLA time-stretch + pitch shift.
 *
 * Per the spec, THIS OWNS PLAYBACK POSITION. play / pause / seek / rate / pitch
 * are messages; the playhead is reported back to the UI at ~30 Hz.
 *
 * Two independent axes:
 *   rate  — tempo, pitch preserved (WSOLA overlap-add)
 *   pitch — frequency ratio, tempo preserved (resampled grain reads)
 * `pitch` exists for the harmonic-nudge assist: shift a deck a semitone or two
 * to stop two clashing keys grinding against each other.
 *
 * WSOLA (waveform-similarity overlap-add) is the same algorithm family as
 * SoundTouch, implemented inline because an AudioWorklet is a classic script and
 * cannot `import` a library — vendoring one would mean a separate bundle step.
 * Parameters are SoundTouch's defaults (40 ms sequence / 15 ms seek / 8 ms
 * overlap), which is what makes +/-8% clean on dance material.
 *
 * SWAP POINT: replace produce()/findOffset() with a SoundTouch WASM kernel and
 * nothing else in the app changes — the message protocol is the interface.
 *
 * At rate === 1 and pitch === 1 both stages are bypassed and playback is
 * bit-transparent.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Linear-interpolated read, for fractional (pitch-shifted) source positions. */
function lerp(x, pos) {
  const i = pos | 0;
  const f = pos - i;
  const a = x[i];
  const b = x[i + 1];
  return a + (b - a) * f;
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.channels = [];
    this.numCh = 2;
    this.length = 0;

    this.playing = false;
    this.pos = 0; // playhead, in source frames (float)
    this.rate = 1;
    this.pitch = 1;
    this.loop = false;
    // Loop region in source frames. loopEnd <= loopStart means "whole buffer".
    this.loopStart = 0;
    this.loopEnd = 0;

    // WSOLA parameters, in frames.
    this.overlap = Math.round(sampleRate * 0.008);
    this.seq = Math.round(sampleRate * 0.04);
    this.seekLen = Math.round(sampleRate * 0.015);
    this.flat = this.seq - this.overlap; // frames emitted per iteration

    this.tail = [new Float32Array(this.overlap), new Float32Array(this.overlap)];
    this.hasTail = false;

    // Output FIFO. One iteration emits `flat` frames; the graph consumes 128 at
    // a time, so we buffer the remainder.
    this.fifoCap = Math.max(sampleRate, this.flat * 4);
    this.fifo = [new Float32Array(this.fifoCap), new Float32Array(this.fifoCap)];
    this.fifoLen = 0;

    this.lastPost = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load': {
        this.channels = m.channels.map((buf) => new Float32Array(buf));
        this.numCh = this.channels.length;
        this.length = this.numCh > 0 ? this.channels[0].length : 0;
        this.pos = 0;
        this.playing = false;
        this.resetStretch();
        this.port.postMessage({ type: 'loaded', length: this.length });
        break;
      }
      case 'play':
        if (this.length > 0) this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        this.resetStretch();
        break;
      case 'seek':
        this.pos = clamp(m.frame, 0, Math.max(0, this.length - 1));
        this.resetStretch();
        if (m.play === true && this.length > 0) this.playing = true;
        break;
      case 'rate':
        this.rate = clamp(m.value, 0.25, 4);
        break;
      case 'pitch':
        this.pitch = clamp(m.value, 0.5, 2);
        this.resetStretch();
        break;
      case 'loop':
        this.loop = !!m.enabled;
        break;
      case 'loopRegion':
        this.loopStart = Math.max(0, Math.round(m.start || 0));
        this.loopEnd = Math.max(0, Math.round(m.end || 0));
        break;
      case 'unload':
        this.channels = [];
        this.length = 0;
        this.playing = false;
        this.pos = 0;
        this.resetStretch();
        break;
      default:
        break;
    }
  }

  resetStretch() {
    this.fifoLen = 0;
    this.hasTail = false;
  }

  /** Source frames consumed by one grain of `n` output frames at current pitch. */
  grainSpan(n) {
    return Math.ceil(n * this.pitch) + 2;
  }

  /**
   * Search +/- seekLen/2 around `base` for the offset whose waveform best
   * continues the previous tail. Coarse stride + subsampled correlation keeps
   * this ~30k ops per iteration (~31 iterations/sec at 44.1 kHz).
   */
  findOffset(base) {
    const x = this.channels[0];
    const t = this.tail[0];
    const ov = this.overlap;
    const p = this.pitch;
    const half = this.seekLen >> 1;

    const lo = Math.max(-half, -base);
    const hi = Math.min(half, this.length - base - this.grainSpan(this.flat + ov) - 1);
    if (hi <= lo) return 0;

    let best = 0;
    let bestScore = -Infinity;
    for (let o = lo; o < hi; o += 2) {
      let corr = 0;
      let norm = 0;
      const p0 = base + o;
      for (let i = 0; i < ov; i += 4) {
        const v = p === 1 ? x[p0 + i] : lerp(x, p0 + i * p);
        corr += t[i] * v;
        norm += v * v;
      }
      const score = corr / Math.sqrt(norm + 1e-9);
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }

  /** One WSOLA iteration: appends `flat` frames to the FIFO. */
  produce() {
    const ov = this.overlap;
    const flat = this.flat;
    const p = this.pitch;

    if (this.fifoLen + flat > this.fifoCap) return false;

    let base = Math.round(this.pos);
    if (base < 0) base = 0;

    const span = this.grainSpan(flat + ov);
    // A loop region lets a deck repeat just the chorus. It only constrains
    // playback while looping; without loop the deck plays to the end as usual.
    const useRegion = this.loop && this.loopEnd > this.loopStart;
    const regionStart = useRegion ? this.loopStart : 0;
    const regionEnd = useRegion ? Math.min(this.loopEnd, this.length) : this.length;

    if (base + span + 1 >= regionEnd) {
      // Wrapping to the region start keeps the loop in time when the region is
      // a whole number of bars. Drop the tail so the seam is not correlated
      // against audio from the other end of the region.
      if (!this.loop || regionEnd - regionStart <= span + 2) return false;
      this.pos = regionStart;
      base = regionStart;
      this.hasTail = false;
    }

    const offset = this.hasTail && (this.rate !== 1 || p !== 1) ? this.findOffset(base) : 0;
    const src = clamp(base + offset, 0, this.length - span - 1);

    for (let c = 0; c < this.numCh; c++) {
      const x = this.channels[c];
      const f = this.fifo[c];
      const t = this.tail[c];
      const w = this.fifoLen;

      if (p === 1) {
        if (this.hasTail) {
          for (let i = 0; i < ov; i++) {
            const g = i / ov;
            f[w + i] = t[i] * (1 - g) + x[src + i] * g;
          }
        } else {
          for (let i = 0; i < ov; i++) f[w + i] = x[src + i];
        }
        for (let i = ov; i < flat; i++) f[w + i] = x[src + i];
        for (let i = 0; i < ov; i++) t[i] = x[src + flat + i];
      } else {
        if (this.hasTail) {
          for (let i = 0; i < ov; i++) {
            const g = i / ov;
            f[w + i] = t[i] * (1 - g) + lerp(x, src + i * p) * g;
          }
        } else {
          for (let i = 0; i < ov; i++) f[w + i] = lerp(x, src + i * p);
        }
        for (let i = ov; i < flat; i++) f[w + i] = lerp(x, src + i * p);
        for (let i = 0; i < ov; i++) t[i] = lerp(x, src + (flat + i) * p);
      }
    }

    this.fifoLen += flat;
    this.hasTail = true;
    this.pos += this.rate * flat;
    return true;
  }

  maybePostPosition() {
    if (currentTime - this.lastPost < 1 / 30) return;
    this.lastPost = currentTime;
    // The FIFO holds already-produced audio, so the audible playhead lags `pos`.
    const heard = this.pos - this.fifoLen * this.rate;
    this.port.postMessage({
      type: 'pos',
      frame: clamp(heard, 0, this.length),
      playing: this.playing,
    });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const n = out[0].length;

    if (!this.playing || this.length === 0) {
      this.maybePostPosition();
      return true; // outputs stay zero-filled = silence
    }

    let ended = false;
    while (this.fifoLen < n) {
      if (!this.produce()) {
        ended = true;
        break;
      }
    }

    const avail = Math.min(n, this.fifoLen);
    for (let c = 0; c < out.length; c++) {
      const srcCh = this.fifo[Math.min(c, this.numCh - 1)];
      out[c].set(srcCh.subarray(0, avail));
    }

    if (avail > 0) {
      for (let c = 0; c < this.numCh; c++) {
        this.fifo[c].copyWithin(0, avail, this.fifoLen);
      }
      this.fifoLen -= avail;
    }

    if (ended && this.fifoLen === 0) {
      this.playing = false;
      this.resetStretch();
      this.port.postMessage({ type: 'ended' });
    }

    this.maybePostPosition();
    return true;
  }
}

registerProcessor('stretch-processor', StretchProcessor);
