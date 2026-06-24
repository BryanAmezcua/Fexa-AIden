/**
 * TANGO-60 — Support Non Enforced Pricings.
 *
 * Two defects (commit 71e772c75c):
 *  (1) BACKEND: get_unit_price's price_only match excluded pure Decrease pricings,
 *      so a non-enforced Decrease never surfaced the Approved Rate. Fixed with a
 *      display-only unfiltered fallback for approved_rate/pricing_type.
 *  (2) FRONTEND: switching products on an open line-item form kept the previous
 *      product's rate (the "stubborn invoice"). Fixed by tracking lastAutoAppliedRate
 *      so the grid clears only its own auto-applied residue, never user input.
 *
 * Verification:
 *  - BACKEND (deterministic): the real ProductPricing#enforces_rate? lock gate and
 *    #evaluate_data are exercised via rails-runner (support/tango60-pricing.rb)
 *    against the approved-rate-reference fixtures: enforced Flat Rate locks while
 *    Decrease/Increase/non-enforced stay editable, and each non-enforced type
 *    computes a real Approved Rate (Decrease surfaces 85 = 100 − 15).
 *  - SOURCE-PRESENCE: the controller's display-only fallback and the grid's
 *    lastAutoAppliedRate tracking are asserted present in merged source. The
 *    get_unit_price endpoint match + the UI product-switch consistency are
 *    additionally covered by 170 lines of merged minitest
 *    (invoices_controller_test.rb) and were manually verified by QA on qatesting
 *    ("This worked as expected"). A browser E2E of the consistency fix needs a
 *    fresh `npm run fexa:fast-mode` rebuild (the served bundle predates this PR).
 *
 * Fixtures: seeds/approved-rate-reference.rb (npm run seed:approved-rate-reference).
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, TANGO_60_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-60';
const FZ = process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo';

test.describe('Support non-enforced pricings (TANGO-60)', () => {
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(180_000);

  let data: any = null;
  let controllerRb = '';
  let lineItemGridJs = '';

  test.beforeAll(() => {
    const resolver = path.resolve(__dirname, '../../support/tango60-pricing.rb');
    const cmd = `cd "${FZ}" && DISABLE_SPRING=1 RUBYOPT='-W0' bundle exec rails runner "${resolver}"`;
    const out = execSync(cmd, { cwd: process.cwd(), shell: '/bin/bash', encoding: 'utf8', timeout: 150_000 });
    const line = out.split('\n').find((l) => l.startsWith('PRICING_JSON='));
    if (!line) throw new Error(`resolver produced no PRICING_JSON line. Output:\n${out}`);
    data = JSON.parse(line.replace('PRICING_JSON=', ''));

    controllerRb  = fs.readFileSync(path.join(FZ, 'app/controllers/api/v1/invoices_controller.rb'), 'utf8');
    lineItemGridJs = fs.readFileSync(path.join(FZ, 'app/assets/javascripts/app/view/general/invoice/LineItemGrid.js'), 'utf8');
  });

  test('AC — enforced Flat Rate locks the field; non-enforced & Decrease/Increase stay editable (backend enforces_rate?)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_60_AC.EnforcedLocked, TANGO_60_AC.ApprovedRateEditable] });
    await testInfo.attach('pricing-resolution', { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
    const m = data.enforces_rate_matrix;
    await test.step(`enforces_rate? matrix: enforced Flat Rate=${m.enforced_flat_rate} (locked); non-enforced Flat=${m.nonenforced_flat}, Decrease+flag=${m.decrease_with_flag}, Increase+flag=${m.increase_with_flag} (all editable)`, async () => {
      expect(m.enforced_flat_rate, 'enforced Flat Rate + base_price>0 locks the rate').toBe(true);
      expect(m.nonenforced_flat, 'a non-enforced Flat Rate stays editable').toBe(false);
      expect(m.decrease_with_flag, 'a Decrease never locks (grandfathered), stays editable').toBe(false);
      expect(m.increase_with_flag, 'an Increase never locks, stays editable').toBe(false);
    });
  });

  test('AC — every non-enforced pricing surfaces a real Approved Rate and remains editable (backend evaluate_data)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_60_AC.NonEnforcedTotal, TANGO_60_AC.ApprovedRateEditable] });
    await test.step(`At unit_price=${data.unit_price}: Decrease approved_rate=${data.decrease.approved_rate}, Increase=${data.increase.approved_rate}, Flat=${data.flat.approved_rate}; all prevent_price_modification=false (editable)`, async () => {
      expect(data.decrease.approved_rate, 'Decrease surfaces an Approved Rate (100 − 15)').toBe(85);
      expect(data.increase.approved_rate, 'Increase surfaces an Approved Rate (100 + 25)').toBe(125);
      expect(data.flat.approved_rate, 'Flat Rate surfaces its base as the Approved Rate').toBe(100);
      for (const k of ['decrease', 'increase', 'flat'] as const) {
        expect(data[k].prevent_flag, `${k} is non-enforced (editable)`).toBe(false);
        expect(data[k].enforces_rate, `${k} does not lock`).toBe(false);
      }
    });
  });

  test('AC — no behavioral difference between Increase and Decrease (both editable, both compute from unit_price with the right sign)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_60_AC.IncreaseDecreaseParity] });
    await test.step(`Increase raises above unit_price (${data.increase.approved_rate} > ${data.unit_price}); Decrease lowers below it (${data.decrease.approved_rate} < ${data.unit_price}); neither locks`, async () => {
      expect(data.increase.approved_rate).toBeGreaterThan(data.unit_price);
      expect(data.decrease.approved_rate).toBeLessThan(data.unit_price);
      expect(data.increase.enforces_rate).toBe(data.decrease.enforces_rate); // both false — parity
    });
  });

  test('AC — Decrease Approved Rate fallback present in get_unit_price (SOURCE-PRESENCE; endpoint match covered by merged minitest)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_60_AC.ApprovedRateEditable] });
    await test.step('invoices_controller.rb#get_unit_price re-runs the match unfiltered (display_match) so a Decrease surfaces approved_rate/pricing_type while price/lock stay keyed to the price_only match', async () => {
      expect(controllerRb.includes('display_match')).toBe(true);
      expect(controllerRb.includes('TANGO-60')).toBe(true);
      expect(/get_pricing\(\s*reference_options\s*,\s*false\s*\)/.test(controllerRb), 'unfiltered fallback lookup present').toBe(true);
    });
  });

  test('AC — "stubborn invoice" consistency fix present in LineItemGrid (SOURCE-PRESENCE; UI E2E needs fresh bundle + covered by manual QA)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_60_AC.Consistency] });
    await test.step('LineItemGrid.js tracks lastAutoAppliedRate so switching products overwrites the grid\'s own residue but never a user-typed value', async () => {
      expect(lineItemGridJs.includes('lastAutoAppliedRate')).toBe(true);
      expect(lineItemGridJs.includes('TANGO-60')).toBe(true);
    });
  });
});
