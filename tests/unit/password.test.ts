import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../worker/lib/password';
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
