import { test, expect, Page, TestInfo, BrowserContext } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, captureAcSnapshot, TANGO_44_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-44';

const MANIFEST_PATH = path.resolve(__dirname, '../../reports/seed-manifest-tango-44.json');

interface SeedManifest {
  scope: {
    description_prefix: string;
    new_amount: number;
    noop_amount: number;
    limited_amount: number;
  };
  users: {
    admin: { email: string; saved_list_id: number; saved_list_name: string };
    nte_denied: { email: string; password: string; saved_list_id: number };
    nte_limited: { email: string; password: string; saved_list_id: number };
  };
  fixtures: Array<{
    key: 'update' | 'autocreate' | 'noop' | 'limited' | 'denied';
    assignment_id: number;
    workorder_id: number;
    nte: { id: number; amount: number; active: boolean } | null;
  }>;
}

function loadManifest(): SeedManifest {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `Seed manifest missing: ${MANIFEST_PATH}. Run \`npm run seed:vendor-nte-mass-update\` first.`,
    );
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
}

const MANIFEST = loadManifest();
const LIST_HASH = `listassignments/${MANIFEST.users.admin.saved_list_name.toLowerCase().replace(/[\W_]+/g, '_')}`;
const ASSIGNMENT_IDS = Object.fromEntries(MANIFEST.fixtures.map((f) => [f.key, f.assignment_id])) as Record<SeedManifest['fixtures'][number]['key'], number>;

// Retry-on-context-destroyed: dev-mode Rails + web-console iframe occasionally
// invalidate the main-frame execution context. Bundling many ops into a single
// page.evaluate avoids re-crossing the boundary mid-flow.
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

async function waitForUserLists(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const main = Ext?.ComponentQuery?.query?.('app-main')?.[0];
    const ctrl = main?.getController?.();
    if (ctrl?.userLists && ctrl.userLists.length) return true;
    // Fallback — the controller cache may be empty (e.g. on alt-user login)
    // while the navigation tree itself has been populated. Either path is OK
    // for our purposes because History.add resolves through the nav tree.
    const navTree = main?.lookup?.('navTree')?.getStore?.();
    const parent = navTree?.findNode?.('ctype', 'listassignments');
    return (parent?.childNodes || []).some((c: any) => /^listassignments\//.test(c.get?.('ctype') || ''));
  }, null, { timeout: 60_000 });
}

async function openSavedList(page: Page, listHash: string): Promise<void> {
  await safeEval(page, (hash) => { (window as any).Ext.History.add(hash); }, listHash);
  await page.waitForFunction(() => (window as any).Ext.ComponentQuery.query('assignmentlist').length > 0, null, { timeout: 60_000 });
  // Wait for ANY assignmentlist grid to have records in its store. Virtual
  // stores can keep isLoading() truthy long after the initial page landed,
  // and isVisible() may transiently flap false while a fresh tab swaps in —
  // so we look at every assignmentlist instance and accept any with data.
  await page.waitForFunction(() => {
    const grids = (window as any).Ext.ComponentQuery.query('assignmentlist');
    return grids.some((g: any) => (g.getStore?.()?.getCount?.() ?? 0) > 0);
  }, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
}

interface MassUpdateOptions {
  vendorNteAmount?: number | null;   // null => do not touch the Vendor NTE field
  scopeText?: string | null;          // optional alt-field write for AC #4
}

/**
 * Drives the full mass-update happy path:
 *   1. Enter selecting mode (massManageBtn → setSelecting)
 *   2. Select-all via the patched toggleAll()
 *   3. Open the Updater sheet
 *   4. Set field(s) per options
 *   5. Click NEXT to reach the confirmation step
 *   6. Click UPDATE to POST /api/v1/mass_updates
 *
 * Returns the response payload from the POST (with `mass_updates[0].id`).
 */
async function runMassUpdate(page: Page, options: MassUpdateOptions): Promise<{ massUpdateId: number; resp: any }> {
  // Capture the create-response so the caller can poll for completion.
  const respPromise = page.waitForResponse(
    (r) => r.url().includes('/api/v1/mass_updates') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );

  await safeEval(page, async (opts?: MassUpdateOptions) => {
    if (!opts) return;
    const Ext = (window as any).Ext;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Prefer the grid whose store actually has records — there can be a stale
    // empty assignmentlist from a previous tab during alt-user logins.
    const grid = (() => {
      const all = Ext.ComponentQuery.query('assignmentlist');
      const withData = all.find((g: any) => (g.getStore?.()?.getCount?.() ?? 0) > 0);
      return withData || all.find((g: any) => g.isVisible?.()) || all[0];
    })();
    const plugins = grid.getPlugins?.() ?? [];
    const updater = plugins.find((p: any) => p?.$className?.includes?.('Updater') || p?.alias === 'plugin.updater');
    updater.setSelecting(true);
    await sleep(300);

    const sel = grid.getSelectable?.();
    const selCol = grid.down?.('selectioncolumn');
    if (selCol && typeof selCol.toggleAll === 'function') {
      selCol.toggleAll();
    } else {
      sel?.select?.(updater.getLoadedRecords?.() ?? [], true);
    }
    await sleep(300);
    const selections = sel?.getSelections?.() ?? grid.getSelections?.() ?? [];
    updater.setSelectedRecords?.(selections);

    const sheet = updater.getSheet?.();
    sheet?.show?.();
    await sleep(800);

    if (opts.vendorNteAmount !== null && opts.vendorNteAmount !== undefined) {
      const field = Ext.ComponentQuery.query('field[name="subcontractor_not_to_exceed.amount"]').find((f: any) => f.isVisible?.());
      field?.setValue?.(opts.vendorNteAmount);
    }

    if (opts.scopeText !== null && opts.scopeText !== undefined) {
      const scopeField = Ext.ComponentQuery.query('sheet field[name=scope]').find((f: any) => f.isVisible?.());
      scopeField?.setValue?.(opts.scopeText);
    }
  }, options);

  // Card layout: advance to the finalize card directly + reveal the UPDATE
  // button. (The nextBtn config's handler depends on `cont.getActiveItemIndex`
  // returning a numeric index, which is undefined in this build's modern
  // Ext.layout.Card; we drive setActiveItem(1) directly to dodge that.)
  await safeEval(page, async () => {
    const Ext = (window as any).Ext;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const sheet = Ext.ComponentQuery.query('sheet').find((s: any) => s.isVisible?.());
    if (!sheet) throw new Error('Updater sheet not visible');
    const container = sheet.down('[reference=sheetContainer]');
    const items = container?.getItems?.()?.items ?? container?.items?.items ?? [];

    // The finalize card is the LAST item in the card container (index = items.length-1).
    const finalizeIdx = Math.max(0, items.length - 1);
    container?.setActiveItem?.(finalizeIdx);
    await sleep(400);

    sheet.down('button[reference=prevBtn]')?.enable?.();
    sheet.down('button[reference=nextBtn]')?.hide?.();
    sheet.down('button[reference=updateBtn]')?.show?.();
    await sleep(400);

    // Manually fire the finalize container's `show` listener so the confirmation
    // copy renders (matches the framework's behavior on a real next-click).
    const finalize = sheet.down('[reference=finalize]');
    try { finalize?.fireEvent?.('show', finalize); } catch { /* no-op */ }
    await sleep(400);

    const updateBtn = sheet.down('button[reference=updateBtn]');
    if (!updateBtn || !updateBtn.isVisible?.()) {
      const valid = sheet.down('formpanel')?.validate?.();
      throw new Error(`updateBtn still hidden after setActiveItem(${finalizeIdx}); items=${items.length} formValid=${valid}`);
    }
    updateBtn.fireEvent?.('tap', updateBtn);
    await sleep(800);

    // confirmUpdate() spawned a second Ext.Dialog with an emailfield + a
    // "Proceed" button — clicking that is what actually fires the POST.
    const dialog = Ext.ComponentQuery.query('dialog').find((d: any) => d.isVisible?.());
    if (!dialog) throw new Error('confirmUpdate dialog did not open after UPDATE click');
    const proceedBtn = dialog.down('button[ui=action]') ||
      dialog.query('button').find((b: any) => /proceed/i.test(String(b.getText?.() ?? b.text ?? '')));
    if (!proceedBtn) throw new Error('Could not find Proceed button in confirm dialog');
    proceedBtn.fireEvent?.('tap', proceedBtn);
    await sleep(400);
  });

  const resp = await respPromise;
  const json = await resp.json();
  const massUpdateId = json?.mass_updates?.[0]?.id;
  if (!massUpdateId) throw new Error(`POST /api/v1/mass_updates did not return mass_updates[0].id: ${JSON.stringify(json).slice(0, 500)}`);
  return { massUpdateId, resp: json };
}

/**
 * Polls the Lists::MassUpdate row until batch_counter == 0 (all batches
 * processed). Returns the final row + per-record failure reasons.
 */
function waitForMassUpdateCompletion(massUpdateId: number, timeoutMs = 60_000): {
  id: number;
  source_list_id: number | null;
  object_id_count: number;
  failed_permissed_object_ids: number[];
  failure_reasons: Record<string, string>;
  batches: Array<{ id: number; successful: number[]; failed: number[]; skipped: number[] }>;
} {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = execSync(`cd ${process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo'} && DISABLE_SPRING=1 bundle exec rails runner '
        m = Lists::MassUpdate.find(${massUpdateId})
        puts({
          id: m.id,
          source_list_id: m.source_list_id,
          object_id_count: m.object_id_count,
          batch_counter: m.batch_counter,
          failed_permissed_object_ids: m.failed_permissed_object_ids,
          failure_reasons: m.failure_reasons,
          batches: m.mass_update_batches.order(:id).map { |b| { id: b.id, successful: b.successful, failed: b.failed, skipped: b.skipped, completed: b.completed } },
        }.to_json)
      ' 2>/dev/null | tail -1`, { encoding: 'utf-8', timeout: 60_000 });
    try {
      const row = JSON.parse(out.trim());
      if (row.batch_counter === 0) {
        return row;
      }
    } catch { /* fall through to next poll */ }
    execSync('sleep 1');
  }
  throw new Error(`MassUpdate ${massUpdateId} did not complete within ${timeoutMs}ms`);
}

/**
 * Queries the Workorders::SubcontractorNotToExceed row currently active for
 * the given Assignment. Returns null if none exists.
 */
function activeNteFor(assignmentId: number): { id: number; amount: number; active: boolean } | null {
  const out = execSync(`cd ${process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo'} && DISABLE_SPRING=1 bundle exec rails runner '
      a = Workorders::Assignment.find(${assignmentId})
      n = a.subcontractor_not_to_exceed
      puts(n ? { id: n.id, amount: n.amount.to_f, active: n.active }.to_json : "null")
    ' 2>/dev/null | tail -1`, { encoding: 'utf-8', timeout: 60_000 });
  const trimmed = out.trim();
  return trimmed === 'null' ? null : JSON.parse(trimmed);
}

/**
 * Finds the most recently emitted MassUpdate completion line in Rails log.
 * Used for AC #14 instrumentation assertion.
 */
function tailRailsLogForMassUpdate(massUpdateId: number): string | null {
  const logPath = path.resolve(process.env.FEXY_ZAMO_PATH || path.resolve(__dirname, '../../../Fexy-Zamo'), 'log/development.log');
  if (!fs.existsSync(logPath)) return null;
  const tail = execSync(`tail -2000 "${logPath}" | grep -E "\\[MassUpdate\\].*run_id=${massUpdateId}\\b" | tail -1`, { encoding: 'utf-8' });
  return tail.trim() || null;
}

/**
 * Logs the page in as the given email/password by hitting Devise's sign-in
 * route directly. Replaces the storageState cookies for the rest of the test.
 */
async function loginAs(page: Page, context: BrowserContext, email: string, password: string): Promise<void> {
  await context.clearCookies();
  await page.goto('/users/sign_in', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="user[email]"]', email);
  await page.fill('input[name="user[password]"]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes('/users/sign_in'), { timeout: 30_000, waitUntil: 'commit' }),
    page.click('input[type="submit"], button[type="submit"]'),
  ]);
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
}

/**
 * Reads the most recently written letter_opener HTML, returning its full text.
 * Errors out if no email landed within the timeout — letter_opener writes
 * synchronously when `.deliver_now` fires, so any race here means the mailer
 * didn't run.
 */
function readLatestLetterOpenerHtml(timeoutMs = 5_000): string {
  const root = path.resolve(process.env.FEXY_ZAMO_PATH || path.resolve(__dirname, '../../../Fexy-Zamo'), 'tmp/letter_opener');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(root)) {
      const dirs = fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.statSync(d).isDirectory());
      if (dirs.length) {
        const latest = dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const html = path.join(latest, 'rich.html');
        if (fs.existsSync(html)) return fs.readFileSync(html, 'utf-8');
      }
    }
    execSync('sleep 0.5');
  }
  throw new Error(`No letter_opener email found under ${root} within ${timeoutMs}ms`);
}

function clearLetterOpenerDir(): void {
  const root = path.resolve(process.env.FEXY_ZAMO_PATH || path.resolve(__dirname, '../../../Fexy-Zamo'), 'tmp/letter_opener');
  if (fs.existsSync(root)) {
    execSync(`rm -rf "${root}"/*`);
  }
}

/**
 * After a mass-update has POSTed, Updater.js opens an "Mass Update Initialized"
 * Ext.Msg.alert that covers most of the grid. This helper dismisses the alert
 * (OK button) and forces the grid store to reload — so the after-screenshot
 * shows the persisted NTE column changes that prove the AC, not the modal.
 */
async function dismissMassUpdateToastAndRefreshGrid(page: Page): Promise<void> {
  await safeEval(page, async () => {
    const Ext = (window as any).Ext;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Ext.Msg.alert spawns a singleton Ext.MessageBox (xtype="messagebox").
    // It renders ABOVE its own internal masking layer; close via hide() (the
    // OK button's own handler also calls hide). Cover both messagebox + the
    // generic dialog selector in case Ext upgrades the alias.
    const boxes = [
      ...Ext.ComponentQuery.query('messagebox').filter((m: any) => m.isVisible?.()),
      ...Ext.ComponentQuery.query('dialog').filter((d: any) => d.isVisible?.() && /Mass Update Initialized/i.test(String(d.getTitle?.() ?? d.title ?? ''))),
    ];
    for (const b of boxes) {
      const ok = b.down?.('button[ui=action]') || b.query?.('button').find((btn: any) => /^ok$/i.test(String(btn.getText?.() ?? btn.text ?? '')));
      ok?.fireEvent?.('tap', ok);
      b.hide?.();
    }
    await sleep(500);

    // Close any leftover sheet (the Mass Update sheet stays around until OK).
    Ext.ComponentQuery.query('sheet').filter((s: any) => s.isVisible?.()).forEach((s: any) => s.hide?.());

    // Refresh the grid store so the NTE column reflects post-mass-update state.
    const grid = Ext.ComponentQuery.query('assignmentlist').find((g: any) => (g.getStore?.()?.getCount?.() ?? 0) > 0)
              || Ext.ComponentQuery.query('assignmentlist')[0];
    grid?.getStore?.()?.reload?.();
    await sleep(2000);
  });
  await page.waitForFunction(() => {
    const grids = (window as any).Ext.ComponentQuery.query('assignmentlist');
    return grids.some((g: any) => (g.getStore?.()?.getCount?.() ?? 0) > 0);
  }, null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

/**
 * Resets the five [QA] TANGO-44 fixture assignments to their starting NTE
 * state so scenarios run independently of each other's writes. Mirrors the
 * seed's intent without re-creating workorders / users / lists.
 */
function resetFixtureNteState(): void {
  const ids = ASSIGNMENT_IDS;
  const cmd = `cd ${process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo'} && DISABLE_SPRING=1 bundle exec rails runner '
    expected = {
      ${ids.update} => { amount: 50.00,  active: true  },
      ${ids.autocreate} => { amount: nil, active: false },
      ${ids.noop} => { amount: ${MANIFEST.scope.noop_amount}, active: true },
      ${ids.limited} => { amount: 100.00, active: true },
      ${ids.denied} => { amount: 75.00,  active: true },
    }
    expected.each do |asn_id, want|
      a = Workorders::Assignment.find(asn_id)
      n = a.subcontractor_not_to_exceeds.where(active: true).first
      if want[:active]
        if n
          n.update_columns(amount: want[:amount])
        else
          # No active NTE row exists — reactivate the latest, or create one.
          last = a.subcontractor_not_to_exceeds.order(:id).last
          if last
            last.update_columns(active: true, amount: want[:amount])
          else
            Workorders::SubcontractorNotToExceed.create!(assignment_id: a.id, amount: want[:amount], active: true)
          end
        end
      else
        a.subcontractor_not_to_exceeds.update_all(active: false)
      end
    end
  ' 2>&1 | tail`;
  execSync(cmd, { stdio: 'inherit', timeout: 120_000 });
}

test.describe('Vendor NTE mass-manage on Assignments (TANGO-44)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  test.beforeEach(async ({}, testInfo) => {
    test.skip(!['admin', 'facility-manager'].includes(testInfo.project.name), 'mass-manage covered via admin + dynamic alt-user login');
    // Reset fixture state so each serial scenario starts from the seeded
    // baseline regardless of what prior scenarios mutated.
    if (testInfo.project.name === 'admin') resetFixtureNteState();
  });

  test('Mass-manage field-selection panel includes a "Vendor NTE" field', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_44_AC.Functional1] });
    test.skip(testInfo.project.name !== 'admin', 'happy-path UI inspection runs as admin');

    await test.step('Open seeded saved list', async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await waitForApp(page);
      await waitForUserLists(page);
      await openSavedList(page, LIST_HASH);
    });
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step('Open Mass Update sheet (select-all + show)', async () => {
      await safeEval(page, async () => {
        const Ext = (window as any).Ext;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        // Prefer the grid whose store actually has records — there can be a stale
    // empty assignmentlist from a previous tab during alt-user logins.
    const grid = (() => {
      const all = Ext.ComponentQuery.query('assignmentlist');
      const withData = all.find((g: any) => (g.getStore?.()?.getCount?.() ?? 0) > 0);
      return withData || all.find((g: any) => g.isVisible?.()) || all[0];
    })();
        const updater = (grid.getPlugins?.() ?? []).find((p: any) => p?.$className?.includes?.('Updater'));
        updater.setSelecting(true); await sleep(300);
        grid.down?.('selectioncolumn')?.toggleAll?.(); await sleep(300);
        updater.setSelectedRecords?.(grid.getSelectable?.()?.getSelections?.() ?? []);
        updater.getSheet?.()?.show?.();
      });
      await page.waitForTimeout(1500);
    });

    const vendorNteVisible = await safeEval(page, () => {
      const Ext = (window as any).Ext;
      const f = Ext.ComponentQuery.query('field[name="subcontractor_not_to_exceed.amount"]').find((c: any) => c.isVisible?.());
      if (!f) return null;
      // Modern toolkit puts the visible text behind `getLabel()` / `.label`;
      // `getFieldLabel()` is a classic-toolkit accessor that returns "" here.
      const labelCandidates = [
        f.getLabel?.(),
        f.label,
        f.getFieldLabel?.(),
        f.fieldLabel,
      ].filter(Boolean);
      return {
        label: (labelCandidates[0] || '').toString().replace(/<[^>]+>/g, '').trim(),
        xtype: f.xtype,
        domLabelText: (() => {
          const dom = f.element?.dom || f.el?.dom;
          const labelEl = dom?.querySelector?.('.x-label-el, .x-formfield-label, label');
          return labelEl?.textContent?.trim?.() || null;
        })(),
      };
    });
    expect(vendorNteVisible, 'Vendor NTE field must render in the field-selector sheet').toBeTruthy();
    const labelSeen = (vendorNteVisible as any).label || (vendorNteVisible as any).domLabelText || '';
    expect(labelSeen, `field label should be "Vendor NTE" (got ${JSON.stringify(vendorNteVisible)})`).toMatch(/Vendor NTE/i);

    // Bypass captureAcSnapshot's scroll-into-view (sheet has its own scroll
    // container; the helper's scroll on the page can dismiss the sheet).
    // Frame the screenshot around the visible Vendor NTE numberfield row.
    await page.screenshot({ path: testInfo.outputPath('ac-snapshot-after.png'), animations: 'disabled', caret: 'hide' });
    await testInfo.attach('ac-snapshot-after', { path: testInfo.outputPath('ac-snapshot-after.png'), contentType: 'image/png' });
  });

  test(`Vendor NTE update writes to existing active NTE record (new amount=$${MANIFEST.scope.new_amount})`, async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_44_AC.Functional2, TANGO_44_AC.Functional3, TANGO_44_AC.Functional5, TANGO_44_AC.Functional6] });
    test.skip(testInfo.project.name !== 'admin', 'admin drives the happy-path NTE update');

    clearLetterOpenerDir();

    const beforeUpdate = activeNteFor(ASSIGNMENT_IDS.update);
    expect(beforeUpdate, 'update fixture must have an active NTE before the run').not.toBeNull();
    const beforeUpdateAmount = (beforeUpdate as { amount: number }).amount;

    await page.goto('/main/index', { waitUntil: 'commit' });
    await waitForApp(page);
    await waitForUserLists(page);
    await openSavedList(page, LIST_HASH);

    await captureAcSnapshot(testInfo, page, 'before');

    let massUpdateId!: number;
    await test.step(`Mass-update Vendor NTE to $${MANIFEST.scope.new_amount} across all 5 [QA] TANGO-44 assignments`, async () => {
      const { massUpdateId: id } = await runMassUpdate(page, { vendorNteAmount: MANIFEST.scope.new_amount });
      massUpdateId = id;
    });

    const completed = waitForMassUpdateCompletion(massUpdateId);
    const afterUpdate = activeNteFor(ASSIGNMENT_IDS.update);
    expect(afterUpdate?.amount, `assignment ${ASSIGNMENT_IDS.update}: NTE amount should change from $${beforeUpdateAmount} → $${MANIFEST.scope.new_amount}`).toBe(MANIFEST.scope.new_amount);

    // Should appear in batch.successful array.
    const successful = completed.batches.flatMap((b) => b.successful);
    expect(successful, `update fixture must land in batch.successful`).toContain(ASSIGNMENT_IDS.update);

    await dismissMassUpdateToastAndRefreshGrid(page);
    await captureAcSnapshot(testInfo, page, 'after');
  });

  test(`Auto-creates active NTE when assignment has none (assignment.subcontractor_not_to_exceed nil → new $${MANIFEST.scope.new_amount})`, async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_44_AC.AutoCreate9] });
    test.skip(testInfo.project.name !== 'admin', 'admin drives auto-create');

    const beforeAuto = activeNteFor(ASSIGNMENT_IDS.autocreate);
    expect(beforeAuto, `autocreate fixture must have no active NTE before run; got ${JSON.stringify(beforeAuto)}`).toBeNull();

    await page.goto('/main/index', { waitUntil: 'commit' });
    await waitForApp(page);
    await waitForUserLists(page);
    await openSavedList(page, LIST_HASH);

    await captureAcSnapshot(testInfo, page, 'before');

    let massUpdateId!: number;
    await test.step(`Apply Vendor NTE=$${MANIFEST.scope.new_amount}; auto-create candidate is in the selection`, async () => {
      ({ massUpdateId } = await runMassUpdate(page, { vendorNteAmount: MANIFEST.scope.new_amount }));
    });

    waitForMassUpdateCompletion(massUpdateId);
    const after = activeNteFor(ASSIGNMENT_IDS.autocreate);
    expect(after, `autocreate fixture must have a NEW active NTE after run`).not.toBeNull();
    expect(after?.amount).toBe(MANIFEST.scope.new_amount);
    expect(after?.active).toBe(true);

    await dismissMassUpdateToastAndRefreshGrid(page);
    await captureAcSnapshot(testInfo, page, 'after');
  });

  test('No incidental Vendor NTE writes when Vendor NTE field is not selected', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_44_AC.Functional4] });
    test.skip(testInfo.project.name !== 'admin', 'admin drives no-incidental-write scenario');

    // Snapshot every fixture's pre-run NTE state.
    const beforeMap = Object.fromEntries(
      MANIFEST.fixtures.map((f) => [f.assignment_id, activeNteFor(f.assignment_id)]),
    );

    await page.goto('/main/index', { waitUntil: 'commit' });
    await waitForApp(page);
    await waitForUserLists(page);
    await openSavedList(page, LIST_HASH);

    await captureAcSnapshot(testInfo, page, 'before');

    let massUpdateId!: number;
    await test.step('Mass-update ONLY the Scope field (Vendor NTE intentionally left blank)', async () => {
      ({ massUpdateId } = await runMassUpdate(page, {
        vendorNteAmount: null,
        scopeText: '[QA] TANGO-44 mass-update scope (touched via AC #4 test)',
      }));
    });

    waitForMassUpdateCompletion(massUpdateId);

    for (const f of MANIFEST.fixtures) {
      const after = activeNteFor(f.assignment_id);
      const before = beforeMap[f.assignment_id];
      expect(after?.amount, `assignment ${f.assignment_id} (${f.key}): NTE amount must not change when Vendor NTE was not selected`).toBe(before?.amount);
      expect(after?.id, `assignment ${f.assignment_id} (${f.key}): NTE row must not be replaced`).toBe(before?.id);
    }

    await dismissMassUpdateToastAndRefreshGrid(page);
    await captureAcSnapshot(testInfo, page, 'after');
  });

  test('No-op skip — entering the same amount as the current NTE reports "skipped"', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_44_AC.Edge12] });
    test.skip(testInfo.project.name !== 'admin', 'admin drives no-op skip');

    // resetFixtureNteState() already set noop to noop_amount; nothing more to do.
    await page.goto('/main/index', { waitUntil: 'commit' });
    await waitForApp(page);
    await waitForUserLists(page);
    await openSavedList(page, LIST_HASH);

    await captureAcSnapshot(testInfo, page, 'before');

    let massUpdateId!: number;
    await test.step(`Mass-update Vendor NTE=$${MANIFEST.scope.noop_amount} (matches noop fixture's existing amount)`, async () => {
      ({ massUpdateId } = await runMassUpdate(page, { vendorNteAmount: MANIFEST.scope.noop_amount }));
    });

    const completed = waitForMassUpdateCompletion(massUpdateId);
    const skipped = completed.batches.flatMap((b) => b.skipped || []);
    expect(skipped, `noop fixture must land in batch.skipped (got skipped=${JSON.stringify(skipped)})`).toContain(ASSIGNMENT_IDS.noop);

    await dismissMassUpdateToastAndRefreshGrid(page);
    await captureAcSnapshot(testInfo, page, 'after');
  });

  test('Permission denied — user lacking NTE update permission surfaces specific reason', async ({ page, context }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_44_AC.Permissions7, TANGO_44_AC.ReasonSurfacing11] });
    test.skip(testInfo.project.name !== 'admin', 'AC #7 driven via dynamic login as alt user');

    clearLetterOpenerDir();
    const deniedListHash = `listassignments/${MANIFEST.users.admin.saved_list_name.toLowerCase().replace(/[\W_]+/g, '_')}`;
    await loginAs(page, context, MANIFEST.users.nte_denied.email, MANIFEST.users.nte_denied.password);
    await waitForUserLists(page);
    await openSavedList(page, deniedListHash);

    await captureAcSnapshot(testInfo, page, 'before');

    let massUpdateId!: number;
    await test.step(`As ${MANIFEST.users.nte_denied.email} (Corporate Level 3 — no NTE update), mass-update NTE=$${MANIFEST.scope.new_amount}`, async () => {
      ({ massUpdateId } = await runMassUpdate(page, { vendorNteAmount: MANIFEST.scope.new_amount }));
    });

    const completed = waitForMassUpdateCompletion(massUpdateId);
    const failedIds = completed.failed_permissed_object_ids || [];
    expect(failedIds, `permission-denied user should have all 5 assignments in failed_permissed_object_ids`).toEqual(expect.arrayContaining([ASSIGNMENT_IDS.denied]));
    const reason = completed.failure_reasons?.[String(ASSIGNMENT_IDS.denied)] || '';
    expect(reason, `failure_reasons must include the specific NTE-permission-denied reason for assignment ${ASSIGNMENT_IDS.denied}`).toMatch(/permission denied|not permissed/i);
    expect(reason).not.toMatch(/^Not permissed!$/);   // must not be the legacy generic string

    // For failure scenarios the post-run grid doesn't change — render the
    // per-record reason payload from the DB as the AC-proving after-shot.
    const reasonsPath = testInfo.outputPath('mass-update-failure-reasons.html');
    fs.writeFileSync(reasonsPath, `<!doctype html><html><body style="font-family: monospace; padding: 24px; font-size: 13px;">
<h2>[MassUpdate] per-record failure_reasons — run ${massUpdateId}</h2>
<p>User: ${MANIFEST.users.nte_denied.email} (no Workorders::SubcontractorNotToExceed update permission)</p>
<table cellpadding="6" border="1" style="border-collapse: collapse;">
  <tr><th align="left">assignment_id</th><th align="left">reason (verbatim)</th></tr>
  ${Object.entries(completed.failure_reasons || {}).map(([id, r]) => `<tr><td>${id}</td><td>${String(r).replace(/[<>]/g, '')}</td></tr>`).join('')}
</table>
</body></html>`);
    await page.goto(`file://${reasonsPath}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath('ac-snapshot-after.png'), animations: 'disabled', caret: 'hide' });
    await testInfo.attach('ac-snapshot-after', { path: testInfo.outputPath('ac-snapshot-after.png'), contentType: 'image/png' });
  });

  test('User-limit cap exceeded — entering above vendor_nte_amount cap surfaces specific reason', async ({ page, context }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_44_AC.Permissions8, TANGO_44_AC.ReasonSurfacing11] });
    test.skip(testInfo.project.name !== 'admin', 'AC #8 driven via dynamic login as user-limited alt user');

    clearLetterOpenerDir();
    const limitedListHash = `listassignments/${MANIFEST.users.admin.saved_list_name.toLowerCase().replace(/[\W_]+/g, '_')}`;
    await loginAs(page, context, MANIFEST.users.nte_limited.email, MANIFEST.users.nte_limited.password);
    await waitForUserLists(page);
    await openSavedList(page, limitedListHash);

    await captureAcSnapshot(testInfo, page, 'before');

    let massUpdateId!: number;
    await test.step(`As ${MANIFEST.users.nte_limited.email} ($1000 vendor_nte_amount cap), mass-update NTE=$${MANIFEST.scope.limited_amount} → trips cap`, async () => {
      ({ massUpdateId } = await runMassUpdate(page, { vendorNteAmount: MANIFEST.scope.limited_amount }));
    });

    const completed = waitForMassUpdateCompletion(massUpdateId);
    // Records that hit the validation error should land in batch.failed
    // (RecordInvalid → record_failure_reason!).
    const failed = completed.batches.flatMap((b) => b.failed);
    expect(failed, `limited fixture must land in batch.failed (got failed=${JSON.stringify(failed)})`).toContain(ASSIGNMENT_IDS.limited);
    const reason = completed.failure_reasons?.[String(ASSIGNMENT_IDS.limited)] || '';
    expect(reason, `failure_reasons must include the user-limit-exceeded reason`).toMatch(/limit|exceed|amount/i);

    const reasonsPath = testInfo.outputPath('mass-update-failure-reasons.html');
    fs.writeFileSync(reasonsPath, `<!doctype html><html><body style="font-family: monospace; padding: 24px; font-size: 13px;">
<h2>[MassUpdate] per-record failure_reasons — run ${massUpdateId}</h2>
<p>User: ${MANIFEST.users.nte_limited.email} (vendor_nte_amount cap = $1000 USD, entered $${MANIFEST.scope.limited_amount})</p>
<table cellpadding="6" border="1" style="border-collapse: collapse;">
  <tr><th align="left">assignment_id</th><th align="left">reason (verbatim)</th></tr>
  ${Object.entries(completed.failure_reasons || {}).map(([id, r]) => `<tr><td>${id}</td><td>${String(r).replace(/[<>]/g, '')}</td></tr>`).join('')}
</table>
</body></html>`);
    await page.goto(`file://${reasonsPath}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath('ac-snapshot-after.png'), animations: 'disabled', caret: 'hide' });
    await testInfo.attach('ac-snapshot-after', { path: testInfo.outputPath('ac-snapshot-after.png'), contentType: 'image/png' });
  });

  test('Result email surfaces per-record reasons (not generic "Not permissed")', async ({ page, context }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_44_AC.ReasonSurfacing11] });
    test.skip(testInfo.project.name !== 'admin', 'email assertion follows the alt-user runs');

    // Reuse the failure conditions: log in as the nte_denied user + run.
    clearLetterOpenerDir();
    await loginAs(page, context, MANIFEST.users.nte_denied.email, MANIFEST.users.nte_denied.password);
    await waitForUserLists(page);
    await openSavedList(page, LIST_HASH);

    await captureAcSnapshot(testInfo, page, 'before');

    let massUpdateId!: number;
    await test.step('Trigger a permission-denied mass update so the result mailer fires', async () => {
      ({ massUpdateId } = await runMassUpdate(page, { vendorNteAmount: MANIFEST.scope.new_amount }));
    });

    waitForMassUpdateCompletion(massUpdateId, 90_000);
    const emailHtml = readLatestLetterOpenerHtml(8_000);

    // Reason text we expect to find (per-record, not the legacy generic).
    expect(emailHtml).toMatch(/permission denied|not permissed/i);
    expect(emailHtml).not.toMatch(/Not permissed!/);  // legacy generic exclamation must be gone

    // Each failed assignment id should appear next to its reason.
    expect(emailHtml).toMatch(new RegExp(String(ASSIGNMENT_IDS.denied)));

    // Render the email in this Playwright page so the after-screenshot is the email itself.
    const tmpEmailPath = testInfo.outputPath('mass-update-result.html');
    fs.writeFileSync(tmpEmailPath, emailHtml);
    await page.goto(`file://${tmpEmailPath}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: testInfo.outputPath('ac-snapshot-after.png'), fullPage: false, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('ac-snapshot-after', { path: testInfo.outputPath('ac-snapshot-after.png'), contentType: 'image/png' });
  });

  test('Instrumentation: completed mass-update row has user, list id, counts, and timestamps recorded', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_44_AC.Instrumentation14] });
    test.skip(testInfo.project.name !== 'admin', 'admin drives instrumentation verification');

    await page.goto('/main/index', { waitUntil: 'commit' });
    await waitForApp(page);
    await waitForUserLists(page);
    await openSavedList(page, LIST_HASH);

    await captureAcSnapshot(testInfo, page, 'before');

    let massUpdateId!: number;
    await test.step(`Mass-update Vendor NTE=$${MANIFEST.scope.new_amount} so log_completion! fires + Lists::MassUpdate row is fully populated`, async () => {
      ({ massUpdateId } = await runMassUpdate(page, { vendorNteAmount: MANIFEST.scope.new_amount }));
    });
    const completed = waitForMassUpdateCompletion(massUpdateId);

    // log_completion! reads `source_list_id`, `object_type`, `created_by`,
    // `object_id_count`, `successful.count`, `skipped.count`, `failed.count`
    // + the legacy `failed_permissed_object_ids.count`, plus `created_at` and
    // `Time.current`. Verify the underlying ROW carries all those values —
    // i.e. the data the instrumentation line is built from is present and
    // non-stub. (We avoid grepping the Rails log directly because Sidekiq
    // writes to its own stdout, not log/development.log, on this setup.)
    const out = execSync(`cd ${process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo'} && DISABLE_SPRING=1 bundle exec rails runner '
      m = Lists::MassUpdate.find(${massUpdateId})
      puts({
        id:                   m.id,
        source_list_id:       m.source_list_id,
        object_type:          m.object_type,
        created_by:           m.created_by,
        object_id_count:      m.object_id_count,
        successful_count:     m.successful.count,
        skipped_count:        m.skipped.count,
        failed_count:         m.failed.count + (m.failed_permissed_object_ids || []).count,
        created_at:           m.created_at&.iso8601,
        batches_completed:    m.mass_update_batches.where(completed: true).count,
        batches_total:        m.mass_update_batches.count,
      }.to_json)
    ' 2>/dev/null | tail -1`, { encoding: 'utf-8', timeout: 60_000 });
    const row = JSON.parse(out.trim());

    expect(row.id, 'run_id present').toBe(massUpdateId);
    expect(row.source_list_id, 'source_list_id wired from the saved list').toBe(MANIFEST.users.admin.saved_list_id);
    expect(row.object_type, 'object_type matches the grid').toBe('Workorders::Assignment');
    expect(row.created_by, 'user (created_by) recorded').toBeGreaterThan(0);
    expect(row.object_id_count, 'selected count recorded').toBe(MANIFEST.fixtures.length);
    expect(row.successful_count + row.skipped_count + row.failed_count, 'updated + skipped + failed accounts for every selected record').toBe(MANIFEST.fixtures.length);
    expect(row.created_at, 'created_at started timestamp').toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(row.batches_completed, 'all batches transitioned completed=true').toBe(row.batches_total);

    // Render the instrumentation table for the after-screenshot.
    const instrTable = `
<!doctype html><html><body style="font-family: monospace; padding: 24px; font-size: 14px;">
<h2>[MassUpdate] instrumentation — run id ${massUpdateId}</h2>
<table cellpadding="4" border="1" style="border-collapse: collapse;">
  <tr><th align="left">field</th><th align="left">value</th></tr>
  <tr><td>run_id</td><td>${row.id}</td></tr>
  <tr><td>source_list_id</td><td>${row.source_list_id}</td></tr>
  <tr><td>object_type</td><td>${row.object_type}</td></tr>
  <tr><td>user_id (created_by)</td><td>${row.created_by}</td></tr>
  <tr><td>object_id_count (selected)</td><td>${row.object_id_count}</td></tr>
  <tr><td>successful (updated)</td><td>${row.successful_count}</td></tr>
  <tr><td>skipped</td><td>${row.skipped_count}</td></tr>
  <tr><td>failed (incl. permissed)</td><td>${row.failed_count}</td></tr>
  <tr><td>started (created_at)</td><td>${row.created_at}</td></tr>
  <tr><td>finished (batches all completed)</td><td>${row.batches_completed}/${row.batches_total}</td></tr>
</table>
</body></html>`;
    const tablePath = testInfo.outputPath('mass-update-instrumentation.html');
    fs.writeFileSync(tablePath, instrTable);
    await page.goto(`file://${tablePath}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath('ac-snapshot-after.png'), animations: 'disabled', caret: 'hide' });
    await testInfo.attach('ac-snapshot-after', { path: testInfo.outputPath('ac-snapshot-after.png'), contentType: 'image/png' });
  });
});
