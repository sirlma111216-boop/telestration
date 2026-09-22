/**
 * 공용 타입 정의 (서버·클라이언트 공유)
 *
 * 역할 개념을 하나의 문자열로 뭉개지 않는다.
 *  - Actor: 요청을 보낸 사람의 신원 (교사 또는 학생)
 *  - HostGrant: 클래스 안에서 교사가 학생에게 준 "방 만들기/운영 자격"
 *  - Room.host: 특정 방의 현재 진행권을 가진 사용자
 *  - Game.players: 이번 판에서 실제로 작업을 쓰는 사람들
 */

export type RoomStatus =
  | 'LOBBY'
  | 'PROMPT_SELECTION'
  | 'PLAYING'
  | 'REVEAL_READY'
  | 'REVEALING'
  | 'FINISHED'
  | 'CLOSED';

export type HostMode = 'play' | 'observe';
export type PromptMode = 'choice' | 'custom';
export type EntryKind = 'prompt' | 'drawing' | 'guess';
export type DrawSeconds = 60 | 90 | 120;
export type GuessSeconds = 30 | 45 | 60;

/** 사용자 ID. 학생은 `s_<random>`, 교사는 `teacher:<teacherId>`. */
export type UserId = string;

export const LIMITS = {
  nicknameMin: 2,
  nicknameMax: 12,
  roomTitleMin: 2,
  roomTitleMax: 30,
  classNameMax: 30,
  capacityMin: 4,
  capacityMax: 12,
  promptMax: 40,
  guessMax: 80,
  promptSelectSeconds: 30,
  strokeMax: 600,
  pointsPerStrokeMax: 400,
  totalPointsMax: 30000,
  drawingBytesMax: 250_000,
  canvasWidth: 800,
  canvasHeight: 600,
  penWidths: [4, 9, 18] as const,
  eraserWidths: [12, 24, 40] as const,
  colors: [
    '#2b2f4a', // 잉크
    '#f4735f', // 코랄
    '#f5a623', // 주황
    '#f7d154', // 노랑
    '#7bc96f', // 초록
    '#6fcdb7', // 민트
    '#4aa3df', // 하늘
    '#3b5bdb', // 파랑
    '#b7a4f2', // 보라
    '#e85d9b', // 분홍
    '#a0724e', // 갈색
    '#9aa0ad', // 회색
  ] as const,
  dataTtlMs: 24 * 60 * 60 * 1000,
  reservationTtlMs: 20_000,
} as const;

export type StrokeTool = 'pen' | 'eraser';

export interface Stroke {
  t: StrokeTool;
  c: string; // 색상 (#rrggbb)
  w: number; // 논리 굵기
  p: number[]; // [x0,y0,x1,y1,...] 논리 좌표 (0..800, 0..600)
}

export interface DrawingPayload {
  kind: 'drawing';
  strokes: Stroke[];
}
export interface TextPayload {
  kind: 'text';
  text: string;
}
export type EntryPayload = DrawingPayload | TextPayload;

export interface RoomSettings {
  promptMode: PromptMode;
  drawSeconds: DrawSeconds;
  guessSeconds: GuessSeconds;
}

export interface MemberBadge {
  color: string;
  shape: 'circle' | 'square' | 'triangle' | 'star' | 'heart' | 'diamond';
  number: number; // 방 안에서 1부터
}

export interface RoomMemberView {
  userId: UserId;
  nickname: string;
  displayName: string; // 동명이인 구분 포함
  isTeacher: boolean;
  badge: MemberBadge;
  connected: boolean;
  ready: boolean;
  left: boolean;
  /** 현재 판의 플레이어인지 */
  isPlayer: boolean;
  /** 현재 방장인지 */
  isHost: boolean;
}

export interface RoomHostView {
  userId: UserId | null;
  displayName: string | null;
  mode: HostMode;
  /** 방장이 현재 판의 플레이어인지 (플레이 중이면 모니터링 불가) */
  isPlayingThisGame: boolean;
  connected: boolean;
}

export interface EntryView {
  index: number;
  stage: number;
  kind: EntryKind;
  authorUserId: UserId;
  authorName: string;
  payload: EntryPayload;
  timedOut: boolean;
  skipped: boolean;
}

/** 현재 단계에서 나에게 배정된 작업 */
export interface MyAssignment {
  gameId: string;
  stage: number;
  stageId: string;
  bookId: string;
  bookOwnerName: string;
  kind: 'drawing' | 'guess';
  /** 직전 항목. 없으면(시간 초과·건너뜀) null */
  previous: EntryView | null;
  submitted: boolean;
  /** 서버에 마지막으로 저장된 초안 */
  draft: EntryPayload | null;
  draftRevision: number;
}

export interface PromptSelectionView {
  gameId: string;
  stageId: string;
  mode: PromptMode;
  candidates: string[];
  chosen: string | null;
  submitted: boolean;
}

export interface RevealProgressBook {
  bookId: string;
  ownerUserId: UserId;
  ownerName: string;
  entryCount: number;
  revealedCount: number;
  status: 'unrevealed' | 'partial' | 'complete';
}

export interface RevealCurrentView {
  revision: number;
  bookId: string | null;
  ownerName: string | null;
  entryIndex: number; // -1 = 책 표지
  entryCount: number;
  entry: EntryView | null;
  /** 전체 공개 완료 여부 */
  allRevealed: boolean;
}

export interface RoomSnapshot {
  roomId: string;
  classId: string;
  className: string;
  title: string;
  capacity: number;
  status: RoomStatus;
  version: number;
  settings: RoomSettings;
  host: RoomHostView;
  members: RoomMemberView[];
  playerCount: number;
  serverTime: number;
  deadlineAt: number | null;
  stage: number; // 0 = 제시어 선택
  stageCount: number;
  gameId: string | null;
  /** 관찰 중인 교사/방장 존재 여부 (학생 화면 표시용) */
  observers: { teacher: boolean; host: boolean };
  /** 내 정보 */
  me: {
    userId: UserId;
    isTeacher: boolean;
    isHost: boolean;
    isPlayer: boolean;
    canControl: boolean; // 게임 시작/공개 진행 권한
    canMonitor: boolean;
    /** 중복 탭인 경우 false */
    primaryConnection: boolean;
  };
  promptSelection: PromptSelectionView | null;
  assignment: MyAssignment | null;
  reveal: RevealCurrentView | null;
  /** 진행권 보유자에게만 제공 */
  revealBooks: RevealProgressBook[] | null;
  closedReason: string | null;
  expiresAt: number;
}

export interface MonitorPlayerView {
  userId: UserId;
  displayName: string;
  connected: boolean;
  kind: 'prompt' | 'drawing' | 'guess' | 'idle';
  submitted: boolean;
  skipped: boolean;
  bookId: string | null;
  bookOwnerName: string | null;
  draft: EntryPayload | null;
  /** 이 초안이 실시간(true)인지 저장본(false)인지 */
  live: boolean;
  updatedAt: number;
  previous: EntryView | null;
}

export interface ClassMemberView {
  studentId: string;
  nickname: string;
  displayName: string;
  connected: boolean;
  hostGrant: boolean;
  currentRoomId: string | null;
  currentRoomTitle: string | null;
  roomRole: 'player' | 'host-observer' | 'host-player' | null;
  joinedAt: number;
}

export interface RoomSummary {
  roomId: string;
  title: string;
  hostUserId: UserId | null;
  hostName: string | null;
  hostMode: HostMode;
  playerCount: number;
  capacity: number;
  status: RoomStatus;
  revision: number;
  updatedAt: number;
}

export interface ClassSnapshot {
  classId: string;
  name: string;
  code: string;
  teacherName: string;
  locked: boolean;
  ended: boolean;
  revision: number;
  members: ClassMemberView[];
  rooms: RoomSummary[];
  memberCount: number;
  connectedCount: number;
  serverTime: number;
  expiresAt: number;
  me: {
    kind: 'teacher' | 'student';
    studentId?: string;
    nickname?: string;
    hostGrant?: boolean;
    currentRoomId?: string | null;
  };
}

export interface ApiError {
  error: string;
  message: string;
}
