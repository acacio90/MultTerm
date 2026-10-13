import { defineConfig } from '@playwright/test';

// Testes de interface: abrem o app Electron real (npm run test:ui compila antes).
export default defineConfig({
  testDir: 'test-ui',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
});
