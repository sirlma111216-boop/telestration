/**
 * Node 측 테스트 하네스 — HTTP API 와 WebSocket 으로 교사·학생 역할을 흉내 낸다.
 * 실제 클라이언트와 같은 프로토콜(같은 메시지 형식, Origin 헤더)을 사용한다.
 */
import WebSocket from 'ws';
import type { ClassSnapshot, MonitorPlayerView, RoomSnapshot, Stroke } from '../../shared/types';

export const BASE = process.env.PR_BASE_URL ?? 'http://localhost:5173';
const WS_BASE = BASE.replace(/^http/, 'ws');
export const ORIGIN = BASE;

/** 로컬 테스트에서 IP 기준 빈도 제한을 서로 간섭하지 않게 호출마다 가짜 IP 를 붙인다 (운영에서는 cf-connecting-ip 가 우선). */
export function fakeIp(): string {
  const n = () => Math.floor(Math.random() * 250);
  return `10.${n()}.${n()}.${n()}`;
}

export interface Teacher {
  cookie: string;
  teacherId: string;
  name: string;
}

export async function teacherLogin(username = 'demo', password = 'teacher-demo-1234'): Promise<Teacher> {
  const res = await fetch(`${BASE}/api/teacher/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': fakeIp() },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  const body = (await res.json()) as { teacher: { teacherId: string; name: string } };
  return { cookie, teacherId: body.teacher.teacherId, name: body.teacher.name };
}

export async function teacherApi<T>(t: Teacher | null, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  headers.set('origin', ORIGIN);
  if (t) headers.set('cookie', t.cookie);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export async function createClass(t: Teacher, name = '테스트 클래스'): Promise<{ classId: string; code: string }> {
  const r = await teacherApi<{ classId: string; code: string }>(t, '/api/teacher/classes', { method: 'POST', body: JSON.stringify({ name }) });
  if (r.status !== 200) throw new Error(`createClass ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export interface Student {
  classId: string;
  studentId: string;
  token: string;
  displayName: string;
}

export async function joinClass(code: string, nickname: string): Promise<Student> {
  const res = await fetch(`${BASE}/api/class/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': fakeIp() },
    body: JSON.stringify({ code, nickname }),
  });
  if (!res.ok) throw new Error(`joinClass ${res.status} ${await res.text()}`);
  return (await res.json()) as Student;
}

type Msg = Record<string, unknown>;

/** 스냅샷을 누적하고 조건을 기다리는 WebSocket 클라이언트 */
export class Client<S = RoomSnapshot> {
  ws: WebSocket;
  snapshot: S | null = null;
  messages: Msg[] = [];
  monitor: MonitorPlayerView[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: () => boolean; resolve: () => void }[] = [];
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private counter = 0;
  readonly opened: Promise<void>;
  readonly snapshotKey: string;

  constructor(url: string, headers: Record<string, string>, snapshotKey: 'room.snapshot' | 'class.snapshot') {
    this.snapshotKey = snapshotKey;
    this.ws = new WebSocket(url, { headers: { origin: ORIGIN, ...headers } });
    this.opened = new Promise((resolve, reject) => {
      // 서버는 연결 직후 스냅샷을 보낸다. 첫 스냅샷까지 기다려야 snapshot 을 바로 읽을 수 있다.
      this.ws.once('open', () => {
        const t = setTimeout(resolve, 5000);
        this.waiters.push({
          pred: () => this.snapshot !== null,
          resolve: () => {
            clearTimeout(t);
            // 실제 클라이언트처럼 연결 직후 ping 을 보낸다 (로컬 환경에서 서버 종료 프레임 전달 보장)
            this.fire({ type: this.snapshotKey === 'room.snapshot' ? 'room.ping' : 'class.ping', clientActionId: 'hello' });
            resolve();
          },
        });
      });
      this.ws.once('error', (e) => reject(e));
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`ws ${res.statusCode}`)));
      this.ws.once('close', () => reject(new Error('closed before open')));
    });
    this.opened.catch(() => {});
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Msg;
      this.messages.push(msg);
      if (msg.type === this.snapshotKey) this.snapshot = msg.snapshot as S;
      if (msg.type === 'monitor.snapshot') this.monitor = msg.players as MonitorPlayerView[];
      if (msg.type === 'monitor.update') {
        const u = msg as { userId: string; strokesAppend?: Stroke[]; reset?: boolean; text?: string };
        this.monitor = this.monitor.map((p) => {
          if (p.userId !== u.userId) return p;
          if (typeof u.text === 'string') return { ...p, draft: { kind: 'text', text: u.text }, live: true };
          const base = u.reset || !p.draft || p.draft.kind !== 'drawing' ? [] : p.draft.strokes;
          return { ...p, draft: { kind: 'drawing', strokes: [...base, ...(u.strokesAppend ?? [])] }, live: true };
        });
      }
      if (msg.type === 'ack' && typeof msg.clientActionId === 'string') {
        const p = this.pending.get(msg.clientActionId);
        if (p) {
          this.pending.delete(msg.clientActionId);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(String(msg.message)));
        }
      }
      this.check();
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const [, p] of this.pending) p.reject(new Error('closed'));
      this.pending.clear();
      this.check();
    });
    this.ws.on('error', () => {});
  }

  private check(): void {
    this.waiters = this.waiters.filter((w) => {
      if (w.pred()) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  async command<T = unknown>(msg: Msg, timeoutMs = 8000): Promise<T> {
    await this.opened;
    const clientActionId = `t${++this.counter}-${Date.now()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientActionId);
        reject(new Error(`timeout: ${String(msg.type)}`));
      }, timeoutMs);
      this.pending.set(clientActionId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ ...msg, clientActionId }));
    });
  }

  /** ack 를 기다리되 실패 메시지를 반환 (거부 검증용) */
  async tryCommand(msg: Msg): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
    try {
      return { ok: true, result: await this.command(msg) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  fire(msg: Msg): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred: (c: this) => boolean, timeoutMs = 15000, label = 'condition'): Promise<void> {
    if (pred(this)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`waitFor timeout: ${label} (status=${(this.snapshot as { status?: string } | null)?.status ?? 'none'})`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push({ pred: () => pred(this), resolve: done });
    });
  }

  waitStatus(status: string | string[], timeoutMs = 20000): Promise<void> {
    const list = Array.isArray(status) ? status : [status];
    return this.waitFor((c) => !!c.snapshot && list.includes((c.snapshot as unknown as { status: string }).status), timeoutMs, `status ${list.join('|')}`);
  }

  close(): void {
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
    } catch {
      /* 이미 닫힘 */
    }
  }
}

export function classSocket(student: Student): Client<ClassSnapshot> {
  return new Client<ClassSnapshot>(`${WS_BASE}/ws/class/${student.classId}?token=${encodeURIComponent(student.token)}`, {}, 'class.snapshot');
}
export function teacherClassSocket(t: Teacher, classId: string): Client<ClassSnapshot> {
  return new Client<ClassSnapshot>(`${WS_BASE}/ws/class/${classId}?as=teacher`, { cookie: t.cookie }, 'class.snapshot');
}
export function roomSocket(student: Student, roomId: string): Client<RoomSnapshot> {
  return new Client<RoomSnapshot>(`${WS_BASE}/ws/room/${roomId}?token=${encodeURIComponent(student.token)}`, {}, 'room.snapshot');
}
export function teacherRoomSocket(t: Teacher, roomId: string): Client<RoomSnapshot> {
  return new Client<RoomSnapshot>(`${WS_BASE}/ws/room/${roomId}?as=teacher`, { cookie: t.cookie }, 'room.snapshot');
}

export function sampleStrokes(seed = 1): Stroke[] {
  const out: Stroke[] = [];
  for (let i = 0; i < 3; i++) {
    const p: number[] = [];
    for (let k = 0; k < 10; k++) p.push(100 + i * 80 + k * 20 + seed, 100 + k * 25 + (seed % 7));
    out.push({ t: 'pen', c: '#2b2f4a', w: 9, p });
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 이번 단계에서 내 담당 작업을 제출 (그림이면 스트로크, 추측이면 텍스트) */
export async function submitCurrent(c: Client<RoomSnapshot>, label: string): Promise<void> {
  const a = c.snapshot?.assignment;
  if (!a || a.submitted) return;
  const payload = a.kind === 'drawing' ? { kind: 'drawing', strokes: sampleStrokes(label.length) } : { kind: 'text', text: `${label}의 추측 ${a.stage}` };
  await c.command({ type: 'entry.submit', gameId: a.gameId, stageId: a.stageId, payload });
}

/** 플레이어 전원이 제시어 선택부터 모든 단계를 끝낼 때까지 자동으로 진행 */
export async function playThrough(players: { c: Client<RoomSnapshot>; name: string }[], onStage?: (stage: number) => Promise<void>): Promise<void> {
  // 제시어
  for (const p of players) {
    await p.c.waitFor((c) => !!c.snapshot?.promptSelection || c.snapshot?.status === 'PLAYING', 15000, 'prompt');
    const ps = p.c.snapshot?.promptSelection;
    if (ps && !ps.submitted) {
      const text = ps.mode === 'choice' ? ps.candidates[0]! : `${p.name}의 제시어`;
      await p.c.command({ type: 'prompt.choose', gameId: ps.gameId, stageId: ps.stageId, text });
    }
  }
  const first = players[0]!.c;
  await first.waitStatus('PLAYING');
  const stageCount = first.snapshot!.stageCount;
  for (let s = 1; s <= stageCount; s++) {
    for (const p of players) {
      await p.c.waitFor((c) => c.snapshot?.status !== 'PLAYING' || (c.snapshot.stage === s && (!!c.snapshot.assignment || !c.snapshot.me.isPlayer)), 20000, `stage ${s} for ${p.name}`);
    }
    if (onStage) await onStage(s);
    for (const p of players) {
      if (p.c.snapshot?.status === 'PLAYING' && p.c.snapshot.stage === s) await submitCurrent(p.c, p.name);
    }
  }
  await first.waitStatus('REVEAL_READY');
}
