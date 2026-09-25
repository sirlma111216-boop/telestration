/**
 * '가짜 예술가 찾기' 서버 상태와 개인별 화면 만들기.
 *
 * 상태를 **두 덩어리로 나눈다.**
 *   - FaPublicState: 모두가 봐도 되는 것 (순서·색·캔버스·턴·공개 단계). 저장 키 'room' 안에 있다.
 *   - FaSecretState: 제시어·가짜 예술가·투표·최종 추측·판정. 저장 키 'faSecret' 에 따로 둔다.
 *
 * 비밀 상태를 읽어 화면에 내보내는 곳은 이 파일의 buildFaView **한 곳뿐**이다.
 * 전체 객체를 보낸 뒤 화면에서 숨기는 방식은 쓰지 않는다 — 필드를 하나씩 골라 담는다.
 */
import type { RoomStatus, Stroke } from '@shared/types';
import {
  faCategoryLabel,
  faRound,
  faTotalTurns,
  faTurnPlayerIndex,
  type FaCard,
  type FaCategoryId,
  type FaOutcome,
  type FaRevealView,
  type FaTally,
  type FaView,
} from '@shared/fakeArtist';

export interface FaCommitted {
  playerId: string;
  turnIndex: number;
  /** 이 턴의 식별자. 같은 확정 요청이 두 번 와도 한 번만 반영하는 데 쓴다. */
  turnId: string;
  stroke: Stroke | null;
  /** true: 본인이 확정. false: 시간 초과로 서버가 확정했거나 건너뜀. */
  byCommit: boolean;
}

export interface FaPublicState {
  gameId: string;
  categoryId: FaCategoryId;
  /** 시작 때 섞어 고정한 순서. 중간에 나간 사람도 빼지 않는다. */
  players: string[];
  playerNames: Record<string, string>;
  playerNumbers: Record<string, number>;
  playerColors: Record<string, number>;
  turnSeconds: number;
  discussionSeconds: number;
  phaseId: string;
  /** DRAWING 중 현재 턴 (0부터). 시작 전 -1, 다 그리면 totalTurns. */
  turnIndex: number;
  deadlineAt: number | null;
  roleAcked: string[];
  committed: FaCommitted[];
  draft: { playerId: string; turnIndex: number; revision: number; stroke: Stroke | null } | null;
  /** 명시적으로 나간 사람. 남은 턴은 건너뛰고, 투표 후보에는 남는다. */
  left: string[];
  /** -1: 공개 전. 0: 그림만. 1~4: 단계별 공개. */
  revealStep: number;
  revealRevision: number;
  highlightPlayerId: string | null;
}

export interface FaResult {
  tally: FaTally;
  caught: boolean;
  guessCorrect: boolean;
  outcome: FaOutcome;
}

export interface FaSecretState {
  gameId: string;
  wordId: string;
  word: string;
  accepted: string[];
  fakeArtistId: string;
  /** 투표자 → 대상. 공개 전까지 누구에게도 보내지 않는다 (본인 표만 본인에게). */
  votes: Record<string, string>;
  finalGuess: string | null;
  guessSubmitted: boolean;
  /** 최종 추측 시간이 끝날 때 미리 계산해 두고, 공개 단계에 맞춰 조금씩 내보낸다. */
  result: FaResult | null;
}

export const FA_TIMED_STATUSES: readonly RoomStatus[] = ['ROLE_REVEAL', 'DRAWING', 'DISCUSSION', 'VOTING', 'FINAL_GUESS'];

export function faActivePlayerId(pub: FaPublicState): string | null {
  const n = pub.players.length;
  if (pub.turnIndex < 0 || pub.turnIndex >= faTotalTurns(n)) return null;
  return pub.players[faTurnPlayerIndex(n, pub.turnIndex)] ?? null;
}

/** 다음 차례 (나간 사람은 건너뛴다) */
export function faNextPlayerId(pub: FaPublicState): string | null {
  const n = pub.players.length;
  for (let t = pub.turnIndex + 1; t < faTotalTurns(n); t++) {
    const p = pub.players[faTurnPlayerIndex(n, t)]!;
    if (!pub.left.includes(p)) return p;
  }
  return null;
}

export function faActiveVoters(pub: FaPublicState): string[] {
  return pub.players.filter((p) => !pub.left.includes(p));
}

interface ViewArgs {
  pub: FaPublicState;
  secret: FaSecretState | null;
  status: RoomStatus;
  viewerId: string;
  connected: ReadonlySet<string>;
  hostId: string | null;
}

/** 공개 단계에 맞춰 필요한 필드만 채운다. 아직 공개하지 않은 단계의 값은 객체에 **넣지 않는다**. */
function buildReveal(pub: FaPublicState, secret: FaSecretState | null): FaRevealView {
  const view: FaRevealView = { step: pub.revealStep, revision: pub.revealRevision, highlightPlayerId: pub.highlightPlayerId };
  const r = secret?.result;
  if (!secret || !r) return view;
  if (pub.revealStep >= 1) {
    view.votes = r.tally.tally.map((t) => ({ playerId: t.playerId, count: t.count }));
    view.voteResult = r.tally.voteResult;
    view.topPlayerId = r.tally.topPlayerId;
  }
  if (pub.revealStep >= 2) {
    view.fakeArtistId = secret.fakeArtistId;
    view.caught = r.caught;
  }
  if (pub.revealStep >= 3) {
    view.finalGuess = { text: secret.guessSubmitted ? secret.finalGuess : null, affectsOutcome: r.caught };
  }
  if (pub.revealStep >= 4) {
    view.word = secret.word;
    view.guessCorrect = r.guessCorrect;
    view.outcome = r.outcome;
  }
  return view;
}

export function buildFaView({ pub, secret, status, viewerId, connected, hostId }: ViewArgs): FaView {
  const n = pub.players.length;
  const total = faTotalTurns(n);
  const drawing = status === 'DRAWING';
  const isOriginalPlayer = pub.players.includes(viewerId);
  const isPlayer = isOriginalPlayer && !pub.left.includes(viewerId);
  const categoryLabel = faCategoryLabel(pub.categoryId);

  // 개인 카드: 본인 것만. 가짜 예술가의 카드에는 제시어를 넣지 않는다.
  let card: FaCard | null = null;
  if (isOriginalPlayer && secret && status !== 'LOBBY') {
    card =
      secret.fakeArtistId === viewerId
        ? { role: 'fake', categoryId: pub.categoryId, categoryLabel }
        : { role: 'artist', categoryId: pub.categoryId, categoryLabel, word: secret.word };
  }
  const isFake = !!secret && secret.fakeArtistId === viewerId;

  return {
    gameId: pub.gameId,
    phaseId: pub.phaseId,
    categoryId: pub.categoryId,
    categoryLabel,
    players: pub.players.map((p) => ({
      userId: p,
      displayName: pub.playerNames[p] ?? '?',
      number: pub.playerNumbers[p] ?? 0,
      color: pub.playerColors[p] ?? 0,
      connected: connected.has(p),
      left: pub.left.includes(p),
      isHost: p === hostId,
    })),
    totalTurns: total,
    turnIndex: pub.turnIndex,
    round: drawing ? faRound(n, pub.turnIndex) : 0,
    activePlayerId: drawing ? faActivePlayerId(pub) : null,
    nextPlayerId: drawing ? faNextPlayerId(pub) : null,
    turnSeconds: pub.turnSeconds,
    discussionSeconds: pub.discussionSeconds,
    committed: pub.committed.map((c) => ({ playerId: c.playerId, turnIndex: c.turnIndex, stroke: c.stroke })),
    draft: drawing ? pub.draft : null,
    roleAckCount: pub.roleAcked.length,
    votedCount: secret ? Object.keys(secret.votes).length : 0,
    voterTotal: faActiveVoters(pub).length,
    me: {
      isPlayer,
      card,
      roleAcked: pub.roleAcked.includes(viewerId),
      myVote: secret?.votes[viewerId] ?? null,
      canGuess: status === 'FINAL_GUESS' && isFake && !secret!.guessSubmitted,
      guessSubmitted: isFake ? secret!.guessSubmitted : false,
    },
    reveal: status === 'REVEALING' || status === 'FINISHED' ? buildReveal(pub, secret) : null,
  };
}
