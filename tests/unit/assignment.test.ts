import { describe, expect, it } from 'vitest';
import { assigneeIndex, bookIndexFor, shuffle, stageCountFor, stageKind, validateAssignment } from '../../shared/assignment';

describe('그림책 배정 (4~12명)', () => {
  for (let n = 4; n <= 12; n++) {
    it(`${n}명: 중복·누락 없음, 단계 수, 마지막 추측`, () => {
      const stages = stageCountFor(n);
      expect(stages).toBe(n % 2 === 0 ? n : n - 1);
      expect(stageKind(stages)).toBe('guess');
      const v = validateAssignment(n);
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      // 각 플레이어는 단계마다 정확히 한 책
      for (let s = 1; s <= stages; s++) {
        const books = new Set<number>();
        for (let p = 0; p < n; p++) books.add(bookIndexFor(n, p, s));
        expect(books.size).toBe(n);
      }
    });
  }

  it('짝수: 1단계는 책 주인이 직접 그린다', () => {
    for (const n of [4, 6, 8, 10, 12]) for (let i = 0; i < n; i++) expect(assigneeIndex(n, i, 1)).toBe(i);
  });

  it('홀수: 1단계는 다음 사람이 그린다 (주인이 아님)', () => {
    for (const n of [5, 7, 9, 11]) for (let i = 0; i < n; i++) expect(assigneeIndex(n, i, 1)).toBe((i + 1) % n);
  });

  it('홀수 단계는 그리기, 짝수 단계는 추측', () => {
    expect(stageKind(1)).toBe('drawing');
    expect(stageKind(2)).toBe('guess');
    expect(stageKind(11)).toBe('drawing');
    expect(stageKind(12)).toBe('guess');
  });

  it('범위 밖 단계는 오류', () => {
    expect(() => assigneeIndex(4, 0, 5)).toThrow();
    expect(() => bookIndexFor(5, 0, 5)).toThrow();
    expect(() => stageCountFor(1)).toThrow();
  });

  it('shuffle 은 같은 원소 집합을 유지한다', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7];
    const s = shuffle(arr, () => 0.42);
    expect([...s].sort()).toEqual([...arr].sort());
    expect(arr).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
