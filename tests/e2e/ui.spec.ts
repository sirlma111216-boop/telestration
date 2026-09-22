/**
 * 브라우저 UI 흐름: 교사 로그인 → 클래스 → 학생 4명(독립 컨텍스트) 참여 → 방장 지정 → 방 → 준비 → 시작 →
 * 캔버스 그리기·제출 → 추측(IME) → 공동 공개에서 학생 화면이 방장을 따라오는지.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const TEACHER = { username: 'demo', password: 'teacher-demo-1234' };

/**
 * 좁은 칸에 밀어 넣어 글자가 겹치거나 사라지지 않는지 확인한다.
 * 학생 화면이 좁은 본문 폭(max-w-xl)에 2단 배치를 욱여넣어 참가자 카드가 100px 남짓으로
 * 찌그러지고 닉네임이 사라지던 회귀를 막는다.
 */
async function expectNoSquish(page: Page, label: string): Promise<void> {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth - document.documentElement.clientWidth > 1) out.push('가로 스크롤 발생');
    for (const el of Array.from(document.querySelectorAll('.chip'))) {
      const r = el.getBoundingClientRect();
      if (el.scrollWidth - r.width > 1) out.push('칩 글자 넘침: ' + (el as HTMLElement).innerText.trim());
    }
    for (const li of Array.from(document.querySelectorAll('ul.grid > li'))) {
      const name = li.querySelector('.truncate') as HTMLElement | null;
      if (name && name.innerText.trim() && name.getBoundingClientRect().width < 20) {
        out.push('참가자 이름이 보이지 않음: ' + name.innerText.trim());
      }
      const box = li.getBoundingClientRect();
      for (const el of Array.from(li.querySelectorAll('.chip'))) {
        if (el.getBoundingClientRect().right > box.right + 1) out.push('칩이 카드 밖으로 넘침: ' + (el as HTMLElement).innerText.trim());
      }
    }
    return out;
  });
  expect(problems, label).toEqual([]);
}

async function studentJoin(browser: Browser, code: string, nickname: string, viewport = { width: 390, height: 844 }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
  const page = await ctx.newPage();
  await page.goto(`/join/${code}`);
  await page.getByPlaceholder('예: 바나나').fill(nickname);
  await page.getByRole('button', { name: '참여하기' }).click();
  await expect(page).toHaveURL(/\/class\/c_/);
  return { ctx, page };
}

async function drawOnCanvas(page: Page): Promise<void> {
  const canvas = page.locator('canvas[aria-label^="그림판"]');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width * 0.2;
  const y = box.y + box.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + box.width * 0.4, y + box.height * 0.2, { steps: 8 });
  await page.mouse.move(x + box.width * 0.5, y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
}

test('교사·학생 4명 브라우저 완주와 공동 공개 동기화', async ({ browser, page }) => {
  test.setTimeout(240_000);
  // 교사 로그인 · 클래스 생성
  await page.goto('/teacher');
  await page.getByLabel('아이디').fill(TEACHER.username);
  await page.getByLabel('비밀번호').fill(TEACHER.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByPlaceholder('예: 2학년 3반 미술').fill('브라우저 반');
  await page.getByRole('button', { name: '만들기' }).click();
  await expect(page).toHaveURL(/\/teacher\/class\//);
  const code = (await page.locator('span.font-mono').first().textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  // 학생 4명 참여 (독립 브라우저 컨텍스트)
  const names = ['하나', '두리', '세찌', '네모'];
  const students: { ctx: BrowserContext; page: Page }[] = [];
  // 마지막 한 명은 넓은 화면(노트북)으로 참여시켜 2단 배치 경로도 확인한다
  for (const [i, n] of names.entries()) {
    students.push(await studentJoin(browser, code, n, i === names.length - 1 ? { width: 1280, height: 800 } : undefined));
  }
  await expect(page.getByText('학생 4명')).toBeVisible();

  // 첫 학생을 방장으로 지정 → 학생 화면에 "방 만들기" 등장
  await page.getByRole('button', { name: '방장 지정' }).first().click();
  const host = students[0]!.page;
  await expect(host.getByRole('button', { name: '+ 방 만들기' })).toBeVisible();
  await host.getByRole('button', { name: '+ 방 만들기' }).click();
  await host.getByPlaceholder('예: 1모둠').fill('브라우저 방');
  await host.getByLabel('함께 참여').check();
  await host.getByRole('dialog').getByRole('button', { name: '만들기' }).click();
  await expect(host).toHaveURL(/\/room\/r_/);

  // 나머지 학생은 로비에서 참여하기
  for (const s of students.slice(1)) {
    await s.page.getByRole('button', { name: '참여하기' }).click();
    await expect(s.page).toHaveURL(/\/room\/r_/);
  }
  // 교사 대시보드에 방·방장 표시
  await expect(page.getByText('브라우저 방', { exact: true })).toBeVisible();
  await expect(page.getByText('하나 (참여)')).toBeVisible();

  // 대기실이 좁은 화면과 넓은 화면 모두에서 멀쩡한지
  for (const s of students) await expectNoSquish(s.page, '대기실');
  // 참가자 카드가 닉네임을 담을 만큼 넓은지 (좁은 본문 폭에 사이드바를 욱여넣으면 100px 남짓으로 찌그러진다)
  for (const s of students) {
    const cardWidth = await s.page.locator('ul.grid > li').first().evaluate((el) => el.getBoundingClientRect().width);
    expect(cardWidth, '참가자 카드 너비').toBeGreaterThan(160);
  }

  // 준비 → 시작
  for (const s of students) await s.page.getByRole('button', { name: '준비 완료!' }).click();
  await host.getByRole('button', { name: '게임 시작' }).click();

  // 제시어 선택
  for (const s of students) {
    await expect(s.page.getByText('제시어를 하나 고르세요')).toBeVisible({ timeout: 15000 });
    await s.page.locator('button.btn-violet').first().click();
  }
  // 1단계 그리기: 캔버스에 실제로 그리고 제출
  for (const s of students) {
    await expect(s.page.getByText('이 내용을 그림으로 표현하세요')).toBeVisible({ timeout: 15000 });
    await expectNoSquish(s.page, '그리기 화면');
    // 넓은 화면에서 캔버스가 사이드바에 밀려 찌그러지지 않는지
    const canvasWidth = await s.page.locator('.canvas-wrap').evaluate((el) => el.getBoundingClientRect().width);
    expect(canvasWidth).toBeGreaterThan(280);
    await drawOnCanvas(s.page);
    await expect(s.page.getByText(/획 [1-9]/)).toBeVisible();
    await s.page.getByRole('button', { name: '제출하기' }).click();
    // 제출 확인 창은 뜨지 않는다 — 누르면 바로 제출된다
    await expect(s.page.getByRole('dialog')).toHaveCount(0);
    // 마지막 제출자는 곧바로 다음 단계로 넘어갈 수 있다
    await expect(s.page.getByText(/그림을 제출했어요|맞혀 보세요/)).toBeVisible();
  }
  // 2단계 추측: 한국어 입력 + IME 조합 중 Enter 는 제출하지 않음
  for (const s of students) {
    await expect(s.page.getByText('이 그림이 무엇인지 맞혀 보세요')).toBeVisible({ timeout: 15000 });
    const input = s.page.getByPlaceholder('예: 우산 쓴 강아지');
    await input.fill('우산 쓴 고양이');
    // 조합 중 Enter 흉내
    await input.dispatchEvent('compositionstart');
    await input.press('Enter');
    await expect(s.page.getByRole('dialog')).toHaveCount(0);
    await input.dispatchEvent('compositionend');
    await s.page.getByRole('button', { name: '제출하기' }).click();
    await expect(s.page.getByText(/추측을 제출했어요|그림으로 표현하세요/)).toBeVisible();
  }
  // 3·4단계는 빠르게 (그림 → 추측)
  for (const s of students) {
    await expect(s.page.getByText('이 내용을 그림으로 표현하세요')).toBeVisible({ timeout: 15000 });
    await drawOnCanvas(s.page);
    await s.page.getByRole('button', { name: '제출하기' }).click();
  }
  for (const s of students) {
    await expect(s.page.getByText('이 그림이 무엇인지 맞혀 보세요')).toBeVisible({ timeout: 15000 });
    await s.page.getByPlaceholder('예: 우산 쓴 강아지').fill('마지막 추측');
    await s.page.getByRole('button', { name: '제출하기' }).click();
  }

  // 공개 준비 → 방장(플레이한 방장)이 시작
  await expect(host.getByRole('button', { name: '결과 공개 시작' })).toBeVisible({ timeout: 15000 });
  const viewer = students[2]!.page;
  await expect(viewer.getByText('방장이 결과 공개를 준비하고 있어요')).toBeVisible();
  await host.getByRole('button', { name: '결과 공개 시작' }).click();
  await expect(viewer.getByText('결과 공개 시간!')).toBeVisible();
  // 학생 화면에는 이전/다음·참가자 목록이 없다
  await expect(viewer.getByRole('button', { name: '다음 →' })).toHaveCount(0);
  await expect(viewer.getByRole('heading', { name: '참가자' })).toHaveCount(0);

  // 방장이 참가자 선택 → 학생 화면도 같은 책 표지
  const aside = host.locator('aside');
  await aside.getByRole('button').nth(1).click();
  const ownerName = (await aside.getByRole('button').nth(1).locator('span').first().textContent())!.trim();
  await expect(viewer.getByText(`${ownerName}의 그림책`).first()).toBeVisible();
  // 다음 → 제시어 → 학생도 같은 항목
  await host.getByRole('button', { name: '다음 →' }).click();
  await expect(host.getByText('1/5 · 제시어')).toBeVisible();
  await expect(viewer.getByText('1/5 · 제시어')).toBeVisible();
  // 제시어 칸 높이를 재 둔다 (그림 칸과 같아야 아래 버튼이 오르내리지 않는다)
  const entryBoxHeight = (p: Page) => p.locator('[data-entry-box]').first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const promptHeight = await entryBoxHeight(viewer);
  expect(promptHeight).toBeGreaterThan(100);
  // 학생이 확대 중에도 방장이 넘기면 갱신
  await viewer.getByRole('button', { name: '🔍 확대' }).click();
  await expect(viewer.getByRole('dialog')).toBeVisible();
  await host.getByRole('button', { name: '다음 →' }).click();
  await expect(host.getByText('2/5 · 1단계 · 그림')).toBeVisible();
  await expect(viewer.getByRole('dialog').getByText('1단계 · 그림')).toBeVisible();
  await viewer.keyboard.press('Escape');
  // 그림 칸과 제시어 칸의 높이가 같아야 한다 (서로 다르면 이전/다음 버튼이 위아래로 튄다)
  await expect(viewer.getByRole('dialog')).toHaveCount(0);
  const drawingHeight = await entryBoxHeight(viewer);
  expect(Math.abs(drawingHeight - promptHeight), '제시어 칸과 그림 칸 높이 차이').toBeLessThanOrEqual(2);
  // 반응 버튼
  await viewer.getByRole('button', { name: 'ㅋㅋ' }).click();
  // 이전
  await host.getByRole('button', { name: '← 이전' }).click();
  await expect(viewer.getByText('1/5 · 제시어')).toBeVisible();

  // 교사가 방을 방문하면 참관 표시가 뜬다
  await page.getByRole('button', { name: '방 방문·모니터링' }).click();
  await expect(page).toHaveURL(/\/teacher\/room\//);
  await expect(viewer.getByText('선생님 참관 중')).toBeVisible();

  for (const s of students) await s.ctx.close();
});
