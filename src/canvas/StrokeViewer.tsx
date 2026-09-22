import { useEffect, useRef } from 'react';
import type { Stroke } from '@shared/types';
import { fitCanvas, renderAll } from './render';

/** 읽기 전용 그림 표시. 스트로크 데이터로 크기 변화에 맞춰 다시 그린다. */
export function StrokeViewer({ strokes, className, label, boxAttr }: { strokes: readonly Stroke[]; className?: string; label?: string; boxAttr?: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const draw = () => {
      const rect = wrap.getBoundingClientRect();
      const ctx = fitCanvas(canvas, rect.width, rect.height);
      if (ctx) renderAll(ctx, strokes);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [strokes]);

  return (
    <div ref={wrapRef} data-entry-box={boxAttr ? '' : undefined} className={`viewer ${className ?? ''}`} role="img" aria-label={label ?? '그림'}>
      <canvas ref={ref} />
    </div>
  );
}
