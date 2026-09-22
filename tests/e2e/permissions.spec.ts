/** 권한·클래스 관리 (명세 18절 첫 묶음). 브라우저 없이 프로토콜 수준에서 검증한다. */
import { expect, test } from '@playwright/test';
import { BASE, ORIGIN, classSocket, fakeIp, createClass, joinClass, roomSocket, sleep, teacherApi, teacherClassSocket, teacherLogin } from './harness';
import { setupRoom, teardown } from './setup';

test.describe('교사 인증과 클래스 격리', () => {
  test('미인증 사용자는 교사 API 를 쓸 수 없다', async () => {
    const r = await teacherApi(null, '/api/teacher/classes');
    expect(r.status).toBe(401);
    const c = await teacherApi(null, '/api/teacher/classes', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    expect(c.status).toBe(401);
  });

  test('잘못된 비밀번호는 거부되고 반복 실패는 제한된다', async () => {
    const ip = fakeIp();
    const res = await fetch(`${BASE}/api/teacher/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': ip }, body: JSON.stringify({ username: 'demo', password: 'wrong' }) });
    expect(res.status).toBe(401);
    // 같은 IP 에서 8회 실패 → 이후 429
    let last = 0;
    for (let i = 0; i < 9; i++) {
      const r = await fetch(`${BASE}/api/teacher/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': ip }, body: JSON.stringify({ username: `nobody-${i}`, password: 'x' }) });
      last = r.status;
    }
    expect(last).toBe(429);
    // 다른 IP 의 올바른 로그인은 영향받지 않는다
    const ok = await fetch(`${BASE}/api/teacher/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': fakeIp() }, body: JSON.stringify({ username: 'demo', password: 'teacher-demo-1234' }) });
    expect(ok.status).toBe(200);
  });

  test('Origin 이 없는 상태 변경 요청은 거부된다 (CSRF)', async () => {
    const res = await fetch(`${BASE}/api/class/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABCDEF', nickname: '해커' }) });
    expect(res.status).toBe(403);
    const bad = await fetch(`${BASE}/api/class/join`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ code: 'ABCDEF', nickname: '해커' }) });
    expect(bad.status).toBe(403);
  });

  test('교사는 자기 클래스만 볼 수 있다 (다른 교사 세션 격리)', async () => {
    const t = await teacherLogin();
    const cls = await createClass(t, '격리');
    const mine = await teacherApi<{ snapshot: { classId: string } }>(t, `/api/teacher/classes/${cls.classId}`);
    expect(mine.status).toBe(200);
    // 세션 쿠키를 위조한 요청은 401
    const forged = await teacherApi<unknown>({ cookie: 'pr_teacher=forged-session', teacherId: 'x', name: 'x' }, `/api/teacher/classes/${cls.classId}`);
    expect(forged.status).toBe(401);
    // 로그아웃 후 같은 쿠키는 무효
    await teacherApi(t, '/api/teacher/logout', { method: 'POST', body: '{}' });
    const after = await teacherApi(t, `/api/teacher/classes/${cls.classId}`);
    expect(after.status).toBe(401);
  });

  test('닉네임·코드만으로는 다른 학생 세션을 쓸 수 없다', async () => {
    const t = await teacherLogin();
    const cls = await createClass(t, '세션');
    const a = await joinClass(cls.code, '가나');
    const forged = await fetch(`${BASE}/api/student/me`, { headers: { authorization: `Bearer ${a.classId}.notarealtoken0000000000000` } });
    expect(forged.status).toBe(401);
    const real = await fetch(`${BASE}/api/student/me`, { headers: { authorization: `Bearer ${a.token}` } });
    expect(real.status).toBe(200);
    // 같은 닉네임으로 다시 참여하면 다른 학생(번호 붙음)
    const b = await joinClass(cls.code, '가나');
    expect(b.studentId).not.toBe(a.studentId);
    expect(b.displayName).toBe('가나(2)');
  });
});

test.describe('명단·방장 자격·방 생성 권한', () => {
  test('학생 참여가 교사 화면에 실시간 반영되고, 방장 자격 부여·회수가 열린 연결에 적용된다', async () => {
    const t = await teacherLogin();
    const cls = await createClass(t, '실시간');
    const tc = teacherClassSocket(t, cls.classId);
    await tc.opened;
    const s = await joinClass(cls.code, '학생');
    await tc.waitFor((c) => c.snapshot?.members.some((m) => m.studentId === s.studentId) ?? false, 5000, 'member appears');
    const cs = classSocket(s);
    await cs.opened;
    await tc.waitFor((c) => c.snapshot?.members.find((m) => m.studentId === s.studentId)?.connected === true, 5000, 'connected');

    // 일반 학생은 방을 만들 수 없다
    const denied = await cs.tryCommand({ type: 'room.create', title: '몰래', capacity: 4, hostMode: 'observe' });
    expect(denied.ok).toBe(false);

    await tc.command({ type: 'class.grantHost', studentId: s.studentId, grant: true });
    await cs.waitFor((c) => c.snapshot?.me.hostGrant === true, 5000, 'grant visible');
    const { roomId } = await cs.command<{ roomId: string }>({ type: 'room.create', title: '내 방', capacity: 4, hostMode: 'observe' });
    const room = roomSocket(s, roomId);
    await room.opened;
    expect(room.snapshot?.me.canControl).toBe(true);

    // 회수 → 열린 방 연결의 진행권도 즉시 사라진다
    await tc.command({ type: 'class.grantHost', studentId: s.studentId, grant: false });
    await room.waitFor((c) => c.snapshot?.me.canControl === false, 5000, 'control revoked');
    expect(room.snapshot?.host.userId).toBeNull();
    const again = await cs.tryCommand({ type: 'room.create', title: '다시', capacity: 4, hostMode: 'observe' });
    expect(again.ok).toBe(false);
    // 교사는 진행권을 인수할 수 있다
    await tc.command({ type: 'room.takeOver', roomId });
    await room.waitFor((c) => c.snapshot?.host.userId === `teacher:${t.teacherId}`, 5000, 'teacher host');
    // 회수된 학생의 설정 변경은 거부
    const upd = await room.tryCommand({ type: 'room.updateSettings', expectedVersion: room.snapshot!.version, capacity: 6 });
    expect(upd.ok).toBe(false);
    tc.close();
    cs.close();
    room.close();
  });

  test('다른 클래스의 방에는 접근할 수 없다', async () => {
    const f = await setupRoom(0, 'observe', { ready: false });
    const t2 = await teacherLogin();
    const other = await createClass(t2, '다른 클래스');
    const stranger = await joinClass(other.code, '외부인');
    const cs = classSocket(stranger);
    await cs.opened;
    const r = await cs.tryCommand({ type: 'room.join', roomId: f.roomId });
    expect(r.ok).toBe(false);
    const ws = roomSocket(stranger, f.roomId);
    await expect(ws.opened).rejects.toThrow();
    cs.close();
    teardown(f);
  });

  test('한 학생은 동시에 하나의 방에만 소속된다', async () => {
    const f = await setupRoom(1, 'observe', { ready: false });
    const { roomId: second } = await f.hostClass.tryCommand({ type: 'room.create', title: '두번째', capacity: 4, hostMode: 'observe' }).then((r) => (r.ok ? (r.result as { roomId: string }) : { roomId: '' }));
    // 방장은 이미 첫 방을 운영 중이므로 두 번째 방을 만들 수 없다
    expect(second).toBe('');
    // 교사가 두 번째 방을 만든다
    const created = await f.tc.command<{ roomId: string }>({ type: 'room.create', title: '교사 방', capacity: 4, hostMode: 'observe' });
    const p = f.players[0]!;
    const r = await p.cs.tryCommand({ type: 'room.join', roomId: created.roomId });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.message).toContain('이미 다른 방');
    // 첫 방에서 나가면 들어갈 수 있다
    await p.c.command({ type: 'room.leave' });
    await p.cs.waitFor((c) => c.snapshot?.me.currentRoomId === null, 5000, 'left');
    const ok = await p.cs.tryCommand({ type: 'room.join', roomId: created.roomId });
    expect(ok.ok).toBe(true);
    teardown(f);
  });

  test('동시 입장 요청에서도 정원을 넘지 않는다', async () => {
    const t = await teacherLogin();
    const cls = await createClass(t, '정원');
    const tc = teacherClassSocket(t, cls.classId);
    await tc.opened;
    const { roomId } = await tc.command<{ roomId: string }>({ type: 'room.create', title: '4인 제한', capacity: 4, hostMode: 'observe' });
    const sockets = [];
    for (let i = 0; i < 7; i++) {
      const s = await joinClass(cls.code, `동시${i}`);
      const cs = classSocket(s);
      await cs.opened;
      sockets.push(cs);
    }
    const results = await Promise.all(sockets.map((cs) => cs.tryCommand({ type: 'room.join', roomId })));
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(4);
    await tc.waitFor((c) => c.snapshot?.rooms.find((r) => r.roomId === roomId)?.playerCount === 4, 5000, 'playerCount 4');
    expect(tc.snapshot!.members.filter((m) => m.currentRoomId === roomId).length).toBe(4);
    for (const cs of sockets) cs.close();
    tc.close();
  });

  test('교사가 학생을 내보내면 세션이 무효화되고 방에서도 빠진다', async () => {
    const f = await setupRoom(2, 'observe', { ready: false });
    const p = f.players[0]!;
    await f.tc.command({ type: 'class.kick', studentId: p.student.studentId });
    await p.c.waitFor((c) => c.closed !== null, 5000, 'room socket closed');
    await p.cs.waitFor((c) => c.closed !== null, 5000, 'class socket closed');
    const me = await fetch(`${BASE}/api/student/me`, { headers: { authorization: `Bearer ${p.student.token}` } });
    expect(me.status).toBe(401);
    await f.host.waitFor((c) => !c.snapshot?.members.some((m) => m.userId === p.student.studentId), 5000, 'removed from room');
    teardown(f);
  });

  test('입장 예약: 존재하지 않는 방·닫힌 방은 거부되고 소속이 남지 않는다', async () => {
    const f = await setupRoom(1, 'observe', { ready: false });
    const p = f.players[0]!;
    await p.c.command({ type: 'room.leave' });
    await p.cs.waitFor((c) => c.snapshot?.me.currentRoomId === null, 5000, 'left');
    const ghost = await p.cs.tryCommand({ type: 'room.join', roomId: 'r_ffffffffffffffffffffffff' });
    expect(ghost.ok).toBe(false);
    await f.host.command({ type: 'room.close', confirm: true });
    await f.tc.waitFor((c) => !c.snapshot?.rooms.some((r) => r.roomId === f.roomId), 5000, 'room removed');
    const closed = await p.cs.tryCommand({ type: 'room.join', roomId: f.roomId });
    expect(closed.ok).toBe(false);
    await sleep(200);
    expect(p.cs.snapshot?.me.currentRoomId).toBeNull();
    teardown(f);
  });
});
