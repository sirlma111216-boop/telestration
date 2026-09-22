/**
 * 기기·화면 크기 검증: 390×844, 768×1024, 1440×900 에서 가로 넘침이 없고 주요 화면이 렌더링되는지.
 * 캔버스 크기 변경·지우개·실행 취소 동작을 Chromium 과 WebKit 에서 확인한다 (/dev/canvas 는 dev 서버 전용 페이지).
 * 실제 휴대폰·태블릿·스타일러스 검증은 자동화하지 않았다 (README 미검증 항목 참조).
 */
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __canvas?: { getStrokes(): unknown[]; undo(): void; redo(): void; clear(): void } | null;
  }
}

const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

for (const s of SIZES) {
  test(`${s.name} ${s.width}x${s.height}: 홈·교사 로그인·그림판 화면 가로 넘침 없음`, async ({ page }) => {
    await page.setViewportSize({ width: s.width, height: s.height });
    for (const path of ['/', '/teacher', '/dev/canvas']) {
      await page.goto(path);
      await expect(page.locator('#root')).not.toBeEmpty();
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} overflow`).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `test-results/screens/${s.name}-${path.replace(/\//g, '_') || 'home'}.png` });
    }
  });
}

async function stroke(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const canvas = page.locator('canvas[aria-label^="그림판"]');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 10 });
  await page.mouse.up();
}

async function alphaAt(page: Page, fx: number, fy: number): Promise<number> {
  return page.evaluate(
    ([x, y]) => {
      const c = document.querySelector<HTMLCanvasElement>('canvas[aria-label^="그림판"]')!;
      const d = c.getContext('2d')!.getImageData(Math.round(c.width * x!), Math.round(c.height * y!), 1, 1).data;
      return d[3]!;
    },
    [fx, fy],
  );
}

test('그림판: 펜 → 지우개(실제 삭제) → 실행 취소/다시 실행 → 크기 변경 후 복원', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/dev/canvas');
  await expect(page.locator('canvas[aria-label^="그림판"]')).toBeVisible();
  await stroke(page, [0.1, 0.5], [0.9, 0.5]);
  await expect(page.getByTestId('count')).toHaveText('획 1');
  expect(await alphaAt(page, 0.5, 0.5)).toBeGreaterThan(100);
  // 지우개: 가운데를 세로로 지우면 그 자리는 투명(실제 삭제), 양옆은 남는다
  await page.getByTestId('eraser').click();
  await stroke(page, [0.5, 0.2], [0.5, 0.8]);
  await expect(page.getByTestId('count')).toHaveText('획 2');
  expect(await alphaAt(page, 0.5, 0.5)).toBe(0);
  expect(await alphaAt(page, 0.2, 0.5)).toBeGreaterThan(100);
  // 실행 취소 → 지우개 획 사라짐 → 다시 실행
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('count')).toHaveText('획 1');
  expect(await alphaAt(page, 0.5, 0.5)).toBeGreaterThan(100);
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('count')).toHaveText('획 2');
  expect(await alphaAt(page, 0.5, 0.5)).toBe(0);
  // 크기 변경(회전 흉내) 후 스트로크 데이터로 다시 그려진다
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(300);
  expect(await alphaAt(page, 0.2, 0.5)).toBeGreaterThan(100);
  expect(await alphaAt(page, 0.5, 0.5)).toBe(0);
  // 전체 지우기
  await page.getByTestId('clear').click();
  await expect(page.getByTestId('count')).toHaveText('획 0');
  // touch-action 은 캔버스에만
  const ta = await page.evaluate(() => ({ canvas: getComputedStyle(document.querySelector('canvas')!).touchAction, body: getComputedStyle(document.body).touchAction }));
  expect(ta.canvas).toBe('none');
  expect(ta.body).not.toBe('none');
});

test('그림판: 터치 포인터와 pointercancel 처리', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dev/canvas');
  const canvas = page.locator('canvas[aria-label^="그림판"]');
  await expect(canvas).toBeVisible();
  const res = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas[aria-label^="그림판"]')!;
    const r = c.getBoundingClientRect();
    const fire = (type: string, x: number, y: number, pointerId = 7) => c.dispatchEvent(new PointerEvent(type, { pointerId, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y, bubbles: true, isPrimary: true, button: 0 }));
    fire('pointerdown', 20, 20);
    fire('pointermove', 60, 40);
    fire('pointermove', 120, 90);
    // 두 번째 손가락(다른 pointerId)은 무시된다
    fire('pointerdown', 200, 200, 9);
    fire('pointermove', 210, 210, 9);
    fire('pointerup', 120, 90);
    const after1 = window.__canvas!.getStrokes().length;
    fire('pointerdown', 200, 20);
    fire('pointermove', 220, 60);
    fire('pointercancel', 220, 60); // 취소되어도 그린 부분은 살린다
    const after2 = window.__canvas!.getStrokes().length;
    fire('pointerdown', 250, 20);
    fire('pointercancel', 250, 20); // 점 하나만 있을 때 취소 → 버림
    const after3 = window.__canvas!.getStrokes().length;
    return { after1, after2, after3 };
  });
  expect(res.after1).toBe(1);
  expect(res.after2).toBe(2);
  expect(res.after3).toBe(2);
});
