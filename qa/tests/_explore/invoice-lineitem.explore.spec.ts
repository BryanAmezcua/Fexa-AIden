import { test, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Exploration: drive into a SubcontractorInvoice's line item form so we
 * can discover the selectors needed for TANGO-6 tests. Not part of the
 * standard suite (excluded by testIgnore).
 *
 * Run with: npx playwright test tests/_explore/invoice-lineitem --project=admin
 */

const OUT = path.resolve(__dirname, '../../exploration');
fs.mkdirSync(OUT, { recursive: true });

async function snapshot(page: Page, label: string): Promise<void> {
  const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const jsonPath = path.join(OUT, `${slug}.json`);

  const state = await page.evaluate((): any => {
    const Ext = (window as any).Ext;
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    if (!Ext?.ComponentQuery) {
      return { url: location.href, hash: location.hash, extReady: false };
    }
    const grids = Ext.ComponentQuery.query('grid,gridpanel,lineitemgrid')
      .filter((g: any) => g.isVisible?.())
      .map((g: any) => ({ xtype: g.xtype, id: g.id }));
    const buttons = Ext.ComponentQuery.query('button')
      .filter((b: any) => b.isVisible?.() && trim((b.getText?.() ?? b.text) || ''))
      .map((b: any) => ({
        text: trim((b.getText?.() ?? b.text)),
        xtype: b.xtype, iconCls: b.iconCls, reference: b.reference,
      }))
      .slice(0, 30);
    const visibleMenus = Ext.ComponentQuery.query('sideeditmenu,menu,dialog,window')
      .filter((m: any) => m.isVisible?.())
      .map((m: any) => ({ xtype: m.xtype, id: m.id, title: trim(m.title) }));
    return {
      url: location.href, hash: location.hash,
      extReady: !!Ext.isReady,
      gridXtypes: grids,
      visibleButtons: buttons,
      visibleMenus,
      hasLineItemGrid: Ext.ComponentQuery.query('lineitemgrid').length > 0,
    };
  });
  fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2));
  console.log(`[snap] ${label}: ${JSON.stringify({ url: state.url, hasLineItemGrid: state.hasLineItemGrid, grids: state.gridXtypes?.length, buttons: state.visibleButtons?.length, menus: state.visibleMenus?.length })}`);
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

test.use({ storageState: 'auth/admin.json' });
test.setTimeout(180_000);

test('navigate to SubcontractorInvoice #24 and inspect line items grid', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await page.evaluate(() => { (window as any).Ext.History.add('invoice/24'); });
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('lineitemgrid').length > 0;
  }, null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await snapshot(page, '01-invoice-loaded');
});

test('open line item form, dump fields, then select Overtime Rate', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await page.evaluate(() => { (window as any).Ext.History.add('invoice/24'); });
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('lineitemgrid').length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Click createLineItemBtn (the "+" button on the invoice line item section)
  const clicked = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const btn = Ext.ComponentQuery.query('button[reference=createLineItemBtn]')[0];
    if (!btn) return { ok: false, reason: 'no createLineItemBtn' };
    const el = btn.element?.dom;
    const r = el?.getBoundingClientRect();
    if (!r) return { ok: false, reason: 'no rect' };
    return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!clicked.ok) throw new Error(JSON.stringify(clicked));
  await page.mouse.click(clicked.x!, clicked.y!);
  // grideditable plugin opens a formpanel inside the grid; wait for the
  // save button to be visible.
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('button[reference=saveLineItemBtn]')
      .some((b: any) => b.isVisible?.());
  }, null, { timeout: 15_000 });
  await page.waitForTimeout(2000);

  // Dump the open form's fields.
  const form = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
    const menu = grid?.down?.('formpanel');
    if (!menu) return { error: 'no formpanel under lineitemgrid' };
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    const fields = menu.query('field,combobox,combo,searchfield,textfield,numberfield,togglefield,selectfield,datefield,infinitecombo,displayfield')
      .filter((f: any) => f.isVisible?.())
      .map((f: any) => ({
        xtype: f.xtype, id: f.id,
        name: f.name, reference: f.reference,
        label: trim(f.getFieldLabel?.() ?? f.fieldLabel),
        value: (() => { try { return f.getValue?.(); } catch { return null; } })(),
      }));
    const buttons = menu.query('button')
      .filter((b: any) => b.isVisible?.())
      .map((b: any) => ({
        text: trim((b.getText?.() ?? b.text) || ''),
        reference: b.reference,
      }));
    return { fieldCount: fields.length, fields, buttons };
  });
  fs.writeFileSync(path.join(OUT, '03-lineitem-form-fields.json'), JSON.stringify(form, null, 2));
  console.log(`[form] fields=${form.fieldCount}, buttons=${(form as any).buttons?.length}`);
});

test('find lineitemgrid "add" trigger', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await page.evaluate(() => { (window as any).Ext.History.add('invoice/24'); });
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('lineitemgrid').length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Dump the lineitemgrid's toolbar / titleBar buttons + tools.
  const probe = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
    if (!grid) return { error: 'no lineitemgrid' };
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    const buttons = grid.query('button')
      .map((b: any) => ({
        xtype: b.xtype, id: b.id,
        text: trim((b.getText?.() ?? b.text) || ''),
        iconCls: b.iconCls,
        reference: b.reference,
        visible: b.isVisible?.(),
      }));
    return { gridId: grid.id, buttonCount: buttons.length, buttons };
  });
  fs.writeFileSync(path.join(OUT, '02-lineitemgrid-buttons.json'), JSON.stringify(probe, null, 2));
  console.log(`[probe] buttons=${probe.buttonCount}`);
});
