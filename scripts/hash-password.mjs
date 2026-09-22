#!/usr/bin/env node
/**
 * 교사 비밀번호 해시 생성기.
 *   npm run hash-password -- "비밀번호"
 * 출력된 문자열을 TEACHER_ACCOUNTS 의 passwordHash 에 넣는다.
 * 형식: pbkdf2-sha256$<iterations>$<saltBase64>$<hashBase64> (worker/lib/password.ts 와 동일)
 */
import { webcrypto } from 'node:crypto';

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('사용법: npm run hash-password -- "8자 이상의 비밀번호"');
  process.exit(1);
}
const iterations = 210000;
const salt = new Uint8Array(16);
webcrypto.getRandomValues(salt);
const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
const b64 = (u8) => Buffer.from(u8).toString('base64');
console.log(`pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
