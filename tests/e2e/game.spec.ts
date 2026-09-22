/** 게임 엔진·모니터링·연결 끊김 (명세 18절 게임 묶음) */
import { expect, test } from '@playwright/test';
import { joinClass, playThrough, roomSocket, sampleStrokes, sleep, submitCurrent, teacherRoomSocket } from './harness';
import { allPlayers, setupRoom, teardown } from './setup';

for (const n of [4, 5, 12]) {
  test(`${n}명 완주: 제시어 → 모든 단계 → REVEAL_READY, 항목 수 검증`, async () => {
    const f = await setupRoom(n, 'observe');
    await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
    await f.host.waitStatus('PROMPT_SELECTION');
    expect(f.host.snapshot!.stageCount).toBe(n % 2 === 0 ? n : n - 1);
    await playThrough(allPlayers(f));
    expect(f.host.snapshot!.status).toBe('REVEAL_READY');
    await f.host.command({ type: 'reveal.start', gameId: f.host.snapshot!.gameId, expectedVersion: f.host.snapshot!.version });
    await f.host.waitStatus('REVEALING');
    const books = f.host.snapshot!.revealBooks!;
    expect(books.length).toBe(n);
    for (const b of books) expect(b.entryCount).toBe(f.host.snapshot!.stageCount + 1);
    teardown(f);
  });
}

test('참관 방장 + 12명 플레이어: 방장은 13번째 연결이며 정원을 쓰지 않는다', async () => {
  const f = await setupRoom(12, 'observe', { capacity: 12 });
  expect(f.host.snapshot!.playerCount).toBe(12);
  expect(f.host.snapshot!.me.isPlayer).toBe(false);
  expect(f.host.snapshot!.members.length).toBe(13);
  // 교사 참관 연결도 정원을 쓰지 않는다
  const tr = teacherRoomSocket(f.teacher, f.roomId);
  await tr.opened;
  expect(tr.snapshot!.playerCount).toBe(12);
  expect(tr.snapshot!.me.canMonitor).toBe(true);
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  await f.host.waitStatus('PROMPT_SELECTION');
  expect(f.host.snapshot!.stageCount).toBe(12);
  tr.close();
  teardown(f);
});

test('참여 방장은 플레이어 수에 포함되고 모니터링이 거부된다', async () => {
  const f = await setupRoom(5, 'play');
  expect(f.host.snapshot!.me.isPlayer).toBe(true);
  expect(f.host.snapshot!.playerCount).toBe(5);
  expect(f.host.snapshot!.me.canMonitor).toBe(false);
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  await f.host.waitStatus('PROMPT_SELECTION');
  const denied = await f.host.tryCommand({ type: 'monitor.subscribe', subscribe: true });
  expect(denied.ok).toBe(false);
  // 진행 중에는 방장 모드를 바꿀 수 없다
  const change = await f.host.tryCommand({ type: 'room.updateSettings', expectedVersion: f.host.snapshot!.version, hostMode: 'observe' });
  expect(change.ok).toBe(false);
  await playThrough(allPlayers(f));
  // 플레이한 방장도 결과 공개는 진행할 수 있다
  const r = await f.host.tryCommand({ type: 'reveal.start', gameId: f.host.snapshot!.gameId, expectedVersion: f.host.snapshot!.version });
  expect(r.ok).toBe(true);
  teardown(f);
});

test('일반 플레이어는 타인의 실시간 초안을 받지 않고, 참관 방장·교사는 그림·텍스트 초안을 받는다', async () => {
  const f = await setupRoom(4, 'observe');
  const tr = teacherRoomSocket(f.teacher, f.roomId);
  await tr.opened;
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  await f.host.command({ type: 'monitor.subscribe', subscribe: true });
  await tr.command({ type: 'monitor.subscribe', subscribe: true });
  let checkedDraw = false;
  let checkedText = false;
  await playThrough(allPlayers(f), async (stage) => {
    const p = f.players[0]!;
    const a = p.c.snapshot!.assignment!;
    const before = f.players[1]!.c.messages.length;
    if (a.kind === 'drawing' && !checkedDraw) {
      p.c.fire({ type: 'draft.live', gameId: a.gameId, stageId: a.stageId, seq: 1, strokesAppend: sampleStrokes(1) });
      await f.host.waitFor((c) => c.monitor.some((m) => m.userId === p.student.studentId && m.draft?.kind === 'drawing' && m.draft.strokes.length === 3), 5000, 'host sees strokes');
      await tr.waitFor((c) => c.monitor.some((m) => m.userId === p.student.studentId && m.draft?.kind === 'drawing' && m.draft.strokes.length === 3), 5000, 'teacher sees strokes');
      checkedDraw = true;
    }
    if (a.kind === 'guess' && !checkedText) {
      p.c.fire({ type: 'draft.live', gameId: a.gameId, stageId: a.stageId, seq: 1, text: '입력 중인 추측' });
      await f.host.waitFor((c) => c.monitor.some((m) => m.userId === p.student.studentId && m.draft?.kind === 'text' && m.draft.text === '입력 중인 추측'), 5000, 'host sees text');
      checkedText = true;
    }
    await sleep(150);
    const others = f.players[1]!.c.messages.slice(before);
    expect(others.some((m) => m.type === 'monitor.update' || m.type === 'monitor.snapshot')).toBe(false);
    // 플레이어 스냅샷에는 다른 사람 초안이 없다
    const snap = f.players[1]!.c.snapshot!;
    expect(snap.revealBooks).toBeNull();
    expect(snap.assignment?.previous?.authorUserId === p.student.studentId || snap.assignment === null || stage >= 1).toBe(true);
  });
  expect(checkedDraw && checkedText).toBe(true);
  tr.close();
  teardown(f);
});

test('서로 다른 두 방이 동시에 진행되고 데이터가 섞이지 않는다', async () => {
  const a = await setupRoom(4, 'observe', { className: 'A반' });
  const b = await setupRoom(4, 'observe', { className: 'B반' });
  await a.host.command({ type: 'game.start', expectedVersion: a.host.snapshot!.version });
  await b.host.command({ type: 'game.start', expectedVersion: b.host.snapshot!.version });
  await Promise.all([playThrough(allPlayers(a)), playThrough(allPlayers(b))]);
  await a.host.command({ type: 'reveal.start', gameId: a.host.snapshot!.gameId, expectedVersion: a.host.snapshot!.version });
  await a.host.waitStatus('REVEALING');
  expect(b.host.snapshot!.status).toBe('REVEAL_READY');
  const aNames = a.host.snapshot!.revealBooks!.map((x) => x.ownerName).sort();
  expect(aNames).toEqual(['학생1', '학생2', '학생3', '학생4']);
  expect(a.host.snapshot!.gameId).not.toBe(b.host.snapshot!.gameId);
  // A 방장이 B 방의 gameId 로 공개 명령을 보내도 거부
  const cross = await a.host.tryCommand({ type: 'reveal.selectBook', gameId: b.host.snapshot!.gameId!, bookId: 'b_x', expectedRevision: 0 });
  expect(cross.ok).toBe(false);
  teardown(a);
  teardown(b);
});

test('중복 제출·동시 제출·오래된 단계 제출', async () => {
  const f = await setupRoom(4, 'observe');
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  const players = allPlayers(f);
  for (const p of players) {
    await p.c.waitFor((c) => !!c.snapshot?.promptSelection, 8000, 'prompt');
    const ps = p.c.snapshot!.promptSelection!;
    await p.c.command({ type: 'prompt.choose', gameId: ps.gameId, stageId: ps.stageId, text: ps.candidates[0]! });
  }
  await players[0]!.c.waitFor((c) => c.snapshot?.status === 'PLAYING' && !!c.snapshot.assignment, 8000, 'stage1');
  const p = players[0]!.c;
  const a = p.snapshot!.assignment!;
  const payload = { kind: 'drawing', strokes: sampleStrokes(2) };
  // 같은 제출을 동시에 두 번 → 둘 다 성공(멱등)하되 항목은 하나
  const [r1, r2] = await Promise.all([p.tryCommand({ type: 'entry.submit', gameId: a.gameId, stageId: a.stageId, payload }), p.tryCommand({ type: 'entry.submit', gameId: a.gameId, stageId: a.stageId, payload })]);
  expect(r1.ok && r2.ok).toBe(true);
  await p.waitFor((c) => c.snapshot?.assignment?.submitted === true, 5000, 'submitted');
  // 나머지 제출 → 2단계로
  for (const q of players.slice(1)) await submitCurrent(q.c, q.name);
  await p.waitFor((c) => c.snapshot?.stage === 2, 8000, 'stage2');
  // 이전 단계 stageId 로 늦은 제출 → 거부
  const stale = await p.tryCommand({ type: 'entry.submit', gameId: a.gameId, stageId: a.stageId, payload: { kind: 'text', text: '늦은 제출' } });
  expect(stale.ok).toBe(false);
  // 잘못된 페이로드 (그림 단계에 텍스트) → 거부
  const a2 = p.snapshot!.assignment!;
  const wrong = await p.tryCommand({ type: 'entry.submit', gameId: a2.gameId, stageId: a2.stageId, payload: { kind: 'drawing', strokes: sampleStrokes(1) } });
  expect(wrong.ok).toBe(false);
  teardown(f);
});

test('새로고침·재접속·중복 탭: 같은 학생으로 복원되고 한 연결만 조작권을 갖는다', async () => {
  const f = await setupRoom(4, 'observe');
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  const p = f.players[0]!;
  await p.c.waitFor((c) => !!c.snapshot?.promptSelection, 8000, 'prompt');
  // 중복 탭
  const tab2 = roomSocket(p.student, f.roomId);
  await tab2.opened;
  expect(tab2.snapshot!.me.primaryConnection).toBe(true);
  await p.c.waitFor((c) => c.snapshot?.me.primaryConnection === false, 5000, 'old tab demoted');
  const denied = await p.c.tryCommand({ type: 'prompt.choose', gameId: tab2.snapshot!.promptSelection!.gameId, stageId: tab2.snapshot!.promptSelection!.stageId, text: tab2.snapshot!.promptSelection!.candidates[0]! });
  expect(denied.ok).toBe(false);
  tab2.close();
  await p.c.waitFor((c) => c.snapshot?.me.primaryConnection === true, 5000, 'old tab promoted');
  // 초안 저장 후 재접속 → 초안 복원
  const ps = p.c.snapshot!.promptSelection!;
  await p.c.command({ type: 'prompt.choose', gameId: ps.gameId, stageId: ps.stageId, text: ps.candidates[1]! });
  for (const q of f.players.slice(1)) {
    const qs = q.c.snapshot!.promptSelection!;
    await q.c.command({ type: 'prompt.choose', gameId: qs.gameId, stageId: qs.stageId, text: qs.candidates[0]! });
  }
  await p.c.waitFor((c) => c.snapshot?.status === 'PLAYING' && !!c.snapshot.assignment, 8000, 'playing');
  const a = p.c.snapshot!.assignment!;
  await p.c.command({ type: 'draft.save', gameId: a.gameId, stageId: a.stageId, revision: 3, payload: { kind: 'drawing', strokes: sampleStrokes(5) } });
  p.c.close();
  const again = roomSocket(p.student, f.roomId);
  await again.opened;
  expect(again.snapshot!.assignment?.bookId).toBe(a.bookId);
  expect(again.snapshot!.assignment?.draft?.kind).toBe('drawing');
  expect(again.snapshot!.assignment?.draftRevision).toBe(3);
  // 낮은 revision 저장은 무시
  const r = await again.command<{ revision: number }>({ type: 'draft.save', gameId: a.gameId, stageId: a.stageId, revision: 2, payload: { kind: 'drawing', strokes: [] } });
  expect(r.revision).toBe(3);
  again.close();
  teardown(f);
});

test('시간 초과: 저장된 초안은 자동 제출되고 초안이 없으면 시간 초과 항목이 생긴다', async () => {
  test.setTimeout(300_000); // 제시어 30초 + 그리기 60초 + 추측 30초 실제 대기
  const f = await setupRoom(4, 'observe');
  // 짧은 시간 설정
  await f.host.command({ type: 'room.updateSettings', expectedVersion: f.host.snapshot!.version, drawSeconds: 60, guessSeconds: 30 });
  for (const p of f.players) await p.c.command({ type: 'room.ready', ready: true });
  await f.host.waitFor((c) => c.snapshot!.members.filter((m) => m.isPlayer).every((m) => m.ready), 5000, 'ready');
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  await f.host.command({ type: 'monitor.subscribe', subscribe: true });
  // 제시어를 아무도 고르지 않으면 30초 후 서버가 확정 (알람) — 여기서는 3명만 고르고 1명은 두어 자동 확정을 확인
  const [p0, p1, p2, p3] = f.players;
  for (const p of [p0!, p1!, p2!]) {
    await p.c.waitFor((c) => !!c.snapshot?.promptSelection, 8000, 'prompt');
    const ps = p.c.snapshot!.promptSelection!;
    await p.c.command({ type: 'prompt.choose', gameId: ps.gameId, stageId: ps.stageId, text: ps.candidates[0]! });
  }
  for (const p of f.players) await p.c.waitFor((c) => c.snapshot?.status === 'PLAYING' && !!c.snapshot.assignment, 40000, 'auto prompt confirm');
  // 1단계: p0 는 초안만 저장, p1 은 라이브만, p2·p3 는 제출. 그리기 60초 만료를 기다린다.
  const a0 = p0!.c.snapshot!.assignment!;
  await p0!.c.command({ type: 'draft.save', gameId: a0.gameId, stageId: a0.stageId, revision: 1, payload: { kind: 'drawing', strokes: sampleStrokes(7) } });
  const a1 = p1!.c.snapshot!.assignment!;
  p1!.c.fire({ type: 'draft.live', gameId: a1.gameId, stageId: a1.stageId, seq: 1, strokesAppend: sampleStrokes(8) });
  await submitCurrent(p2!.c, '학생3');
  await submitCurrent(p3!.c, '학생4');
  await p0!.c.waitFor((c) => c.snapshot?.stage === 2, 75000, 'stage 2 after timeout');
  // 2단계 담당자의 직전 항목으로 확인: p0 의 책 담당자는 초안을 본다
  const stage2 = f.players.map((p) => p.c.snapshot!.assignment!);
  const fromP0 = stage2.find((a) => a.previous?.authorUserId === p0!.student.studentId)!;
  expect(fromP0.previous!.timedOut).toBe(false);
  expect(fromP0.previous!.payload.kind === 'drawing' && fromP0.previous!.payload.strokes.length).toBe(3);
  // 라이브 전용 초안은 메모리에만 있어 객체가 잠들면 사라질 수 있다(명세 9절). 있으면 자동 제출, 없으면 시간 초과 항목이 정상이다.
  const fromP1 = stage2.find((a) => a.previous?.authorUserId === p1!.student.studentId)!;
  expect(fromP1.previous).not.toBeNull();
  // 아무것도 없는 사람의 항목은 시간 초과: 2단계에서 아무도 제출하지 않고 30초 대기
  // 한 명만 기다리고 전원의 스냅샷을 읽으면 아직 2단계인 사람이 섞인다 — 전원을 기다린다
  for (const p of f.players) {
    await p.c.waitFor((c) => (c.snapshot?.stage === 3 && !!c.snapshot.assignment) || c.snapshot?.status !== 'PLAYING', 45000, 'stage 3 after timeout');
  }
  const stage3 = f.players.map((p) => p.c.snapshot!.assignment!);
  expect(stage3.every((a) => a.previous?.kind === 'guess')).toBe(true);
  expect(stage3.every((a) => a.previous?.timedOut === true)).toBe(true);
  teardown(f);
});

test('방장 연결 끊김 → 진행 계속, 교사 진행권 인수 후 공개 진행, 이전 방장 조작 거부', async () => {
  const f = await setupRoom(4, 'observe');
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  f.host.close(); // 방장 끊김
  await playThrough(allPlayers(f)); // 타이머·제출은 계속 동작
  const p = f.players[0]!;
  expect(p.c.snapshot!.status).toBe('REVEAL_READY');
  expect(p.c.snapshot!.host.connected).toBe(false);
  // 교사가 진행권 인수
  await f.tc.command({ type: 'room.takeOver', roomId: f.roomId });
  const tr = teacherRoomSocket(f.teacher, f.roomId);
  await tr.opened;
  await tr.waitFor((c) => c.snapshot?.me.canControl === true, 5000, 'teacher control');
  await tr.command({ type: 'reveal.start', gameId: tr.snapshot!.gameId, expectedVersion: tr.snapshot!.version });
  await tr.waitStatus('REVEALING');
  // 기존 방장이 복귀해도 권한이 자동 복원되지 않는다
  const back = roomSocket(f.hostStudent, f.roomId);
  await back.opened;
  expect(back.snapshot!.me.canControl).toBe(false);
  const denied = await back.tryCommand({ type: 'reveal.selectBook', gameId: tr.snapshot!.gameId, bookId: tr.snapshot!.revealBooks![0]!.bookId, expectedRevision: tr.snapshot!.reveal!.revision });
  expect(denied.ok).toBe(false);
  back.close();
  tr.close();
  teardown(f);
});

test('게임 중 나간 플레이어의 남은 작업은 건너뛰고 판은 계속된다', async () => {
  const f = await setupRoom(4, 'observe');
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  const players = allPlayers(f);
  for (const p of players) {
    await p.c.waitFor((c) => !!c.snapshot?.promptSelection, 8000, 'prompt');
    const ps = p.c.snapshot!.promptSelection!;
    await p.c.command({ type: 'prompt.choose', gameId: ps.gameId, stageId: ps.stageId, text: ps.candidates[0]! });
  }
  await players[0]!.c.waitFor((c) => c.snapshot?.status === 'PLAYING', 8000, 'playing');
  await players[3]!.c.command({ type: 'room.leave' });
  const remaining = players.slice(0, 3);
  // 남은 3명만으로 모든 단계 진행 (나간 사람은 자동 건너뛰기)
  const stageCount = remaining[0]!.c.snapshot!.stageCount;
  for (let s = 1; s <= stageCount; s++) {
    for (const p of remaining) await p.c.waitFor((c) => c.snapshot?.status !== 'PLAYING' || c.snapshot.stage === s, 15000, `stage ${s}`);
    for (const p of remaining) if (p.c.snapshot?.status === 'PLAYING') await submitCurrent(p.c, p.name);
  }
  await remaining[0]!.c.waitStatus('REVEAL_READY');
  // 나간 사람이 다시 들어올 수 없다 (진행 중 신규 입장 불가)
  const rejoin = await f.players[3]!.cs.tryCommand({ type: 'room.join', roomId: f.roomId });
  expect(rejoin.ok).toBe(false);
  teardown(f);
});

test('진행 중인 방에는 신규 플레이어가 들어올 수 없다', async () => {
  const f = await setupRoom(4, 'observe');
  await f.host.command({ type: 'game.start', expectedVersion: f.host.snapshot!.version });
  const late = await joinClass(f.code, '지각생');
  const cs = (await import('./harness')).classSocket(late);
  await cs.opened;
  const r = await cs.tryCommand({ type: 'room.join', roomId: f.roomId });
  expect(r.ok).toBe(false);
  expect(r.ok ? '' : r.message).toContain('진행 중');
  cs.close();
  teardown(f);
});
