/**
 * PBKDF2-SHA256 비밀번호 해시 (WebCrypto). 형식:
 *   pbkdf2-sha256$<iterations>$<saltBase64>$<hashBase64>
 * scripts/hash-password.mjs 도 같은 형식을 만든다.
 *
 * Cloudflare Workers 의 WebCrypto 는 PBKDF2 반복 횟수를 10만 회까지만 허용한다
 * ("iteration counts above 100000 are not supported"). 로컬 workerd 는 이 제한을 적용하지
 * 않으므로, 더 큰 값을 쓰면 로컬에서만 통과하고 배포 후 로그인이 실패한다.
 */
export const MAX_ITERATIONS = 100_000;
const DEFAULT_ITERATIONS = MAX_ITERATIONS;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  if (iterations > MAX_ITERATIONS) throw new Error(`반복 횟수는 ${MAX_ITERATIONS} 이하여야 합니다 (Cloudflare Workers 제한)`);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000) return false;
  if (iterations > MAX_ITERATIONS) {
    // 운영자에게 원인을 알린다. 비밀번호·해시는 남기지 않는다.
    console.warn(`저장된 비밀번호 해시의 반복 횟수(${iterations})가 Workers 한도 ${MAX_ITERATIONS}를 넘습니다. npm run hash-password 로 다시 만들어 TEACHER_ACCOUNTS 를 갱신하세요.`);
    return false;
  }
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]!);
    expected = fromBase64(parts[3]!);
  } catch {
    return false;
  }
  let actual: Uint8Array;
  try {
    actual = await derive(password, salt, iterations);
  } catch {
    // 플랫폼이 거부한 파라미터 등 — 500 대신 인증 실패로 처리한다
    return false;
  }
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
