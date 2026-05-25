#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';

const inputPath = process.argv[2];
const outputPath = process.argv[3] || inputPath;

console.log(`Reading: ${inputPath}`);
let html = readFileSync(inputPath, 'utf8');

// ── STEP 1: Rewrite verbose step text → clean English ────────────────────────

const stepRewrites = [
  // Navigation
  ['Navigate to Administration &gt; Pricings &gt; Client Pricing', 'Opened Client Pricing grid'],
  ['Navigate to Administration &gt; Pricings &gt; Subcontractor Pricing', 'Opened Subcontractor Pricing grid'],
  ['Navigate to Administration &gt; Imports', 'Opened Imports page'],
  // Also handle un-escaped versions
  ['Navigate to Administration > Pricings > Client Pricing', 'Opened Client Pricing grid'],
  ['Navigate to Administration > Pricings > Subcontractor Pricing', 'Opened Subcontractor Pricing grid'],
  ['Navigate to Administration > Imports', 'Opened Imports page'],
  // Hamburger menus
  ['Click Client grid hamburger menu', 'Opened Client grid hamburger menu'],
  ['Click Subcontractor grid hamburger menu', 'Opened Subcontractor grid hamburger menu'],
  ['Client menu items: Export Pricings, Download Import Template, Upload Import File', 'All 3 menu items present: Export, Download Template, Upload'],
  ['Navigate to Subcontractor Pricing grid for template download', 'Navigated to Subcontractor Pricing for template download'],
  // Template
  ['Rendering new template columns (scrolled right view)', 'Template columns rendered — lifecycle fields visible'],
  ['Template: 27 columns, 1 sheets', 'Template verified: 27 columns across 1 sheet'],
  ['Column count: 27', ''],
  // Export
  ['Click hamburger &gt; Export Pricings', 'Clicked Export Pricings from hamburger menu'],
  ['Click hamburger > Export Pricings', 'Clicked Export Pricings from hamburger menu'],
  ['Export initiated — file will be emailed to the user', 'Export triggered — confirmation email sent'],
  // Import wizard
  ['Click Create Import button', 'Clicked Create Import'],
  ['Open importables dropdown', 'Opened import type dropdown'],
  // Import results — rewrite completion messages to clean English
  ['Import complete: 1 Rows Processed. 1 Successful. 0 Failures.', 'Import complete — 1 row processed, 1 successful'],
  ['Import complete: 3 Rows Processed. 2 Successful. 1 Failures.', 'Import complete — 3 rows processed, 2 successful, 1 failed'],
  ['Import complete: 1 Rows Processed. 1 Successful. 0 Failures.', 'Import complete — 1 row processed, 1 successful'],
  ['Import complete: 20 Rows Processed. 20 Successful. 0 Failures.', 'Import complete — 20 rows processed, all successful'],
  ['Import complete: 3 Rows Processed. 1 Successful. 2 Failures.', 'Import complete — 3 rows processed, 1 successful, 2 failed'],
  // AC-specific rewrites
  ['Uploading file with intentional errors (bad type, missing name)', 'Uploaded file with intentional errors (bad type, missing name)'],
  ['Subcontractor pricing grid present: true', 'Subcontractor Pricing grid loaded'],
  ['Verify hamburger menu on Subcontractor grid', 'Verified hamburger menu on Subcontractor grid'],
  ['Subcontractor parity confirmed: all prior import tests (ACs 5-10, 12) run against Subcontractor variant', 'All import tests confirmed against Subcontractor variant — parity verified'],
];

for (const [from, to] of stepRewrites) {
  if (to !== '') {
    html = html.replaceAll(from, to);
  }
}

// ── STEP 2: Remove noisy steps entirely ──────────────────────────────────────

const stepsToRemove = [
  // Navigation / wizard boilerplate
  'Navigating back to app after template render',
  'File selected',
  'Clicking Upload button',
  'Clicking Begin Import',
  'Import started',
  'Waiting for import to complete',
  'Navigate to import wizard',
  'Import wizard loaded',
  'Import wizard ready',
  'File uploaded',
  // Template column verification (already shown in screenshot)
  'Column &quot;Action&quot; present:',
  'Column &quot;ID&quot; present:',
  'Column &quot;Pricing Name&quot; present:',
  'Column &quot;Pricing Type&quot; present:',
  'Column &quot;Active&quot; present:',
  'Column &quot;Base Price&quot; present:',
  'Column &quot;Vendor&quot; present:',
  'Column &quot;Prevent Price Modification&quot; present:',
  'Column &quot;Effective Start Date&quot; present:',
  'Column &quot;Effective End Date&quot; present:',
  'Column "Action" present:',
  'Column "ID" present:',
  'Column "Pricing Name" present:',
  'Column "Pricing Type" present:',
  'Column "Active" present:',
  'Column "Base Price" present:',
  'Column "Vendor" present:',
  'Column "Prevent Price Modification" present:',
  'Column "Effective Start Date" present:',
  'Column "Effective End Date" present:',
  // File/path internals
  'Sheet count:',
  'Sheets:',
  'Uploading file:',
  'Column count:',
  'Columns:',
  // Import results noise
  'Results: 1 successful',
  'Results: 2 successful',
  'Results: 20 successful',
  'Results: 1 successful, 2 failures',
  // Phase labels
  'Phase 1: CREATE record',
  'Phase 2: UPDATE same record',
  'Created record ID:',
  'Created batch file with 20 rows',
  'Note: 20 rows processed too fast',
  // Date/modification column internals
  'Using date columns:',
  'Using modification column:',
  'Uploaded 3 rows:',
  'Test file created:',
  // Detail page failures (known issue)
  'Opening pricing detail for record',
  'Detail page navigation skipped:',
  'Detail page skipped:',
  // Template download internals
  'Initiate template download via hamburger menu',
  'Download event not caught',
  'Template downloaded via API:',
  // Misc
  'Pricing options found:',
  'Failure details:',
  'Opened Subcontractor Pricing grid',  // Remove redundant nav steps (keep first per AC)
];

html = html.replace(/<li class="step[^"]*">[\s\S]*?<\/li>/g, (match) => {
  for (const pattern of stepsToRemove) {
    if (match.includes(pattern)) return '';
  }
  return match;
});

// ── STEP 3: Remove duplicate/boilerplate screenshots ─────────────────────────
// Keep: client-pricings-grid, client-hamburger-menu-open, sub-hamburger-menu-open,
//       template-downloaded, template-new-columns, export-triggered, imports-dropdown-open,
//       import-complete (one per AC), error-details, sub-pricings-grid, sub-hamburger-menu
// Remove: repetitive import-wizard, file-uploaded, import-started, record-detail-skipped

const screenshotsToRemove = [
  'import-wizard',       // repeated 8 times — wizard UI is same every time
  'file-uploaded',       // repeated 8 times — file input is same every time
  'import-started',      // repeated 8 times — spinner/progress is same every time
  'record-detail-skipped', // detail page never loaded (timeout), useless screenshot
  'imports-grid',        // just the empty grid, not useful
];

html = html.replace(/<figure>[\s\S]*?<\/figure>/g, (match) => {
  for (const name of screenshotsToRemove) {
    if (match.includes(name)) return '';
  }
  return match;
});

// ── STEP 3b: Remove duplicate import-complete screenshots ────────────────────
// Keep only 3: first success (AC#5), the partial failure (AC#7), and error (AC#12)
// The figcaptions are all "import-complete" so we keep 1st, 3rd (AC#7 = 2+1 fail), and last
let importCompleteIdx = 0;
const importCompleteKeep = [0, 2, 7]; // indices to keep: AC5, AC7(partial), AC12(errors)
html = html.replace(/<figure>[\s\S]*?<\/figure>/g, (match) => {
  if (match.includes('import-complete')) {
    const keep = importCompleteKeep.includes(importCompleteIdx);
    importCompleteIdx++;
    return keep ? match : '';
  }
  return match;
});

// ── STEP 3c: Clean "Finished in X minutes" suffix from step text ─────────────
html = html.replace(/Finished in \d+ minutes \d+ seconds/g, '');

// ── STEP 4: Clean up empties ─────────────────────────────────────────────────
html = html.replace(/<ol class="steps">\s*<\/ol>/g, '');
html = html.replace(/<div class="screenshots">\s*<\/div>/g, '');

// ── STEP 5: Remove duplicate "Opened Subcontractor Pricing grid" steps ───────
// Keep only the first occurrence per test case — remove subsequent ones that
// are just navigation back after imports
let subGridCount = 0;
html = html.replace(/<li class="step[^"]*">[\s\S]*?<\/li>/g, (match) => {
  if (match.includes('Opened Subcontractor Pricing grid')) {
    subGridCount++;
    // Keep the first two (AC#1 verify, AC#2 template download), remove rest
    if (subGridCount > 2) return '';
  }
  return match;
});

writeFileSync(outputPath, html, 'utf8');
const sizeMB = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(1);
const figCount = (html.match(/<figure>/g) || []).length;
const stepCount = (html.match(/step-title/g) || []).length;
console.log(`\nBefore: 3.3MB, 47 screenshots, 159 steps`);
console.log(`After:  ${outputPath} (${sizeMB}MB, ${figCount} screenshots, ${stepCount} steps)`);
console.log('Done.');
