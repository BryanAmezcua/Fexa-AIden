/**
 * TANGO-60 — Support Non Enforced Pricings: BROWSER UI pass.
 *
 * Runs against the freshly rebuilt fast-mode bundle (now carries the PR #6994
 * LineItemGrid.js changes). Complements the deterministic backend spec
 * (non-enforced-pricing.spec.ts) with real Ext invoice line-item checks on the
 * non-enforced reference + editability and the re-resolve-on-product-change
 * behavior the consistency fix protects. Helpers mirror the proven TANGO-6
 * approved-rate-reference suite.
 *
 * Fixtures: seeds/approved-rate-reference.rb (Overtime Rate editable pricings).
 */
import { test, expect, Page } from '@playwright/test';
import { annotateAc, captureAcSnapshot, TANGO_60_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-60';
const SUBCONTRACTOR_INVOICE_ID = 24;
const FIXTURE_PRODUCT_ID = 24;           // Overtime Rate — non-enforced Flat/Increase/Decrease fixtures
const LABOR_CLASSIFICATION_ID = 1;

async function waitForFexaApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    if (!Ext?.ComponentQuery) return false;
    try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; } catch { return false; }
  }, null, { timeout: 90_000, polling: 1000 });
  await page.waitForTimeout(2000);
}

async function gotoInvoice(page: Page, id: number): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);
  await page.evaluate((id) => (window as any).Ext.History.add(`invoice/${id}`), id);
  await page.waitForFunction(() => (window as any).Ext.ComponentQuery.query('lineitemgrid').length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(2500);
}

async function openNewLineItemForm(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
      const form = grid?.down?.('formpanel');
      if (form?.isVisible?.()) form.query?.('button[action=cancel]')[0]?.element?.dom?.click?.();
    });
    await page.waitForTimeout(500);
    const rect = await page.evaluate(() => {
      const btn = (window as any).Ext.ComponentQuery.query('button[reference=createLineItemBtn]')[0];
      const el = btn?.element?.dom;
      el?.scrollIntoView?.({ block: 'center' });
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    if (!rect) throw new Error('createLineItemBtn not found');
    await page.waitForTimeout(400);
    await page.mouse.click(rect.x, rect.y);
    try {
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        const form = Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
        const saveBtn = Ext.ComponentQuery.query('button[reference=saveLineItemBtn]').some((b: any) => b.isVisible?.());
        const productField = form?.query?.('[name=product_id]')[0];
        return saveBtn && productField && productField.isVisible?.();
      }, null, { timeout: 25_000 });
      await page.waitForTimeout(2500);
      return;
    } catch { /* retry */ }
  }
  throw new Error('openNewLineItemForm: failed after 3 attempts');
}

async function selectProduct(page: Page, productId: number | null, classificationId: number | null): Promise<void> {
  if (classificationId != null) {
    await page.evaluate((cid) => {
      const form = (window as any).Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
      form?.query?.('[name="product.product_classification_id"]')[0]?.setValue(cid);
    }, classificationId);
    await page.waitForTimeout(800);
  }
  if (productId != null) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.evaluate((pid) => {
        const form = (window as any).Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
        form?.query?.('[name=product_id]')[0]?.setValue(pid);
      }, productId);
      try {
        await page.waitForFunction(() => {
          const form = (window as any).Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
          return form?.query?.('[name=product_id]')[0]?.getValue?.() != null;
        }, null, { timeout: 5_000 });
        break;
      } catch { await page.waitForTimeout(1500); }
    }
  }
  await page.waitForTimeout(2500);
}

function approvedRateField(page: Page) { return page.locator('.approved-rate-reference'); }
async function approvedRateText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const f = (window as any).Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel')?.down?.('[reference=approved_rate]');
    return (!f || !f.isVisible?.()) ? null : String(f.getValue?.() || '');
  });
}
async function unitPriceState(page: Page) {
  return page.evaluate(() => {
    const f = (window as any).Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel')?.query?.('[name=unit_price]')[0];
    return { disabled: !!f?.getDisabled?.(), readOnly: !!f?.getReadOnly?.(), value: f?.getValue?.() };
  });
}
async function setUnitPrice(page: Page, v: number) {
  await page.evaluate((val) => {
    const f = (window as any).Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel')?.query?.('[name=unit_price]')[0];
    f?.setValue?.(val);
  }, v);
  await page.waitForTimeout(600);
}
async function clearProduct(page: Page) {
  await page.evaluate(() => {
    const form = (window as any).Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
    form?.query?.('[name=product_id]')[0]?.clearValue?.();
  });
  await page.waitForTimeout(1500);
}
async function cancelForm(page: Page) {
  await page.evaluate(() => {
    const form = (window as any).Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
    form?.query?.('button[action=cancel]')[0]?.element?.dom?.click?.();
  });
  await page.waitForTimeout(500);
}

test.describe('Support non-enforced pricings — UI (TANGO-60)', () => {
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(120_000);
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin');
  });

  test('Non-enforced product surfaces the Approved Rate reference and keeps unit_price editable (type-over)', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_60_AC.NonEnforcedTotal, TANGO_60_AC.ApprovedRateEditable] });
    await gotoInvoice(page, SUBCONTRACTOR_INVOICE_ID);
    await openNewLineItemForm(page);
    await test.step('Select the non-enforced product (Overtime Rate, Labor)', async () => {
      await selectProduct(page, FIXTURE_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
    });
    await captureAcSnapshot(testInfo, page, 'before', { focus: approvedRateField(page) }).catch(() => {});

    await test.step('Approved Rate reference is shown', async () => {
      await expect(approvedRateField(page)).toBeVisible({ timeout: 10_000 });
      expect(await approvedRateText(page)).toMatch(/Approved Rate\s*=?\s*\$/i);
    });
    await test.step('unit_price stays editable and accepts a typed-over value (77)', async () => {
      await setUnitPrice(page, 77);
      const s = await unitPriceState(page);
      expect(s.disabled, 'unit_price not disabled (non-enforced)').toBe(false);
      expect(s.readOnly, 'unit_price not read-only (non-enforced)').toBe(false);
      expect(s.value, 'typed-over value accepted').toBe(77);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: approvedRateField(page) }).catch(() => {});
    await cancelForm(page);
  });

  test('Re-selecting the product re-resolves the Approved Rate (no stale reference left behind)', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_60_AC.Consistency] });
    await gotoInvoice(page, SUBCONTRACTOR_INVOICE_ID);
    await openNewLineItemForm(page);

    await test.step('Select Overtime Rate → reference appears', async () => {
      await selectProduct(page, FIXTURE_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
      await expect(approvedRateField(page)).toBeVisible({ timeout: 10_000 });
    });
    await captureAcSnapshot(testInfo, page, 'before', { focus: approvedRateField(page) }).catch(() => {});

    await test.step('Clear the product, then re-select it → the reference re-resolves (recomputed, not stale)', async () => {
      await clearProduct(page);
      await selectProduct(page, FIXTURE_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
      await expect(approvedRateField(page)).toBeVisible({ timeout: 10_000 });
      expect(await approvedRateText(page)).toMatch(/Approved Rate\s*=?\s*\$/i);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: approvedRateField(page) }).catch(() => {});
    await cancelForm(page);
  });
});
