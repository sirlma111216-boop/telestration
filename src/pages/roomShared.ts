import type { RoomStatus } from '@shared/types';

export function statusLabel(s: RoomStatus): string {
  switch (s) {
    case 'LOBBY':
      return '대기 중';
    case 'PROMPT_SELECTION':
      return '제시어 고르는 중';
    case 'PLAYING':
      return '게임 진행 중';
    case 'REVEAL_READY':
      return '공개 준비';
    case 'REVEALING':
      return '결과 공개 중';
    case 'FINISHED':
      return '공개 완료';
    case 'CLOSED':
      return '닫힘';
  }
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
