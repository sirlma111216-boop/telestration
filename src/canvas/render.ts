import { LIMITS, type Stroke } from '@shared/types';

export const CANVAS_W = LIMITS.canvasWidth;
export const CANVAS_H = LIMITS.canvasHeight;

/** 캔버스를 논리 해상도 × devicePixelRatio 로 맞추고 변환 행렬을 설정한다 */
export function fitCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(w / CANVAS_W, 0, 0, h / CANVAS_H, 0, 0);
  return ctx;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  if (s.p.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = s.w;
  if (s.t === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = s.c;
  }
  ctx.beginPath();
  if (s.p.length === 2) {
    // 점 하나: 작은 원
    ctx.fillStyle = ctx.strokeStyle;
    ctx.arc(s.p[0]!, s.p[1]!, s.w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.moveTo(s.p[0]!, s.p[1]!);
  for (let i = 2; i < s.p.length; i += 2) ctx.lineTo(s.p[i]!, s.p[i + 1]!);
  ctx.stroke();
  ctx.restore();
}

export function renderAll(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[]): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  for (const s of strokes) drawStroke(ctx, s);
}

/** 이미 그려진 선 위에 마지막 구간만 추가 (그리는 중) */
export function drawSegment(ctx: CanvasRenderingContext2D, s: Stroke, fromPointIndex: number): void {
  const n = s.p.length / 2;
  if (n < 2) {
    drawStroke(ctx, s);
    return;
  }
  const start = Math.max(0, fromPointIndex - 1);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = s.w;
  if (s.t === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.strokeStyle = s.c;
  }
  ctx.beginPath();
  ctx.moveTo(s.p[start * 2]!, s.p[start * 2 + 1]!);
  for (let i = start + 1; i < n; i++) ctx.lineTo(s.p[i * 2]!, s.p[i * 2 + 1]!);
  ctx.stroke();
  ctx.restore();
}
