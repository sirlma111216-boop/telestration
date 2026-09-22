/**
 * RoomObject — 게임방 하나당 하나의 Durable Object
 *  - 방 명단·설정·진행 상태(상태 머신), 그림책·항목·초안(SQLite), 실시간 모니터링, 공동 결과 공개
 *  - 모든 권한은 서버에서 검증한다. 학생은 방장이 보여 주는 현재 항목만 받는다.
 *
 * 상태 머신: LOBBY → PROMPT_SELECTION → PLAYING → REVEAL_READY → REVEALING → FINISHED → LOBBY, 어디서든 → CLOSED
 */
import { DurableObject } from 'cloudflare:workers';
import {
  LIMITS,
  type EntryKind,
  type EntryPayload,
  type EntryView,
  type HostMode,
  type MemberBadge,
  type MonitorPlayerView,
  type PromptMode,
  type RevealCurrentView,
  type RevealProgressBook,
  type RoomMemberView,
  type RoomSettings,
  type RoomSnapshot,
  type RoomStatus,
  type RoomSummary,
  type Stroke,
} from '@shared/types';
import type { RoomClientMessage, RoomServerMessage } from '@shared/protocol';
import { assigneeIndex, bookIndexFor, shuffle, stageCountFor, stageKind } from '@shared/assignment';
import { randomId } from '@shared/ids';
import { sanitizeText, validateCapacity, validatePayloadFor, validateRoomTitle, validateStroke, ValidationError } from '@shared/validation';
import type { Env, Identity } from '../lib/env';
import { RateLimiter } from '../lib/rate';
import { PROMPTS, pickPromptCandidates } from '../lib/prompts';
import { getAttachment, isOpen, parseMessage, safeClose, safeSend, setAttachment } from '../lib/ws';
import type { ClassObject } from './ClassObject';

export interface RoomInitParams {
  roomId: string;
  classId: string;
  className: string;
  teacherId: string;
  title: string;
  capacity: number;
  hostMode: HostMode;
  settings: RoomSettings;
  host: { userId: string; displayName: string; isTeacher: boolean };
}

interface MemberRec {
  userId: string;
  nickname: string;
  displayName: string;
  isTeacher: boolean;
  badgeNumber: number;
  ready: boolean;
  left: boolean;
  joinedAt: number;
}

interface RevealRec {
  started: boolean;
  revision: number;
  bookId: string | null;
  entryIndex: number;
  revealed: Record<string, number[]>;
}

interface GameRec {
  gameId: string;
  players: string[];
  playerNames: Record<string, string>;
  stageCount: number;
  stage: number;
  stageId: string;
  deadlineAt: number | null;
  promptMode: PromptMode;
  candidates: Record<string, string[]>;
  prompts: Record<string, string | null>;
  submitted: string[];
  skipped: string[];
  books: { bookId: string; ownerUserId: string }[];
  reveal: RevealRec;
  startedAt: number;
}

interface RoomMeta {
  roomId: string;
  classId: string;
  className: string;
  teacherId: string;
  title: string;
  capacity: number;
  hostMode: HostMode;
  settings: RoomSettings;
  host: { userId: string | null; displayName: string | null; isTeacher: boolean };
  status: RoomStatus;
  version: number;
  summaryRevision: number;
  members: MemberRec[];
  game: GameRec | null;
  closedReason: string | null;
  createdAt: number;
  lastActivityAt: number;
  purgeAt: number | null;
  nextBadge: number;
}

interface Attachment {
  connId: string;
  userId: string;
  displayName: string;
  isTeacher: boolean;
  monitoring: boolean;
  primary: boolean;
  connectedAt: number;
}

interface LiveDraft {
  stageId: string;
  seq: number;
  strokes: Stroke[];
  text: string;
  updatedAt: number;
}

interface EntryRow {
  game_id: string;
  book_id: string;
  idx: number;
  stage: number;
  author_user_id: string;
  kind: EntryKind;
  payload: string;
  timed_out: number;
  skipped: number;
  submitted_at: number;
}

const BADGE_SHAPES: MemberBadge['shape'][] = ['circle', 'square', 'triangle', 'star', 'heart', 'diamond'];
const ACTIVE_GAME: RoomStatus[] = ['PROMPT_SELECTION', 'PLAYING', 'REVEAL_READY', 'REVEALING', 'FINISHED'];
const PURGE_DELAY_MS = 30_000;
const ACK_SENT = Symbol("ack-sent");

export class RoomObject extends DurableObject<Env> {
  private meta: RoomMeta | null = null;
  private live = new Map<string, LiveDraft>();
  private msgLimiter = new RateLimiter(120, 10_000);
  private liveLimiter = new RateLimiter(150, 10_000);
  private reactionLimiter = new RateLimiter(1, 1_500);
  private lastSummaryJson = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          game_id TEXT NOT NULL, book_id TEXT NOT NULL, idx INTEGER NOT NULL, stage INTEGER NOT NULL,
          author_user_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
          timed_out INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, submitted_at INTEGER NOT NULL,
          PRIMARY KEY (game_id, book_id, idx)
        );
        CREATE TABLE IF NOT EXISTS drafts (
          game_id TEXT NOT NULL, stage_id TEXT NOT NULL, user_id TEXT NOT NULL, payload TEXT NOT NULL,
          revision INTEGER NOT NULL, saved_at INTEGER NOT NULL,
          PRIMARY KEY (game_id, stage_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL
        );
      `);
      this.meta = (await ctx.storage.get<RoomMeta>('room')) ?? null;
    });
  }

  // ---------- RPC: ClassObject 가 호출 ----------

  async init(params: RoomInitParams): Promise<RoomSummary> {
    if (this.meta) return this.summary();
    const now = Date.now();
    this.meta = {
      roomId: params.roomId,
      classId: params.classId,
      className: params.className,
      teacherId: params.teacherId,
      title: params.title,
      capacity: params.capacity,
      hostMode: params.hostMode,
      settings: params.settings,
      host: { userId: params.host.userId, displayName: params.host.displayName, isTeacher: params.host.isTeacher },
      status: 'LOBBY',
      version: 1,
      summaryRevision: 1,
      members: [],
      game: null,
      closedReason: null,
      createdAt: now,
      lastActivityAt: now,
      purgeAt: null,
      nextBadge: 1,
    };
    this.addMember({ userId: params.host.userId, nickname: params.host.displayName, displayName: params.host.displayName, isTeacher: params.host.isTeacher });
    await this.save();
    await this.scheduleAlarm();
    return this.summary();
  }

  async joinReserved(args: { reservationId: string; member: { userId: string; nickname: string; displayName: string } }): Promise<{ ok: true; summary: RoomSummary } | { ok: false; error: string; message: string; summary?: RoomSummary }> {
    const m = this.meta;
    if (!m || m.status === 'CLOSED') return { ok: false, error: 'closed', message: '닫힌 방이에요.' };
    if (m.status !== 'LOBBY') return { ok: false, error: 'in_progress', message: '게임이 진행 중인 방이에요. 다음 판을 기다려 주세요.', summary: this.summary() };
    const existing = m.members.find((x) => x.userId === args.member.userId);
    if (existing && !existing.left) return { ok: true, summary: this.summary() };
    if (this.playerCandidates().length >= m.capacity) return { ok: false, error: 'full', message: '정원이 가득 찼어요.', summary: this.summary() };
    if (existing) {
      existing.left = false;
      existing.ready = false;
      existing.displayName = args.member.displayName;
    } else {
      this.addMember({ ...args.member, isTeacher: false });
    }
    await this.commit();
    return { ok: true, summary: this.summary() };
  }

  async hasMember(userId: string): Promise<boolean> {
    const m = this.meta;
    if (!m || m.status === 'CLOSED') return false;
    return m.members.some((x) => x.userId === userId && !x.left);
  }

  async getSummary(): Promise<RoomSummary | null> {
    if (!this.meta) return null;
    return this.summary();
  }

  async removeMember(userId: string, reason: 'left' | 'kicked' | 'class-kick'): Promise<void> {
    if (!this.meta || this.meta.status === 'CLOSED') return;
    await this.leaveInternal(userId, reason);
  }

  async hostGrantRevoked(studentId: string): Promise<void> {
    const m = this.meta;
    if (!m || m.status === 'CLOSED') return;
    if (m.host.userId === studentId) {
      m.host = { userId: null, displayName: null, isTeacher: false };
      await this.commit();
    } else {
      this.broadcastAll();
    }
  }

  async setHost(args: { userId: string; displayName: string; isTeacher: boolean; byTeacher: boolean }): Promise<{ ok: true } | { ok: false; message: string }> {
    const m = this.meta;
    if (!m || m.status === 'CLOSED') return { ok: false, message: '닫힌 방이에요.' };
    if (!args.byTeacher) return { ok: false, message: '권한이 없어요.' };
    if (!args.isTeacher) {
      const member = m.members.find((x) => x.userId === args.userId && !x.left);
      if (!member) return { ok: false, message: '그 방에 참여 중인 학생만 방장으로 지정할 수 있어요.' };
      // 클래스의 최신 자격과 대조
      let granted = false;
      try {
        granted = await this.classStub().hasHostGrant(args.userId);
      } catch {
        return { ok: false, message: '자격을 확인하지 못했어요. 다시 시도해 주세요.' };
      }
      if (!granted) return { ok: false, message: '방장 자격이 없는 학생이에요.' };
    }
    const wasMember = m.members.some((x) => x.userId === args.userId && !x.left);
    const playsNow = m.status === 'LOBBY' ? wasMember : this.isPlayerInGame(args.userId);
    m.host = { userId: args.userId, displayName: args.displayName, isTeacher: args.isTeacher };
    // 새 방장이 플레이어(대기실이면 구성원, 진행 중이면 이번 판 플레이어)면 플레이 모드, 아니면 참관 모드 (대기실에서 변경 가능)
    m.hostMode = playsNow ? 'play' : 'observe';
    if (m.status === 'LOBBY') for (const x of m.members) x.ready = false;
    await this.commit();
    return { ok: true };
  }

  async forceClose(reason: string): Promise<void> {
    if (!this.meta || this.meta.status === 'CLOSED') return;
    await this.closeRoom(reason);
  }

  // ---------- WebSocket ----------

  async fetch(request: Request): Promise<Response> {
    const m = this.meta;
    if (!m || m.status === 'CLOSED') return new Response('방을 찾을 수 없어요', { status: 404 });
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const identity = JSON.parse(request.headers.get('x-identity') ?? 'null') as Identity | null;
    if (!identity) return new Response('unauthorized', { status: 401 });
    let att: Attachment;
    if (identity.kind === 'teacher') {
      if (identity.teacherId !== m.teacherId) return new Response('forbidden', { status: 403 });
      att = { connId: randomId('conn', 6), userId: `teacher:${identity.teacherId}`, displayName: identity.name, isTeacher: true, monitoring: false, primary: true, connectedAt: Date.now() };
    } else {
      if (identity.classId !== m.classId) return new Response('forbidden', { status: 403 });
      const member = m.members.find((x) => x.userId === identity.studentId && !x.left);
      if (!member) return new Response('not a member', { status: 403 });
      att = { connId: randomId('conn', 6), userId: identity.studentId, displayName: member.displayName, isTeacher: false, monitoring: false, primary: true, connectedAt: Date.now() };
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // 중복 탭: 가장 최근 연결만 조작 권한을 갖는다
    for (const other of this.openSockets(`user:${att.userId}`)) {
      const oa = getAttachment<Attachment>(other);
      if (oa && oa.primary) {
        oa.primary = false;
        setAttachment(other, oa);
        safeSend(other, { type: 'room.snapshot', snapshot: this.buildSnapshot(oa) } satisfies RoomServerMessage);
      }
    }
    this.ctx.acceptWebSocket(server, [`user:${att.userId}`, att.isTeacher ? 'teacher' : 'student']);
    setAttachment(server, att);
    safeSend(server, { type: 'room.snapshot', snapshot: this.buildSnapshot(att) } satisfies RoomServerMessage);
    this.broadcastAll(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = getAttachment<Attachment>(ws);
    if (!att) return safeClose(ws, 4001, 'no attachment');
    const msg = parseMessage(raw) as RoomClientMessage | null;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'draft.live') {
      if (!this.liveLimiter.hit(att.connId)) return;
      this.handleLive(att, msg);
      return;
    }
    if (!this.msgLimiter.hit(att.connId)) return void safeSend(ws, { type: 'error', error: 'rate_limited', message: '요청이 너무 잦아요' });
    const actionId = typeof (msg as { clientActionId?: unknown }).clientActionId === 'string' ? (msg as { clientActionId: string }).clientActionId : 'x';
    try {
      if (!this.meta || this.meta.status === 'CLOSED') throw new ValidationError('닫힌 방이에요');
      const result = await this.handle(ws, att, msg, actionId);
      if (result !== ACK_SENT) safeSend(ws, { type: 'ack', clientActionId: actionId, ok: true, result } satisfies RoomServerMessage);
    } catch (e) {
      const message = e instanceof Error ? e.message : '요청을 처리하지 못했어요';
      safeSend(ws, { type: 'ack', clientActionId: actionId, ok: false, error: e instanceof ValidationError ? 'invalid' : 'failed', message } satisfies RoomServerMessage);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = getAttachment<Attachment>(ws);
    safeClose(ws);
    if (!att) return;
    // 남은 연결 중 가장 최근 것을 주 연결로 승격
    const remaining = this.openSockets(`user:${att.userId}`).filter((w) => w !== ws);
    if (att.primary && remaining.length > 0) {
      let best: WebSocket | null = null;
      let bestAt = -1;
      for (const w of remaining) {
        const a = getAttachment<Attachment>(w);
        if (a && a.connectedAt > bestAt) {
          bestAt = a.connectedAt;
          best = w;
        }
      }
      if (best) {
        const a = getAttachment<Attachment>(best)!;
        a.primary = true;
        setAttachment(best, a);
      }
    }
    this.broadcastAll(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    safeClose(ws, 1011);
  }

  // ---------- 명령 처리 ----------

  private async handle(ws: WebSocket, att: Attachment, msg: RoomClientMessage, actionId: string): Promise<unknown> {
    const m = this.meta!;
    if (msg.type === 'room.ping') return { serverTime: Date.now() };
    if (msg.type === 'room.resync') {
      safeSend(ws, { type: 'room.snapshot', snapshot: this.buildSnapshot(att) } satisfies RoomServerMessage);
      if (att.monitoring && this.canMonitor(att)) this.sendMonitorSnapshot(ws);
      return null;
    }
    if (msg.type === 'monitor.subscribe') {
      if (msg.subscribe && !this.canMonitor(att)) {
        safeSend(ws, { type: 'monitor.denied', message: '플레이 중인 방장은 다른 사람의 작업을 볼 수 없어요.' } satisfies RoomServerMessage);
        throw new ValidationError('모니터링 권한이 없어요');
      }
      att.monitoring = !!msg.subscribe;
      setAttachment(ws, att);
      if (att.monitoring) this.sendMonitorSnapshot(ws);
      this.broadcastAll();
      return null;
    }
    if (msg.type === 'reveal.reaction') {
      if (!['lol', 'wow', 'best'].includes(msg.reaction)) throw new ValidationError('알 수 없는 반응');
      if (m.status !== 'REVEALING' && m.status !== 'FINISHED') throw new ValidationError('지금은 반응을 보낼 수 없어요');
      if (!this.reactionLimiter.hit(att.userId)) return null;
      for (const w of this.openSockets()) safeSend(w, { type: 'reveal.reaction', reaction: msg.reaction, from: att.displayName } satisfies RoomServerMessage);
      return null;
    }
    if (!att.primary) throw new ValidationError('다른 탭에서 이 방을 열고 있어요. 그 탭에서 조작해 주세요.');

    switch (msg.type) {
      case 'room.ready':
        return this.setReady(att, !!msg.ready);
      case 'room.leave':
        await this.leaveInternal(att.userId, 'left', { ws, actionId });
        return ACK_SENT;
      case 'room.updateSettings':
        return this.updateSettings(att, msg);
      case 'room.kick': {
        this.requireControl(att);
        if (m.status !== 'LOBBY') throw new ValidationError('대기실에서만 내보낼 수 있어요');
        if (msg.userId === att.userId) throw new ValidationError('자기 자신은 내보낼 수 없어요');
        const target = m.members.find((x) => x.userId === msg.userId && !x.left);
        if (!target) throw new ValidationError('참가자를 찾을 수 없어요');
        if (target.isTeacher) throw new ValidationError('선생님은 내보낼 수 없어요');
        await this.leaveInternal(msg.userId, 'kicked', { ws, actionId });
        return ACK_SENT;
      }
      case 'game.start':
        this.requireControl(att);
        await this.startGame(msg.expectedVersion);
        return null;
      case 'prompt.choose':
        return this.choosePrompt(att, msg);
      case 'draft.save':
        return this.saveDraft(att, msg);
      case 'entry.submit':
        return this.submitEntry(att, msg);
      case 'reveal.start': {
        this.requireControl(att);
        this.requireGame(msg.gameId);
        if (m.status !== 'REVEAL_READY') throw new ValidationError('아직 결과 공개를 시작할 수 없어요');
        if (msg.expectedVersion !== m.version) throw new ValidationError('화면이 최신 상태가 아니에요. 잠시 후 다시 시도해 주세요.');
        m.status = 'REVEALING';
        m.game!.reveal.started = true;
        m.game!.reveal.revision += 1;
        await this.commit();
        return null;
      }
      case 'reveal.selectBook': {
        this.requireControl(att);
        const g = this.requireGame(msg.gameId);
        this.requireRevealing();
        if (msg.expectedRevision !== g.reveal.revision) throw new ValidationError('다른 조작이 먼저 처리되었어요. 화면을 확인해 주세요.');
        if (!g.books.some((b) => b.bookId === msg.bookId)) throw new ValidationError('그림책을 찾을 수 없어요');
        g.reveal.bookId = msg.bookId;
        g.reveal.entryIndex = -1;
        g.reveal.revision += 1;
        await this.touch();
        await this.commit();
        return { revision: g.reveal.revision };
      }
      case 'reveal.step': {
        this.requireControl(att);
        const g = this.requireGame(msg.gameId);
        this.requireRevealing();
        if (msg.expectedRevision !== g.reveal.revision) throw new ValidationError('다른 조작이 먼저 처리되었어요. 화면을 확인해 주세요.');
        if (!g.reveal.bookId) throw new ValidationError('먼저 참가자를 선택해 주세요');
        const entryCount = g.stageCount + 1;
        const dir = msg.direction === -1 ? -1 : 1;
        const next = Math.max(-1, Math.min(entryCount - 1, g.reveal.entryIndex + dir));
        if (next === g.reveal.entryIndex) throw new ValidationError(dir === 1 ? '이 그림책의 마지막이에요' : '첫 페이지예요');
        g.reveal.entryIndex = next;
        if (next >= 0) {
          const list = g.reveal.revealed[g.reveal.bookId] ?? [];
          if (!list.includes(next)) list.push(next);
          g.reveal.revealed[g.reveal.bookId] = list;
        }
        g.reveal.revision += 1;
        if (m.status === 'REVEALING' && this.allRevealed(g)) m.status = 'FINISHED';
        await this.touch();
        await this.commit();
        return { revision: g.reveal.revision };
      }
      case 'room.restart': {
        this.requireControl(att);
        if (m.status !== 'FINISHED') throw new ValidationError('모든 그림책을 공개한 뒤에 다시 시작할 수 있어요');
        if (msg.expectedVersion !== m.version) throw new ValidationError('화면이 최신 상태가 아니에요');
        await this.restart();
        return null;
      }
      case 'room.close': {
        this.requireControl(att);
        if (msg.confirm !== true) throw new ValidationError('확인이 필요해요');
        if (m.status !== 'LOBBY' && m.status !== 'FINISHED') throw new ValidationError('게임이 끝난 뒤에 방을 닫을 수 있어요. 진행 중 강제 종료는 선생님께 요청하세요.');
        await this.closeRoom('방장이 방을 닫았어요.', { ws, actionId });
        return ACK_SENT;
      }
      case 'room.forceClose': {
        if (!att.isTeacher) throw new ValidationError('선생님만 강제 종료할 수 있어요');
        if (msg.confirm !== true) throw new ValidationError('확인이 필요해요');
        await this.closeRoom('선생님이 방을 닫았어요.', { ws, actionId });
        return ACK_SENT;
      }
      default:
        throw new ValidationError('알 수 없는 명령');
    }
  }

  private requireControl(att: Attachment): void {
    const m = this.meta!;
    if (!m.host.userId || m.host.userId !== att.userId) throw new ValidationError('방장만 할 수 있어요');
  }

  private requireGame(gameId: string): GameRec {
    const g = this.meta!.game;
    if (!g || g.gameId !== gameId) throw new ValidationError('이미 끝난 판의 요청이에요');
    return g;
  }

  private requireRevealing(): void {
    const s = this.meta!.status;
    if (s !== 'REVEALING' && s !== 'FINISHED') throw new ValidationError('결과 공개 중이 아니에요');
  }

  private async setReady(att: Attachment, ready: boolean): Promise<null> {
    const m = this.meta!;
    if (m.status !== 'LOBBY') throw new ValidationError('대기실에서만 준비할 수 있어요');
    const member = m.members.find((x) => x.userId === att.userId && !x.left);
    if (!member) throw new ValidationError('방의 참가자가 아니에요');
    if (!this.isCandidate(member)) throw new ValidationError('참관 방장은 준비 상태가 필요 없어요');
    member.ready = ready;
    await this.touch();
    await this.commit();
    return null;
  }

  private async updateSettings(att: Attachment, msg: Extract<RoomClientMessage, { type: 'room.updateSettings' }>): Promise<null> {
    const m = this.meta!;
    this.requireControl(att);
    if (m.status !== 'LOBBY') throw new ValidationError('대기실에서만 설정을 바꿀 수 있어요');
    if (msg.expectedVersion !== m.version) throw new ValidationError('다른 변경이 먼저 반영되었어요. 다시 시도해 주세요.');
    const next = { title: m.title, capacity: m.capacity, hostMode: m.hostMode, settings: { ...m.settings } };
    if (msg.title !== undefined) next.title = validateRoomTitle(msg.title);
    if (msg.capacity !== undefined) next.capacity = validateCapacity(msg.capacity);
    if (msg.hostMode !== undefined) {
      if (msg.hostMode !== 'play' && msg.hostMode !== 'observe') throw new ValidationError('방장 모드가 올바르지 않아요');
      next.hostMode = msg.hostMode;
    }
    if (msg.promptMode !== undefined) {
      if (msg.promptMode !== 'choice' && msg.promptMode !== 'custom') throw new ValidationError('제시어 방식이 올바르지 않아요');
      next.settings.promptMode = msg.promptMode;
    }
    if (msg.drawSeconds !== undefined) {
      if (![60, 90, 120].includes(msg.drawSeconds)) throw new ValidationError('그리기 시간이 올바르지 않아요');
      next.settings.drawSeconds = msg.drawSeconds;
    }
    if (msg.guessSeconds !== undefined) {
      if (![30, 45, 60].includes(msg.guessSeconds)) throw new ValidationError('추측 시간이 올바르지 않아요');
      next.settings.guessSeconds = msg.guessSeconds;
    }
    // 정원 검증: 방장이 플레이하면 방장도 정원에 포함
    const candidatesAfter = m.members.filter((x) => !x.left && !(x.userId === m.host.userId && next.hostMode === 'observe')).length;
    if (candidatesAfter > next.capacity) throw new ValidationError(`현재 참가자(${candidatesAfter}명)가 정원보다 많아요`);
    const changed = next.title !== m.title || next.capacity !== m.capacity || next.hostMode !== m.hostMode || JSON.stringify(next.settings) !== JSON.stringify(m.settings);
    m.title = next.title;
    m.capacity = next.capacity;
    m.hostMode = next.hostMode;
    m.settings = next.settings;
    if (changed) for (const x of m.members) x.ready = false; // 설정이 바뀌면 준비 상태 초기화
    await this.touch();
    await this.commit();
    return null;
  }

  // ---------- 명단 ----------

  private addMember(args: { userId: string; nickname: string; displayName: string; isTeacher: boolean }): MemberRec {
    const m = this.meta!;
    const rec: MemberRec = { ...args, badgeNumber: m.nextBadge++, ready: false, left: false, joinedAt: Date.now() };
    m.members.push(rec);
    return rec;
  }

  private isCandidate(x: MemberRec): boolean {
    const m = this.meta!;
    return !x.left && !(x.userId === m.host.userId && m.hostMode === 'observe');
  }

  private playerCandidates(): MemberRec[] {
    return this.meta!.members.filter((x) => this.isCandidate(x));
  }

  private isPlayerInGame(userId: string): boolean {
    const m = this.meta!;
    return !!m.game && ACTIVE_GAME.includes(m.status) && m.game.players.includes(userId);
  }

  private async leaveInternal(userId: string, reason: 'left' | 'kicked' | 'class-kick', ack?: { ws: WebSocket; actionId: string }): Promise<void> {
    const m = this.meta!;
    const member = m.members.find((x) => x.userId === userId && !x.left);
    const wasHost = m.host.userId === userId;
    if (member) {
      if (m.status === 'LOBBY' || !m.game || !m.game.players.includes(userId)) {
        m.members = m.members.filter((x) => x.userId !== userId);
      } else {
        member.left = true;
        member.ready = false;
        if (!m.game.skipped.includes(userId)) m.game.skipped.push(userId);
        this.live.delete(userId);
      }
    }
    if (wasHost && !m.host.isTeacher) m.host = { userId: null, displayName: null, isTeacher: false };
    if (member && !member.isTeacher && reason !== 'class-kick') {
      try {
        await this.classStub().memberLeftRoom(userId, m.roomId);
      } catch {
        this.enqueue('memberLeft', { studentId: userId });
      }
    }
    await this.touch();
    // 저장이 끝난 뒤에 소켓을 닫는다: 닫기 직후 저장(출력 게이트)이 이어지면 close 프레임 전달이 지연·유실될 수 있다
    await this.save();
    if (ack) safeSend(ack.ws, { type: 'ack', clientActionId: ack.actionId, ok: true, result: null } satisfies RoomServerMessage);
    for (const ws of this.ctx.getWebSockets(`user:${userId}`)) {
      if (reason !== 'left') safeSend(ws, { type: 'room.kicked', message: reason === 'kicked' ? '방장이 방에서 내보냈어요.' : '선생님이 클래스에서 내보냈어요.' } satisfies RoomServerMessage);
      safeClose(ws, 4002, reason);
    }
    await this.commit();
    // 남은 사람이 모두 제출한 상태면 단계 전환
    await this.maybeAdvance();
  }

  // ---------- 게임 진행 ----------

  private async startGame(expectedVersion: number): Promise<void> {
    const m = this.meta!;
    if (m.status !== 'LOBBY') throw new ValidationError('대기실에서만 시작할 수 있어요');
    if (expectedVersion !== m.version) throw new ValidationError('화면이 최신 상태가 아니에요. 다시 시도해 주세요.');
    const candidates = this.playerCandidates();
    if (candidates.length < LIMITS.capacityMin) throw new ValidationError(`플레이어가 ${LIMITS.capacityMin}명 이상이어야 시작할 수 있어요 (지금 ${candidates.length}명)`);
    if (candidates.length > LIMITS.capacityMax) throw new ValidationError('플레이어가 너무 많아요');
    const connected = this.connectedUserIds();
    const notReady = candidates.filter((x) => !x.ready || !connected.has(x.userId));
    if (notReady.length > 0) throw new ValidationError(`아직 준비되지 않은 참가자가 있어요: ${notReady.map((x) => x.displayName).join(', ')}`);
    const players = shuffle(candidates.map((x) => x.userId), () => this.random());
    const names: Record<string, string> = {};
    for (const c of candidates) names[c.userId] = c.displayName;
    const gameId = randomId('g');
    const promptMode = m.settings.promptMode;
    const candidatesMap: Record<string, string[]> = {};
    const used = new Set<string>();
    for (const p of players) {
      const picks = pickPromptCandidates(() => this.random(), 3, used);
      for (const c of picks) used.add(c);
      candidatesMap[p] = picks;
    }
    const prompts: Record<string, string | null> = {};
    for (const p of players) prompts[p] = null;
    m.game = {
      gameId,
      players,
      playerNames: names,
      stageCount: stageCountFor(players.length),
      stage: 0,
      stageId: randomId('st'),
      deadlineAt: Date.now() + LIMITS.promptSelectSeconds * 1000,
      promptMode,
      candidates: candidatesMap,
      prompts,
      submitted: [],
      skipped: [],
      books: players.map((p) => ({ bookId: randomId('b'), ownerUserId: p })),
      reveal: { started: false, revision: 0, bookId: null, entryIndex: -1, revealed: {} },
      startedAt: Date.now(),
    };
    m.status = 'PROMPT_SELECTION';
    this.live.clear();
    await this.touch();
    await this.commit();
  }

  private async choosePrompt(att: Attachment, msg: Extract<RoomClientMessage, { type: 'prompt.choose' }>): Promise<null> {
    const m = this.meta!;
    const g = this.requireGame(msg.gameId);
    if (m.status !== 'PROMPT_SELECTION' || g.stageId !== msg.stageId) throw new ValidationError('제시어 선택 시간이 끝났어요');
    if (!g.players.includes(att.userId) || g.skipped.includes(att.userId)) throw new ValidationError('이번 판의 플레이어가 아니에요');
    if (g.prompts[att.userId]) return null; // 중복 요청은 조용히 성공 처리
    let text: string;
    if (g.promptMode === 'choice') {
      if (!g.candidates[att.userId]?.includes(msg.text)) throw new ValidationError('후보 중에서 골라 주세요');
      text = msg.text;
    } else {
      text = sanitizeText(msg.text, LIMITS.promptMax);
      if (text.length === 0) throw new ValidationError('제시어를 입력해 주세요');
    }
    g.prompts[att.userId] = text;
    if (!g.submitted.includes(att.userId)) g.submitted.push(att.userId);
    await this.touch();
    await this.commit();
    await this.maybeAdvance();
    return null;
  }

  /** 모든 플레이어가 제출(또는 건너뜀)했으면 단계 전환. 알람과 제출이 경합해도 stageId 로 한 번만 전환된다. */
  private async maybeAdvance(): Promise<void> {
    const m = this.meta!;
    const g = m.game;
    if (!g) return;
    if (m.status !== 'PROMPT_SELECTION' && m.status !== 'PLAYING') return;
    const active = g.players.filter((p) => !g.skipped.includes(p));
    const allDone = active.every((p) => g.submitted.includes(p));
    if (allDone) await this.endStage(g.stageId);
  }

  private async endStage(stageId: string): Promise<void> {
    const m = this.meta!;
    const g = m.game;
    if (!g || g.stageId !== stageId) return; // 이미 전환됨
    if (m.status === 'PROMPT_SELECTION') {
      for (const p of g.players) {
        if (!g.prompts[p]) {
          const cands = g.candidates[p] ?? [];
          g.prompts[p] = g.promptMode === 'choice' && cands.length > 0 ? cands[Math.floor(this.random() * cands.length)]! : PROMPTS[Math.floor(this.random() * PROMPTS.length)]!;
        }
      }
      const now = Date.now();
      g.books.forEach((b) => {
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO entries (game_id, book_id, idx, stage, author_user_id, kind, payload, timed_out, skipped, submitted_at) VALUES (?, ?, 0, 0, ?, ?, ?, 0, 0, ?)',
          g.gameId, b.bookId, b.ownerUserId, 'prompt', JSON.stringify({ kind: 'text', text: g.prompts[b.ownerUserId] ?? '' } satisfies EntryPayload), now,
        );
      });
      m.status = 'PLAYING';
      await this.startStage(1);
      return;
    }
    if (m.status !== 'PLAYING') return;
    // 미제출자 자동 제출: 서버의 최신 유효 초안 → 없으면 시간 초과 항목
    const now = Date.now();
    const kind = stageKind(g.stage);
    for (const p of g.players) {
      if (g.submitted.includes(p)) continue;
      const bookIdx = bookIndexFor(g.players.length, g.players.indexOf(p), g.stage);
      const book = g.books[bookIdx]!;
      let payload: EntryPayload | null = null;
      let timedOut = 1;
      const skipped = g.skipped.includes(p) ? 1 : 0;
      if (!skipped) {
        const draftRow = this.ctx.storage.sql.exec('SELECT payload, saved_at FROM drafts WHERE game_id = ? AND stage_id = ? AND user_id = ?', g.gameId, g.stageId, p).toArray()[0] as { payload: string; saved_at: number } | undefined;
        const live = this.live.get(p);
        const liveValid = live && live.stageId === g.stageId && (kind === 'drawing' ? live.strokes.length > 0 : live.text.trim().length > 0);
        if (liveValid && (!draftRow || live.updatedAt >= draftRow.saved_at)) {
          try {
            payload = validatePayloadFor(kind, kind === 'drawing' ? { kind: 'drawing', strokes: live.strokes } : { kind: 'text', text: live.text });
          } catch {
            payload = null;
          }
        }
        if (!payload && draftRow) {
          try {
            payload = validatePayloadFor(kind, JSON.parse(draftRow.payload));
            if (payload.kind === 'drawing' ? payload.strokes.length === 0 : payload.text.length === 0) payload = null;
          } catch {
            payload = null;
          }
        }
        if (payload) timedOut = 0;
      }
      if (!payload) payload = kind === 'drawing' ? { kind: 'drawing', strokes: [] } : { kind: 'text', text: '' };
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO entries (game_id, book_id, idx, stage, author_user_id, kind, payload, timed_out, skipped, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        g.gameId, book.bookId, g.stage, g.stage, p, kind, JSON.stringify(payload), timedOut, skipped, now,
      );
      g.submitted.push(p);
    }
    if (g.stage < g.stageCount) {
      await this.startStage(g.stage + 1);
    } else {
      m.status = 'REVEAL_READY';
      g.deadlineAt = null;
      g.stageId = randomId('st');
      this.live.clear();
      this.ctx.storage.sql.exec('DELETE FROM drafts WHERE game_id = ?', g.gameId);
      await this.touch();
      await this.commit();
    }
  }

  private async startStage(stage: number): Promise<void> {
    const m = this.meta!;
    const g = m.game!;
    g.stage = stage;
    g.stageId = randomId('st');
    g.submitted = [];
    const seconds = stageKind(stage) === 'drawing' ? m.settings.drawSeconds : m.settings.guessSeconds;
    g.deadlineAt = Date.now() + seconds * 1000;
    this.live.clear();
    await this.touch();
    await this.commit();
    // 나간 사람의 작업은 자동 건너뛰기 → 남은 사람이 없으면 즉시 다음 단계
    await this.maybeAdvance();
  }

  private assignmentFor(userId: string): { bookIdx: number; bookId: string; ownerUserId: string; kind: 'drawing' | 'guess' } | null {
    const m = this.meta!;
    const g = m.game;
    if (!g || m.status !== 'PLAYING') return null;
    const pi = g.players.indexOf(userId);
    if (pi < 0) return null;
    const bookIdx = bookIndexFor(g.players.length, pi, g.stage);
    const book = g.books[bookIdx]!;
    return { bookIdx, bookId: book.bookId, ownerUserId: book.ownerUserId, kind: stageKind(g.stage) };
  }

  private async saveDraft(att: Attachment, msg: Extract<RoomClientMessage, { type: 'draft.save' }>): Promise<{ revision: number }> {
    const m = this.meta!;
    const g = this.requireGame(msg.gameId);
    if (m.status !== 'PLAYING' || g.stageId !== msg.stageId) throw new ValidationError('이 단계는 이미 끝났어요');
    const a = this.assignmentFor(att.userId);
    if (!a) throw new ValidationError('이번 단계의 담당자가 아니에요');
    if (g.submitted.includes(att.userId)) throw new ValidationError('이미 제출했어요');
    const payload = validatePayloadFor(a.kind, msg.payload);
    const revision = Number.isInteger(msg.revision) ? msg.revision : 0;
    const existing = this.ctx.storage.sql.exec('SELECT revision FROM drafts WHERE game_id = ? AND stage_id = ? AND user_id = ?', g.gameId, g.stageId, att.userId).toArray()[0] as { revision: number } | undefined;
    if (existing && existing.revision >= revision) return { revision: existing.revision };
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO drafts (game_id, stage_id, user_id, payload, revision, saved_at) VALUES (?, ?, ?, ?, ?, ?)',
      g.gameId, g.stageId, att.userId, JSON.stringify(payload), revision, Date.now(),
    );
    return { revision };
  }

  private async submitEntry(att: Attachment, msg: Extract<RoomClientMessage, { type: 'entry.submit' }>): Promise<null> {
    const m = this.meta!;
    const g = this.requireGame(msg.gameId);
    if (m.status !== 'PLAYING' || g.stageId !== msg.stageId) throw new ValidationError('이 단계는 이미 끝났어요. 제출이 반영되지 않았어요.');
    if (g.deadlineAt && Date.now() > g.deadlineAt + 1_500) {
      await this.endStage(g.stageId);
      throw new ValidationError('제한 시간이 지났어요');
    }
    const a = this.assignmentFor(att.userId);
    if (!a) throw new ValidationError('이번 단계의 담당자가 아니에요');
    if (g.submitted.includes(att.userId)) return null; // 중복 제출은 성공으로 응답 (멱등)
    const payload = validatePayloadFor(a.kind, msg.payload);
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO entries (game_id, book_id, idx, stage, author_user_id, kind, payload, timed_out, skipped, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)',
      g.gameId, a.bookId, g.stage, g.stage, att.userId, a.kind, JSON.stringify(payload), Date.now(),
    );
    this.ctx.storage.sql.exec('DELETE FROM drafts WHERE game_id = ? AND stage_id = ? AND user_id = ?', g.gameId, g.stageId, att.userId);
    g.submitted.push(att.userId);
    this.live.delete(att.userId);
    await this.touch();
    await this.commit(); // 영구 저장 후 ACK
    await this.maybeAdvance();
    return null;
  }

  private handleLive(att: Attachment, msg: Extract<RoomClientMessage, { type: 'draft.live' }>): void {
    const m = this.meta;
    if (!m || !m.game || m.status !== 'PLAYING') return;
    const g = m.game;
    if (msg.gameId !== g.gameId || msg.stageId !== g.stageId) return;
    if (!att.primary || g.submitted.includes(att.userId)) return;
    const a = this.assignmentFor(att.userId);
    if (!a) return;
    let cur = this.live.get(att.userId);
    if (!cur || cur.stageId !== g.stageId) {
      cur = { stageId: g.stageId, seq: 0, strokes: [], text: '', updatedAt: 0 };
      this.live.set(att.userId, cur);
    }
    const seq = typeof msg.seq === 'number' && Number.isFinite(msg.seq) ? msg.seq : cur.seq + 1;
    const out: Extract<RoomServerMessage, { type: 'monitor.update' }> = { type: 'monitor.update', gameId: g.gameId, stageId: g.stageId, userId: att.userId, seq, updatedAt: Date.now() };
    if (a.kind === 'drawing') {
      if (msg.reset) {
        cur.strokes = [];
        out.reset = true;
      }
      if (Array.isArray(msg.strokesAppend)) {
        const appended: Stroke[] = [];
        for (const s of msg.strokesAppend.slice(0, 50)) {
          try {
            appended.push(validateStroke(s));
          } catch {
            /* 잘못된 획은 무시 */
          }
        }
        if (cur.strokes.length + appended.length > LIMITS.strokeMax) return;
        cur.strokes.push(...appended);
        out.strokesAppend = appended;
      }
    } else if (typeof msg.text === 'string') {
      try {
        cur.text = sanitizeText(msg.text, LIMITS.guessMax);
      } catch {
        return;
      }
      out.text = cur.text;
    }
    cur.seq = seq;
    cur.updatedAt = out.updatedAt;
    for (const ws of this.openSockets()) {
      const oa = getAttachment<Attachment>(ws);
      if (oa && oa.monitoring && this.canMonitor(oa)) safeSend(ws, out);
    }
  }

  private allRevealed(g: GameRec): boolean {
    const entryCount = g.stageCount + 1;
    return g.books.every((b) => (g.reveal.revealed[b.bookId] ?? []).length >= entryCount);
  }

  private async restart(): Promise<void> {
    const m = this.meta!;
    const old = m.game;
    m.members = m.members.filter((x) => !x.left);
    for (const x of m.members) x.ready = false;
    m.game = null;
    m.status = 'LOBBY';
    this.live.clear();
    if (old) {
      this.ctx.storage.sql.exec('DELETE FROM entries WHERE game_id = ?', old.gameId);
      this.ctx.storage.sql.exec('DELETE FROM drafts WHERE game_id = ?', old.gameId);
    }
    await this.touch();
    await this.commit();
  }

  private async closeRoom(reason: string, ack?: { ws: WebSocket; actionId: string }): Promise<void> {
    const m = this.meta!;
    m.status = 'CLOSED';
    m.closedReason = reason;
    m.purgeAt = Date.now() + PURGE_DELAY_MS;
    m.version += 1;
    m.summaryRevision += 1;
    await this.save();
    if (ack) safeSend(ack.ws, { type: 'ack', clientActionId: ack.actionId, ok: true, result: null } satisfies RoomServerMessage);
    for (const ws of this.ctx.getWebSockets()) {
      safeSend(ws, { type: 'room.closed', message: reason } satisfies RoomServerMessage);
      safeClose(ws, 4000, 'closed');
    }
    this.enqueue('summary', this.summary());
    await this.processOutbox();
    await this.scheduleAlarm();
  }

  // ---------- 알람 ----------

  async alarm(): Promise<void> {
    const m = this.meta;
    if (!m) return;
    const now = Date.now();
    if (m.status === 'CLOSED') {
      await this.processOutbox();
      const remaining = this.ctx.storage.sql.exec('SELECT COUNT(*) AS c FROM outbox').one().c as number;
      if (m.purgeAt && now >= m.purgeAt && remaining === 0) {
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
        this.meta = null;
        return;
      }
      await this.scheduleAlarm();
      return;
    }
    if (m.game && m.game.deadlineAt && now >= m.game.deadlineAt && (m.status === 'PROMPT_SELECTION' || m.status === 'PLAYING')) {
      await this.endStage(m.game.stageId);
    }
    await this.processOutbox();
    if (now >= m.lastActivityAt + LIMITS.dataTtlMs) {
      await this.closeRoom('24시간 동안 활동이 없어 방이 자동으로 닫혔어요.');
      return;
    }
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const m = this.meta;
    if (!m) return;
    const now = Date.now();
    let next = m.lastActivityAt + LIMITS.dataTtlMs;
    if (m.status === 'CLOSED' && m.purgeAt) next = Math.min(next, m.purgeAt);
    if (m.game?.deadlineAt && (m.status === 'PROMPT_SELECTION' || m.status === 'PLAYING')) next = Math.min(next, m.game.deadlineAt);
    const out = this.ctx.storage.sql.exec('SELECT MIN(next_at) AS t FROM outbox').one().t as number | null;
    if (out) next = Math.min(next, out);
    await this.ctx.storage.setAlarm(Math.max(now + 250, next));
  }

  // ---------- outbox (ClassObject 통지) ----------

  private enqueue(kind: 'summary' | 'memberLeft', payload: unknown): void {
    if (kind === 'summary') {
      const json = JSON.stringify(payload);
      if (json === this.lastSummaryJson) return;
      this.lastSummaryJson = json;
      // 이전 요약 통지는 최신 것으로 대체
      this.ctx.storage.sql.exec("DELETE FROM outbox WHERE kind = 'summary'");
    }
    this.ctx.storage.sql.exec('INSERT INTO outbox (kind, payload, attempts, next_at) VALUES (?, ?, 0, ?)', kind, JSON.stringify(payload), Date.now());
  }

  private async processOutbox(): Promise<void> {
    const now = Date.now();
    const jobs = this.ctx.storage.sql.exec('SELECT * FROM outbox WHERE next_at <= ? ORDER BY id LIMIT 20', now).toArray() as unknown as { id: number; kind: string; payload: string; attempts: number }[];
    for (const job of jobs) {
      try {
        const cls = this.classStub();
        const payload = JSON.parse(job.payload) as Record<string, unknown>;
        if (job.kind === 'summary') await cls.roomSummaryUpdated(payload as unknown as RoomSummary);
        else if (job.kind === 'memberLeft') await cls.memberLeftRoom(String(payload.studentId), this.meta!.roomId);
        this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id = ?', job.id);
      } catch {
        const attempts = job.attempts + 1;
        if (attempts >= 12) this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id = ?', job.id);
        else this.ctx.storage.sql.exec('UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?', attempts, now + Math.min(60_000, 1_000 * 2 ** attempts), job.id);
      }
    }
  }

  // ---------- 저장 · 방송 ----------

  private summary(): RoomSummary {
    const m = this.meta!;
    const playerCount = m.game && ACTIVE_GAME.includes(m.status) ? m.game.players.length : this.playerCandidates().length;
    return {
      roomId: m.roomId,
      title: m.title,
      hostUserId: m.host.userId,
      hostName: m.host.displayName,
      hostMode: m.hostMode,
      playerCount,
      capacity: m.capacity,
      status: m.status,
      revision: m.summaryRevision,
      updatedAt: m.lastActivityAt,
      connectedUserIds: [...this.connectedUserIds()],
    };
  }

  private async save(): Promise<void> {
    if (this.meta) await this.ctx.storage.put('room', this.meta);
  }

  private async touch(): Promise<void> {
    if (this.meta) this.meta.lastActivityAt = Date.now();
  }

  /** 버전 증가 → 저장 → 전원에게 스냅샷 → 클래스에 요약 통지 → 알람 재예약 */
  private async commit(): Promise<void> {
    const m = this.meta!;
    m.version += 1;
    m.summaryRevision += 1;
    await this.save();
    this.broadcastAll();
    this.enqueue('summary', this.summary());
    await this.processOutbox();
    await this.scheduleAlarm();
  }

  private openSockets(tag?: string): WebSocket[] {
    return (tag ? this.ctx.getWebSockets(tag) : this.ctx.getWebSockets()).filter(isOpen);
  }

  private connectedUserIds(): Set<string> {
    const set = new Set<string>();
    for (const ws of this.openSockets()) {
      const a = getAttachment<Attachment>(ws);
      if (a) set.add(a.userId);
    }
    return set;
  }

  private canMonitor(att: Attachment): boolean {
    const m = this.meta!;
    if (this.isPlayerInGame(att.userId)) return false; // 플레이 중이면 누구도 모니터링 불가
    if (att.isTeacher) return att.userId === `teacher:${m.teacherId}`;
    // 학생 방장은 '참관하며 진행' 모드일 때만 모니터링할 수 있다
    return m.host.userId === att.userId && m.hostMode === 'observe';
  }

  private broadcastAll(except?: WebSocket): void {
    for (const ws of this.openSockets()) {
      if (ws === except) continue;
      const a = getAttachment<Attachment>(ws);
      if (!a) continue;
      safeSend(ws, { type: 'room.snapshot', snapshot: this.buildSnapshot(a) } satisfies RoomServerMessage);
      if (a.monitoring && this.canMonitor(a)) this.sendMonitorSnapshot(ws);
    }
  }

  private random(): number {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0]! / 4294967296;
  }

  private classStub(): DurableObjectStub<ClassObject> {
    return this.env.CLASSES.get(this.env.CLASSES.idFromName(this.meta!.classId));
  }

  // ---------- 조회 ----------

  private entryRow(gameId: string, bookId: string, idx: number): EntryRow | null {
    return (this.ctx.storage.sql.exec('SELECT * FROM entries WHERE game_id = ? AND book_id = ? AND idx = ?', gameId, bookId, idx).toArray()[0] as unknown as EntryRow | undefined) ?? null;
  }

  private entryView(row: EntryRow): EntryView {
    const g = this.meta!.game!;
    return {
      index: row.idx,
      stage: row.stage,
      kind: row.kind,
      authorUserId: row.author_user_id,
      authorName: g.playerNames[row.author_user_id] ?? '?',
      payload: JSON.parse(row.payload) as EntryPayload,
      timedOut: !!row.timed_out,
      skipped: !!row.skipped,
    };
  }

  private badgeFor(x: MemberRec): MemberBadge {
    const i = (x.badgeNumber - 1) % LIMITS.colors.length;
    return { color: LIMITS.colors[i]!, shape: BADGE_SHAPES[(x.badgeNumber - 1) % BADGE_SHAPES.length]!, number: x.badgeNumber };
  }

  private revealView(forControl: boolean): { current: RevealCurrentView | null; books: RevealProgressBook[] | null } {
    const m = this.meta!;
    const g = m.game;
    if (!g || (m.status !== 'REVEALING' && m.status !== 'FINISHED')) return { current: null, books: null };
    const entryCount = g.stageCount + 1;
    const r = g.reveal;
    let entry: EntryView | null = null;
    let ownerName: string | null = null;
    if (r.bookId) {
      const book = g.books.find((b) => b.bookId === r.bookId);
      ownerName = book ? g.playerNames[book.ownerUserId] ?? null : null;
      if (r.entryIndex >= 0) {
        const row = this.entryRow(g.gameId, r.bookId, r.entryIndex);
        entry = row ? this.entryView(row) : null;
      }
    }
    const current: RevealCurrentView = { revision: r.revision, bookId: r.bookId, ownerName, entryIndex: r.entryIndex, entryCount, entry, allRevealed: this.allRevealed(g) };
    if (!forControl) return { current, books: null };
    const books: RevealProgressBook[] = g.books.map((b) => {
      const revealed = (r.revealed[b.bookId] ?? []).length;
      return {
        bookId: b.bookId,
        ownerUserId: b.ownerUserId,
        ownerName: g.playerNames[b.ownerUserId] ?? '?',
        entryCount,
        revealedCount: revealed,
        status: revealed === 0 ? 'unrevealed' : revealed >= entryCount ? 'complete' : 'partial',
      };
    });
    return { current, books };
  }

  private buildSnapshot(att: Attachment): RoomSnapshot {
    const m = this.meta!;
    const g = m.game;
    const connected = this.connectedUserIds();
    const isHost = !!m.host.userId && m.host.userId === att.userId;
    const isPlayer = m.status === 'LOBBY' ? m.members.some((x) => x.userId === att.userId && this.isCandidate(x)) : !!g && g.players.includes(att.userId) && !g.skipped.includes(att.userId);
    const canControl = isHost && att.primary;
    const canMonitor = this.canMonitor(att);
    const hostConnected = !!m.host.userId && connected.has(m.host.userId);
    const members: RoomMemberView[] = m.members
      .filter((x) => !x.left || (g && g.players.includes(x.userId)))
      .map((x) => ({
        userId: x.userId,
        nickname: x.nickname,
        displayName: x.displayName,
        isTeacher: x.isTeacher,
        badge: this.badgeFor(x),
        connected: connected.has(x.userId),
        ready: x.ready,
        left: x.left,
        isPlayer: m.status === 'LOBBY' ? this.isCandidate(x) : !!g && g.players.includes(x.userId),
        isHost: m.host.userId === x.userId,
      }));
    // 참관 표시: 플레이어가 아닌 교사·참관 방장이 연결되어 있으면 학생 화면에 알린다
    const observers = { teacher: false, host: false };
    for (const ws of this.openSockets()) {
      const a = getAttachment<Attachment>(ws);
      if (!a || !this.canMonitor(a)) continue;
      if (a.isTeacher) observers.teacher = true;
      else observers.host = true;
    }
    let promptSelection: RoomSnapshot['promptSelection'] = null;
    let assignment: RoomSnapshot['assignment'] = null;
    if (g && m.status === 'PROMPT_SELECTION' && g.players.includes(att.userId)) {
      promptSelection = {
        gameId: g.gameId,
        stageId: g.stageId,
        mode: g.promptMode,
        candidates: g.candidates[att.userId] ?? [],
        chosen: g.prompts[att.userId] ?? null,
        submitted: !!g.prompts[att.userId],
      };
    }
    if (g && m.status === 'PLAYING' && g.players.includes(att.userId) && !g.skipped.includes(att.userId)) {
      const a = this.assignmentFor(att.userId);
      if (a) {
        const prevRow = this.entryRow(g.gameId, a.bookId, g.stage - 1);
        const draftRow = this.ctx.storage.sql.exec('SELECT payload, revision FROM drafts WHERE game_id = ? AND stage_id = ? AND user_id = ?', g.gameId, g.stageId, att.userId).toArray()[0] as { payload: string; revision: number } | undefined;
        assignment = {
          gameId: g.gameId,
          stage: g.stage,
          stageId: g.stageId,
          bookId: a.bookId,
          bookOwnerName: g.playerNames[a.ownerUserId] ?? '?',
          kind: a.kind,
          previous: prevRow ? this.entryView(prevRow) : null,
          submitted: g.submitted.includes(att.userId),
          draft: draftRow ? (JSON.parse(draftRow.payload) as EntryPayload) : null,
          draftRevision: draftRow?.revision ?? 0,
        };
      }
    }
    const reveal = this.revealView(isHost);
    return {
      roomId: m.roomId,
      classId: m.classId,
      className: m.className,
      title: m.title,
      capacity: m.capacity,
      status: m.status,
      version: m.version,
      settings: m.settings,
      host: { userId: m.host.userId, displayName: m.host.displayName, mode: m.hostMode, isPlayingThisGame: !!m.host.userId && this.isPlayerInGame(m.host.userId), connected: hostConnected },
      members,
      playerCount: this.summary().playerCount,
      serverTime: Date.now(),
      deadlineAt: g && (m.status === 'PROMPT_SELECTION' || m.status === 'PLAYING') ? g.deadlineAt : null,
      stage: g?.stage ?? 0,
      stageCount: g?.stageCount ?? 0,
      gameId: g?.gameId ?? null,
      observers,
      me: { userId: att.userId, isTeacher: att.isTeacher, isHost, isPlayer, canControl, canMonitor, primaryConnection: att.primary },
      promptSelection,
      assignment,
      reveal: reveal.current,
      revealBooks: reveal.books,
      closedReason: m.closedReason,
      expiresAt: m.lastActivityAt + LIMITS.dataTtlMs,
    };
  }

  private sendMonitorSnapshot(ws: WebSocket): void {
    const m = this.meta!;
    const g = m.game;
    const players: MonitorPlayerView[] = [];
    const connected = this.connectedUserIds();
    if (g && ACTIVE_GAME.includes(m.status)) {
      for (const p of g.players) {
        const skipped = g.skipped.includes(p);
        const submitted = g.submitted.includes(p);
        let kind: MonitorPlayerView['kind'] = 'idle';
        let bookId: string | null = null;
        let bookOwnerName: string | null = null;
        let draft: EntryPayload | null = null;
        let live = false;
        let updatedAt = 0;
        let previous: EntryView | null = null;
        if (m.status === 'PROMPT_SELECTION') {
          kind = 'prompt';
          const chosen = g.prompts[p];
          if (chosen) draft = { kind: 'text', text: chosen };
        } else if (m.status === 'PLAYING') {
          const pi = g.players.indexOf(p);
          const bookIdx = bookIndexFor(g.players.length, pi, g.stage);
          const book = g.books[bookIdx]!;
          kind = stageKind(g.stage);
          bookId = book.bookId;
          bookOwnerName = g.playerNames[book.ownerUserId] ?? null;
          const prevRow = this.entryRow(g.gameId, book.bookId, g.stage - 1);
          previous = prevRow ? this.entryView(prevRow) : null;
          if (submitted) {
            const row = this.entryRow(g.gameId, book.bookId, g.stage);
            if (row) {
              draft = JSON.parse(row.payload) as EntryPayload;
              updatedAt = row.submitted_at;
            }
          } else {
            const lv = this.live.get(p);
            const draftRow = this.ctx.storage.sql.exec('SELECT payload, saved_at FROM drafts WHERE game_id = ? AND stage_id = ? AND user_id = ?', g.gameId, g.stageId, p).toArray()[0] as { payload: string; saved_at: number } | undefined;
            if (lv && lv.stageId === g.stageId && (!draftRow || lv.updatedAt >= draftRow.saved_at)) {
              draft = kind === 'drawing' ? { kind: 'drawing', strokes: lv.strokes } : { kind: 'text', text: lv.text };
              live = true;
              updatedAt = lv.updatedAt;
            } else if (draftRow) {
              draft = JSON.parse(draftRow.payload) as EntryPayload;
              updatedAt = draftRow.saved_at;
            }
          }
        }
        players.push({ userId: p, displayName: g.playerNames[p] ?? '?', connected: connected.has(p), kind, submitted, skipped, bookId, bookOwnerName, draft, live, updatedAt, previous });
      }
    }
    safeSend(ws, { type: 'monitor.snapshot', gameId: g?.gameId ?? null, players } satisfies RoomServerMessage);
  }
}

export type { RoomMeta };
export { assigneeIndex };
