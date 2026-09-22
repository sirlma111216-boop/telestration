/**
 * 자동 재접속 WebSocket 클라이언트.
 *  - 명령은 clientActionId 로 ack 를 기다린다.
 *  - 끊기면 지수 백오프로 다시 붙고, 붙을 때마다 서버가 최신 스냅샷을 보낸다.
 */
import { newActionId } from './session';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
}

export interface SocketOptions {
  url: () => string;
  onMessage: (msg: Record<string, unknown>) => void;
  onState?: (state: ConnectionState, detail?: string) => void;
  /** 서버가 4000 번대 코드로 닫으면 재접속하지 않는다 */
  onFatalClose?: (code: number, reason: string) => void;
  /** 연결 직후 보낼 인사 메시지 (예: { type: 'room.ping' }). 서버 시각 동기화용이며, 한 번도 보내지 않은 소켓은 일부 환경에서 서버 종료 프레임을 늦게 받는다. */
  hello?: Record<string, unknown>;
}

export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private attempts = 0;
  private closedByUser = false;
  private timer: number | null = null;
  private everOpened = false;
  state: ConnectionState = 'connecting';

  constructor(private opts: SocketOptions) {
    this.connect();
  }

  private setState(s: ConnectionState, detail?: string): void {
    this.state = s;
    this.opts.onState?.(s, detail);
  }

  private connect(): void {
    if (this.closedByUser) return;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.everOpened = true;
      this.setState('open');
      if (this.opts.hello) this.command(this.opts.hello).catch(() => {});
    };
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === 'ack' && typeof msg.clientActionId === 'string') {
        const p = this.pending.get(msg.clientActionId);
        if (p) {
          this.pending.delete(msg.clientActionId);
          window.clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(typeof msg.message === 'string' ? msg.message : '실패했어요'));
        }
        return;
      }
      this.opts.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [, p] of this.pending) {
        window.clearTimeout(p.timer);
        p.reject(new Error('연결이 끊어졌어요. 다시 시도해 주세요.'));
      }
      this.pending.clear();
      if (this.closedByUser) return;
      if (ev.code >= 4000 && ev.code < 5000) {
        this.setState('closed', ev.reason);
        this.opts.onFatalClose?.(ev.code, ev.reason);
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose 가 이어서 호출됨 */
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.attempts += 1;
    if (!this.everOpened && this.attempts >= 4) {
      // 처음부터 한 번도 연결되지 않음: 권한 없음·닫힌 방 등. 무한 재시도 대신 알린다.
      this.setState('closed', '연결할 수 없어요');
      this.opts.onFatalClose?.(4999, 'unreachable');
      return;
    }
    const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempts, 5)) + Math.random() * 300;
    this.setState('reconnecting');
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  /** 즉시 재접속 시도 (탭이 다시 보일 때 등) */
  nudge(): void {
    if (this.closedByUser) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.connect();
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** ack 없이 보내는 메시지 (초안 실시간 전송 등). 연결이 없으면 조용히 버린다. */
  fire(msg: Record<string, unknown>): boolean {
    if (!this.isOpen) return false;
    try {
      this.ws!.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** ack 를 기다리는 명령 */
  command<T = unknown>(msg: Record<string, unknown>, timeoutMs = 8000): Promise<T> {
    const clientActionId = newActionId();
    return new Promise<T>((resolve, reject) => {
      if (!this.isOpen) {
        reject(new Error('연결이 끊어졌어요. 잠시 후 다시 시도해 주세요.'));
        return;
      }
      const timer = window.setTimeout(() => {
        this.pending.delete(clientActionId);
        reject(new Error('응답이 없어요. 연결 상태를 확인해 주세요.'));
      }, timeoutMs);
      this.pending.set(clientActionId, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ ...msg, clientActionId }));
      } catch {
        this.pending.delete(clientActionId);
        window.clearTimeout(timer);
        reject(new Error('보내지 못했어요'));
      }
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.setState('closed');
  }
}
