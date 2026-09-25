/**
 * '가짜 예술가 찾기' 화면들.
 *
 * 이 화면들은 서버가 이 사람에게 보내 준 것만 그린다 (snap.fa). 비밀 정보(제시어·가짜·투표·최종 추측)는
 * 공개 단계 전에는 스냅샷에 아예 들어 있지 않으므로, 여기서 숨길 것도 없다.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RoomSnapshot, Stroke } from '@shared/types';
import {
  FA_CATEGORIES,
  FA_COLORS,
  FA_DISCUSSION_SECONDS,
  FA_GUESS_MAX,
  FA_GUESS_SECONDS,
  FA_OUTCOME_LABEL,
  FA_ROLE_SECONDS,
  FA_TURN_SECONDS,
  FA_VOTE_SECONDS,
  faEstimatedDrawingSeconds,
  type FaPlayerView,
  type FaView,
} from '@shared/fakeArtist';
import type { ReconnectingSocket } from '../lib/socket';
import { useCountdown } from '../lib/clock';
import { waitingMusic } from '../lib/waitingMusic';
import { SharedCanvas, type SharedCanvasHandle } from '../canvas/SharedCanvas';
import { ConfirmModal, Illustration, Notice, Pill, TimerBar, useAsyncAction, useToast } from '../components/ui';
import type { Reaction } from './RevealView';

export interface FaLiveDraft {
  gameId: string;
  turnId: string;
  playerId: string;
  revision: number;
  stroke: Stroke | null;
}

type Sock = ReconnectingSocket;

// ---------- 작은 부품 ----------

export function ColorDot({ index, size = 16 }: { index: number; size?: number }) {
  const c = FA_COLORS[index] ?? FA_COLORS[0];
  return <span aria-hidden="true" className="inline-block shrink-0 rounded-full border-2 border-white shadow-[0_0_0_1.5px_#2b2f4a]" style={{ width: size, height: size, background: c.hex }} />;
}

/** 색만으로 구분하지 않도록 번호·이름·색 이름을 함께 쓴다 */
function PlayerChip({ p, dim, suffix }: { p: FaPlayerView; dim?: boolean; suffix?: ReactNode }) {
  const color = FA_COLORS[p.color] ?? FA_COLORS[0];
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${dim ? 'opacity-50' : ''}`}>
      <ColorDot index={p.color} />
      <span className="shrink-0 text-xs font-bold text-ink-2">{p.number}</span>
      <span className="truncate font-bold">{p.displayName}</span>
      <span className="sr-only">({color.name})</span>
      {p.left && <span className="shrink-0 text-xs text-ink-2">(나감)</span>}
      {suffix}
    </span>
  );
}

function findPlayer(fa: FaView, userId: string | null | undefined): FaPlayerView | null {
  return fa.players.find((p) => p.userId === userId) ?? null;
}

function useFaDraft(fa: FaView, live: FaLiveDraft | null): Stroke | null {
  // 스냅샷의 초안과 실시간 초안 중 더 새것 (같은 턴·더 높은 revision, 같으면 점이 더 많은 쪽)
  const snapDraft = fa.draft && fa.draft.turnIndex === fa.turnIndex ? fa.draft : null;
  const liveDraft = live && live.gameId === fa.gameId && live.turnId === fa.phaseId ? live : null;
  if (!liveDraft) return snapDraft?.stroke ?? null;
  if (!snapDraft) return liveDraft.stroke;
  if (liveDraft.revision > snapDraft.revision) return liveDraft.stroke;
  if (liveDraft.revision < snapDraft.revision) return snapDraft.stroke;
  const a = liveDraft.stroke?.p.length ?? 0;
  const b = snapDraft.stroke?.p.length ?? 0;
  return a >= b ? liveDraft.stroke : snapDraft.stroke;
}

export function FaRulesHelp({ open }: { open?: boolean }) {
  return (
    <details className="paper bg-white p-3 text-sm" open={open}>
      <summary className="cursor-pointer font-extrabold">가짜 예술가 찾기 규칙 (온라인 수업용)</summary>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 leading-relaxed">
        <li>
          4~12명이 함께합니다. 한 명만 몰래 <b>가짜 예술가</b>가 되고, 나머지는 같은 제시어를 받아요. 가짜는 분류만 알아요.
        </li>
        <li>
          모두 같은 캔버스에 정해진 순서대로 <b>한 사람씩 한 획</b>만 그려요. 같은 순서로 두 바퀴 돕니다.
        </li>
        <li>
          한 획 = 펜을 대서 떼기까지 이어진 선 하나. 곡선·꺾인 선·닫힌 도형·점 하나는 괜찮고, 펜을 뗀 뒤 두 번째 선은 안 돼요. 떼고 나면 <b>확정</b>
          하거나 <b>지우고 다시 그리기</b>를 고를 수 있어요.
        </li>
        <li>다 그리면 토론한 뒤 비공개로 투표해요. 자기 자신에게는 투표할 수 없고, 한 번 확정한 표는 바꿀 수 없어요.</li>
        <li>
          <b>투표 판정</b>: 가짜가 단독 최다 득표면 발각, 다른 사람이 단독 최다거나 <b>동률이면 발각 실패</b>, 유효 투표가 하나도 없으면 <b>투표 불성립</b>(승패 없음). 재투표는 없어요. 투표하지 않으면
          기권이에요.
        </li>
        <li>
          투표가 끝나면 누구나 똑같이 20초 동안 기다리고, 그동안 가짜만 몰래 <b>최종 추측</b>을 적어요. 들켰어도 제시어를 맞히면 <b>가짜 역전 승리</b>, 틀리면 <b>예술가 팀 승리</b>. 들키지 않았다면
          추측은 재미로만 보여 주고 승패에 영향이 없어요.
        </li>
        <li>
          <b>정답 판정</b>은 서버가 해요. 유니코드 정규화(NFKC), 앞뒤·중복 공백 정리, 띄어쓰기 무시 뒤 제시어나 미리 등록한 동의어와 <b>글자가 같아야</b> 정답이에요. 비슷한 말이나 오타를 봐주는
          AI·유사도 판정은 쓰지 않아요.
        </li>
        <li>점수·순위는 없어요. 이번 판의 승패만 보여 줘요. 이 규칙은 수업용으로 바꾼 것이라 원래 보드게임과 세부 규칙이 다를 수 있어요.</li>
      </ul>
    </details>
  );
}

function MusicBar() {
  const [, bump] = useState(0);
  useEffect(() => waitingMusic.subscribe(() => bump((n) => n + 1)), []);
  const m = waitingMusic;
  if (m.state !== 'on') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button className="btn btn-sm" onClick={() => void m.enable()} aria-label="기다리는 동안 음악 켜기">
          🔈 소리 켜기
        </button>
        {m.state === 'blocked' && <span className="text-xs text-ink-2">소리를 켜지 못했어요. 다시 눌러 주세요 (게임은 그대로 진행돼요).</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button className="btn btn-sm" aria-pressed={m.prefs.muted} onClick={() => m.setMuted(!m.prefs.muted)}>
        {m.prefs.muted ? '🔇 음소거됨' : '🔊 음악 켜짐'}
      </button>
      <label className="flex items-center gap-1 text-xs">
        <span className="sr-only">음량</span>
        <input type="range" min={0} max={1} step={0.05} value={m.prefs.volume} onChange={(e) => m.setVolume(Number(e.target.value))} aria-label="음량" />
      </label>
      <button className="btn btn-ghost btn-sm" onClick={() => m.disable()}>
        끄기
      </button>
    </div>
  );
}

/** 내 비밀 카드. 옆 친구가 볼 수 있으니 가릴 수 있게 한다. */
function MyCard({ fa, big }: { fa: FaView; big?: boolean }) {
  const [hidden, setHidden] = useState(false);
  const card = fa.me.card;
  if (!card) return null;
  return (
    <div className={`paper p-3 ${card.role === 'fake' ? 'bg-coral-2' : 'bg-mint-2'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-ink-2">내 비밀 카드 · 분류: {card.categoryLabel}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => setHidden((h) => !h)} aria-pressed={hidden}>
          {hidden ? '보기' : '가리기'}
        </button>
      </div>
      {hidden ? (
        <div className="mt-1 text-sm text-ink-2">가려 두었어요</div>
      ) : card.role === 'artist' ? (
        <div className={`${big ? 'mt-2 text-4xl' : 'mt-1 text-2xl'} font-extrabold break-keep`}>{card.word}</div>
      ) : (
        <div className={`${big ? 'mt-2 text-2xl' : 'mt-1 text-lg'} font-extrabold`}>🎭 나는 가짜 예술가</div>
      )}
    </div>
  );
}

function TurnOrder({ fa }: { fa: FaView }) {
  const n = fa.players.length;
  const slot = (t: number) => fa.committed.find((c) => c.turnIndex === t);
  return (
    <ol className="flex flex-col gap-1" aria-label="그리는 순서">
      {fa.players.map((p, i) => {
        const marks = [i, i + n].map((t) => {
          const c = slot(t);
          if (c) return c.stroke ? '✓' : '—';
          if (t === fa.turnIndex) return '▶';
          return '·';
        });
        const current = fa.activePlayerId === p.userId;
        return (
          <li key={p.userId} className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-sm ${current ? 'bg-violet-2 font-extrabold' : ''}`}>
            <PlayerChip p={p} dim={p.left} suffix={!p.connected && !p.left ? <Pill tone="coral">끊김</Pill> : undefined} />
            <span className="shrink-0 font-mono text-xs tracking-widest" aria-label={`1바퀴 ${marks[0]}, 2바퀴 ${marks[1]}`}>
              {marks.join(' ')}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- 대기실 ----------

export function FaColorPicker({ snap, sock }: { snap: RoomSnapshot; sock: Sock }) {
  const { busy, run } = useAsyncAction();
  const mine = snap.members.find((m) => m.userId === snap.me.userId);
  if (!mine?.isPlayer) return null;
  const holders = new Map<number, string>();
  for (const m of snap.members) if (m.faColor != null && !m.left) holders.set(m.faColor, m.displayName);
  return (
    <div className="paper p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-extrabold">내 펜 색 고르기</h3>
        {mine.faColor == null ? <Pill tone="coral">아직 안 골랐어요</Pill> : <Pill tone="mint">{FA_COLORS[mine.faColor]!.name}</Pill>}
      </div>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4" role="radiogroup" aria-label="펜 색">
        {FA_COLORS.map((c, i) => {
          const holder = holders.get(i);
          const isMine = mine.faColor === i;
          const taken = !!holder && !isMine;
          return (
            <button
              key={c.hex}
              role="radio"
              aria-checked={isMine}
              disabled={busy || taken}
              onClick={() => run(() => sock.command({ type: 'fa.color', colorIndex: i }))}
              className={`flex min-h-11 items-center gap-1.5 rounded-xl border-2 px-2 py-1 text-left text-xs font-bold ${isMine ? 'border-ink bg-violet-2' : 'border-ink/20 bg-white'} ${taken ? 'opacity-50' : ''}`}
              aria-label={`${c.name}${taken ? ` (${holder} 사용 중)` : ''}`}
            >
              <ColorDot index={i} size={18} />
              <span className="min-w-0">
                <span className="block">{c.name}</span>
                {taken && <span className="block truncate font-normal text-ink-2">{holder}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-ink-2">같은 색은 한 명만 쓸 수 있어요. 게임이 시작되면 바꿀 수 없어요. 굵기는 모두 같아요.</p>
    </div>
  );
}

export function FaSettingsRows({ snap, busy, update, playerCount }: { snap: RoomSnapshot; busy: boolean; update: (patch: Record<string, unknown>) => void; playerCount: number }) {
  const can = snap.me.canControl;
  const s = snap.faSettings;
  const est = faEstimatedDrawingSeconds(Math.max(playerCount, 4), s.turnSeconds);
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-bold text-ink-2">분류 (제시어는 서버가 이 안에서 뽑아요)</span>
        {can ? (
          <select className="input" value={s.categoryId} disabled={busy} onChange={(e) => update({ faCategoryId: e.target.value })}>
            {FA_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        ) : (
          <span>{FA_CATEGORIES.find((c) => c.id === s.categoryId)?.label}</span>
        )}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-bold text-ink-2">한 차례 시간</span>
        {can ? (
          <select className="input" value={s.turnSeconds} disabled={busy} onChange={(e) => update({ faTurnSeconds: Number(e.target.value) })}>
            {FA_TURN_SECONDS.map((n) => (
              <option key={n} value={n}>
                {n}초
              </option>
            ))}
          </select>
        ) : (
          <span>{s.turnSeconds}초</span>
        )}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-bold text-ink-2">토론 시간</span>
        {can ? (
          <select className="input" value={s.discussionSeconds} disabled={busy} onChange={(e) => update({ faDiscussionSeconds: Number(e.target.value) })}>
            {FA_DISCUSSION_SECONDS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? '없음 (바로 투표)' : `${n}초`}
              </option>
            ))}
          </select>
        ) : (
          <span>{s.discussionSeconds === 0 ? '없음' : `${s.discussionSeconds}초`}</span>
        )}
      </label>
      <p className="rounded-lg bg-cream-2 px-3 py-2 text-xs text-ink-2">
        예상 그리기 시간: 최대 약{' '}
        <b>
          {Math.floor(est / 60)}분 {est % 60}초
        </b>{' '}
        ({Math.max(playerCount, 4)}명 × 2바퀴 × {s.turnSeconds}초). 카드 확인 {FA_ROLE_SECONDS}초, 투표 {FA_VOTE_SECONDS}초, 최종 추측 {FA_GUESS_SECONDS}초가 더해져요.
      </p>
    </>
  );
}

// ---------- 게임 진행 ----------

export function FaGame({ snap, sock, live, reactions, connected }: { snap: RoomSnapshot; sock: Sock; live: FaLiveDraft | null; reactions: Reaction[]; connected: boolean }) {
  const fa = snap.fa;
  // 기다리는 음악은 그리기 단계에서 '내 차례가 아닐 때' 만. 다른 단계로 가면 끈다.
  useEffect(() => () => waitingMusic.setWaiting(false), []);
  if (!fa) return <Notice>게임 정보를 불러오는 중이에요…</Notice>;
  switch (snap.status) {
    case 'ROLE_REVEAL':
      return <RoleReveal snap={snap} fa={fa} sock={sock} />;
    case 'DRAWING':
      return <Drawing snap={snap} fa={fa} sock={sock} live={live} connected={connected} />;
    case 'DISCUSSION':
      return <Discussion snap={snap} fa={fa} />;
    case 'VOTING':
      return <Voting snap={snap} fa={fa} sock={sock} />;
    case 'FINAL_GUESS':
      return <FinalGuess snap={snap} fa={fa} sock={sock} />;
    case 'REVEAL_READY':
      return <RevealReady snap={snap} fa={fa} sock={sock} />;
    case 'REVEALING':
    case 'FINISHED':
      return (
        <div className="flex flex-col gap-4">
          <Reveal snap={snap} fa={fa} sock={sock} reactions={reactions} connected={connected} />
          {snap.status === 'FINISHED' && snap.me.canControl && <FaFinishedControls snap={snap} sock={sock} />}
          {snap.status === 'FINISHED' && !snap.me.canControl && <Notice tone="mint">결과를 모두 공개했어요! 방장이 다시 하거나 방을 닫을 때까지 잠시 기다려요.</Notice>}
        </div>
      );
    default:
      return null;
  }
}

function PhaseHeader({ fa, title, children }: { fa: FaView; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="violet">분류: {fa.categoryLabel}</Pill>
        <h2 className="text-lg font-extrabold">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function RoleReveal({ snap, fa, sock }: { snap: RoomSnapshot; fa: FaView; sock: Sock }) {
  const left = useCountdown(snap.deadlineAt);
  const { busy, run } = useAsyncAction();
  const card = fa.me.card;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <PhaseHeader fa={fa} title="비밀 카드 확인">
        <span className="text-sm text-ink-2">
          확인 {fa.roleAckCount}/{fa.voterTotal}명
        </span>
      </PhaseHeader>
      <TimerBar secondsLeft={left} total={FA_ROLE_SECONDS} />
      {card && fa.me.isPlayer ? (
        <div className={`paper pop flex flex-col items-center gap-2 p-6 text-center ${card.role === 'fake' ? 'bg-coral-2' : 'bg-mint-2'}`}>
          <div className="text-sm font-bold text-ink-2">분류: {card.categoryLabel}</div>
          {card.role === 'artist' ? (
            <>
              <div className="text-sm text-ink-2">제시어</div>
              <div className="text-4xl font-extrabold break-keep">{card.word}</div>
              <p className="mt-2 text-sm">너무 직접적으로 그리면 가짜 예술가도 알아챌 수 있어요.</p>
            </>
          ) : (
            <>
              <div className="text-3xl">🎭</div>
              <div className="text-2xl font-extrabold">당신은 가짜 예술가입니다.</div>
              <p className="mt-2 text-sm">그림을 보며 제시어를 추측하고 들키지 않게 그려보세요.</p>
            </>
          )}
          {fa.me.roleAcked ? (
            <p className="mt-3 text-sm font-bold text-ink-2">확인했어요. 다른 친구들을 기다리는 중…</p>
          ) : (
            <button
              className="btn btn-primary mt-3 text-lg"
              disabled={busy}
              onClick={() =>
                run(() =>
                  sock.command({
                    type: 'fa.roleAck',
                    gameId: fa.gameId,
                    phaseId: fa.phaseId,
                  }),
                )
              }
            >
              확인했어요
            </button>
          )}
          <p className="text-xs text-ink-2">옆 친구가 보지 않게 조심하세요.</p>
        </div>
      ) : (
        <div className="paper flex flex-col items-center bg-cream-2 p-6 text-center">
          <Illustration src="/images/mascot.webp" className="w-24 max-w-full" />
          <div className="mt-2 font-extrabold">플레이어들이 비밀 카드를 확인하고 있어요</div>
          <p className="mt-1 text-sm text-ink-2">참관 중에는 제시어와 가짜 예술가가 결과 공개 때까지 보이지 않아요.</p>
        </div>
      )}
      <div className="paper p-3">
        <div className="mb-1 text-xs font-bold text-ink-2">그리는 순서 (두 바퀴 모두 같은 순서)</div>
        <TurnOrder fa={fa} />
      </div>
    </div>
  );
}

function Drawing({ snap, fa, sock, live, connected }: { snap: RoomSnapshot; fa: FaView; sock: Sock; live: FaLiveDraft | null; connected: boolean }) {
  const me = snap.me.userId;
  const myTurn = fa.activePlayerId === me;
  const left = useCountdown(snap.deadlineAt);
  const active = findPlayer(fa, fa.activePlayerId);
  const next = findPlayer(fa, fa.nextPlayerId);
  const othersDraft = useFaDraft(fa, live);

  // 차례를 기다리는 동안 음악, 내 차례가 되면 멈추고 알림
  useEffect(() => {
    waitingMusic.setWaiting(fa.me.isPlayer && !myTurn);
  }, [fa.me.isPlayer, myTurn]);
  // 그리기 단계가 끝나면(토론·투표로 넘어가면) 음악도 멈춘다
  useEffect(() => () => waitingMusic.setWaiting(false), []);
  useEffect(() => {
    if (!myTurn) return;
    waitingMusic.chime();
    const prev = document.title;
    document.title = '🖍️ 내 차례! · 그림 이어말하기';
    return () => {
      document.title = prev;
    };
  }, [myTurn, fa.phaseId]);

  return (
    <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[1fr_17rem] lg:gap-5">
      <div className="flex flex-col gap-3">
        <PhaseHeader fa={fa} title={`한 획씩 그리기 · ${fa.round}/2 바퀴`}>
          <span className="text-sm text-ink-2">
            {Math.min(fa.turnIndex + 1, fa.totalTurns)}/{fa.totalTurns}번째 획
          </span>
        </PhaseHeader>
        <TimerBar secondsLeft={left} total={fa.turnSeconds} />
        <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-3 py-2 text-sm ${myTurn ? 'pop bg-coral text-white' : 'bg-cream-2'}`} role="status" aria-live="polite">
          {myTurn ? <b className="text-base">🖍️ 내 차례예요! 한 획만 그려 주세요</b> : <span className="flex items-center gap-1">지금 차례: {active ? <PlayerChip p={active} /> : '—'}</span>}
          {next && (
            <span className={`flex items-center gap-1 ${myTurn ? 'text-white/90' : 'text-ink-2'}`}>
              다음: <PlayerChip p={next} />
            </span>
          )}
        </div>
        {myTurn ? (
          <MyTurn key={fa.phaseId} snap={snap} fa={fa} sock={sock} connected={connected} />
        ) : (
          <SharedCanvas committed={fa.committed} draft={othersDraft} label={`공유 캔버스. 지금 ${active?.displayName ?? ''} 님이 그리는 중`} />
        )}
      </div>
      <aside className="flex flex-col gap-3">
        <MyCard fa={fa} />
        <div className="paper p-3">
          <div className="mb-1 text-xs font-bold text-ink-2">순서 (✓ 그림 · — 건너뜀 · ▶ 지금)</div>
          <TurnOrder fa={fa} />
        </div>
        {fa.me.isPlayer && (
          <div className="paper p-3">
            <div className="mb-1 text-xs font-bold text-ink-2">기다리는 동안 음악</div>
            <MusicBar />
          </div>
        )}
      </aside>
    </div>
  );
}

function MyTurn({ snap, fa, sock, connected }: { snap: RoomSnapshot; fa: FaView; sock: Sock; connected: boolean }) {
  const me = snap.me.userId;
  const toast = useToast();
  const canvasRef = useRef<SharedCanvasHandle | null>(null);
  const player = findPlayer(fa, me)!;
  const colorHex = (FA_COLORS[player.color] ?? FA_COLORS[0]).hex;
  // 재접속: 서버에 남은 내 초안이 있으면 그대로 복원해 확정하거나 다시 그릴 수 있게 한다
  const restored = fa.draft && fa.draft.playerId === me && fa.draft.turnIndex === fa.turnIndex ? fa.draft : null;
  const [revision, setRevision] = useState(restored?.revision ?? 0);
  const [locked, setLocked] = useState(!!restored?.stroke);
  const [hasStroke, setHasStroke] = useState(!!restored?.stroke);
  const [busy, setBusy] = useState(false);
  const rev = useRef(revision);
  rev.current = revision;
  const pending = useRef<Stroke | null>(null);
  const timer = useRef<number | null>(null);

  // 그리는 중인 획은 150ms 마다 묶어서 보낸다 (내 화면에는 곧바로 그려진다)
  const flush = () => {
    timer.current = null;
    const s = pending.current;
    pending.current = null;
    if (s)
      sock.fire({
        type: 'fa.draft',
        gameId: fa.gameId,
        turnId: fa.phaseId,
        revision: rev.current,
        stroke: s,
      });
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const commit = async () => {
    const s = canvasRef.current?.getLocal();
    if (!s || busy) return;
    setBusy(true);
    try {
      await sock.command({
        type: 'fa.commit',
        gameId: fa.gameId,
        turnId: fa.phaseId,
        revision: rev.current,
        stroke: s,
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : '확정하지 못했어요', 'error');
    } finally {
      setBusy(false);
    }
  };

  const redo = async () => {
    if (busy) return;
    setBusy(true);
    const next = rev.current + 1;
    try {
      // 서버가 새 revision 을 받아들인 뒤에 다시 그리게 한다 (지우기 전의 늦은 메시지가 새 선을 덮지 못한다)
      await sock.command({
        type: 'fa.redo',
        gameId: fa.gameId,
        turnId: fa.phaseId,
        revision: next,
      });
      rev.current = next;
      setRevision(next);
      pending.current = null;
      canvasRef.current?.clearLocal();
      setLocked(false);
      setHasStroke(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : '다시 그리지 못했어요', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SharedCanvas
        ref={canvasRef}
        active
        committed={fa.committed}
        label="공유 캔버스. 내 차례예요. 한 획을 그려 주세요."
        input={{
          colorHex,
          enabled: !locked && !busy,
          initial: restored?.stroke ?? null,
          onChange: (s) => {
            pending.current = s;
            setHasStroke(true);
            if (timer.current === null) timer.current = window.setTimeout(flush, 150);
          },
          onEnd: (s) => {
            pending.current = s;
            if (timer.current !== null) window.clearTimeout(timer.current);
            flush();
            setLocked(true); // 펜을 떼면 잠근다 — 확정하거나 지우고 다시 그리기
          },
        }}
      />
      {locked ? (
        <div className="grid grid-cols-2 gap-2">
          <button className="btn" disabled={busy} onClick={redo}>
            ↺ 지우고 다시 그리기
          </button>
          <button className="btn btn-primary text-lg" disabled={busy || !hasStroke} onClick={commit}>
            이 획으로 확정
          </button>
        </div>
      ) : (
        <p className="text-center text-sm text-ink-2">
          <ColorDot index={player.color} /> {FA_COLORS[player.color]?.name} 펜으로 <b>한 번에 이어서</b> 그려요. 펜을 떼면 확정하거나 다시 그릴 수 있어요.
        </p>
      )}
      {!connected && <Notice tone="coral">연결이 끊겼어요. 다시 연결되면 그린 선을 확정할 수 있어요. 시간은 계속 흘러요.</Notice>}
    </div>
  );
}

function Discussion({ snap, fa }: { snap: RoomSnapshot; fa: FaView }) {
  const left = useCountdown(snap.deadlineAt);
  return (
    <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[1fr_17rem] lg:gap-5">
      <div className="flex flex-col gap-3">
        <PhaseHeader fa={fa} title="토론 — 어떤 획이 수상했나요?" />
        <TimerBar secondsLeft={left} total={fa.discussionSeconds || 1} />
        <SharedCanvas committed={fa.committed} label="완성된 그림" />
        <Notice>같은 교실이라면 말로 이야기해요. 원격 수업이라면 쓰고 있는 통화 도구로 이야기해요. 이 앱에는 채팅이 없어요.</Notice>
      </div>
      <aside className="flex flex-col gap-3">
        <MyCard fa={fa} />
        <div className="paper p-3">
          <TurnOrder fa={fa} />
        </div>
      </aside>
    </div>
  );
}

function Voting({ snap, fa, sock }: { snap: RoomSnapshot; fa: FaView; sock: Sock }) {
  const left = useCountdown(snap.deadlineAt);
  const [choice, setChoice] = useState<string | null>(null);
  const { busy, run } = useAsyncAction();
  const me = snap.me.userId;
  const voted = fa.me.myVote;
  const votedFor = findPlayer(fa, voted);
  return (
    <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[1fr_20rem] lg:gap-5">
      <div className="flex flex-col gap-3">
        <PhaseHeader fa={fa} title="비공개 투표 — 가짜 예술가는 누구?">
          <span className="text-sm font-bold text-ink-2" aria-live="polite">
            투표 {fa.votedCount}/{fa.voterTotal}명
          </span>
        </PhaseHeader>
        <TimerBar secondsLeft={left} total={FA_VOTE_SECONDS} />
        <SharedCanvas committed={fa.committed} label="완성된 그림" />
      </div>
      <aside className="flex flex-col gap-3">
        {fa.me.isPlayer ? (
          voted ? (
            <div className="paper bg-mint-2 p-4 text-center">
              <div className="text-sm text-ink-2">내 투표 (바꿀 수 없어요)</div>
              <div className="mt-1 flex justify-center">{votedFor && <PlayerChip p={votedFor} />}</div>
              <p className="mt-2 text-xs text-ink-2">누가 누구를 찍었는지는 공개되지 않아요.</p>
            </div>
          ) : (
            <div className="paper flex flex-col gap-2 p-3">
              <div className="font-extrabold">한 명을 골라 투표해요</div>
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="투표 후보">
                {fa.players
                  .filter((p) => p.userId !== me)
                  .map((p) => (
                    <button
                      key={p.userId}
                      role="radio"
                      aria-checked={choice === p.userId}
                      className={`btn btn-sm justify-start ${choice === p.userId ? 'btn-violet' : ''}`}
                      onClick={() => setChoice(p.userId)}
                      disabled={busy}
                    >
                      <PlayerChip p={p} />
                    </button>
                  ))}
              </div>
              <button
                className="btn btn-primary"
                disabled={!choice || busy}
                onClick={() =>
                  run(() =>
                    sock.command({
                      type: 'fa.vote',
                      gameId: fa.gameId,
                      phaseId: fa.phaseId,
                      targetId: choice,
                    }),
                  )
                }
              >
                투표 확정
              </button>
              <p className="text-xs text-ink-2">확정 전에 고른 사람은 다른 사람에게 보이지 않아요. 투표하지 않으면 기권이에요.</p>
            </div>
          )
        ) : (
          <Notice>참관 중이에요. 플레이어들이 투표하고 있어요. 득표 결과는 방장이 공개할 때 볼 수 있어요.</Notice>
        )}
        <MyCard fa={fa} />
      </aside>
    </div>
  );
}

function FinalGuess({ snap, fa, sock }: { snap: RoomSnapshot; fa: FaView; sock: Sock }) {
  const left = useCountdown(snap.deadlineAt);
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
  const { busy, run } = useAsyncAction();
  const submit = () => {
    if (!text.trim()) return;
    void run(() =>
      sock.command({
        type: 'fa.guess',
        gameId: fa.gameId,
        phaseId: fa.phaseId,
        text: text.trim(),
      }),
    );
  };
  return (
    <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[1fr_20rem] lg:gap-5">
      <div className="flex flex-col gap-3">
        <PhaseHeader fa={fa} title="최종 추측 시간" />
        {/* 모두에게 같은 20초. 가짜가 일찍 내도 줄어들지 않는다. */}
        <TimerBar secondsLeft={left} total={FA_GUESS_SECONDS} />
        <SharedCanvas committed={fa.committed} label="완성된 그림" />
      </div>
      <aside className="flex flex-col gap-3">
        {fa.me.canGuess ? (
          <form
            className="paper flex flex-col gap-2 bg-coral-2 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!composing) submit();
            }}
          >
            <div className="font-extrabold">🎭 가짜 예술가만 보는 칸이에요</div>
            <p className="text-sm">제시어가 무엇이었을까요? 들켰더라도 맞히면 역전이에요.</p>
            <input
              className="input text-lg"
              value={text}
              maxLength={FA_GUESS_MAX}
              placeholder="제시어 추측 (최대 40자)"
              onChange={(e) => setText(e.target.value.slice(0, FA_GUESS_MAX))}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onKeyDown={(e) => {
                // 한국어 조합 중 Enter 는 제출하지 않는다
                if (e.key === 'Enter' && (composing || e.nativeEvent.isComposing)) e.preventDefault();
              }}
              autoComplete="off"
              enterKeyHint="done"
              aria-label="최종 추측"
            />
            <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
              추측 확정 (바꿀 수 없어요)
            </button>
          </form>
        ) : fa.me.guessSubmitted ? (
          <div className="paper bg-coral-2 p-4 text-center">
            <div className="font-extrabold">최종 추측을 냈어요</div>
            <p className="mt-1 text-sm text-ink-2">결과 공개 때 모두에게 보여요.</p>
          </div>
        ) : (
          <div className="paper bg-cream-2 p-4 text-center">
            <div className="text-2xl">⏳</div>
            <div className="mt-1 font-extrabold">최종 추측을 기다리는 중</div>
            <p className="mt-1 text-sm text-ink-2">가짜 예술가가 제시어를 마지막으로 추측하고 있어요. 모두 같은 시간만큼 기다려요.</p>
          </div>
        )}
        <MyCard fa={fa} />
      </aside>
    </div>
  );
}

function RevealReady({ snap, fa, sock }: { snap: RoomSnapshot; fa: FaView; sock: Sock }) {
  const { busy, run } = useAsyncAction();
  return (
    <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[1fr_20rem] lg:gap-5">
      <SharedCanvas committed={fa.committed} label="완성된 그림" />
      {snap.me.canControl ? (
        <div className="paper flex flex-col items-center gap-2 bg-violet-2 p-5 text-center">
          <div className="text-3xl">🎬</div>
          <div className="font-extrabold">모든 투표와 추측이 끝났어요</div>
          <p className="text-sm text-ink-2">한 단계씩 공개해요. 방장인 나에게도 결과는 공개하는 순서대로만 보여요.</p>
          <button className="btn btn-primary text-lg" disabled={busy} onClick={() => run(() => sock.command({ type: 'fa.reveal.start', gameId: fa.gameId }))}>
            결과 공개 시작
          </button>
        </div>
      ) : (
        <div className="paper flex flex-col items-center bg-cream-2 p-5 text-center">
          <Illustration src="/images/mascot.webp" className="w-24 max-w-full" />
          <div className="mt-2 font-extrabold">방장이 결과 공개를 준비하고 있어요</div>
          {!snap.host.connected && <p className="mt-1 text-sm text-ink-2">방장의 연결이 끊겨 있어요. 방장이 돌아오거나 선생님이 진행권을 가져오면 시작돼요.</p>}
        </div>
      )}
    </div>
  );
}

const NEXT_LABEL = ['투표 결과 공개', '가짜 예술가 공개', '최종 추측 공개', '제시어 공개'];
const EMOJI: Record<Reaction['reaction'], string> = {
  lol: '😂',
  wow: '😲',
  best: '👍',
};

function Reveal({ snap, fa, sock, reactions, connected }: { snap: RoomSnapshot; fa: FaView; sock: Sock; reactions: Reaction[]; connected: boolean }) {
  const r = fa.reveal!;
  const { busy, run } = useAsyncAction();
  const [lastReaction, setLastReaction] = useState(0);
  const can = snap.me.canControl;
  const top = findPlayer(fa, r.topPlayerId);
  const fake = findPlayer(fa, r.fakeArtistId);
  const hl = findPlayer(fa, r.highlightPlayerId);
  const maxVotes = useMemo(() => Math.max(1, ...(r.votes ?? []).map((v) => v.count)), [r.votes]);
  const react = (k: Reaction['reaction']) => {
    if (Date.now() - lastReaction < 1500) return;
    setLastReaction(Date.now());
    sock.command({ type: 'reveal.reaction', gameId: fa.gameId, reaction: k }).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[1fr_22rem] lg:gap-6">
      <div className="relative flex flex-col gap-3">
        {!connected && <Notice tone="coral">연결이 끊겨 최신 화면인지 확인할 수 없어요. 연결이 복구되면 자동으로 맞춰져요.</Notice>}
        <PhaseHeader fa={fa} title={r.step >= 4 ? '결과' : '결과 공개'}>
          <Pill tone="violet">{Math.max(0, r.step)}/4단계</Pill>
        </PhaseHeader>
        <SharedCanvas committed={fa.committed} highlightPlayerId={r.highlightPlayerId} label={hl ? `${hl.displayName} 님의 획을 강조한 그림` : '완성된 그림'} />
        {hl && <div className="text-center text-sm font-bold">✨ {hl.displayName} 님이 그린 두 획을 강조하고 있어요</div>}
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          {reactions.map((x) => (
            <span key={x.id} className="float-up absolute bottom-8 text-3xl" style={{ left: `${10 + ((x.id * 37) % 80)}%` }}>
              {EMOJI[x.reaction]}
            </span>
          ))}
        </div>
        <div className="flex gap-1.5" role="group" aria-label="반응">
          {(['lol', 'wow', 'best'] as const).map((k) => (
            <button key={k} className="btn btn-sm" onClick={() => react(k)} aria-label={k === 'lol' ? 'ㅋㅋ' : k === 'wow' ? '놀람' : '최고'}>
              {EMOJI[k]} {k === 'lol' ? 'ㅋㅋ' : k === 'wow' ? '놀람' : '최고'}
            </button>
          ))}
        </div>
      </div>

      <aside className="flex flex-col gap-3">
        {r.step === 0 && <Notice>완성된 그림이에요. 방장이 한 단계씩 결과를 공개해요.</Notice>}

        {r.votes && (
          <section className="paper pop p-3" aria-label="투표 결과">
            <h3 className="mb-2 font-extrabold">1. 투표 결과</h3>
            <ul className="flex flex-col gap-1">
              {r.votes.map((v) => {
                const p = findPlayer(fa, v.playerId)!;
                return (
                  <li key={v.playerId} className="flex items-center gap-2 text-sm">
                    <span className="w-28 min-w-0 shrink-0">
                      <PlayerChip p={p} />
                    </span>
                    <span className="h-3 flex-1 overflow-hidden rounded-full bg-cream-2">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${(v.count / maxVotes) * 100}%`,
                          background: FA_COLORS[p.color]?.hex,
                        }}
                      />
                    </span>
                    <b className="w-8 text-right tabular-nums">{v.count}표</b>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-sm font-bold">
              {r.voteResult === 'single' && top && <>단독 최다 득표: {top.displayName}</>}
              {r.voteResult === 'tie' && <>최다 득표가 동률이에요 → 발각 실패</>}
              {r.voteResult === 'none' && <>유효 투표가 없어요 → 투표 불성립 (이번 판은 승패 없음)</>}
            </p>
          </section>
        )}

        {fake && (
          <section className="paper pop bg-coral-2 p-3" aria-label="가짜 예술가">
            <h3 className="mb-1 font-extrabold">2. 가짜 예술가는…</h3>
            <div className="text-lg">
              <PlayerChip p={fake} />
            </div>
            <p className="mt-1 text-sm font-bold">{r.voteResult === 'none' ? '투표가 불성립했어요' : r.caught ? '🔍 발각됐어요!' : '🙈 들키지 않았어요!'}</p>
          </section>
        )}

        {r.finalGuess && (
          <section className="paper pop p-3" aria-label="최종 추측">
            <h3 className="mb-1 font-extrabold">3. 가짜 예술가의 최종 추측</h3>
            <div className="text-xl font-extrabold">{r.finalGuess.text ?? '시간 초과 (답 없음)'}</div>
            {!r.finalGuess.affectsOutcome && <p className="mt-1 text-xs font-bold text-ink-2">이번 판 승패에는 영향 없음 (재미로 보는 추측)</p>}
          </section>
        )}

        {r.word && r.outcome && (
          <section className="paper pop bg-violet-2 p-4 text-center" aria-label="제시어와 결과">
            <h3 className="font-extrabold">4. 제시어는</h3>
            <div className="mt-1 text-4xl font-extrabold break-keep">{r.word}</div>
            {r.finalGuess && r.finalGuess.text && <p className="mt-1 text-sm">최종 추측은 {r.guessCorrect ? '⭕ 정답' : '❌ 오답'}이에요</p>}
            <div className="mt-3 rounded-xl bg-white px-3 py-2 text-lg font-extrabold">{FA_OUTCOME_LABEL[r.outcome]}</div>
          </section>
        )}

        {can && snap.status === 'REVEALING' && (
          <button
            className="btn btn-primary text-lg"
            disabled={busy}
            onClick={() =>
              run(() =>
                sock.command({
                  type: 'fa.reveal.next',
                  gameId: fa.gameId,
                  expectedStep: r.step,
                }),
              )
            }
          >
            {NEXT_LABEL[r.step] ?? '다음'} →
          </button>
        )}

        {can && snap.status === 'FINISHED' && (
          <section className="paper p-3" aria-label="획 강조">
            <h3 className="mb-1 font-extrabold">누가 어떤 획을 그렸을까?</h3>
            <p className="mb-2 text-xs text-ink-2">참가자를 누르면 모두의 화면에서 그 사람의 두 획이 강조돼요.</p>
            <div className="flex flex-col gap-1">
              {fa.players.map((p) => (
                <button
                  key={p.userId}
                  className={`btn btn-sm justify-start ${r.highlightPlayerId === p.userId ? 'btn-violet' : ''}`}
                  disabled={busy}
                  aria-pressed={r.highlightPlayerId === p.userId}
                  onClick={() =>
                    run(() =>
                      sock.command({
                        type: 'fa.highlight',
                        gameId: fa.gameId,
                        playerId: p.userId,
                        expectedRevision: r.revision,
                      }),
                    )
                  }
                >
                  <PlayerChip p={p} suffix={p.userId === r.fakeArtistId ? <span className="text-xs">🎭</span> : undefined} />
                </button>
              ))}
              <button
                className="btn btn-sm"
                disabled={busy || !r.highlightPlayerId}
                onClick={() =>
                  run(() =>
                    sock.command({
                      type: 'fa.highlight',
                      gameId: fa.gameId,
                      playerId: null,
                      expectedRevision: r.revision,
                    }),
                  )
                }
              >
                전체 그림 보기
              </button>
            </div>
          </section>
        )}
        {!can && snap.status === 'REVEALING' && <p className="text-center text-xs text-ink-2">방장이 다음 단계를 공개할 때까지 기다려요.</p>}
      </aside>
    </div>
  );
}

export function FaFinishedControls({ snap, sock }: { snap: RoomSnapshot; sock: Sock }) {
  const [confirm, setConfirm] = useState<'again' | 'mode' | 'close' | null>(null);
  const { busy, run } = useAsyncAction();
  const toast = useToast();
  const restart = (hint?: string) =>
    run(async () => {
      await sock.command({
        type: 'room.restart',
        expectedVersion: snap.version,
      });
      if (hint) toast(hint, 'info');
    });
  return (
    <div className="paper flex flex-wrap items-center justify-between gap-3 bg-mint-2 p-4">
      <div className="font-bold">이번 판이 끝났어요. 어떻게 할까요?</div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy} onClick={() => setConfirm('again')}>
          같은 모드로 다시 하기
        </button>
        <button className="btn" disabled={busy} onClick={() => setConfirm('mode')}>
          대기실에서 게임 종류 바꾸기
        </button>
        <button className="btn btn-danger" disabled={busy} onClick={() => setConfirm('close')}>
          방 닫기
        </button>
      </div>
      {confirm === 'again' && (
        <ConfirmModal
          title="같은 모드로 다시 하기"
          message="대기실로 돌아가 준비를 다시 받아요. 펜 색은 그대로 두고, 새 제시어와 새 가짜 예술가를 뽑아요."
          confirmLabel="대기실로"
          onClose={() => setConfirm(null)}
          onConfirm={() => restart()}
        />
      )}
      {confirm === 'mode' && (
        <ConfirmModal
          title="게임 종류 바꾸기"
          message="대기실로 돌아가요. 대기실의 방 설정에서 게임 종류를 바꿀 수 있어요."
          confirmLabel="대기실로"
          onClose={() => setConfirm(null)}
          onConfirm={() => restart('방 설정의 "게임 종류" 에서 바꿔 주세요')}
        />
      )}
      {confirm === 'close' && (
        <ConfirmModal
          title="방 닫기"
          message="방을 닫으면 모두 클래스 로비로 돌아가고 게임 데이터는 삭제돼요."
          confirmLabel="닫기"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => run(() => sock.command({ type: 'room.close', confirm: true }))}
        />
      )}
    </div>
  );
}
