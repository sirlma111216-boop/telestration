/** 개발 전용: 한 획 공유 캔버스·대기 음악 시험 페이지 (/dev/fa). 프로덕션 빌드에서는 라우트가 등록되지 않는다. */
import { useRef, useState } from 'react';
import type { Stroke } from '@shared/types';
import { FA_COLORS, type FaStrokeView } from '@shared/fakeArtist';
import { SharedCanvas, type SharedCanvasHandle } from '../canvas/SharedCanvas';
import { waitingMusic } from '../lib/waitingMusic';
import { Page } from '../components/ui';

declare global {
  interface Window {
    __fa?: {
      ends: number;
      changes: number;
      last: Stroke | null;
      handle: SharedCanvasHandle | null;
    };
  }
}

export function FaPlayground() {
  const ref = useRef<SharedCanvasHandle | null>(null);
  const [committed, setCommitted] = useState<FaStrokeView[]>([]);
  const [locked, setLocked] = useState(false);
  const [hl, setHl] = useState<string | null>(null);
  const [color, setColor] = useState(0);
  const stats = useRef({
    ends: 0,
    changes: 0,
    last: null as Stroke | null,
    handle: null as SharedCanvasHandle | null,
  });
  window.__fa = stats.current;
  return (
    <Page wide>
      <h1 className="mb-2 font-extrabold">한 획 캔버스 시험</h1>
      <div className="flex flex-wrap gap-2 pb-2">
        <button
          className="btn btn-sm"
          data-testid="redo"
          onClick={() => {
            ref.current?.clearLocal();
            setLocked(false);
          }}
        >
          지우고 다시
        </button>
        <button
          className="btn btn-sm"
          data-testid="commit"
          onClick={() => {
            const s = ref.current?.getLocal();
            if (!s) return;
            setCommitted((c) => [...c, { playerId: `p${color}`, turnIndex: c.length, stroke: s }]);
            ref.current?.clearLocal();
            setLocked(false);
            setColor((i) => (i + 1) % FA_COLORS.length);
          }}
        >
          확정 (다음 색)
        </button>
        <button className="btn btn-sm" data-testid="hl" onClick={() => setHl(hl ? null : 'p0')}>
          강조 {hl ? '끄기' : '(첫 색)'}
        </button>
        <button
          className="btn btn-sm"
          data-testid="music-on"
          onClick={() => {
            void waitingMusic.enable().then(() => waitingMusic.setWaiting(true));
          }}
        >
          음악 켜기
        </button>
        <button className="btn btn-sm" data-testid="music-off" onClick={() => waitingMusic.setWaiting(false)}>
          음악 멈춤
        </button>
      </div>
      <SharedCanvas
        ref={(h) => {
          ref.current = h;
          stats.current.handle = h;
        }}
        active={!locked}
        committed={committed}
        highlightPlayerId={hl}
        label="시험 캔버스"
        input={{
          colorHex: FA_COLORS[color]!.hex,
          enabled: !locked,
          onChange: (s) => {
            stats.current.changes += 1;
            stats.current.last = s;
          },
          onEnd: (s) => {
            stats.current.ends += 1;
            stats.current.last = s;
            setLocked(true);
          },
        }}
      />
      <p className="mt-2 text-sm" data-testid="status">
        {locked ? '잠김' : '그리기 가능'} · 확정 {committed.length}획
      </p>
    </Page>
  );
}
