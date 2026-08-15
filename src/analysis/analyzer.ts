import type { AnalysisRequest, AnalysisResponse, AnalysisResult } from '../audio/types';

/** One shared worker for all decks; requests are keyed so they cannot cross. */
let worker: Worker | null = null;
let seq = 0;

interface Pending {
  resolve: (r: AnalysisResult) => void;
  reject: (e: Error) => void;
}
const pending = new Map<string, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
  }
  return worker;
}

/** Takes ownership of `mono` — its buffer is transferred to the worker. */
export function analyzeTrack(mono: Float32Array, sampleRate: number): Promise<AnalysisResult> {
  const id = `a${++seq}`;
  const w = getWorker();
  return new Promise<AnalysisResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: AnalysisRequest = { id, sampleRate, mono: mono.buffer as ArrayBuffer };
    w.postMessage(req, [req.mono]);
  });
}
