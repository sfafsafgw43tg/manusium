/**
 * e2e/playwright.config.ts
 *
 * End-to-end tests of both apps in a real Electron (Windows CI job, see
 * .github/workflows/ci.yml). Run locally on Windows after `npm run build`:
 *   npm run e2e
 *
 * The apps are started unpackaged (electron apps/<app>) because Playwright
 * attaches through the Node inspector, which the fuses disable in packaged
 * builds on purpose. Packaged builds are checked separately (fuses, verify
 * mode, installer) in the same CI job.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  // Electron apps share single-instance locks and ports - run serially.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  // Hard cap for the whole suite so a hanging app cannot eat the CI job.
  globalTimeout: 25 * 60_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github'], ['junit', { outputFile: '../test-results/e2e-junit.xml' }]] : 'list',
  outputDir: '../test-results/e2e',
});
