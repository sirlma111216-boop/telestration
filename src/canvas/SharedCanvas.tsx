/**
 * 가짜 예술가 찾기의 공유 캔버스.
 *
 * 기존 그림판의 좌표 변환·렌더링(render.ts)을 그대로 쓰되, 입력은 **한 획 전용**이다.
 *  - pointerdown 하나에서 시작해 pointerup(또는 pointercancel)으로 끝나는 경로 하나만 만든다.
 *  - 끝나면 입력을 잠근다. 다시 그리려면 부모가 clearLocal() 을 불러야 한다 ('지우고 다시 그리기').
 *  - 활성 포인터는 하나만 받는다 (두 번째 손가락·펜은 무시).
 *  - 창이 포커스를 잃으면 그리던 획을 잠정 종료한다 (pointercancel 과 같게).
 *  - 크기가 바뀌면 받은 데이터로 처음부터 다시 그린다.
 *
 * 확정된 획(committed)은 부모가 서버 상태로 넘겨준다. 이 컴포넌트는 그것을 바꾸지 않는다.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { Stroke } from '@shared/types';
import { FA_MAX_POINTS, FA_STROKE_WIDTH, simplifyPoints, type FaStrokeView } from '@shared/fakeArtist';
import { CANVAS_H, CANVAS_W, drawSegment, drawStroke, fitCanvas } from './render';

export interface SharedCanvasHandle {
  clearLocal(): void;
  getLocal(): Stroke | null;
}

export interface SharedCanvasInput {
  colorHex: string;
  /** false 면 그리기 불가 (차례 아님·잠김) */
  enabled: boolean;
  /** 재접속 등으로 이미 그려 둔 내 획을 복원할 때 */
  initial?: Stroke | null;
  onChange?: (s: Stroke) => void;
  onEnd?: (s: Stroke) => void;
}

interface Props {
  committed: readonly FaStrokeView[];
  /** 지금 차례인 다른 사람이 그리는 중인 획 */
  draft?: Stroke | null;
  highlightPlayerId?: string | null;
  input?: SharedCanvasInput | null;
  label: string;
  active?: boolean;
}

const HIGHLIGHT_MS = 900;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export const SharedCanvas = forwardRef<SharedCanvasHandle, Props>(function SharedCanvas({ committed, draft, highlightPlayerId, input, label, active }, ref) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const localRef = useRef<Stroke | null>(input?.initial ? { ...input.initial, p: input.initial.p.slice() } : null);
  const finishedRef = useRef<boolean>(!!input?.initial);
  const activePointer = useRef<number | null>(null);
  const drawnPoints = useRef(0);
  const animStart = useRef(0);
  const animFrame = useRef<number | null>(null);
  const props = useRef({ committed, draft, highlightPlayerId, input });
  props.current = { committed, draft, highlightPlayerId, input };

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const ctx = fitCanvas(canvas, rect.width, rect.height);
    ctxRef.current = ctx;
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    const { committed: list, draft: d, highlightPlayerId: hl } = props.current;
    const progress = hl && !prefersReducedMotion() ? Math.min(1, (performance.now() - animStart.current) / HIGHLIGHT_MS) : 1;
    // 강조: 나머지 획은 옅게, 고른 사람의 획은 천천히 다시 그린다. 데이터는 바꾸지 않는다.
    for (const c of list) {
      if (!c.stroke) continue;
      if (hl && c.playerId !== hl) {
        ctx.globalAlpha = 0.14;
        drawStroke(ctx, c.stroke);
        ctx.globalAlpha = 1;
      }
    }
    for (const c of list) {
      if (!c.stroke) continue;
      if (hl && c.playerId !== hl) continue;
      if (hl && progress < 1) {
        const n = c.stroke.p.length / 2;
        const upto = Math.max(1, Math.round(n * progress));
        drawStroke(ctx, { ...c.stroke, p: c.stroke.p.slice(0, upto * 2) });
      } else {
        drawStroke(ctx, c.stroke);
      }
    }
    if (d) drawStroke(ctx, d);
    if (localRef.current) drawStroke(ctx, localRef.current);
    drawnPoints.current = localRef.current ? localRef.current.p.length / 2 : 0;
    if (hl && progress < 1) {
      if (animFrame.current === null) {
        animFrame.current = requestAnimationFrame(() => {
          animFrame.current = null;
          redraw();
        });
      }
    }
  }, []);

  // 받은 데이터가 바뀌면 다시 그린다
  useEffect(() => {
    redraw();
  }, [committed, draft, redraw]);
  useEffect(() => {
    animStart.current = performance.now();
    redraw();
  }, [highlightPlayerId, redraw]);

  // 크기 변경·회전 → 데이터로 다시 그리기
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      if (animFrame.current !== null) cancelAnimationFrame(animFrame.current);
    };
  }, [redraw]);

  const copy = (s: Stroke): Stroke => ({ ...s, p: s.p.slice() });

  const finish = useCallback(() => {
    const pid = activePointer.current;
    if (pid === null) return;
    activePointer.current = null;
    try {
      canvasRef.current?.releasePointerCapture(pid);
    } catch {
      /* 이미 풀림 */
    }
    const s = localRef.current;
    if (!s) return;
    finishedRef.current = true; // 펜을 뗀 뒤에는 두 번째 선을 그릴 수 없다
    props.current.input?.onEnd?.(copy(s));
  }, []);

  // 창이 포커스를 잃으면 그리던 획을 잠정 종료한다
  useEffect(() => {
    const onBlur = () => finish();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [finish]);

  useImperativeHandle(ref, () => ({
    clearLocal: () => {
      localRef.current = null;
      finishedRef.current = false;
      activePointer.current = null;
      redraw();
    },
    getLocal: () => (localRef.current ? copy(localRef.current) : null),
  }));

  const toLogical = (ev: { clientX: number; clientY: number }): [number, number] => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((ev.clientY - rect.top) / rect.height) * CANVAS_H;
    return [Math.round(Math.max(0, Math.min(CANVAS_W, x)) * 10) / 10, Math.round(Math.max(0, Math.min(CANVAS_H, y)) * 10) / 10];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const inp = props.current.input;
    if (!inp?.enabled || finishedRef.current || activePointer.current !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    activePointer.current = e.pointerId;
    const [x, y] = toLogical(e);
    localRef.current = { t: 'pen', c: inp.colorHex, w: FA_STROKE_WIDTH, p: [x, y] };
    const ctx = ctxRef.current;
    if (ctx) drawSegment(ctx, localRef.current, 0);
    drawnPoints.current = 1;
    inp.onChange?.(copy(localRef.current));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== e.pointerId || !localRef.current) return;
    e.preventDefault();
    const s = localRef.current;
    const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const evs = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [native]) {
      const [x, y] = toLogical(ev);
      const lx = s.p[s.p.length - 2]!;
      const ly = s.p[s.p.length - 1]!;
      if (Math.abs(lx - x) < 1.5 && Math.abs(ly - y) < 1.5) continue;
      s.p.push(x, y);
    }
    if (s.p.length / 2 > FA_MAX_POINTS) {
      // 너무 길면 점을 솎아 낸다 (모양은 거의 그대로)
      s.p = simplifyPoints(s.p);
      redraw();
    } else if (ctxRef.current) {
      drawSegment(ctxRef.current, s, drawnPoints.current);
      drawnPoints.current = s.p.length / 2;
    }
    props.current.input?.onChange?.(copy(s));
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== e.pointerId) return;
    e.preventDefault();
    finish();
  };

  const interactive = !!input?.enabled;
  return (
    // 4:3 캔버스가 화면 높이를 넘어 아래 버튼(확정·다시 그리기)이 밀려나지 않게 폭을 화면 높이에 맞춰 줄인다
    <div
      ref={wrapRef}
      className={`canvas-wrap mx-auto w-full ${active ? 'fa-active' : ''}`}
      style={{ touchAction: interactive ? 'none' : 'auto', maxWidth: 'max(18rem, calc((100dvh - 22rem) * 4 / 3))' }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        data-fa-canvas=""
        style={{ touchAction: interactive ? 'none' : 'auto' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
});
