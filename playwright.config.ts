import { defineConfig, devices } from '@playwright/test';

/** Set E2E_BASE_URL to test a running container (CI); otherwise build + `vite preview` locally. */
const externalBaseUrl = process.env.E2E_BASE_URL;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: externalBaseUrl ?? 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
  ],
  ...(externalBaseUrl === undefined
    ? {
        webServer: {
          command: 'npm run build && npm run preview',
          url: 'http://localhost:4173/version.json',
          reuseExistingServer: !isCI,
          timeout: 120_000,
        },
      }
    : {}),
});
