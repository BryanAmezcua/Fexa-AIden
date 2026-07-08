import { test, expect, Page, TestInfo } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, captureAcSnapshot, TANGO_78_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-78';

const MANIFEST_PATH = path.resolve(__dirname, '../../reports/seed-manifest-tango-78.json');

interface SeedManifest {
  scope: { description_prefix: string; seed_nte_amount: number };
  fixtures: Array<{
    key: 'core_admin' | 'core_vendor' | 'core_fm' | 'edit';
    workorder_id: number;
    assignment_id: number;
    nte: { id: number; amount: number; active: boolean };
  }>;
}

function loadManifest(): SeedManifest {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `Seed manifest missing: ${MANIFEST_PATH}. Run \`npm run seed:assignment-nte-revert\` first.`,
    );
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
}

const MANIFEST = loadManifest();
const SEED_AMOUNT = MANIFEST.scope.seed_nte_amount;          // 100.00
const EXTERNAL_AMOUNT = 444.44;   // the "proposal approval" write while the page is stale
const FRESH_AMOUNT = 555.55;      // server value the re-fetching sheet must display
const DELIBERATE_AMOUNT = 321.5;  // amount typed by the user in the deliberate-edit case

const FIXTURES = Object.fromEntries(MANIFEST.fixtures.map((f) => [f.key, f])) as Record<
  SeedManifest['fixtures'][number]['key'],
  SeedManifest['fixtures'][number]
>;

/** Playwright project name → the persona-owned stale-echo fixture. */
const CORE_FIXTURE_BY_PROJECT: Record<string, SeedManifest['fixtures'][number]> = {
  admin: FIXTURES.core_admin,
  vendor: FIXTURES.core_vendor,
  'facility-manager': FIXTURES.core_fm,
};

// ---------------------------------------------------------------------------
// rails-runner helpers (same execSync pattern as vendor-nte-mass-update.spec)
// ---------------------------------------------------------------------------

function railsRunner(script: string, timeoutMs = 90_000): string {
  const out = execSync(
    `cd ${process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo'} && DISABLE_SPRING=1 bundle exec rails runner '${script}' 2>/dev/null | tail -1`,
    { encoding: 'utf-8', shell: '/bin/bash', timeout: timeoutMs },
  );
  return out.trim();
}

/** Active SubcontractorNotToExceed row for an assignment (null if none). */
function activeNteFor(assignmentId: number): { id: number; amount: number; active: boolean; updated_at: string } | null {
  const out = railsRunner(`
      a = Workorders::Assignment.find(${assignmentId})
      n = a.subcontractor_not_to_exceed
      puts(n ? { id: n.id, amount: n.amount.to_f, active: n.active, updated_at: n.updated_at.iso8601(6) }.to_json : "null")
    `);
  return out === 'null' ? null : JSON.parse(out);
}

/**
 * Mutates the assignment NTE server-side EXACTLY the way proposal approval
 * does (subcontractor_quote.rb before_state_change): update_attribute on the
 * same active row. This is the "NTE changed elsewhere" event of the ticket.
 */
function setNteServerSide(assignmentId: number, amount: number): void {
  railsRunner(`
      a = Workorders::Assignment.find(${assignmentId})
      a.subcontractor_not_to_exceed.update_attribute(:amount, ${amount})
      puts a.subcontractor_not_to_exceed.reload.amount.to_f
    `);
}

/** Resets a fixture NTE row to the seeded baseline for idempotent re-runs. */
function resetFixtureNte(fixture: SeedManifest['fixtures'][number]): void {
  railsRunner(`
      n = Workorders::SubcontractorNotToExceed.find(${fixture.nte.id})
      n.update_columns(amount: ${SEED_AMOUNT}, active: true)
      puts n.reload.amount.to_f
    `);
}

// ---------------------------------------------------------------------------
// Ext-side helpers
// ---------------------------------------------------------------------------

/** Retry-on-context-destroyed page.evaluate (see vendor-nte-mass-update). */
async function safeEval<T, A = any>(page: Page, fn: (arg?: A) => T, arg?: A, attempts = 5): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await (arg === undefined ? page.mainFrame().evaluate(fn as any) : page.mainFrame().evaluate(fn as any, arg)); }
    catch (e) {
      lastErr = e;
      if (!/Execution context was destroyed/i.test((e as Error)?.message ?? '')) throw e;
      await page.waitForTimeout(1000);
    }
  }
  throw lastErr;
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    if (!Ext?.ComponentQuery) return false;
    try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; } catch { return false; }
  }, null, { timeout: 90_000, polling: 1000 });
  await page.waitForTimeout(1500);
}

/**
 * Deep-links to the Work Order Overview and waits for its assignments grid
 * to hold the fixture assignment. Returns false when the persona cannot
 * reach the screen (used as a runtime skip guard for vendor / fm projects).
 */
async function openWorkorderOverview(page: Page, workorderId: number, assignmentId: number): Promise<boolean> {
  await safeEval(page, (id) => { (window as any).Ext.History.add(`workorder/${id}`); }, workorderId);
  try {
    await page.waitForFunction((asnId) => {
      const Ext = (window as any).Ext;
      const panels = Ext.ComponentQuery.query('workorderassignments');
      return panels.some((p: any) => {
        const store = p.down?.('grid')?.getStore?.();
        if (!store || !store.getCount?.()) return false;
        const items = store.getData?.()?.items ?? [];
        return items.some((r: any) => r?.data?.id === asnId);
      });
    }, assignmentId, { timeout: 60_000, polling: 1000 });
  } catch {
    return false;
  }
  await page.waitForTimeout(1500);
  return true;
}

// The app keeps other always-visible sheets mounted, so "first visible sheet"
// is NOT the assignment editor. Every helper below locates the assignment
// sheet by its distinctive Save button reference; the NTE field lives on the
// same sheet.

/**
 * Opens the assignment edit sheet through the SAME code path the UI uses
 * (AssignmentsController.editAssignment via the grid record), then waits for
 * the TANGO-78 re-fetch to finish binding: assignment sheet visible, mask
 * cleared, and the formpanel bound to the right record.
 */
async function openAssignmentSheet(page: Page, assignmentId: number): Promise<void> {
  await safeEval(page, (asnId) => {
    const Ext = (window as any).Ext;
    const panel = Ext.ComponentQuery.query('workorderassignments').find((p: any) => {
      const items = p.down?.('grid')?.getStore?.()?.getData?.()?.items ?? [];
      return items.some((r: any) => r?.data?.id === asnId);
    });
    if (!panel) throw new Error(`No workorderassignments panel holding assignment ${asnId}`);
    const store = panel.down('grid').getStore();
    const record = (store.getData?.()?.items ?? []).find((r: any) => r?.data?.id === asnId);
    panel.getController().editAssignment(null, { record });
  }, assignmentId);

  await page.waitForFunction((asnId) => {
    const Ext = (window as any).Ext;
    const sheet = Ext.ComponentQuery.query('sheet')
      .filter((s: any) => s.isVisible?.())
      .find((s: any) => s.down?.('[reference=assignmentSheetSaveBtn]'));
    if (!sheet || sheet.getMasked?.()) return false;
    const form = sheet.down?.('formpanel');
    return form?.getRecord?.()?.data?.id === asnId;
  }, assignmentId, { timeout: 60_000, polling: 500 });
  await page.waitForTimeout(1000);
}

/** Reads the assignment sheet's NTE numberfield value. */
async function readSheetNte(page: Page): Promise<number | null> {
  return await safeEval(page, () => {
    const Ext = (window as any).Ext;
    const sheet = Ext.ComponentQuery.query('sheet')
      .filter((s: any) => s.isVisible?.())
      .find((s: any) => s.down?.('[reference=assignmentSheetSaveBtn]'));
    const field = sheet?.down?.('[name="subcontractor_not_to_exceed.amount"]');
    const v = field?.getValue?.();
    return v === undefined || v === null || v === '' ? null : Number(v);
  });
}

/** Sets a named field on the assignment sheet via the Ext component API. */
async function setSheetField(page: Page, name: string, value: string | number): Promise<void> {
  await safeEval(page, (arg?: { name: string; value: string | number }) => {
    if (!arg) return;
    const Ext = (window as any).Ext;
    const sheet = Ext.ComponentQuery.query('sheet')
      .filter((s: any) => s.isVisible?.())
      .find((s: any) => s.down?.('[reference=assignmentSheetSaveBtn]'));
    const field = sheet?.down?.(`[name="${arg.name}"]`);
    if (!field) throw new Error(`Assignment sheet field [name=${arg.name}] not found`);
    field.setValue(arg.value);
  }, { name, value });
  await page.waitForTimeout(300);
}

/**
 * Taps the assignment sheet's Save button and captures the resulting
 * PUT /api/v1/assignments/:id payload. Returns the parsed assignment object
 * from the request body so callers can assert exactly what was submitted.
 */
async function saveSheetAndCapturePut(page: Page, assignmentId: number): Promise<{ payload: any; status: number }> {
  const respPromise = page.waitForResponse(
    (r) => new RegExp(`/api/v1/assignments/${assignmentId}(\\?|$)`).test(r.url()) && r.request().method() === 'PUT',
    { timeout: 30_000 },
  );

  await safeEval(page, () => {
    const Ext = (window as any).Ext;
    const sheet = Ext.ComponentQuery.query('sheet')
      .filter((s: any) => s.isVisible?.())
      .find((s: any) => s.down?.('[reference=assignmentSheetSaveBtn]'));
    const btn = sheet?.down?.('[reference=assignmentSheetSaveBtn]');
    if (!btn) throw new Error('assignmentSheetSaveBtn not found on visible assignment sheet');
    btn.fireEvent('tap', btn);
  });

  const resp = await respPromise;
  const req = resp.request();
  const body = req.postDataJSON() ?? {};
  const payload = Array.isArray(body.assignments) ? body.assignments[0] : body.assignments ?? body;
  return { payload, status: resp.status() };
}

/** Closes the assignment sheet if the controller left it open. */
async function closeSheetIfOpen(page: Page): Promise<void> {
  await safeEval(page, () => {
    const Ext = (window as any).Ext;
    const sheet = Ext.ComponentQuery.query('sheet')
      .filter((s: any) => s.isVisible?.())
      .find((s: any) => s.down?.('[reference=assignmentSheetSaveBtn]'));
    sheet?.hide?.();
  }).catch(() => {});
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test.describe('Assignment NTE stale-overwrite fix on WO Overview (TANGO-78)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test('External NTE change survives an unrelated-field edit on a stale Overview', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_78_AC.Problem, TANGO_78_AC.StepsToReproduce, TANGO_78_AC.CrossScreenTrigger],
    });

    const fixture = CORE_FIXTURE_BY_PROJECT[testInfo.project.name];
    test.skip(!fixture, `no fixture for project ${testInfo.project.name}`);
    resetFixtureNte(fixture);

    await test.step(`Open WO Overview #${fixture.workorder_id} (assignment #${fixture.assignment_id}, seeded NTE $${SEED_AMOUNT})`, async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      const accessible = await openWorkorderOverview(page, fixture.workorder_id, fixture.assignment_id);
      test.skip(!accessible, `${testInfo.project.name} persona cannot reach WO Overview #${fixture.workorder_id} in this demo DB — access gap documented in the QA report`);
    });
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step(`Server-side NTE write while the page sits stale: $${SEED_AMOUNT} → $${EXTERNAL_AMOUNT} (update_attribute — the exact proposal-approval write)`, async () => {
      setNteServerSide(fixture.assignment_id, EXTERNAL_AMOUNT);
      const now = activeNteFor(fixture.assignment_id);
      expect(now?.amount, 'server-side mutation must land before the UI edit').toBe(EXTERNAL_AMOUNT);
    });

    let putStatus!: number;
    let putPayload: any;
    await test.step(`WITHOUT reloading, edit unrelated field Scope="[QA] TANGO-78 unrelated edit" on assignment #${fixture.assignment_id} and Save`, async () => {
      await openAssignmentSheet(page, fixture.assignment_id);
      await setSheetField(page, 'scope', `[QA] TANGO-78 unrelated edit (${testInfo.project.name})`);
      const { payload, status } = await saveSheetAndCapturePut(page, fixture.assignment_id);
      putStatus = status;
      putPayload = payload;
    });

    // Two legitimate outcomes depending on the persona's assignment-update
    // permission (the ticket flags permission-gating as an explicit concern):
    //   - can update (admin/internal ops): PUT succeeds and MUST omit the NTE
    //     (Fix 1) so the external value survives — the core proof.
    //   - cannot update (read-only vendor role): the backend rejects the PUT
    //     (401/403). The bug is not triggerable by this role, and the external
    //     NTE must remain intact. This positively covers the ticket's "fix must
    //     not break permission-gated cases" note rather than skipping it.
    if (putStatus === 200) {
      await test.step('Persona CAN update — assert the PUT carries NO NTE data (Fix 1: untouched NTE is not submitted)', async () => {
        // The nested object save() builds is what convert_params reshapes into
        // the permitted `subcontractor_not_to_exceed_attributes` (the only
        // server-side NTE write path) — Fix 1 omits it here.
        expect(
          putPayload?.subcontractor_not_to_exceed,
          `PUT must NOT carry nested subcontractor_not_to_exceed when untouched; got ${JSON.stringify(putPayload?.subcontractor_not_to_exceed)}`,
        ).toBeUndefined();
        // The flat modeled key form.getValues() emits is inert server-side (not a
        // permitted param) but is now explicitly deleted in save() so the payload
        // carries no NTE data at all. This assertion is the regression guard for
        // that delete (it was RED before the delete, when the flat key leaked).
        expect(
          putPayload?.['subcontractor_not_to_exceed.amount'],
          `flat NTE key must be stripped from the PUT in the unchanged path; got ${JSON.stringify(putPayload?.['subcontractor_not_to_exceed.amount'])}`,
        ).toBeUndefined();
      });
    } else {
      await test.step(`Persona CANNOT update assignments (PUT ${putStatus}) — permission-gated; the stale-overwrite is not reachable by this role`, async () => {
        expect([401, 403], `read-only persona save should be rejected by the backend, got ${putStatus}`).toContain(putStatus);
      });
    }

    await test.step(`Assert the external NTE $${EXTERNAL_AMOUNT} survived (no silent revert to $${SEED_AMOUNT})`, async () => {
      const after = activeNteFor(fixture.assignment_id);
      expect(after?.amount, 'NTE amount must remain the externally-written value').toBeCloseTo(EXTERNAL_AMOUNT, 2);
      expect(after?.id, 'NTE row must not be replaced').toBe(fixture.nte.id);
    });

    await closeSheetIfOpen(page);
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: page.getByText(`${EXTERNAL_AMOUNT}`).first(),
    });
  });

  test('Edit sheet re-fetches on open — shows the server-fresh NTE, not the stale grid value', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_78_AC.RootCause] });
    test.skip(testInfo.project.name !== 'admin', 'sheet re-fetch behavior proven once, as admin');

    const fixture = FIXTURES.edit;
    resetFixtureNte(fixture);

    await test.step(`Open WO Overview #${fixture.workorder_id} while NTE=$${SEED_AMOUNT} (grid caches this value)`, async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      const accessible = await openWorkorderOverview(page, fixture.workorder_id, fixture.assignment_id);
      expect(accessible, 'admin must reach the WO Overview').toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step(`Server-side NTE write while page open: $${SEED_AMOUNT} → $${FRESH_AMOUNT}`, async () => {
      setNteServerSide(fixture.assignment_id, FRESH_AMOUNT);
    });

    await test.step(`Open the assignment edit sheet — it must display $${FRESH_AMOUNT} (server truth), not the stale $${SEED_AMOUNT}`, async () => {
      await openAssignmentSheet(page, fixture.assignment_id);
      const shown = await readSheetNte(page);
      expect(shown, `sheet NTE field must show the re-fetched amount`).toBeCloseTo(FRESH_AMOUNT, 2);
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: page.locator('input[name="subcontractor_not_to_exceed.amount"]').last(),
    });
    await closeSheetIfOpen(page);
  });

  test(`Deliberate NTE edit still persists (to the SAME row) — $${SEED_AMOUNT} → $${DELIBERATE_AMOUNT}`, async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_78_AC.StepsToReproduce] });
    test.skip(testInfo.project.name !== 'admin', 'regression guard proven once, as admin');

    const fixture = FIXTURES.edit;
    resetFixtureNte(fixture);

    await test.step(`Open WO Overview #${fixture.workorder_id} and the assignment edit sheet`, async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      const accessible = await openWorkorderOverview(page, fixture.workorder_id, fixture.assignment_id);
      expect(accessible, 'admin must reach the WO Overview').toBe(true);
      await openAssignmentSheet(page, fixture.assignment_id);
    });
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: page.locator('input[name="subcontractor_not_to_exceed.amount"]').last(),
    });

    let putPayload: any;
    await test.step(`Set NTE=$${DELIBERATE_AMOUNT} in the sheet and Save`, async () => {
      await setSheetField(page, 'subcontractor_not_to_exceed.amount', DELIBERATE_AMOUNT);
      const { payload, status } = await saveSheetAndCapturePut(page, fixture.assignment_id);
      expect(status).toBe(200);
      putPayload = payload;
    });

    await test.step('Assert the PUT carried the changed NTE with the existing row id (edited values still submit)', async () => {
      expect(putPayload?.subcontractor_not_to_exceed, 'changed NTE must be in the payload').toBeTruthy();
      expect(Number(putPayload.subcontractor_not_to_exceed.amount)).toBeCloseTo(DELIBERATE_AMOUNT, 2);
      expect(putPayload.subcontractor_not_to_exceed.id, 'must target the existing NTE row').toBe(fixture.nte.id);
    });

    await test.step(`Assert DB: amount=$${DELIBERATE_AMOUNT} on the same NTE row #${fixture.nte.id}`, async () => {
      const after = activeNteFor(fixture.assignment_id);
      expect(after?.amount).toBeCloseTo(DELIBERATE_AMOUNT, 2);
      expect(after?.id, 'NTE updated in place, not replaced').toBe(fixture.nte.id);
    });

    await closeSheetIfOpen(page);
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: page.getByText(`${DELIBERATE_AMOUNT}`).first(),
    });
  });

  test('Unrelated-field edit performs zero NTE writes (row untouched, byte for byte)', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_78_AC.Problem, TANGO_78_AC.RootCause] });
    test.skip(testInfo.project.name !== 'admin', 'no-write proof driven once, as admin');

    const fixture = FIXTURES.edit;
    resetFixtureNte(fixture);
    const before = activeNteFor(fixture.assignment_id);
    expect(before, 'edit fixture must have an active NTE').not.toBeNull();

    await test.step(`Open WO Overview #${fixture.workorder_id}, edit Scope only, Save`, async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      const accessible = await openWorkorderOverview(page, fixture.workorder_id, fixture.assignment_id);
      expect(accessible, 'admin must reach the WO Overview').toBe(true);
      await captureAcSnapshot(testInfo, page, 'before');
      await openAssignmentSheet(page, fixture.assignment_id);
      await setSheetField(page, 'scope', '[QA] TANGO-78 no-write scope edit');
      const { payload, status } = await saveSheetAndCapturePut(page, fixture.assignment_id);
      expect(status).toBe(200);
      // Both NTE shapes must be gone: the nested object (the server-honored write
      // path) and the flat modeled key (now explicitly deleted in save()). The
      // updated_at byte-check below independently confirms no write occurred.
      expect(payload?.subcontractor_not_to_exceed, 'payload must omit the nested untouched NTE').toBeUndefined();
      expect(payload?.['subcontractor_not_to_exceed.amount'], 'payload must omit the flat NTE key too').toBeUndefined();
    });

    await test.step('Assert the NTE row is bit-identical: same id, same amount, same updated_at', async () => {
      const after = activeNteFor(fixture.assignment_id);
      expect(after?.id).toBe(before!.id);
      expect(after?.amount).toBeCloseTo(before!.amount, 2);
      expect(after?.updated_at, 'updated_at must not move — proves no UPDATE hit the row').toBe(before!.updated_at);
    });

    await closeSheetIfOpen(page);
    await captureAcSnapshot(testInfo, page, 'after');
  });

  test('nteAmountChanged guard: numeric equality (API "100.0" vs field 100) and blank transitions', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_78_AC.RootCause] });
    test.skip(testInfo.project.name !== 'admin', 'white-box guard check runs once, as admin');

    // The whole reason save() stopped over-submitting is nteAmountChanged's
    // numeric comparison: the API serializes the loaded amount as a string
    // ("100.0") while the numberfield holds a Number (100). A naive `!==` would
    // read every save as "changed" and silently reintroduce the bug. This
    // exercises the guard directly against the shipped controller method so a
    // regression to reference/string equality fails HERE, not just in a flaky
    // end-to-end flow.
    const fixture = FIXTURES.edit;
    await test.step('Open WO Overview so the assignments view controller is instantiated', async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      const accessible = await openWorkorderOverview(page, fixture.workorder_id, fixture.assignment_id);
      expect(accessible, 'admin must reach the WO Overview').toBe(true);
    });

    const cases = await safeEval(page, () => {
      const Ext = (window as any).Ext;
      const ctrl = Ext.ComponentQuery.query('workorderassignments')[0]?.getController?.();
      if (!ctrl || typeof ctrl.nteAmountChanged !== 'function') {
        return { error: 'nteAmountChanged not found on controller' };
      }
      const c = (a: any, b: any) => ctrl.nteAmountChanged(a, b);
      return {
        error: null,
        // [label, result, expected]
        results: [
          ['string "100.0" vs number 100 → unchanged', c('100.0', 100), false],
          ['string "100.50" vs number 100.5 → unchanged', c('100.50', 100.5), false],
          ['number 100 vs number 100 → unchanged', c(100, 100), false],
          ['blank "" vs blank null → unchanged', c('', null), false],
          ['undefined vs blank "" → unchanged', c(undefined, ''), false],
          ['blank "" vs number 200 → changed', c('', 200), true],
          ['number 250 vs blank null → changed (clearing) ', c(250, null), true],
          ['number 321.5 vs string "100.0" → changed', c(321.5, '100.0'), true],
        ] as Array<[string, boolean, boolean]>,
      };
    });

    expect(cases.error, 'nteAmountChanged must be present on the shipped controller').toBeNull();
    for (const [label, got, want] of cases.results!) {
      expect(got, `nteAmountChanged — ${label}`).toBe(want);
    }

    // Render the truth table as the AC-proving artifact for the report.
    const rowsHtml = cases.results!
      .map(([label, got, want]) => `<tr><td>${label}</td><td>${got}</td><td>${want}</td><td>${got === want ? 'PASS' : 'FAIL'}</td></tr>`)
      .join('');
    const tablePath = testInfo.outputPath('nte-amount-changed-truth-table.html');
    fs.writeFileSync(tablePath, `<!doctype html><html><body style="font-family: monospace; padding: 24px; font-size: 14px;">
<h2>TANGO-78 — nteAmountChanged() guard truth table</h2>
<p>Direct calls into the shipped Fexy.view.general.workorder.AssignmentsController#nteAmountChanged</p>
<table cellpadding="6" border="1" style="border-collapse: collapse;">
<tr><th align="left">case</th><th>returned</th><th>expected</th><th>verdict</th></tr>
${rowsHtml}
</table></body></html>`);
    await test.step('Render nteAmountChanged truth table as evidence', async () => {
      await page.goto(`file://${tablePath}`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: testInfo.outputPath('ac-snapshot-after.png'), animations: 'disabled', caret: 'hide' });
      await testInfo.attach('ac-snapshot-after', { path: testInfo.outputPath('ac-snapshot-after.png'), contentType: 'image/png' });
    });
  });
});

// ---------------------------------------------------------------------------
// Documented coverage boundaries (surfaced by the multi-agent critique):
//   - MOBILE FORK (mobile/app/.../AssignmentsController.js) received Fix 1
//     (guarded NTE submit) but NOT the sheet re-fetch. It still binds the
//     stale grid record on open, so a deliberate NTE edit from a stale base
//     can overwrite on mobile. Not exercised here (no workordermobile build
//     harness); flagged as a follow-up.
//   - FIELD-DISABLED-BUT-ASSIGNMENT-UPDATABLE persona (can update the
//     assignment, cannot update the NTE → field disabled) is not seeded; the
//     disabled-field arm of the save() guard is covered only by the unit-level
//     nteAmountChanged check above, not end-to-end.
//   - BACKEND minitest for api/v1/assignments#update nested-NTE param handling
//     (honored when sent, row untouched when omitted) does not exist and is
//     recommended as a follow-up alongside the lock_version work.
// ---------------------------------------------------------------------------
