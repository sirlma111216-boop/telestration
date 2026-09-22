import { defineConfig, devices } from '@playwright/test';

/**
 * E2E: 로컬 dev 서버(vite + Cloudflare 플러그인, Durable Objects 로컬 에뮬레이션)에 대해 실행.
 * `npm run test:e2e` 가 서버를 자동으로 띄운다. 이미 떠 있으면 재사용.
 * 교사 계정은 .dev.vars 의 demo / teacher-demo-1234 를 사용한다.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    locale: 'ko-KR',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /devices\.spec\.ts/ },
  ],
});
