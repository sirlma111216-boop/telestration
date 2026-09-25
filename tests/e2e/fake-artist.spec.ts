/**
 * 가짜 예술가 찾기 (명세 16절). 실제 서버(로컬 Durable Object)에 진짜 WebSocket 으로 붙어 검증한다.
 * 봇·지름길 없이 학생 화면과 같은 메시지만 쓴다.
 */
import { expect, test, type Page } from '@playwright/test';
import type { RoomSnapshot, Stroke } from '../../shared/types';
import { FA_COLORS, FA_STROKE_WIDTH } from '../../shared/fakeArtist';
import { classSocket, joinClass, roomSocket, sleep, teacherRoomSocket, type Client } from './harness';
import { allPlayers, setupRoom, teardown, type RoomFixture } from './setup';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __fa?: any;
    __waitingMusic?: any;
  }
}

type C = Client<RoomSnapshot>;
type P = { c: C; name: string };

const FA_CREATE = (fa: Record<string, unknown> = {}) => ({
  gameMode: 'FAKE_ARTIST',
  fa: { categoryId: 'animal', turnSeconds: 15, discussionSeconds: 0, ...fa },
});

async function setupFa(n: number, hostMode: 'observe' | 'play' = 'observe', fa: Record<string, unknown> = {}, opts: { ready?: boolean } = {}): Promise<RoomFixture> {
  const f = await setupRoom(n, hostMode, {
    ready: false,
    create: FA_CREATE(fa),
  });
  if (opts.ready === false) return f;
  const all = allPlayers(f);
  for (const [i, p] of all.entries()) {
    await p.c.command({ type: 'fa.color', colorIndex: i });
    await p.c.command({ type: 'room.ready', ready: true });
  }
  await f.host.waitFor((c) => !!c.snapshot && c.snapshot.members.filter((m) => m.isPlayer).every((m) => m.ready), 8000, 'all ready');
  return f;
}

const uid = (c: C) => c.snapshot!.me.userId;

function strokeFor(c: C, seed = 0, pointCount = 3): Stroke {
  const me = c.snapshot!.fa!.players.find((p) => p.userId === uid(c))!;
  const p: number[] = [];
  for (let i = 0; i < pointCount; i++) p.push(100 + i * 7 + seed, 120 + ((i * 13 + seed) % 300));
  return { t: 'pen', c: FA_COLORS[me.color]!.hex, w: FA_STROKE_WIDTH, p };
}

async function startFa(f: RoomFixture): Promise<void> {
  await f.host.command({
    type: 'game.start',
    expectedVersion: f.host.snapshot!.version,
  });
  await f.host.waitStatus('ROLE_REVEAL');
}

async function ackAll(players: P[]): Promise<void> {
  for (const p of players) {
    await p.c.waitFor((c) => !!c.snapshot?.fa, 8000, 'fa view');
    const fa = p.c.snapshot!.fa!;
    if (p.c.snapshot!.status === 'ROLE_REVEAL')
      await p.c.command({
        type: 'fa.roleAck',
        gameId: fa.gameId,
        phaseId: fa.phaseId,
      });
  }
}

/** 차례대로 한 획씩 확정해 그리기 단계를 끝낸다 */
async function drawAll(f: RoomFixture, players: P[], skip: (userId: string) => boolean = () => false): Promise<void> {
  for (let guard = 0; guard < 40; guard++) {
    await f.host.waitFor((c) => c.snapshot?.status !== 'ROLE_REVEAL', 15000, 'past role reveal');
    if (f.host.snapshot!.status !== 'DRAWING') return;
    const fa = f.host.snapshot!.fa!;
    const active = players.find((p) => uid(p.c) === fa.activePlayerId);
    if (active && !skip(uid(active.c))) {
      await active.c.command({
        type: 'fa.commit',
        gameId: fa.gameId,
        turnId: fa.phaseId,
        revision: 0,
        stroke: strokeFor(active.c, fa.turnIndex),
      });
    }
    await f.host.waitFor((c) => c.snapshot?.status !== 'DRAWING' || c.snapshot.fa?.phaseId !== fa.phaseId, 20000, `turn ${fa.turnIndex} done`);
  }
  throw new Error('drawing did not finish');
}

function roles(players: P[]): { fake: P; artists: P[]; word: string } {
  const fakes = players.filter((p) => p.c.snapshot!.fa!.me.card?.role === 'fake');
  expect(fakes.length).toBe(1);
  const artists = players.filter((p) => p.c.snapshot!.fa!.me.card?.role === 'artist');
  expect(artists.length).toBe(players.length - 1);
  const words = new Set(artists.map((a) => (a.c.snapshot!.fa!.me.card as { word: string }).word));
  expect(words.size).toBe(1);
  return { fake: fakes[0]!, artists, word: [...words][0]! };
}

/** 이 클라이언트가 받은 모든 메시지를 JSON 으로 — 누출 검사용 */
const dump = (c: C, from = 0) => JSON.stringify(c.messages.slice(from));

async function vote(p: P, target: P): Promise<void> {
  const fa = p.c.snapshot!.fa!;
  await p.c.command({
    type: 'fa.vote',
    gameId: fa.gameId,
    phaseId: fa.phaseId,
    targetId: uid(target.c),
  });
}

async function revealTo(f: RoomFixture, ctl: C, step: number, watchers: P[]): Promise<void> {
  const fa = ctl.snapshot!.fa!;
  if (ctl.snapshot!.status === 'REVEAL_READY') {
    await ctl.command({ type: 'fa.reveal.start', gameId: fa.gameId });
    await ctl.waitStatus('REVEALING');
  }
  while (ctl.snapshot!.fa!.reveal!.step < step) {
    const cur = ctl.snapshot!.fa!.reveal!.step;
    await ctl.command({
      type: 'fa.reveal.next',
      gameId: fa.gameId,
      expectedStep: cur,
    });
    await ctl.waitFor((c) => c.snapshot!.fa!.reveal!.step === cur + 1, 8000, `step ${cur + 1}`);
  }
  for (const w of watchers) await w.c.waitFor((c) => c.snapshot?.fa?.reveal?.step === step, 8000, `${w.name} sees step ${step}`);
  void f;
}

// ---------------------------------------------------------------- 완주

for (const n of [4, 5, 12]) {
  test(`${n}명 완주: 한 명만 가짜, 같은 제시어, 2N 차례, 비밀 누출 없음, 판정`, async () => {
    const f = await setupFa(n, 'observe');
    const tr = teacherRoomSocket(f.teacher, f.roomId);
    await tr.opened;
    const players = allPlayers(f);
    expect(players.length).toBe(n);
    await startFa(f);
    await ackAll(players);
    const { fake, artists, word } = roles(players);
    // 참관 방장·교사에게는 카드가 없다
    expect(f.host.snapshot!.fa!.me.card).toBeNull();
    expect(f.host.snapshot!.fa!.me.isPlayer).toBe(false);
    await tr.waitFor((c) => !!c.snapshot?.fa, 5000, 'teacher fa');
    expect(tr.snapshot!.fa!.me.card).toBeNull();

    await drawAll(f, players);
    const fa = f.host.snapshot!.fa!;
    expect(fa.committed.length).toBe(2 * n);
    const order = fa.players.map((p) => p.userId);
    fa.committed.forEach((c, t) => {
      expect(c.turnIndex).toBe(t);
      expect(c.playerId).toBe(order[t % n]);
      expect(c.stroke).not.toBeNull();
    });
    expect(f.host.snapshot!.status).toBe('VOTING'); // 토론 0초 → 곧바로 투표

    // 투표 규칙: 자기 자신 금지, 참관자 금지, 변경 금지, 같은 요청 재전송은 성공
    const a0 = artists[0]!;
    expect(
      (
        await a0.c.tryCommand({
          type: 'fa.vote',
          gameId: fa.gameId,
          phaseId: a0.c.snapshot!.fa!.phaseId,
          targetId: uid(a0.c),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.host.tryCommand({
          type: 'fa.vote',
          gameId: fa.gameId,
          phaseId: f.host.snapshot!.fa!.phaseId,
          targetId: uid(fake.c),
        })
      ).ok,
    ).toBe(false);

    let expectOutcome: string;
    if (n === 12) {
      // 동률 만들기: 예술가 A, B 에게 6표씩 → 발각 실패 → 가짜 승리 (추측은 승패와 무관)
      const [A, B, ...rest] = artists;
      await vote(A!, B!);
      expect(
        (
          await A!.c.tryCommand({
            type: 'fa.vote',
            gameId: fa.gameId,
            phaseId: A!.c.snapshot!.fa!.phaseId,
            targetId: uid(fake.c),
          })
        ).ok,
      ).toBe(false);
      await vote(A!, B!); // 재전송
      await vote(B!, A!);
      const voters = [...rest, fake];
      for (const [i, v] of voters.entries()) await vote(v, i % 2 === 0 ? A! : B!);
      expectOutcome = 'FAKE_WINS';
    } else {
      for (const a of artists) await vote(a, fake);
      await vote(fake, artists[0]!);
      expectOutcome = n === 4 ? 'FAKE_COMEBACK' : 'ARTISTS_WIN';
    }
    // 모두 투표하면 곧바로 최종 추측
    await f.host.waitStatus('FINAL_GUESS');
    for (const p of players) await p.c.waitStatus('FINAL_GUESS');
    expect(fake.c.snapshot!.fa!.me.canGuess).toBe(true);
    for (const a of artists) expect(a.c.snapshot!.fa!.me.canGuess).toBe(false);
    // 가짜가 아닌 사람의 추측은 거부
    expect(
      (
        await a0.c.tryCommand({
          type: 'fa.guess',
          gameId: fa.gameId,
          phaseId: a0.c.snapshot!.fa!.phaseId,
          text: word,
        })
      ).ok,
    ).toBe(false);
    // 가짜가 추측을 내도 다른 사람에게는 아무 것도 가지 않는다 (시점 누출 방지)
    const before = players.filter((p) => p !== fake).map((p) => p.c.messages.length);
    const hostBefore = f.host.messages.length;
    const guessText = n === 4 ? ` ${word} ` : '전혀아닌답';
    await fake.c.command({
      type: 'fa.guess',
      gameId: fa.gameId,
      phaseId: fake.c.snapshot!.fa!.phaseId,
      text: guessText,
    });
    await fake.c.waitFor((c) => c.snapshot!.fa!.me.guessSubmitted, 5000, 'guess ack snapshot');
    await sleep(700);
    expect(players.filter((p) => p !== fake).map((p) => p.c.messages.length)).toEqual(before);
    expect(f.host.messages.length).toBe(hostBefore);
    expect(fake.c.snapshot!.status).toBe('FINAL_GUESS'); // 일찍 끝나지 않는다
    expect(
      (
        await fake.c.tryCommand({
          type: 'fa.guess',
          gameId: fa.gameId,
          phaseId: fake.c.snapshot!.fa!.phaseId,
          text: '다른 답',
        })
      ).ok,
    ).toBe(false);

    await f.host.waitStatus('REVEAL_READY', 30000);

    // 결과 공개 전: 가짜·참관자·교사가 받은 어떤 메시지에도 제시어·가짜 정체·표가 없다
    const quoted = JSON.stringify(word);
    for (const c of [fake.c, f.host, tr]) expect(dump(c)).not.toContain(quoted);
    for (const c of [...players.map((p) => p.c), f.host, tr]) {
      const all = dump(c);
      expect(all).not.toContain('"fakeArtistId"');
      expect(all).not.toContain('"votes"');
      expect(all).not.toContain('"finalGuess"');
    }
    for (const a of artists) expect(dump(a.c)).not.toContain('"role":"fake"');

    // 학생은 공개를 진행할 수 없다
    expect((await a0.c.tryCommand({ type: 'fa.reveal.start', gameId: fa.gameId })).ok).toBe(false);
    await f.host.command({ type: 'fa.reveal.start', gameId: fa.gameId });
    await f.host.waitStatus('REVEALING');
    expect(
      (
        await a0.c.tryCommand({
          type: 'fa.reveal.next',
          gameId: fa.gameId,
          expectedStep: 0,
        })
      ).ok,
    ).toBe(false);
    // 건너뛰기 금지 (기대 단계가 다르면 거부)
    expect(
      (
        await f.host.tryCommand({
          type: 'fa.reveal.next',
          gameId: fa.gameId,
          expectedStep: 2,
        })
      ).ok,
    ).toBe(false);
    // 강조는 모두 공개한 뒤에만
    expect(
      (
        await f.host.tryCommand({
          type: 'fa.highlight',
          gameId: fa.gameId,
          playerId: uid(fake.c),
          expectedRevision: f.host.snapshot!.fa!.reveal!.revision,
        })
      ).ok,
    ).toBe(false);

    const watchers = [...players, { c: tr, name: '교사' }];
    // 단계별로 해당 정보만 나타난다
    await revealTo(f, f.host, 0, watchers);
    let r = fake.c.snapshot!.fa!.reveal!;
    expect(r.votes).toBeUndefined();
    expect(r.fakeArtistId).toBeUndefined();
    await revealTo(f, f.host, 1, watchers);
    r = fake.c.snapshot!.fa!.reveal!;
    expect(r.votes!.reduce((s, v) => s + v.count, 0)).toBe(n);
    expect(r.voteResult).toBe(n === 12 ? 'tie' : 'single');
    expect(r.fakeArtistId).toBeUndefined();
    expect(dump(fake.c)).not.toContain(quoted);
    await revealTo(f, f.host, 2, watchers);
    r = tr.snapshot!.fa!.reveal!;
    expect(r.fakeArtistId).toBe(uid(fake.c));
    expect(r.caught).toBe(n !== 12);
    expect(r.finalGuess).toBeUndefined();
    expect(dump(tr)).not.toContain(quoted);
    await revealTo(f, f.host, 3, watchers);
    r = artists[1]!.c.snapshot!.fa!.reveal!;
    expect(r.finalGuess!.text).toBe(guessText.trim());
    expect(r.finalGuess!.affectsOutcome).toBe(n !== 12);
    expect(r.word).toBeUndefined();
    expect(r.outcome).toBeUndefined();
    await revealTo(f, f.host, 4, watchers);
    for (const w of watchers) {
      const rv = w.c.snapshot!.fa!.reveal!;
      expect(rv.word).toBe(word);
      expect(rv.outcome).toBe(expectOutcome);
      expect(w.c.snapshot!.status).toBe('FINISHED');
    }
    expect(fake.c.snapshot!.fa!.reveal!.guessCorrect).toBe(n === 4);

    // 강조: 방장이 고르면 모두 같은 사람을 본다. 학생은 못 한다.
    expect(
      (
        await a0.c.tryCommand({
          type: 'fa.highlight',
          gameId: fa.gameId,
          playerId: uid(fake.c),
          expectedRevision: a0.c.snapshot!.fa!.reveal!.revision,
        })
      ).ok,
    ).toBe(false);
    await f.host.command({
      type: 'fa.highlight',
      gameId: fa.gameId,
      playerId: uid(fake.c),
      expectedRevision: f.host.snapshot!.fa!.reveal!.revision,
    });
    for (const w of watchers) await w.c.waitFor((c) => c.snapshot!.fa!.reveal!.highlightPlayerId === uid(fake.c), 5000, `${w.name} highlight`);
    // 오래된 revision 으로는 못 바꾼다 (동시 조작)
    expect(
      (
        await f.host.tryCommand({
          type: 'fa.highlight',
          gameId: fa.gameId,
          playerId: null,
          expectedRevision: 0,
        })
      ).ok,
    ).toBe(false);

    // 같은 모드로 다시: 대기실로, 모드와 색은 그대로, 준비·게임 상태는 초기화
    await f.host.command({
      type: 'room.restart',
      expectedVersion: f.host.snapshot!.version,
    });
    await f.host.waitStatus('LOBBY');
    const s = f.host.snapshot!;
    expect(s.gameMode).toBe('FAKE_ARTIST');
    expect(s.fa).toBeNull();
    const colors = s.members.filter((m) => m.isPlayer).map((m) => m.faColor);
    expect(colors.every((c) => c !== null)).toBe(true);
    expect(s.members.filter((m) => m.isPlayer).every((m) => !m.ready)).toBe(true);
    tr.close();
    teardown(f);
  });
}

// ---------------------------------------------------------------- 대기실·모드

test('모드 전환: 준비·색 초기화, 오래된 요청 거부, 색 중복·동시 선택', async () => {
  const f = await setupRoom(4, 'observe', { ready: false });
  const [p1, p2, p3] = f.players;
  expect(f.host.snapshot!.gameMode).toBe('TELESTRATION');
  // 그림 이어말하기에서는 색을 고르지 않는다
  expect((await p1!.c.tryCommand({ type: 'fa.color', colorIndex: 0 })).ok).toBe(false);
  await p1!.c.command({ type: 'room.ready', ready: true });
  const oldVersion = f.host.snapshot!.version;
  await f.host.command({
    type: 'room.updateSettings',
    expectedVersion: f.host.snapshot!.version,
    gameMode: 'FAKE_ARTIST',
  });
  await p1!.c.waitFor((c) => c.snapshot!.gameMode === 'FAKE_ARTIST', 5000, 'mode switched');
  expect(p1!.c.snapshot!.members.every((m) => !m.ready)).toBe(true);
  // 전환 전 버전으로 보낸 설정 변경은 거부
  expect(
    (
      await f.host.tryCommand({
        type: 'room.updateSettings',
        expectedVersion: oldVersion,
        gameMode: 'TELESTRATION',
      })
    ).ok,
  ).toBe(false);
  // 색 없이 준비 불가
  expect((await p1!.c.tryCommand({ type: 'room.ready', ready: true })).ok).toBe(false);
  // 참관 방장은 색을 고르지 않는다
  expect((await f.host.tryCommand({ type: 'fa.color', colorIndex: 1 })).ok).toBe(false);
  // 동시에 같은 색: 정확히 한 명만 성공, 실패 메시지에 가진 사람 이름
  const [r2, r3] = await Promise.all([p2!.c.tryCommand({ type: 'fa.color', colorIndex: 3 }), p3!.c.tryCommand({ type: 'fa.color', colorIndex: 3 })]);
  expect([r2.ok, r3.ok].filter(Boolean).length).toBe(1);
  const failed = (r2.ok ? r3 : r2) as { ok: false; message: string };
  expect(failed.message).toContain(r2.ok ? p2!.name : p3!.name);
  await p1!.c.command({ type: 'fa.color', colorIndex: 0 });
  await p1!.c.command({ type: 'room.ready', ready: true });
  await p1!.c.waitFor((c) => c.snapshot!.members.find((m) => m.userId === uid(c))!.ready, 5000, 'ready');
  // 색이 없는 사람이 있으면 시작 불가
  expect(
    (
      await f.host.tryCommand({
        type: 'game.start',
        expectedVersion: f.host.snapshot!.version,
      })
    ).ok,
  ).toBe(false);
  // 설정 변경 → 준비 초기화, 색은 유지
  await f.host.command({
    type: 'room.updateSettings',
    expectedVersion: f.host.snapshot!.version,
    faTurnSeconds: 30,
  });
  await p1!.c.waitFor((c) => c.snapshot!.faSettings.turnSeconds === 30, 5000, 'settings');
  expect(p1!.c.snapshot!.members.find((m) => m.userId === uid(p1!.c))!.ready).toBe(false);
  expect(p1!.c.snapshot!.members.find((m) => m.userId === uid(p1!.c))!.faColor).toBe(0);
  // 다시 그림 이어말하기로 → 색 초기화
  await f.host.command({
    type: 'room.updateSettings',
    expectedVersion: f.host.snapshot!.version,
    gameMode: 'TELESTRATION',
  });
  await p1!.c.waitFor((c) => c.snapshot!.gameMode === 'TELESTRATION', 5000, 'back');
  expect(p1!.c.snapshot!.members.every((m) => m.faColor === null)).toBe(true);
  teardown(f);
});

test('두 모드 방을 한 클래스에서 동시에 진행하고 목록에 모드가 표시된다', async () => {
  const fa = await setupFa(4, 'observe');
  // 같은 클래스에 그림 이어말하기 방 하나 더
  const host2 = await joinClass(fa.code, '방장2');
  await fa.tc.command({
    type: 'class.grantHost',
    studentId: host2.studentId,
    grant: true,
  });
  const h2cs = classSocket(host2);
  await h2cs.opened;
  await h2cs.waitFor((c) => !!c.snapshot?.me.hostGrant, 5000, 'grant');
  const { roomId: tRoom } = await h2cs.command<{ roomId: string }>({
    type: 'room.create',
    title: '이어말하기 방',
    capacity: 12,
    hostMode: 'observe',
  });
  await fa.tc.waitFor((c) => (c.snapshot?.rooms.length ?? 0) >= 2, 8000, 'two rooms');
  const modes = Object.fromEntries(fa.tc.snapshot!.rooms.map((r) => [r.roomId, r.gameMode]));
  expect(modes[fa.roomId]).toBe('FAKE_ARTIST');
  expect(modes[tRoom]).toBe('TELESTRATION');
  const h2 = roomSocket(host2, tRoom);
  await h2.opened;
  const tplayers: C[] = [];
  for (let i = 0; i < 4; i++) {
    const s = await joinClass(fa.code, `이어${i}`);
    const cs = classSocket(s);
    await cs.opened;
    await cs.command({ type: 'room.join', roomId: tRoom });
    cs.close();
    const c = roomSocket(s, tRoom);
    await c.opened;
    await c.command({ type: 'room.ready', ready: true });
    tplayers.push(c);
  }
  await h2.waitFor((c) => c.snapshot!.members.filter((m) => m.isPlayer).every((m) => m.ready) && c.snapshot!.playerCount === 4, 8000, 'ready');
  await startFa(fa);
  await h2.command({
    type: 'game.start',
    expectedVersion: h2.snapshot!.version,
  });
  await h2.waitStatus('PROMPT_SELECTION');
  expect(fa.host.snapshot!.status).toBe('ROLE_REVEAL');
  expect(h2.snapshot!.fa).toBeNull();
  // 그림 이어말하기 방에 가짜 예술가 명령을 보내면 거부
  expect(
    (
      await tplayers[0]!.tryCommand({
        type: 'fa.roleAck',
        gameId: fa.host.snapshot!.fa!.gameId,
        phaseId: fa.host.snapshot!.fa!.phaseId,
      })
    ).ok,
  ).toBe(false);
  for (const c of tplayers) c.close();
  h2.close();
  h2cs.close();
  teardown(fa);
});

// ---------------------------------------------------------------- 차례·획

test('차례 규칙: 남의 차례 거부, 경로 하나만, 초안 방송, 지우고 다시 그리기 revision, 멱등 확정', async () => {
  const f = await setupFa(4, 'observe');
  const players = allPlayers(f);
  await startFa(f);
  await ackAll(players);
  await f.host.waitStatus('DRAWING');
  const fa = f.host.snapshot!.fa!;
  const A = players.find((p) => uid(p.c) === fa.activePlayerId)!;
  const B = players.find((p) => uid(p.c) === fa.nextPlayerId)!;
  const other = players.find((p) => p !== A && p !== B)!;
  const turn = { gameId: fa.gameId, turnId: fa.phaseId };

  // 차례가 아닌 사람: 확정·지우기 거부, 초안은 방송되지 않음
  expect(
    (
      await B.c.tryCommand({
        type: 'fa.commit',
        ...turn,
        revision: 0,
        stroke: strokeFor(B.c),
      })
    ).ok,
  ).toBe(false);
  expect((await B.c.tryCommand({ type: 'fa.redo', ...turn, revision: 1 })).ok).toBe(false);
  const drafts = () => other.c.messages.filter((m) => m.type === 'fa.draft');
  B.c.fire({ type: 'fa.draft', ...turn, revision: 0, stroke: strokeFor(B.c) });
  await sleep(400);
  expect(drafts().length).toBe(0);

  // 현재 차례의 초안은 모두에게 (검증 후) 전달
  A.c.fire({
    type: 'fa.draft',
    ...turn,
    revision: 0,
    stroke: strokeFor(A.c, 1, 5),
  });
  await other.c.waitFor(() => drafts().length === 1, 5000, 'draft relayed');
  expect((drafts()[0]!.stroke as Stroke).p.length).toBe(10);
  // 잘못된 초안(다른 색·여러 경로)은 방송하지 않는다
  A.c.fire({
    type: 'fa.draft',
    ...turn,
    revision: 0,
    stroke: { ...strokeFor(A.c), c: '#123456' },
  });
  A.c.fire({
    type: 'fa.draft',
    ...turn,
    revision: 0,
    stroke: [strokeFor(A.c), strokeFor(A.c, 2)],
  });
  await sleep(400);
  expect(drafts().length).toBe(1);

  // 여러 경로·지우개·다른 색·굵기·점 과다 확정은 거부
  for (const bad of [
    [strokeFor(A.c), strokeFor(A.c, 2)],
    { ...strokeFor(A.c), t: 'eraser' },
    {
      ...strokeFor(A.c),
      c: FA_COLORS[11]!.hex === strokeFor(A.c).c ? FA_COLORS[0]!.hex : FA_COLORS[11]!.hex,
    },
    { ...strokeFor(A.c), w: 20 },
    strokeFor(A.c, 0, 301),
  ]) {
    expect(
      (
        await A.c.tryCommand({
          type: 'fa.commit',
          ...turn,
          revision: 0,
          stroke: bad,
        })
      ).ok,
    ).toBe(false);
  }

  // 지우고 다시 그리기 → revision 1. 그 전에 보낸 늦은 초안(rev 0)은 버린다.
  await A.c.command({ type: 'fa.redo', ...turn, revision: 1 });
  await other.c.waitFor(() => drafts().some((d) => d.revision === 1 && d.stroke === null), 5000, 'redo relayed');
  const n0 = drafts().length;
  A.c.fire({
    type: 'fa.draft',
    ...turn,
    revision: 0,
    stroke: strokeFor(A.c, 9),
  });
  await sleep(400);
  expect(drafts().length).toBe(n0);
  expect(
    (
      await A.c.tryCommand({
        type: 'fa.commit',
        ...turn,
        revision: 0,
        stroke: strokeFor(A.c, 9),
      })
    ).ok,
  ).toBe(false);
  // 새 획 확정 (저장 후 ACK), 같은 요청 재전송은 성공, 다른 사람 화면에 반영
  const final = strokeFor(A.c, 4, 6);
  await A.c.command({ type: 'fa.commit', ...turn, revision: 1, stroke: final });
  expect(
    (
      await A.c.tryCommand({
        type: 'fa.commit',
        ...turn,
        revision: 1,
        stroke: final,
      })
    ).ok,
  ).toBe(true);
  await other.c.waitFor((c) => c.snapshot!.fa!.committed.length === 1, 5000, 'committed');
  expect(other.c.snapshot!.fa!.committed[0]!.stroke!.p).toEqual(final.p);
  expect(other.c.snapshot!.fa!.activePlayerId).toBe(uid(B.c));
  // 끝난 차례에 다시 확정하면 거부 (다른 사람이)
  expect(
    (
      await B.c.tryCommand({
        type: 'fa.commit',
        ...turn,
        revision: 1,
        stroke: strokeFor(B.c),
      })
    ).ok,
  ).toBe(false);
  teardown(f);
});

test('시간 초과: 도착한 최신 초안을 확정하고, 초안이 없으면 건너뛴다. 늦은 확정은 거부', async () => {
  test.setTimeout(90_000);
  const f = await setupFa(4, 'observe', { turnSeconds: 15 });
  const players = allPlayers(f);
  await startFa(f);
  await ackAll(players);
  await f.host.waitStatus('DRAWING');
  const fa = f.host.snapshot!.fa!;
  const A = players.find((p) => uid(p.c) === fa.activePlayerId)!;
  const s1 = strokeFor(A.c, 3, 4);
  const s2 = strokeFor(A.c, 5, 8);
  A.c.fire({
    type: 'fa.draft',
    gameId: fa.gameId,
    turnId: fa.phaseId,
    revision: 0,
    stroke: s1,
  });
  A.c.fire({
    type: 'fa.draft',
    gameId: fa.gameId,
    turnId: fa.phaseId,
    revision: 0,
    stroke: s2,
  });
  await f.host.waitFor((c) => c.snapshot!.fa!.committed.length === 1, 25000, 'timeout commit');
  expect(f.host.snapshot!.fa!.committed[0]!.stroke!.p).toEqual(s2.p);
  expect(
    (
      await A.c.tryCommand({
        type: 'fa.commit',
        gameId: fa.gameId,
        turnId: fa.phaseId,
        revision: 0,
        stroke: s2,
      })
    ).ok,
  ).toBe(false);
  // 두 번째 차례는 아무 것도 안 그림 → 건너뜀(null)
  await f.host.waitFor((c) => c.snapshot!.fa!.committed.length === 2, 25000, 'timeout skip');
  expect(f.host.snapshot!.fa!.committed[1]!.stroke).toBeNull();
  teardown(f);
});

test('재접속: 그리던 획이 복원되고 확정할 수 있다', async () => {
  const f = await setupFa(4, 'observe');
  const players = allPlayers(f);
  await startFa(f);
  await ackAll(players);
  await f.host.waitStatus('DRAWING');
  const fa = f.host.snapshot!.fa!;
  const idx = f.players.findIndex((p) => p.student.studentId === fa.activePlayerId);
  const A = f.players[idx]!;
  const s = strokeFor(A.c, 7, 5);
  A.c.fire({
    type: 'fa.draft',
    gameId: fa.gameId,
    turnId: fa.phaseId,
    revision: 0,
    stroke: s,
  });
  await f.host.waitFor((c) => c.messages.some((m) => m.type === 'fa.draft'), 5000, 'draft seen');
  A.c.close();
  await sleep(300);
  const again = roomSocket(A.student, f.roomId);
  await again.opened;
  await again.waitFor((c) => !!c.snapshot?.fa?.draft, 5000, 'draft restored');
  const d = again.snapshot!.fa!.draft!;
  expect(d.playerId).toBe(A.student.studentId);
  expect(d.stroke!.p).toEqual(s.p);
  expect(again.snapshot!.fa!.me.card).not.toBeNull(); // 내 카드도 다시 받는다
  await again.command({
    type: 'fa.commit',
    gameId: fa.gameId,
    turnId: fa.phaseId,
    revision: d.revision,
    stroke: d.stroke,
  });
  await f.host.waitFor((c) => c.snapshot!.fa!.committed.length === 1, 5000, 'committed');
  again.close();
  teardown(f);
});

test('가짜 예술가가 나가도 역할은 다시 뽑지 않고, 그 사람의 차례는 건너뛴다', async () => {
  test.setTimeout(90_000);
  const f = await setupFa(5, 'observe');
  const players = allPlayers(f);
  await startFa(f);
  await ackAll(players);
  const { fake, artists } = roles(players);
  await fake.c.command({ type: 'room.leave' });
  await drawAll(f, artists);
  const fa = f.host.snapshot!.fa!;
  expect(fa.committed.length).toBe(10);
  for (const c of fa.committed) expect(c.stroke === null).toBe(c.playerId === uid(fake.c));
  expect(fa.players.find((p) => p.userId === uid(fake.c))!.left).toBe(true);
  // 남은 사람 중 누구도 가짜 카드로 바뀌지 않았다
  for (const a of artists) expect(a.c.snapshot!.fa!.me.card!.role).toBe('artist');
  expect(fa.voterTotal).toBe(4);
  for (const a of artists) await vote(a, fake);
  await f.host.waitStatus('FINAL_GUESS');
  await f.host.waitStatus('REVEAL_READY', 30000);
  await revealTo(f, f.host, 4, artists);
  const r = artists[0]!.c.snapshot!.fa!.reveal!;
  expect(r.fakeArtistId).toBe(uid(fake.c));
  expect(r.caught).toBe(true);
  expect(r.finalGuess!.text).toBeNull();
  expect(r.outcome).toBe('ARTISTS_WIN');
  teardown(f);
});

test('유효 투표가 없으면 투표 불성립, 교사가 진행권을 가져와 공개한다', async () => {
  test.setTimeout(100_000);
  const f = await setupFa(4, 'observe');
  const players = allPlayers(f);
  await startFa(f);
  await ackAll(players);
  await drawAll(f, players);
  await f.host.waitStatus('VOTING');
  const p0 = players[0]!;
  // 자기 자신에게 한 표 → 거부되어 셈에 들어가지 않는다
  expect(
    (
      await p0.c.tryCommand({
        type: 'fa.vote',
        gameId: p0.c.snapshot!.fa!.gameId,
        phaseId: p0.c.snapshot!.fa!.phaseId,
        targetId: uid(p0.c),
      })
    ).ok,
  ).toBe(false);
  // 아무도 투표하지 않음 → 20초 뒤 최종 추측, 다시 20초 뒤 공개 대기
  await f.host.waitStatus('FINAL_GUESS', 30000);
  await f.host.waitStatus('REVEAL_READY', 30000);
  // 진행 중 방장 교체: 교사가 진행권 인수 → 이전 방장은 공개 불가
  const tr = teacherRoomSocket(f.teacher, f.roomId);
  await tr.opened;
  await f.tc.command({ type: 'room.takeOver', roomId: f.roomId });
  await tr.waitFor((c) => c.snapshot!.me.canControl, 8000, 'teacher control');
  expect(tr.snapshot!.fa!.me.card).toBeNull();
  expect(
    (
      await f.host.tryCommand({
        type: 'fa.reveal.start',
        gameId: tr.snapshot!.fa!.gameId,
      })
    ).ok,
  ).toBe(false);
  await revealTo(f, tr, 4, players);
  const r = players[1]!.c.snapshot!.fa!.reveal!;
  expect(r.voteResult).toBe('none');
  expect(r.votes!.reduce((s, v) => s + v.count, 0)).toBe(0);
  expect(r.caught).toBe(false);
  expect(r.outcome).toBe('NO_CONTEST');
  tr.close();
  teardown(f);
});

test('함께 참여하는 방장: 방장도 카드를 받고 그린다 (4명)', async () => {
  const f = await setupFa(4, 'play');
  const players = allPlayers(f);
  expect(players.length).toBe(4);
  await startFa(f);
  await ackAll(players);
  expect(f.host.snapshot!.fa!.me.isPlayer).toBe(true);
  expect(f.host.snapshot!.fa!.me.card).not.toBeNull();
  roles(players);
  await drawAll(f, players);
  expect(f.host.snapshot!.fa!.committed.length).toBe(8);
  teardown(f);
});

// ---------------------------------------------------------------- 브라우저: 한 획 캔버스·음악

async function drag(page: Page, sel: string, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await page.locator(sel).boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], {
    steps: 10,
  });
  await page.mouse.up();
}

test('한 획 캔버스: 펜을 떼면 잠기고, 두 번째 선·두 번째 손가락은 무시, pointercancel·창 blur 도 종료', async ({ page }) => {
  await page.goto('/dev/fa');
  const sel = 'canvas[data-fa-canvas]';
  await drag(page, sel, [0.2, 0.2], [0.6, 0.5]);
  const first = await page.evaluate(() => ({
    ends: window.__fa!.ends,
    n: window.__fa!.last!.p.length,
  }));
  expect(first.ends).toBe(1);
  expect(first.n).toBeGreaterThan(4);
  await expect(page.getByTestId('status')).toContainText('잠김');
  // 두 번째 선은 그려지지 않는다
  await drag(page, sel, [0.7, 0.7], [0.9, 0.9]);
  expect(
    await page.evaluate(() => ({
      ends: window.__fa!.ends,
      n: window.__fa!.last!.p.length,
    })),
  ).toEqual(first);
  // 확정 후 다음 사람: 터치 두 손가락 — 두 번째 포인터는 무시, pointercancel 로 끝남
  await page.getByTestId('commit').click();
  const r = await page.evaluate(() => {
    const c = document.querySelector('canvas[data-fa-canvas]')!;
    const b = c.getBoundingClientRect();
    const ev = (type: string, id: number, x: number, y: number) =>
      c.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          isPrimary: id === 1,
          clientX: b.left + x,
          clientY: b.top + y,
          bubbles: true,
          cancelable: true,
        }),
      );
    const before = window.__fa!.ends;
    ev('pointerdown', 1, 50, 50);
    ev('pointermove', 1, 90, 80);
    ev('pointerdown', 2, 200, 200); // 두 번째 손가락
    ev('pointermove', 2, 260, 260);
    ev('pointermove', 1, 140, 120);
    ev('pointercancel', 1, 140, 120);
    const last = window.__fa!.last!;
    const xs = (last.p as number[]).filter((_: number, i: number) => i % 2 === 0);
    return {
      ends: window.__fa!.ends - before,
      points: last.p.length / 2,
      maxX: Math.max(...xs),
    };
  });
  expect(r.ends).toBe(1);
  expect(r.points).toBe(3);
  // 논리 좌표로 두 번째 손가락(260px)의 흔적이 없다
  const width = (await page.locator(sel).boundingBox())!.width;
  expect(r.maxX).toBeLessThan((150 / width) * 800);
  // 창이 포커스를 잃으면 그리던 획을 끝낸다
  await page.getByTestId('redo').click();
  const box = (await page.locator(sel).boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 60, { steps: 4 });
  const endsBefore = await page.evaluate(() => window.__fa!.ends);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  expect(await page.evaluate(() => window.__fa!.ends)).toBe(endsBefore + 1);
});

test('대기 음악: 켜기를 여러 번 눌러도 루프는 하나, 멈춤·끄기', async ({ page }) => {
  await page.goto('/dev/fa');
  expect(await page.evaluate(() => window.__waitingMusic!.state)).toBe('off'); // 기본은 꺼짐
  for (let i = 0; i < 3; i++) await page.getByTestId('music-on').click();
  await page.waitForFunction(() => window.__waitingMusic!.state !== 'off');
  const s = await page.evaluate(() => ({
    state: window.__waitingMusic!.state,
    loops: window.__waitingMusic!.activeLoops,
  }));
  if (s.state === 'on') expect(s.loops).toBe(1);
  else expect(s.loops).toBe(0); // 오디오를 못 쓰는 환경: 게임은 그대로, 루프 없음
  await page.getByTestId('music-off').click();
  expect(await page.evaluate(() => window.__waitingMusic!.activeLoops)).toBe(0);
  await page.evaluate(() => window.__waitingMusic!.disable());
  expect(await page.evaluate(() => window.__waitingMusic!.state)).toBe('off');
});

// ---------------------------------------------------------------- 브라우저: 실제 학생 화면

test('학생 브라우저: 색 고르기 → 카드 확인 → 내 차례에 한 획 → 투표 → 공개를 방장과 함께 본다', async ({ browser }) => {
  test.setTimeout(180_000);
  const f = await setupFa(3, 'observe', {}, { ready: false });
  for (const [i, p] of f.players.entries()) {
    await p.c.command({ type: 'fa.color', colorIndex: i });
    await p.c.command({ type: 'room.ready', ready: true });
  }
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(`/join/${f.code}`);
  await page.getByPlaceholder('예: 바나나').fill('브라우저');
  await page.getByRole('button', { name: '참여하기' }).click();
  await expect(page).toHaveURL(/\/class\/c_/);
  await expect(page.getByText('가짜 예술가 찾기').first()).toBeVisible();
  await page.getByRole('button', { name: '참여하기' }).click();
  await expect(page).toHaveURL(/\/room\//);
  // 이미 쓰인 색은 고를 수 없고, 색을 고르기 전에는 준비 불가
  await expect(page.getByRole('button', { name: '먼저 펜 색을 골라 주세요' })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /학생1 사용 중/ })).toBeDisabled();
  await page.getByRole('radio', { name: FA_COLORS[6]!.name, exact: true }).click();
  await page.getByRole('button', { name: '준비 완료!' }).click();
  await f.host.waitFor((c) => c.snapshot!.members.filter((m) => m.isPlayer).length === 4 && c.snapshot!.members.filter((m) => m.isPlayer).every((m) => m.ready), 10000, 'all ready');
  const me = f.host.snapshot!.members.find((m) => m.displayName === '브라우저')!.userId;

  await startFa(f);
  await page.getByRole('button', { name: '확인했어요' }).click();
  const harness = f.players.map((p) => ({ c: p.c, name: p.name }));
  await ackAll(harness);
  await f.host.waitStatus('DRAWING');

  let drewTurns = 0;
  for (let guard = 0; guard < 20 && f.host.snapshot!.status === 'DRAWING'; guard++) {
    const fa = f.host.snapshot!.fa!;
    if (fa.activePlayerId === me) {
      await expect(page.getByText('내 차례예요!')).toBeVisible();
      const sel = 'canvas[data-fa-canvas]';
      await drag(page, sel, [0.3, 0.3], [0.5, 0.6]);
      await drag(page, sel, [0.7, 0.2], [0.8, 0.3]); // 무시되어야 한다
      await page.getByRole('button', { name: '이 획으로 확정' }).click();
      drewTurns++;
      if (drewTurns === 1) {
        // 기다리는 동안 음악을 켜 둔다 — 루프는 하나, 내 차례가 되면 멈춘다
        await page.getByRole('button', { name: '기다리는 동안 음악 켜기' }).click();
        await page.waitForFunction(() => window.__waitingMusic!.state !== 'off');
        if ((await page.evaluate(() => window.__waitingMusic!.state)) === 'on') {
          await expect.poll(() => page.evaluate(() => window.__waitingMusic!.activeLoops)).toBe(1);
        }
      }
    } else {
      const p = harness.find((h) => uid(h.c) === fa.activePlayerId)!;
      await p.c.command({
        type: 'fa.commit',
        gameId: fa.gameId,
        turnId: fa.phaseId,
        revision: 0,
        stroke: strokeFor(p.c, fa.turnIndex),
      });
    }
    await f.host.waitFor((c) => c.snapshot!.status !== 'DRAWING' || c.snapshot!.fa!.phaseId !== fa.phaseId, 20000, 'next turn');
  }
  expect(drewTurns).toBe(2);
  const mine = f.host.snapshot!.fa!.committed.filter((c) => c.playerId === me);
  expect(mine.length).toBe(2);
  for (const c of mine) {
    expect(c.stroke!.c).toBe(FA_COLORS[6]!.hex);
    // 한 획에 두 번째 드래그(오른쪽 위)의 점이 섞이지 않았다
    expect(Math.max(...c.stroke!.p.filter((_, i) => i % 2 === 0))).toBeLessThan(0.6 * 800);
  }

  await f.host.waitStatus('VOTING');
  // 그리기가 끝나면 기다리는 음악도 멈춘다 (켜 두었더라도)
  await expect.poll(() => page.evaluate(() => window.__waitingMusic!.activeLoops)).toBe(0);
  await page.getByRole('radio', { name: /학생1/ }).click();
  await page.getByRole('button', { name: '투표 확정' }).click();
  await expect(page.getByText('내 투표 (바꿀 수 없어요)')).toBeVisible();
  for (const p of harness) await vote(p, p.name === '학생1' ? harness[1]! : harness[0]!);
  await f.host.waitStatus('FINAL_GUESS');
  const iAmFake = harness.every((h) => h.c.snapshot!.fa!.me.card?.role === 'artist');
  if (iAmFake) {
    const input = page.getByLabel('최종 추측');
    await input.fill('고양이');
    await input.press('Enter');
    await expect(page.getByText('최종 추측을 냈어요')).toBeVisible();
  } else {
    await expect(page.getByText('최종 추측을 기다리는 중')).toBeVisible();
  }
  await f.host.waitStatus('REVEAL_READY', 30000);
  await expect(page.getByText('방장이 결과 공개를 준비하고 있어요')).toBeVisible();
  await revealTo(f, f.host, 3, []);
  await expect(page.getByText('3. 가짜 예술가의 최종 추측')).toBeVisible();
  await expect(page.getByText('4. 제시어는')).toHaveCount(0);
  await revealTo(f, f.host, 4, []);
  await expect(page.getByText('4. 제시어는')).toBeVisible();
  await expect(page.getByText(f.host.snapshot!.fa!.reveal!.word!, { exact: true })).toBeVisible();
  // 학생 화면에는 공개 진행 버튼이 없다
  await expect(page.getByRole('button', { name: /공개 →/ })).toHaveCount(0);
  await ctx.close();
  teardown(f);
});
