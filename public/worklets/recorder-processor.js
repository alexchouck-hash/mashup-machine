/**
 * recorder-processor.js — raw PCM tap on the master bus.
 *
 * Spec: "custom AudioWorklet capturing raw PCM from the master bus ... Do NOT use
 * MediaRecorder (lossy)". This processor never writes to its outputs, so it is
 * silent and can be connected straight to the destination (a node must be pulled
 * by the graph for process() to run at all).
 *
 * Posts interleaved stereo Float32 chunks to the main thread, transferring the
 * buffer so there is no copy. The main thread converts to 16-bit and accumulates.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      const t = e.data && e.data.type;
      if (t === 'start') this.recording = true;
      else if (t === 'stop') this.recording = false;
    };
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const L = input[0];
    if (!L) return true;
    const R = input.length > 1 ? input[1] : L;
    const n = L.length;

    const inter = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      inter[i * 2] = L[i];
      inter[i * 2 + 1] = R[i];
    }
    this.port.postMessage({ type: 'pcm', data: inter }, [inter.buffer]);
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
