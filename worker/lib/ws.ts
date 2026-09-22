/** WebSocket 보조 함수 */

const OPEN = 1;

/** 닫는 중인 소켓에 보내면 close 프레임 전달이 깨질 수 있으므로 열린 소켓에만 보낸다 */
export function isOpen(ws: WebSocket): boolean {
  try {
    return ws.readyState === OPEN;
  } catch {
    return false;
  }
}

export function safeSend(ws: WebSocket, message: unknown): boolean {
  if (!isOpen(ws)) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export function safeClose(ws: WebSocket, code = 1000, reason = ''): void {
  try {
    ws.close(code, reason.slice(0, 120));
  } catch {
    /* 이미 닫힘 */
  }
}

export function parseMessage(raw: string | ArrayBuffer, maxBytes = 300_000): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > maxBytes) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getAttachment<T>(ws: WebSocket): T | null {
  try {
    return (ws.deserializeAttachment() as T) ?? null;
  } catch {
    return null;
  }
}

export function setAttachment(ws: WebSocket, value: unknown): void {
  ws.serializeAttachment(value);
}
