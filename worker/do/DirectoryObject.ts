/**
 * DirectoryObject (단일 인스턴스 "directory")
 *  - 교사 로그인 검증 · 세션 저장 · 로그인 실패 빈도 제한
 *  - 클래스 코드 → classId 색인, 교사별 클래스 목록
 * 교사 계정 자체는 환경 변수(TEACHER_ACCOUNTS 비밀)에서 읽는다. 임시 수업 데이터와 분리된다.
 */
import { DurableObject } from 'cloudflare:workers';
import { LIMITS } from '@shared/types';
import { isValidCode, randomCode, randomId, randomToken } from '@shared/ids';
import { parseTeacherAccounts, type Env } from '../lib/env';
import { verifyPassword } from '../lib/password';
import { RateLimiter } from '../lib/rate';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;

export interface TeacherSessionInfo {
  teacherId: string;
  name: string;
}

export interface ClassIndexRow {
  classId: string;
  name: string;
  code: string;
  createdAt: number;
  ended: boolean;
}

export class DirectoryObject extends DurableObject<Env> {
  private lookupLimiter = new RateLimiter(30, 60_000);
  private joinLimiter = new RateLimiter(20, 60_000);
  private createLimiter = new RateLimiter(10, 60_000);
  private createLimiterDev = new RateLimiter(500, 60_000);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS login_fails (
          key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS classes (
          class_id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS classes_teacher ON classes(teacher_id);
      `);
    });
  }

  // ---------- 교사 인증 ----------

  async login(username: string, password: string, ip: string): Promise<{ ok: true; sessionId: string; teacher: TeacherSessionInfo } | { ok: false; error: string; message: string }> {
    const now = Date.now();
    const keys = [`ip:${ip}`, `user:${username.toLowerCase()}`];
    for (const key of keys) {
      const row = this.ctx.storage.sql.exec('SELECT window_start, count FROM login_fails WHERE key = ?', key).toArray()[0] as { window_start: number; count: number } | undefined;
      if (row && now - row.window_start < LOGIN_WINDOW_MS && row.count >= LOGIN_MAX_FAILS) {
        return { ok: false, error: 'rate_limited', message: '로그인 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요.' };
      }
    }
    const account = parseTeacherAccounts(this.env).find((a) => a.username.toLowerCase() === username.toLowerCase());
    const ok = account ? await verifyPassword(password, account.passwordHash) : false;
    if (!ok || !account) {
      for (const key of keys) {
        const row = this.ctx.storage.sql.exec('SELECT window_start, count FROM login_fails WHERE key = ?', key).toArray()[0] as { window_start: number; count: number } | undefined;
        if (row && now - row.window_start < LOGIN_WINDOW_MS) {
          this.ctx.storage.sql.exec('UPDATE login_fails SET count = count + 1 WHERE key = ?', key);
        } else {
          this.ctx.storage.sql.exec('INSERT OR REPLACE INTO login_fails (key, window_start, count) VALUES (?, ?, 1)', key, now);
        }
      }
      return { ok: false, error: 'invalid_credentials', message: '아이디 또는 비밀번호가 맞지 않아요.' };
    }
    for (const key of keys) this.ctx.storage.sql.exec('DELETE FROM login_fails WHERE key = ?', key);
    const sessionId = randomToken(32);
    this.ctx.storage.sql.exec('INSERT INTO sessions (id, teacher_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sessionId, account.id, now, now + SESSION_TTL_MS);
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE expires_at < ?', now);
    return { ok: true, sessionId, teacher: { teacherId: account.id, name: account.name } };
  }

  async verifySession(sessionId: string): Promise<TeacherSessionInfo | null> {
    if (!sessionId) return null;
    const row = this.ctx.storage.sql.exec('SELECT teacher_id, expires_at FROM sessions WHERE id = ?', sessionId).toArray()[0] as { teacher_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    const account = parseTeacherAccounts(this.env).find((a) => a.id === row.teacher_id);
    if (!account) return null; // 계정이 설정에서 사라지면 세션도 무효
    return { teacherId: account.id, name: account.name };
  }

  async logout(sessionId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId);
  }

  // ---------- 클래스 색인 ----------

  async createClass(teacherId: string, name: string): Promise<{ ok: true; classId: string; code: string } | { ok: false; error: string; message: string }> {
    const limiter = this.env.ENVIRONMENT === 'production' ? this.createLimiter : this.createLimiterDev;
    if (!limiter.hit(`create:${teacherId}`)) {
      return { ok: false, error: 'rate_limited', message: '클래스 생성 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' };
    }
    const now = Date.now();
    // 만료된 클래스 색인 정리 (ClassObject 가 스스로 만료 통지를 못 했을 때의 안전장치)
    this.ctx.storage.sql.exec('DELETE FROM classes WHERE ended = 1 AND created_at < ?', now - LIMITS.dataTtlMs * 2);
    const classId = randomId('c');
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = randomCode(6);
      const exists = this.ctx.storage.sql.exec('SELECT 1 FROM classes WHERE code = ?', code).toArray().length > 0;
      if (exists) continue;
      this.ctx.storage.sql.exec('INSERT INTO classes (class_id, teacher_id, name, code, created_at, ended) VALUES (?, ?, ?, ?, ?, 0)', classId, teacherId, name, code, now);
      return { ok: true, classId, code };
    }
    return { ok: false, error: 'code_collision', message: '입장 코드를 만들지 못했어요. 다시 시도해 주세요.' };
  }

  async listClasses(teacherId: string): Promise<ClassIndexRow[]> {
    return this.ctx.storage.sql
      .exec('SELECT class_id, name, code, created_at, ended FROM classes WHERE teacher_id = ? ORDER BY created_at DESC', teacherId)
      .toArray()
      .map((r) => ({ classId: r.class_id as string, name: r.name as string, code: r.code as string, createdAt: r.created_at as number, ended: !!(r.ended as number) }));
  }

  async ownerOf(classId: string): Promise<string | null> {
    const row = this.ctx.storage.sql.exec('SELECT teacher_id FROM classes WHERE class_id = ?', classId).toArray()[0];
    return row ? (row.teacher_id as string) : null;
  }

  async lookupCode(code: string, ip: string): Promise<{ ok: true; classId: string } | { ok: false; error: string; message: string }> {
    if (!this.lookupLimiter.hit(`lookup:${ip}`)) return { ok: false, error: 'rate_limited', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' };
    if (!isValidCode(code)) return { ok: false, error: 'not_found', message: '클래스를 찾을 수 없어요. 코드를 다시 확인해 주세요.' };
    const row = this.ctx.storage.sql.exec('SELECT class_id, ended FROM classes WHERE code = ?', code).toArray()[0] as { class_id: string; ended: number } | undefined;
    if (!row || row.ended) return { ok: false, error: 'not_found', message: '클래스를 찾을 수 없어요. 코드를 다시 확인해 주세요.' };
    return { ok: true, classId: row.class_id };
  }

  async allowJoin(ip: string): Promise<boolean> {
    return this.joinLimiter.hit(`join:${ip}`);
  }

  async classEnded(classId: string): Promise<void> {
    // 코드는 재사용될 수 있도록 색인에서 비운다 (UNIQUE 제약을 피하려 접미사를 붙여 보관)
    const row = this.ctx.storage.sql.exec('SELECT code FROM classes WHERE class_id = ?', classId).toArray()[0];
    if (!row) return;
    const code = row.code as string;
    if (!code.includes('#')) {
      this.ctx.storage.sql.exec('UPDATE classes SET ended = 1, code = ? WHERE class_id = ?', `${code}#${classId}`, classId);
    }
  }

  async deleteClass(classId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM classes WHERE class_id = ?', classId);
  }
}
