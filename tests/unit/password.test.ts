import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hashPassword, MAX_ITERATIONS, verifyPassword } from '../../worker/lib/password';
import { RateLimiter } from '../../worker/lib/rate';
import { pickPromptCandidates, PROMPTS } from '../../worker/lib/prompts';

describe('비밀번호 해시', () => {
  it('salt 포함 PBKDF2, 검증 성공/실패', async () => {
    const h = await hashPassword('secret-pass-1', 20_000);
    expect(h.startsWith('pbkdf2-sha256$20000$')).toBe(true);
    expect(await verifyPassword('secret-pass-1', h)).toBe(true);
    expect(await verifyPassword('secret-pass-2', h)).toBe(false);
    const h2 = await hashPassword('secret-pass-1', 20_000);
    expect(h2).not.toBe(h); // salt 가 다르다
  });
  it('형식이 깨진 해시는 거부', async () => {
    expect(await verifyPassword('x', 'plain')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256$10$a$b')).toBe(false);
  });

  // Cloudflare Workers 의 WebCrypto 는 10만 회를 넘는 PBKDF2 를 거부한다.
  // 로컬 workerd 는 이 제한을 적용하지 않아 배포 후에야 드러났다 — 상수로 고정한다.
  it('반복 횟수는 Workers 한도(100000) 이하', async () => {
    expect(MAX_ITERATIONS).toBeLessThanOrEqual(100_000);
    const h = await hashPassword('workers-limit-test');
    expect(Number(h.split('$')[1])).toBeLessThanOrEqual(100_000);
    await expect(hashPassword('x', 210_000)).rejects.toThrow();
  });

  it('한도를 넘는 해시는 예외 대신 인증 실패로 처리', async () => {
    const over = 'pbkdf2-sha256$210000$' + Buffer.alloc(16).toString('base64') + '$' + Buffer.alloc(32).toString('base64');
    expect(await verifyPassword('any', over)).toBe(false);
  });

  it('hash-password 스크립트 출력도 한도를 지키고 서버가 검증한다', async () => {
    const out = execFileSync(process.execPath, ['scripts/hash-password.mjs', 'script-round-trip-pw'], { encoding: 'utf8' }).trim();
    expect(Number(out.split('$')[1])).toBeLessThanOrEqual(100_000);
    expect(await verifyPassword('script-round-trip-pw', out)).toBe(true);
    expect(await verifyPassword('wrong', out)).toBe(false);
  });
});

describe('빈도 제한', () => {
  it('창 안에서 limit 까지 허용', () => {
    const r = new RateLimiter(3, 1000);
    expect(r.hit('a', 0)).toBe(true);
    expect(r.hit('a', 1)).toBe(true);
    expect(r.hit('a', 2)).toBe(true);
    expect(r.hit('a', 3)).toBe(false);
    expect(r.hit('a', 1001)).toBe(true);
    expect(r.hit('b', 3)).toBe(true);
  });
});

describe('제시어', () => {
  it('200개 이상, 중복 없음, 40자 이하', () => {
    expect(PROMPTS.length).toBeGreaterThanOrEqual(200);
    expect(new Set(PROMPTS).size).toBe(PROMPTS.length);
    for (const p of PROMPTS) expect(p.length).toBeLessThanOrEqual(40);
  });
  it('후보 3개는 서로 다르고 제외 목록을 피한다', () => {
    const exclude = new Set(PROMPTS.slice(0, 100));
    const c = pickPromptCandidates(Math.random, 3, exclude);
    expect(c).toHaveLength(3);
    expect(new Set(c).size).toBe(3);
    for (const x of c) expect(exclude.has(x)).toBe(false);
  });
});
