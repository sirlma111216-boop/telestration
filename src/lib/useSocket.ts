import { useEffect, useRef, useState } from 'react';
import { ReconnectingSocket, type ConnectionState } from './socket';

/** 컴포넌트 수명에 묶인 재접속 WebSocket. 메시지 핸들러는 최신 것을 사용한다. */
export function useSocket(url: string | null, onMessage: (msg: Record<string, unknown>) => void, onFatal?: (code: number, reason: string) => void, hello?: Record<string, unknown>) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const sockRef = useRef<ReconnectingSocket | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  const fatalRef = useRef(onFatal);
  fatalRef.current = onFatal;

  useEffect(() => {
    if (!url) return;
    const sock = new ReconnectingSocket({
      url: () => url,
      onMessage: (m) => handlerRef.current(m),
      onState: (s, d) => {
        setState(s);
        setDetail(d);
      },
      onFatalClose: (c, r) => fatalRef.current?.(c, r),
      hello,
    });
    sockRef.current = sock;
    const onVisible = () => {
      if (document.visibilityState === 'visible') sock.nudge();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      sock.close();
      sockRef.current = null;
    };
  }, [url]);

  return { state, detail, sock: sockRef };
}
