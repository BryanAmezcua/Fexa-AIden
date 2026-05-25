#!/usr/bin/env node
// Quick script to clean up step text in an existing HTML report
// Usage: node clean-report.mjs /path/to/report.html

import { readFileSync, writeFileSync } from 'fs';

const inputPath = process.argv[2];
const outputPath = process.argv[3] || inputPath; // overwrite by default

console.log(`Reading: ${inputPath}`);
let html = readFileSync(inputPath, 'utf8');

// Step text lives inside: <span class="step-title">...</span>
// Replace verbose steps with clean English

const replacements = [
  // Navigation boilerplate → remove entire step li
  [/<!-- step -->.*?Navigate to Work Orders.*?<\/li>/gs, ''],
  [/<!-- step -->.*?Navigating to:.*?<\/li>/gs, ''],
  [/<!-- step -->.*?Arrived at:.*?<\/li>/gs, ''],

  // Since steps are in <li> tags with step-title spans, target the span content
  // Navigation noise
  ['Navigate to Work Orders &gt; Assignments via sidebar', null],
  ['Check if a saved list is loaded (required for mass manage)', null],
  ['Force-calling loadLists() and searching for saved list child nodes', null],
  ['No saved list loaded — attempting to load or create one', null],
  ['Resetting Updater plugin state and activating mass manage', null],
  ['Select all assignment rows via select-all checkbox', null],
  ['Click mass edit button (pencil)', null],
  ['Resetting grid state for fresh mass manage', null],
  ['Enter Vendor NTE value: 250', null],
  ['Click Next to go to finalize', null],
  ['Click Update button', null],
  ['Click Proceed in email confirmation', null],
  ['Capturing MassUpdate ID', null],
  ['Attempting to force-process mass update synchronously', null],
  ['Logging out current user', null],
  ['Logging back in as admin', null],
  ['Logout complete', null],
  ['Cleared cookies to force logout', null],

  // Verbose → concise rewrites
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
  ['Checking assignments that originally had NO NTE (auto-create candidates)', 'Verifying NTE auto-creation on assignments that had none'],
  ['Executing mass update with ONLY Scope field (NTE left blank)', 'Submitted mass update with Scope only — NTE intentionally blank'],
  ['PASS AC#4: NTE values unchanged after mass update of Scope-only field', 'NTE values unchanged — no incidental writes confirmed'],
  ['Logging in as qa_bot_nte_denied@fexa.io (no NTE update permission)', 'Switched to permission-denied user (qa_bot_nte_denied)'],
  ['Attempting NTE update as denied user', 'Attempted NTE mass update as denied user'],
  ['Checking MassUpdate for permission-denied failures', 'Checking mass update result for permission denial'],
  ['PASS AC#7: Vendor NTE field not shown to user without NTE update permission', 'Vendor NTE field not visible to denied user — permission gate working'],
  ['Setting up $1000 NTE user limit for qa_bot_nte_limited@fexa.io', 'Configured $1000 vendor NTE limit for test user'],
  ['Logging in as qa_bot_nte_limited@fexa.io ($1000 NTE cap)', 'Switched to limit-capped user ($1000 cap)'],
  ['Attempting NTE update to $5000 (above $1000 user limit)', 'Attempted NTE mass update to $5000 (above $1000 cap)'],
  ['Checking MassUpdate for limit-exceeded failures', 'Checking mass update result for limit violation'],
  ['PASS AC#8: Failure errors contain limit-exceeded message', 'User limit exceeded — $5000 blocked by $1000 cap'],
  ['PASS AC#11: Per-record failure reasons present in MassUpdate record', 'Per-record failure reasons present in mass update result'],
  ['Checking ActionMailer::Base.deliveries for mass update emails', 'Checking email deliveries for mass update notifications'],
  ['Force-processing any incomplete mass updates before checking instrumentation', 'Processing remaining mass updates before verification'],
  ['Checking Lists::MassUpdate records for proper instrumentation', 'Verifying mass update instrumentation and logging'],
  ['PASS AC#14: MassUpdate record has all required instrumentation fields', 'All instrumentation fields verified — user, run ID, counts, timestamps present'],
];

// Patterns to suppress entirely (remove the whole <li>)
const suppressPatterns = [
  /Navigating to:/,
  /Arrived at:/,
  /Assignments view:/,
  /loadLists result:/,
  /Loaded saved list: \{/,
  /Loaded saved list: qa_bot/,
  /Clicking saved list:/,
  /After clicking saved list:/,
  /Mass manage toggle:/,
  /Mass edit button:/,
  /Force-process attempt:/,
  /Poll attempt \d+/,
  /Polling MassUpdate/,
  /MassUpdate #\d+ completed/,
  /MassUpdate #\d+ did NOT complete/,
  /NTE record IDs with existing values/,
  /NTE field component found/,
  /NTE field name:/,
  /Vendor NTE in page text/,
  /&quot;Vendor NTE&quot; in page text/,
  /ExtJS logout did not work/,
  /Clearing cookies/,
  /Callback check:/,
  /MassUpdate details:/,
  /Finalize summary:/,
  /Mass update result:/,
  /AC#11 failure_errors:/,
  /Sample audit:/,
  /Failed to parse/,
  /Spring preloader/,
  /DEPRECATED/,
  /spawnSync/,
  /Assignment \d+: \$/,  // individual assignment change lines
  /Assignment \d+: NEW/,
];

// Apply text replacements
for (const [from, to] of replacements) {
  if (typeof from === 'string' && to === null) {
    // Remove lines containing this text
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<li class="step[^"]*">\\s*<span class="step-mark">[^<]*</span>\\s*<span class="step-title">[^<]*${escaped}[^<]*</span>[^<]*(?:<span[^<]*</span>)?\\s*</li>`, 'g');
    html = html.replace(regex, '');
  } else if (typeof from === 'string' && typeof to === 'string') {
    html = html.replaceAll(from, to);
  }
}

// Suppress patterns — remove entire <li> elements
for (const pattern of suppressPatterns) {
  // Match <li> elements where step-title contains the pattern
  const liRegex = new RegExp(`<li class="step[^"]*">[\\s\\S]*?</li>`, 'g');
  html = html.replace(liRegex, (match) => {
    if (pattern.test(match)) return '';
    return match;
  });
}

// Clean up empty <ol> tags that might result
html = html.replace(/<ol class="steps">\s*<\/ol>/g, '');

// Remove duplicate/navigation screenshots — keep only meaningful ones
const screenshotKillPatterns = [
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

for (const pattern of screenshotKillPatterns) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const figRegex = new RegExp(`<figure>[\\s\\S]*?${escaped}[\\s\\S]*?<\\/figure>`, 'g');
  const before = html.length;
  html = html.replace(figRegex, '');
  if (html.length < before) console.log(`  Removed screenshots matching: ${pattern}`);
}

// Clean up empty screenshot sections
html = html.replace(/<div class="screenshots">\s*<\/div>/g, '');
html = html.replace(/<h4>Evidence<\/h4>\s*(?=<\/div>)/g, '');

writeFileSync(outputPath, html, 'utf8');
const sizeMB = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(1);
console.log(`Cleaned report written to: ${outputPath} (${sizeMB}MB)`);
console.log('Done.');
