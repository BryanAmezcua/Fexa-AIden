/**
 * TANGO-48 — Forward-looking relative date filters: BROWSER UI pass.
 *
 * Runs against a freshly rebuilt fast-mode bundle (the served bundle now contains
 * the PR #6994 frontend). Complements the deterministic backend spec
 * (relative-date-filters.spec.ts) with real Ext UI checks:
 *   1. the relativetimestore (which backs the filter value dropdown) exposes the
 *      new "Next 7/14/30 Days" + "Custom Days Forward" options;
 *   2. choosing "Custom Days Forward" in a date filter reveals the day-count
 *      numberfield, which caps at 365 and surfaces the AC cap-error.
 */
import { test, expect, Page } from '@playwright/test';
import { annotateAc, captureAcSnapshot, TANGO_48_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-48';
const SRC_PRICING = 'Products::SubcontractorProductPricing';
const DATE_COLUMN = 'subcontractor_product_pricing.effective_start_date';

async function waitForFexaApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    if (!Ext?.ComponentQuery) return false;
    try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; }
    catch { return false; }
  }, null, { timeout: 90_000, polling: 1000 });
  await page.waitForTimeout(1500);
}

async function gotoBuilder(page: Page): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);
  await page.evaluate(() => (window as any).Ext.History.add('reports'));
  await page.waitForFunction(() => (window as any).Ext.ComponentQuery.query('reports').length > 0, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    Ext.ComponentQuery.query('button[reference=createReportBtn]')[0]?.element?.dom?.click?.();
  });
  await page.waitForFunction(() => (window as any).Ext.ComponentQuery.query('createreport').length > 0, null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
}

async function selectDataSource(page: Page, source: string): Promise<void> {
  await page.evaluate((src) => {
    (window as any).Ext.ComponentQuery.query('[reference=dataSource]')[0].setValue(src);
  }, source);
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const f = Ext.ComponentQuery.query('[reference=dataColumns]')[0];
    return f && f.getStore() && f.getStore().getCount() > 0;
  }, null, { timeout: 20_000 });
  await page.waitForTimeout(1000);
}

test.describe('Forward-looking relative date filters — UI (TANGO-48)', () => {
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(180_000);

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin');
  });

  test('relativetimestore (the filter value dropdown source) exposes Next 7/14/30 Days + Custom Days Forward', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_48_AC.Presets, TANGO_48_AC.CustomOption] });
    await page.goto('/main/index', { waitUntil: 'commit' });
    await waitForFexaApp(page);

    const opts = await test.step('Instantiate the relativetimestore and read its options', async () => {
      return page.evaluate(() => {
        const Ext = (window as any).Ext;
        const store = Ext.create('Fexy.store.general.RelativeTimes');
        return store.getRange().map((r: any) => ({ name: r.get('name'), val: r.get('val') }));
      });
    });
    await test.step(`Store options include the forward-looking presets + custom option (got ${opts.length} options)`, async () => {
      const vals = opts.map((o: any) => o.val);
      const names = opts.map((o: any) => o.name);
      for (const v of ['next_7_days', 'next_14_days', 'next_30_days', 'custom_days_forward']) {
        expect(vals, `option value "${v}" present`).toContain(v);
      }
      for (const n of ['Next 7 Days', 'Next 14 Days', 'Next 30 Days', 'Custom Days Forward']) {
        expect(names, `option label "${n}" present`).toContain(n);
      }
    });
  });

  test('Custom Days Forward reveals a day-count numberfield that caps at 365 with the AC cap-error', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_48_AC.CustomInput, TANGO_48_AC.Cap365, TANGO_48_AC.CapError] });

    await gotoBuilder(page);
    await test.step(`Select data source "${SRC_PRICING}"`, async () => { await selectDataSource(page, SRC_PRICING); });

    await test.step('Open the filter dialog and select the Effective Start Date (date) column', async () => {
      await page.evaluate(() => {
        (window as any).Ext.ComponentQuery.query('button[reference=addFilterButton]')[0]?.element?.dom?.click?.();
      });
      await page.waitForFunction((col) => {
        const Ext = (window as any).Ext;
        const block = Ext.ComponentQuery.query('filterblock')[0];
        if (!block) return false;
        const ff = block.getController().lookup('filterField');
        return !!(ff && ff.getStore() && ff.getStore().findRecord('value', col, 0, false, false, true));
      }, DATE_COLUMN, { timeout: 15_000 });
      await page.evaluate((col) => {
        const Ext = (window as any).Ext;
        const block = Ext.ComponentQuery.query('filterblock')[0];
        const ctrl = block.getController();
        const ff = ctrl.lookup('filterField');
        const rec = ff.getStore().findRecord('value', col, 0, false, false, true);
        ff.setValue(col);
        ctrl.onFilterFieldSelect(ff, rec);   // reveals the date value section (explicit + relative)
      }, DATE_COLUMN);
      await page.waitForTimeout(1200);
    });

    const relRef = await test.step('Locate the relative selectfield for the date column and choose "Custom Days Forward"', async () => {
      return page.evaluate(() => {
        const Ext = (window as any).Ext;
        const block = Ext.ComponentQuery.query('filterblock')[0];
        const ctrl = block.getController();
        // date or datetime variant
        const rel = ctrl.lookup('filterValueDateRelative') || ctrl.lookup('filterValueDatetimeRelative');
        if (!rel) return null;
        const ref = rel.getReference();
        rel.setValue('custom_days_forward');
        ctrl.onRelativeSelect(rel, 'custom_days_forward');   // reveals the days numberfield
        return ref;
      });
    });
    expect(relRef, 'a relative selectfield exists for the date column').toBeTruthy();
    await page.waitForTimeout(800);
    await captureAcSnapshot(testInfo, page, 'before', { focus: page.locator('.x-msgbox, .x-dialog').first() }).catch(() => {});

    await test.step('The day-count numberfield is now visible and capped at maxValue 365', async () => {
      const info = await page.evaluate((ref) => {
        const Ext = (window as any).Ext;
        const days = (window as any).Ext.ComponentQuery.query('filterblock')[0].getController().lookup(`${ref}Days`);
        return days ? { visible: !!days.isVisible?.(), maxValue: days.getMaxValue?.() } : null;
      }, relRef);
      expect(info, 'days numberfield resolved').toBeTruthy();
      expect(info!.visible, 'days numberfield is shown for Custom Days Forward').toBe(true);
      expect(info!.maxValue, 'capped at 365').toBe(365);
    });

    await test.step('The day-count field rejects > 365 with the AC cap-error "only supports values up to 365"', async () => {
      const res = await page.evaluate((ref) => {
        const Ext = (window as any).Ext;
        const days = Ext.ComponentQuery.query('filterblock')[0].getController().lookup(`${ref}Days`);
        // The cap is a `validators(v)` function returning the error string for v > 365
        // (it surfaces on save per the AC). Invoke it directly for a deterministic check,
        // trying the accessors Ext exposes the original config through.
        const vfn =
          (typeof days.getInitialConfig === 'function' && days.getInitialConfig('validators')) ||
          (days.initialConfig && days.initialConfig.validators) ||
          (days.config && days.config.validators);
        const at = (v: number) => { try { return typeof vfn === 'function' ? vfn.call(days, v) : null; } catch { return null; } };
        return { type: typeof vfn, over: at(400), under: at(30), atCap: at(365), maxValue: days.getMaxValue?.() };
      }, relRef);
      expect(res.type, 'a validators function is configured on the day-count field').toBe('function');
      expect(String(res.over), '400 is rejected with the AC cap-error copy').toMatch(/only supports values up to 365/i);
      expect(res.under, '30 (within range) is accepted').toBe(true);
      expect(res.atCap, 'exactly 365 is accepted (boundary)').toBe(true);
      expect(res.maxValue, 'field maxValue is 365').toBe(365);
    });
  });
});
