import { test, expect, Page } from '@playwright/test';
import { annotateAc, captureAcSnapshot, TANGO_2_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-2';

/**
 * Subcontractor Pricing export, filtered by status — TANGO-2 regression.
 *
 * COLLEAGUE'S CONCERN (PR #6901 review): "confirm the export on the
 * subcontractor pricings grid still works / doesn't crash when you filter the
 * grid by the expired status."
 *
 * The grid's Export button (GridController#exportPricings) serializes the
 * store's *current* filters and POSTs them to
 * `/api/v1/subcontractor_product_pricings/export`. When the user picks the
 * "Expired" status, that POST carries the synthetic `pricing_status` filter.
 *
 * PricingStatusFilter strips/translates that synthetic filter, but its
 * before_actions are registered `only: [:index]` — NOT `:export`. So on export
 * the filter reaches parse_filters unguarded and Postgres errors with
 * `column "pricing_status" does not exist` (ActiveRecord::StatementInvalid),
 * which ApplicationController#error_catcher obfuscates into a 200 response of
 * `{ success: false, error_code: "invalid_request" }`. The export job never
 * enqueues — the user gets no export.
 *
 * This spec drives the real UI: apply the Expired filter (which loads fine on
 * the grid — index IS guarded), then trigger Export and inspect the response.
 * A passing export returns `{ success: true, email: <user> }`; the bug returns
 * `success: false`.
 *
 * Pre-requisite: TANGO fast-mode build so the status filter control is present
 * in the served bundle (npm run fexa:fast-mode). No seed needed — the crash is
 * on the missing column, independent of whether any row matches "expired".
 */

const EXPORT_PATH = '/api/v1/subcontractor_product_pricings/export';

async function waitForFexaApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    if (!Ext?.ComponentQuery) return false;
    try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; }
    catch { return false; }
  }, null, { timeout: 90_000, polling: 1000 });
  await page.waitForTimeout(2000);
}

async function gotoSubcontractorPricingsGrid(page: Page): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => { (window as any).Ext.History.add('subcontractorproductpricings'); });
    try {
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        return Ext?.ComponentQuery.query('accountingpricinggrid').length > 0;
      }, null, { timeout: 30_000 });
      break;
    } catch {
      await page.waitForTimeout(2000);
      if (attempt === 2) throw new Error('accountingpricinggrid never mounted after 3 attempts');
    }
  }
  await page.evaluate(() => {
    (window as any).Ext.ComponentQuery.query('accountingpricinggrid')[0]?.getStore?.()?.load?.();
  });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const store = Ext.ComponentQuery.query('accountingpricinggrid')[0]?.getStore?.();
    return store && !store.isLoading?.();
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(1000);
}

/** Confirm the grid really is the Subcontractor variant (roleType). */
async function assertSubcontractorGrid(page: Page): Promise<void> {
  const roleType = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    return grid?.getRoleType?.();
  });
  expect(roleType, 'expected the Subcontractor pricing grid (roleType=subcontractor)').toBe('subcontractor');
}

test.describe('Subcontractor Pricing export filtered by status (TANGO-2)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'Pricings administration is admin-only');
    await gotoSubcontractorPricingsGrid(page);
    await assertSubcontractorGrid(page);
  });

  test('CONTROL: export with no status filter enqueues successfully', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_2_AC.ExpectedBehavior4] });

    await test.step('On the Subcontractor Pricing grid with NO status filter applied', async () => {
      await captureAcSnapshot(testInfo, page, 'before', { focus: page.locator('.x-grid').first() });
    });

    let body: any = null;
    await test.step('Click Export (POST /api/v1/subcontractor_product_pricings/export) and capture the response', async () => {
      const [resp] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes(EXPORT_PATH) && r.request().method() === 'POST',
          { timeout: 30_000 },
        ),
        page.evaluate(() => {
          const Ext = (window as any).Ext;
          const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
          grid.getController().exportPricings();
        }),
      ]);
      body = await resp.json().catch(() => null);
      console.log(`[QA] CONTROL export (no status filter): http=${resp.status()} body=${JSON.stringify(body)}`);
      await captureAcSnapshot(testInfo, page, 'after', { focus: page.locator('.x-grid').first() });
    });

    await test.step('Expect a normal export: { success: true, email: <admin> }', async () => {
      expect(body?.success, `control export should succeed; got ${JSON.stringify(body)}`).toBe(true);
    });
  });

  test('FIXED: export filtered by Expired status succeeds (concern now guards :export)', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_2_AC.ExpectedBehavior4] });

    await test.step('Filter the Subcontractor Pricing grid by status = "Expired" (pricing_status=expired)', async () => {
      // Prefer the real filter combobox; it lives in the grid's lazily-built
      // filter menu, so if it isn't instantiated yet, fall back to adding the
      // identical store filter the combobox produces. Either way
      // exportPricings() reads store.getFilters(), so the export payload is the same.
      const filterApplied = await page.evaluate(() => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
        let field = Ext.ComponentQuery.query('[reference=effectiveDateStatusFilter]')[0]
          || Ext.ComponentQuery.query('[name=pricing_status]')[0];
        if (!field && grid.getAttachedMenu) {
          const menu = grid.getAttachedMenu();
          if (menu && menu.down) {
            field = menu.down('[reference=effectiveDateStatusFilter]') || menu.down('[name=pricing_status]');
          }
        }
        if (field && field.setValue) { field.setValue('expired'); return 'control'; }
        grid.getStore().addFilter({ property: 'pricing_status', value: 'expired', operator: '=' });
        return 'store';
      });
      console.log(`[QA] applied Expired filter via: ${filterApplied}`);
      expect(['control', 'store']).toContain(filterApplied);
    });

    await test.step('Grid reloads under the Expired filter — the INDEX path IS guarded, so this load succeeds', async () => {
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        const store = Ext.ComponentQuery.query('accountingpricinggrid')[0]?.getStore?.();
        return store && !store.isLoading?.();
      }, null, { timeout: 20_000 });
      await page.waitForTimeout(1500);

      const hasStatusFilter = await page.evaluate(() => {
        const Ext = (window as any).Ext;
        const store = Ext.ComponentQuery.query('accountingpricinggrid')[0]?.getStore?.();
        return (store?.getFilters?.()?.items || []).some((f: any) => f.getProperty?.() === 'pricing_status');
      });
      expect(hasStatusFilter, 'pricing_status filter did not attach to the store').toBe(true);
      await captureAcSnapshot(testInfo, page, 'before', { focus: page.locator('.x-grid').first() });
    });

    let body: any = null;
    let httpStatus = 0;
    await test.step('Click Export — the SAME filters POST to /export, which is NOW guarded by PricingStatusFilter', async () => {
      const [resp] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes(EXPORT_PATH) && r.request().method() === 'POST',
          { timeout: 30_000 },
        ),
        page.evaluate(() => {
          const Ext = (window as any).Ext;
          const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
          grid.getController().exportPricings();
        }),
      ]);
      httpStatus = resp.status();
      body = await resp.json().catch(() => null);
      console.log(`[QA] export (pricing_status=expired): http=${httpStatus} body=${JSON.stringify(body)}`);
      await page.waitForTimeout(1000);
      await captureAcSnapshot(testInfo, page, 'after', { focus: page.locator('body') });
    });

    await test.step(`Export now succeeds under the Expired filter: { success: true, email } — http ${httpStatus}`, async () => {
      expect(body, 'no JSON body from export endpoint').not.toBeNull();
      expect(
        body.success,
        `export should succeed after the :export guard fix; got ${JSON.stringify(body)}`,
      ).toBe(true);
      expect(typeof body.email, `expected an email in the export response; got ${JSON.stringify(body)}`).toBe('string');
    });
  });
});
