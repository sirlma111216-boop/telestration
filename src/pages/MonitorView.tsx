/** 참관 방장·교사 모니터링: 플레이어별 카드 (휴대폰: 목록, 태블릿·PC: 그리드) */
import { useState } from 'react';
import type { MonitorPlayerView, RoomSnapshot } from '@shared/types';
import { EntryCard, Modal, Notice, PayloadView, Pill, TimerBar } from '../components/ui';
import { useCountdown } from '../lib/clock';

export function MonitorView({ snap, players, synced }: { snap: RoomSnapshot; players: MonitorPlayerView[]; synced: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const left = useCountdown(snap.deadlineAt);
  const total = snap.status === 'PROMPT_SELECTION' ? 30 : snap.stage % 2 === 1 ? snap.settings.drawSeconds : snap.settings.guessSeconds;
  const open = players.find((p) => p.userId === openId) ?? null;
  const submittedCount = players.filter((p) => p.submitted || p.skipped).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-extrabold">
          {snap.status === 'PROMPT_SELECTION' ? '제시어 고르는 중' : `${snap.stage}/${snap.stageCount}단계 · ${snap.stage % 2 === 1 ? '그리기' : '추측'}`}
          <span className="ml-2 text-sm font-bold text-ink-2">
            제출 {submittedCount}/{players.length}
          </span>
        </div>
        {!synced && <Pill tone="coral">최신 스냅샷과 동기화 중…</Pill>}
      </div>
      <TimerBar secondsLeft={left} total={total} />
      {players.length === 0 && <Notice>아직 표시할 작업이 없어요.</Notice>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {players.map((p) => (
          <li key={p.userId}>
            <button className="paper flex w-full flex-col gap-2 p-3 text-left" onClick={() => setOpenId(p.userId)} aria-label={`${p.displayName} 작업 확대`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`inline-block h-2.5 w-2.5 rounded-full border-2 border-ink ${p.connected ? 'bg-mint' : 'bg-white'}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-bold">{p.displayName}</span>
                {p.skipped ? <Pill tone="muted">나감</Pill> : p.submitted ? <Pill tone="mint">제출 완료</Pill> : <Pill tone="violet">{p.kind === 'drawing' ? '그리는 중' : p.kind === 'guess' ? '입력 중' : p.kind === 'prompt' ? '고르는 중' : '대기'}</Pill>}
                {!p.connected && <Pill tone="coral">끊김</Pill>}
              </div>
              <div className="text-xs text-ink-2">{p.bookOwnerName ? `${p.bookOwnerName}의 그림책` : ''}</div>
              <div className={p.submitted ? 'opacity-80' : ''}>
                <PayloadView payload={p.draft} kind={p.kind === 'idle' ? 'guess' : p.kind} />
              </div>
              <div className="flex items-center justify-between text-[11px] text-ink-2">
                <span>{p.updatedAt ? `갱신 ${new Date(p.updatedAt).toLocaleTimeString('ko-KR', { hour12: false })}` : '아직 입력 없음'}</span>
                {!p.submitted && p.draft && <span>{p.live ? '실시간' : '저장본'}</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <Modal title={`${open.displayName} · ${open.kind === 'drawing' ? '그리기' : open.kind === 'guess' ? '추측' : '제시어'}`} onClose={() => setOpenId(null)}>
          <div className="flex flex-col gap-3">
            <PayloadView payload={open.draft} kind={open.kind === 'idle' ? 'guess' : open.kind} big />
            {open.previous && (
              <div>
                <div className="mb-1 text-xs font-bold text-ink-2">직전 입력</div>
                <EntryCard entry={open.previous} />
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
