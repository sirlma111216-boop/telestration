import { useCallback, useEffect, useState } from 'react';
import type { ClassSnapshot, RoomSummary } from '@shared/types';
import { noteServerTime } from '../lib/clock';
import { navigate } from '../lib/router';
import { clearStudentSession, getStudentSession, saveStudentSession } from '../lib/session';
import { useSocket } from '../lib/useSocket';
import { ConnectionBanner, Illustration, Logo, Notice, Page, PageBackdrop, Pill, RETENTION_NOTICE, TopBar, useAsyncAction, useToast } from '../components/ui';
import { CreateRoomModal } from './TeacherClass';
import { statusLabel, wsUrl } from './roomShared';

const CLASS_HELLO = { type: 'class.ping' };

export function StudentLobbyPage({ classId }: { classId: string }) {
  const toast = useToast();
  const session = getStudentSession(classId);
  const [snap, setSnap] = useState<ClassSnapshot | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const { busy, run } = useAsyncAction();

  const onMessage = useCallback(
    (m: Record<string, unknown>) => {
      if (m.type === 'class.snapshot') {
        const s = m.snapshot as ClassSnapshot;
        noteServerTime(s.serverTime);
        setSnap((prev) => (prev && prev.revision > s.revision ? prev : s));
        if (session && s.name && session.className !== s.name) saveStudentSession({ ...session, className: s.name });
      } else if (m.type === 'class.ended' || m.type === 'class.kicked') {
        setFatal(String(m.message ?? '클래스가 종료되었어요'));
        clearStudentSession(classId);
      } else if (m.type === 'error') {
        toast(String(m.message ?? '오류'), 'error');
      }
    },
    [toast, classId, session],
  );

  const { state, detail, sock } = useSocket(session ? wsUrl(`/ws/class/${classId}?token=${encodeURIComponent(session.token)}`) : null, onMessage, (code, reason) => {
    if (code === 4000 || code === 4003) {
      clearStudentSession(classId);
      setFatal(reason === 'kicked' ? '선생님이 클래스에서 내보냈어요.' : '클래스가 종료되었어요.');
    } else if (code === 4999) {
      clearStudentSession(classId);
      setFatal('클래스에 연결할 수 없어요. 클래스가 끝났거나 세션이 만료되었어요. 다시 참여해 주세요.');
    } else setFatal(reason || '연결이 종료되었어요');
  }, CLASS_HELLO);

  // 이미 방에 소속되어 있으면 방으로 이동
  useEffect(() => {
    if (snap?.me.kind === 'student' && snap.me.currentRoomId) navigate(`/room/${snap.me.currentRoomId}`, true);
  }, [snap]);

  if (!session) {
    return (
      <Page>
        <div className="py-6 text-center">
          <Logo />
        </div>
        <Notice tone="coral">이 기기에는 이 클래스의 참여 정보가 없어요. 코드와 닉네임으로 다시 참여해 주세요.</Notice>
        <button className="btn mt-4" onClick={() => navigate('/')}>
          참여 화면으로
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
        <button className="btn mt-4" onClick={() => navigate('/')}>
          처음으로
        </button>
      </Page>
    );
  }
  if (!snap) {
    return (
      <Page>
        <ConnectionBanner state={state} detail={detail} />
        <p className="py-10 text-center text-ink-2">클래스 로비를 불러오는 중…</p>
      </Page>
    );
  }

  const rooms = snap.rooms.filter((r) => r.status !== 'CLOSED');
  const me = snap.me;

  return (
    <Page>
      <PageBackdrop />
      <ConnectionBanner state={state} detail={detail} />
      <TopBar
        title={snap.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-bold text-ink">{me.nickname}</span>
            {me.hostGrant && <Pill tone="violet">방장 자격</Pill>}
            <span>· 학생 {snap.memberCount}명</span>
          </span>
        }
        right={
          me.hostGrant ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              + 방 만들기
            </button>
          ) : undefined
        }
      />
      {rooms.length === 0 ? (
        <div className="flex flex-col items-center gap-3">
          <Illustration src="/images/mascot.webp" className="w-32 max-w-full" />
          <Notice>아직 열린 게임방이 없어요. 선생님이나 방장이 방을 만들면 여기에 나타나요.</Notice>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rooms.map((r) => (
            <RoomCard key={r.roomId} r={r} busy={busy} onJoin={() => run(() => sock.current!.command({ type: 'room.join', roomId: r.roomId }).then(() => navigate(`/room/${r.roomId}`)))} />
          ))}
        </ul>
      )}
      <div className="mt-6 flex flex-col gap-3">
        <Notice>{RETENTION_NOTICE}</Notice>
        <button
          className="btn btn-ghost btn-sm self-start"
          onClick={() => {
            clearStudentSession(classId);
            navigate('/');
          }}
        >
          이 기기에서 클래스 나가기
        </button>
      </div>
      {createOpen && (
        <CreateRoomModal
          hostable={[]}
          teacherOption={false}
          onClose={() => setCreateOpen(false)}
          onCreate={async (args) => {
            const ok = await run(async () => {
              const res = (await sock.current!.command({ type: 'room.create', ...args })) as { roomId: string };
              navigate(`/room/${res.roomId}`);
            });
            if (ok) setCreateOpen(false);
          }}
        />
      )}
    </Page>
  );
}

function RoomCard({ r, busy, onJoin }: { r: RoomSummary; busy: boolean; onJoin: () => void }) {
  const full = r.playerCount >= r.capacity;
  const joinable = r.status === 'LOBBY' && !full;
  return (
    <li className="paper flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-lg font-extrabold">{r.title}</h3>
        <Pill tone={r.status === 'LOBBY' ? 'mint' : 'coral'}>{statusLabel(r.status)}</Pill>
      </div>
      <div className="text-sm text-ink-2">
        방장 {r.hostName ?? '없음'} · 플레이 {r.playerCount}/{r.capacity}명
      </div>
      {joinable ? (
        <button className="btn btn-primary" disabled={busy} onClick={onJoin}>
          참여하기
        </button>
      ) : (
        <button className="btn" disabled>
          {r.status !== 'LOBBY' ? '게임 진행 중' : '가득 참'}
        </button>
      )}
    </li>
  );
}
