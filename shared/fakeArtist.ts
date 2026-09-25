/**
 * '가짜 예술가 찾기' 모드 — 서버·클라이언트가 함께 쓰는 규칙과 상수.
 *
 * ⚠ 여기에는 **제시어 목록을 두지 않는다.** 이 파일은 프런트엔드 번들에 들어간다.
 *    제시어·동의어는 worker/lib/fakeArtistWords.ts (서버 전용)에만 있다.
 *
 * 온라인 수업용 변형이다. 공식 보드게임의 인원수·출제자 역할·세부 판정과 같다고 주장하지 않는다.
 */
import type { Stroke } from './types';
import { ValidationError } from './validation';

export type GameMode = 'TELESTRATION' | 'FAKE_ARTIST';
export const GAME_MODES: readonly GameMode[] = ['TELESTRATION', 'FAKE_ARTIST'];

export const GAME_MODE_LABEL: Record<GameMode, string> = {
  TELESTRATION: '그림 이어말하기',
  FAKE_ARTIST: '가짜 예술가 찾기',
};

/** 흰 배경에서 서로 구분되는 12색. 색만으로 구분하지 않도록 이름을 함께 쓴다. */
export const FA_COLORS = [
  { hex: '#212529', name: '검정' },
  { hex: '#e03131', name: '빨강' },
  { hex: '#f76707', name: '주황' },
  { hex: '#a07800', name: '황토' },
  { hex: '#5c940d', name: '연두' },
  { hex: '#2b8a3e', name: '초록' },
  { hex: '#0c8599', name: '청록' },
  { hex: '#1c7ed6', name: '하늘' },
  { hex: '#364fc7', name: '남색' },
  { hex: '#7048e8', name: '보라' },
  { hex: '#d6336c', name: '분홍' },
  { hex: '#8b5a2b', name: '갈색' },
] as const;

/** 모두 같은 굵기 (논리 좌표 800×600 기준) */
export const FA_STROKE_WIDTH = 8;
/** 한 획의 최대 점 수. 넘으면 클라이언트가 경로를 솎아 낸다. */
export const FA_MAX_POINTS = 300;

/** 분류 이름만 둔다. 분류별 제시어는 서버에만 있다. */
export const FA_CATEGORIES = [
  { id: 'animal', label: '동물' },
  { id: 'food', label: '음식' },
  { id: 'vehicle', label: '탈것' },
  { id: 'household', label: '생활용품' },
  { id: 'place', label: '장소' },
  { id: 'nature', label: '자연' },
  { id: 'job', label: '직업' },
  { id: 'sport', label: '운동' },
] as const;
export type FaCategoryId = (typeof FA_CATEGORIES)[number]['id'];

export function faCategoryLabel(id: string): string {
  return FA_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}
export function isFaCategoryId(id: unknown): id is FaCategoryId {
  return typeof id === 'string' && FA_CATEGORIES.some((c) => c.id === id);
}

export type FaTurnSeconds = 15 | 20 | 30;
export type FaDiscussionSeconds = 0 | 30 | 60;
export const FA_TURN_SECONDS: readonly FaTurnSeconds[] = [15, 20, 30];
export const FA_DISCUSSION_SECONDS: readonly FaDiscussionSeconds[] = [0, 30, 60];

/** 카드 확인 · 투표 · 최종 추측 시간. 최종 추측은 **항상 같은 길이**로 둔다 — 일찍 끝나면 가짜가 누구인지 새어 나간다. */
export const FA_ROLE_SECONDS = 10;
export const FA_VOTE_SECONDS = 20;
export const FA_GUESS_SECONDS = 20;
export const FA_GUESS_MAX = 40;

export interface FaSettings {
  categoryId: FaCategoryId;
  turnSeconds: FaTurnSeconds;
  discussionSeconds: FaDiscussionSeconds;
}
export const FA_DEFAULT_SETTINGS: FaSettings = { categoryId: 'animal', turnSeconds: 20, discussionSeconds: 30 };

export type FaOutcome = 'NO_CONTEST' | 'FAKE_WINS' | 'FAKE_COMEBACK' | 'ARTISTS_WIN';
export type FaVoteResult = 'single' | 'tie' | 'none';

export const FA_OUTCOME_LABEL: Record<FaOutcome, string> = {
  NO_CONTEST: '투표 불성립 — 이번 판은 승패가 없어요',
  FAKE_WINS: '가짜 예술가 승리!',
  FAKE_COMEBACK: '가짜 예술가 역전 승리!',
  ARTISTS_WIN: '예술가 팀 승리!',
};

// ---------- 턴 ----------

export function faTotalTurns(playerCount: number): number {
  return playerCount * 2;
}
/** 턴 t 의 차례인 플레이어 인덱스. 두 바퀴 모두 같은 순서. */
export function faTurnPlayerIndex(playerCount: number, turnIndex: number): number {
  return turnIndex % playerCount;
}
export function faRound(playerCount: number, turnIndex: number): number {
  return Math.floor(turnIndex / playerCount) + 1;
}
export function faEstimatedDrawingSeconds(playerCount: number, turnSeconds: number): number {
  return faTotalTurns(playerCount) * turnSeconds;
}

// ---------- 정답 판정 ----------

/**
 * 답을 비교하기 전에 명시적으로 적용하는 정규화:
 *  1) 유니코드 NFKC 정규화 (전각·반각, 조합형 한글 등을 한 가지 표기로)
 *  2) 앞뒤 공백 제거
 *  3) 연속 공백을 하나로
 *  4) 영문 소문자화
 * 비교할 때는 여기에 더해 **공백을 모두 없앤 형태**로 맞춘다 ('아이스 크림' = '아이스크림').
 * 유사도·AI 판정은 쓰지 않는다. 등록된 정답·동의어와 글자가 같아야 정답이다.
 */
export function normalizeAnswer(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
export function answerKey(input: string): string {
  return normalizeAnswer(input).replace(/\s/g, '');
}
export function isAcceptedAnswer(guess: string | null | undefined, accepted: readonly string[]): boolean {
  if (!guess) return false;
  const key = answerKey(guess);
  if (!key) return false;
  return accepted.some((a) => answerKey(a) === key);
}

// ---------- 투표 판정 ----------

export interface FaTally {
  tally: { playerId: string; count: number }[];
  voteResult: FaVoteResult;
  topPlayerId: string | null;
  validVotes: number;
}

/**
 * 이 앱의 명시적 투표 판정 (온라인용):
 *  - 유효 투표 = 시작 때 확정된 플레이어가, 자기 아닌 다른 플레이어에게 한 표
 *  - 유효 투표가 0 → 'none' (투표 불성립)
 *  - 최다 득표자가 한 명 → 'single'
 *  - 최다 득표 동률 → 'tie' (발각 실패로 본다). 재투표는 하지 않는다.
 */
export function tallyVotes(players: readonly string[], votes: Readonly<Record<string, string>>): FaTally {
  const counts = new Map<string, number>(players.map((p) => [p, 0]));
  let valid = 0;
  for (const [voter, target] of Object.entries(votes)) {
    if (!counts.has(voter) || !counts.has(target) || voter === target) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
    valid += 1;
  }
  const tally = players.map((p) => ({ playerId: p, count: counts.get(p) ?? 0 }));
  if (valid === 0) return { tally, voteResult: 'none', topPlayerId: null, validVotes: 0 };
  const max = Math.max(...tally.map((t) => t.count));
  const tops = tally.filter((t) => t.count === max);
  if (tops.length === 1) return { tally, voteResult: 'single', topPlayerId: tops[0]!.playerId, validVotes: valid };
  return { tally, voteResult: 'tie', topPlayerId: null, validVotes: valid };
}

/**
 * 최종 결과:
 *  - 투표 불성립 → 승패 없음
 *  - 발각 실패(다른 사람 단독 최다, 또는 동률) → 가짜 예술가 승리
 *  - 발각 + 최종 추측 정답 → 가짜 예술가 역전 승리
 *  - 발각 + 최종 추측 오답·미제출 → 예술가 팀 승리
 */
export function judgeFakeArtist(t: Pick<FaTally, 'voteResult' | 'topPlayerId'>, fakeArtistId: string, guessCorrect: boolean): { caught: boolean; outcome: FaOutcome } {
  if (t.voteResult === 'none') return { caught: false, outcome: 'NO_CONTEST' };
  const caught = t.voteResult === 'single' && t.topPlayerId === fakeArtistId;
  if (!caught) return { caught, outcome: 'FAKE_WINS' };
  return { caught, outcome: guessCorrect ? 'FAKE_COMEBACK' : 'ARTISTS_WIN' };
}

// ---------- 한 획 검증 ----------

/**
 * '한 획' = 하나의 pointerdown 부터 pointerup 까지의 경로 하나.
 * 서버가 확인하는 것: 경로가 **하나의 객체**인지(배열·여러 경로 아님), 도구가 펜인지,
 * 지정된 색·굵기인지, 점 개수와 좌표 범위. 물리적으로 손을 뗐는지까지는 서버가 증명할 수 없다.
 */
export function validateFaStroke(raw: unknown, colorHex: string): Stroke {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('한 번에 하나의 선만 그릴 수 있어요');
  const s = raw as Record<string, unknown>;
  if (s.t !== 'pen') throw new ValidationError('펜으로만 그릴 수 있어요');
  if (s.c !== colorHex) throw new ValidationError('내 색으로만 그릴 수 있어요');
  if (s.w !== FA_STROKE_WIDTH) throw new ValidationError('굵기는 바꿀 수 없어요');
  if (!Array.isArray(s.p) || s.p.length < 2 || s.p.length % 2 !== 0) throw new ValidationError('선 모양이 올바르지 않아요');
  if (s.p.length / 2 > FA_MAX_POINTS) throw new ValidationError('선이 너무 길어요');
  const points: number[] = [];
  for (let i = 0; i < s.p.length; i += 2) {
    const x = s.p[i];
    const y = s.p[i + 1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new ValidationError('좌표가 올바르지 않아요');
    if (x < -20 || x > 820 || y < -20 || y > 620) throw new ValidationError('좌표 범위 밖');
    points.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  }
  return { t: 'pen', c: colorHex, w: FA_STROKE_WIDTH, p: points };
}

/** 경로가 너무 길면 점을 솎아 낸다 (처음과 끝은 남긴다) */
export function simplifyPoints(points: number[], maxPoints = FA_MAX_POINTS): number[] {
  let p = points;
  while (p.length / 2 > maxPoints) {
    const next: number[] = [];
    const n = p.length / 2;
    for (let i = 0; i < n; i++) if (i % 2 === 0 || i === n - 1) next.push(p[i * 2]!, p[i * 2 + 1]!);
    p = next;
  }
  return p;
}

// ---------- 화면에 내려가는 모양 ----------

export interface FaPlayerView {
  userId: string;
  displayName: string;
  number: number;
  color: number;
  connected: boolean;
  left: boolean;
  isHost: boolean;
}

export interface FaStrokeView {
  playerId: string;
  turnIndex: number;
  /** null = 이번 차례 건너뜀 */
  stroke: Stroke | null;
}

/** 개인 카드. 가짜 예술가의 카드에는 제시어가 **없다**. */
export type FaCard =
  | { role: 'artist'; categoryId: string; categoryLabel: string; word: string }
  | { role: 'fake'; categoryId: string; categoryLabel: string };

/** 공개 단계별로 채워진다. 아직 공개하지 않은 단계의 필드는 **아예 없다**. */
export interface FaRevealView {
  step: number; // 0: 그림만, 1: 투표, 2: 가짜, 3: 최종 추측, 4: 제시어·승패
  revision: number;
  highlightPlayerId: string | null;
  votes?: { playerId: string; count: number }[];
  voteResult?: FaVoteResult;
  topPlayerId?: string | null;
  fakeArtistId?: string;
  caught?: boolean;
  finalGuess?: { text: string | null; affectsOutcome: boolean };
  word?: string;
  guessCorrect?: boolean;
  outcome?: FaOutcome;
}

export interface FaView {
  gameId: string;
  /** 단계·턴마다 바뀐다. 모든 명령에 함께 보내 지난 단계의 요청을 거른다 (턴 ID 로도 쓴다). */
  phaseId: string;
  categoryId: string;
  categoryLabel: string;
  players: FaPlayerView[];
  totalTurns: number;
  turnIndex: number;
  round: number;
  activePlayerId: string | null;
  nextPlayerId: string | null;
  turnSeconds: number;
  discussionSeconds: number;
  committed: FaStrokeView[];
  draft: { playerId: string; turnIndex: number; revision: number; stroke: Stroke | null } | null;
  roleAckCount: number;
  votedCount: number;
  voterTotal: number;
  me: {
    isPlayer: boolean;
    card: FaCard | null;
    roleAcked: boolean;
    /** 내가 확정한 투표 (나만 본다) */
    myVote: string | null;
    /** 가짜 예술가 본인이고 최종 추측 시간이며 아직 내지 않았을 때만 true */
    canGuess: boolean;
    /** 가짜 예술가 본인에게만 의미가 있다. 다른 사람에게는 항상 false. */
    guessSubmitted: boolean;
  };
  reveal: FaRevealView | null;
}
