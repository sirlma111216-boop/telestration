/** 개발 전용 그림판 시험 페이지 (/dev/canvas). 프로덕션 빌드에서는 라우트가 등록되지 않는다. */
import { useRef, useState } from 'react';
import { LIMITS, type StrokeTool } from '@shared/types';
import { DrawingCanvas, type DrawingCanvasHandle } from '../canvas/DrawingCanvas';
import { StrokeViewer } from '../canvas/StrokeViewer';
import { Page } from '../components/ui';

declare global {
  interface Window {
    __canvas?: DrawingCanvasHandle | null;
  }
}

export function CanvasPlayground() {
  const ref = useRef<DrawingCanvasHandle | null>(null);
  const [tool, setTool] = useState<StrokeTool>('pen');
  const [, bump] = useState(0);
  return (
    <Page>
      <h1 className="mb-2 font-extrabold">그림판 시험</h1>
      <div className="flex gap-2 pb-2">
        <button className="btn btn-sm" data-testid="pen" onClick={() => setTool('pen')}>
          펜
        </button>
        <button className="btn btn-sm" data-testid="eraser" onClick={() => setTool('eraser')}>
          지우개
        </button>
        <button className="btn btn-sm" data-testid="undo" onClick={() => ref.current?.undo()}>
          취소
        </button>
        <button className="btn btn-sm" data-testid="redo" onClick={() => ref.current?.redo()}>
          복구
        </button>
        <button className="btn btn-sm" data-testid="clear" onClick={() => ref.current?.clear()}>
          지우기
        </button>
      </div>
      <DrawingCanvas
        ref={(h) => {
          ref.current = h;
          window.__canvas = h;
        }}
        tool={tool}
        color={LIMITS.colors[1]}
        width={tool === 'pen' ? 18 : 40}
        onChange={() => bump((n) => n + 1)}
      />
      <p data-testid="count" className="py-2 text-sm">
        획 {ref.current?.getStrokes().length ?? 0}
      </p>
      <StrokeViewer strokes={ref.current?.getStrokes() ?? []} label="미리보기" />
    </Page>
  );
}
