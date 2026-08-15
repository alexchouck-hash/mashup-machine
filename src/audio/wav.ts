/**
 * 16-bit PCM WAV encoding for the recorder.
 *
 * The spec forbids MediaRecorder (lossy). The recorder worklet hands us raw
 * interleaved Float32; we convert to Int16 as chunks arrive rather than at the
 * end, which halves peak memory — a 10-minute stereo recording at 48 kHz is
 * ~110 MB as Int16 versus ~220 MB as Float32.
 */

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i] < -1 ? -1 : input[i] > 1 ? 1 : input[i];
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function encodeWav(chunks: Int16Array[], sampleRate: number, channels = 2): Blob {
  let samples = 0;
  for (const c of chunks) samples += c.length;

  const dataBytes = samples * 2;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Pass the underlying buffers: TS 5.7+ types typed arrays over ArrayBufferLike,
  // which does not satisfy BlobPart. Chunks from floatToInt16 are exact-fit, so
  // the fast path is a straight handoff with no copy.
  const parts: BlobPart[] = [header];
  for (const c of chunks) {
    const exact = c.byteOffset === 0 && c.byteLength === c.buffer.byteLength;
    parts.push(
      exact
        ? (c.buffer as ArrayBuffer)
        : (c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer)
    );
  }
  return new Blob(parts, { type: 'audio/wav' });
}

export function recordingFilename(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `mashup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}.wav`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
