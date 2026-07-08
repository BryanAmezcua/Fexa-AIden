import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, captureAcSnapshot, TANGO_78_PR_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-78';

const MANIFEST_PATH = path.resolve(__dirname, '../../reports/seed-manifest-tango-78.json');

interface SeedManifest {
  fixtures: Array<{
    key: string;
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
const FIXTURE = MANIFEST.fixtures.find((f) => f.key === 'merge')!;

// ---------------------------------------------------------------------------
// Ext-side helpers (same patterns as assignment-nte-revert.spec)
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

interface RowIntegrity {
  category: any;
  categoryCellText: string;
  statusField: any;
  statusPath: any;
  statusCellText: string;
  deadlines: Record<string, string | null>;
}

/**
 * Reads the fields Regression C showed can be corrupted by a convert-rerunning
 * merge: the category convert output (+ its rendered cell), the status convert
 * output (+ its rendered cell via object_state.status.name), and the date
 * fields, straight off the grid record and rendered row.
 */
async function readRowIntegrity(page: Page, assignmentId: number): Promise<RowIntegrity> {
  return await safeEval(page, (asnId) => {
    const Ext = (window as any).Ext;
    const panel = Ext.ComponentQuery.query('workorderassignments').find((p: any) => {
      const items = p.down?.('grid')?.getStore?.()?.getData?.()?.items ?? [];
      return items.some((r: any) => r?.data?.id === asnId);
    });
    const grid = panel.down('grid');
    const rec = (grid.getStore().getData()?.items ?? []).find((r: any) => r?.data?.id === asnId);
    const cellText = (dataIndex: string) => {
      try {
        const col = grid.getColumns().find((c: any) => c.getDataIndex?.() === dataIndex);
        return grid.getItem(rec)?.getCellByColumn?.(col)?.el?.dom?.innerText ?? '<no cell>';
      } catch { return '<no cell>'; }
    };
    const iso = (v: any) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
    return {
      category: rec.data.category,
      categoryCellText: cellText('category_id'),
      statusField: rec.data.status,
      statusPath: rec.data['object_state.status.name'],
      statusCellText: cellText('object_state.status.name'),
      deadlines: {
        completion_deadline: iso(rec.data.completion_deadline),
        initial_arrival_deadline: iso(rec.data.initial_arrival_deadline),
        initial_response_deadline: iso(rec.data.initial_response_deadline),
      },
    };
  }, assignmentId);
}

/** Opens the assignment edit sheet and waits for the TANGO-78 refetch+bind. */
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
  const body = resp.request().postDataJSON() ?? {};
  const payload = Array.isArray(body.assignments) ? body.assignments[0] : body.assignments ?? body;
  return { payload, status: resp.status() };
}

// ---------------------------------------------------------------------------
// Scenarios — Regression C from the PR #7073 review (desktop refetch merge)
// ---------------------------------------------------------------------------

test.describe('Edit-sheet refetch merge preserves grid record integrity (PR #7073 Regression C)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test('Open-then-cancel leaves Category, Status and deadlines untouched (converts not re-run)', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_78_PR_AC.RegressionC, TANGO_78_PR_AC.RegressionCMechanism],
    });
    test.skip(testInfo.project.name !== 'admin', 'merge integrity proven once, as admin');

    await test.step(`Open WO Overview #${FIXTURE.workorder_id} and note the assignment row's Category/Status`, async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      const accessible = await openWorkorderOverview(page, FIXTURE.workorder_id, FIXTURE.assignment_id);
      expect(accessible, 'admin must reach the WO Overview').toBe(true);
    });

    const before = await readRowIntegrity(page, FIXTURE.assignment_id);
    expect(before.category, 'seeded parent-child category must render as "Parent | Child" before the sheet opens')
      .toMatch(/\S+ \| \S+/);
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step('Double-click-equivalent: open the edit sheet (triggers the refetch+merge), then Cancel immediately', async () => {
      await openAssignmentSheet(page, FIXTURE.assignment_id);
      await closeSheetIfOpen(page);
    });

    await test.step('Assert the row survived the merge byte-for-byte', async () => {
      const after = await readRowIntegrity(page, FIXTURE.assignment_id);
      expect(after.category, `category must not be blanked by a re-run convert (was "${before.category}")`)
        .toBe(before.category);
      expect(after.categoryCellText, 'rendered Category cell').toBe(before.categoryCellText);
      expect(after.statusPath, 'object_state.status.name (the status the grid renders)').toBe(before.statusPath);
      expect(after.statusCellText, 'rendered Status cell').toBe(before.statusCellText);
      expect(after.statusField, 'status field must never read "Pending Create" after a merge').not.toBe('Pending Create');
      expect(after.deadlines, 'date fields unchanged (idempotence guard)').toEqual(before.deadlines);
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: page.getByText(before.category).first(),
    });
  });

  test('Save after the refetch carries no category/status keys and the row stays intact', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_78_PR_AC.RegressionCMechanism] });
    test.skip(testInfo.project.name !== 'admin', 'merge integrity proven once, as admin');

    await test.step(`Open WO Overview #${FIXTURE.workorder_id}, open the sheet, edit Scope only, Save`, async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      const accessible = await openWorkorderOverview(page, FIXTURE.workorder_id, FIXTURE.assignment_id);
      expect(accessible, 'admin must reach the WO Overview').toBe(true);
    });
    const before = await readRowIntegrity(page, FIXTURE.assignment_id);
    await captureAcSnapshot(testInfo, page, 'before');

    let putPayload: any;
    await test.step('Save with only Scope changed and capture the PUT', async () => {
      await openAssignmentSheet(page, FIXTURE.assignment_id);
      await setSheetField(page, 'scope', '[QA] TANGO-78 refetch-merge scope edit');
      const { payload, status } = await saveSheetAndCapturePut(page, FIXTURE.assignment_id);
      expect(status).toBe(200);
      putPayload = payload;
    });

    await test.step('Assert the PUT carries neither a corrupted category nor a convert-artifact status', async () => {
      expect(putPayload?.category, 'no category key in the PUT (merge must not dirty it)').toBeUndefined();
      expect(putPayload?.status, 'no status key in the PUT (merge must not dirty it)').toBeUndefined();
    });

    await test.step('Assert the grid row still shows the category after the post-save store reload', async () => {
      await page.waitForTimeout(2500); // post-save store.load
      const after = await readRowIntegrity(page, FIXTURE.assignment_id);
      expect(after.category).toBe(before.category);
      expect(after.statusField).not.toBe('Pending Create');
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: page.getByText(before.category).first(),
    });
  });
});
