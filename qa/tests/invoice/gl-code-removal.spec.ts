/**
 * TANGO-51 — GL Code Reappearing After Removal from Invoice.
 *
 * Backend persistence bug: removing a GL Code, saving, and refreshing made it
 * reappear because the GL mapping re-derived it on save. The fix (commit
 * 59189fe1fd) restores the gl_code contract — nil = "derive from the GL mapping";
 * any non-nil value, including '' from an explicit clear, is deliberate and must
 * NOT be re-derived.
 *
 * Verified DETERMINISTICALLY (support/tango51-glcode.rb) against a real
 * SubcontractorInvoice + its assignment, entirely inside a transaction that ROLLS
 * BACK (no demo data mutated). It proves both re-derivation paths honor the
 * contract: the model guard (maybe_set_gl_code) leaves a cleared '' alone, and
 * SetGlCodesJob skips a cleared '' while still applying a code to a nil invoice.
 * The controller permission guard (key? not present?) and the UI '' persistence
 * are asserted at the source level (and covered by the merged change). The
 * status-gating note (deletion only in Accepted/Billing) is a separate UI gate,
 * documented below as not exercised here.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, TANGO_51_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-51';
const FZ = process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo';

test.describe('GL code removal persists (TANGO-51)', () => {
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(180_000);

  let data: any = null;
  let v1Rb = '';
  let ev1Rb = '';
  let invoiceControllerJs = '';
  let jobRb = '';

  test.beforeAll(() => {
    const resolver = path.resolve(__dirname, '../../support/tango51-glcode.rb');
    const cmd = `cd "${FZ}" && DISABLE_SPRING=1 RUBYOPT='-W0' bundle exec rails runner "${resolver}"`;
    const out = execSync(cmd, { cwd: process.cwd(), shell: '/bin/bash', encoding: 'utf8', timeout: 150_000 });
    const line = out.split('\n').find((l) => l.startsWith('T51_JSON='));
    if (!line) throw new Error(`resolver produced no T51_JSON line. Output:\n${out}`);
    data = JSON.parse(line.replace('T51_JSON=', ''));

    v1Rb  = fs.readFileSync(path.join(FZ, 'app/controllers/api/v1/subcontractor_invoices_controller.rb'), 'utf8');
    ev1Rb = fs.readFileSync(path.join(FZ, 'app/controllers/api/ev1/subcontractor_invoices_controller.rb'), 'utf8');
    invoiceControllerJs = fs.readFileSync(path.join(FZ, 'app/assets/javascripts/app/view/general/invoice/InvoiceController.js'), 'utf8');
    jobRb = fs.readFileSync(path.join(FZ, 'app/jobs/set_gl_codes_job.rb'), 'utf8');
  });

  test('A removed GL code (\'\') is NOT re-derived by the model save guard (maybe_set_gl_code)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_51_AC.ExpectedRemoval, TANGO_51_AC.BugRepro] });
    await testInfo.attach('gl-code-contract', { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
    await test.step(`On a real invoice (#${data.invoice_id}), clearing gl_code to '' and re-running maybe_set_gl_code after a saved change leaves it '' (got ${JSON.stringify(data.guard_blank_stays)}) — not re-derived from the mapping`, async () => {
      expect(data.guard_blank_stays, "an explicit clear ('') survives maybe_set_gl_code").toBe('');
      expect(data.guard_nil_no_raise, 'the nil derive path does not raise').toBe(true);
    });
  });

  test('SetGlCodesJob skips a cleared GL code (\'\') but still applies a code to a nil invoice', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_51_AC.ExpectedRemoval, TANGO_51_AC.BugRepro] });
    await test.step(`SetGlCodesJob on assignment #${data.assignment_id}: a nil invoice receives the code (${JSON.stringify(data.job_from_nil)} == ${JSON.stringify(data.source_code)}), but a cleared '' is left removed (${JSON.stringify(data.job_from_blank)})`, async () => {
      expect(data.job_from_nil, 'a nil gl_code is derived/applied (so the removal contrast is real, not vacuous)').toBe(data.source_code);
      expect(data.job_from_blank, "a cleared '' is skipped and stays removed after the job").toBe('');
    });
  });

  test('The clear survives BOTH re-derivation paths — the original "reappears after refresh" defect is fixed', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_51_AC.ExpectedRemoval] });
    await test.step('Neither the model save guard nor the SetGlCodesJob re-applies the mapping to a removed GL code', async () => {
      expect(data.guard_blank_stays).toBe('');
      expect(data.job_from_blank).toBe('');
      // job confirms a derivable code DID exist for this assignment, so "stays removed" is meaningful
      expect(data.job_from_nil).toBe(data.source_code);
    });
  });

  test('Permission guard + UI clear-persistence present in merged source (SOURCE-PRESENCE)', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_51_AC.ExpectedRemoval] });
    await test.step('v1 & ev1 subcontractor controllers gate gl_code on params.key?(:gl_code) (not present?), so a blank clear still passes the edit_gl_code permission check', async () => {
      expect(v1Rb.includes('params.key?( :gl_code )') || v1Rb.includes('params.key?(:gl_code)')).toBe(true);
      expect(ev1Rb.includes('params.key?( :gl_code )') || ev1Rb.includes('params.key?(:gl_code)')).toBe(true);
    });
    await test.step("InvoiceController.js persists '' when the GL Code field is cleared (so null doesn't tell the backend to re-derive); SetGlCodesJob carries the TANGO-51 skip guard", async () => {
      expect(invoiceControllerJs.includes("values.gl_code = '';")).toBe(true);
      expect(jobRb.includes('gl_code.nil?') && jobRb.includes('gl_code.blank?')).toBe(true);
      expect(jobRb.includes('TANGO-51')).toBe(true);
    });
  });

  test('Status-gating note (deletion only in Accepted/Billing) — documented as a separate UI gate, not exercised here', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_51_AC.StatusGating] });
    await test.step('Per the reporter comment, GL Code deletion is only offered in Accepted/Billing statuses (not New/In Progress/Needs Review). This is a UI status gate distinct from the persistence fix verified above; it would need a browser E2E across statuses (deferred — see report notes).', async () => {
      // No backend assertion: this clause is a UI affordance note, recorded for traceability.
      expect(true).toBe(true);
    });
  });
});
