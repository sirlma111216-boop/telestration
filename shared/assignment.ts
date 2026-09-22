/**
 * 그림책 배정 알고리즘 (명세 8절)
 *
 * 플레이어 P[0..N-1] 이 고정되면 각 그림책 B[i] 의 s단계(1부터) 담당자는
 *  - N 짝수: P[(i + s - 1) mod N], 단계 수 N   (첫 그림은 책 주인이 직접)
 *  - N 홀수: P[(i + s) mod N],     단계 수 N-1 (제시어를 다음 사람에게 넘겨 그리게 함)
 * 홀수 단계는 그리기, 짝수 단계는 추측. 마지막 단계는 항상 추측.
 */

export function stageCountFor(n: number): number {
  if (n < 2) throw new Error('플레이어는 2명 이상이어야 합니다');
  return n % 2 === 0 ? n : n - 1;
}

export function stageKind(stage: number): 'drawing' | 'guess' {
  return stage % 2 === 1 ? 'drawing' : 'guess';
}

/** 그림책 i 의 s 단계 담당 플레이어 인덱스 */
export function assigneeIndex(n: number, bookIndex: number, stage: number): number {
  if (stage < 1 || stage > stageCountFor(n)) throw new Error('단계 범위 밖');
  if (n % 2 === 0) return (bookIndex + stage - 1) % n;
  return (bookIndex + stage) % n;
}

/** 플레이어 p 가 s 단계에서 담당하는 그림책 인덱스 (assigneeIndex 의 역함수) */
export function bookIndexFor(n: number, playerIndex: number, stage: number): number {
  if (stage < 1 || stage > stageCountFor(n)) throw new Error('단계 범위 밖');
  const offset = n % 2 === 0 ? stage - 1 : stage;
  return (((playerIndex - offset) % n) + n) % n;
}

/**
 * 배정 검증: 모든 단계에서 각 플레이어가 정확히 한 책을 담당하고,
 * 각 책은 정확히 한 담당자를 갖고, 마지막 단계는 추측이며,
 * 같은 사람이 같은 책을 두 번 담당하지 않는지 확인한다.
 */
export function validateAssignment(n: number): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const stages = stageCountFor(n);
  if (stageKind(stages) !== 'guess') problems.push('마지막 단계가 추측이 아님');
  const seen = new Map<string, number>();
  for (let s = 1; s <= stages; s++) {
    const players = new Set<number>();
    for (let i = 0; i < n; i++) {
      const p = assigneeIndex(n, i, s);
      if (players.has(p)) problems.push(`단계 ${s}: 플레이어 ${p} 중복 배정`);
      players.add(p);
      if (bookIndexFor(n, p, s) !== i) problems.push(`단계 ${s}: 역함수 불일치 (책 ${i})`);
      const key = `${i}:${p}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    if (players.size !== n) problems.push(`단계 ${s}: 누락된 플레이어 존재`);
  }
  for (const [key, count] of seen) {
    if (count > 1) problems.push(`책:플레이어 ${key} 이(가) ${count}회 담당`);
  }
  // 책 주인이 그림 단계에서 자기 책을 다시 만나지 않는지 (짝수는 1단계에 주인이 그리는 것이 정상)
  for (let i = 0; i < n; i++) {
    for (let s = 2; s <= stages; s++) {
      if (assigneeIndex(n, i, s) === i) problems.push(`책 ${i}: 주인이 ${s}단계를 다시 담당`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 안정적인 셔플 (서버가 제공하는 난수로) */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
