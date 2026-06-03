import { test, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const OUT = path.resolve(__dirname, '../../exploration');
fs.mkdirSync(OUT, { recursive: true });

const LIST_NAME = '[QA] TANGO-44 Vendor NTE Mass Update';
const LIST_HASH = `listassignments/${LIST_NAME.toLowerCase().replace(/[\W_]+/g, '_')}`;

async function dump(page: Page, slug: string, data: any): Promise<void> {
  fs.writeFileSync(path.join(OUT, `${slug}.json`), JSON.stringify(data, null, 2));
}

// Retry evaluate to ride out the intermittent "Execution context was destroyed"
// failures that fire when Ext briefly tears down + recreates its main-frame
// context (web-console iframe + framework lifecycle interact badly with the
// rails dev-mode build).
async function safeEval<T, A = any>(page: Page, fn: (arg?: A) => T, arg?: A, attempts = 5): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await (arg === undefined ? page.mainFrame().evaluate(fn as any) : page.mainFrame().evaluate(fn as any, arg)); }
    catch (e) {
      lastErr = e;
      const msg = (e as Error)?.message ?? '';
      if (!/Execution context was destroyed/i.test(msg)) throw e;
      await page.waitForTimeout(1000);
    }
  }
  throw lastErr;
}

async function shot(page: Page, slug: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, `${slug}.png`) }).catch(() => {});
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    if (!Ext?.ComponentQuery) return false;
    try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; }
    catch { return false; }
  }, null, { timeout: 90_000, polling: 1000 });
  await page.waitForTimeout(2000);
}

async function waitForUserLists(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const main = Ext?.ComponentQuery?.query?.('app-main')?.[0];
    const ctrl = main?.getController?.();
    return !!(ctrl?.userLists && ctrl.userLists.length);
  }, null, { timeout: 30_000 });
}

test.use({ storageState: 'auth/admin.json' });
test.setTimeout(240_000);

test('end-to-end mass-manage Vendor NTE flow + selector discovery', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await waitForUserLists(page);
  await safeEval(page, (hash) => { (window as any).Ext.History.add(hash); }, LIST_HASH);
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('assignmentlist').length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('assignmentlist')[0];
    const store = grid?.getStore?.();
    return store && !store.isLoading?.() && store.getCount?.() > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // 0. Bundled snapshot: nav + grid plugins + selecting transition + selectAll + edit-trigger + sheet/field dump
  //    all in ONE evaluate so we never re-cross the page boundary between
  //    operations (every cross-boundary evaluate on this dev-mode build
  //    intermittently dies with "Execution context was destroyed").
  const bundle = await safeEval(page, async () => {
    const Ext = (window as any).Ext;
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const out: any = {};

    const main = Ext.ComponentQuery.query('app-main')[0];
    const navTree = main?.lookup?.('navTree')?.getStore?.();
    const parent = navTree?.findNode?.('ctype', 'listassignments');
    out.navChildren = (parent?.childNodes || []).map((c: any) => c.get?.('ctype'));

    const grid = Ext.ComponentQuery.query('assignmentlist')[0];
    if (!grid) { out.error = 'no assignmentlist'; return out; }

    const plugins = grid.getPlugins?.() ?? [];
    const updater = plugins.find((p: any) => p?.$className?.includes?.('Updater') || p?.alias === 'plugin.updater');
    out.pluginFound = !!updater;
    if (!updater) return out;

    updater.setSelecting(true);
    await sleep(500);

    const sel = grid.getSelectable?.();
    // Use the patched selection-column toggleAll override (handles virtual stores).
    const selCol = grid.down?.('selectioncolumn');
    if (selCol && typeof selCol.toggleAll === 'function') {
      selCol.toggleAll();
    } else {
      const records = updater.getLoadedRecords?.() ?? [];
      sel?.select?.(records, true);
    }
    await sleep(300);
    const selections = sel?.getSelections?.() ?? grid.getSelections?.() ?? [];
    out.selCount = selections.length;
    updater.setSelectedRecords?.(selections);

    out.editBtnVisibleBeforeClick = !!Ext.ComponentQuery.query('button[reference=massEditBtn]').find((b: any) => b.isVisible?.());

    // The Updater plugin's getSheet() builds (lazily) + returns the sheet.
    // Show it explicitly.
    const sheet = updater.getSheet?.();
    out.sheetExists = !!sheet;
    out.sheetVisibleBefore = !!sheet?.isVisible?.();
    sheet?.show?.();
    await sleep(1500);
    out.sheetVisibleAfter = !!sheet?.isVisible?.();

    const visibleSheets = Ext.ComponentQuery.query('sheet,dialog,window')
      .filter((s: any) => s.isVisible?.())
      .map((s: any) => ({ xtype: s.xtype, id: s.id, title: trim(s.title || '') }));
    const formPanels = Ext.ComponentQuery.query('formpanel').filter((f: any) => f.isVisible?.())
      .map((f: any) => ({ id: f.id, reference: f.reference }));
    const visibleFields = Ext.ComponentQuery.query('field')
      .filter((f: any) => f.isVisible?.())
      .map((f: any) => ({
        xtype: f.xtype, name: f.name,
        label: trim(f.getFieldLabel?.() ?? f.fieldLabel ?? ''),
        reference: f.reference,
      }));
    out.visibleSheets = visibleSheets;
    out.formPanels = formPanels;
    out.visibleFields = visibleFields;

    // Locate the Vendor NTE field specifically.
    out.vendorNteHits = Ext.ComponentQuery.query('field[name="subcontractor_not_to_exceed.amount"]')
      .filter((c: any) => c.isVisible?.())
      .map((c: any) => ({ xtype: c.xtype, name: c.name, id: c.id, label: trim(c.getFieldLabel?.() ?? c.fieldLabel ?? '') }));

    out.allVisibleButtons = Ext.ComponentQuery.query('button')
      .filter((b: any) => b.isVisible?.() && (trim((b.getText?.() ?? b.text) || '') || b.reference))
      .map((b: any) => ({
        text: trim((b.getText?.() ?? b.text) || ''),
        reference: b.reference, iconCls: b.iconCls,
      }));

    return out;
  });
  await dump(page, '00-bundled-discovery', bundle);
  await shot(page, '01-after-bundled-discovery');
});
