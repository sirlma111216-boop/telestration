import type { Env } from './env';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: code, message }, { status });
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie') ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function allowedOrigins(env: Env, request: Request): Set<string> {
  const set = new Set<string>();
  set.add(new URL(request.url).origin);
  for (const o of (env.ALLOWED_ORIGINS ?? '').split(',')) {
    const t = o.trim();
    if (t) set.add(t);
  }
  return set;
}

/**
 * 상태 변경 요청과 WebSocket 업그레이드는 Origin 이 허용 목록(또는 자기 자신)과 일치해야 한다.
 * 브라우저는 Origin 헤더를 위조할 수 없으므로 CSRF 방어로 충분하다.
 */
export function assertTrustedOrigin(env: Env, request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) {
    // 브라우저 fetch/WS 는 항상 Origin 을 보낸다. 없으면 비브라우저 클라이언트로 보고 거부.
    throw new HttpError(403, 'bad_origin', '허용되지 않은 요청 출처입니다');
  }
  if (!allowedOrigins(env, request).has(origin)) {
    throw new HttpError(403, 'bad_origin', '허용되지 않은 요청 출처입니다');
  }
}

/** 운영에서는 Cloudflare 가 넣는 cf-connecting-ip 만 믿는다. 로컬 개발·테스트(ENVIRONMENT !== 'production')에서는 x-forwarded-for 로 흉내낼 수 있다. */
export function clientIp(request: Request, env?: Env): string {
  if (env && env.ENVIRONMENT !== 'production') {
    const fake = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (fake) return fake;
  }
  return request.headers.get('cf-connecting-ip') ?? 'local';
}

export async function readJson<T>(request: Request, maxBytes = 64_000): Promise<T> {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', '요청이 너무 큽니다');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'bad_json', '요청 형식이 올바르지 않습니다');
  }
}

export function teacherCookie(sessionId: string | null, request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  if (!sessionId) return `pr_teacher=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `pr_teacher=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}${secure}`;
}
