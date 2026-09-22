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
  | { type: 'room.closed'; message: string }
  | { type: 'room.kicked'; message: string }
  | { type: 'error'; error: string; message: string };

export type AckMessage = Extract<RoomServerMessage, { type: 'ack' }>;
