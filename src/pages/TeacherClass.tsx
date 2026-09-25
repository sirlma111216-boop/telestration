import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { ClassMemberView, ClassSnapshot, HostMode, RoomSummary } from '@shared/types';
import { noteServerTime } from '../lib/clock';
import { navigate } from '../lib/router';
import { useSocket } from '../lib/useSocket';
import { ConfirmModal, ConnectionBanner, Modal, Notice, Page, Pill, RETENTION_NOTICE, TopBar, useAsyncAction, useToast } from '../components/ui';
import { statusLabel } from './roomShared';
import type { DemoBotState } from '../lib/demoBots';
import { FA_CATEGORIES, FA_DEFAULT_SETTINGS, FA_DISCUSSION_SECONDS, FA_TURN_SECONDS, GAME_MODE_LABEL, type FaSettings, type GameMode } from '@shared/fakeArtist';

function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

const CLASS_HELLO = { type: 'class.ping' };

export function TeacherClassPage({ classId }: { classId: string }) {
  const toast = useToast();
  const [snap, setSnap] = useState<ClassSnapshot | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; message: string; label: string; danger?: boolean; run: () => Promise<unknown> } | null>(null);
  const [bots, setBots] = useState<DemoBotState | null>(null);
  const [botRoom, setBotRoom] = useState<RoomSummary | null>(null);
  const botsRef = useRef<typeof import('../lib/demoBots').demoBots | null>(null);
  const { busy, run } = useAsyncAction();

  // 데모봇 코드는 교사가 버튼을 누를 때만 내려받는다. 학생 기기는 받지 않는다.
  const loadBots = useCallback(async () => {
    if (!botsRef.current) {
      const mod = await import('../lib/demoBots');
      botsRef.current = mod.demoBots;
      mod.demoBots.subscribe(setBots);
    }
    return botsRef.current;
  }, []);

  const onMessage = useCallback(
    (m: Record<string, unknown>) => {
      if (m.type === 'class.snapshot') {
        const s = m.snapshot as ClassSnapshot;
        noteServerTime(s.serverTime);
        setSnap((prev) => (prev && prev.revision > s.revision ? prev : s));
      } else if (m.type === 'class.ended') {
        setFatal(String(m.message ?? '클래스가 종료되었어요'));
      } else if (m.type === 'error') {
        toast(String(m.message ?? '오류'), 'error');
      }
    },
    [toast],
  );
  const { state, detail, sock } = useSocket(wsUrl(`/ws/class/${classId}?as=teacher`), onMessage, (_c, r) => setFatal(r || '연결이 종료되었어요'), CLASS_HELLO);

  const inviteUrl = useMemo(() => (snap ? `${location.origin}/join/${snap.code}` : ''), [snap]);
  useEffect(() => {
    if (!inviteUrl) return;
    QRCode.toDataURL(inviteUrl, { width: 320, margin: 1, color: { dark: '#2b2f4a', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [inviteUrl]);

  const cmd = (msg: Record<string, unknown>, ok?: string) => run(() => sock.current!.command(msg), ok);

  /** 봇을 방에서 내보낸 뒤 클래스 명단에서도 지운다 (교사의 '내보내기' 와 같은 명령) */
  const removeBots = useCallback(async () => {
    const mgr = await loadBots();
    const removed = await mgr.stop();
    const leftovers = mgr.leftovers(classId);
    const ids = new Set([...removed.map((r) => r.studentId), ...leftovers.map((r) => r.studentId)]);
    for (const studentId of ids) {
      await sock.current?.command({ type: 'class.kick', studentId }).catch(() => {
        /* 이미 나갔을 수 있다 */
      });
    }
    mgr.clearLeftovers();
  }, [classId, loadBots]);

  if (fatal) {
    return (
      <Page>
        <TopBar title="클래스 종료" />
        <Notice tone="coral">{fatal}</Notice>
        <button className="btn mt-4" onClick={() => navigate('/teacher')}>
          대시보드로
        </button>
      </Page>
    );
  }
  if (!snap) {
    return (
      <Page>
        <ConnectionBanner state={state} detail={detail} />
        <p className="py-10 text-center text-ink-2">클래스를 불러오는 중…</p>
      </Page>
    );
  }

  const openRooms = snap.rooms.filter((r) => r.status !== 'CLOSED');
  const hostable = snap.members.filter((m) => m.hostGrant && !m.currentRoomId);

  return (
    <Page wide>
      <ConnectionBanner state={state} detail={detail} />
      <TopBar
        title={snap.name}
        subtitle={
          <span>
            입장 코드 <span className="font-mono text-base font-extrabold tracking-[0.25em] text-ink">{snap.code}</span>
            {snap.locked && <Pill tone="coral">입장 잠김</Pill>}
          </span>
        }
        right={
          <>
            <button className="btn btn-sm" onClick={() => setShowQr(true)}>
              QR · 초대 링크
            </button>
            <button className="btn btn-sm" onClick={() => cmd({ type: 'class.lock', locked: !snap.locked })} disabled={busy}>
              {snap.locked ? '입장 열기' : '입장 잠그기'}
            </button>
            <button
              className="btn btn-danger btn-sm"
              onClick={() =>
                setConfirm({
                  title: '클래스 종료',
                  message: '모든 방을 닫고 학생 접속을 끊어요. 게임 데이터는 곧 삭제돼요. 정말 종료할까요?',
                  label: '종료하기',
                  danger: true,
                  run: () => sock.current!.command({ type: 'class.end', confirm: true }),
                })
              }
            >
              클래스 종료
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/teacher')}>
              ← 목록
            </button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-extrabold">
              학생 {snap.memberCount}명 <span className="text-sm font-bold text-ink-2">(접속 {snap.connectedCount}명)</span>
            </h2>
          </div>
          {snap.members.length === 0 ? (
            <Notice>아직 참여한 학생이 없어요. 코드 또는 QR 을 보여 주세요. 학생이 들어오면 여기에 바로 나타나요.</Notice>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {snap.members.map((m) => (
                <MemberRow key={m.studentId} m={m} busy={busy} onGrant={(g) => cmd({ type: 'class.grantHost', studentId: m.studentId, grant: g })} onKick={() => setConfirm({ title: '학생 내보내기', message: `${m.displayName} 학생을 클래스에서 내보낼까요? 참여 중인 방에서도 나가게 돼요.`, label: '내보내기', danger: true, run: () => sock.current!.command({ type: 'class.kick', studentId: m.studentId }) })} />
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-extrabold">게임방 {openRooms.length}개</h2>
            <button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              + 방 만들기
            </button>
          </div>
          {openRooms.length === 0 ? (
            <Notice>아직 게임방이 없어요. 직접 만들거나, 학생을 방장으로 지정하면 학생이 만들 수 있어요.</Notice>
          ) : (
            <ul className="flex flex-col gap-2">
              {openRooms.map((r) => (
                <RoomRow
                  key={r.roomId}
                  r={r}
                  members={snap.members}
                  busy={busy}
                  onVisit={() => navigate(`/teacher/room/${r.roomId}?class=${classId}`)}
                  onTakeOver={() => setConfirm({ title: '진행권 인수', message: `"${r.title}" 방의 진행권을 선생님이 가져올까요? 기존 방장은 진행 권한을 잃어요.`, label: '인수하기', run: () => sock.current!.command({ type: 'room.takeOver', roomId: r.roomId }) })}
                  onAssign={(studentId) => cmd({ type: 'room.assignHost', roomId: r.roomId, studentId }, '방장을 바꿨어요')}
                  onClose={() => setConfirm({ title: '방 강제 종료', message: `"${r.title}" 방을 닫을까요? 진행 중인 게임도 끝나고 학생들은 로비로 돌아가요.`, label: '방 닫기', danger: true, run: () => sock.current!.command({ type: 'room.forceClose', roomId: r.roomId, confirm: true }) })}
                  bots={bots}
                  onDemoBots={() => setBotRoom(r)}
                  onStopBots={() => run(removeBots, '데모봇을 내보냈어요')}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="mt-6">
        <Notice>{RETENTION_NOTICE}</Notice>
      </div>

      {showQr && (
        <Modal title="초대 링크 · QR" onClose={() => setShowQr(false)}>
          <div className="flex flex-col items-center gap-3">
            {qr ? <img src={qr} alt={`초대 QR 코드: ${inviteUrl}`} className="w-56 rounded-xl border-2 border-ink" /> : <p>QR 을 만들지 못했어요. 링크를 복사해 주세요.</p>}
            <div className="text-center text-3xl font-extrabold tracking-[0.3em]">{snap.code}</div>
            <code className="break-all rounded bg-cream-2 px-2 py-1 text-xs">{inviteUrl}</code>
            <button
              className="btn btn-mint"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(inviteUrl);
                  toast('링크를 복사했어요', 'success');
                } catch {
                  toast('복사하지 못했어요. 링크를 길게 눌러 복사해 주세요.', 'error');
                }
              }}
            >
              링크 복사
            </button>
          </div>
        </Modal>
      )}

      {createOpen && (
        <CreateRoomModal
          hostable={hostable}
          teacherOption
          onClose={() => setCreateOpen(false)}
          onCreate={async (args) => {
            const ok = await cmd({ type: 'room.create', ...args }, '방을 만들었어요');
            if (ok) setCreateOpen(false);
          }}
        />
      )}

      {botRoom && (
        <DemoBotModal
          room={botRoom}
          onClose={() => setBotRoom(null)}
          onStart={async (count) => {
            const ok = await run(async () => {
              const mgr = await loadBots();
              await mgr.start(snap.code, botRoom.roomId, count);
              const st = mgr.getState();
              if (st.error) throw new Error(st.error);
            }, '데모봇이 들어갔어요');
            if (ok) setBotRoom(null);
          }}
        />
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await run(confirm.run);
          }}
        />
      )}
    </Page>
  );
}

function MemberRow({ m, busy, onGrant, onKick }: { m: ClassMemberView; busy: boolean; onGrant: (g: boolean) => void; onKick: () => void }) {
  return (
    <li className="paper flex flex-wrap items-center gap-2 px-3 py-2">
      <span className={`inline-block h-3 w-3 rounded-full border-2 border-ink ${m.connected ? 'bg-mint' : 'bg-white'}`} aria-hidden="true" />
      <span className="sr-only">{m.connected ? '접속 중' : '접속 끊김'}</span>
      <span className="min-w-0 flex-1 truncate font-bold">{m.displayName}</span>
      {m.hostGrant && <Pill tone="violet">방장 자격</Pill>}
      {m.currentRoomTitle && (
        <Pill tone={m.roomRole === 'host-observer' ? 'coral' : 'mint'}>
          {m.currentRoomTitle} · {m.roomRole === 'host-observer' ? '참관 방장' : m.roomRole === 'host-player' ? '참여 방장' : '플레이'}
        </Pill>
      )}
      {!m.connected && <Pill tone="muted">오프라인</Pill>}
      <div className="ml-auto flex gap-1">
        <button className="btn btn-sm" disabled={busy} onClick={() => onGrant(!m.hostGrant)}>
          {m.hostGrant ? '방장 해제' : '방장 지정'}
        </button>
        <button className="btn btn-ghost btn-sm text-[#b3261e]" disabled={busy} onClick={onKick} aria-label={`${m.displayName} 내보내기`}>
          내보내기
        </button>
      </div>
    </li>
  );
}

function RoomRow({ r, members, busy, onVisit, onTakeOver, onAssign, onClose, bots, onDemoBots, onStopBots }: { r: RoomSummary; members: ClassMemberView[]; busy: boolean; onVisit: () => void; onTakeOver: () => void; onAssign: (studentId: string) => void; onClose: () => void; bots: DemoBotState | null; onDemoBots: () => void; onStopBots: () => void }) {
  const [assignOpen, setAssignOpen] = useState(false);
  const candidates = members.filter((m) => m.hostGrant && m.currentRoomId === r.roomId && m.studentId !== r.hostUserId);
  const botsHere = !!bots?.running && bots.roomId === r.roomId;
  const seatsLeft = Math.max(0, r.capacity - r.playerCount);
  const canAddBots = r.status === 'LOBBY' && seatsLeft > 0 && !bots?.running;
  return (
    <li className="paper p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-extrabold">{r.title}</span>
        <Pill tone={r.gameMode === 'FAKE_ARTIST' ? 'coral' : 'muted'}>{r.gameMode === 'FAKE_ARTIST' ? '🎭 ' : '📖 '}{GAME_MODE_LABEL[r.gameMode ?? 'TELESTRATION']}</Pill>
        <Pill tone={r.status === 'LOBBY' ? 'mint' : r.status === 'REVEALING' || r.status === 'REVEAL_READY' ? 'violet' : 'coral'}>{statusLabel(r.status)}</Pill>
        <span className="text-sm font-bold">
          {r.playerCount}/{r.capacity}명
        </span>
      </div>
      <div className="mt-1 text-sm text-ink-2">
        방장: {r.hostName ? `${r.hostName} (${r.hostMode === 'observe' ? '참관' : '참여'})` : <span className="font-bold text-coral">없음 — 진행권 인수 또는 방장 지정 필요</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button className="btn btn-mint btn-sm" onClick={onVisit}>
          방 방문·모니터링
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={onTakeOver}>
          진행권 인수
        </button>
        <button className="btn btn-sm" disabled={busy || candidates.length === 0} onClick={() => setAssignOpen((v) => !v)} title={candidates.length === 0 ? '이 방에 방장 자격을 가진 다른 학생이 없어요' : ''}>
          방장 교체
        </button>
        {botsHere ? (
          <button className="btn btn-sm" disabled={busy || bots?.busy} onClick={onStopBots}>
            🤖 데모봇 {bots?.joined}명 내보내기
          </button>
        ) : (
          <button
            className="btn btn-sm"
            disabled={busy || !canAddBots}
            onClick={onDemoBots}
            title={r.status !== 'LOBBY' ? '대기 중인 방에만 넣을 수 있어요' : seatsLeft === 0 ? '자리가 없어요' : bots?.running ? '다른 방에서 데모봇이 돌고 있어요' : '혼자 게임을 돌려 볼 수 있어요'}
          >
            🤖 데모봇 참가
          </button>
        )}
        <button className="btn btn-ghost btn-sm text-[#b3261e]" disabled={busy} onClick={onClose}>
          방 닫기
        </button>
      </div>
      {assignOpen && (
        <div className="mt-2 flex flex-wrap gap-1.5 rounded-lg bg-violet-2 p-2">
          {candidates.map((c) => (
            <button
              key={c.studentId}
              className="btn btn-sm"
              onClick={() => {
                onAssign(c.studentId);
                setAssignOpen(false);
              }}
            >
              {c.displayName} 에게
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function DemoBotModal({ room, onClose, onStart }: { room: RoomSummary; onClose: () => void; onStart: (count: number) => Promise<void> }) {
  const seatsLeft = Math.max(0, room.capacity - room.playerCount);
  const max = Math.min(seatsLeft, 12);
  const [count, setCount] = useState(Math.min(4, max));
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="데모봇 참가"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || max === 0}
            onClick={async () => {
              setBusy(true);
              try {
                await onStart(count);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '들어가는 중…' : `${count}명 넣기`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p>
          혼자서 게임을 끝까지 돌려 볼 수 있어요. 데모봇은 실제 학생과 똑같은 방법으로 들어와 준비하고, 제시어를 고르고, 그림과 추측을 제출해요.
        </p>
        <label className="flex flex-col gap-1">
          <span className="font-bold">데모봇 수 (남은 자리 {seatsLeft}명)</span>
          <select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={max === 0}>
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}명
              </option>
            ))}
          </select>
        </label>
        <Notice>
          한 명은 일부러 느리게 움직여요. "언제 다음으로 넘길까"를 연습할 수 있어요. 끝나면 <b>데모봇 내보내기</b> 를 눌러 방과 명단에서 모두 지워 주세요. 이 창을 닫거나 새로고침하면 데모봇이 멈추니, 그때는 명단에서 직접 내보내면 돼요.
        </Notice>
      </div>
    </Modal>
  );
}

export function CreateRoomModal({ hostable, teacherOption, onClose, onCreate }: { hostable: ClassMemberView[]; teacherOption: boolean; onClose: () => void; onCreate: (args: { title: string; capacity: number; hostMode: HostMode; hostStudentId?: string | null; settings: { promptMode: 'choice' | 'custom'; drawSeconds: 60 | 90 | 120; guessSeconds: 30 | 45 | 60 }; gameMode: GameMode; fa: FaSettings }) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [gameMode, setGameMode] = useState<GameMode>('TELESTRATION');
  const [fa, setFa] = useState<FaSettings>(FA_DEFAULT_SETTINGS);
  const [capacity, setCapacity] = useState(12);
  const [hostMode, setHostMode] = useState<HostMode>('observe');
  const [hostStudentId, setHostStudentId] = useState<string>('');
  const [promptMode, setPromptMode] = useState<'choice' | 'custom'>('choice');
  const [drawSeconds, setDrawSeconds] = useState<60 | 90 | 120>(90);
  const [guessSeconds, setGuessSeconds] = useState<30 | 45 | 60>(45);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="게임방 만들기"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || title.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              try {
                await onCreate({ title: title.trim(), capacity, hostMode, hostStudentId: hostStudentId || null, settings: { promptMode, drawSeconds, guessSeconds }, gameMode, fa });
              } finally {
                setBusy(false);
              }
            }}
          >
            만들기
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-1">
          <legend className="font-bold">게임 종류</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['TELESTRATION', 'FAKE_ARTIST'] as const).map((g) => (
              <label key={g} className={`flex cursor-pointer flex-col rounded-xl border-2 px-3 py-2 ${gameMode === g ? 'border-ink bg-violet-2' : 'border-ink/20'}`}>
                <span className="flex items-center gap-2 font-bold">
                  <input type="radio" name="gameMode" checked={gameMode === g} onChange={() => setGameMode(g)} />
                  {g === 'FAKE_ARTIST' ? '🎭' : '📖'} {GAME_MODE_LABEL[g]}
                </span>
                <span className="mt-0.5 text-xs text-ink-2">{g === 'FAKE_ARTIST' ? '한 캔버스에 한 획씩, 제시어를 모르는 한 명 찾기' : '그림과 추측을 번갈아 이어 가는 그림책'}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="font-bold">방 제목 (2~30자)</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 30))} placeholder="예: 1모둠" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-bold">플레이 정원</span>
          <select className="input" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))}>
            {[4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
              <option key={n} value={n}>
                {n}명
              </option>
            ))}
          </select>
        </label>
        {teacherOption && (
          <label className="flex flex-col gap-1">
            <span className="font-bold">방장</span>
            <select className="input" value={hostStudentId} onChange={(e) => setHostStudentId(e.target.value)}>
              <option value="">선생님 (직접 진행)</option>
              {hostable.map((m) => (
                <option key={m.studentId} value={m.studentId}>
                  {m.displayName} (방장 자격)
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-2">다른 방에 참여 중인 학생은 목록에 나오지 않아요.</span>
          </label>
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="font-bold">방장 모드</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="hostMode" checked={hostMode === 'observe'} onChange={() => setHostMode('observe')} /> 참관하며 진행 (그리지 않고 모니터링·공개 진행)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="hostMode" checked={hostMode === 'play'} onChange={() => setHostMode('play')} /> 함께 참여 (플레이어로 포함, 모니터링 없음)
          </label>
        </fieldset>
        {gameMode === 'FAKE_ARTIST' ? (
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold">분류</span>
              <select className="input" value={fa.categoryId} onChange={(e) => setFa({ ...fa, categoryId: e.target.value as FaSettings['categoryId'] })}>
                {FA_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold">한 차례</span>
              <select className="input" value={fa.turnSeconds} onChange={(e) => setFa({ ...fa, turnSeconds: Number(e.target.value) as FaSettings['turnSeconds'] })}>
                {FA_TURN_SECONDS.map((n) => (
                  <option key={n} value={n}>
                    {n}초
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold">토론</span>
              <select className="input" value={fa.discussionSeconds} onChange={(e) => setFa({ ...fa, discussionSeconds: Number(e.target.value) as FaSettings['discussionSeconds'] })}>
                {FA_DISCUSSION_SECONDS.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? '없음' : `${n}초`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold">제시어</span>
            <select className="input" value={promptMode} onChange={(e) => setPromptMode(e.target.value as 'choice' | 'custom')}>
              <option value="choice">후보 3개 중 선택</option>
              <option value="custom">직접 입력</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold">그리기</span>
            <select className="input" value={drawSeconds} onChange={(e) => setDrawSeconds(Number(e.target.value) as 60 | 90 | 120)}>
              {[60, 90, 120].map((n) => (
                <option key={n} value={n}>
                  {n}초
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold">추측</span>
            <select className="input" value={guessSeconds} onChange={(e) => setGuessSeconds(Number(e.target.value) as 30 | 45 | 60)}>
              {[30, 45, 60].map((n) => (
                <option key={n} value={n}>
                  {n}초
                </option>
              ))}
            </select>
          </label>
        </div>
        )}
      </div>
    </Modal>
  );
}
