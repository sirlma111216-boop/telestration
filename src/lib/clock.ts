import { useEffect, useState } from 'react';

/** 서버 시각 오프셋 추정: 스냅샷의 serverTime 과 로컬 시각 차이 */
let offset = 0;
export function noteServerTime(serverTime: number): void {
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return;
  const sample = serverTime - Date.now();
  // 첫 표본은 그대로, 이후는 완만하게 따라간다
  offset = offset === 0 ? sample : offset * 0.7 + sample * 0.3;
}
export function serverNow(): number {
  return Date.now() + offset;
}

/** deadlineAt 까지 남은 초 (매초 갱신). null 이면 null */
export function useCountdown(deadlineAt: number | null): number | null {
  const [left, setLeft] = useState<number | null>(() => (deadlineAt ? Math.max(0, Math.ceil((deadlineAt - serverNow()) / 1000)) : null));
  useEffect(() => {
    if (!deadlineAt) {
      setLeft(null);
      return;
    }
    const tick = () => setLeft(Math.max(0, Math.ceil((deadlineAt - serverNow()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [deadlineAt]);
  return left;
}
