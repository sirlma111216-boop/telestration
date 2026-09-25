/**
 * WebSocket 메시지 명세
 *
 * 클라이언트 → 서버: 모든 명령은 `clientActionId` 를 포함한다. 서버는 반드시 `ack` 로 응답한다.
 * 서버 → 클라이언트: 스냅샷/이벤트. `version`/`revision` 이 낮은 메시지는 무시한다.
 */
import type {
  ClassSnapshot,
  DrawSeconds,
  EntryPayload,
  GuessSeconds,
  HostMode,
  MonitorPlayerView,
  PromptMode,
  RoomSnapshot,
  RoomSummary,
  Stroke,
} from './types';
import type { FaDiscussionSeconds, FaSettings, FaTurnSeconds, GameMode } from './fakeArtist';

// ---------- 클래스 WebSocket ----------

export type ClassClientMessage =
  | { type: 'class.ping'; clientActionId: string }
  // 교사
  | { type: 'class.lock'; clientActionId: string; locked: boolean }
  | { type: 'class.end'; clientActionId: string; confirm: true }
  | { type: 'class.grantHost'; clientActionId: string; studentId: string; grant: boolean }
  | { type: 'class.kick'; clientActionId: string; studentId: string }
  | {
      type: 'room.create';
      clientActionId: string;
      title: string;
      capacity: number;
      hostMode: HostMode;
      /** 교사만: 학생을 방장으로 지정 (없으면 본인) */
      hostStudentId?: string | null;
      settings?: Partial<{ promptMode: PromptMode; drawSeconds: DrawSeconds; guessSeconds: GuessSeconds }>;
      /** 게임 종류. 없으면 그림 이어말하기. */
      gameMode?: GameMode;
      fa?: Partial<FaSettings>;
    }
  | { type: 'room.assignHost'; clientActionId: string; roomId: string; studentId: string }
  | { type: 'room.takeOver'; clientActionId: string; roomId: string }
  | { type: 'room.forceClose'; clientActionId: string; roomId: string; confirm: true }
  // 학생
  | { type: 'room.join'; clientActionId: string; roomId: string }
  | { type: 'room.leave'; clientActionId: string; roomId: string };

export type ClassServerMessage =
  | { type: 'class.snapshot'; snapshot: ClassSnapshot }
  | { type: 'class.rooms'; revision: number; rooms: RoomSummary[] }
  | { type: 'ack'; clientActionId: string; ok: true; result?: unknown }
  | { type: 'ack'; clientActionId: string; ok: false; error: string; message: string }
  | { type: 'class.ended'; message: string }
  | { type: 'class.kicked'; message: string }
  | { type: 'error'; error: string; message: string };

// ---------- 게임방 WebSocket ----------

export type RoomClientMessage =
  | { type: 'room.ping'; clientActionId: string }
  | { type: 'room.resync'; clientActionId: string }
  // 대기실
  | { type: 'room.ready'; clientActionId: string; ready: boolean }
  | { type: 'room.leave'; clientActionId: string }
  | {
      type: 'room.updateSettings';
      clientActionId: string;
      expectedVersion: number;
      title?: string;
      capacity?: number;
      hostMode?: HostMode;
      promptMode?: PromptMode;
      drawSeconds?: DrawSeconds;
      guessSeconds?: GuessSeconds;
      /** 대기실에서만 바꿀 수 있다. 바꾸면 준비 상태와 모드 전용 데이터(색 등)가 초기화된다. */
      gameMode?: GameMode;
      faCategoryId?: string;
      faTurnSeconds?: FaTurnSeconds;
      faDiscussionSeconds?: FaDiscussionSeconds;
    }
  | { type: 'room.kick'; clientActionId: string; userId: string }
  | { type: 'game.start'; clientActionId: string; expectedVersion: number }
  // 게임
  | { type: 'prompt.choose'; clientActionId: string; gameId: string; stageId: string; text: string }
  | { type: 'draft.live'; gameId: string; stageId: string; seq: number; strokesAppend?: Stroke[]; reset?: boolean; text?: string }
  | { type: 'draft.save'; clientActionId: string; gameId: string; stageId: string; revision: number; payload: EntryPayload }
  | { type: 'entry.submit'; clientActionId: string; gameId: string; stageId: string; payload: EntryPayload }
  // 모니터링
  | { type: 'monitor.subscribe'; clientActionId: string; subscribe: boolean }
  // 결과 공개
  | { type: 'reveal.start'; clientActionId: string; gameId: string; expectedVersion: number }
  | { type: 'reveal.selectBook'; clientActionId: string; gameId: string; bookId: string; expectedRevision: number }
  | { type: 'reveal.step'; clientActionId: string; gameId: string; direction: 1 | -1; expectedRevision: number }
  | { type: 'reveal.reaction'; clientActionId: string; gameId: string; reaction: 'lol' | 'wow' | 'best' }
  | { type: 'room.restart'; clientActionId: string; expectedVersion: number }
  // ---- 가짜 예술가 찾기 (모든 게임 명령에 gameId 와 단계/턴 ID 를 함께 보낸다) ----
  | { type: 'fa.color'; clientActionId: string; colorIndex: number }
  | { type: 'fa.roleAck'; clientActionId: string; gameId: string; phaseId: string }
  /** 그리는 중인 획 (ack 없음, 100~200ms 묶음). 획 전체를 보낸다 — 누락돼도 다음 메시지로 복구된다. */
  | { type: 'fa.draft'; gameId: string; turnId: string; revision: number; stroke: Stroke }
  /** 지우고 다시 그리기: revision 을 올린다. 이보다 낮은 revision 의 늦은 메시지는 무시된다. */
  | { type: 'fa.redo'; clientActionId: string; gameId: string; turnId: string; revision: number }
  | { type: 'fa.commit'; clientActionId: string; gameId: string; turnId: string; revision: number; stroke: Stroke }
  | { type: 'fa.vote'; clientActionId: string; gameId: string; phaseId: string; targetId: string }
  | { type: 'fa.guess'; clientActionId: string; gameId: string; phaseId: string; text: string }
  | { type: 'fa.reveal.start'; clientActionId: string; gameId: string }
  | { type: 'fa.reveal.next'; clientActionId: string; gameId: string; expectedStep: number }
  | { type: 'fa.highlight'; clientActionId: string; gameId: string; playerId: string | null; expectedRevision: number }
  | { type: 'room.close'; clientActionId: string; confirm: true }
  | { type: 'room.forceClose'; clientActionId: string; confirm: true };

export type RoomServerMessage =
  | { type: 'room.snapshot'; snapshot: RoomSnapshot }
  | { type: 'ack'; clientActionId: string; ok: true; result?: unknown }
  | { type: 'ack'; clientActionId: string; ok: false; error: string; message: string }
  | { type: 'monitor.snapshot'; gameId: string | null; players: MonitorPlayerView[] }
  | {
      type: 'monitor.update';
      gameId: string;
      stageId: string;
      userId: string;
      seq: number;
      strokesAppend?: Stroke[];
      reset?: boolean;
      text?: string;
      updatedAt: number;
    }
  | { type: 'monitor.denied'; message: string }
  | { type: 'reveal.reaction'; reaction: 'lol' | 'wow' | 'best'; from: string }
  /** 가짜 예술가 찾기: 지금 차례인 사람이 그리는 중인 획 (서버가 검증한 것만) */
  | { type: 'fa.draft'; gameId: string; turnId: string; playerId: string; revision: number; stroke: Stroke | null }
  | { type: 'room.closed'; message: string }
  | { type: 'room.kicked'; message: string }
  | { type: 'error'; error: string; message: string };

export type AckMessage = Extract<RoomServerMessage, { type: 'ack' }>;
