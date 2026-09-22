/**
 * Worker 진입점 — HTTP API 와 WebSocket 업그레이드를 Durable Object 로 연결한다.
 * 사용자 신원은 항상 서버가 세션(교사 쿠키 / 학생 토큰)에서 도출하며, 클라이언트가 보낸 userId 는 믿지 않는다.
 */
import { canonicalCode } from '@shared/ids';
import { sanitizeText } from '@shared/validation';
import { LIMITS } from '@shared/types';
import type { Env, Identity } from './lib/env';
import { assertTrustedOrigin, clientIp, errorResponse, HttpError, json, parseCookies, readJson, teacherCookie } from './lib/http';

export { DirectoryObject } from './do/DirectoryObject';
export { ClassObject } from './do/ClassObject';
export { RoomObject } from './do/RoomObject';

function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
}
function classStub(env: Env, classId: string) {
  return env.CLASSES.get(env.CLASSES.idFromName(classId));
}
function roomStub(env: Env, roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

async function teacherFromRequest(env: Env, request: Request): Promise<Extract<Identity, { kind: 'teacher' }> | null> {
  const sid = parseCookies(request).pr_teacher;
  if (!sid) return null;
  const info = await directory(env).verifySession(sid);
  if (!info) return null;
  return { kind: 'teacher', teacherId: info.teacherId, name: info.name };
}

async function studentFromToken(env: Env, token: string | null): Promise<Extract<Identity, { kind: 'student' }> | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const classId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^c_[0-9a-f]{24}$/.test(classId) || secret.length < 20 || secret.length > 100) return null;
  const id = await classStub(env, classId).authenticate(secret);
  if (!id || id.kind !== 'student') return null;
  return { kind: 'student', classId: id.classId, studentId: id.studentId, nickname: id.nickname, displayName: id.displayName, hostGrant: id.hostGrant, currentRoomId: id.currentRoomId };
}

function bearer(request: Request): string | null {
  const h = request.headers.get('authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

async function requireTeacherOwning(env: Env, request: Request, classId: string): Promise<Extract<Identity, { kind: 'teacher' }>> {
  const teacher = await teacherFromRequest(env, request);
  if (!teacher) throw new HttpError(401, 'unauthorized', '교사 로그인이 필요해요');
  const owner = await directory(env).ownerOf(classId);
  if (owner !== teacher.teacherId) throw new HttpError(403, 'forbidden', '내가 만든 클래스가 아니에요');
  return teacher;
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (method !== 'GET') assertTrustedOrigin(env, request);

  // ---------- 교사 ----------
  if (path === '/api/teacher/login' && method === 'POST') {
    const body = await readJson<{ username?: unknown; password?: unknown }>(request);
    const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    if (!username || !password) throw new HttpError(400, 'invalid', '아이디와 비밀번호를 입력해 주세요');
    const res = await directory(env).login(username, password, clientIp(request, env));
    if (!res.ok) return errorResponse(res.error === 'rate_limited' ? 429 : 401, res.error, res.message);
    return json({ teacher: res.teacher }, { headers: { 'set-cookie': teacherCookie(res.sessionId, request) } });
  }
  if (path === '/api/teacher/logout' && method === 'POST') {
    const sid = parseCookies(request).pr_teacher;
    if (sid) await directory(env).logout(sid);
    return json({ ok: true }, { headers: { 'set-cookie': teacherCookie(null, request) } });
  }
  if (path === '/api/teacher/me' && method === 'GET') {
    const teacher = await teacherFromRequest(env, request);
    if (!teacher) return errorResponse(401, 'unauthorized', '로그인이 필요해요');
    return json({ teacher: { teacherId: teacher.teacherId, name: teacher.name } });
  }
  if (path === '/api/teacher/classes' && method === 'GET') {
    const teacher = await teacherFromRequest(env, request);
    if (!teacher) return errorResponse(401, 'unauthorized', '로그인이 필요해요');
    const classes = await directory(env).listClasses(teacher.teacherId);
    return json({ classes: classes.filter((c) => !c.ended) });
  }
  if (path === '/api/teacher/classes' && method === 'POST') {
    const teacher = await teacherFromRequest(env, request);
    if (!teacher) return errorResponse(401, 'unauthorized', '로그인이 필요해요');
    const body = await readJson<{ name?: unknown }>(request);
    let name: string;
    try {
      name = sanitizeText(body.name, LIMITS.classNameMax);
    } catch (e) {
      throw new HttpError(400, 'invalid', e instanceof Error ? e.message : '이름이 올바르지 않아요');
    }
    if (name.length === 0) throw new HttpError(400, 'invalid', '클래스 이름을 입력해 주세요');
    const res = await directory(env).createClass(teacher.teacherId, name);
    if (!res.ok) return errorResponse(res.error === 'rate_limited' ? 429 : 500, res.error, res.message);
    await classStub(env, res.classId).init({ classId: res.classId, name, code: res.code, teacherId: teacher.teacherId, teacherName: teacher.name });
    return json({ classId: res.classId, code: res.code, name });
  }
  const teacherClassMatch = path.match(/^\/api\/teacher\/classes\/(c_[0-9a-f]{24})$/);
  if (teacherClassMatch && method === 'GET') {
    const classId = teacherClassMatch[1]!;
    const teacher = await requireTeacherOwning(env, request, classId);
    const snap = await classStub(env, classId).snapshotFor(teacher);
    if (!snap) return errorResponse(404, 'not_found', '클래스를 찾을 수 없어요');
    return json({ snapshot: snap });
  }

  // ---------- 학생 ----------
  if (path === '/api/class/lookup' && method === 'GET') {
    const code = canonicalCode(url.searchParams.get('code') ?? '');
    const res = await directory(env).lookupCode(code, clientIp(request, env));
    if (!res.ok) return errorResponse(res.error === 'rate_limited' ? 429 : 404, res.error, res.message);
    const info = await classStub(env, res.classId).info();
    if (!info || info.ended) return errorResponse(404, 'not_found', '클래스를 찾을 수 없어요');
    return json({ classId: info.classId, name: info.name, locked: info.locked });
  }
  if (path === '/api/class/join' && method === 'POST') {
    if (!(await directory(env).allowJoin(clientIp(request, env)))) return errorResponse(429, 'rate_limited', '잠시 후 다시 시도해 주세요');
    const body = await readJson<{ code?: unknown; nickname?: unknown }>(request);
    const code = canonicalCode(typeof body.code === 'string' ? body.code : '');
    const res = await directory(env).lookupCode(code, clientIp(request, env));
    if (!res.ok) return errorResponse(res.error === 'rate_limited' ? 429 : 404, res.error, res.message);
    const joined = await classStub(env, res.classId).joinClass(body.nickname);
    if (!joined.ok) return errorResponse(joined.error === 'locked' ? 423 : 400, joined.error, joined.message);
    return json({ classId: joined.classId, studentId: joined.studentId, token: joined.token, displayName: joined.displayName });
  }
  if (path === '/api/student/me' && method === 'GET') {
    const student = await studentFromToken(env, bearer(request));
    if (!student) return errorResponse(401, 'unauthorized', '세션이 만료되었어요. 클래스에 다시 참여해 주세요.');
    const info = await classStub(env, student.classId).info();
    return json({ student: { classId: student.classId, studentId: student.studentId, displayName: student.displayName, hostGrant: student.hostGrant, currentRoomId: student.currentRoomId }, class: info });
  }
  return errorResponse(404, 'not_found', '알 수 없는 API');
}

async function handleWs(request: Request, env: Env, url: URL): Promise<Response> {
  assertTrustedOrigin(env, request);
  if (request.headers.get('upgrade') !== 'websocket') throw new HttpError(426, 'upgrade_required', 'WebSocket 연결이 필요해요');
  const classMatch = url.pathname.match(/^\/ws\/class\/(c_[0-9a-f]{24})$/);
  const roomMatch = url.pathname.match(/^\/ws\/room\/(r_[0-9a-f]{24})$/);
  const as = url.searchParams.get('as');
  let identity: Identity | null = null;
  if (as === 'teacher') identity = await teacherFromRequest(env, request);
  else identity = await studentFromToken(env, url.searchParams.get('token'));
  if (!identity) throw new HttpError(401, 'unauthorized', '세션이 만료되었어요');

  const forward = (stub: DurableObjectStub) => {
    const headers = new Headers(request.headers);
    headers.set('x-identity', JSON.stringify(identity));
    return stub.fetch(new Request(request.url, { headers, method: 'GET' }));
  };

  if (classMatch) {
    const classId = classMatch[1]!;
    if (identity.kind === 'student' && identity.classId !== classId) throw new HttpError(403, 'forbidden', '다른 클래스예요');
    if (identity.kind === 'teacher') {
      const owner = await directory(env).ownerOf(classId);
      if (owner !== identity.teacherId) throw new HttpError(403, 'forbidden', '내가 만든 클래스가 아니에요');
    }
    return forward(classStub(env, classId));
  }
  if (roomMatch) {
    // RoomObject 가 classId 일치와 방 소속을 검증한다
    return forward(roomStub(env, roomMatch[1]!));
  }
  throw new HttpError(404, 'not_found', '알 수 없는 경로');
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        const res = await handleApi(request, env, url);
        return res;
      }
      if (url.pathname.startsWith('/ws/')) return await handleWs(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e.status, e.code, e.message);
      console.error('unhandled', e instanceof Error ? e.message : String(e));
      return errorResponse(500, 'internal', '서버 오류가 발생했어요');
    }
  },
} satisfies ExportedHandler<Env>;
