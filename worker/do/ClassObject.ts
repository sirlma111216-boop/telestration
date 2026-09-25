/**
 * ClassObject — 클래스 하나당 하나의 Durable Object
 *  - 학생 명단 · 세션 토큰 · 방장 자격(HostGrant)
 *  - 방 목록(RoomSummary) 색인, 학생의 현재 소속 방
 *  - 방 입장 예약(RoomMembershipReservation): 예약 → RoomObject 입장 → 확정/취소, 알람으로 만료·복구
 *  - RoomObject 로 보내는 통지는 outbox 에 쌓고 재시도한다 (네트워크 호출을 트랜잭션으로 가정하지 않는다)
 */
import { DurableObject } from 'cloudflare:workers';
import { LIMITS, type ClassMemberView, type ClassSnapshot, type HostMode, type RoomSummary } from '@shared/types';
import type { ClassClientMessage, ClassServerMessage } from '@shared/protocol';
import { randomId, randomToken } from '@shared/ids';
import { validateCapacity, validateNickname, validateRoomTitle, ValidationError } from '@shared/validation';
import type { Env, Identity } from '../lib/env';
import { sha256Hex } from '../lib/password';
import { RateLimiter } from '../lib/rate';
import { getAttachment, isOpen, parseMessage, safeClose, safeSend, setAttachment } from '../lib/ws';
import type { RoomInitParams, RoomObject } from './RoomObject';

interface ClassMeta {
  classId: string;
  name: string;
  code: string;
  teacherId: string;
  teacherName: string;
  locked: boolean;
  ended: boolean;
  createdAt: number;
  lastActivityAt: number;
  revision: number;
}

interface MemberRow {
  student_id: string;
  nickname: string;
  display_name: string;
  token_hash: string;
  host_grant: number;
  current_room_id: string | null;
  joined_at: number;
  kicked: number;
}

type Attachment = { kind: 'teacher'; teacherId: string; connId: string } | { kind: 'student'; studentId: string; connId: string };

const RECONCILE_INTERVAL_MS = 15_000;
const ACK_SENT = Symbol("ack-sent");

export class ClassObject extends DurableObject<Env> {
  private meta: ClassMeta | null = null;
  private msgLimiter = new RateLimiter(40, 10_000);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS members (
          student_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, display_name TEXT NOT NULL, token_hash TEXT NOT NULL,
          host_grant INTEGER NOT NULL DEFAULT 0, current_room_id TEXT, joined_at INTEGER NOT NULL, kicked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS rooms (
          room_id TEXT PRIMARY KEY, summary TEXT NOT NULL, revision INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reservations (
          reservation_id TEXT PRIMARY KEY, student_id TEXT NOT NULL, room_id TEXT NOT NULL, status TEXT NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL
        );
      `);
      this.meta = (await ctx.storage.get<ClassMeta>('meta')) ?? null;
    });
  }

  // ---------- 초기화 · 조회 ----------

  async init(params: { classId: string; name: string; code: string; teacherId: string; teacherName: string }): Promise<void> {
    if (this.meta) return;
    const now = Date.now();
    this.meta = { ...params, locked: false, ended: false, createdAt: now, lastActivityAt: now, revision: 1 };
    await this.ctx.storage.put('meta', this.meta);
    await this.scheduleAlarm();
  }

  async info(): Promise<{ classId: string; name: string; locked: boolean; ended: boolean; teacherId: string } | null> {
    if (!this.meta) return null;
    const m = this.meta;
    return { classId: m.classId, name: m.name, locked: m.locked, ended: m.ended, teacherId: m.teacherId };
  }

  async joinClass(nickname: unknown): Promise<{ ok: true; studentId: string; token: string; classId: string; displayName: string } | { ok: false; error: string; message: string }> {
    if (!this.meta || this.meta.ended) return { ok: false, error: 'not_found', message: '이미 끝난 클래스예요.' };
    if (this.meta.locked) return { ok: false, error: 'locked', message: '선생님이 입장을 잠갔어요. 잠시 후 다시 시도해 주세요.' };
    let nick: string;
    try {
      nick = validateNickname(nickname);
    } catch (e) {
      return { ok: false, error: 'invalid_nickname', message: e instanceof ValidationError ? e.message : '닉네임이 올바르지 않아요' };
    }
    const count = this.ctx.storage.sql.exec('SELECT COUNT(*) AS c FROM members WHERE nickname = ? AND kicked = 0', nick).one().c as number;
    const displayName = count > 0 ? `${nick}(${count + 1})` : nick;
    const studentId = randomId('s');
    const secret = randomToken(32);
    const tokenHash = await sha256Hex(secret);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      'INSERT INTO members (student_id, nickname, display_name, token_hash, host_grant, current_room_id, joined_at, kicked) VALUES (?, ?, ?, ?, 0, NULL, ?, 0)',
      studentId, nick, displayName, tokenHash, now,
    );
    await this.touch();
    this.broadcastSnapshots();
    return { ok: true, studentId, token: `${this.meta.classId}.${secret}`, classId: this.meta.classId, displayName };
  }

  /** 학생 세션 토큰의 비밀 부분으로 신원을 확인 */
  async authenticate(secret: string): Promise<Identity | null> {
    if (!this.meta || this.meta.ended) return null;
    const hash = await sha256Hex(secret);
    const row = this.ctx.storage.sql.exec('SELECT * FROM members WHERE token_hash = ? AND kicked = 0', hash).toArray()[0] as unknown as MemberRow | undefined;
    if (!row) return null;
    return {
      kind: 'student',
      classId: this.meta.classId,
      studentId: row.student_id,
      nickname: row.nickname,
      displayName: row.display_name,
      hostGrant: !!row.host_grant,
      currentRoomId: row.current_room_id,
    };
  }

  private member(studentId: string): MemberRow | null {
    return (this.ctx.storage.sql.exec('SELECT * FROM members WHERE student_id = ?', studentId).toArray()[0] as unknown as MemberRow | undefined) ?? null;
  }

  private roomSummaries(includeClosed = false): RoomSummary[] {
    const rows = this.ctx.storage.sql.exec(includeClosed ? 'SELECT summary FROM rooms ORDER BY created_at' : 'SELECT summary FROM rooms WHERE closed = 0 ORDER BY created_at').toArray();
    return rows.map((r) => JSON.parse(r.summary as string) as RoomSummary);
  }

  private roomSummary(roomId: string): RoomSummary | null {
    const row = this.ctx.storage.sql.exec('SELECT summary FROM rooms WHERE room_id = ?', roomId).toArray()[0];
    return row ? (JSON.parse(row.summary as string) as RoomSummary) : null;
  }

  private openSockets(tag?: string): WebSocket[] {
    return (tag ? this.ctx.getWebSockets(tag) : this.ctx.getWebSockets()).filter(isOpen);
  }

  /**
   * 접속 중인 학생. 클래스 소켓뿐 아니라 방 소켓도 센다.
   * 방에 들어간 학생은 클래스 소켓을 닫으므로, 방 쪽을 세지 않으면 전부 오프라인으로 보인다.
   */
  private connectedStudentIds(): Set<string> {
    const set = new Set<string>();
    for (const ws of this.openSockets()) {
      const a = getAttachment<Attachment>(ws);
      if (a?.kind === 'student') set.add(a.studentId);
    }
    for (const room of this.roomSummaries()) {
      for (const userId of room.connectedUserIds ?? []) set.add(userId);
    }
    return set;
  }

  private hostingRoomOf(studentId: string): RoomSummary | null {
    return this.roomSummaries().find((r) => r.hostUserId === studentId) ?? null;
  }

  async snapshotFor(identity: Identity): Promise<ClassSnapshot | null> {
    if (!this.meta) return null;
    const m = this.meta;
    const connected = this.connectedStudentIds();
    const rooms = this.roomSummaries();
    const roomTitle = new Map(rooms.map((r) => [r.roomId, r]));
    const memberRows = this.ctx.storage.sql.exec('SELECT * FROM members WHERE kicked = 0 ORDER BY joined_at').toArray() as unknown as MemberRow[];
    const members: ClassMemberView[] = memberRows.map((r) => {
      const room = r.current_room_id ? roomTitle.get(r.current_room_id) ?? null : null;
      let roomRole: ClassMemberView['roomRole'] = null;
      if (room) roomRole = room.hostUserId === r.student_id ? (room.hostMode === 'observe' ? 'host-observer' : 'host-player') : 'player';
      return {
        studentId: r.student_id,
        nickname: r.nickname,
        displayName: r.display_name,
        connected: connected.has(r.student_id),
        hostGrant: !!r.host_grant,
        currentRoomId: room ? r.current_room_id : null,
        currentRoomTitle: room?.title ?? null,
        roomRole,
        joinedAt: r.joined_at,
      };
    });
    const base = {
      classId: m.classId,
      name: m.name,
      code: m.code,
      teacherName: m.teacherName,
      locked: m.locked,
      ended: m.ended,
      revision: m.revision,
      rooms,
      memberCount: members.length,
      connectedCount: members.filter((x) => x.connected).length,
      serverTime: Date.now(),
      expiresAt: this.expiresAt(),
    };
    if (identity.kind === 'teacher') {
      return { ...base, members, me: { kind: 'teacher' } };
    }
    // 학생에게는 방의 접속자 목록을 내려보내지 않는다 (필요 없고, 알 이유도 없다)
    base.rooms = rooms.map(({ connectedUserIds: _drop, ...rest }) => rest);
    const me = this.member(identity.studentId);
    return {
      ...base,
      members: [],
      me: {
        kind: 'student',
        studentId: identity.studentId,
        nickname: me?.display_name ?? identity.displayName,
        hostGrant: !!me?.host_grant,
        currentRoomId: me?.current_room_id ?? null,
      },
    };
  }

  // ---------- WebSocket ----------

  async fetch(request: Request): Promise<Response> {
    if (!this.meta || this.meta.ended) return new Response('클래스를 찾을 수 없어요', { status: 404 });
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const identity = JSON.parse(request.headers.get('x-identity') ?? 'null') as Identity | null;
    if (!identity) return new Response('unauthorized', { status: 401 });
    if (identity.kind === 'teacher' && identity.teacherId !== this.meta.teacherId) return new Response('forbidden', { status: 403 });
    if (identity.kind === 'student') {
      const row = this.member(identity.studentId);
      if (!row || row.kicked) return new Response('forbidden', { status: 403 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const connId = randomId('conn', 6);
    const attachment: Attachment = identity.kind === 'teacher' ? { kind: 'teacher', teacherId: identity.teacherId, connId } : { kind: 'student', studentId: identity.studentId, connId };
    const tags = identity.kind === 'teacher' ? ['teacher'] : ['student', `student:${identity.studentId}`];
    this.ctx.acceptWebSocket(server, tags);
    setAttachment(server, attachment);
    const snap = await this.snapshotFor(identity);
    if (snap) safeSend(server, { type: 'class.snapshot', snapshot: snap } satisfies ClassServerMessage);
    if (identity.kind === 'student') this.broadcastToTeacher();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = getAttachment<Attachment>(ws);
    if (!att) return safeClose(ws, 4001, 'no attachment');
    if (!this.msgLimiter.hit(att.connId)) return void safeSend(ws, { type: 'error', error: 'rate_limited', message: '요청이 너무 잦아요' });
    const msg = parseMessage(raw) as ClassClientMessage | null;
    if (!msg || typeof msg.type !== 'string') return;
    const actionId = typeof (msg as { clientActionId?: unknown }).clientActionId === 'string' ? (msg as { clientActionId: string }).clientActionId : 'x';
    try {
      if (!this.meta || this.meta.ended) throw new ValidationError('이미 끝난 클래스예요');
      const result = await this.handle(att, msg, ws, actionId);
      if (result !== ACK_SENT) safeSend(ws, { type: 'ack', clientActionId: actionId, ok: true, result });
    } catch (e) {
      const message = e instanceof Error ? e.message : '요청을 처리하지 못했어요';
      safeSend(ws, { type: 'ack', clientActionId: actionId, ok: false, error: e instanceof ValidationError ? 'invalid' : 'failed', message });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = getAttachment<Attachment>(ws);
    safeClose(ws);
    if (att?.kind === 'student') this.broadcastToTeacher();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    safeClose(ws, 1011);
  }

  private async handle(att: Attachment, msg: ClassClientMessage, ws: WebSocket, actionId: string): Promise<unknown> {
    if (msg.type === 'class.ping') return { serverTime: Date.now() };
    if (att.kind === 'teacher') return this.handleTeacher(msg, ws, actionId);
    return this.handleStudent(att.studentId, msg);
  }

  // ---------- 교사 명령 ----------

  private async handleTeacher(msg: ClassClientMessage, ws: WebSocket, actionId: string): Promise<unknown> {
    const meta = this.meta!;
    switch (msg.type) {
      case 'class.lock': {
        meta.locked = !!msg.locked;
        await this.bumpMeta();
        this.broadcastSnapshots();
        return null;
      }
      case 'class.end': {
        if (msg.confirm !== true) throw new ValidationError('확인이 필요해요');
        await this.endClass('선생님이 클래스를 종료했어요.', { ws, actionId });
        return ACK_SENT;
      }
      case 'class.grantHost': {
        const m = this.member(msg.studentId);
        if (!m || m.kicked) throw new ValidationError('학생을 찾을 수 없어요');
        const grant = !!msg.grant;
        this.ctx.storage.sql.exec('UPDATE members SET host_grant = ? WHERE student_id = ?', grant ? 1 : 0, msg.studentId);
        await this.touch();
        if (!grant) {
          // 운영 중인 방의 진행권도 즉시 회수. 게임 데이터는 삭제하지 않는다.
          for (const r of this.roomSummaries()) {
            if (r.hostUserId === msg.studentId) this.enqueue(r.roomId, 'hostGrantRevoked', { studentId: msg.studentId });
          }
          await this.processOutbox();
        }
        this.broadcastSnapshots();
        return null;
      }
      case 'class.kick': {
        const m = this.member(msg.studentId);
        if (!m || m.kicked) throw new ValidationError('학생을 찾을 수 없어요');
        this.ctx.storage.sql.exec('UPDATE members SET kicked = 1, host_grant = 0, token_hash = ?, current_room_id = NULL WHERE student_id = ?', `kicked:${randomToken(8)}`, msg.studentId);
        this.ctx.storage.sql.exec('DELETE FROM reservations WHERE student_id = ?', msg.studentId);
        for (const ws of this.ctx.getWebSockets(`student:${msg.studentId}`)) {
          safeSend(ws, { type: 'class.kicked', message: '선생님이 클래스에서 내보냈어요.' } satisfies ClassServerMessage);
          safeClose(ws, 4003, 'kicked');
        }
        if (m.current_room_id) this.enqueue(m.current_room_id, 'removeMember', { userId: msg.studentId, reason: 'class-kick' });
        for (const r of this.roomSummaries()) if (r.hostUserId === msg.studentId) this.enqueue(r.roomId, 'hostGrantRevoked', { studentId: msg.studentId });
        await this.touch();
        await this.processOutbox();
        this.broadcastSnapshots();
        return null;
      }
      case 'room.create': {
        const title = validateRoomTitle(msg.title);
        const capacity = validateCapacity(msg.capacity);
        const hostMode: HostMode = msg.hostMode === 'play' ? 'play' : 'observe';
        if (msg.hostStudentId) {
          const m = this.member(msg.hostStudentId);
          if (!m || m.kicked) throw new ValidationError('학생을 찾을 수 없어요');
          if (!m.host_grant) throw new ValidationError('방장 자격이 없는 학생이에요. 먼저 방장으로 지정해 주세요.');
          if (m.current_room_id) throw new ValidationError('이미 다른 방에 참여 중인 학생이에요.');
          if (this.hostingRoomOf(m.student_id)) throw new ValidationError('이미 다른 방을 운영 중인 학생이에요.');
          return this.createRoom({ title, capacity, hostMode, settings: msg.settings, gameMode: msg.gameMode, fa: msg.fa, host: { userId: m.student_id, displayName: m.display_name, isTeacher: false } });
        }
        return this.createRoom({ title, capacity, hostMode, settings: msg.settings, gameMode: msg.gameMode, fa: msg.fa, host: { userId: `teacher:${meta.teacherId}`, displayName: meta.teacherName, isTeacher: true } });
      }
      case 'room.assignHost': {
        const room = this.roomSummary(msg.roomId);
        if (!room || room.status === 'CLOSED') throw new ValidationError('방을 찾을 수 없어요');
        const m = this.member(msg.studentId);
        if (!m || m.kicked) throw new ValidationError('학생을 찾을 수 없어요');
        if (!m.host_grant) throw new ValidationError('방장 자격이 없는 학생이에요.');
        if (m.current_room_id !== msg.roomId) throw new ValidationError('그 방에 참여 중인 학생만 방장으로 지정할 수 있어요.');
        const hosting = this.hostingRoomOf(m.student_id);
        if (hosting && hosting.roomId !== msg.roomId) throw new ValidationError('이미 다른 방을 운영 중인 학생이에요.');
        const res = await this.roomStub(msg.roomId).setHost({ userId: m.student_id, displayName: m.display_name, isTeacher: false, byTeacher: true });
        if (!res.ok) throw new ValidationError(res.message);
        await this.touch();
        return null;
      }
      case 'room.takeOver': {
        const room = this.roomSummary(msg.roomId);
        if (!room || room.status === 'CLOSED') throw new ValidationError('방을 찾을 수 없어요');
        const res = await this.roomStub(msg.roomId).setHost({ userId: `teacher:${meta.teacherId}`, displayName: meta.teacherName, isTeacher: true, byTeacher: true });
        if (!res.ok) throw new ValidationError(res.message);
        await this.touch();
        return null;
      }
      case 'room.forceClose': {
        if (msg.confirm !== true) throw new ValidationError('확인이 필요해요');
        const room = this.roomSummary(msg.roomId);
        if (!room) throw new ValidationError('방을 찾을 수 없어요');
        this.enqueue(msg.roomId, 'forceClose', { reason: '선생님이 방을 닫았어요.' });
        await this.processOutbox();
        return null;
      }
      case 'room.join':
      case 'room.leave':
        throw new ValidationError('교사는 이 명령을 사용할 수 없어요');
      default:
        throw new ValidationError('알 수 없는 명령');
    }
  }

  private async createRoom(args: {
    title: string;
    capacity: number;
    hostMode: HostMode;
    settings?: Partial<RoomInitParams['settings']>;
    gameMode?: RoomInitParams['gameMode'];
    fa?: RoomInitParams['fa'];
    host: { userId: string; displayName: string; isTeacher: boolean };
  }): Promise<{ roomId: string }> {
    const meta = this.meta!;
    const roomId = randomId('r');
    const settings: RoomInitParams['settings'] = {
      promptMode: args.settings?.promptMode === 'custom' ? 'custom' : 'choice',
      drawSeconds: ([60, 90, 120] as const).includes(args.settings?.drawSeconds as 60) ? (args.settings!.drawSeconds as 60 | 90 | 120) : 90,
      guessSeconds: ([30, 45, 60] as const).includes(args.settings?.guessSeconds as 30) ? (args.settings!.guessSeconds as 30 | 45 | 60) : 45,
    };
    const params: RoomInitParams = {
      roomId,
      classId: meta.classId,
      className: meta.name,
      teacherId: meta.teacherId,
      title: args.title,
      capacity: args.capacity,
      hostMode: args.hostMode,
      settings,
      host: args.host,
      gameMode: args.gameMode,
      fa: args.fa,
    };
    const now = Date.now();
    // 학생 방장은 방의 구성원이 되므로 예약을 먼저 기록한다
    const reservationId = randomId('res');
    if (!args.host.isTeacher) {
      this.ctx.storage.sql.exec(
        'INSERT INTO reservations (reservation_id, student_id, room_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        reservationId, args.host.userId, roomId, 'pending', now, now + LIMITS.reservationTtlMs,
      );
    }
    const placeholder: RoomSummary = {
      roomId, title: args.title, gameMode: args.gameMode === 'FAKE_ARTIST' ? 'FAKE_ARTIST' : 'TELESTRATION', hostUserId: args.host.userId, hostName: args.host.displayName, hostMode: args.hostMode,
      playerCount: 0, capacity: args.capacity, status: 'LOBBY', revision: 0, updatedAt: now,
    };
    this.ctx.storage.sql.exec('INSERT INTO rooms (room_id, summary, revision, closed, created_at) VALUES (?, ?, 0, 0, ?)', roomId, JSON.stringify(placeholder), now);
    try {
      const summary = await this.roomStub(roomId).init(params);
      this.applySummary(summary);
      if (!args.host.isTeacher) {
        this.ctx.storage.sql.exec('UPDATE members SET current_room_id = ? WHERE student_id = ?', roomId, args.host.userId);
        this.ctx.storage.sql.exec('DELETE FROM reservations WHERE reservation_id = ?', reservationId);
      }
    } catch (e) {
      this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', roomId);
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE reservation_id = ?', reservationId);
      throw new ValidationError('방을 만들지 못했어요. 다시 시도해 주세요.');
    }
    await this.touch();
    this.broadcastSnapshots();
    return { roomId };
  }

  // ---------- 학생 명령 ----------

  private async handleStudent(studentId: string, msg: ClassClientMessage): Promise<unknown> {
    const m = this.member(studentId);
    if (!m || m.kicked) throw new ValidationError('클래스에서 나간 상태예요');
    switch (msg.type) {
      case 'room.create': {
        if (!m.host_grant) throw new ValidationError('방을 만들 수 있는 자격이 없어요. 선생님께 방장 지정을 요청하세요.');
        if (m.current_room_id) throw new ValidationError('이미 다른 방에 참여 중이에요. 먼저 나와 주세요.');
        if (this.hostingRoomOf(studentId)) throw new ValidationError('이미 운영 중인 방이 있어요. 한 번에 하나만 운영할 수 있어요.');
        const title = validateRoomTitle(msg.title);
        const capacity = validateCapacity(msg.capacity);
        const hostMode: HostMode = msg.hostMode === 'play' ? 'play' : 'observe';
        return this.createRoom({ title, capacity, hostMode, settings: msg.settings, gameMode: msg.gameMode, fa: msg.fa, host: { userId: studentId, displayName: m.display_name, isTeacher: false } });
      }
      case 'room.join':
        return this.joinRoom(m, msg.roomId);
      case 'room.leave': {
        if (m.current_room_id !== msg.roomId) return null;
        try {
          await this.roomStub(msg.roomId).removeMember(studentId, 'left');
        } catch {
          this.enqueue(msg.roomId, 'removeMember', { userId: studentId, reason: 'left' });
        }
        this.ctx.storage.sql.exec('UPDATE members SET current_room_id = NULL WHERE student_id = ? AND current_room_id = ?', studentId, msg.roomId);
        await this.touch();
        this.broadcastSnapshots();
        return null;
      }
      default:
        throw new ValidationError('학생은 이 명령을 사용할 수 없어요');
    }
  }

  /** 입장 예약 → RoomObject 입장 → 확정. 실패·예외 시 취소 또는 알람 기반 복구. */
  private async joinRoom(m: MemberRow, roomId: string): Promise<unknown> {
    const now = Date.now();
    const room = this.roomSummary(roomId);
    if (!room || room.status === 'CLOSED') throw new ValidationError('닫힌 방이에요');
    if (room.status !== 'LOBBY') throw new ValidationError('게임이 진행 중인 방이에요. 다음 판을 기다려 주세요.');
    if (m.current_room_id && m.current_room_id !== roomId) throw new ValidationError('이미 다른 방에 참여 중이에요.');
    if (m.current_room_id === roomId) return { roomId };
    const pending = this.ctx.storage.sql.exec('SELECT reservation_id, expires_at FROM reservations WHERE student_id = ?', m.student_id).toArray()[0] as { reservation_id: string; expires_at: number } | undefined;
    if (pending) {
      if (pending.expires_at > now) throw new ValidationError('입장 처리 중이에요. 잠시만 기다려 주세요.');
      await this.reconcileReservation(pending.reservation_id);
      const again = this.member(m.student_id);
      if (again?.current_room_id) throw new ValidationError('이미 다른 방에 참여 중이에요.');
    }
    if (room.playerCount >= room.capacity) throw new ValidationError('정원이 가득 찼어요.');
    const reservationId = randomId('res');
    this.ctx.storage.sql.exec(
      'INSERT INTO reservations (reservation_id, student_id, room_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      reservationId, m.student_id, roomId, 'pending', now, now + LIMITS.reservationTtlMs,
    );
    await this.scheduleAlarm();
    let result: Awaited<ReturnType<RoomObject['joinReserved']>>;
    try {
      result = await this.roomStub(roomId).joinReserved({ reservationId, member: { userId: m.student_id, nickname: m.nickname, displayName: m.display_name } });
    } catch {
      // 결과를 알 수 없음 → 예약을 남겨 두고 알람에서 방에 물어본다
      throw new ValidationError('입장 확인이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.');
    }
    this.ctx.storage.sql.exec('DELETE FROM reservations WHERE reservation_id = ?', reservationId);
    if (!result.ok) throw new ValidationError(result.message);
    this.ctx.storage.sql.exec('UPDATE members SET current_room_id = ? WHERE student_id = ?', roomId, m.student_id);
    if (result.summary) this.applySummary(result.summary);
    await this.touch();
    this.broadcastSnapshots();
    return { roomId };
  }

  private async reconcileReservation(reservationId: string): Promise<void> {
    const row = this.ctx.storage.sql.exec('SELECT * FROM reservations WHERE reservation_id = ?', reservationId).toArray()[0] as { student_id: string; room_id: string } | undefined;
    if (!row) return;
    let inRoom = false;
    try {
      inRoom = await this.roomStub(row.room_id).hasMember(row.student_id);
    } catch {
      return; // 다음 알람에서 재시도
    }
    this.ctx.storage.sql.exec('DELETE FROM reservations WHERE reservation_id = ?', reservationId);
    if (inRoom) {
      this.ctx.storage.sql.exec('UPDATE members SET current_room_id = ? WHERE student_id = ? AND current_room_id IS NULL', row.room_id, row.student_id);
    }
  }

  // ---------- RoomObject 에서 오는 통지 ----------

  async roomSummaryUpdated(summary: RoomSummary): Promise<void> {
    if (!this.meta) return;
    this.applySummary(summary);
    if (summary.status === 'CLOSED') {
      this.ctx.storage.sql.exec('UPDATE members SET current_room_id = NULL WHERE current_room_id = ?', summary.roomId);
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE room_id = ?', summary.roomId);
    }
    await this.touch();
    this.broadcastSnapshots();
  }

  async memberLeftRoom(studentId: string, roomId: string): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE members SET current_room_id = NULL WHERE student_id = ? AND current_room_id = ?', studentId, roomId);
    this.ctx.storage.sql.exec('DELETE FROM reservations WHERE student_id = ? AND room_id = ?', studentId, roomId);
    this.broadcastSnapshots();
  }

  async roomClosed(summary: RoomSummary): Promise<void> {
    await this.roomSummaryUpdated({ ...summary, status: 'CLOSED' });
  }

  /** RoomObject 가 방장 지정 전 최신 자격을 확인할 때 사용 */
  async hasHostGrant(studentId: string): Promise<boolean> {
    const m = this.member(studentId);
    return !!m && !m.kicked && !!m.host_grant;
  }

  /** RoomObject 가 자기 명단과 클래스 소속을 대조할 때 사용 */
  async membersInRoom(roomId: string): Promise<string[]> {
    return this.ctx.storage.sql.exec('SELECT student_id FROM members WHERE current_room_id = ? AND kicked = 0', roomId).toArray().map((r) => r.student_id as string);
  }

  private applySummary(summary: RoomSummary): void {
    const row = this.ctx.storage.sql.exec('SELECT revision FROM rooms WHERE room_id = ?', summary.roomId).toArray()[0] as { revision: number } | undefined;
    if (row && row.revision > summary.revision) return; // 지연된 이벤트 무시
    const closed = summary.status === 'CLOSED' ? 1 : 0;
    if (row) {
      this.ctx.storage.sql.exec('UPDATE rooms SET summary = ?, revision = ?, closed = ? WHERE room_id = ?', JSON.stringify(summary), summary.revision, closed, summary.roomId);
    } else {
      this.ctx.storage.sql.exec('INSERT INTO rooms (room_id, summary, revision, closed, created_at) VALUES (?, ?, ?, ?, ?)', summary.roomId, JSON.stringify(summary), summary.revision, closed, Date.now());
    }
  }

  // ---------- 종료 · 만료 ----------

  async endClass(reason: string, ack?: { ws: WebSocket; actionId: string }): Promise<void> {
    const meta = this.meta;
    if (!meta || meta.ended) return;
    meta.ended = true;
    meta.locked = true;
    await this.bumpMeta();
    for (const r of this.roomSummaries()) this.enqueue(r.roomId, 'forceClose', { reason });
    await this.processOutbox();
    if (ack) safeSend(ack.ws, { type: 'ack', clientActionId: ack.actionId, ok: true, result: null } satisfies ClassServerMessage);
    for (const ws of this.ctx.getWebSockets()) {
      safeSend(ws, { type: 'class.ended', message: reason } satisfies ClassServerMessage);
      safeClose(ws, 4000, 'class ended');
    }
    try {
      await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory')).classEnded(meta.classId);
    } catch {
      /* 알람에서 재시도 */
    }
    await this.scheduleAlarm();
  }

  private async purge(): Promise<void> {
    const meta = this.meta;
    try {
      if (meta) await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory')).deleteClass(meta.classId);
    } catch {
      /* 색인은 Directory 가 자체 정리 */
    }
    for (const ws of this.ctx.getWebSockets()) safeClose(ws, 4000, 'expired');
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.meta = null;
  }

  private expiresAt(): number {
    const meta = this.meta!;
    let last = meta.lastActivityAt;
    for (const r of this.roomSummaries()) if (r.updatedAt > last) last = r.updatedAt;
    return last + LIMITS.dataTtlMs;
  }

  async alarm(): Promise<void> {
    if (!this.meta) return;
    const now = Date.now();
    // 1) 만료된 예약 정합성 복구
    const stale = this.ctx.storage.sql.exec('SELECT reservation_id FROM reservations WHERE expires_at <= ?', now).toArray();
    for (const r of stale) await this.reconcileReservation(r.reservation_id as string);
    // 2) 통지 재시도
    await this.processOutbox();
    // 3) 방 목록 대조 (열린 방의 최신 요약을 가져와 어긋남 보정)
    for (const r of this.roomSummaries()) {
      if (now - r.updatedAt < RECONCILE_INTERVAL_MS) continue;
      try {
        const s = await this.roomStub(r.roomId).getSummary();
        if (s) this.applySummary(s);
        else this.applySummary({ ...r, status: 'CLOSED', revision: r.revision + 1, updatedAt: now });
      } catch {
        /* 다음 알람 */
      }
    }
    if (this.meta.ended) {
      const remaining = this.ctx.storage.sql.exec('SELECT COUNT(*) AS c FROM outbox').one().c as number;
      if (remaining === 0) {
        await this.purge();
        return;
      }
    } else if (now >= this.expiresAt()) {
      await this.endClass('24시간 동안 활동이 없어 클래스가 자동으로 종료되었어요.');
      await this.purge();
      return;
    }
    this.broadcastSnapshots();
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    if (!this.meta) return;
    const now = Date.now();
    let next = this.expiresAt();
    const res = this.ctx.storage.sql.exec('SELECT MIN(expires_at) AS t FROM reservations').one().t as number | null;
    if (res && res < next) next = res;
    const out = this.ctx.storage.sql.exec('SELECT MIN(next_at) AS t FROM outbox').one().t as number | null;
    if (out && out < next) next = out;
    if (this.meta.ended) next = Math.min(next, now + 5_000);
    // 최소 1초 뒤, 최대 만료 시각. 여러 종류의 기한이 서로 덮어쓰지 않도록 항상 가장 가까운 것을 예약.
    await this.ctx.storage.setAlarm(Math.max(now + 1_000, next));
  }

  // ---------- outbox ----------

  private enqueue(roomId: string, kind: string, payload: unknown): void {
    this.ctx.storage.sql.exec('INSERT INTO outbox (room_id, kind, payload, attempts, next_at) VALUES (?, ?, ?, 0, ?)', roomId, kind, JSON.stringify(payload), Date.now());
  }

  private async processOutbox(): Promise<void> {
    const now = Date.now();
    const jobs = this.ctx.storage.sql.exec('SELECT * FROM outbox WHERE next_at <= ? ORDER BY id LIMIT 20', now).toArray() as unknown as { id: number; room_id: string; kind: string; payload: string; attempts: number }[];
    for (const job of jobs) {
      const payload = JSON.parse(job.payload) as Record<string, unknown>;
      try {
        const stub = this.roomStub(job.room_id);
        if (job.kind === 'forceClose') await stub.forceClose(String(payload.reason ?? '방이 닫혔어요.'));
        else if (job.kind === 'hostGrantRevoked') await stub.hostGrantRevoked(String(payload.studentId));
        else if (job.kind === 'removeMember') await stub.removeMember(String(payload.userId), (payload.reason as 'left' | 'kicked' | 'class-kick') ?? 'left');
        this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id = ?', job.id);
      } catch {
        const attempts = job.attempts + 1;
        if (attempts >= 12) {
          this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id = ?', job.id);
        } else {
          this.ctx.storage.sql.exec('UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?', attempts, now + Math.min(60_000, 1_000 * 2 ** attempts), job.id);
        }
      }
    }
    await this.scheduleAlarm();
  }

  // ---------- 보조 ----------

  private roomStub(roomId: string): DurableObjectStub<RoomObject> {
    return this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId));
  }

  private async touch(): Promise<void> {
    if (!this.meta) return;
    this.meta.lastActivityAt = Date.now();
    await this.bumpMeta();
  }

  private async bumpMeta(): Promise<void> {
    if (!this.meta) return;
    this.meta.revision += 1;
    await this.ctx.storage.put('meta', this.meta);
  }

  private broadcastToTeacher(): void {
    if (!this.meta) return;
    const teacherSockets = this.openSockets('teacher');
    if (teacherSockets.length === 0) return;
    void this.snapshotFor({ kind: 'teacher', teacherId: this.meta.teacherId, name: this.meta.teacherName }).then((snap) => {
      if (!snap) return;
      for (const ws of teacherSockets) safeSend(ws, { type: 'class.snapshot', snapshot: snap } satisfies ClassServerMessage);
    });
  }

  private broadcastSnapshots(): void {
    if (!this.meta) return;
    this.broadcastToTeacher();
    const studentSockets = this.openSockets('student');
    for (const ws of studentSockets) {
      const att = getAttachment<Attachment>(ws);
      if (att?.kind !== 'student') continue;
      const m = this.member(att.studentId);
      if (!m) continue;
      void this.snapshotFor({
        kind: 'student', classId: this.meta.classId, studentId: m.student_id, nickname: m.nickname, displayName: m.display_name, hostGrant: !!m.host_grant, currentRoomId: m.current_room_id,
      }).then((snap) => {
        if (snap) safeSend(ws, { type: 'class.snapshot', snapshot: snap } satisfies ClassServerMessage);
      });
    }
  }
}
