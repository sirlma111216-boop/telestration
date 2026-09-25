/**
 * 리허설용 데모봇 — 교사가 혼자 게임 전체를 돌려 볼 수 있게 한다.
 *
 * ★ 가장 중요한 원칙: 봇은 **진짜 학생과 똑같은 경로**로 움직인다.
 *   - 참여: POST /api/class/join (학생 화면과 같은 API)
 *   - 방 입장: 클래스 WebSocket 으로 room.join (학생 로비와 같은 명령)
 *   - 준비·제시어·제출: 방 WebSocket 으로 room.ready / prompt.choose / entry.submit
 *   - 그리는 중에는 draft.live 와 draft.save 도 보낸다 (그림판 화면과 같은 순서)
 *   - 가짜 예술가 찾기: fa.color → room.ready → fa.roleAck → (내 차례) fa.draft → fa.commit → fa.vote → (가짜라면) fa.guess
 *
 *   주의: 봇의 비밀 카드는 이 탭(교사 브라우저)으로 내려온다. 개발자 도구로 들여다볼 수 있으므로
 *   공정해야 하는 판에는 봇을 섞지 않는다 — 봇은 리허설용이다.
 *   서버에 지름길을 만들지 않았다. 봇이 통과하는 길은 학생이 통과하는 길과 같다.
 *   따라서 봇으로 잘 돌아간다고 해서 학생 화면이 검증된 것은 아니다 —
 *   실제 브라우저 두 개로 왕복하는 검증(tests/e2e/ui.spec.ts)은 따로 있다.
 *
 * 이 파일은 교사 화면에서 버튼을 누를 때만 내려받는다(동적 import). 학생 기기는 받지 않는다.
 */
import { LIMITS, type EntryPayload, type RoomSnapshot, type Stroke } from '@shared/types';
import { FA_COLORS, FA_STROKE_WIDTH } from '@shared/fakeArtist';
import { api } from './api';
import { serverNow } from './clock';
import { ReconnectingSocket } from './socket';

const BOT_NAME_PREFIX = '봇';
/** 사람 이름처럼 보이되 봇임을 알 수 있게 접두어를 붙인다. 정리할 때 골라내기도 쉽다. */
const NICKS = ['가람', '나래', '다올', '라온', '마루', '바다', '사랑', '아라', '푸른', '하늘', '한별', '해든'];

/** 답이 갈리도록 서로 다른 추측을 섞는다 */
const GUESSES = [
  '눈사람 만들기',
  '춤추는 고양이',
  '우산 쓴 강아지',
  '하늘을 나는 빵',
  '축구하는 로봇',
  '낮잠 자는 공룡',
  '케이크 먹는 펭귄',
  '자전거 탄 문어',
  '노래하는 주전자',
  '거꾸로 매달린 사람',
  '풍선 든 코끼리',
  '스케이트 타는 오리',
];
const CUSTOM_PROMPTS = ['줄넘기하는 하마', '우주에서 라면 먹기', '눈 오는 날의 붕어빵', '춤추는 선인장'];
/** 가짜 예술가 봇의 최종 추측 — 제시어를 모르니 흔한 낱말을 아무거나 댄다 */
const FA_GUESSES = ['고양이', '사과', '자동차', '의자', '바다', '나무', '의사', '축구', '기차', '우산'];

const STORAGE_KEY = 'pr.demoBots.previous';

export interface DemoBotState {
  running: boolean;
  roomId: string | null;
  total: number;
  joined: number;
  error: string | null;
  busy: boolean;
}

interface BotSession {
  classId: string;
  studentId: string;
  token: string;
  displayName: string;
}

function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
const rnd = (min: number, max: number) => min + Math.random() * (max - min);

/** 사람이 손으로 그린 것처럼 몇 획 흘려 그린다 */
function randomDrawing(): Stroke[] {
  const strokes: Stroke[] = [];
  const count = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const points: number[] = [];
    let x = rnd(120, 680);
    let y = rnd(120, 480);
    const steps = 8 + Math.floor(Math.random() * 10);
    for (let k = 0; k < steps; k++) {
      points.push(Math.round(x), Math.round(y));
      x = Math.max(10, Math.min(LIMITS.canvasWidth - 10, x + rnd(-90, 90)));
      y = Math.max(10, Math.min(LIMITS.canvasHeight - 10, y + rnd(-90, 90)));
    }
    strokes.push({ t: 'pen', c: pick(LIMITS.colors), w: pick(LIMITS.penWidths), p: points });
  }
  return strokes;
}

/** 가짜 예술가 찾기용 한 획: 이어진 선 하나 */
function randomOneStroke(colorHex: string): Stroke {
  const points: number[] = [];
  let x = rnd(160, 640);
  let y = rnd(140, 460);
  let dir = rnd(0, Math.PI * 2);
  const steps = 10 + Math.floor(Math.random() * 20);
  for (let k = 0; k < steps; k++) {
    points.push(Math.round(x), Math.round(y));
    dir += rnd(-0.6, 0.6);
    x = Math.max(10, Math.min(LIMITS.canvasWidth - 10, x + Math.cos(dir) * 22));
    y = Math.max(10, Math.min(LIMITS.canvasHeight - 10, y + Math.sin(dir) * 22));
  }
  return { t: 'pen', c: colorHex, w: FA_STROKE_WIDTH, p: points };
}

/**
 * 클래스 WebSocket 으로 방에 들어간다. 학생 로비가 하는 일과 같다.
 * (학생은 방에 들어간 뒤 클래스 소켓을 닫고 방 소켓만 연다 — 봇도 같게 한다.)
 */
function joinRoom(session: BotSession, roomId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(`/ws/class/${session.classId}?token=${encodeURIComponent(session.token)}`));
    } catch {
      reject(new Error('연결할 수 없어요'));
      return;
    }
    const actionId = `bot-join-${Math.random().toString(36).slice(2, 8)}`;
    const timer = window.setTimeout(() => {
      ws.close();
      reject(new Error('방 입장이 늦어지고 있어요'));
    }, 12_000);
    const done = (err?: Error) => {
      window.clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 이미 닫힘 */
      }
      if (err) reject(err);
      else resolve();
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'class.ping', clientActionId: 'hello' }));
      ws.send(JSON.stringify({ type: 'room.join', roomId, clientActionId: actionId }));
    };
    ws.onmessage = (ev) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (m.type === 'ack' && m.clientActionId === actionId) {
        if (m.ok) done();
        else done(new Error(typeof m.message === 'string' ? m.message : '입장하지 못했어요'));
      }
    };
    ws.onerror = () => done(new Error('연결하지 못했어요'));
    ws.onclose = () => done(new Error('연결이 끊어졌어요'));
  });
}

class Bot {
  private sock: ReconnectingSocket | null = null;
  private acted = new Set<string>();
  private timers: number[] = [];
  /** 준비는 한 번만 누르는 일이 아니다 — 방장이 설정을 바꾸면 초기화된다 */
  private readyTimer: number | null = null;
  private colorTimer: number | null = null;
  /** 이 봇의 속도. 사람마다 다르게 둔다. */
  private pace = rnd(1.0, 1.0);
  /** 끝까지 못 하는 사람도 있어야 "언제 넘어갈까" 판단을 연습할 수 있다 */
  readonly slow: boolean;

  constructor(
    readonly session: BotSession,
    private roomId: string,
    slow: boolean,
  ) {
    this.slow = slow;
    this.pace = slow ? rnd(0.7, 0.9) : rnd(0.08, 0.35);
  }

  connect(): void {
    this.sock = new ReconnectingSocket({
      url: () => wsUrl(`/ws/room/${this.roomId}?token=${encodeURIComponent(this.session.token)}`),
      hello: { type: 'room.ping' },
      onMessage: (m) => {
        if (m.type === 'room.snapshot') this.onSnapshot(m.snapshot as RoomSnapshot);
      },
    });
  }

  /** 같은 일을 두 번 하지 않도록 열쇠를 두고, 흩어져 도착하게 지연을 준다 */
  private once(key: string, delayMs: number, fn: () => void): void {
    if (this.acted.has(key)) return;
    this.acted.add(key);
    this.timers.push(window.setTimeout(fn, Math.max(200, delayMs)));
  }

  private send(msg: Record<string, unknown>): void {
    this.sock?.command(msg).catch(() => {
      /* 단계가 이미 넘어갔거나 방이 닫힌 경우 — 조용히 넘어간다 */
    });
  }

  /**
   * 남은 시간의 일부만 쓴다.
   * 느린 봇도 제한 시간을 다 쓰지는 않는다 — 리허설이 한 사람 때문에 늘어지면
   * 흐름을 보기 어렵다. 눈에 띄게 늦되 최대 25초까지만 기다린다.
   */
  private delayWithin(deadlineAt: number | null, fallback: number): number {
    if (!deadlineAt) return fallback;
    const remaining = deadlineAt - serverNow();
    if (remaining <= 1500) return 200;
    const cap = this.slow ? 25_000 : 9_000;
    return Math.min(remaining - 1200, remaining * this.pace, cap);
  }

  private onSnapshot(s: RoomSnapshot): void {
    if (s.status === 'LOBBY') {
      // 대기실로 돌아왔다 = 새 판. 지난 판의 기록을 지워 다음 판에도 움직이게 한다.
      this.acted.clear();
      const me = s.members.find((m) => m.userId === s.me.userId);
      // 가짜 예술가 찾기: 준비 전에 펜 색부터 고른다. 다른 봇과 겹치면 서버가 거절하고, 다음 스냅샷에서 다른 색으로 다시 한다.
      const needsColor = s.gameMode === 'FAKE_ARTIST' && s.me.isPlayer && !!me && me.faColor == null;
      if (needsColor) {
        if (this.colorTimer === null) {
          this.colorTimer = window.setTimeout(() => {
            this.colorTimer = null;
            const taken = new Set(s.members.filter((m) => m.faColor != null).map((m) => m.faColor));
            const free = FA_COLORS.map((_, i) => i).filter((i) => !taken.has(i));
            if (free.length) this.send({ type: 'fa.color', colorIndex: pick(free) });
          }, rnd(300, 2000));
          this.timers.push(this.colorTimer);
        }
        return;
      }
      const needsReady = s.me.isPlayer && !!me && !me.ready;
      if (needsReady && this.readyTimer === null) {
        // 방장이 설정을 바꾸면 준비가 풀린다. 그때마다 다시 누른다.
        this.readyTimer = window.setTimeout(() => {
          this.readyTimer = null;
          this.send({ type: 'room.ready', ready: true });
        }, rnd(400, 2500));
        this.timers.push(this.readyTimer);
      } else if (!needsReady && this.readyTimer !== null) {
        window.clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      return;
    }

    if (s.gameMode === 'FAKE_ARTIST') {
      this.onFaSnapshot(s);
      return;
    }

    const ps = s.promptSelection;
    if (ps && !ps.submitted) {
      this.once(`prompt:${ps.stageId}`, this.delayWithin(s.deadlineAt, 2500), () => {
        const text = ps.mode === 'choice' && ps.candidates.length > 0 ? pick(ps.candidates) : pick(CUSTOM_PROMPTS);
        this.send({ type: 'prompt.choose', gameId: ps.gameId, stageId: ps.stageId, text });
      });
      return;
    }

    const a = s.assignment;
    if (a && !a.submitted) {
      const payload: EntryPayload = a.kind === 'drawing' ? { kind: 'drawing', strokes: randomDrawing() } : { kind: 'text', text: pick(GUESSES) };
      // 그림판 화면과 같은 순서: 그리는 중 실시간 전송 → 초안 저장 → 제출
      if (a.kind === 'drawing' && payload.kind === 'drawing') {
        this.once(`live:${a.stageId}`, rnd(600, 1800), () => {
          this.sock?.fire({ type: 'draft.live', gameId: a.gameId, stageId: a.stageId, seq: 1, reset: true, strokesAppend: payload.strokes });
        });
      }
      this.once(`draft:${a.stageId}`, this.delayWithin(s.deadlineAt, 4000) * 0.6, () => {
        this.send({ type: 'draft.save', gameId: a.gameId, stageId: a.stageId, revision: 1, payload });
      });
      this.once(`submit:${a.stageId}`, this.delayWithin(s.deadlineAt, 5000), () => {
        this.send({ type: 'entry.submit', gameId: a.gameId, stageId: a.stageId, payload });
      });
    }
  }

  private onFaSnapshot(s: RoomSnapshot): void {
    const fa = s.fa;
    if (!fa || !fa.me.isPlayer) return;
    const meId = s.me.userId;
    if (s.status === 'ROLE_REVEAL' && !fa.me.roleAcked) {
      this.once(`fa-ack:${fa.phaseId}`, rnd(800, this.slow ? 7000 : 3000), () => {
        this.send({ type: 'fa.roleAck', gameId: fa.gameId, phaseId: fa.phaseId });
      });
      return;
    }
    if (s.status === 'DRAWING' && fa.activePlayerId === meId) {
      const mine = fa.players.find((p) => p.userId === meId);
      const color = FA_COLORS[mine?.color ?? 0]!.hex;
      const stroke = randomOneStroke(color);
      const half = { ...stroke, p: stroke.p.slice(0, Math.max(2, Math.floor(stroke.p.length / 4) * 2)) };
      const commitAt = this.delayWithin(s.deadlineAt, 3000) * 0.5;
      // 그리는 화면과 같은 순서: 그리는 중 초안 → 전체 초안 → 확정
      this.once(`fa-d1:${fa.phaseId}`, commitAt * 0.4, () => {
        this.sock?.fire({ type: 'fa.draft', gameId: fa.gameId, turnId: fa.phaseId, revision: 0, stroke: half });
      });
      this.once(`fa-d2:${fa.phaseId}`, commitAt * 0.8, () => {
        this.sock?.fire({ type: 'fa.draft', gameId: fa.gameId, turnId: fa.phaseId, revision: 0, stroke });
      });
      this.once(`fa-commit:${fa.phaseId}`, commitAt, () => {
        this.send({ type: 'fa.commit', gameId: fa.gameId, turnId: fa.phaseId, revision: 0, stroke });
      });
      return;
    }
    if (s.status === 'VOTING' && !fa.me.myVote) {
      this.once(`fa-vote:${fa.phaseId}`, this.delayWithin(s.deadlineAt, 4000) * 0.6, () => {
        const others = fa.players.filter((p) => p.userId !== meId && !p.left);
        if (others.length) this.send({ type: 'fa.vote', gameId: fa.gameId, phaseId: fa.phaseId, targetId: pick(others).userId });
      });
      return;
    }
    if (s.status === 'FINAL_GUESS' && fa.me.canGuess) {
      this.once(`fa-guess:${fa.phaseId}`, rnd(2000, 6000), () => {
        this.send({ type: 'fa.guess', gameId: fa.gameId, phaseId: fa.phaseId, text: pick(FA_GUESSES) });
      });
    }
  }

  /** 방에서 나간다 (학생이 '나가기' 를 누르는 것과 같은 명령) */
  async leave(): Promise<void> {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.readyTimer = null;
    this.colorTimer = null;
    try {
      await this.sock?.command({ type: 'room.leave' }, 4000);
    } catch {
      /* 이미 닫혔을 수 있다 */
    }
    this.sock?.close();
    this.sock = null;
  }

  stopNow(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.readyTimer = null;
    this.colorTimer = null;
    this.sock?.close();
    this.sock = null;
  }
}

type Listener = (state: DemoBotState) => void;

class DemoBotManager {
  private bots: Bot[] = [];
  private listeners = new Set<Listener>();
  private state: DemoBotState = { running: false, roomId: null, total: 0, joined: 0, error: null, busy: false };

  getState(): DemoBotState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<DemoBotState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /** 정리 신호를 못 보내고 새로고침한 경우를 위해 남겨 둔다 */
  private remember(sessions: BotSession[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.map((s) => ({ classId: s.classId, studentId: s.studentId, displayName: s.displayName }))));
    } catch {
      /* 저장 불가 환경 */
    }
  }

  /** 지난번에 남은 봇 학생 목록 (교사 화면이 내보낼 때 쓴다) */
  leftovers(classId: string): { studentId: string; displayName: string }[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const rows = JSON.parse(raw) as { classId: string; studentId: string; displayName: string }[];
      return rows.filter((r) => r.classId === classId).map((r) => ({ studentId: r.studentId, displayName: r.displayName }));
    } catch {
      return [];
    }
  }

  clearLeftovers(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  async start(code: string, roomId: string, count: number): Promise<void> {
    if (this.state.busy || this.state.running) return;
    this.set({ busy: true, error: null, roomId, total: count, joined: 0 });
    const sessions: BotSession[] = [];
    try {
      const names = [...NICKS].sort(() => Math.random() - 0.5);
      for (let i = 0; i < count; i++) {
        const nickname = `${BOT_NAME_PREFIX}${names[i % names.length]}`.slice(0, LIMITS.nicknameMax);
        const joined = await api<{ classId: string; studentId: string; token: string; displayName: string }>('/api/class/join', {
          method: 'POST',
          body: JSON.stringify({ code, nickname }),
        });
        sessions.push(joined);
        this.remember(sessions);
        await joinRoom(joined, roomId);
        this.set({ joined: sessions.length });
      }
    } catch (e) {
      // 중간에 실패해도 이미 들어간 봇은 그대로 두고 알린다
      this.set({ busy: false, error: e instanceof Error ? e.message : '데모봇을 넣지 못했어요' });
      if (sessions.length > 0) this.attach(sessions, roomId);
      return;
    }
    this.attach(sessions, roomId);
    this.set({ busy: false, running: true });
  }

  private attach(sessions: BotSession[], roomId: string): void {
    // 한 명은 느리게 움직인다 — 전원이 곧바로 끝내면 "언제 넘어갈까" 판단을 연습할 수 없다
    const slowIndex = sessions.length >= 3 ? Math.floor(Math.random() * sessions.length) : -1;
    this.bots = sessions.map((s, i) => {
      const bot = new Bot(s, roomId, i === slowIndex);
      bot.connect();
      return bot;
    });
    this.set({ running: true, joined: sessions.length });
  }

  /** 방에서 내보낸다. 클래스 명단에서 지우는 것은 교사 화면이 kick 으로 마무리한다. */
  async stop(): Promise<{ studentId: string; displayName: string }[]> {
    const removed = this.bots.map((b) => ({ studentId: b.session.studentId, displayName: b.session.displayName }));
    this.set({ busy: true });
    await Promise.all(this.bots.map((b) => b.leave()));
    this.bots = [];
    this.set({ running: false, busy: false, roomId: null, total: 0, joined: 0, error: null });
    return removed;
  }

  stopNow(): void {
    for (const b of this.bots) b.stopNow();
    this.bots = [];
    this.set({ running: false, busy: false, roomId: null, total: 0, joined: 0 });
  }
}

export const demoBots = new DemoBotManager();
