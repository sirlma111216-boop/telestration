/**
 * 공동 결과 공개 화면.
 * 학생: 방장이 고른 같은 참가자·같은 그림책·같은 항목만 본다. 독립 이전/다음·목록·자유 탐색 없음.
 * 방장: 참가자 목록 → 그림책 선택 → 이전/다음. 서버가 공개 상태를 관리하고 모두에게 방송한다.
 */
import { useEffect, useState } from 'react';
import type { RoomSnapshot } from '@shared/types';
import type { ReconnectingSocket } from '../lib/socket';
import { EntryCard, Modal, Notice, Pill, useAsyncAction } from '../components/ui';

export interface Reaction {
  id: number;
  reaction: 'lol' | 'wow' | 'best';
  from: string;
}
const EMOJI: Record<Reaction['reaction'], string> = { lol: '😂', wow: '😲', best: '👍' };

export function RevealView({ snap, sock, reactions, connected }: { snap: RoomSnapshot; sock: ReconnectingSocket; reactions: Reaction[]; connected: boolean }) {
  const r = snap.reveal;
  const canControl = snap.me.canControl;
  const { busy, run } = useAsyncAction();
  const [zoom, setZoom] = useState(false);
  const [lastReaction, setLastReaction] = useState(0);

  useEffect(() => {
    if (!r?.entry) setZoom(false);
  }, [r?.bookId, r?.entry]);

  if (!r) return null;

  const step = (dir: 1 | -1) => run(() => sock.command({ type: 'reveal.step', gameId: snap.gameId, direction: dir, expectedRevision: r.revision }));
  const select = (bookId: string) => run(() => sock.command({ type: 'reveal.selectBook', gameId: snap.gameId, bookId, expectedRevision: r.revision }));
  const react = (reaction: Reaction['reaction']) => {
    if (Date.now() - lastReaction < 1500) return;
    setLastReaction(Date.now());
    sock.command({ type: 'reveal.reaction', gameId: snap.gameId, reaction }).catch(() => {});
  };

  const stageText = r.entry ? (r.entry.kind === 'prompt' ? '제시어' : r.entry.kind === 'drawing' ? `${r.entry.stage}단계 · 그림` : `${r.entry.stage}단계 · 추측`) : '';

  const stage = (
    <div className="relative flex flex-col gap-3">
      {!connected && <Notice tone="coral">연결이 끊겨 최신 화면인지 확인할 수 없어요. 연결이 복구되면 자동으로 맞춰져요.</Notice>}
      {r.bookId ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-lg font-extrabold">{r.ownerName}의 그림책</div>
            <Pill tone="violet">
              {r.entryIndex + 1}/{r.entryCount} {stageText && `· ${stageText}`}
            </Pill>
          </div>
          {r.entry ? (
            <div className="pop" key={`${r.bookId}-${r.entryIndex}`}>
              <EntryCard entry={r.entry} frame />
            </div>
          ) : (
            <div className="paper flex aspect-[4/3] flex-col items-center justify-center bg-violet-2 p-6 text-center">
              <div className="text-5xl">📖</div>
              <div className="mt-3 text-2xl font-extrabold">{r.ownerName}의 그림책</div>
              <p className="mt-1 text-sm text-ink-2">{canControl ? '"다음"을 눌러 첫 제시어를 공개하세요' : '방장이 곧 첫 페이지를 넘겨요'}</p>
            </div>
          )}
        </>
      ) : (
        <div className="paper flex aspect-[4/3] flex-col items-center justify-center bg-cream-2 p-6 text-center">
          <div className="text-4xl">🎉</div>
          <div className="mt-2 text-xl font-extrabold">{snap.status === 'FINISHED' ? '모든 그림책을 공개했어요!' : '결과 공개 시간!'}</div>
          <p className="mt-1 text-sm text-ink-2">{canControl ? '참가자를 선택하면 그 그림책이 모두의 화면에 나타나요' : '방장이 참가자를 고르면 함께 볼 수 있어요'}</p>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 top-0 overflow-hidden" aria-hidden="true">
        {reactions.map((x) => (
          <span key={x.id} className="float-up absolute bottom-8 text-3xl" style={{ left: `${10 + ((x.id * 37) % 80)}%` }}>
            {EMOJI[x.reaction]}
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[1fr_16rem] lg:gap-6">
      <div className="flex flex-col gap-3">
        {stage}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1.5" role="group" aria-label="반응">
            {(['lol', 'wow', 'best'] as const).map((k) => (
              <button key={k} className="btn btn-sm" onClick={() => react(k)} aria-label={k === 'lol' ? 'ㅋㅋ' : k === 'wow' ? '놀람' : '최고'}>
                {EMOJI[k]} {k === 'lol' ? 'ㅋㅋ' : k === 'wow' ? '놀람' : '최고'}
              </button>
            ))}
          </div>
          {r.entry && (
            <button className="btn btn-sm" onClick={() => setZoom(true)}>
              🔍 확대
            </button>
          )}
        </div>
        {canControl && (
          <div className="flex gap-2">
            <button className="btn flex-1" disabled={busy || !r.bookId || r.entryIndex <= -1} onClick={() => step(-1)}>
              ← 이전
            </button>
            <button className="btn btn-primary flex-1 text-lg" disabled={busy || !r.bookId || r.entryIndex >= r.entryCount - 1} onClick={() => step(1)}>
              다음 →
            </button>
          </div>
        )}
        {!canControl && snap.me.isHost && !snap.me.primaryConnection && <Notice tone="coral">다른 탭에서 이 방을 열고 있어요. 그 탭에서 진행해 주세요.</Notice>}
      </div>

      {canControl && snap.revealBooks && (
        <aside className="paper p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-extrabold">참가자</h3>
            <span className="text-xs text-ink-2">
              완료 {snap.revealBooks.filter((b) => b.status === 'complete').length}/{snap.revealBooks.length}
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {snap.revealBooks.map((b) => (
              <li key={b.bookId}>
                <button className={`btn btn-sm w-full justify-between ${r.bookId === b.bookId ? 'btn-violet' : ''}`} disabled={busy} onClick={() => select(b.bookId)} aria-current={r.bookId === b.bookId}>
                  <span className="truncate">{b.ownerName}</span>
                  <span className="text-xs">{b.status === 'complete' ? '✅ 완료' : b.status === 'partial' ? `${b.revealedCount}/${b.entryCount}` : '미공개'}</span>
                </button>
              </li>
            ))}
          </ul>
          {snap.status === 'REVEALING' && <p className="mt-2 text-xs text-ink-2">모든 그림책의 모든 페이지를 한 번씩 공개해야 완료돼요. 건너뛴 책은 완료로 처리되지 않아요.</p>}
        </aside>
      )}

      {zoom && r.entry && (
        <Modal title={`${r.ownerName}의 그림책 · ${stageText}`} onClose={() => setZoom(false)}>
          <div key={`${r.bookId}-${r.entryIndex}`}>
            <EntryCard entry={r.entry} frame />
          </div>
          <p className="mt-2 text-xs text-ink-2">방장이 넘기면 확대 화면도 함께 바뀌어요.</p>
        </Modal>
      )}
    </div>
  );
}
