import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FA_CATEGORIES,
  FA_COLORS,
  FA_MAX_POINTS,
  FA_STROKE_WIDTH,
  answerKey,
  faRound,
  faTotalTurns,
  faTurnPlayerIndex,
  isAcceptedAnswer,
  judgeFakeArtist,
  normalizeAnswer,
  simplifyPoints,
  tallyVotes,
  validateFaStroke,
} from '../../shared/fakeArtist';
import { FA_WORDS, faWordCount, pickFaWord } from '../../worker/lib/fakeArtistWords';
import { buildFaView, type FaPublicState, type FaSecretState } from '../../worker/lib/fakeArtist';
import type { RoomStatus } from '../../shared/types';

describe('턴 순서 (4~12명)', () => {
  for (let n = 4; n <= 12; n++) {
    it(`${n}명: 정확히 2N 턴, 두 바퀴 같은 순서, 각자 두 번`, () => {
      const total = faTotalTurns(n);
      expect(total).toBe(2 * n);
      const counts = new Array(n).fill(0);
      for (let t = 0; t < total; t++) {
        const p = faTurnPlayerIndex(n, t);
        counts[p] += 1;
        expect(faRound(n, t)).toBe(t < n ? 1 : 2);
        if (t >= n) expect(p).toBe(faTurnPlayerIndex(n, t - n)); // 두 번째 바퀴도 같은 순서
      }
      expect(counts.every((c) => c === 2)).toBe(true);
    });
  }
});

describe('투표 판정', () => {
  const P = ['a', 'b', 'c', 'd'];
  it('가짜가 단독 최다 → 발각', () => {
    const t = tallyVotes(P, { a: 'd', b: 'd', c: 'a', d: 'a' === 'a' ? 'b' : 'b' });
    expect(t.voteResult).toBe('single');
    expect(t.topPlayerId).toBe('d');
    expect(judgeFakeArtist(t, 'd', false)).toEqual({ caught: true, outcome: 'ARTISTS_WIN' });
    expect(judgeFakeArtist(t, 'd', true)).toEqual({ caught: true, outcome: 'FAKE_COMEBACK' });
  });
  it('다른 사람이 단독 최다 → 발각 실패, 가짜 승리', () => {
    const t = tallyVotes(P, { a: 'b', c: 'b', d: 'a' });
    expect(t.topPlayerId).toBe('b');
    expect(judgeFakeArtist(t, 'd', true).outcome).toBe('FAKE_WINS');
  });
  it('최다 득표 동률 → 발각 실패', () => {
    const t = tallyVotes(P, { a: 'b', b: 'd', c: 'b', d: 'c' === 'c' ? 'b' : 'b' });
    // b:3 — 단독. 동률 사례를 따로 만든다
    const tie = tallyVotes(P, { a: 'b', b: 'a', c: 'd', d: 'c' });
    expect(t.voteResult).toBe('single');
    expect(tie.voteResult).toBe('tie');
    expect(tie.topPlayerId).toBeNull();
    expect(judgeFakeArtist(tie, 'd', true)).toEqual({ caught: false, outcome: 'FAKE_WINS' });
  });
  it('유효 투표 0 (전원 기권) → 투표 불성립, 승패 없음', () => {
    const t = tallyVotes(P, {});
    expect(t.voteResult).toBe('none');
    expect(judgeFakeArtist(t, 'd', true).outcome).toBe('NO_CONTEST');
  });
  it('자기 투표·후보 밖 투표는 무효로 센다', () => {
    const t = tallyVotes(P, { a: 'a', b: 'zzz', x: 'a' });
    expect(t.validVotes).toBe(0);
    expect(t.voteResult).toBe('none');
  });
});

describe('최종 추측 정답 판정', () => {
  const accepted = ['계란프라이', '달걀프라이', '계란후라이'];
  it('정규화: NFKC, 앞뒤 공백, 연속 공백, 소문자', () => {
    expect(normalizeAnswer('  계란   프라이 ')).toBe('계란 프라이');
    expect(normalizeAnswer('ＴＶ')).toBe('tv');
    expect(answerKey(' 아이스 크림 ')).toBe('아이스크림');
  });
  it('정답·동의어·띄어쓰기 차이는 정답', () => {
    expect(isAcceptedAnswer('계란프라이', accepted)).toBe(true);
    expect(isAcceptedAnswer('달걀프라이', accepted)).toBe(true);
    expect(isAcceptedAnswer(' 계란 후라이 ', accepted)).toBe(true);
  });
  it('오답·빈 답·미제출은 오답 (유사도로 봐주지 않는다)', () => {
    expect(isAcceptedAnswer('계란', accepted)).toBe(false);
    expect(isAcceptedAnswer('계란프라', accepted)).toBe(false);
    expect(isAcceptedAnswer('', accepted)).toBe(false);
    expect(isAcceptedAnswer('   ', accepted)).toBe(false);
    expect(isAcceptedAnswer(null, accepted)).toBe(false);
  });
  it('조합형 한글(NFD)도 같은 글자로 본다', () => {
    const nfd = '고양이'.normalize('NFD');
    expect(isAcceptedAnswer(nfd, ['고양이'])).toBe(true);
  });
});

describe('한 획 검증', () => {
  const color = FA_COLORS[2].hex;
  const good = { t: 'pen', c: color, w: FA_STROKE_WIDTH, p: [10, 10, 50, 60, 20, 30] };
  it('경로 하나는 통과', () => {
    expect(validateFaStroke(good, color).p.length).toBe(6);
    expect(validateFaStroke({ ...good, p: [5, 5] }, color).p).toEqual([5, 5]); // 점 하나
  });
  it('여러 경로(배열)는 거부', () => {
    expect(() => validateFaStroke([good, good], color)).toThrow('하나의 선');
  });
  it('다른 색·굵기·지우개는 거부 (흰 펜으로 가리기 불가)', () => {
    expect(() => validateFaStroke({ ...good, c: FA_COLORS[3].hex }, color)).toThrow();
    expect(() => validateFaStroke({ ...good, c: '#ffffff' }, color)).toThrow();
    expect(() => validateFaStroke({ ...good, w: 40 }, color)).toThrow();
    expect(() => validateFaStroke({ ...good, t: 'eraser' }, color)).toThrow();
  });
  it('점 개수·좌표 상한', () => {
    expect(() => validateFaStroke({ ...good, p: new Array((FA_MAX_POINTS + 1) * 2).fill(3) }, color)).toThrow();
    expect(() => validateFaStroke({ ...good, p: [0, 0, Number.NaN, 1] }, color)).toThrow();
    expect(() => validateFaStroke({ ...good, p: [0, 0, 5000, 1] }, color)).toThrow();
  });
  it('긴 경로는 솎아 내면 상한 안으로 들어오고 끝점은 남는다', () => {
    const pts: number[] = [];
    for (let i = 0; i < 1000; i++) pts.push(i % 800, (i * 3) % 600);
    const s = simplifyPoints(pts);
    expect(s.length / 2).toBeLessThanOrEqual(FA_MAX_POINTS);
    expect(s.slice(-2)).toEqual(pts.slice(-2));
    expect(s.slice(0, 2)).toEqual(pts.slice(0, 2));
  });
});

describe('제시어 목록 (서버 전용)', () => {
  it('8개 분류 모두 제시어가 있고, 합계 200개 이상', () => {
    for (const c of FA_CATEGORIES) expect(FA_WORDS[c.id].length).toBeGreaterThanOrEqual(20);
    expect(faWordCount()).toBeGreaterThanOrEqual(200);
  });
  it('id 중복 없음, 제시어 자신이 정답 목록에 들어 있음, 짧다', () => {
    const ids = new Set<string>();
    for (const list of Object.values(FA_WORDS)) {
      for (const w of list) {
        expect(ids.has(w.wordId)).toBe(false);
        ids.add(w.wordId);
        expect(isAcceptedAnswer(w.word, w.accepted)).toBe(true);
        expect(w.word.length).toBeLessThanOrEqual(8);
      }
    }
  });
  it('최근에 나온 제시어는 피한다', () => {
    const recent = FA_WORDS.animal.slice(0, FA_WORDS.animal.length - 1).map((w) => w.wordId);
    const last = FA_WORDS.animal[FA_WORDS.animal.length - 1]!;
    for (let i = 0; i < 20; i++) expect(pickFaWord('animal', recent, Math.random).wordId).toBe(last.wordId);
    // 전부 최근이면 제한을 풀고 뽑는다
    const all = FA_WORDS.animal.map((w) => w.wordId);
    expect(FA_WORDS.animal.map((w) => w.wordId)).toContain(pickFaWord('animal', all, Math.random).wordId);
  });
  it('프런트엔드(src/, shared/)는 제시어 파일을 가져오지 않고, 제시어도 담지 않는다', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk('src');
    walk('shared');
    // 다른 곳에서 쓰지 않는, 이 목록에만 있는 표기들
    const probes = ['훌라후프', '케이블카', '수의사', '포클레인', '해수욕장', '회오리바람', '어릿광대'];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      // 주석에서 이름을 언급하는 것은 괜찮다. 실제로 가져오는(import) 곳이 없어야 한다.
      expect(text, f).not.toMatch(/(from|import)\s*\(?\s*['"][^'"]*fakeArtistWords/);
      for (const w of probes) expect(text.includes(w), `${f} 에 '${w}'`).toBe(false);
    }
  });
  // 빌드한 뒤에만 의미가 있다 (npm run build → npm test). 빌드 결과가 없으면 건너뛴다.
  it.skipIf(!existsSync('dist/client'))('빌드된 클라이언트 번들에 제시어 목록이 들어 있지 않다', () => {
    const bundle: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(js|html|css|json)$/.test(name)) bundle.push(readFileSync(full, 'utf8'));
      }
    };
    walk('dist/client');
    // 압축기가 한글을 \uXXXX 로 바꿔 둘 수도 있으니 풀어서 비교한다
    const js = bundle.join('\n').replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    // 화면 문구에 우연히 같은 낱말(예: '선생님')이 있을 수 있으므로, 앱 소스에 없는 낱말만 따진다
    const uiSources: string[] = [];
    const walkSrc = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walkSrc(full);
        else if (/\.(ts|tsx|html|css)$/.test(name)) uiSources.push(readFileSync(full, 'utf8'));
      }
    };
    walkSrc('src');
    walkSrc('shared');
    uiSources.push(readFileSync('index.html', 'utf8'));
    const ui = uiSources.join('\n');
    const leaked = Object.values(FA_WORDS)
      .flat()
      .flatMap((w) => w.accepted)
      .filter((w) => w.length >= 2 && !ui.includes(w) && js.includes(w));
    expect(leaked).toEqual([]);
  });
});

describe('개인별 화면: 비밀 정보가 새지 않는다', () => {
  const players = ['p1', 'p2', 'p3', 'p4'];
  const pub = (over: Partial<FaPublicState> = {}): FaPublicState => ({
    gameId: 'g1',
    categoryId: 'food',
    players,
    playerNames: { p1: '가', p2: '나', p3: '다', p4: '라' },
    playerNumbers: { p1: 1, p2: 2, p3: 3, p4: 4 },
    playerColors: { p1: 0, p2: 1, p3: 2, p4: 3 },
    turnSeconds: 20,
    discussionSeconds: 30,
    phaseId: 'ph1',
    turnIndex: 0,
    deadlineAt: 0,
    roleAcked: [],
    committed: [],
    draft: null,
    left: [],
    revealStep: -1,
    revealRevision: 0,
    highlightPlayerId: null,
    ...over,
  });
  const secret = (over: Partial<FaSecretState> = {}): FaSecretState => ({
    gameId: 'g1',
    wordId: 'food.cottoncandy',
    word: '솜사탕',
    accepted: ['솜사탕', '구름과자'],
    fakeArtistId: 'p3',
    votes: { p1: 'p3', p2: 'p3', p3: 'p1', p4: 'p3' },
    finalGuess: '구름과자',
    guessSubmitted: true,
    result: {
      tally: tallyVotes(players, { p1: 'p3', p2: 'p3', p3: 'p1', p4: 'p3' }),
      caught: true,
      guessCorrect: true,
      outcome: 'FAKE_COMEBACK',
    },
    ...over,
  });
  const view = (status: RoomStatus, viewerId: string, p = pub(), s = secret()) =>
    buildFaView({ pub: p, secret: s, status, viewerId, connected: new Set(players), hostId: 'teacher:t' });
  const SECRETS = ['솜사탕', '구름과자', 'cottoncandy'];
  const leaks = (v: unknown) => SECRETS.filter((w) => JSON.stringify(v).includes(w));

  it('진짜 예술가는 같은 제시어를 받는다', () => {
    for (const p of ['p1', 'p2', 'p4']) {
      const v = view('DRAWING', p);
      expect(v.me.card).toEqual({ role: 'artist', categoryId: 'food', categoryLabel: '음식', word: '솜사탕' });
    }
  });

  it('가짜 예술가는 분류만 받고, 제시어·wordId·동의어는 어디에도 없다', () => {
    for (const status of ['ROLE_REVEAL', 'DRAWING', 'DISCUSSION', 'VOTING', 'FINAL_GUESS', 'REVEAL_READY'] as RoomStatus[]) {
      const v = view(status, 'p3', pub(), secret({ finalGuess: null, guessSubmitted: false }));
      expect(v.me.card).toEqual({ role: 'fake', categoryId: 'food', categoryLabel: '음식' });
      expect(leaks(v), status).toEqual([]);
    }
  });

  it('참관자(교사·참관 방장)는 공개 전까지 제시어도, 가짜도, 투표 내용도 받지 않는다', () => {
    for (const status of ['ROLE_REVEAL', 'DRAWING', 'DISCUSSION', 'VOTING', 'FINAL_GUESS', 'REVEAL_READY'] as RoomStatus[]) {
      const v = view(status, 'teacher:t');
      expect(v.me.card).toBeNull();
      expect(v.reveal).toBeNull();
      expect(v.me.myVote).toBeNull();
      expect(v.me.canGuess).toBe(false);
      expect(leaks(v), status).toEqual([]);
      const json = JSON.stringify(v);
      expect(json).not.toMatch(/"fakeArtistId"|"role":"fake"|"votes"|"finalGuess"|"outcome"/);
    }
  });

  it('다른 사람의 투표 대상은 보이지 않고, 투표한 사람 수만 보인다', () => {
    const v = view('VOTING', 'p1');
    expect(v.me.myVote).toBe('p3'); // 내 표만
    expect(v.votedCount).toBe(4);
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/"p2":"p3"|"p4":"p3"/);
  });

  it('최종 추측 입력란과 제출 여부는 가짜 본인에게만', () => {
    const s = secret({ finalGuess: null, guessSubmitted: false });
    expect(view('FINAL_GUESS', 'p3', pub(), s).me.canGuess).toBe(true);
    for (const p of ['p1', 'p2', 'p4', 'teacher:t']) {
      const v = view('FINAL_GUESS', p, pub(), s);
      expect(v.me.canGuess).toBe(false);
      expect(v.me.guessSubmitted).toBe(false);
    }
    const done = secret({ guessSubmitted: true, finalGuess: '구름' });
    expect(view('FINAL_GUESS', 'p3', pub(), done).me.guessSubmitted).toBe(true);
    expect(view('FINAL_GUESS', 'p1', pub(), done).me.guessSubmitted).toBe(false);
  });

  it('공개 단계별로 필요한 필드만 채워진다 (건너뛰어 정답을 볼 수 없다)', () => {
    const at = (step: number) => view(step >= 4 ? 'FINISHED' : 'REVEALING', 'p1', pub({ revealStep: step })).reveal!;
    const r0 = at(0);
    expect(Object.keys(r0).sort()).toEqual(['highlightPlayerId', 'revision', 'step']);
    const r1 = at(1);
    expect(r1.votes?.find((v) => v.playerId === 'p3')?.count).toBe(3);
    expect(r1.voteResult).toBe('single');
    expect(r1.fakeArtistId).toBeUndefined();
    expect(leaks(r1)).toEqual([]);
    const r2 = at(2);
    expect(r2.fakeArtistId).toBe('p3');
    expect(r2.finalGuess).toBeUndefined();
    const r3 = at(3);
    expect(r3.finalGuess).toEqual({ text: '구름과자', affectsOutcome: true });
    expect(r3.word).toBeUndefined();
    expect(r3.outcome).toBeUndefined();
    const r4 = at(4);
    expect(r4.word).toBe('솜사탕');
    expect(r4.outcome).toBe('FAKE_COMEBACK');
    expect(r4.guessCorrect).toBe(true);
  });

  it('가짜 본인의 카드에도 공개 전에는 제시어가 없다 (결과 공개 4단계에서만 모두에게)', () => {
    const v = view('REVEALING', 'p3', pub({ revealStep: 3 }));
    expect(v.me.card).toEqual({ role: 'fake', categoryId: 'food', categoryLabel: '음식' });
    expect(JSON.stringify(v)).not.toContain('솜사탕');
  });

  it('나간 가짜 예술가도 후보·순서에 그대로 남는다', () => {
    const v = view('VOTING', 'p1', pub({ left: ['p3'] }));
    expect(v.players.map((p) => p.userId)).toEqual(players);
    expect(v.players.find((p) => p.userId === 'p3')!.left).toBe(true);
    expect(v.voterTotal).toBe(3);
  });
});
