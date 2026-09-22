/**
 * 그림판 — Pointer Events, pointer capture, pointercancel 처리, 논리 좌표(800×600) 저장.
 * 포인터 이동마다 React 를 다시 렌더링하지 않고 캔버스에 직접 그린다.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { LIMITS, type Stroke, type StrokeTool } from '@shared/types';
import { CANVAS_H, CANVAS_W, drawSegment, fitCanvas, renderAll } from './render';

export interface DrawingCanvasHandle {
  getStrokes(): Stroke[];
  setStrokes(strokes: Stroke[]): void;
  undo(): void;
  redo(): void;
  clear(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

interface Props {
  disabled?: boolean;
  initialStrokes?: Stroke[];
  /** 획이 추가·삭제될 때 (실시간 전송·초안 저장용). appended 가 null 이면 전체 재구성 필요. */
  onChange?: (strokes: Stroke[], appended: Stroke | null) => void;
  tool: StrokeTool;
  color: string;
  width: number;
}

export const DrawingCanvas = forwardRef<DrawingCanvasHandle, Props>(function DrawingCanvas({ disabled, initialStrokes, onChange, tool, color, width }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const strokesRef = useRef<Stroke[]>(initialStrokes ? initialStrokes.slice() : []);
  const redoRef = useRef<Stroke[]>([]);
  const activeRef = useRef<{ pointerId: number; stroke: Stroke; drawnPoints: number } | null>(null);
  const [, bump] = useState(0);
  const propsRef = useRef({ tool, color, width, disabled, onChange });
  propsRef.current = { tool, color, width, disabled, onChange };

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const ctx = fitCanvas(canvas, rect.width, rect.height);
    ctxRef.current = ctx;
    if (ctx) renderAll(ctx, strokesRef.current);
  }, []);

  useEffect(() => {
    redraw();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(wrap);
    const onOrient = () => window.setTimeout(redraw, 50);
    window.addEventListener('orientationchange', onOrient);
    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', onOrient);
    };
  }, [redraw]);

  useImperativeHandle(ref, () => ({
    getStrokes: () => strokesRef.current.slice(),
    setStrokes: (s) => {
      strokesRef.current = s.slice();
      redoRef.current = [];
      redraw();
      bump((n) => n + 1);
    },
    undo: () => {
      const s = strokesRef.current.pop();
      if (!s) return;
      redoRef.current.push(s);
      redraw();
      bump((n) => n + 1);
      propsRef.current.onChange?.(strokesRef.current.slice(), null);
    },
    redo: () => {
      const s = redoRef.current.pop();
      if (!s) return;
      strokesRef.current.push(s);
      redraw();
      bump((n) => n + 1);
      propsRef.current.onChange?.(strokesRef.current.slice(), s);
    },
    clear: () => {
      if (strokesRef.current.length === 0) return;
      strokesRef.current = [];
      redoRef.current = [];
      redraw();
      bump((n) => n + 1);
      propsRef.current.onChange?.([], null);
    },
    canUndo: () => strokesRef.current.length > 0,
    canRedo: () => redoRef.current.length > 0,
  }));

  const toLogical = (e: PointerEvent | React.PointerEvent): [number, number] => {
    const wrap = wrapRef.current!;
    const rect = wrap.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    return [Math.max(0, Math.min(CANVAS_W, Math.round(x * 10) / 10)), Math.max(0, Math.min(CANVAS_H, Math.round(y * 10) / 10))];
  };

  const finish = useCallback((commit: boolean) => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    const canvas = canvasRef.current;
    try {
      canvas?.releasePointerCapture(active.pointerId);
    } catch {
      /* ignore */
    }
    if (!commit) {
      redraw();
      return;
    }
    if (strokesRef.current.length >= LIMITS.strokeMax) {
      redraw();
      return;
    }
    strokesRef.current.push(active.stroke);
    redoRef.current = [];
    bump((n) => n + 1);
    propsRef.current.onChange?.(strokesRef.current.slice(), active.stroke);
  }, [redraw]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = propsRef.current;
    if (p.disabled) return;
    if (activeRef.current) return; // 펜 + 손가락 동시 입력 방지: 한 번에 한 포인터만
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const canvas = e.currentTarget;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const [x, y] = toLogical(e);
    const stroke: Stroke = { t: p.tool, c: p.color, w: p.width, p: [x, y] };
    activeRef.current = { pointerId: e.pointerId, stroke, drawnPoints: 0 };
    const ctx = ctxRef.current;
    if (ctx) drawSegment(ctx, stroke, 0);
    activeRef.current.drawnPoints = 1;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    const s = active.stroke;
    if (s.p.length / 2 >= LIMITS.pointsPerStrokeMax) return;
    const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const events = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const list = events.length > 0 ? events : [native];
    for (const ev of list) {
      const [x, y] = toLogical(ev);
      const lx = s.p[s.p.length - 2]!;
      const ly = s.p[s.p.length - 1]!;
      if (Math.abs(lx - x) < 0.8 && Math.abs(ly - y) < 0.8) continue;
      s.p.push(x, y);
      if (s.p.length / 2 >= LIMITS.pointsPerStrokeMax) break;
    }
    const ctx = ctxRef.current;
    if (ctx) {
      drawSegment(ctx, s, active.drawnPoints);
      active.drawnPoints = s.p.length / 2;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    finish(true);
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    // 스크롤·제스처 등으로 취소되면 지금까지 그린 부분은 살린다
    finish(active.stroke.p.length >= 4);
  };

  return (
    <div ref={wrapRef} className={`canvas-wrap ${disabled ? 'opacity-70' : ''}`}>
      <canvas
        ref={canvasRef}
        aria-label="그림판. 손가락, 마우스, 펜으로 그릴 수 있어요."
        role="img"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
});
