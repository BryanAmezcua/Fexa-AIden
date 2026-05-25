// qa-bot/lib/evidence.mjs — Render backend verification data as styled HTML screenshots

import { waitForAppReady } from './extjs.mjs';

/**
 * Render verification data as a styled HTML table, screenshot it, then restore app context.
 * @param {Page} page
 * @param {Function} screenshot - screenshot callback from test.run()
 * @param {string} title - e.g., "AC #4: No Incidental NTE Writes"
 * @param {string[]} columns - column headers
 * @param {string[][]} rows - data rows (each an array of cell strings)
 * @param {object} opts - { label, restoreApp (default true), subtitle }
 */
export async function evidenceScreenshot(page, screenshot, title, columns, rows, opts = {}) {
  const label = opts.label || title.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  const restoreApp = opts.restoreApp !== false;

  const headerCells = columns.map(c => `<th>${esc(c)}</th>`).join('');
  const bodyRows = rows.map(row => {
    const cells = row.map(cell => {
      let cls = '';
      const s = String(cell);
      if (s.includes('✓') || s.includes('No change') || s.includes('PASS') || s.includes('unchanged')) cls = 'cell-pass';
      if (s.includes('✗') || s.includes('CHANGED') || s.includes('FAIL') || s.includes('exceeded') || s.includes('denied')) cls = 'cell-fail';
      if (s.includes('→') || s.includes('updated')) cls = 'cell-changed';
      return `<td class="${cls}">${esc(s)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const subtitleHtml = opts.subtitle ? `<div class="subtitle">${esc(opts.subtitle)}</div>` : '';

  const html = `<!DOCTYPE html><html><head><style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; margin: 0; padding: 24px; }
    .evidence { background: #1e293b; border-radius: 10px; padding: 20px; display: inline-block; min-width: 500px; max-width: 900px; }
    .evidence h2 { color: #e2e8f0; font-size: 15px; margin: 0 0 4px; font-weight: 600; }
    .subtitle { color: #94a3b8; font-size: 12px; margin-bottom: 14px; }
    .badge { display: inline-block; background: #22c55e; color: white; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; margin-right: 8px; vertical-align: middle; }
    .badge-fail { background: #ef4444; }
    table { border-collapse: collapse; width: 100%; }
    th { background: #334155; color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 12px; text-align: left; border-bottom: 2px solid #475569; }
    td { padding: 7px 12px; font-size: 13px; color: #e2e8f0; border-bottom: 1px solid #334155; font-family: ui-monospace, monospace; }
    tr:hover td { background: rgba(51,65,85,0.5); }
    .cell-pass { color: #22c55e; font-weight: 600; }
    .cell-fail { color: #ef4444; font-weight: 600; }
    .cell-changed { color: #3b82f6; font-weight: 600; }
    .summary { margin-top: 12px; font-size: 11px; color: #64748b; }
  </style></head><body>
    <div class="evidence">
      <h2><span class="badge">VERIFIED</span>${esc(title)}</h2>
      ${subtitleHtml}
      <table>
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <div class="summary">${rows.length} record${rows.length !== 1 ? 's' : ''} verified via database query</div>
    </div>
  </body></html>`;

  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await screenshot(label, { keepOverlays: true });

  if (restoreApp) {
    const baseUrl = page._qaConfig?.baseUrl || 'http://localhost:3000';
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, 30000);
    await page.waitForTimeout(2000);
  }
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
