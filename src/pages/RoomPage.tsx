/**
 * 게임방 페이지 — 학생(플레이어/방장)과 교사(참관) 모두 이 컴포넌트를 쓴다.
 * 서버 스냅샷(version) 이 곧 화면이며, 낮은 version 은 무시한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MonitorPlayerView, RoomSnapshot, Stroke } from '@shared/types';
import { noteServerTime } from '../lib/clock';
import { navigate } from '../lib/router';
import { getStudentSession } from '../lib/session';
import { useSocket } from '../lib/useSocket';
import { BadgeMark, ConfirmModal, ConnectionBanner, Illustration, Logo, Notice, Page, Pill, TopBar, useAsyncAction, useToast } from '../components/ui';
import { DrawView, GuessView, PromptSelectView } from './PlayViews';
import { MonitorView } from './MonitorView';
import { RevealView, type Reaction } from './RevealView';
import { statusLabel, wsUrl } from './roomShared';

const ROOM_HELLO = { type: 'room.ping' };

/**
 * 안쪽에서 lg 2단 배치(참가자+설정, 캔버스+도구, 공개+참가자 목록)를 쓰는 화면은
 * 넓은 본문 폭이 필요하다. 좁은 폭에 사이드바가 들어가면 칸이 찌그러진다.
 */
function usesWideLayout(snap: RoomSnapshot): boolean {
  if (snap.me.canMonitor) return true;
  if (snap.status === 'LOBBY' || snap.status === 'REVEALING' || snap.status === 'FINISHED') return true;
  return snap.status === 'PLAYING' && snap.assignment?.kind === 'drawing';
}

interface Props {
  roomId: string;
  mode: 'student' | 'teacher';
  classId: string | null; // 학생: 세션 조회용, 교사: 돌아갈 클래스
}

export function RoomPage({ roomId, mode, classId }: Props) {
  const toast = useToast();
  const session = mode === 'student' && classId ? getStudentSession(classId) : null;
  const [snap, setSnap] = useState<RoomSnapshot | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<{ gameId: string | null; players: MonitorPlayerView[]; synced: boolean }>({ gameId: null, players: [], synced: false });
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const monitoringRef = useRef(false);

  const onMessage = useCallback(
    (m: Record<string, unknown>) => {
      switch (m.type) {
        case 'room.snapshot': {
          const s = m.snapshot as RoomSnapshot;
          noteServerTime(s.serverTime);
          setSnap((prev) => (prev && prev.roomId === s.roomId && prev.version > s.version ? prev : s));
          break;
        }
        case 'monitor.snapshot':
          setMonitor({ gameId: (m.gameId as string | null) ?? null, players: m.players as MonitorPlayerView[], synced: true });
          break;
        case 'monitor.update': {
          const u = m as { gameId: string; stageId: string; userId: string; strokesAppend?: Stroke[]; reset?: boolean; text?: string; updatedAt: number };
          setMonitor((prev) => {
            if (prev.gameId !== u.gameId) return prev;
            return {
              ...prev,
              players: prev.players.map((p) => {
                if (p.userId !== u.userId || p.submitted) return p;
                if (p.kind === 'drawing') {
                  const base = u.reset || !p.draft || p.draft.kind !== 'drawing' ? [] : p.draft.strokes;
                  return { ...p, draft: { kind: 'drawing', strokes: [...base, ...(u.strokesAppend ?? [])] }, live: true, updatedAt: u.updatedAt };
                }
                if (typeof u.text === 'string') return { ...p, draft: { kind: 'text', text: u.text }, live: true, updatedAt: u.updatedAt };
                return p;
              }),
            };
          });
          break;
        }
        case 'monitor.denied':
          monitoringRef.current = false;
          toast(String(m.message), 'error');
          break;
        case 'reveal.reaction': {
          const id = Date.now() + Math.random();
          setReactions((r) => [...r.slice(-8), { id, reaction: m.reaction as Reaction['reaction'], from: String(m.from) }]);
          window.setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 1700);
          break;
        }
        case 'room.closed':
        case 'room.kicked':
          setFatal(String(m.message ?? '방이 닫혔어요'));
          break;
        case 'error':
          toast(String(m.message ?? '오류'), 'error');
          break;
      }
    },
    [toast],
  );

  const url = mode === 'teacher' ? wsUrl(`/ws/room/${roomId}?as=teacher`) : session ? wsUrl(`/ws/room/${roomId}?token=${encodeURIComponent(session.token)}`) : null;
  const { state, detail, sock } = useSocket(url, onMessage, (code, reason) => {
    if (code === 4000) setFatal(reason === 'expired' ? '방이 만료되었어요.' : '방이 닫혔어요.');
    else if (code === 4002) setFatal(reason === 'left' ? '방에서 나왔어요.' : '방에서 내보내졌어요.');
    else if (code === 4999) setFatal('이 방에 연결할 수 없어요. 방이 닫혔거나 참여 중인 방이 아니에요.');
    else setFatal(reason || '연결이 종료되었어요');
  }, ROOM_HELLO);

  // 모니터링 구독: 권한이 있고 게임이 진행 중일 때 자동 구독 (교사·참관 방장)
  useEffect(() => {
    if (!snap || state !== 'open') return;
    const want = snap.me.canMonitor && (snap.status === 'PROMPT_SELECTION' || snap.status === 'PLAYING');
    if (want !== monitoringRef.current) {
      monitoringRef.current = want;
      setMonitor((m) => ({ ...m, synced: false }));
      sock.current?.command({ type: 'monitor.subscribe', subscribe: want }).catch(() => {
        monitoringRef.current = false;
      });
    }
  }, [snap, state, sock]);
  useEffect(() => {
    if (state !== 'open') monitoringRef.current = false;
  }, [state]);

  const connected = state === 'open';

  if (mode === 'student' && !session) {
    return (
      <Page>
        <div className="py-6 text-center">
          <Logo />
        </div>
        <Notice tone="coral">이 기기에는 참여 정보가 없어요. 클래스에 다시 참여해 주세요.</Notice>
        <button className="btn mt-4" onClick={() => navigate('/')}>
          처음으로
        </button>
      </Page>
    );
  }
  if (fatal) {
    return (
      <Page>
        <div className="py-6 text-center">
          <Logo />
        </div>
        <Notice tone="coral">{fatal}</Notice>
        <button className="btn btn-primary mt-4" onClick={() => navigate(mode === 'teacher' ? `/teacher/class/${classId ?? ''}` : `/class/${classId ?? ''}`)}>
          {mode === 'teacher' ? '클래스 화면으로' : '클래스 로비로'}
        </button>
      </Page>
    );
  }
  if (!snap) {
    return (
      <Page>
        <ConnectionBanner state={state} detail={detail} />
        <p className="py-10 text-center text-ink-2">방을 불러오는 중…</p>
      </Page>
    );
  }

  return (
    <Page wide={usesWideLayout(snap)}>
      <ConnectionBanner state={state} detail={detail} />
      <RoomHeader snap={snap} mode={mode} classId={classId} sock={sock.current} />
      {snap.observers.teacher && <div className="mb-3 text-center text-xs font-bold text-ink-2">👀 선생님 참관 중</div>}
      {!snap.observers.teacher && snap.observers.host && !snap.me.isHost && <div className="mb-3 text-center text-xs font-bold text-ink-2">👀 방장 참관 중</div>}
      {!snap.me.primaryConnection && <Notice tone="coral">다른 탭이나 창에서 이 방을 열고 있어요. 이 화면에서는 볼 수만 있어요.</Notice>}
      <div className="mt-3">
        <RoomBody snap={snap} sock={sock.current!} monitor={monitor} reactions={reactions} connected={connected} mode={mode} />
      </div>
    </Page>
  );
}

function RoomHeader({ snap, mode, classId, sock }: { snap: RoomSnapshot; mode: 'student' | 'teacher'; classId: string | null; sock: import('../lib/socket').ReconnectingSocket | null }) {
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const { run } = useAsyncAction();
  const hostText = snap.host.displayName ? `방장 ${snap.host.displayName}${snap.host.mode === 'observe' && !snap.host.isPlayingThisGame ? ' (참관)' : ''}${!snap.host.connected ? ' · 연결 끊김' : ''}` : '방장 없음 — 선생님이 진행권을 인수해야 해요';
  return (
    <>
      <TopBar
        title={snap.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            <Pill tone={snap.status === 'LOBBY' ? 'mint' : 'violet'}>{statusLabel(snap.status)}</Pill>
            <span>{hostText}</span>
            <span>· {snap.className}</span>
          </span>
        }
        right={
          <>
            {mode === 'teacher' ? (
              <>
                {(snap.status !== 'LOBBY' && snap.status !== 'FINISHED') || !snap.me.canControl ? (
                  <button className="btn btn-danger btn-sm" onClick={() => setConfirmClose(true)}>
                    강제 종료
                  </button>
                ) : null}
                <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/teacher/class/${classId ?? snap.classId}`)}>
                  ← 클래스
                </button>
              </>
            ) : (
              (snap.status === 'LOBBY' || snap.me.isPlayer) && (
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmLeave(true)}>
                  나가기
                </button>
              )
            )}
          </>
        }
      />
      {confirmLeave && (
        <ConfirmModal
          title="방 나가기"
          message={snap.status === 'LOBBY' ? '방에서 나가 클래스 로비로 돌아갈까요?' : '게임 중에 나가면 내 남은 작업은 건너뛰어요. 다시 들어올 수 없어요. 정말 나갈까요?'}
          confirmLabel="나가기"
          danger={snap.status !== 'LOBBY'}
          onClose={() => setConfirmLeave(false)}
          onConfirm={async () => {
            await run(() => sock!.command({ type: 'room.leave' }));
            navigate(`/class/${snap.classId}`);
          }}
        />
      )}
      {confirmClose && (
        <ConfirmModal
          title="방 강제 종료"
          message="진행 중인 게임을 끝내고 방을 닫아요. 학생들은 클래스 로비로 돌아가요. 게임 데이터는 삭제돼요."
          confirmLabel="강제 종료"
          danger
          onClose={() => setConfirmClose(false)}
          onConfirm={() => run(() => sock!.command({ type: 'room.forceClose', confirm: true }))}
        />
      )}
    </>
  );
}

function RoomBody({ snap, sock, monitor, reactions, connected, mode }: { snap: RoomSnapshot; sock: import('../lib/socket').ReconnectingSocket; monitor: { gameId: string | null; players: MonitorPlayerView[]; synced: boolean }; reactions: Reaction[]; connected: boolean; mode: 'student' | 'teacher' }) {
  const me = snap.me;
  switch (snap.status) {
    case 'LOBBY':
      return <LobbyView snap={snap} sock={sock} mode={mode} />;
    case 'PROMPT_SELECTION':
      if (snap.promptSelection) return <PromptSelectView ps={snap.promptSelection} deadlineAt={snap.deadlineAt} sock={sock} />;
      if (me.canMonitor) return <MonitorView snap={snap} players={monitor.players} synced={monitor.synced} />;
      return <WaitingView title="제시어를 고르는 중" text="플레이어들이 제시어를 고르고 있어요." />;
    case 'PLAYING': {
      const a = snap.assignment;
      if (a) {
        const total = a.kind === 'drawing' ? snap.settings.drawSeconds : snap.settings.guessSeconds;
        const sendLive = snap.observers.teacher || snap.observers.host;
        const key = `${a.gameId}:${a.stageId}:${a.submitted ? 's' : 'e'}`;
        return a.kind === 'drawing' ? <DrawView key={key} a={a} deadlineAt={snap.deadlineAt} totalSeconds={total} sock={sock} connected={connected} sendLive={sendLive} /> : <GuessView key={key} a={a} deadlineAt={snap.deadlineAt} totalSeconds={total} sock={sock} connected={connected} sendLive={sendLive} />;
      }
      if (me.canMonitor) return <MonitorView snap={snap} players={monitor.players} synced={monitor.synced} />;
      return <WaitingView title={`${snap.stage}/${snap.stageCount}단계 진행 중`} text={me.isHost ? '플레이어들이 작업 중이에요.' : '이번 판에는 참여하지 않았어요. 결과 공개 때 함께 볼 수 있어요.'} />;
    }
    case 'REVEAL_READY':
      return <RevealReadyView snap={snap} sock={sock} />;
    case 'REVEALING':
    case 'FINISHED':
      return (
        <div className="flex flex-col gap-4">
          <RevealView snap={snap} sock={sock} reactions={reactions} connected={connected} />
          {snap.status === 'FINISHED' && me.canControl && <FinishedControls snap={snap} sock={sock} />}
          {snap.status === 'FINISHED' && !me.canControl && <Notice tone="mint">모든 그림책을 다 봤어요! 방장이 다시 시작하거나 방을 닫을 때까지 잠시 기다려요.</Notice>}
        </div>
      );
    case 'CLOSED':
      return <Notice tone="coral">{snap.closedReason ?? '방이 닫혔어요.'}</Notice>;
  }
}

function WaitingView({ title, text }: { title: string; text: string }) {
  return (
    <div className="paper flex flex-col items-center bg-cream-2 p-6 text-center">
      <Illustration src="/images/mascot.webp" className="w-28 max-w-full" />
      <div className="mt-2 text-lg font-extrabold">{title}</div>
      <p className="mt-1 text-sm text-ink-2">{text}</p>
    </div>
  );
}

function RevealReadyView({ snap, sock }: { snap: RoomSnapshot; sock: import('../lib/socket').ReconnectingSocket }) {
  const { busy, run } = useAsyncAction();
  if (snap.me.canControl) {
    return (
      <div className="paper bg-violet-2 p-6 text-center">
        <div className="text-3xl">🎬</div>
        <div className="mt-2 text-lg font-extrabold">모든 작업이 끝났어요!</div>
        <p className="mt-1 text-sm text-ink-2">결과 공개를 시작하면 참가자를 골라 한 장씩 함께 볼 수 있어요.</p>
        <button className="btn btn-primary mt-4 text-lg" disabled={busy} onClick={() => run(() => sock.command({ type: 'reveal.start', gameId: snap.gameId, expectedVersion: snap.version }))}>
          결과 공개 시작
        </button>
      </div>
    );
  }
  return <WaitingView title="방장이 결과 공개를 준비하고 있어요" text={snap.host.connected ? '곧 다 같이 그림책을 볼 거예요!' : '방장의 연결이 끊겨 있어요. 방장이 돌아오거나 선생님이 진행권을 가져오면 시작돼요.'} />;
}

function FinishedControls({ snap, sock }: { snap: RoomSnapshot; sock: import('../lib/socket').ReconnectingSocket }) {
  const [confirm, setConfirm] = useState<'restart' | 'close' | null>(null);
  const { busy, run } = useAsyncAction();
  return (
    <div className="paper flex flex-wrap items-center justify-between gap-3 bg-mint-2 p-4">
      <div className="font-bold">모든 그림책을 공개했어요. 어떻게 할까요?</div>
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy} onClick={() => setConfirm('restart')}>
          다시 시작
        </button>
        <button className="btn btn-danger" disabled={busy} onClick={() => setConfirm('close')}>
          방 닫기
        </button>
      </div>
      {confirm === 'restart' && <ConfirmModal title="다시 시작" message="대기실로 돌아가 참가자를 다시 확정해요. 이번 판의 그림은 지워져요." confirmLabel="대기실로" onClose={() => setConfirm(null)} onConfirm={() => run(() => sock.command({ type: 'room.restart', expectedVersion: snap.version }))} />}
      {confirm === 'close' && <ConfirmModal title="방 닫기" message="방을 닫으면 모두 클래스 로비로 돌아가고 게임 데이터는 삭제돼요." confirmLabel="닫기" danger onClose={() => setConfirm(null)} onConfirm={() => run(() => sock.command({ type: 'room.close', confirm: true }))} />}
    </div>
  );
}

// ---------- 대기실 ----------

function LobbyView({ snap, sock, mode }: { snap: RoomSnapshot; sock: import('../lib/socket').ReconnectingSocket; mode: 'student' | 'teacher' }) {
  const me = snap.me;
  const { busy, run } = useAsyncAction();
  const [kick, setKick] = useState<{ userId: string; name: string } | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const myMember = snap.members.find((m) => m.userId === me.userId);
  const players = snap.members.filter((m) => m.isPlayer);
  const allReady = players.length >= 4 && players.every((p) => p.ready && p.connected);
  const startProblems = useMemo(() => {
    const out: string[] = [];
    if (players.length < 4) out.push(`플레이어가 ${4 - players.length}명 더 필요해요`);
    const notReady = players.filter((p) => !p.ready);
    if (notReady.length) out.push(`준비 안 함: ${notReady.map((p) => p.displayName).join(', ')}`);
    const offline = players.filter((p) => !p.connected);
    if (offline.length) out.push(`연결 끊김: ${offline.map((p) => p.displayName).join(', ')}`);
    return out;
  }, [players]);

  const update = (patch: Record<string, unknown>) => run(() => sock.command({ type: 'room.updateSettings', expectedVersion: snap.version, ...patch }));

  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[1fr_18rem] lg:gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-extrabold">
            참가자 {players.length}/{snap.capacity}명
          </h2>
          {snap.host.mode === 'observe' && snap.host.displayName && <Pill tone="coral">방장 {snap.host.displayName} 참관</Pill>}
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {snap.members.map((m) => (
            <li key={m.userId} className={`paper flex items-start gap-2 px-3 py-2 ${!m.connected ? 'opacity-60' : ''}`}>
              <span className="mt-0.5">
                <BadgeMark badge={m.badge} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">
                  {m.displayName}
                  {m.userId === me.userId && <span className="text-xs text-ink-2"> (나)</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {m.isHost && <Pill tone="violet">방장</Pill>}
                  {!m.isPlayer && <Pill tone="muted">참관</Pill>}
                  {m.isPlayer && (m.ready ? <Pill tone="mint">준비됨</Pill> : <Pill tone="muted">대기</Pill>)}
                  {!m.connected && <Pill tone="coral">끊김</Pill>}
                </div>
              </div>
              {me.canControl && m.userId !== me.userId && !m.isTeacher && (
                <button className="btn btn-ghost btn-sm shrink-0 text-[#b3261e]" onClick={() => setKick({ userId: m.userId, name: m.displayName })} aria-label={`${m.displayName} 내보내기`}>
                  내보내기
                </button>
              )}
            </li>
          ))}
        </ul>
        {myMember?.isPlayer && (
          <button className={`btn text-lg ${myMember.ready ? '' : 'btn-primary'}`} disabled={busy} onClick={() => run(() => sock.command({ type: 'room.ready', ready: !myMember.ready }))}>
            {myMember.ready ? '준비 취소' : '준비 완료!'}
          </button>
        )}
        {me.canControl && (
          <div className="paper flex flex-col gap-2 bg-violet-2 p-4">
            <button className="btn btn-primary text-lg" disabled={busy || !allReady} onClick={() => run(() => sock.command({ type: 'game.start', expectedVersion: snap.version }))}>
              게임 시작
            </button>
            {startProblems.length > 0 && (
              <ul className="text-xs text-ink-2">
                {startProblems.map((p) => (
                  <li key={p}>• {p}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!me.canControl && !me.isHost && <Notice>{snap.host.displayName ? `모두 준비되면 방장(${snap.host.displayName})이 게임을 시작해요.` : '방장이 없어요. 선생님이 진행권을 인수하거나 방장을 지정하면 시작할 수 있어요.'}</Notice>}
        {mode === 'teacher' && !me.isHost && <Notice tone="violet">선생님은 이 방을 참관 중이에요. 진행하려면 클래스 화면에서 "진행권 인수"를 눌러 주세요.</Notice>}
      </section>

      <aside className="paper flex flex-col gap-3 p-4">
        <h3 className="font-extrabold">방 설정</h3>
        <SettingRow label="방장 모드">
          {me.canControl ? (
            <select className="input" value={snap.host.mode} disabled={busy} onChange={(e) => update({ hostMode: e.target.value })}>
              <option value="observe">참관하며 진행</option>
              <option value="play">함께 참여</option>
            </select>
          ) : (
            <span>{snap.host.mode === 'observe' ? '참관하며 진행' : '함께 참여'}</span>
          )}
        </SettingRow>
        <SettingRow label="정원">
          {me.canControl ? (
            <select className="input" value={snap.capacity} disabled={busy} onChange={(e) => update({ capacity: Number(e.target.value) })}>
              {[4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                <option key={n} value={n}>
                  {n}명
                </option>
              ))}
            </select>
          ) : (
            <span>{snap.capacity}명</span>
          )}
        </SettingRow>
        <SettingRow label="제시어">
          {me.canControl ? (
            <select className="input" value={snap.settings.promptMode} disabled={busy} onChange={(e) => update({ promptMode: e.target.value })}>
              <option value="choice">후보 3개 중 선택</option>
              <option value="custom">직접 입력</option>
            </select>
          ) : (
            <span>{snap.settings.promptMode === 'choice' ? '후보 3개 중 선택' : '직접 입력'}</span>
          )}
        </SettingRow>
        <SettingRow label="그리기 시간">
          {me.canControl ? (
            <select className="input" value={snap.settings.drawSeconds} disabled={busy} onChange={(e) => update({ drawSeconds: Number(e.target.value) })}>
              {[60, 90, 120].map((n) => (
                <option key={n} value={n}>
                  {n}초
                </option>
              ))}
            </select>
          ) : (
            <span>{snap.settings.drawSeconds}초</span>
          )}
        </SettingRow>
        <SettingRow label="추측 시간">
          {me.canControl ? (
            <select className="input" value={snap.settings.guessSeconds} disabled={busy} onChange={(e) => update({ guessSeconds: Number(e.target.value) })}>
              {[30, 45, 60].map((n) => (
                <option key={n} value={n}>
                  {n}초
                </option>
              ))}
            </select>
          ) : (
            <span>{snap.settings.guessSeconds}초</span>
          )}
        </SettingRow>
        {me.canControl && <p className="text-xs text-ink-2">설정을 바꾸면 모두의 준비 상태가 초기화돼요.</p>}
        {me.canControl && (
          <button className="btn btn-danger btn-sm" onClick={() => setCloseConfirm(true)}>
            방 닫기
          </button>
        )}
      </aside>

      {kick && <ConfirmModal title="참가자 내보내기" message={`${kick.name} 을(를) 방에서 내보낼까요?`} confirmLabel="내보내기" danger onClose={() => setKick(null)} onConfirm={() => run(() => sock.command({ type: 'room.kick', userId: kick.userId }))} />}
      {closeConfirm && <ConfirmModal title="방 닫기" message="방을 닫으면 모두 클래스 로비로 돌아가요." confirmLabel="닫기" danger onClose={() => setCloseConfirm(false)} onConfirm={() => run(() => sock.command({ type: 'room.close', confirm: true }))} />}
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-bold text-ink-2">{label}</span>
      {children}
    </label>
  );
}
