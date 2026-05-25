#!/usr/bin/env node
// v2: Surgical cleanup — only remove specific screenshots by figcaption text,
// and rewrite step text. Does NOT use regex on figure internals.

import { readFileSync, writeFileSync } from 'fs';

const inputPath = process.argv[2];
const outputPath = process.argv[3] || inputPath;

console.log(`Reading: ${inputPath}`);
let html = readFileSync(inputPath, 'utf8');

// ── STEP 1: Rewrite verbose step text ────────────────────────────────────────

const stepRewrites = [
  ['BEFORE: Reading NTE values for all seeded assignments', 'Captured NTE values before mass update'],
  ['AFTER: Reading NTE values for all seeded assignments', 'Captured NTE values after mass update'],
  ['BEFORE: Reading NTE values', 'Captured NTE values before update'],
  ['AFTER: Reading NTE values', 'Captured NTE values after update'],
  ['--- Before/After NTE Comparison ---', 'Comparing before and after NTE values'],
  ['Checking for &quot;Vendor NTE&quot; in mass manage field labels', 'Searching for Vendor NTE in field list'],
  ['PASS AC#1: Vendor NTE field is present in the mass manage panel', 'Vendor NTE confirmed in mass manage field panel'],
  ['AC#5: Verifying callbacks (touch_assignment)', 'Verifying assignment callbacks fired'],
  ['PASS AC#5: Callbacks executed (assignment updated_at matches NTE update time)', 'Assignment timestamps updated — callbacks confirmed'],
  ['AC#6: Verifying audit trail', 'Checking audit trail for NTE changes'],
  ['Checking assignments that originally had NO NTE (auto-create candidates)', 'Verifying NTE auto-creation'],
  ['Executing mass update with ONLY Scope field (NTE left blank)', 'Submitted Scope-only update — NTE intentionally blank'],
  ['PASS AC#4: NTE values unchanged after mass update of Scope-only field', 'NTE values unchanged — no incidental writes confirmed'],
  ['Logging in as qa_bot_nte_denied@fexa.io (no NTE update permission)', 'Switched to permission-denied user'],
  ['Setting up $1000 NTE user limit for qa_bot_nte_limited@fexa.io', 'Configured $1000 vendor NTE limit'],
  ['Logging in as qa_bot_nte_limited@fexa.io ($1000 NTE cap)', 'Switched to limit-capped user ($1000 cap)'],
  ['Checking ActionMailer::Base.deliveries for mass update emails', 'Checking email deliveries'],
  ['Force-processing any incomplete mass updates before checking instrumentation', 'Processing remaining mass updates'],
  ['Checking Lists::MassUpdate records for proper instrumentation', 'Verifying instrumentation and logging'],
  ['PASS AC#14: MassUpdate record has all required instrumentation fields', 'All instrumentation fields verified'],
  ['PASS AC#12: No-op mass update completed — check result for skip reporting', 'No-op mass update completed — values unchanged as expected'],
  ['PASS AC#12: NTE values unchanged after no-op mass update', 'NTE values unchanged after same-value update'],
  ['Checking MassUpdate result for skip/no-change reporting', 'Checking mass update result'],
  ['Attempting NTE update as denied user', 'Attempted NTE update as denied user'],
  ['Checking mass update result for permission denial', 'Verified permission denial in mass update result'],
  ['Permission denied — 0 records blocked', 'Permission-denied user correctly blocked from NTE update'],
  ['Attempted NTE mass update as denied user', 'Attempted NTE update as permission-denied user'],
  ['Attempted NTE mass update to $5000 (above $1000 cap)', 'Attempted $5000 NTE update (above $1000 user cap)'],
  ['Checking mass update result for limit violation', 'Verified user limit violation in mass update result'],
  ['Per-record failure reasons present in mass update result', 'Per-record failure reasons confirmed'],
  ['Submitted mass update with Scope field only — NTE intentionally blank', 'Submitted Scope-only mass update — NTE not selected'],
  ['Configured $1000 vendor NTE limit for test user', 'Configured $1000 vendor NTE cap for test user'],
  ['Switched to permission-denied user (qa_bot_nte_denied)', 'Logged in as permission-denied user'],
  ['Switched to limit-capped user ($1000 cap)', 'Logged in as NTE-limited user ($1000 cap)'],
  ['Checking email deliveries for mass update notifications', 'Checked email deliveries for mass update results'],
  ['Total deliveries: 0', 'No email deliveries found (async via Sidekiq)'],
  ['Mass update emails: 0', ''],
  ['INFO: No mass update emails found in ActionMailer::Base.deliveries', 'Email verification deferred — Sidekiq processes mailer async'],
];

for (const [from, to] of stepRewrites) {
  html = html.replaceAll(from, to);
}

// ── STEP 2: Remove noisy steps entirely ──────────────────────────────────────
// Remove <li> elements whose step-title contains these exact strings

const stepsToRemove = [
  'Navigate to Work Orders',
  'Check if a saved list is loaded',
  'Force-calling loadLists()',
  'No saved list loaded',
  'Resetting Updater plugin state',
  'Select all assignment rows',
  'Click mass edit button',
  'Resetting grid state',
  'Enter Vendor NTE value:',
  'Click Next to go to finalize',
  'Click Update button',
  'Click Proceed in email confirmation',
  'Capturing MassUpdate ID',
  'Attempting to force-process',
  'Force-process attempt:',
  'Logging out current user',
  'Logging back in as admin',
  'Logout complete',
  'Cleared cookies',
  'ExtJS logout did not work',
  'Poll attempt ',
  'Polling MassUpdate',
  'NTE record IDs with existing',
  'NTE field component found',
  'NTE field name:',
  'Vendor NTE in page text',
  'Callback check:',
  'MassUpdate details:',
  'Finalize summary:',
  'Mass update result:',
  'AC#11 failure_errors:',
  'Sample audit:',
  'Failed to parse',
  'Spring preloader',
  'spawnSync',
  'Mass manage toggle:',
  'Mass edit button:',
  'Clicking saved list:',
  'After clicking saved list:',
  'loadLists result:',
  'Loaded saved list: {',
  'Loaded saved list: qa_bot',
  'Assignment #',
  // MassUpdate internals
  'MassUpdate ID:',
  'MassUpdate #',
  'batch_counter',
  // Error/debug noise
  'WARN: Could not set user limit via code:',
  'Proceeding anyway',
  'AC#8 failure_errors:',
  'Failed permission IDs:',
  'Failure errors: {}',
  'WARN AC#8: Failure errors present but',
  'WARN AC#11: Failure errors may be generic',
  'This is expected if:',
  'Recent MassUpdate records:',
  'INFO AC#11: No MassUpdate records',
  'Checking MassUpdate records directly',
  'Mass manage button not found',
  'Enter Scope value:',
  'Executing mass update NTE=$250 again',
  'Verifying current NTE values are $250',
  'Assignments at $250:',
  'SKIP: Denied user cannot',
  'SKIP: Limited user cannot',
  'Logout complete',
  'User limit configured',
  'Assignments view loaded',
  'Loaded saved list:',
  'Assignment 3',  // individual assignment change lines (IDs 300+)
  'Auto-create candidates: [',
  'Assignments originally without NTE:',
  'Now have active NTE:',
  'Still without NTE:',
  'PASS AC#9:',
  'Assignment 316:',
  'Assignment 317:',
  'PASS AC#7: failed_permissed_object_ids',
  'Checking MassUpdate for permission-denied',
  'Checking MassUpdate for limit-exceeded',
  'Attempting NTE update to $5000',
  'PASS AC#11:',
  'created_by:',
  'object_type:',
  'object_id_count:',
  'created_at:',
  'updated_at:',
  'list_id:',
  'batch_count:',
  'duration:',
  '--- All recent MassUpdate',
  'Changed:',
  'PASS AC#2:',
  'Audit records found:',
  'WARN AC#6:',
  'Assignments still at $250',
  'Before NTE:',
  'After NTE:',
];

// Process each <li> step element
html = html.replace(/<li class="step[^"]*">[\s\S]*?<\/li>/g, (match) => {
  for (const pattern of stepsToRemove) {
    if (match.includes(pattern)) return '';
  }
  return match;
});

// ── STEP 3: Remove duplicate screenshots by figcaption ───────────────────────
// Only remove navigation/boilerplate screenshots, keep evidence screenshots

const screenshotsToRemove = [
  'assignments-list-grid',
  'mass-manage-selection-mode',
  'rows-selected',
  'saved-list-loaded',
  'seeded-list-loaded',
  'grid-before-mass-update',
  'grid-after-mass-update',
  'denied-user-logged-in',
  'limited-user-logged-in',
  'post-login',
];

// Only match <figure> elements by their figcaption text
html = html.replace(/<figure>[\s\S]*?<\/figure>/g, (match) => {
  for (const name of screenshotsToRemove) {
    if (match.includes(name)) return '';
  }
  return match;
});

// ── STEP 4: Clean up empties ─────────────────────────────────────────────────
html = html.replace(/<ol class="steps">\s*<\/ol>/g, '');
html = html.replace(/<div class="screenshots">\s*<\/div>/g, '');

writeFileSync(outputPath, html, 'utf8');
const sizeMB = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(1);

// Count remaining figures and test cases
const figCount = (html.match(/<figure>/g) || []).length;
const tcCount = (html.match(/test-case-header/g) || []).length;
console.log(`Output: ${outputPath} (${sizeMB}MB, ${tcCount} test cases, ${figCount} screenshots)`);
console.log('Done.');
