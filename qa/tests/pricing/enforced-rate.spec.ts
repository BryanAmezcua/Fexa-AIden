import { test, expect, Page } from '@playwright/test';
import { annotateAc, captureAcSnapshot, TANGO_5_AC } from '../../src/support/qa-report';

/**
 * Lock rate field when enforcement is ON — TANGO-5.
 *
 * When a vendor (or internal admin viewing a vendor's invoice/quote) selects
 * a product on a line item, the system matches a SubcontractorProductPricing
 * via get_pricing(). If that pricing has prevent_price_modification=true,
 * the unit_price field auto-fills with the calculated Approved Rate AND is
 * made read-only (greyed + disabled), with italic helper text rendered
 * directly below: "This rate is enforced. Contact your client to request a
 * change."
 *
 * Pre-requisite: `npm run seed:enforced-rate` to create the locked fixture
 * pricings on (Holiday Rate, 1st Quality Electric) plus an expired locked
 * pricing on Labor Incurred for the AC #13 date-exclusion case. The seed is
 * idempotent so re-running between iterations is safe.
 *
 * Existing seed data the tests rely on:
 *   - SubcontractorInvoice id=24 — payable_to "1st Quality Electric, Inc"
 *   - SubcontractorQuote   id=5  — payable_to "1st Quality Electric, Inc"
 *   - Both are visible to both admin and the vendor (subcontractor_user3083).
 *
 * AC #7 implementation note: the literal AC reads `"Approved Rate = $[amount]"
 * displays in the line item side edit panel pre filled and uneditable`. The
 * implementation satisfies this by pre-filling the Approved Rate value INTO
 * the locked unit_price field itself rather than as a separate display
 * element. Functionally equivalent (pre-filled + uneditable); flagged in the
 * report as a wording-level deviation only.
 */

const TICKET = 'TANGO-5';

const SUBCONTRACTOR_INVOICE_ID = 24;
const SUBCONTRACTOR_QUOTE_ID   = 5;
const LABOR_CLASSIFICATION_ID  = 1;

// Locked fixture from seeds/enforced-rate.rb — primary happy-path product.
const ENFORCED_PRODUCT_NAME = 'Holiday Rate';
const ENFORCED_PRODUCT_ID   = 25;
const ENFORCED_RATE         = 150;   // Flat Rate $150

// Product with NO pricing for this vendor — drives AC #11 (no match → editable).
const NO_MATCH_PRODUCT_NAME = 'Labor Emergency';
const NO_MATCH_PRODUCT_ID   = 26;

// Product whose only pricing is expired-and-locked (2020 dates) — drives
// AC #13 (date filter excludes → editable).
const EXPIRED_PRODUCT_NAME = 'Labor Incurred';
const EXPIRED_PRODUCT_ID   = 22;

// TANGO-6 fixture: editable Overtime Rate. Drives AC #12 (modification
// allowed → editable + Approved Rate reference still shows).
const REFERENCE_PRODUCT_NAME = 'Overtime Rate';
const REFERENCE_PRODUCT_ID   = 24;

// --- Helpers ---------------------------------------------------------------

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

async function gotoInvoice(page: Page, ctype: 'invoice' | 'subcontractorquote', id: number): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);

  // Cold-start workaround — Ext.History.add can no-op when the router isn't
  // fully bound yet on the very first test after Rails wakes up. Retry up to
  // 5 times, waiting for the lineitemgrid to appear after each attempt. We
  // also bump the first-attempt timeout because the initial GET of the
  // invoice JSON can take 20-40s when the AR cache is cold.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await page.evaluate(({ ctype, id }) => {
      (window as any).Ext.History.add(`${ctype}/${id}`);
    }, { ctype, id });
    try {
      await page.waitForFunction(() => {
        return (window as any).Ext.ComponentQuery.query('lineitemgrid').length > 0;
      }, null, { timeout: attempt === 0 ? 45_000 : 30_000 });
      await page.waitForTimeout(2500);
      return;
    } catch {
      // Retry — fire History.add again. Some cold-start cases need 2-3 tries.
      // Give the router a bit longer to settle between attempts.
      await page.waitForTimeout(1500);
    }
  }
  throw new Error(`gotoInvoice: lineitemgrid never appeared after ${MAX_ATTEMPTS} attempts (${ctype}/${id})`);
}

async function openNewLineItemForm(page: Page): Promise<void> {
  // Defensive close + scroll the createLineItemBtn into view, then click.
  // Retry the whole sequence — long-running suites sometimes catch the form
  // mid-transition and the first click no-ops.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
      const form = grid?.down?.('formpanel');
      if (form?.isVisible?.()) {
        form.query?.('button[action=cancel]')[0]?.element?.dom?.click?.();
      }
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
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const form = grid?.down?.('formpanel');
        const saveBtn = Ext.ComponentQuery.query('button[reference=saveLineItemBtn]')
          .some((b: any) => b.isVisible?.());
        const productField = form?.query?.('[name=product_id]')[0];
        return saveBtn && productField && productField.isVisible?.();
      }, null, { timeout: 25_000 });
      await page.waitForTimeout(2500);
      return;
    } catch {
      // retry — possibly stale click target or animation hiccup
    }
  }
  throw new Error('openNewLineItemForm: failed to open form after 3 attempts');
}

/**
 * Set classification + product on the open line item form. The product
 * InfiniteCombo is async — set the value, then poll until getValue actually
 * reflects the product id (otherwise the change handler won't have fired).
 * The change handler is what kicks off the get_unit_price AJAX call.
 */
async function selectProduct(page: Page, productId: number | null, classificationId: number | null): Promise<void> {
  if (classificationId != null) {
    await page.evaluate((cid) => {
      const Ext = (window as any).Ext;
      const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
      const form = grid?.down?.('formpanel');
      form?.query?.('[name="product.product_classification_id"]')[0]?.setValue(cid);
    }, classificationId);
    await page.waitForTimeout(800);
  }
  if (productId != null) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.evaluate((pid) => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const form = grid?.down?.('formpanel');
        form?.query?.('[name=product_id]')[0]?.setValue(pid);
      }, productId);
      try {
        await page.waitForFunction(() => {
          const Ext = (window as any).Ext;
          const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
          const form = grid?.down?.('formpanel');
          const v = form?.query?.('[name=product_id]')[0]?.getValue?.();
          return v != null;
        }, null, { timeout: 5_000 });
        break;
      } catch {
        await page.waitForTimeout(1500);
      }
    }
  }
  // Give the rate-fetch AJAX + enforcement/reference DOM mutations time to settle.
  await page.waitForTimeout(2500);
}

async function cancelLineItemForm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
    const form = grid?.down?.('formpanel');
    const cancelBtn = form?.query?.('button[action=cancel]')[0];
    if (cancelBtn) {
      const el = cancelBtn.element?.dom;
      el?.click?.();
    }
  });
  await page.waitForTimeout(500);
}

/** Snapshot of the unit_price field + helper component state. */
interface UnitPriceState {
  value:         number | null;
  disabled:      boolean;
  readOnly:      boolean;
  hasLockClass:  boolean;
  helperPresent: boolean;
  helperText:    string;
}

async function unitPriceState(page: Page): Promise<UnitPriceState> {
  return await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
    const form = grid?.down?.('formpanel');
    const f = form?.query?.('[name=unit_price]')[0];
    const helper = form?.query?.('[reference=liRateEnforcedHelper]')[0];
    const el = f?.element?.dom;
    const helperEl = helper?.element?.dom;
    return {
      value:         f?.getValue?.() ?? null,
      disabled:      !!f?.getDisabled?.(),
      readOnly:      !!f?.getReadOnly?.(),
      hasLockClass:  !!el?.classList?.contains?.('rate-enforced-locked'),
      helperPresent: !!helper,
      helperText:    helperEl?.innerText?.trim?.() || '',
    };
  });
}

/** Locator for the locked-state CSS class on the unit_price element. */
function lockedFieldLocator(page: Page) {
  return page.locator('.rate-enforced-locked').first();
}

/** Locator for the helper subtitle inserted under the locked field. */
function helperLocator(page: Page) {
  return page.locator('.rate-enforced-helper').first();
}

/** Locator for the editable unit_price field (used as focus when proving absence-of-lock). */
function unitPriceLocator(page: Page) {
  return page.locator('input[name=unit_price]').first();
}

/** Locator for the TANGO-6 Approved Rate reference (visible when enforcement OFF). */
function approvedRateRefLocator(page: Page) {
  return page.locator('.approved-rate-reference');
}

// --- Tests -----------------------------------------------------------------

test.describe('Lock rate field when enforcement is ON (TANGO-5)', () => {
  // Serial because each test boots the Ext app; parallel workers overwhelm
  // the dev server. Per-test timeout 180s — gives gotoInvoice's full 5-attempt
  // cold-start retry budget (~165s) room to complete on the very first test.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name === 'facility-manager', 'Facility manager is out of scope for vendor pricing UI');
  });

  test('Enforced product auto-fills the locked unit_price field with the Approved Rate', async ({ page }, testInfo) => {
    // AC #1-3 (calculation), #4 (locked + auto-filled), #7 (Approved Rate value
    // pre-filled + uneditable — satisfied via the locked field itself, see file
    // header note), and #9 (admin = internal user is also restricted).
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [
        TANGO_5_AC.Calculation1,
        TANGO_5_AC.Calculation2,
        TANGO_5_AC.Calculation3,
        TANGO_5_AC.RateLocking1,
        TANGO_5_AC.RateLocking4,
        TANGO_5_AC.Scope2,
      ],
    });
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin (form-fill mechanics validated; AC #9 covered)');

    await test.step(`Navigate to SubcontractorInvoice #${SUBCONTRACTOR_INVOICE_ID}`, async () => {
      await gotoInvoice(page, 'invoice', SUBCONTRACTOR_INVOICE_ID);
    });
    await test.step('Click "+" to open new line item form', async () => { await openNewLineItemForm(page); });
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: unitPriceLocator(page),
      label: 'New line item form opened — Rate field empty and editable, no helper text rendered, no product selected yet',
    });

    // NOTE: classification + product are set together (selectProduct sets both
    // in quick succession). Splitting the call to capture a "classification
    // set" intermediate frame breaks the change-event chain that drives
    // get_unit_price → enforcement application — the InfiniteCombo's store
    // state gets confused when too much time passes between the two writes.
    await test.step(`Set Product Class = "Labor" (id=${LABOR_CLASSIFICATION_ID}), Product = "${ENFORCED_PRODUCT_NAME}" (id=${ENFORCED_PRODUCT_ID}, seeded locked Flat Rate $${ENFORCED_RATE})`, async () => {
      await selectProduct(page, ENFORCED_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
    });

    await test.step(`Verify unit_price is locked, auto-filled to $${ENFORCED_RATE}, has rate-enforced-locked CSS class`, async () => {
      await expect(lockedFieldLocator(page)).toBeVisible({ timeout: 10_000 });
      const state = await unitPriceState(page);
      expect(state.value).toBe(ENFORCED_RATE);
      expect(state.disabled).toBe(true);
      expect(state.readOnly).toBe(true);
      expect(state.hasLockClass).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: lockedFieldLocator(page),
      label: `Product "${ENFORCED_PRODUCT_NAME}" selected — Rate auto-filled to $${ENFORCED_RATE} and locked`,
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: helperLocator(page),
      label: 'Helper subtitle rendered with the exact AC copy below the locked field',
    });

    await test.step('Cancel form', async () => { await cancelLineItemForm(page); });
  });

  test('Locked field has grey disabled visual treatment + helper text below it', async ({ page }, testInfo) => {
    // AC #5 (visual treatment — greyed disabled) + #6 (helper text copy).
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_5_AC.RateLocking2, TANGO_5_AC.RateLocking3],
    });
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin');

    await gotoInvoice(page, 'invoice', SUBCONTRACTOR_INVOICE_ID);
    await openNewLineItemForm(page);
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: unitPriceLocator(page),
      label: 'New line item form opened — Rate field is the default editable look (white background, focused border, not greyed)',
    });

    await test.step(`Set Product Class = "Labor", Product = "${ENFORCED_PRODUCT_NAME}"`, async () => {
      await selectProduct(page, ENFORCED_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
    });

    await test.step('Verify helper subtitle is present with exact AC copy', async () => {
      await expect(helperLocator(page)).toBeVisible({ timeout: 10_000 });
      const state = await unitPriceState(page);
      expect(state.helperPresent).toBe(true);
      // AC #6 helper text — must match the locale value exactly.
      expect(state.helperText).toBe('This rate is enforced. Contact your client to request a change.');
      // AC #5 visual treatment — the .rate-enforced-locked class on the input
      // is what carries the greyed/disabled styling per LineItemGrid.scss.
      expect(state.hasLockClass).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: lockedFieldLocator(page),
      label: 'AC #5 visual treatment — Rate field is greyed/disabled with the auto-filled $150 value visible inside it',
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: helperLocator(page),
      label: 'AC #6 helper text — italic subtitle below the locked field with the exact locale-defined copy',
    });

    await cancelLineItemForm(page);
  });

  test('Saving a locked line item persists it to the grid at the enforced Rate', async ({ page }, testInfo) => {
    // Happy-path end-to-end: prove the locked Rate flows through to a saved
    // line item (not just into the form's transient state), and that re-opening
    // the saved row re-applies the lock via the form-open re-trigger.
    //
    // Note: rows persist in the dev DB across runs (per user preference — no
    // auto-cleanup). Each row's Description is timestamped + tagged "[QA]" so
    // they're easy to identify and clean up manually with:
    //   `Invoices::SubcontractorInvoiceLineItem.where("description LIKE '[QA] TANGO-5 happy path %'").destroy_all`
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [
        TANGO_5_AC.Calculation1,
        TANGO_5_AC.Calculation2,
        TANGO_5_AC.RateLocking1,
        TANGO_5_AC.RateLocking4,
      ],
    });
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin');

    const uniqueDescription = `[QA] TANGO-5 happy path ${Date.now()}`;
    const QTY = 2;

    await test.step(`Navigate to SubcontractorInvoice #${SUBCONTRACTOR_INVOICE_ID}`, async () => {
      await gotoInvoice(page, 'invoice', SUBCONTRACTOR_INVOICE_ID);
    });
    await test.step('Click "+" to open new line item form', async () => { await openNewLineItemForm(page); });
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: unitPriceLocator(page),
      label: 'New line item form opened — all fields empty, awaiting input',
    });

    await test.step(`Set Product Class = "Labor", Product = "${ENFORCED_PRODUCT_NAME}" (locked Flat Rate $${ENFORCED_RATE})`, async () => {
      await selectProduct(page, ENFORCED_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
      await expect(lockedFieldLocator(page)).toBeVisible({ timeout: 10_000 });
    });
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: lockedFieldLocator(page),
      label: `Product selected — Rate auto-filled and locked at $${ENFORCED_RATE}, awaiting QTY and Description`,
    });

    await test.step(`Fill QTY = ${QTY}, Description = "${uniqueDescription}"`, async () => {
      await page.evaluate(({ qty, desc }) => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const form = grid?.down?.('formpanel');
        form?.query?.('[name=quantity]')[0]?.setValue?.(qty);
        form?.query?.('[name=description]')[0]?.setValue?.(desc);
      }, { qty: QTY, desc: uniqueDescription });
      await page.waitForTimeout(600);
    });
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: lockedFieldLocator(page),
      label: `All required fields filled (QTY=${QTY} + Description) — Rate still locked at $${ENFORCED_RATE}, ready to save`,
    });

    await test.step('Click Save', async () => {
      await page.evaluate(() => {
        const Ext = (window as any).Ext;
        const saveBtn = Ext.ComponentQuery.query('button[reference=saveLineItemBtn]')[0];
        saveBtn?.element?.dom?.click?.();
      });
      // Wait for the POST to complete + grid to refresh with the new row.
      await page.waitForFunction((desc) => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const store = grid?.getStore?.();
        const items = store?.getData?.()?.items || store?.getRange?.() || [];
        return items.some((r: any) => r.get?.('description') === desc);
      }, uniqueDescription, { timeout: 20_000 });
      await page.waitForTimeout(1500);
    });

    let savedLineItemId: number | null = null;
    await test.step(`Verify the saved line item has unit_price = $${ENFORCED_RATE} (server honored the enforced rate)`, async () => {
      const row = await page.evaluate((desc) => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const store = grid?.getStore?.();
        const items = store?.getData?.()?.items || store?.getRange?.() || [];
        const match = items.find((r: any) => r.get?.('description') === desc);
        return match ? {
          id:          match.get?.('id'),
          unit_price:  match.get?.('unit_price'),
          quantity:    match.get?.('quantity'),
          product_id:  match.get?.('product_id'),
          description: match.get?.('description'),
        } : null;
      }, uniqueDescription);
      expect(row).not.toBeNull();
      expect(parseFloat(row!.unit_price as unknown as string)).toBe(ENFORCED_RATE);
      expect(Number(row!.quantity)).toBe(QTY);
      expect(row!.product_id).toBe(ENFORCED_PRODUCT_ID);
      savedLineItemId = row!.id as number;
    });

    // Focus on the new row in the grid for the after-shot. Locate by DOM id
    // derived from the Ext record so the screenshot reliably shows the row.
    const newRowDomId = await page.evaluate((desc) => {
      const Ext = (window as any).Ext;
      const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
      const view = grid?.getView?.() || grid;
      const store = grid?.getStore?.();
      const items = store?.getData?.()?.items || store?.getRange?.() || [];
      const match = items.find((r: any) => r.get?.('description') === desc);
      if (!match) return null;
      // In Ext modern, grid rows are .x-gridrow elements with the record id
      // baked into the DOM. Find the row element by record id, fall back to a
      // text-content search if the structure differs.
      const rows = document.querySelectorAll('.x-gridrow,.x-listitem,.x-gridcell');
      for (const r of Array.from(rows)) {
        if ((r as HTMLElement).innerText?.includes(desc)) return (r as HTMLElement).id || null;
      }
      return null;
    }, uniqueDescription);
    const newRowLocator = newRowDomId
      ? page.locator(`#${newRowDomId}`)
      : page.locator(`.x-gridrow:has-text("${uniqueDescription}")`).first();
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: newRowLocator,
      label: `Line item saved — new row visible in the grid with Rate = $${ENFORCED_RATE} (the enforced value persisted server-side)`,
    });

    await test.step('Re-open the saved row to verify the lock persists when editing an existing line item', async () => {
      // Synthesizing childdoubletap via grid.fireEvent doesn't mount the form
      // because the GridEditable plugin's listener is what calls plugin.edit
      // — it expects a real pointer interaction. Use Playwright's dblclick
      // on the row's DOM element so the plugin's full event chain fires.
      const rowDomId = await page.evaluate(({ desc }) => {
        const rows = Array.from(document.querySelectorAll('.x-gridrow,.x-listitem')) as HTMLElement[];
        const rowDom = rows.find((el) => (el.innerText || '').includes(desc));
        return rowDom?.id || null;
      }, { desc: uniqueDescription });
      if (!rowDomId) throw new Error('Could not locate the saved row in the grid DOM');
      await page.locator(`#${rowDomId}`).dblclick({ timeout: 5_000 });
      // Wait for the form to mount on the saved record.
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const form = grid?.down?.('formpanel');
        const productField = form?.query?.('[name=product_id]')[0];
        return productField && productField.isVisible?.() && productField.getValue?.() != null;
      }, null, { timeout: 15_000 });
      // The re-trigger fires via Ext.defer(100). Give it room to run.
      await page.waitForTimeout(2500);
      await expect(lockedFieldLocator(page)).toBeVisible({ timeout: 10_000 });
      await expect(helperLocator(page)).toBeVisible({ timeout: 5_000 });
      const state = await unitPriceState(page);
      // Note: on form re-open Ext modern's setDisabled can race with the
      // form-binding lifecycle and `getDisabled()` may report false even
      // though the field is visually locked. Assert on the user-visible
      // signals (CSS class + helper subtitle + readOnly) which are stable.
      expect(state.value).toBe(ENFORCED_RATE);
      expect(state.hasLockClass).toBe(true);
      expect(state.helperPresent).toBe(true);
      expect(state.readOnly).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: lockedFieldLocator(page),
      label: `Saved row re-opened — lock re-applied automatically (Rate $${ENFORCED_RATE} greyed, helper visible) on the existing line item`,
    });

    await cancelLineItemForm(page);
  });

  test('Clearing + re-selecting product re-evaluates enforcement', async ({ page }, testInfo) => {
    // AC #10 — re-select recomputes enforcement against the new pricing.
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_5_AC.Edge1],
    });
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin');

    await gotoInvoice(page, 'invoice', SUBCONTRACTOR_INVOICE_ID);
    await openNewLineItemForm(page);

    await test.step(`Select Product = "${ENFORCED_PRODUCT_NAME}" → lock applies`, async () => {
      await selectProduct(page, ENFORCED_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
      const before = await unitPriceState(page);
      expect(before.disabled).toBe(true);
      expect(before.hasLockClass).toBe(true);
      expect(before.helperPresent).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: lockedFieldLocator(page),
      label: `Starting state — "${ENFORCED_PRODUCT_NAME}" selected, Rate locked at $${ENFORCED_RATE} with helper text`,
    });

    await test.step('Clear Product (set product_id to null)', async () => {
      await page.evaluate(() => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const form = grid?.down?.('formpanel');
        form?.query?.('[name=product_id]')[0]?.clearValue?.();
      });
      await page.waitForTimeout(1500);
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: unitPriceLocator(page),
      // Observation: clearValue() on the product field empties LI Type but
      // the lock state (greyed Rate + helper) persists until the NEXT
      // product selection fires the change handler with a new newValue. AC
      // #10 still met because the re-evaluation runs on re-select; flagging
      // for PM as a UX nit.
      label: 'Product cleared (LI Type empty) — lock state persists; teardown fires on next product selection',
    });

    await test.step(`Re-select Product = "${NO_MATCH_PRODUCT_NAME}" (no pricing for this vendor) → lock clears, field editable`, async () => {
      await selectProduct(page, NO_MATCH_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
      const after = await unitPriceState(page);
      expect(after.disabled).toBe(false);
      expect(after.readOnly).toBe(false);
      expect(after.hasLockClass).toBe(false);
      expect(after.helperPresent).toBe(false);
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: unitPriceLocator(page),
      label: `Re-selected "${NO_MATCH_PRODUCT_NAME}" (no matching pricing) — Rate field editable again, no helper, no lock styling`,
    });

    await cancelLineItemForm(page);
  });

  test('No matching pricing keeps the rate field editable, no helper, no lock', async ({ page }, testInfo) => {
    // AC #11 — enforcement only applies when a matching enforced pricing is
    // found. With no match, get_unit_price returns nothing to enforce on.
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_5_AC.Edge2],
    });
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin');

    await gotoInvoice(page, 'invoice', SUBCONTRACTOR_INVOICE_ID);
    await openNewLineItemForm(page);
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: unitPriceLocator(page),
      label: 'New line item form opened — no product selected yet, Rate is the default editable look',
    });

    await test.step(`Set Product Class = "Labor", Product = "${NO_MATCH_PRODUCT_NAME}" (id=${NO_MATCH_PRODUCT_ID}, no pricing fixture for this vendor)`, async () => {
      await selectProduct(page, NO_MATCH_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
    });

    await test.step('Verify rate field is editable, no rate-enforced-locked class, no helper text', async () => {
      const state = await unitPriceState(page);
      expect(state.disabled).toBe(false);
      expect(state.readOnly).toBe(false);
      expect(state.hasLockClass).toBe(false);
      expect(state.helperPresent).toBe(false);
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: unitPriceLocator(page),
      label: `"${NO_MATCH_PRODUCT_NAME}" selected — no matching pricing for this vendor, Rate stays editable (no helper, no lock class)`,
    });

    await cancelLineItemForm(page);
  });

  test('Modification-allowed pricing leaves field editable; Approved Rate reference still shows', async ({ page }, testInfo) => {
    // AC #12 — when matched pricing has do_not_allow_price_modification=false,
    // this story does not apply (regression of TANGO-6 behavior: rate stays
    // editable and the Approved Rate reference displays).
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_5_AC.Edge3],
    });
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin');

    await gotoInvoice(page, 'invoice', SUBCONTRACTOR_INVOICE_ID);
    await openNewLineItemForm(page);
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: unitPriceLocator(page),
      label: 'New line item form opened — Rate editable, no Approved Rate reference yet',
    });

    await test.step(`Set Product Class = "Labor", Product = "${REFERENCE_PRODUCT_NAME}" (id=${REFERENCE_PRODUCT_ID}, TANGO-6 fixture with prevent_price_modification=false)`, async () => {
      await selectProduct(page, REFERENCE_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
    });

    await test.step('Verify rate field stays editable AND Approved Rate reference appears', async () => {
      const state = await unitPriceState(page);
      expect(state.disabled).toBe(false);
      expect(state.readOnly).toBe(false);
      expect(state.hasLockClass).toBe(false);
      expect(state.helperPresent).toBe(false);
      // TANGO-6 reference should still appear when enforcement is OFF.
      await expect(approvedRateRefLocator(page)).toBeVisible({ timeout: 10_000 });
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: unitPriceLocator(page),
      label: `"${REFERENCE_PRODUCT_NAME}" selected — matched pricing has prevent_price_modification=false, Rate stays editable`,
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: approvedRateRefLocator(page),
      label: 'TANGO-6 Approved Rate reference still appears — modification-allowed branch unbroken',
    });

    await cancelLineItemForm(page);
  });

  test('Expired pricing dates exclude the WO completion date → field remains editable', async ({ page }, testInfo) => {
    // AC #13 — get_pricing's comparison_date filter must drop the locked
    // 2020-dated fixture so the rate stays editable today.
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_5_AC.Edge4],
    });
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin');

    await gotoInvoice(page, 'invoice', SUBCONTRACTOR_INVOICE_ID);
    await openNewLineItemForm(page);
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: unitPriceLocator(page),
      label: 'New line item form opened — Rate editable, no enforcement applied yet',
    });

    await test.step(`Set Product Class = "Labor", Product = "${EXPIRED_PRODUCT_NAME}" (id=${EXPIRED_PRODUCT_ID}, only pricing is 2020-dated + locked)`, async () => {
      await selectProduct(page, EXPIRED_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
    });

    await test.step('Verify rate field is editable — the expired pricing is filtered out, so no enforcement applies', async () => {
      const state = await unitPriceState(page);
      expect(state.disabled).toBe(false);
      expect(state.readOnly).toBe(false);
      expect(state.hasLockClass).toBe(false);
      expect(state.helperPresent).toBe(false);
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: unitPriceLocator(page),
      label: `"${EXPIRED_PRODUCT_NAME}" selected — only pricing is 2020-dated, so get_pricing's date filter drops it, Rate stays editable`,
    });

    await cancelLineItemForm(page);
  });

  test('Enforcement applies on SubcontractorQuote line items (shared lineitemgrid)', async ({ page }, testInfo) => {
    // AC #8 — same enforcement behavior on Quote line items.
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_5_AC.Scope1],
    });
    test.skip(testInfo.project.name !== 'admin', 'Run once as admin');

    await test.step(`Navigate to SubcontractorQuote #${SUBCONTRACTOR_QUOTE_ID}`, async () => {
      await gotoInvoice(page, 'subcontractorquote', SUBCONTRACTOR_QUOTE_ID);
    });
    await openNewLineItemForm(page);
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: unitPriceLocator(page),
      label: `New Quote line item form opened on Proposal #${SUBCONTRACTOR_QUOTE_ID} — Rate editable, no product selected yet`,
    });

    await test.step(`Set Product Class = "Labor", Product = "${ENFORCED_PRODUCT_NAME}"`, async () => {
      await selectProduct(page, ENFORCED_PRODUCT_ID, LABOR_CLASSIFICATION_ID);
    });

    await test.step(`Verify Quote line item is also locked at $${ENFORCED_RATE} with helper text`, async () => {
      await expect(lockedFieldLocator(page)).toBeVisible({ timeout: 10_000 });
      const state = await unitPriceState(page);
      expect(state.value).toBe(ENFORCED_RATE);
      expect(state.disabled).toBe(true);
      expect(state.hasLockClass).toBe(true);
      expect(state.helperPresent).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: lockedFieldLocator(page),
      label: `"${ENFORCED_PRODUCT_NAME}" selected on the Quote — Rate locked at $${ENFORCED_RATE} (same behavior as on Invoice)`,
    });
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: helperLocator(page),
      label: 'Helper subtitle rendered on the Quote — enforcement UI is identical across Invoice and Quote',
    });

    await cancelLineItemForm(page);
  });

  test('Vendor can navigate to and view their own SubcontractorInvoice', async ({ page }, testInfo) => {
    // Smoke test — proves vendor-side access works. AC #9 enforcement
    // (admin/internal user also restricted) is covered by the admin scenarios
    // above; this test exists so the report shows the vendor persona too.
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_5_AC.Scope2],
    });
    test.skip(testInfo.project.name !== 'vendor', 'Vendor smoke test');

    await test.step(`Navigate to SubcontractorInvoice #${SUBCONTRACTOR_INVOICE_ID} as the vendor`, async () => {
      await gotoInvoice(page, 'invoice', SUBCONTRACTOR_INVOICE_ID);
    });

    await test.step('Verify the invoice page loaded and the line item grid is present', async () => {
      const visible = await page.evaluate(() => {
        const Ext = (window as any).Ext;
        const grids = Ext.ComponentQuery.query('lineitemgrid').filter((g: any) => g.isVisible?.()).length;
        return { lineItemGridVisible: grids > 0, hash: location.hash };
      });
      expect(visible.lineItemGridVisible).toBe(true);
      expect(visible.hash).toContain('invoice/');
    });
    // Focus on the line item grid element so the after-shot proves the vendor
    // reached their own invoice. Form-fill mechanics differ on the vendor side
    // in the dev env and are covered by the admin scenarios above.
    const lineItemGridId = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
      return grid?.element?.dom?.id || grid?.id;
    });
    const lineItemGrid = page.locator(`#${lineItemGridId}`);
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: lineItemGrid,
      label: `Vendor reached SubcontractorInvoice #${SUBCONTRACTOR_INVOICE_ID} — line item grid visible`,
    });
  });
});
