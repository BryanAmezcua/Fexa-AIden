// qa-bot/lib/report.mjs — Generate self-contained HTML QA report
// Dark theme (Bryan's style) + structural improvements (step checkmarks, figure/figcaption screenshots)

import { readFileSync, writeFileSync } from 'fs';
import { toBase64 } from './screenshots.mjs';

export function generateReport({ ticketKey, ticketSummary, tester, branch, environment, baseUrl, testCases, screenshotDir, outputPath, fixtures, suiteDurationMs }) {
  const date = new Date().toISOString().split('T')[0];

  const totalTests = testCases.length;
  const passed = testCases.filter(t => t.status === 'pass').length;
  const failed = testCases.filter(t => t.status === 'fail').length;
  const skipped = testCases.filter(t => t.status === 'skip').length;

  const testCaseHtml = testCases.map(tc => {
    const statusClass = tc.status;
    const mark = tc.status === 'pass' ? '✓' : tc.status === 'fail' ? '✗' : '—';
    const stepClass = tc.status === 'pass' ? 'step-ok' : tc.status === 'fail' ? 'step-fail' : '';

    const durBadge = tc.durationMs ? `<span class="dur-badge">${(tc.durationMs / 1000).toFixed(1)}s</span>` : '';

    const stepsHtml = (tc.steps || []).map(s => {
      const text = typeof s === 'string' ? s : s.text;
      const dur = typeof s === 'object' && s.durationMs != null
        ? `<span class="step-dur">${(s.durationMs / 1000).toFixed(1)}s</span>` : '';
      return `
          <li class="step ${stepClass}">
            <span class="step-mark">${mark}</span>
            <span class="step-title">${esc(text)}</span>
            ${dur}
          </li>`;
    }).join('');

    const screenshotsHtml = (tc.screenshots || []).map(s => {
      let imgSrc = '';
      try { imgSrc = toBase64(s.path); } catch (e) {}
      return `
          <figure>
            <figcaption>${esc(s.label)}</figcaption>
            ${imgSrc ? `<a class="screenshot-link"><img class="screenshot-img" src="${imgSrc}" alt="${esc(s.label)}"></a>` : '<p class="missing">Screenshot not captured</p>'}
          </figure>`;
    }).join('');

    const errorHtml = tc.error ? `
        <details class="error" open>
          <summary>Error details</summary>
          <pre>${esc(tc.error)}</pre>
        </details>` : '';

    return `
      <div class="test-case ${statusClass}">
        <div class="test-case-header" onclick="this.parentElement.classList.toggle('open')">
          <div class="test-case-title">
            ${(Array.isArray(tc.ac) ? tc.ac : [tc.ac]).map(n => `<span class="ac-badge">AC #${n}</span>`).join(' ')}
            ${esc(tc.name)}
          </div>
          ${durBadge}
          <span class="status-badge ${statusClass}">${tc.status.toUpperCase()}</span>
        </div>
        <div class="test-case-body">
          <blockquote>${esc(tc.criteria)}</blockquote>
          ${stepsHtml ? `<h4>Steps</h4><ol class="steps">${stepsHtml}</ol>` : ''}
          ${errorHtml}
          ${tc.notes ? `<h4>Notes</h4><p class="note-text">${esc(tc.notes)}</p>` : ''}
          ${screenshotsHtml ? `<h4>Evidence</h4><div class="screenshots">${screenshotsHtml}</div>` : ''}
        </div>
      </div>`;
  }).join('\n');

  const summaryRows = testCases.map(tc => {
    const acDisplay = Array.isArray(tc.ac) ? tc.ac.join(', ') : tc.ac;
    const dur = tc.durationMs ? `${(tc.durationMs / 1000).toFixed(1)}s` : '';
    return `<tr><td>${acDisplay}</td><td>${esc(tc.name)}</td><td>${dur}</td><td><span class="status-badge ${tc.status}">${tc.status.toUpperCase()}</span></td></tr>`;
  }).join('');

  // Fixtures table
  const fixturesHtml = (fixtures && fixtures.length) ? `
  <div style="margin-bottom:2rem;">
    <h3 style="font-size:1rem;margin-bottom:0.75rem;">Test Data / Fixtures</h3>
    <table class="summary-table">
      <thead><tr><th>ID</th><th>Name</th><th>Active</th><th>Purpose</th></tr></thead>
      <tbody>${fixtures.map(f => `<tr>
        <td><code style="background:var(--surface2);padding:2px 6px;border-radius:3px;font-size:0.8rem;">${esc(String(f.id))}</code></td>
        <td style="font-weight:600;">${esc(f.name)}</td>
        <td>${f.active ? '<span style="color:var(--pass);">Yes</span>' : '<span style="color:var(--text-muted);">No</span>'}</td>
        <td>${esc(f.purpose)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>` : '';

  // Copy-pasteable summary for Jira/Slack
  const totalDur = suiteDurationMs ? `${Math.floor(suiteDurationMs / 60000)}m ${Math.floor((suiteDurationMs % 60000) / 1000)}s` : '';
  const summaryText = [
    `QA Report: ${ticketKey} — ${ticketSummary}`,
    `Tester: ${tester} | Date: ${date} | Branch: ${branch}`,
    `Environment: ${environment} | Base URL: ${baseUrl}`,
    totalDur ? `Duration: ${totalDur}` : '',
    '',
    `Result: ${passed} passed | ${failed} failed | ${skipped} skipped`,
    '',
    ...testCases.map(tc => {
      const acLabel = Array.isArray(tc.ac) ? tc.ac.map(n => `#${n}`).join(', ') : `#${tc.ac}`;
      const icon = tc.status === 'pass' ? '[PASS]' : tc.status === 'fail' ? '[FAIL]' : '[SKIP]';
      return `  ${icon}  AC ${acLabel} — ${tc.name}`;
    }),
  ].filter(Boolean).join('\n');

  const copyBlockHtml = `
  <div style="background:var(--surface);border-radius:10px;padding:1.25rem;margin-top:2rem;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
      <h3 style="font-size:1rem;margin:0;">Jira / Slack Summary</h3>
      <button onclick="navigator.clipboard.writeText(document.getElementById('jira-summary').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)})" style="background:var(--accent);color:white;border:none;padding:0.4rem 1rem;border-radius:6px;cursor:pointer;font-size:0.85rem;font-weight:600;">Copy</button>
    </div>
    <pre id="jira-summary" style="background:var(--bg);padding:1rem;border-radius:6px;font-size:0.8rem;line-height:1.6;overflow-x:auto;white-space:pre-wrap;color:var(--text-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(summaryText)}</pre>
  </div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QA Report — ${esc(ticketKey)}</title>
<style>
  :root {
    --pass: #22c55e; --fail: #ef4444; --skip: #f59e0b;
    --bg: #0f172a; --surface: #1e293b; --surface2: #334155;
    --text: #e2e8f0; --text-muted: #94a3b8; --border: #475569; --accent: #3b82f6;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem; }
  .report { max-width: 960px; margin: 0 auto; }
  .report-header { border-bottom: 2px solid var(--accent); padding-bottom: 1.5rem; margin-bottom: 2rem; }
  .report-header h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
  .report-header .subtitle { color: var(--text-muted); font-size: 0.95rem; }
  .report-header a { color: var(--accent); text-decoration: none; font-size: 0.85rem; margin-left: 8px; }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
  .meta-item { background: var(--surface); border-radius: 8px; padding: 0.75rem 1rem; }
  .meta-item .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
  .meta-item .value { font-weight: 600; font-size: 0.95rem; }
  .meta-item a { color: var(--accent); text-decoration: none; }
  .summary-bar { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .summary-stat { background: var(--surface); border-radius: 8px; padding: 1rem 1.5rem; text-align: center; min-width: 120px; flex: 1; }
  .summary-stat .count { font-size: 2rem; font-weight: 700; }
  .summary-stat .count.pass { color: var(--pass); } .summary-stat .count.fail { color: var(--fail); } .summary-stat .count.skip { color: var(--skip); }
  .summary-stat .stat-label { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .controls { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  .controls button { background: var(--surface); color: var(--text); border: 1px solid var(--border); padding: 0.4rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  .controls button:hover { background: var(--surface2); }
  .test-case { background: var(--surface); border-radius: 10px; margin-bottom: 1.5rem; overflow: hidden; border-left: 4px solid var(--pass); }
  .test-case.fail { border-left-color: var(--fail); } .test-case.skip { border-left-color: var(--skip); }
  .test-case-header { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; cursor: pointer; user-select: none; }
  .test-case-header:hover { background: var(--surface2); }
  .test-case-title { font-weight: 600; font-size: 1rem; display: flex; align-items: center; gap: 0.75rem; }
  .ac-badge { background: var(--accent); color: white; font-size: 0.7rem; font-weight: 700; padding: 0.2rem 0.5rem; border-radius: 4px; white-space: nowrap; }
  .status-badge { font-size: 0.75rem; font-weight: 700; padding: 0.25rem 0.75rem; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.05em; }
  .status-badge.pass { background: rgba(34,197,94,0.15); color: var(--pass); }
  .status-badge.fail { background: rgba(239,68,68,0.15); color: var(--fail); }
  .status-badge.skip { background: rgba(245,158,11,0.15); color: var(--skip); }
  .test-case-body { padding: 0 1.25rem 1.25rem; display: none; }
  .test-case.open .test-case-body { display: block; }
  .test-case-body blockquote { background: var(--surface2); border-left: 3px solid var(--accent); padding: 0.75rem 1rem; margin-bottom: 1rem; border-radius: 0 6px 6px 0; font-size: 0.9rem; color: var(--text-muted); font-style: italic; }
  .test-case-body h4 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin: 1.25rem 0 0.5rem; }
  ol.steps { margin: 0; padding: 0; list-style: none; }
  .step { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; font-size: 0.9rem; border-bottom: 1px dashed var(--surface2); }
  .step:last-child { border-bottom: none; }
  .step-mark { width: 16px; font-weight: 700; flex-shrink: 0; font-size: 1rem; }
  .step-ok .step-mark { color: var(--pass); }
  .step-fail .step-mark { color: var(--fail); }
  .step-title { flex: 1; word-break: break-word; }
  .step-dur { font-size: 0.7rem; color: var(--text-muted); margin-left: auto; font-family: monospace; flex-shrink: 0; }
  .dur-badge { font-size: 0.7rem; color: var(--text-muted); margin-right: 0.5rem; font-family: monospace; background: var(--surface2); padding: 2px 8px; border-radius: 4px; }
  .screenshots { display: flex; flex-direction: column; gap: 12px; margin: 8px 0; }
  .screenshots figure { margin: 0; padding: 10px; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; }
  .screenshots figcaption { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; letter-spacing: 0.05em; }
  .screenshot-link { display: block; text-decoration: none; }
  .screenshot-img { width: 100%; height: auto; border-radius: 4px; display: block; cursor: zoom-in; transition: opacity 0.15s; }
  .screenshot-img:hover { opacity: 0.9; }
  .screenshots .missing { background: var(--surface); padding: 12px; font-size: 0.85rem; color: var(--skip); border-radius: 4px; }
  details.error { margin: 12px 0; padding: 10px 12px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 6px; }
  details.error summary { font-weight: 600; cursor: pointer; color: var(--fail); font-size: 0.85rem; }
  details.error pre { margin: 8px 0 0; padding: 10px; background: #0f172a; color: #f87171; border-radius: 4px; overflow-x: auto; font-size: 0.8rem; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .note-text { font-size: 0.9rem; color: var(--text-muted); }
  .summary-table { width: 100%; border-collapse: collapse; margin-top: 2rem; }
  .summary-table th, .summary-table td { padding: 0.6rem 1rem; text-align: left; border-bottom: 1px solid var(--surface2); font-size: 0.9rem; }
  .summary-table th { color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; background: var(--surface); }
  .summary-table tr:hover td { background: var(--surface); }
  @media print { body { background: white; color: black; } .test-case-body { display: block !important; } .controls { display: none; } }
</style>
</head>
<body>
<div class="report">
  <div class="report-header">
    <h1>${esc(ticketKey)}: ${esc(ticketSummary)}
      <a href="https://facilitiesexchange.atlassian.net/browse/${esc(ticketKey)}" target="_blank">${esc(ticketKey)} &#8599;</a>
    </h1>
    <div class="subtitle">QA Test Report — Automated Verification of Acceptance Criteria</div>
    <div class="meta-grid">
      <div class="meta-item"><div class="label">Tester</div><div class="value">${esc(tester)}</div></div>
      <div class="meta-item"><div class="label">Date</div><div class="value">${date}</div></div>
      <div class="meta-item"><div class="label">Branch</div><div class="value">${esc(branch)}</div></div>
      <div class="meta-item"><div class="label">Environment</div><div class="value">${esc(environment)}</div></div>
      <div class="meta-item"><div class="label">Base URL</div><div class="value">${esc(baseUrl)}</div></div>
    </div>
  </div>
  <div class="summary-bar">
    <div class="summary-stat"><div class="count" style="color:var(--text);">${totalTests}</div><div class="stat-label">Total</div></div>
    <div class="summary-stat"><div class="count pass">${passed}</div><div class="stat-label">Passed</div></div>
    <div class="summary-stat"><div class="count fail">${failed}</div><div class="stat-label">Failed</div></div>
    ${skipped > 0 ? `<div class="summary-stat"><div class="count skip">${skipped}</div><div class="stat-label">Skipped</div></div>` : ''}
  </div>
  <div class="controls">
    <button onclick="toggleAll(true)">Expand All</button>
    <button onclick="toggleAll(false)">Collapse All</button>
  </div>
  ${fixturesHtml}
  ${testCaseHtml}
  <h2 style="margin-top:2.5rem;margin-bottom:1rem;font-size:1.25rem;">Summary</h2>
  <table class="summary-table">
    <thead><tr><th>AC #</th><th>Description</th><th>Duration</th><th>Result</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>
  ${copyBlockHtml}
</div>
<script>function toggleAll(o){document.querySelectorAll('.test-case').forEach(t=>t.classList.toggle('open',o))}</script>
</body>
</html>`;

  writeFileSync(outputPath, html, 'utf8');
  console.log(`\nReport written to: ${outputPath}`);
  return outputPath;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
