import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, captureAcSnapshot, TANGO_78_PR_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-78';

const MANIFEST_PATH = path.resolve(__dirname, '../../reports/seed-manifest-tango-78.json');

interface SeedManifest {
  scope: { description_prefix: string; seed_nte_amount: number };
  create_flow: { workorder_id: number; facility_id: number; vendor_role_id: number; category_id: number };
  fixtures: Array<{ key: string; workorder_id: number; assignment_id: number }>;
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
const CREATE_FLOW = MANIFEST.create_flow;
const FIRST_SAVE_AMOUNT = 500;     // the amount Kevin's Regression A steps use
const IMMEDIATE_AMOUNT = 777;      // immediate-submit variant (reviewer's Note)

// ---------------------------------------------------------------------------
// rails-runner helpers (same execSync pattern as assignment-nte-revert.spec)
// ---------------------------------------------------------------------------

function railsRunner(script: string, timeoutMs = 90_000): string {
  const out = execSync(
    `cd ${process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo'} && DISABLE_SPRING=1 bundle exec rails runner '${script}' 2>/dev/null | tail -1`,
    { encoding: 'utf-8', shell: '/bin/bash', timeout: timeoutMs },
  );
  return out.trim();
}

/** Deletes any assignments a previous run attached to the create-flow WO. */
function resetCreateFlowWorkorder(): void {
  railsRunner(`
      wo = Workorders::Workorder.find(${CREATE_FLOW.workorder_id})
      wo.assignments.destroy_all
      puts wo.assignments.count
    `);
}

/** Active-NTE amounts of the create-flow WO's assignments, JSON-encoded. */
function createFlowAssignmentNtes(): Array<{ assignment_id: number; amount: number | null; active: boolean }> {
  const out = railsRunner(`
      wo = Workorders::Workorder.find(${CREATE_FLOW.workorder_id})
      puts wo.assignments.reload.map { |a|
        n = a.subcontractor_not_to_exceed
        { assignment_id: a.id, amount: n&.amount&.to_f, active: n ? n.active : nil }
      }.to_json
    `);
  return JSON.parse(out || '[]');
}

// ---------------------------------------------------------------------------
// Ext-side helpers
// ---------------------------------------------------------------------------

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
 * Opens the Create Work Order screen and selects the seeded facility on the
 * WO form (the assignment sheet's getSheet() reads the facility selection for
 * its timezone default and crashes without one).
 */
async function openCreateWorkorderScreen(page: Page): Promise<void> {
  await safeEval(page, () => { (window as any).Ext.History.add('createworkorder'); });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    return Ext.ComponentQuery.query('createworkorder').some((p: any) => p.isVisible?.());
  }, null, { timeout: 60_000, polling: 1000 });
  await page.waitForTimeout(2000);

  const err = await safeEval(page, async (facilityId?: number) => {
    const Ext = (window as any).Ext;
    const create = Ext.ComponentQuery.query('createworkorder').find((p: any) => p.isVisible?.());
    const ff = create.down('[name=facility_id]');
    if (!ff) return 'no facility field on createworkorder';
    const rec: any = await new Promise((resolve) => {
      Ext.create('Fexy.model.facility.Facility', { id: facilityId }).load({
        callback: (r: any, op: any, success: boolean) => resolve(success ? r : null),
      });
    });
    if (!rec) return `facility ${facilityId} failed to load`;
    ff.setSelected?.(rec);
    ff.setValue?.(facilityId);
    return null;
  }, CREATE_FLOW.facility_id);
  expect(err, 'facility selection on the create screen').toBeNull();
  await page.waitForTimeout(500);
}

/**
 * Opens the assignment sheet on the create screen via createAssignment() and
 * fills the required fields (provider = seeded QA vendor role, category,
 * priority/class = first store option) plus the given NTE amount. Returns any
 * error string, or null.
 */
async function addAssignmentViaSheet(page: Page, nteAmount: number, scope: string): Promise<string | null> {
  return await safeEval(page, async (arg?: { vendorRoleId: number; categoryId: number; nteAmount: number; scope: string }) => {
    if (!arg) return 'no arg';
    const Ext = (window as any).Ext;
    const create = Ext.ComponentQuery.query('createworkorder').find((p: any) => p.isVisible?.());
    const ctrl = create.down('workorderassignments').getController();
    ctrl.createAssignment();
    const sheet = ctrl.sheet;
    const form = sheet.down('formpanel');

    form.down('[name="role_id"]').setValue(arg.vendorRoleId);
    form.down('[name="category_id"]').setValue(arg.categoryId);
    form.down('[name="subcontractor_not_to_exceed.amount"]').setValue(arg.nteAmount);
    form.down('[name="scope"]').setValue(arg.scope);
    await new Promise((r) => setTimeout(r, 800));

    // priority / workorder class selectfields: first available option
    for (const name of ['priority_id', 'workorder_class_id']) {
      const f = form.down(`[name="${name}"]`);
      if (f && (f.getValue() === null || f.getValue() === undefined || f.getValue() === '')) {
        const st = f.getStore?.();
        if (st && !st.getCount() && st.load) { await new Promise<void>((r) => st.load({ callback: () => r() })); }
        const first = st?.getAt?.(0);
        if (first) { f.setSelected?.(first); f.setValue(first.getId ? first.getId() : first); }
      }
    }

    if (!form.validate()) {
      const missing = form.query('field')
        .filter((f: any) => (f.getRequired?.() ?? false) && !f.getHidden?.() &&
          (f.getValue?.() === null || f.getValue?.() === undefined || f.getValue?.() === ''))
        .map((f: any) => f.getName?.());
      return `sheet form invalid; empty required: ${JSON.stringify(missing)}`;
    }

    const btn = sheet.down('[reference=assignmentSheetSaveBtn]');
    btn.fireEvent('tap', btn);
    await new Promise((r) => setTimeout(r, 1200));
    return null;
  }, { vendorRoleId: CREATE_FLOW.vendor_role_id, categoryId: CREATE_FLOW.category_id, nteAmount, scope });
}

/** Snapshot of the newest grid record's NTE state on the create screen. */
async function newestGridRecordNte(page: Page): Promise<{ flat: any; nested: any; cellText: string; gridCount: number }> {
  return await safeEval(page, () => {
    const Ext = (window as any).Ext;
    const create = Ext.ComponentQuery.query('createworkorder').find((p: any) => p.isVisible?.());
    const grid = create.down('workorderassignments').down('grid');
    const store = grid.getStore();
    const rec = store.getAt(store.getCount() - 1);
    let cellText = '<no cell>';
    try {
      const col = grid.getColumns().find((c: any) => c.getDataIndex?.() === 'subcontractor_not_to_exceed.amount');
      cellText = grid.getItem(rec)?.getCellByColumn?.(col)?.el?.dom?.innerText ?? '<no cell>';
    } catch { /* cell rendering is asserted via flat value too */ }
    return {
      flat: rec.data['subcontractor_not_to_exceed.amount'],
      nested: rec.data.subcontractor_not_to_exceed,
      cellText,
      gridCount: store.getCount(),
    };
  });
}

/** Reopens the edit sheet for the newest (phantom) grid record. */
async function reopenNewestAssignmentSheet(page: Page): Promise<number | null> {
  return await safeEval(page, async () => {
    const Ext = (window as any).Ext;
    const create = Ext.ComponentQuery.query('createworkorder').find((p: any) => p.isVisible?.());
    const ctrl = create.down('workorderassignments').getController();
    const store = create.down('workorderassignments').down('grid').getStore();
    const rec = store.getAt(store.getCount() - 1);
    ctrl.editAssignment(null, { record: rec });
    await new Promise((r) => setTimeout(r, 1200));
    const v = ctrl.sheet.down('formpanel').down('[name="subcontractor_not_to_exceed.amount"]')?.getValue?.();
    return v === undefined || v === null || v === '' ? null : Number(v);
  });
}

/** Taps save on the currently open create-screen assignment sheet. */
async function saveOpenSheet(page: Page): Promise<void> {
  await safeEval(page, async () => {
    const Ext = (window as any).Ext;
    const create = Ext.ComponentQuery.query('createworkorder').find((p: any) => p.isVisible?.());
    const ctrl = create.down('workorderassignments').getController();
    const btn = ctrl.sheet.down('[reference=assignmentSheetSaveBtn]');
    btn.fireEvent('tap', btn);
    await new Promise((r) => setTimeout(r, 1200));
  });
}

/**
 * Attaches the phantom grid assignments to the seeded create-flow WO and
 * syncs — the EXACT transport CreateController#saveAssignments uses (set
 * workorder_id on each phantom, POST via store.sync). Deadline conversion is
 * mirrored where saveAssignments would call toUTCString on Date values.
 * Returns per-record server results.
 */
async function syncAssignmentsToWorkorder(page: Page): Promise<{ ok: boolean; detail: string }> {
  return await safeEval(page, async (workorderId?: number) => {
    const Ext = (window as any).Ext;
    const create = Ext.ComponentQuery.query('createworkorder').find((p: any) => p.isVisible?.());
    const store = create.down('workorderassignments').down('grid').getStore();
    const items = store.getData().items.slice();
    for (const rec of items) {
      rec.set('workorder_id', workorderId);
      for (const k of ['initial_arrival_deadline', 'initial_response_deadline', 'completion_deadline']) {
        if (rec.data[k] instanceof Date) rec.data[k] = rec.data[k].toUTCString();
      }
    }
    return await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      store.sync({
        success: (batch: any) => resolve({ ok: true, detail: `synced ${batch.operations.length} operation(s)` }),
        failure: (batch: any) => {
          const msgs = batch.operations.map((op: any) => {
            try { return JSON.stringify(op.getResponse()?.responseJson?.errors ?? op.getError() ?? 'unknown'); }
            catch { return 'unknown'; }
          });
          resolve({ ok: false, detail: msgs.join('; ') });
        },
      });
    });
  }, CREATE_FLOW.workorder_id);
}

// ---------------------------------------------------------------------------
// Scenarios — Regression A from the PR #7073 review (desktop create-WO flow)
// ---------------------------------------------------------------------------

test.describe('Create-WO flow keeps the assignment NTE (PR #7073 Regression A)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  test(`Reopen-then-resave keeps NTE $${FIRST_SAVE_AMOUNT}: grid column, reopened sheet, and created assignment`, async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_78_PR_AC.RegressionA1, TANGO_78_PR_AC.RegressionA2, TANGO_78_PR_AC.RegressionA3],
    });
    test.skip(testInfo.project.name !== 'admin', 'create-WO flow proven once, as admin');

    resetCreateFlowWorkorder();

    await test.step('Open Create Work Order and select the seeded facility', async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      await openCreateWorkorderScreen(page);
    });
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step(`Add an assignment via the sheet: QA vendor, NTE=$${FIRST_SAVE_AMOUNT}, save`, async () => {
      const err = await addAssignmentViaSheet(page, FIRST_SAVE_AMOUNT, '[QA] TANGO-78 create-flow reopen-resave');
      expect(err, 'assignment sheet fill/save').toBeNull();
    });

    await test.step(`Observation 1 guard: grid Facility NTE column shows ${FIRST_SAVE_AMOUNT} (flat field written on the phantom record)`, async () => {
      const state = await newestGridRecordNte(page);
      expect(state.flat, 'flat subcontractor_not_to_exceed.amount on the phantom record').toBe(FIRST_SAVE_AMOUNT);
      expect(Number(state.nested?.amount), 'nested NTE object built by save()').toBe(FIRST_SAVE_AMOUNT);
      expect(state.cellText, 'rendered Facility NTE grid cell').toContain(String(FIRST_SAVE_AMOUNT));
    });

    await test.step(`Observation 2 guard: reopened edit sheet shows ${FIRST_SAVE_AMOUNT}, not blank`, async () => {
      const shown = await reopenNewestAssignmentSheet(page);
      expect(shown, 'NTE field on the reopened sheet').toBe(FIRST_SAVE_AMOUNT);
    });

    await test.step('Re-save the reopened sheet untouched (the data-loss step)', async () => {
      await saveOpenSheet(page);
      const state = await newestGridRecordNte(page);
      expect(state.flat, 'flat NTE survives the untouched re-save').toBe(FIRST_SAVE_AMOUNT);
      expect(Number(state.nested?.amount), `nested NTE must NOT become '' on re-save`).toBe(FIRST_SAVE_AMOUNT);
    });

    await test.step(`Observation 3 guard: sync to WO #${CREATE_FLOW.workorder_id} persists an active NTE of $${FIRST_SAVE_AMOUNT}`, async () => {
      const sync = await syncAssignmentsToWorkorder(page);
      expect(sync.ok, `store.sync (saveAssignments transport): ${sync.detail}`).toBe(true);
      const ntes = createFlowAssignmentNtes();
      expect(ntes.length, 'exactly one assignment created').toBe(1);
      expect(ntes[0].amount, 'persisted NTE amount').toBeCloseTo(FIRST_SAVE_AMOUNT, 2);
      expect(ntes[0].active, 'persisted NTE active').toBe(true);
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: page.getByText(String(FIRST_SAVE_AMOUNT)).first(),
    });
  });

  test(`Immediate sync (no reopen) also persists NTE $${IMMEDIATE_AMOUNT} — reviewer's Note stays true`, async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_78_PR_AC.RegressionANote] });
    test.skip(testInfo.project.name !== 'admin', 'create-WO flow proven once, as admin');

    resetCreateFlowWorkorder();

    await test.step('Open Create Work Order, add assignment with NTE, sync immediately', async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      await openCreateWorkorderScreen(page);
      const err = await addAssignmentViaSheet(page, IMMEDIATE_AMOUNT, '[QA] TANGO-78 create-flow immediate');
      expect(err, 'assignment sheet fill/save').toBeNull();
      const sync = await syncAssignmentsToWorkorder(page);
      expect(sync.ok, `store.sync: ${sync.detail}`).toBe(true);
    });

    await test.step(`Assert DB: active NTE $${IMMEDIATE_AMOUNT} on the created assignment`, async () => {
      const ntes = createFlowAssignmentNtes();
      expect(ntes.length).toBe(1);
      expect(ntes[0].amount).toBeCloseTo(IMMEDIATE_AMOUNT, 2);
      expect(ntes[0].active).toBe(true);
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: page.getByText(String(IMMEDIATE_AMOUNT)).first(),
    });
  });
});
