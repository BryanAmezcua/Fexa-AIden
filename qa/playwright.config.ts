import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root. Override with .env.local / .env.qa by copying
// to .env before invoking, or by setting vars inline:
//   TEST_BASE_URL=https://qa.example.com npx playwright test
dotenv.config({ path: path.resolve(__dirname, '.env') });

const baseURL = process.env.TEST_BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  // Exclude scratch exploration scripts from the standard suite; opt-in by
  // running them explicitly with `npx playwright test tests/_explore/`.
  // Disable via TANGO_INCLUDE_EXPLORE=1 to run exploration specs alongside.
  testIgnore: process.env.TANGO_INCLUDE_EXPLORE === '1' ? [] : ['**/_explore/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  // Reporters:
  //  - html: Playwright's interactive browseable report (for engineers)
  //  - list: live terminal output while tests run
  //  - qa-report: our standardized self-contained HTML for ticket attachment
  //    (groups by ticket, shows AC clause, before/after screenshots, repro)
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    ['./src/reporters/qa-report.ts'],
  ],

  // Logs in each configured role once before the suite runs, dumps session
  // state to auth/<role>.json. Projects below pick up that state.
  globalSetup: require.resolve('./src/setup/global-setup'),

  use: {
    baseURL,
    // Pin the browser timezone so date-only fields don't shift days based on
    // a headless-Chromium default (we saw UTC+8 in practice). UTC means
    // local-midnight === UTC-midnight, which Ext date fields and our seed
    // baselines both treat as the same day.
    timezoneId: 'UTC',
    // Artifact capture — these are the knobs you'll attach to tickets.
    trace: 'retain-on-failure',        // full step-by-step replay on failure
    screenshot: 'only-on-failure',     // PNG at point of failure
    video: 'retain-on-failure',        // webm of the run
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'admin',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'auth/admin.json',
      },
    },
    {
      name: 'vendor',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'auth/vendor.json',
      },
    },
    {
      name: 'facility-manager',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'auth/facility-manager.json',
      },
    },
  ],
});
