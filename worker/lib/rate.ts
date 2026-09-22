/**
 * 메모리 기반 고정 창 빈도 제한. Durable Object 인스턴스마다 독립적으로 동작한다.
 * (인스턴스가 재시작되면 창이 초기화되는데, 이 앱의 위협 모델에서는 허용 가능한 완화 수준이다.
 *  로그인 시도 제한은 DirectoryObject 가 SQLite 에 별도 저장한다.)
 */
export class RateLimiter {
  private buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** 허용되면 true */
  hit(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.windowMs) {
      b = { windowStart: now, count: 0 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (this.buckets.size > 5000) this.sweep(now);
    return b.count <= this.limit;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now: number): void {
    for (const [k, b] of this.buckets) if (now - b.windowStart >= this.windowMs) this.buckets.delete(k);
  }
}
