/**
 * Custom Playwright reporter that emits a single self-contained HTML file
 * per test run. Screenshots are base64-embedded so the file can be attached
 * to a ticket directly without external assets.
 *
 * Output: ./reports/qa-report-<timestamp>.html plus ./reports/latest.html
 *
 * Test conventions consumed (see src/support/qa-report.ts):
 *   - testInfo.annotations of type 'ticket' → grouping + ticket link
 *   - testInfo.annotations of type 'ac' (JSON-encoded AcClause[]) → AC text
 *   - test.step('label', ...) → human-readable "Steps executed" list
 *     (step labels should spell out input values for reproducibility)
 *   - testInfo.attach('ac-snapshot-before' / 'ac-snapshot-after', ...) →
 *     embedded before/after screenshots, opened full-size on click
 *
 * Tests with zero `test.step()` calls are excluded from the report — the
 * report only lists scenarios that can be reproduced manually.
 */

import type {
  FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep,
} from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';
import {
  reportOutputDir, ticketUrl, PERSONAS,
  ANNOTATION_TICKET, ANNOTATION_AC,
  type AcClause,
} from '../support/qa-report';

interface SeedManifest {
  generated_at: string;
  ticket?: string;
  source_seed: string;
  description: string;
  scope: {
    product?: { id?: number; name?: string; classification?: string };
    vendor?:  { name?: string; role_id?: number; entity_id?: number; user_email?: string };
    facility?: { id?: number; identifier?: string };
    invoice_targets?: { subcontractor_invoice_id?: number | null; subcontractor_quote_id?: number | null };
    currency?: string;
    pricing_type?: string;
    base_price?: string;
  };
  fixtures: Array<{
    id?: number;
    name: string;
    active: boolean;
    effective_start_date?: string | null;
    effective_end_date?: string | null;
    facility_id?: number | null;
    pricing_type?: string;
    base_price?: string;
    currency?: string;
    prevent_price_modification?: boolean;
    purpose?: string;
  }>;
}

interface TestEntry {
  title: string;
  status: TestResult['status'];
  duration: number;
  ticket?: string;
  ac: AcClause[];
  persona: string;
  steps: StepEntry[];
  /** Legacy single-snapshot path: captureAcSnapshot(…, 'before') without a label. */
  beforeImg?: string;
  /** Legacy single-snapshot path: captureAcSnapshot(…, 'after') without a label. */
  afterImg?: string;
  /** New labeled-snapshot path: captureAcSnapshot(…, 'before', { label }) — invocation order preserved. */
  beforeSteps: SnapshotStep[];
  /** New labeled-snapshot path: captureAcSnapshot(…, 'after', { label }) — invocation order preserved. */
  afterSteps: SnapshotStep[];
  beforeNote?: string;
  afterNote?: string;
  error?: string;
  errorLocation?: string;
  tracePath?: string;
  videoPath?: string;
  reproCommands: string[];
}

interface SnapshotStep {
  label: string;
  img: string;
}

interface StepEntry {
  title: string;
  ok: boolean;
  durationMs: number;
}

class QaReporter implements Reporter {
  private startTime = Date.now();
  private config!: FullConfig;
  private entries: TestEntry[] = [];
  private baseURL = '';

  onBegin(config: FullConfig, _suite: Suite): void {
    this.startTime = Date.now();
    this.config = config;
    for (const proj of config.projects) {
      if (proj.use?.baseURL) { this.baseURL = String(proj.use.baseURL); break; }
    }
    if (!this.baseURL) this.baseURL = process.env.TEST_BASE_URL || '';
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const ticket = test.annotations.find((a) => a.type === ANNOTATION_TICKET)?.description;
    const acRaw  = test.annotations.find((a) => a.type === ANNOTATION_AC)?.description;
    const ac     = parseAcAnnotation(acRaw);

    const projectName = test.parent.project()?.name ?? '';
    const entry: TestEntry = {
      title: test.title,
      status: result.status,
      duration: result.duration,
      ticket, ac,
      persona: PERSONAS[projectName] || projectName,
      steps: collectStepEntries(result.steps),
      beforeSteps: [],
      afterSteps:  [],
      reproCommands: buildReproCommands(test),
    };

    for (const att of result.attachments) {
      if (!att.path) continue;

      // Labeled multi-snapshot path: attachment name shaped like
      // `ac-snapshot-{moment}:{label}`. Split on the FIRST colon only —
      // labels may contain text but not colons (enforced by the helper).
      const labeledMatch = /^ac-snapshot-(before|after):(.+)$/.exec(att.name);
      if (labeledMatch) {
        const [, moment, label] = labeledMatch;
        const img = toDataUri(att.path, att.contentType || 'image/png');
        if (img) {
          const target = moment === 'before' ? entry.beforeSteps : entry.afterSteps;
          target.push({ label, img });
        }
        continue;
      }

      // Legacy single-snapshot path (no label) and capture-error sentinels.
      if (att.name === 'ac-snapshot-before') {
        entry.beforeImg = toDataUri(att.path, att.contentType || 'image/png');
      } else if (att.name === 'ac-snapshot-after') {
        entry.afterImg = toDataUri(att.path, att.contentType || 'image/png');
      } else if (att.name === 'ac-snapshot-before-error') {
        entry.beforeNote = readSnippet(att.path);
      } else if (att.name === 'ac-snapshot-after-error') {
        entry.afterNote = readSnippet(att.path);
      } else if (att.name === 'trace' && att.path.endsWith('.zip')) {
        entry.tracePath = path.relative(this.config.rootDir, att.path);
      } else if (att.name === 'video' && att.path.endsWith('.webm')) {
        entry.videoPath = path.relative(this.config.rootDir, att.path);
      }
    }

    if (result.errors.length) {
      entry.error = result.errors.map((e) => stripAnsi(e.message || String(e))).join('\n\n');
      const loc = result.errors[0]?.location;
      if (loc) entry.errorLocation = `${path.relative(this.config.rootDir, loc.file)}:${loc.line}`;
    }

    this.entries.push(entry);
  }

  async onEnd(_result: FullResult): Promise<void> {
    // Drop tests with zero steps — they aren't reproducible from the report,
    // and any skipped-by-fixture tests fall into this category.
    const reportable = this.entries.filter((e) => e.steps.length > 0);

    if (reportable.length === 0) {
      // eslint-disable-next-line no-console
      console.log('\n[qa-report] No reportable tests in this run — no files written.');
      return;
    }

    // Group reportable entries by ticket. We emit ONE report file per
    // ticket so a multi-ticket run produces multiple files, not a combined
    // dump. Tests without a ticket annotation are skipped (the report has
    // no good place for them).
    const byTicket = groupByTicket(reportable);
    const outDir = reportOutputDir();
    const latestDir = path.join(outDir, 'latest');
    fs.mkdirSync(latestDir, { recursive: true });

    // Migrate away from the legacy combined file if it exists.
    const legacyLatest = path.join(outDir, 'latest.html');
    if (fs.existsSync(legacyLatest)) {
      try { fs.unlinkSync(legacyLatest); } catch { /* best-effort */ }
    }

    const written: string[] = [];
    for (const [ticket, tests] of Object.entries(byTicket)) {
      if (ticket === '__no-ticket__') {
        // eslint-disable-next-line no-console
        console.warn(`[qa-report] Skipping ${tests.length} unannotated test(s) — add annotateAc() to include them.`);
        continue;
      }
      const html = this.renderHtml(tests);
      const outPath = path.join(latestDir, `${ticket}.html`);
      fs.writeFileSync(outPath, html, 'utf8');
      written.push(outPath);
    }

    // eslint-disable-next-line no-console
    console.log(`\n[qa-report] Wrote ${written.length} ticket report${written.length === 1 ? '' : 's'}:`);
    for (const p of written) {
      // eslint-disable-next-line no-console
      console.log(`[qa-report]   ${p}`);
    }
  }

  // --- HTML rendering ------------------------------------------------------

  private renderHtml(entries: TestEntry[]): string {
    const runTimestamp = new Date(this.startTime).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const runDuration  = formatMs(Date.now() - this.startTime);
    const byTicket     = groupByTicket(entries);
    const allPersonas  = uniqueOrdered(entries.map((e) => e.persona).filter(Boolean));
    const totals        = summarize(entries);
    // Only include seed cards whose `ticket` field matches a ticket actually
    // exercised in this run — otherwise a TANGO-3-only run would show
    // unrelated TANGO-6 seed data (and vice versa). Manifests without a
    // ticket field are kept (legacy / generic).
    const ticketsInRun = new Set(entries.map((e) => e.ticket).filter(Boolean) as string[]);
    const seedManifests = readSeedManifests().filter(
      (m) => !m.ticket || ticketsInRun.has(m.ticket),
    );

    const pastableSummary = renderPastableSummary({
      entries, runTimestamp, baseURL: this.baseURL, runDuration, totals, allPersonas,
    });

    const ticketKeys = Object.keys(byTicket).filter((k) => k !== '__no-ticket__');
    const showInlineGroupHeader = ticketKeys.length > 1; // only useful as scroll-anchor when multi-ticket
    const ticketSections = Object.entries(byTicket).map(([ticket, tests]) => {
      const ticketHeader = showInlineGroupHeader
        ? (ticket === '__no-ticket__'
            ? `<h2 class="ticket-title">Uncategorized</h2>`
            : `<h2 class="ticket-title">${escapeHtml(ticket)} <a class="ticket-link" href="${escapeAttr(ticketUrl(ticket))}" target="_blank" rel="noopener">View ticket ↗</a></h2>`)
        : '';
      return `<section class="ticket-group">${ticketHeader}\n${tests.map((t) => this.renderTest(t)).join('\n')}</section>`;
    }).join('\n');

    // Tickets-under-test card, rendered ABOVE the summary so a reader sees
    // *what was tested* before *how it went*.
    const ticketsCard = ticketKeys.length
      ? `<section class="tickets-card">
           <h2>Ticket${ticketKeys.length > 1 ? 's' : ''} under test</h2>
           <ul class="tickets-list">
             ${ticketKeys.map((t) => `<li>
               <strong>${escapeHtml(t)}</strong>
               <a class="ticket-link" href="${escapeAttr(ticketUrl(t))}" target="_blank" rel="noopener">${escapeAttr(ticketUrl(t))} ↗</a>
             </li>`).join('')}
           </ul>
         </section>`
      : '';

    const seedCards = seedManifests.map(renderSeedCard).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>TANGO QA Report — ${runTimestamp}</title>
<style>${CSS}</style>
</head>
<body>
  <header class="report-header">
    <h1>TANGO QA Report</h1>
    <div class="run-meta">
      <span><strong>Run</strong> ${escapeHtml(runTimestamp)}</span>
      <span><strong>Environment</strong> ${escapeHtml(this.baseURL || 'unknown')}</span>
      <span><strong>Duration</strong> ${escapeHtml(runDuration)}</span>
    </div>
    <div class="totals">
      <span class="pill pill-pass">✓ ${totals.passed} passed</span>
      ${totals.failed  ? `<span class="pill pill-fail">✗ ${totals.failed} failed</span>`  : ''}
      ${totals.skipped ? `<span class="pill pill-skip">– ${totals.skipped} skipped</span>` : ''}
    </div>
  </header>
  ${ticketsCard}
  <section class="summary-block">
    <div class="summary-block-header">
      <h2>Summary <span class="muted">(copy-paste into ticket/Slack)</span></h2>
      <button class="copy-button" onclick="copyPastableSummary(this)">Copy</button>
    </div>
    <pre id="pastable-summary">${escapeHtml(pastableSummary)}</pre>
  </section>
  ${seedCards}
  ${ticketSections}
  <footer class="report-footer">
    Generated by TANGO custom reporter. Self-contained HTML — embedded screenshots, no external assets.
  </footer>

  <!-- Click-to-zoom modal for screenshots -->
  <div class="lightbox" id="lightbox" onclick="closeLightbox()" role="dialog" aria-label="Screenshot full view">
    <img id="lightbox-img" alt="">
    <span class="lightbox-hint">Click anywhere or press Esc to close</span>
  </div>
  <script>${INLINE_JS}</script>
</body>
</html>`;
  }

  private renderTest(t: TestEntry): string {
    const statusClass = `status-${t.status}`;
    const badgeText = badge(t.status);

    const acHtml = t.ac.length
      ? `<div class="ac-clauses">
           ${t.ac.map((c) => `
             <blockquote class="ac-clause">
               <div class="ac-ref">${escapeHtml(c.ref)}</div>
               <div class="ac-text">${escapeHtml(c.text)}</div>
             </blockquote>`).join('')}
         </div>`
      : `<p class="muted">No AC annotation. Add <code>annotateAc(testInfo, { ticket, ac })</code> in the test.</p>`;

    const stepsHtml = `<ol class="steps">${t.steps.map((s) => `
      <li class="step ${s.ok ? 'step-ok' : 'step-fail'}">
        <span class="step-mark">${s.ok ? '✓' : '✗'}</span>
        <span class="step-title">${escapeHtml(s.title)}</span>
        <span class="step-duration">${formatMs(s.durationMs)}</span>
      </li>`).join('')}</ol>`;

    const screenshotsHtml = renderScreenshots(t);
    const errorHtml = t.error
      ? `<details class="error" open><summary>Failure details</summary>
           <pre><code>${escapeHtml(t.error)}</code></pre>
           ${t.errorLocation ? `<p class="muted">at ${escapeHtml(t.errorLocation)}</p>` : ''}
         </details>`
      : '';
    const reproHtml = (t.status === 'failed' || t.status === 'timedOut')
      ? `<details class="repro" open><summary>Reproduce locally</summary>
           <pre><code>${escapeHtml(t.reproCommands.join('\n'))}</code></pre>
         </details>`
      : '';
    const artifactsHtml = (t.tracePath || t.videoPath)
      ? `<details class="artifacts"><summary>Engineer artifacts</summary>
           <ul>
             ${t.tracePath ? `<li>Trace: <code>${escapeHtml(t.tracePath)}</code> — open with <code>npx playwright show-trace ${escapeHtml(t.tracePath)}</code></li>` : ''}
             ${t.videoPath ? `<li>Video: <code>${escapeHtml(t.videoPath)}</code></li>` : ''}
           </ul>
         </details>`
      : '';

    return `
      <article class="test ${statusClass}">
        <header class="test-header">
          <span class="badge badge-${t.status}">${badgeText}</span>
          <h3 class="test-title">${escapeHtml(t.title)}</h3>
          <span class="test-duration">${formatMs(t.duration)}</span>
        </header>
        <div class="test-meta">
          ${t.persona ? `<div class="meta-row"><span class="meta-label">Persona</span><span class="meta-value">${escapeHtml(t.persona)}</span></div>` : ''}
        </div>
        <h4>Acceptance criteria</h4>
        ${acHtml}
        <h4>Steps executed</h4>
        ${stepsHtml}
        <h4>AC verification</h4>
        ${screenshotsHtml}
        ${errorHtml}
        ${reproHtml}
        ${artifactsHtml}
      </article>`;
  }
}

// --- pastable summary -----------------------------------------------------

interface SummaryInputs {
  entries: TestEntry[];
  runTimestamp: string;
  baseURL: string;
  runDuration: string;
  totals: { passed: number; failed: number; skipped: number };
  allPersonas: string[];
}

function renderPastableSummary(s: SummaryInputs): string {
  const tickets = uniqueOrdered(s.entries.map((e) => e.ticket).filter(Boolean) as string[]);
  const ticketLine = tickets.length === 1
    ? `Ticket:      ${tickets[0]} — ${ticketUrl(tickets[0])}`
    : tickets.length > 1
      ? `Tickets:     ${tickets.join(', ')}`
      : '';
  const personaLine = s.allPersonas.length === 1
    ? `Persona:     ${s.allPersonas[0]}`
    : s.allPersonas.length > 1
      ? `Personas:    ${s.allPersonas.join(' | ')}`
      : '';

  const lines: string[] = [];
  lines.push('TANGO QA REPORT');
  lines.push('================================================================');
  if (ticketLine)  lines.push(ticketLine);
  if (personaLine) lines.push(personaLine);
  lines.push(`Environment: ${s.baseURL || 'unknown'}`);
  lines.push(`Run:         ${s.runTimestamp} (duration: ${s.runDuration})`);
  lines.push('');
  lines.push(`Result: ${s.totals.passed} passed | ${s.totals.failed} failed | ${s.totals.skipped} skipped`);
  lines.push('');
  lines.push(`Test cases (${s.entries.length}):`);
  for (const e of s.entries) {
    const mark = e.status === 'passed'   ? '[PASS]'
              : e.status === 'skipped'  ? '[SKIP]'
              : e.status === 'failed' || e.status === 'timedOut' ? '[FAIL]'
              : `[${String(e.status).toUpperCase()}]`;
    const acRef = e.ac.length ? e.ac.map((c) => c.ref).join(', ') : '(no AC)';
    lines.push(`  ${mark}  ${acRef}`);
    lines.push(`          ${e.title}`);
    if (e.error) {
      const firstLine = e.error.split('\n')[0].slice(0, 140);
      lines.push(`          → ${firstLine}`);
    }
  }
  lines.push('');
  lines.push('================================================================');
  return lines.join('\n');
}

// --- seed manifest ---------------------------------------------------------

function readSeedManifests(): SeedManifest[] {
  const dir = reportOutputDir();
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir)
      .filter((f) => /^seed-manifest.*\.json$/.test(f))
      .sort();   // stable order; tickets typically increment lexicographically
    const out: SeedManifest[] = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        out.push(JSON.parse(raw) as SeedManifest);
      } catch { /* skip malformed manifest */ }
    }
    return out;
  } catch {
    return [];
  }
}

function renderSeedCard(m: SeedManifest): string {
  const scopeRows: string[] = [];
  if (m.scope.product?.name) {
    scopeRows.push(`<div class="seed-row"><span class="seed-label">Product</span><span>${escapeHtml(m.scope.product.name)}${m.scope.product.classification ? ` <span class="muted">(classification: ${escapeHtml(m.scope.product.classification)})</span>` : ''}</span></div>`);
  }
  if (m.scope.vendor?.name) {
    const userEmail = m.scope.vendor.user_email ? ` · user: ${m.scope.vendor.user_email}` : '';
    scopeRows.push(`<div class="seed-row"><span class="seed-label">Vendor</span><span>${escapeHtml(m.scope.vendor.name)} <span class="muted">(role_id=${m.scope.vendor.role_id ?? '?'}${userEmail})</span></span></div>`);
  }
  if (m.scope.facility?.identifier) {
    scopeRows.push(`<div class="seed-row"><span class="seed-label">Facility</span><span>${escapeHtml(m.scope.facility.identifier)} <span class="muted">(id=${m.scope.facility.id})</span></span></div>`);
  }
  if (m.scope.pricing_type) {
    scopeRows.push(`<div class="seed-row"><span class="seed-label">Pricing</span><span>${escapeHtml(m.scope.pricing_type)}${m.scope.base_price ? ` · base price ${escapeHtml(m.scope.base_price)} ${escapeHtml(m.scope.currency || '')}` : ''}</span></div>`);
  }
  if (m.scope.invoice_targets) {
    const it = m.scope.invoice_targets;
    const bits: string[] = [];
    if (it.subcontractor_invoice_id) bits.push(`SubcontractorInvoice id=${it.subcontractor_invoice_id}`);
    if (it.subcontractor_quote_id)   bits.push(`SubcontractorQuote id=${it.subcontractor_quote_id}`);
    if (bits.length) {
      scopeRows.push(`<div class="seed-row"><span class="seed-label">Invoices</span><span class="muted">${escapeHtml(bits.join(' · '))}</span></div>`);
    }
  }

  // Pick column layout based on what columns have meaningful values across
  // the fixtures. Date-driven fixtures (TANGO-3) show date columns; pricing-
  // type-driven fixtures (TANGO-6) show pricing_type and prevent_modification.
  const anyHasDates = m.fixtures.some((f) => f.effective_start_date || f.effective_end_date);
  const anyHasPricingType = m.fixtures.some((f) => f.pricing_type);
  const anyHasPreventMod = m.fixtures.some((f) => f.prevent_price_modification !== undefined);

  const headers = ['ID', 'Baseline pricing', 'Active'];
  if (anyHasPricingType) headers.push('Pricing');
  if (anyHasDates)       headers.push('Effective dates');
  if (anyHasPreventMod)  headers.push('Editable?');
  headers.push('Facility scope');
  headers.push('Why it exists / what it proves');

  const fixtureRows = m.fixtures.map((f) => {
    const cells = [
      `<td class="fixture-id">#${f.id ?? '?'}</td>`,
      `<td class="fixture-name">${escapeHtml(f.name)}</td>`,
      `<td class="fixture-active">${f.active ? '<span class="dot dot-on" title="active"></span>' : '<span class="dot dot-off" title="inactive"></span>'}</td>`,
    ];
    if (anyHasPricingType) {
      const pt = f.pricing_type
        ? `${escapeHtml(f.pricing_type)}${f.base_price ? ` $${escapeHtml(f.base_price)}` : ''}`
        : '<span class="muted">—</span>';
      cells.push(`<td class="fixture-pricing">${pt}</td>`);
    }
    if (anyHasDates) {
      cells.push(`<td class="fixture-dates">${escapeHtml(f.effective_start_date || '')}<br>→ ${escapeHtml(f.effective_end_date || '')}</td>`);
    }
    if (anyHasPreventMod) {
      // prevent_price_modification = true → field LOCKED → not editable
      const editable = f.prevent_price_modification === false;
      cells.push(`<td class="fixture-editable">${editable ? '<span class="dot dot-on" title="editable"></span> editable' : (f.prevent_price_modification === true ? '<span class="dot dot-off" title="locked"></span> locked' : '<span class="muted">—</span>')}</td>`);
    }
    cells.push(`<td class="fixture-facility">${f.facility_id != null ? `facility=${f.facility_id}` : '<span class="muted">any</span>'}</td>`);
    cells.push(`<td class="fixture-purpose">${escapeHtml(f.purpose || '')}</td>`);
    return `<tr class="${f.active ? '' : 'fixture-inactive'}">${cells.join('')}</tr>`;
  }).join('');

  const ticketTag = m.ticket ? `<span class="seed-ticket">${escapeHtml(m.ticket)}</span> ` : '';
  return `<section class="seed-card">
    <h2>${ticketTag}Test setup <span class="muted">(seed: ${escapeHtml(m.source_seed)} · ${escapeHtml(m.generated_at)})</span></h2>
    <p class="muted seed-description">${escapeHtml(m.description)}</p>
    <div class="seed-scope">
      ${scopeRows.join('')}
    </div>
    <table class="seed-fixtures">
      <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${fixtureRows}</tbody>
    </table>
  </section>`;
}

// --- helpers ---------------------------------------------------------------

function parseAcAnnotation(raw: string | undefined): AcClause[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    // Backwards-compat: treat as a single free-text clause.
    return [{ ref: '', text: raw }];
  }
}

function collectStepEntries(steps: TestStep[]): StepEntry[] {
  const out: StepEntry[] = [];
  const walk = (s: TestStep[]) => {
    for (const step of s) {
      if (step.category === 'test.step') {
        out.push({
          title: step.title,
          ok: !step.error,
          durationMs: step.duration ?? 0,
        });
      }
      if (step.steps?.length) walk(step.steps);
    }
  };
  walk(steps);
  return out;
}

function buildReproCommands(test: TestCase): string[] {
  return [
    '# Make sure Rails is in fast mode (production-built Sencha bundle):',
    'npm run fexa:fast-mode',
    '',
    '# Reset baseline fixtures so the DB matches the seed:',
    'npm run seed:pricing-overlap',
    '',
    '# Run just this scenario:',
    `npx playwright test --grep ${JSON.stringify(test.title)}`,
  ];
}

function summarize(entries: TestEntry[]) {
  let passed = 0, failed = 0, skipped = 0;
  for (const e of entries) {
    if (e.status === 'passed') passed++;
    else if (e.status === 'skipped') skipped++;
    else failed++;
  }
  return { passed, failed, skipped };
}

function groupByTicket(entries: TestEntry[]): Record<string, TestEntry[]> {
  const groups: Record<string, TestEntry[]> = {};
  for (const e of entries) {
    const key = e.ticket || '__no-ticket__';
    (groups[key] ||= []).push(e);
  }
  return groups;
}

function toDataUri(filePath: string, contentType: string): string {
  try {
    const buf = fs.readFileSync(filePath);
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

function readSnippet(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8').slice(0, 500); } catch { return ''; }
}

function renderScreenshots(t: TestEntry): string {
  const hasAnything = t.beforeImg || t.afterImg
    || t.beforeSteps.length || t.afterSteps.length
    || t.beforeNote || t.afterNote;
  if (!hasAnything) {
    return `<p class="muted">No AC verification screenshots captured. Add <code>captureAcSnapshot(testInfo, page, 'before' | 'after')</code> in the test.</p>`;
  }

  const figure = (caption: string, img: string) => `<figure>
    <figcaption>${escapeHtml(caption)}</figcaption>
    <a href="${img}" target="_blank" rel="noopener" class="screenshot-link" onclick="return openLightbox(this.href)">
      <img loading="lazy" src="${img}" alt="${escapeAttr(caption)}" class="screenshot-img">
    </a>
  </figure>`;

  const errorFigure = (caption: string, note: string) => `<figure class="missing">
    <figcaption>${escapeHtml(caption)} — not captured</figcaption>
    <pre class="note">${escapeHtml(note)}</pre>
  </figure>`;

  // For each moment, prefer labeled steps when present; otherwise fall back
  // to the legacy single-snapshot path. If both are present (unusual but
  // valid), render the labeled sequence first, then the legacy one as a
  // trailing "final" capture — so we never silently drop captured data.
  const renderMomentSection = (
    moment: 'Before' | 'After',
    steps: SnapshotStep[],
    legacyImg: string | undefined,
    note: string | undefined,
  ): string => {
    const figures: string[] = [];
    if (steps.length) {
      // Numbered captions: "Before · 1. Form opened"
      const total = steps.length;
      steps.forEach((s, i) => {
        const ordinal = total > 1 ? `${i + 1}. ` : '';
        figures.push(figure(`${moment} · ${ordinal}${s.label}`, s.img));
      });
      if (legacyImg) {
        figures.push(figure(`${moment} · final`, legacyImg));
      }
    } else if (legacyImg) {
      figures.push(figure(moment, legacyImg));
    } else if (note) {
      figures.push(errorFigure(moment, note));
    }

    if (!figures.length) return '';
    return `<section class="screenshots-moment screenshots-moment-${moment.toLowerCase()}">
      <h5 class="screenshots-heading">${moment}</h5>
      <div class="screenshots-grid">${figures.join('')}</div>
    </section>`;
  };

  const beforeSection = renderMomentSection('Before', t.beforeSteps, t.beforeImg, t.beforeNote);
  const afterSection  = renderMomentSection('After',  t.afterSteps,  t.afterImg,  t.afterNote);

  return `<div class="screenshots">${beforeSection}${afterSection}</div>`;
}

function badge(status: TestResult['status']): string {
  switch (status) {
    case 'passed':      return 'PASS';
    case 'failed':      return 'FAIL';
    case 'timedOut':    return 'TIMEOUT';
    case 'skipped':     return 'SKIP';
    case 'interrupted': return 'INTERRUPTED';
    default:            return String(status).toUpperCase();
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60), rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string { return escapeHtml(s); }

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function uniqueOrdered<T>(arr: T[]): T[] {
  const seen = new Set<T>(); const out: T[] = [];
  for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

// --- inline JS for clickable screenshots + copy summary -------------------

const INLINE_JS = `
function openLightbox(src) {
  var box = document.getElementById('lightbox');
  document.getElementById('lightbox-img').src = src;
  box.classList.add('open');
  return false; // prevent the anchor's new-tab navigation
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
}
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeLightbox();
});
function copyPastableSummary(btn) {
  var text = document.getElementById('pastable-summary').textContent;
  navigator.clipboard.writeText(text).then(function() {
    var original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function(){ btn.textContent = original; }, 1500);
  }).catch(function() {
    btn.textContent = 'Copy failed';
  });
}
`;

// --- CSS -------------------------------------------------------------------

const CSS = `
  :root {
    --green: #22c55e;
    --green-bg: #0e2a1a;
    --red: #ef4444;
    --red-bg: #2a1414;
    --gray: #94a3b8;
    --gray-bg: #1e293b;
    --yellow: #f59e0b;
    --yellow-bg: #2a2310;
    --blue: #3b82f6;
    --border: #334155;
    --code-bg: #0b1220;
    --bg: #0f172a;
    --surface: #1e293b;
    --surface-2: #0b1220;
    --text: #e2e8f0;
    --text-muted: #94a3b8;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, sans-serif;
    color: var(--text);
    background: var(--bg);
    margin: 0;
    line-height: 1.5;
  }
  .report-header {
    background: var(--surface);
    padding: 24px 32px 20px;
    border-bottom: 1px solid var(--border);
  }
  .report-header h1 { margin: 0 0 12px; font-size: 22px; }
  .run-meta {
    display: flex; gap: 24px; flex-wrap: wrap;
    margin: 0 0 14px;
    font-size: 13px; color: var(--gray);
  }
  .totals { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill {
    display: inline-block; padding: 4px 12px; border-radius: 999px;
    font-size: 13px; font-weight: 600;
  }
  .pill-pass { background: var(--green-bg); color: var(--green); }
  .pill-fail { background: var(--red-bg);   color: var(--red); }
  .pill-skip { background: var(--gray-bg);  color: var(--gray); }
  .tickets-card {
    max-width: 1100px; margin: 20px auto 0; padding: 0 32px;
  }
  .tickets-card h2 {
    margin: 0 0 10px; font-size: 15px;
  }
  .tickets-list {
    margin: 0; padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    list-style: none;
  }
  .tickets-list li {
    display: flex; gap: 16px; align-items: baseline;
    padding: 4px 0;
    font-size: 14px;
  }
  .tickets-list li strong {
    color: var(--blue); font-weight: 700; min-width: 100px;
  }
  .tickets-list .ticket-link {
    color: var(--gray); margin-left: 0; font-size: 13px;
    word-break: break-all;
  }
  .summary-block {
    max-width: 1100px; margin: 20px auto; padding: 0 32px;
  }
  .seed-card {
    max-width: 1100px; margin: 20px auto; padding: 0 32px;
  }
  .seed-card h2 { margin: 0 0 6px; font-size: 15px; }
  .seed-card h2 .muted { font-weight: normal; font-size: 12px; }
  .seed-description { margin: 0 0 12px; }
  .seed-scope {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px 14px; margin-bottom: 10px;
  }
  .seed-row { padding: 3px 0; font-size: 13px; display: flex; gap: 12px; }
  .seed-label {
    min-width: 90px; font-weight: 600; color: var(--text); flex-shrink: 0;
  }
  table.seed-fixtures {
    width: 100%; border-collapse: collapse;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    overflow: hidden; font-size: 12.5px;
  }
  table.seed-fixtures th {
    text-align: left; padding: 8px 10px;
    background: var(--surface-2); border-bottom: 1px solid var(--border);
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--gray); font-weight: 700;
  }
  table.seed-fixtures td {
    padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top;
  }
  table.seed-fixtures tbody tr:last-child td { border-bottom: none; }
  .fixture-id { font-family: ui-monospace, Menlo, monospace; color: var(--gray); white-space: nowrap; }
  .fixture-name { font-weight: 600; }
  .fixture-active { text-align: center; }
  .fixture-dates { font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
  .fixture-facility { white-space: nowrap; }
  .fixture-purpose { color: var(--text); max-width: 380px; }
  .fixture-pricing { white-space: nowrap; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .fixture-editable { white-space: nowrap; }
  .fixture-inactive .fixture-name { color: var(--gray); }
  .seed-ticket {
    display: inline-block; padding: 1px 8px; border-radius: 3px;
    background: var(--blue); color: white;
    font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
    margin-right: 8px; vertical-align: middle;
  }
  .dot {
    display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  }
  .dot-on  { background: var(--green); }
  .dot-off { background: var(--red); }
  .summary-block-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 8px;
  }
  .summary-block-header h2 { margin: 0; font-size: 15px; }
  .summary-block-header .muted { font-weight: normal; font-size: 12px; }
  .copy-button {
    background: var(--blue); color: white; border: 0;
    padding: 6px 14px; border-radius: 4px;
    font-size: 12px; font-weight: 600;
    cursor: pointer;
  }
  .copy-button:hover { opacity: 0.9; }
  .summary-block pre {
    background: #1f2429; color: #e6e6e6; padding: 16px 20px;
    border-radius: 6px; overflow-x: auto;
    font-size: 12.5px; line-height: 1.55;
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .ticket-group {
    max-width: 1100px; margin: 24px auto; padding: 0 32px;
  }
  .ticket-title {
    font-size: 16px; margin: 28px 0 12px; padding-bottom: 8px;
    border-bottom: 2px solid var(--border);
  }
  .ticket-link {
    margin-left: 12px; font-size: 13px; color: var(--blue); text-decoration: none; font-weight: normal;
  }
  .ticket-link:hover { text-decoration: underline; }
  .test {
    background: var(--surface); border: 1px solid var(--border);
    border-left-width: 4px; border-radius: 6px;
    padding: 16px 20px; margin-bottom: 16px;
  }
  .test.status-passed { border-left-color: var(--green); }
  .test.status-failed, .test.status-timedOut, .test.status-interrupted { border-left-color: var(--red); }
  .test.status-skipped { border-left-color: var(--gray); }
  .test-header {
    display: flex; align-items: center; gap: 12px;
  }
  .test-title { margin: 0; font-size: 15px; flex: 1; }
  .test-duration { font-size: 12px; color: var(--gray); }
  .badge {
    font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.05em;
  }
  .badge-passed      { background: var(--green-bg); color: var(--green); }
  .badge-failed,
  .badge-timedOut,
  .badge-interrupted { background: var(--red-bg);   color: var(--red); }
  .badge-skipped     { background: var(--gray-bg);  color: var(--gray); }
  .test-meta {
    margin: 12px 0;
    font-size: 13px; color: var(--gray);
  }
  .meta-row { padding: 2px 0; }
  .meta-label {
    display: inline-block; min-width: 90px; font-weight: 600;
    color: var(--text);
  }
  .meta-value { display: inline; }
  .test h4 {
    margin: 18px 0 8px; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--gray);
  }
  .ac-clauses { margin: 0; }
  .ac-clause {
    margin: 0 0 10px; padding: 10px 14px;
    border-left: 3px solid var(--blue);
    background: #122033;
    border-radius: 0 4px 4px 0;
  }
  .ac-ref { font-size: 11px; font-weight: 700; color: var(--blue); letter-spacing: 0.05em; margin-bottom: 4px; }
  .ac-text { font-size: 13px; color: var(--text); white-space: pre-wrap; }
  ol.steps { margin: 0; padding: 0; list-style: none; }
  .step {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 6px 0;
    font-size: 13px;
    border-bottom: 1px dashed var(--border);
  }
  .step:last-child { border-bottom: none; }
  .step-mark { width: 14px; font-weight: 700; flex-shrink: 0; }
  .step-ok .step-mark { color: var(--green); }
  .step-fail .step-mark { color: var(--red); }
  .step-title { flex: 1; word-break: break-word; }
  .step-duration { font-size: 11px; color: var(--gray); flex-shrink: 0; }
  .screenshots {
    display: flex; flex-direction: column; gap: 18px;
    margin: 8px 0;
  }
  .screenshots-moment {
    display: flex; flex-direction: column; gap: 8px;
  }
  .screenshots-heading {
    margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--gray);
    padding: 4px 0 6px;
    border-bottom: 1px solid var(--border);
  }
  .screenshots-moment-before .screenshots-heading { color: var(--blue); border-bottom-color: var(--blue); }
  .screenshots-moment-after  .screenshots-heading { color: var(--green); border-bottom-color: var(--green); }
  .screenshots-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 12px;
  }
  .screenshots figure {
    margin: 0; padding: 8px; background: var(--gray-bg);
    border: 1px solid var(--border); border-radius: 4px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .screenshots figcaption {
    font-size: 12px; font-weight: 600;
    color: var(--text);
    line-height: 1.35;
  }
  .screenshot-link {
    display: block;
    text-decoration: none;
  }
  .screenshot-img {
    width: 100%; height: auto; border-radius: 2px; display: block;
    cursor: zoom-in;
    transition: opacity 0.15s;
  }
  .screenshot-img:hover { opacity: 0.92; }
  .screenshots .missing { background: var(--yellow-bg); }
  .note { font-size: 12px; color: var(--yellow); margin: 0; white-space: pre-wrap; }
  .muted { color: var(--gray); font-size: 13px; }
  details.error, details.repro, details.artifacts {
    margin: 12px 0; padding: 10px 12px;
    background: var(--code-bg); border-radius: 4px;
  }
  details.error  { background: var(--red-bg); }
  details.repro  { background: var(--yellow-bg); }
  details summary {
    cursor: pointer; font-weight: 600; font-size: 13px;
  }
  details pre {
    margin: 10px 0 0; padding: 10px; background: var(--surface); border-radius: 4px;
    font-size: 12px; overflow-x: auto;
  }
  details code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  details ul { margin: 8px 0 0; padding-left: 20px; font-size: 13px; }
  .report-footer {
    max-width: 1100px; margin: 40px auto; padding: 20px 32px;
    color: var(--gray); font-size: 12px; text-align: center;
  }

  /* Lightbox */
  .lightbox {
    display: none;
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.92);
    z-index: 1000;
    align-items: center; justify-content: center;
    cursor: zoom-out;
    padding: 20px;
    flex-direction: column; gap: 12px;
  }
  .lightbox.open { display: flex; }
  .lightbox img {
    max-width: 96vw; max-height: 90vh;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
  }
  .lightbox-hint {
    color: #ccc; font-size: 12px;
  }
`;

export default QaReporter;
