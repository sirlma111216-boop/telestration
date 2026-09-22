/** 공동 결과 공개 · 종료 · 재시작 (명세 18절) */
import { expect, test } from '@playwright/test';
import { BASE, ORIGIN, playThrough, roomSocket, sleep, teacherRoomSocket } from './harness';
import { allPlayers, setupRoom, teardown, type RoomFixture } from './setup';

async function toRevealing(f: RoomFixture): Promise<void> {
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  await playThrough(allPlayers(f));
  await f.host.command({ type: 'reveal.start', gameId: f.host.snapshot!.gameId, expectedVersion: f.host.snapshot!.version });
  await f.host.waitStatus('REVEALING');
}

test('방장이 참가자를 선택하고 넘기면 전원이 같은 항목으로 수렴하고, 학생은 미공개 내용을 받지 못한다', async () => {
  const f = await setupRoom(4, 'observe');
  await toRevealing(f);
  const books = f.host.snapshot!.revealBooks!;
  const students = f.players.map((p) => p.c);
  for (const s of students) {
    await s.waitStatus('REVEALING');
    expect(s.snapshot!.revealBooks).toBeNull();
    expect(s.snapshot!.reveal!.bookId).toBeNull();
  }
  const first = books[0]!;
  await f.host.command({ type: 'reveal.selectBook', gameId: f.host.snapshot!.gameId, bookId: first.bookId, expectedRevision: f.host.snapshot!.reveal!.revision });
  for (const s of students) await s.waitFor((c) => c.snapshot?.reveal?.bookId === first.bookId && c.snapshot.reveal.entryIndex === -1, 5000, 'cover');
  for (let i = 0; i < first.entryCount; i++) {
    await f.host.command({ type: 'reveal.step', gameId: f.host.snapshot!.gameId, direction: 1, expectedRevision: f.host.snapshot!.reveal!.revision });
    const rev = f.host.snapshot!.reveal!.revision;
    for (const s of students) {
      await s.waitFor((c) => c.snapshot?.reveal?.revision === rev, 5000, `student rev ${rev}`);
      const r = s.snapshot!.reveal!;
      expect(r.bookId).toBe(first.bookId);
      expect(r.entryIndex).toBe(i);
      expect(r.entry?.index).toBe(i);
      expect(r.entry?.kind).toBe(i === 0 ? 'prompt' : i % 2 === 1 ? 'drawing' : 'guess');
      // 스냅샷 전체에 다른 항목의 내용이 없다
      const json = JSON.stringify(s.snapshot);
      expect(json.includes('"revealBooks":null')).toBe(true);
    }
  }
  // 이전으로 돌아가면 학생도 따라온다
  await f.host.command({ type: 'reveal.step', gameId: f.host.snapshot!.gameId, direction: -1, expectedRevision: f.host.snapshot!.reveal!.revision });
  for (const s of students) await s.waitFor((c) => c.snapshot?.reveal?.entryIndex === first.entryCount - 2, 5000, 'back');
  teardown(f);
});

test('학생의 공개 명령·타 결과 요청은 거부되고, 오래된 revision 은 무시된다', async () => {
  const f = await setupRoom(4, 'observe');
  await toRevealing(f);
  const s = f.players[0]!.c;
  const g = f.host.snapshot!.gameId!;
  const b = f.host.snapshot!.revealBooks![1]!.bookId;
  for (const msg of [
    { type: 'reveal.selectBook', gameId: g, bookId: b, expectedRevision: f.host.snapshot!.reveal!.revision },
    { type: 'reveal.step', gameId: g, direction: 1, expectedRevision: f.host.snapshot!.reveal!.revision },
    { type: 'room.restart', expectedVersion: f.host.snapshot!.version },
    { type: 'room.close', confirm: true },
    { type: 'room.forceClose', confirm: true },
    { type: 'monitor.subscribe', subscribe: true },
  ]) {
    const r = await s.tryCommand(msg);
    expect(r.ok, msg.type).toBe(false);
  }
  // 학생 스냅샷은 여전히 표지 상태
  expect(s.snapshot!.reveal!.bookId).toBeNull();
  // 방장: 오래된 revision 으로 보낸 명령은 거부
  await f.host.command({ type: 'reveal.selectBook', gameId: g, bookId: b, expectedRevision: f.host.snapshot!.reveal!.revision });
  const staleRev = f.host.snapshot!.reveal!.revision - 1;
  const stale = await f.host.tryCommand({ type: 'reveal.step', gameId: g, direction: 1, expectedRevision: staleRev });
  expect(stale.ok).toBe(false);
  // 같은 revision 으로 두 번 동시에 → 하나만 성공
  const rev = f.host.snapshot!.reveal!.revision;
  const [r1, r2] = await Promise.all([f.host.tryCommand({ type: 'reveal.step', gameId: g, direction: 1, expectedRevision: rev }), f.host.tryCommand({ type: 'reveal.step', gameId: g, direction: 1, expectedRevision: rev })]);
  expect([r1.ok, r2.ok].filter(Boolean).length).toBe(1);
  expect(f.host.snapshot!.reveal!.entryIndex).toBe(0);
  teardown(f);
});

test('새로고침 후 현재 공동 화면으로 복귀하고, 건너뛴 책은 완료가 아니며, 모든 항목 공개 후에만 FINISHED', async () => {
  const f = await setupRoom(4, 'observe');
  await toRevealing(f);
  const g = f.host.snapshot!.gameId!;
  const books = f.host.snapshot!.revealBooks!;
  // 첫 책 절반만 공개하고 두 번째 책으로 이동
  await f.host.command({ type: 'reveal.selectBook', gameId: g, bookId: books[0]!.bookId, expectedRevision: f.host.snapshot!.reveal!.revision });
  await f.host.command({ type: 'reveal.step', gameId: g, direction: 1, expectedRevision: f.host.snapshot!.reveal!.revision });
  await f.host.command({ type: 'reveal.step', gameId: g, direction: 1, expectedRevision: f.host.snapshot!.reveal!.revision });
  await f.host.command({ type: 'reveal.selectBook', gameId: g, bookId: books[1]!.bookId, expectedRevision: f.host.snapshot!.reveal!.revision });
  expect(f.host.snapshot!.revealBooks!.find((b) => b.bookId === books[0]!.bookId)!.status).toBe('partial');
  // 학생 재접속 → 두 번째 책 표지
  const p = f.players[0]!;
  p.c.close();
  const again = roomSocket(p.student, f.roomId);
  await again.opened;
  expect(again.snapshot!.reveal!.bookId).toBe(books[1]!.bookId);
  expect(again.snapshot!.reveal!.entryIndex).toBe(-1);
  // 전체 공개 전 다시 시작 불가
  const early = await f.host.tryCommand({ type: 'room.restart', expectedVersion: f.host.snapshot!.version });
  expect(early.ok).toBe(false);
  const closeEarly = await f.host.tryCommand({ type: 'room.close', confirm: true });
  expect(closeEarly.ok).toBe(false);
  // 모든 책의 모든 항목 공개
  for (const b of books) {
    await f.host.command({ type: 'reveal.selectBook', gameId: g, bookId: b.bookId, expectedRevision: f.host.snapshot!.reveal!.revision });
    for (let i = 0; i < b.entryCount; i++) {
      if (f.host.snapshot!.status === 'FINISHED') break;
      await f.host.command({ type: 'reveal.step', gameId: g, direction: 1, expectedRevision: f.host.snapshot!.reveal!.revision });
    }
  }
  await f.host.waitStatus('FINISHED');
  await again.waitStatus('FINISHED');
  // FINISHED 이후에도 학생은 독립 탐색 불가 (명령 거부, 현재 항목만 보유)
  const nav = await again.tryCommand({ type: 'reveal.step', gameId: g, direction: -1, expectedRevision: again.snapshot!.reveal!.revision });
  expect(nav.ok).toBe(false);
  expect(again.snapshot!.revealBooks).toBeNull();
  expect(again.snapshot!.reveal!.entry?.index).toBe(again.snapshot!.reveal!.entryCount - 1);
  again.close();
  teardown(f);
});

test('다시 시작: 새 참가 인원 반영, 이전 판의 제출·공개 명령 무효, 새 gameId', async () => {
  const f = await setupRoom(4, 'observe');
  await toRevealing(f);
  const g = f.host.snapshot!.gameId!;
  for (const b of f.host.snapshot!.revealBooks!) {
    await f.host.command({ type: 'reveal.selectBook', gameId: g, bookId: b.bookId, expectedRevision: f.host.snapshot!.reveal!.revision });
    for (let i = 0; i < b.entryCount && f.host.snapshot!.status !== 'FINISHED'; i++) await f.host.command({ type: 'reveal.step', gameId: g, direction: 1, expectedRevision: f.host.snapshot!.reveal!.revision });
  }
  await f.host.waitStatus('FINISHED');
  const oldStage = f.players[0]!.c.snapshot!;
  await f.host.command({ type: 'room.restart', expectedVersion: f.host.snapshot!.version });
  await f.host.waitStatus('LOBBY');
  expect(f.host.snapshot!.gameId).toBeNull();
  expect(f.host.snapshot!.members.every((m) => !m.ready)).toBe(true);
  // 이전 판의 공개·제출 명령 무효
  const oldReveal = await f.host.tryCommand({ type: 'reveal.start', gameId: g, expectedVersion: f.host.snapshot!.version });
  expect(oldReveal.ok).toBe(false);
  const oldSubmit = await f.players[0]!.c.tryCommand({ type: 'entry.submit', gameId: g, stageId: 'st_old', payload: { kind: 'text', text: 'x' } });
  expect(oldSubmit.ok).toBe(false);
  // 한 명 나가고 새 학생 입장 → 4명으로 새 판
  await f.players[3]!.c.command({ type: 'room.leave' });
  const { joinClass, classSocket } = await import('./harness');
  const fresh = await joinClass(f.code, '새친구');
  const cs = classSocket(fresh);
  await cs.opened;
  await cs.command({ type: 'room.join', roomId: f.roomId });
  const nc = roomSocket(fresh, f.roomId);
  await nc.opened;
  const newPlayers = [...f.players.slice(0, 3).map((p) => ({ c: p.c, name: p.name })), { c: nc, name: '새친구' }];
  for (const p of newPlayers) await p.c.command({ type: 'room.ready', ready: true });
  await f.host.waitFor((c) => c.snapshot!.members.filter((m) => m.isPlayer).length === 4 && c.snapshot!.members.filter((m) => m.isPlayer).every((m) => m.ready), 5000, 'ready 4');
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  await f.host.waitStatus('PROMPT_SELECTION');
  expect(f.host.snapshot!.gameId).not.toBe(oldStage.gameId);
  await playThrough(newPlayers);
  expect(f.host.snapshot!.status).toBe('REVEAL_READY');
  nc.close();
  cs.close();
  teardown(f);
});

test('방 닫기: 학생은 로비로, 닫힌 방 재입장 거부, 늦은 요청 거부', async () => {
  const f = await setupRoom(4, 'observe');
  const p = f.players[0]!;
  await f.host.command({ type: 'room.close', confirm: true });
  await p.c.waitFor((c) => c.closed?.code === 4000, 5000, 'student socket closed');
  expect(p.c.messages.some((m) => m.type === 'room.closed')).toBe(true);
  await p.cs.waitFor((c) => c.snapshot?.me.currentRoomId === null && !c.snapshot.rooms.some((r) => r.roomId === f.roomId), 5000, 'lobby updated');
  await f.tc.waitFor((c) => !c.snapshot?.rooms.some((r) => r.roomId === f.roomId), 5000, 'teacher dashboard updated');
  const rejoin = await p.cs.tryCommand({ type: 'room.join', roomId: f.roomId });
  expect(rejoin.ok).toBe(false);
  const ws = roomSocket(p.student, f.roomId);
  await expect(ws.opened).rejects.toThrow();
  teardown(f);
});

test('클래스 종료: 모든 방 접근 차단, 학생 세션 무효, 코드 조회 불가, 데이터 삭제', async () => {
  const f = await setupRoom(4, 'observe');
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  await f.host.waitStatus('PROMPT_SELECTION');
  await f.tc.command({ type: 'class.end', confirm: true });
  await f.host.waitFor((c) => c.closed !== null, 8000, 'host closed');
  for (const p of f.players) {
    await p.c.waitFor((c) => c.closed !== null, 8000, 'player room closed');
    await p.cs.waitFor((c) => c.closed !== null, 8000, 'player class closed');
  }
  const me = await fetch(`${BASE}/api/student/me`, { headers: { authorization: `Bearer ${f.players[0]!.student.token}` } });
  expect(me.status).toBe(401);
  const lookup = await fetch(`${BASE}/api/class/lookup?code=${f.code}`, { headers: { origin: ORIGIN } });
  expect(lookup.status).toBe(404);
  const ws = teacherRoomSocket(f.teacher, f.roomId);
  await expect(ws.opened).rejects.toThrow();
  // 알람이 저장 데이터를 지운 뒤에는 클래스 스냅샷도 없다
  const { teacherApi } = await import('./harness');
  let status = 200;
  for (let i = 0; i < 20 && status === 200; i++) {
    await sleep(500);
    status = (await teacherApi(f.teacher, `/api/teacher/classes/${f.classId}`)).status;
  }
  expect([403, 404]).toContain(status);
  teardown(f);
});
