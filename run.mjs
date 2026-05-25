#!/usr/bin/env node
// qa-bot/run.mjs — Entry point: runs a ticket's test suite and generates the report
//
// Usage:
//   node run.mjs TANGO-9
//   QA_BASE_URL=https://qa.fexa.io node run.mjs TANGO-9
//   QA_EMAIL=admin@fexa.io QA_PASSWORD=secret node run.mjs TANGO-9

import { launch, close } from './lib/browser.mjs';
import { login } from './lib/auth.mjs';
import { capture } from './lib/screenshots.mjs';
import { generateReport } from './lib/report.mjs';
import { formatStep } from './lib/step-formatter.mjs';
import { executeSeed, cleanup as cleanupSeed } from './lib/seeds.mjs';
import { SCREENSHOT_DIR, REPORT_DIR } from './lib/config.mjs';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const ticketKey = process.argv[2];
if (!ticketKey) {
  console.error('Usage: node run.mjs <TICKET-KEY> [--post-to-jira] [--no-cleanup]');
  process.exit(1);
}
const skipCleanup = process.argv.includes('--no-cleanup');

const normalizedKey = ticketKey.toUpperCase();
const modulePath = `./tickets/${normalizedKey}.mjs`;

// Dynamic import of the ticket test module
let ticketModule;
try {
  ticketModule = await import(modulePath);
} catch (e) {
  console.error(`No test script found for ${normalizedKey} at ${modulePath}`);
  console.error(`Create it at: qa-bot/tickets/${normalizedKey}.mjs`);
  process.exit(1);
}

const { metadata, tests, seed: seedDef } = ticketModule;

console.log(`\n=== QA Bot: ${normalizedKey} — ${metadata.summary} ===\n`);

// Set up screenshot directory for this ticket
const screenshotDir = join(SCREENSHOT_DIR, normalizedKey);
if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });

// Execute seed script if the ticket defines one
let seedManifest = null;
if (seedDef) {
  try {
    console.log('--- Seeding test fixtures ---');
    seedManifest = executeSeed(seedDef);
  } catch (e) {
    console.error(`Seed failed: ${e.message}`);
    console.error('Continuing without seed data...');
  }
}

// Launch browser and login
const page = await launch({ screenshotDir });
const baseUrl = page._qaConfig.baseUrl;

let loginSuccess = false;
try {
  await login(page);
  loginSuccess = true;
  await capture(page, 'post-login');

  // If seed data was created, reload the page so the app picks up new lists
  if (seedManifest) {
    console.log('  Reloading page to pick up seeded data...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const { waitForAppReady } = await import('./lib/extjs.mjs');
    await waitForAppReady(page, 60000);
    // loadLists() runs on a 1500ms setTimeout after app init — wait for it
    await page.waitForTimeout(5000);
    console.log('  Page reloaded.');
  }
} catch (e) {
  console.error(`Login failed: ${e.message}`);
  await capture(page, 'login-failed');
}

// Run each test case
const testResults = [];
const suiteStart = Date.now();

for (const test of tests) {
  const acLabel = Array.isArray(test.ac) ? test.ac.map(n => `#${n}`).join(', ') : `#${test.ac}`;
  console.log(`\n--- AC ${acLabel}: ${test.name} ---`);

  const result = {
    ac: test.ac,
    name: test.name,
    criteria: test.criteria,
    steps: [],
    screenshots: [],
    status: 'skip',
    notes: '',
    error: '',
    durationMs: 0,
  };

  if (!loginSuccess) {
    result.status = 'skip';
    result.notes = 'Skipped due to login failure.';
    testResults.push(result);
    continue;
  }

  const testStart = Date.now();
  let stepStart = Date.now();

  try {
    // Each test.run() receives page, a step logger, and a screenshot function
    await test.run(
      page,
      // Log a step with timing + formatting
      (stepText) => {
        const formatted = formatStep(stepText);
        if (formatted === null) return; // suppress noise
        const now = Date.now();
        const elapsed = now - stepStart;
        result.steps.push({ text: formatted, durationMs: elapsed });
        stepStart = now;
        console.log(`    Step (${(elapsed / 1000).toFixed(1)}s): ${formatted}`);
      },
      // Capture a screenshot (opts.keepOverlays = true to preserve open menus)
      async (label, opts = {}) => {
        const safeName = `ac${test.ac}_${label}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const path = await capture(page, safeName, opts);
        result.screenshots.push({ label, path });
      }
    );

    result.status = 'pass';
    result.durationMs = Date.now() - testStart;
    console.log(`  Result: PASS (${(result.durationMs / 1000).toFixed(1)}s)`);
  } catch (e) {
    result.status = 'fail';
    result.error = e.message;
    result.durationMs = Date.now() - testStart;
    console.error(`  Result: FAIL — ${e.message}`);

    // Capture failure screenshot
    try {
      const failPath = await capture(page, `ac${test.ac}_FAIL`);
      result.screenshots.push({ label: 'State at failure', path: failPath });
    } catch (_) {}
  }

  testResults.push(result);
}

// Generate report
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = join(REPORT_DIR, `${normalizedKey}.html`);

const suiteDurationMs = Date.now() - suiteStart;

generateReport({
  ticketKey: normalizedKey,
  ticketSummary: metadata.summary,
  tester: metadata.tester || 'Bryan',
  branch: metadata.branch || normalizedKey,
  environment: metadata.environment || (baseUrl.includes('localhost') ? 'Local Dev (WSL)' : 'QA'),
  baseUrl,
  testCases: testResults,
  screenshotDir,
  outputPath: reportPath,
  fixtures: metadata.fixtures || [],
  suiteDurationMs,
});

// Close browser
await close();

// Cleanup seed data
if (seedManifest && !skipCleanup) {
  try {
    console.log('\n--- Cleaning up seed data ---');
    cleanupSeed(seedDef.tag);
  } catch (e) {
    console.error(`Cleanup failed: ${e.message}`);
  }
}

const passed = testResults.filter(t => t.status === 'pass').length;
const failed = testResults.filter(t => t.status === 'fail').length;
const skipped = testResults.filter(t => t.status === 'skip').length;
console.log(`\n=== Done: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
console.log(`Report: ${reportPath}\n`);

// Post results to Jira if --post-to-jira flag or JIRA_POST env var is set
if (process.argv.includes('--post-to-jira') || process.env.JIRA_POST === '1') {
  try {
    const { postQAComment } = await import('./lib/jira.mjs');
    console.log(`Posting QA results to Jira ${normalizedKey}...`);
    await postQAComment(normalizedKey, testResults, reportPath, {
      tester: metadata.tester || 'Bryan',
      environment: metadata.environment || 'Local Dev (WSL)',
    });
    console.log(`Jira comment posted successfully.`);
  } catch (e) {
    console.error(`Failed to post to Jira: ${e.message}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
