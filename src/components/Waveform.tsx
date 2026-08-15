import { useEffect, useRef } from 'react';
import type { Deck } from '../audio/Deck';

interface Props {
  deck: Deck;
  color: string;
}

const ZOOM_WINDOW_SEC = 6;

/**
 * Overview + zoomed strip, both on canvas and driven by rAF reading
 * deck.positionFrames directly — no React re-render per frame.
 *
 * The overview waveform is rendered once into two offscreen canvases (dim for
 * unplayed, bright for played) and blitted each frame. Rescanning ~120k peak
 * buckets per frame per deck would not hold 60 fps; a drawImage does.
 */
export function Waveform({ deck, color }: Props) {
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const zoomRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<{
    dim: HTMLCanvasElement;
    bright: HTMLCanvasElement;
    key: string;
  } | null>(null);

  useEffect(() => {
    let raf = 0;

    const buildCache = (w: number, h: number) => {
      const key = `${deck.fileName}:${deck.lengthFrames}:${w}x${h}:${color}`;
      if (cacheRef.current?.key === key) return cacheRef.current;
      const peaks = deck.peaks;
      if (!peaks || w === 0 || h === 0) return null;

      const make = (stroke: string) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        if (!g) return c;
        g.fillStyle = stroke;
        const buckets = peaks.min.length;
        const mid = h / 2;
        for (let x = 0; x < w; x++) {
          const b0 = Math.floor((x / w) * buckets);
          const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * buckets));
          let lo = 0;
          let hi = 0;
          for (let b = b0; b < b1 && b < buckets; b++) {
            if (peaks.min[b] < lo) lo = peaks.min[b];
            if (peaks.max[b] > hi) hi = peaks.max[b];
          }
          const y0 = mid - hi * mid * 0.95;
          const y1 = mid - lo * mid * 0.95;
          g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
        }
        return c;
      };

      const entry = { dim: make('#33405a'), bright: make(color), key };
      cacheRef.current = entry;
      return entry;
    };

    const sizeCanvas = (canvas: HTMLCanvasElement) => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return { w, h };
    };

    const drawOverview = () => {
      const canvas = overviewRef.current;
      if (!canvas) return;
      const { w, h } = sizeCanvas(canvas);
      const g = canvas.getContext('2d');
      if (!g) return;

      g.clearRect(0, 0, w, h);
      g.fillStyle = '#10141d';
      g.fillRect(0, 0, w, h);

      if (!deck.loaded || !deck.peaks) return;

      const cache = buildCache(w, h);
      if (!cache) return;

      const frac = deck.durationSec > 0 ? deck.positionSecNow / deck.durationSec : 0;
      const px = Math.max(0, Math.min(w, frac * w));

      g.drawImage(cache.dim, 0, 0);
      if (px > 0) g.drawImage(cache.bright, 0, 0, px, h, 0, 0, px, h);

      // Loop region, so it is obvious which part is repeating.
      if (deck.loopStartSec != null && deck.loopEndSec != null && deck.durationSec > 0) {
        const x0 = (deck.loopStartSec / deck.durationSec) * w;
        const x1 = (deck.loopEndSec / deck.durationSec) * w;
        g.fillStyle = 'rgba(163, 230, 53, 0.15)';
        g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
        g.fillStyle = 'rgba(163, 230, 53, 0.85)';
        g.fillRect(x0, 0, 2, h);
        g.fillRect(x1 - 2, 0, 2, h);
      }

      // Hot cues.
      for (let i = 0; i < deck.cues.length; i++) {
        const f = deck.cues[i];
        if (f == null) continue;
        const cx = (f / deck.sampleRate / deck.durationSec) * w;
        g.fillStyle = '#fbbf24';
        g.fillRect(cx - 1, 0, 2, h);
        g.fillRect(cx - 1, 0, 10, 12);
        g.fillStyle = '#0a0d14';
        g.font = `bold ${9 * (window.devicePixelRatio || 1)}px ui-monospace, monospace`;
        g.fillText(String(i + 1), cx + 1, 9 * (window.devicePixelRatio || 1));
      }

      g.fillStyle = '#ffffff';
      g.fillRect(px - 1, 0, 2, h);
    };

    const drawZoom = () => {
      const canvas = zoomRef.current;
      if (!canvas) return;
      const { w, h } = sizeCanvas(canvas);
      const g = canvas.getContext('2d');
      if (!g) return;

      g.clearRect(0, 0, w, h);
      g.fillStyle = '#10141d';
      g.fillRect(0, 0, w, h);

      const peaks = deck.peaks;
      if (!deck.loaded || !peaks) return;

      const pos = deck.positionSecNow;
      const t0 = pos - ZOOM_WINDOW_SEC / 2;
      const bps = peaks.bucketsPerSecond;
      const mid = h / 2;

      g.fillStyle = color;
      for (let x = 0; x < w; x++) {
        const t = t0 + (x / w) * ZOOM_WINDOW_SEC;
        if (t < 0 || t > deck.durationSec) continue;
        const b0 = Math.floor(t * bps);
        const b1 = Math.max(b0 + 1, Math.floor((t + ZOOM_WINDOW_SEC / w) * bps));
        let lo = 0;
        let hi = 0;
        for (let b = b0; b < b1 && b < peaks.min.length; b++) {
          if (peaks.min[b] < lo) lo = peaks.min[b];
          if (peaks.max[b] > hi) hi = peaks.max[b];
        }
        const y0 = mid - hi * mid * 0.95;
        const y1 = mid - lo * mid * 0.95;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }

      if (deck.loopStartSec != null && deck.loopEndSec != null) {
        const toX = (t: number) => ((t - t0) / ZOOM_WINDOW_SEC) * w;
        const x0 = toX(deck.loopStartSec);
        const x1 = toX(deck.loopEndSec);
        if (x1 > 0 && x0 < w) {
          const cx0 = Math.max(0, x0);
          const cx1 = Math.min(w, x1);
          g.fillStyle = 'rgba(163, 230, 53, 0.15)';
          g.fillRect(cx0, 0, Math.max(1, cx1 - cx0), h);
          g.fillStyle = 'rgba(163, 230, 53, 0.85)';
          if (x0 >= 0 && x0 <= w) g.fillRect(x0, 0, 2, h);
          if (x1 >= 0 && x1 <= w) g.fillRect(x1 - 2, 0, 2, h);
        }
      }

      // Beat grid — this is what makes phase alignment visible rather than a
      // claim: when two decks are locked, their grids line up on screen.
      const a = deck.analysis;
      if (a) {
        const beat = 60 / a.bpm;
        const first = Math.ceil((t0 - a.firstBeatSec) / beat);
        for (let n = first; ; n++) {
          const t = a.firstBeatSec + n * beat;
          if (t > t0 + ZOOM_WINDOW_SEC) break;
          if (t < t0) continue;
          const x = ((t - t0) / ZOOM_WINDOW_SEC) * w;
          const downbeat = ((n % 4) + 4) % 4 === 0;
          g.fillStyle = downbeat ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.16)';
          g.fillRect(x, downbeat ? 0 : h * 0.35, 1, downbeat ? h : h * 0.3);
        }
      }

      g.fillStyle = '#ffffff';
      g.fillRect(w / 2 - 1, 0, 2, h);
    };

    const loop = () => {
      drawOverview();
      drawZoom();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [deck, color]);

  const seekFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!deck.loaded) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    deck.seekSeconds(frac * deck.durationSec, deck.playing);
  };

  return (
    <div className="space-y-1">
      <canvas
        ref={overviewRef}
        onClick={seekFromEvent}
        className="w-full h-16 rounded-md cursor-pointer block"
      />
      <canvas ref={zoomRef} className="w-full h-10 rounded-md block" />
    </div>
  );
}
