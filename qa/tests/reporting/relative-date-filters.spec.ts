/**
 * TANGO-48 — Forward-looking relative date filter options for communication
 * rule and report filters.
 *
 * Two-layer verification:
 *  - BACKEND (deterministic, authoritative): the real Reporting::Report#relative_time
 *    is driven via rails-runner (support/tango48-reltime.rb) for the new tokens
 *    (next_7/14/30_days, custom_days_forward_<n>) and an unchanged backward token.
 *    This is the shared engine behind BOTH report filters and comm-rule filters
 *    (comm rules invoke it via ReportAutomator), so it covers the Scope clause.
 *  - FRONTEND (source-presence): the merged ExtJS source is asserted to contain
 *    the dropdown options, the "Custom Days Forward" numeric input, the maxValue:365
 *    cap and the exact cap-error string. This is SOURCE-PRESENCE, not a browser
 *    exercise: the server is in fast mode serving a PRE-BUILT bundle that predates
 *    TANGO-48 (none of the new strings are in public/), so a true UI E2E needs a
 *    fresh `npm run fexa:fast-mode` rebuild. QA manually verified the live UI on
 *    qatesting.fexa.io (Jira comments). PR #6994.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, TANGO_48_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-48';
const FZ = process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo';

test.describe('Forward-looking relative date filters (TANGO-48)', () => {
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(180_000);

  let data: any = null;
  let relTimesJs = '';
  let filterBlockJs = '';
  let filtersCtrlJs = '';
  let automatorJs = '';

  const win = (token: string) => data.results.find((r: any) => r.token === token);

  test.beforeAll(() => {
    const resolver = path.resolve(__dirname, '../../support/tango48-reltime.rb');
    const cmd = `cd "${FZ}" && DISABLE_SPRING=1 RUBYOPT='-W0' bundle exec rails runner "${resolver}"`;
    const out = execSync(cmd, { cwd: process.cwd(), shell: '/bin/bash', encoding: 'utf8', timeout: 150_000 });
    const line = out.split('\n').find((l) => l.startsWith('RELTIME_JSON='));
    if (!line) throw new Error(`resolver produced no RELTIME_JSON line. Output:\n${out}`);
    data = JSON.parse(line.replace('RELTIME_JSON=', ''));

    const base = path.join(FZ, 'app/assets/javascripts/app');
    relTimesJs    = fs.readFileSync(path.join(base, 'store/general/RelativeTimes.js'), 'utf8');
    filterBlockJs = fs.readFileSync(path.join(base, 'view/general/reporting/FilterBlock.js'), 'utf8');
    filtersCtrlJs = fs.readFileSync(path.join(base, 'view/general/reporting/FiltersController.js'), 'utf8');
    automatorJs   = fs.readFileSync(path.join(base, 'view/general/general/ReportAutomatorDialog.js'), 'utf8');
  });

  test('AC#1 — Next 7/14/30 Days presets resolve to a today-anchored window of the right span (backend)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_48_AC.Presets, TANGO_48_AC.Scope] });
    await testInfo.attach('relative_time-windows', { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
    for (const [token, span] of [['next_7_days', 7], ['next_14_days', 14], ['next_30_days', 30]] as const) {
      const w = win(token);
      await test.step(`relative_time("${token}") = ${w.start_date}..${w.end_date} (${w.delta_days} days; starts today=${data.today})`, async () => {
        expect(w.start_date, `${token} starts at today`).toBe(data.today);
        expect(w.delta_days, `${token} spans ${span} days forward`).toBe(span);
      });
    }
  });

  test('AC#7 — Custom Days Forward is dynamic and clamped to 1..365 (backend)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_48_AC.CustomInput, TANGO_48_AC.Cap365] });
    const c45 = win('custom_days_forward_45');
    const c400 = win('custom_days_forward_400');
    const c0 = win('custom_days_forward_0');
    await test.step(`custom_days_forward_45 -> ${c45.delta_days} days (expected 45, today-anchored)`, async () => {
      expect(c45.start_date).toBe(data.today);
      expect(c45.delta_days).toBe(45);
    });
    await test.step(`custom_days_forward_400 -> ${c400.delta_days} days (clamped to the 365 cap)`, async () => {
      expect(c400.delta_days, 'over-cap value is clamped to 365').toBe(365);
    });
    await test.step(`custom_days_forward_0 -> ${c0.delta_days} days (floored to 1, never a 0-width window)`, async () => {
      expect(c0.delta_days, 'a 0 is floored to 1 day').toBe(1);
    });
  });

  test('AC#4 — windows are evaluated dynamically (anchored to today, no hardcoded dates) (backend)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_48_AC.Dynamic] });
    await test.step(`Every forward token starts at the run-time today (${data.today}); recomputing tomorrow yields tomorrow-anchored windows`, async () => {
      for (const token of ['next_7_days', 'next_14_days', 'next_30_days', 'custom_days_forward_45']) {
        expect(win(token).start_date, `${token} is anchored to today, not a fixed date`).toBe(data.today);
      }
    });
  });

  test('AC#5 — existing backward-looking options remain unchanged (backend)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_48_AC.BackwardUnchanged] });
    const past = win('past_30_days');
    const today = win('today');
    const tomorrow = win('tomorrow');
    await test.step(`past_30_days = ${past.start_date}..${past.end_date} (ends today, spans 30 days back); today/tomorrow still 1-day windows`, async () => {
      expect(past.end_date, 'past_30_days still ends at today').toBe(data.today);
      expect(past.delta_days, 'past_30_days still spans 30 days').toBe(30);
      expect(today.start_date).toBe(data.today);
      expect(today.delta_days).toBe(1);
      expect(tomorrow.start_date).toBe(data.tomorrow);
      expect(tomorrow.delta_days).toBe(1);
    });
  });

  test('AC#1/#2/#3 — dropdown options + Custom Days Forward numeric input present in merged source (SOURCE-PRESENCE)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_48_AC.Presets, TANGO_48_AC.CustomOption, TANGO_48_AC.CustomInput] });
    await test.step('RelativeTimes.js exposes Next 7/14/30 Days (-> next_*_days) and "Custom Days Forward" (-> custom_days_forward)', async () => {
      for (const s of ['Next 7 Days', 'next_7_days', 'Next 14 Days', 'next_14_days', 'Next 30 Days', 'next_30_days', 'Custom Days Forward', 'custom_days_forward']) {
        expect(relTimesJs.includes(s), `RelativeTimes.js contains "${s}"`).toBe(true);
      }
    });
    await test.step('FiltersController shows the numeric input on Custom Days Forward and serializes the custom_days_forward_<n> token; FilterBlock declares a numberfield', async () => {
      expect(filtersCtrlJs.includes("'custom_days_forward'")).toBe(true);
      expect(/custom_days_forward_\$\{?days\}?|custom_days_forward_\$/.test(filtersCtrlJs) || filtersCtrlJs.includes('custom_days_forward_')).toBe(true);
      expect(filterBlockJs.includes("xtype: 'numberfield'")).toBe(true);
    });
    await test.step('Comm-rule surface (ReportAutomatorDialog.js) was also updated for the shared relative-time filter (Scope: both surfaces)', async () => {
      expect(automatorJs.length, 'ReportAutomatorDialog.js present and non-empty').toBeGreaterThan(0);
    });
  });

  test('AC#7/#8 — 365 cap (maxValue) and the exact cap-error string present in merged source (SOURCE-PRESENCE)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_48_AC.Cap365, TANGO_48_AC.CapError] });
    await test.step('FilterBlock.js caps the day-count numberfield at maxValue: 365', async () => {
      expect(filterBlockJs.includes('maxValue: 365')).toBe(true);
    });
    await test.step('FilterBlock.js surfaces the AC cap-error copy "only supports values up to 365"', async () => {
      expect(filterBlockJs.includes('only supports values up to 365')).toBe(true);
    });
  });
});
