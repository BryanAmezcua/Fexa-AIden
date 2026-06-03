import { test, expect, Locator, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { annotateAc, captureAcSnapshot, TANGO_4_AC } from '../../src/support/qa-report';

/**
 * Enforcement toggle on pricing records — TANGO-4.
 *
 * Adds a "Do not allow pricing to be modified" toggle to the Subcontractor
 * Product Pricing side edit panel. The toggle can only be enabled when the
 * pricing has a calculable rate (`pricing_type` set + `base_price > 0`).
 *
 * Ticket status at QA-write time: `failed qa` — re-QA against PR #6916 which
 * fixed the AC #6 inline-validation issue surfaced in Bryan's first pass.
 * Latest PM clarification (michelle.klaer, 2026-05-21): "Flat rate and base
 * price are the fields and values we care about for this change."
 *
 * The DB column is `prevent_price_modification` despite AC #1 saying
 * `do_not_allow_price_modification`; comment thread confirms this was a
 * naming decision during dev.
 *
 * Pre-requisite: `npm run seed:enforcement-toggle` to create the seeded
 * Locked Flat Rate $100 pricing used by the AC Edge #1 scenario.
 */

const TICKET = 'TANGO-4';

// Seed-known IDs (kept in sync with seeds/enforcement-toggle.rb).
const SEED_IDS = {
  productId: 20,                  // Materials Incurred (Material classification)
  productClassificationId: 2,     // Material
  vendorRoleId: 183,              // 1st Quality Electric, Inc
} as const;

const PRODUCT_NAME    = 'Materials Incurred';
const VENDOR_NAME     = '1st Quality Electric, Inc';
const LOCKED_FIXTURE  = 'Enforcement Toggle - Locked Flat Rate $100';

// Verbatim AC strings — for text/tooltip assertions.
const TOGGLE_LABEL    = 'Do not allow pricing to be modified';
const TOGGLE_TOOLTIP  = 'At invoicing, you can enforce prices on line items and allow/disallow modifications or overrides. Turning this on disallows price overrides';

// ENVIRONMENT / COPY NOTE (verified 2026-06-03):
// Two wordings of the enforcement-calculable-rate inline validation are in
// play, and which one renders depends on the local build state:
//   (a) ORIGINAL AC #6 copy, verbatim:
//       "Enforcement requires a pricing type with a base price or percent configured"
//   (b) CURRENT copy after Kevin's final-AC fix (config/locales/en.yml @
//       aa861498d8, 2026-05-23 "restrict enforcement to Flat Rate + base_price"):
//       "Enforcement requires a flat rate pricing type with a base price configured"
// The local fast-mode build serves copy (a): the Sencha JS LOGIC build is
// current (app.js built 2026-06-02, includes the 05-23 GridController.js fix),
// but the static translations asset public/scripts/translations.js is dated
// 2026-05-14 — pre-05-23 — so the rendered wording is the old AC #6 text. The
// deployed qatesting env (where Ashiq deployed the build) renders copy (b).
// Per Fexa-AIden's hard rule we do NOT regenerate the Fexy-Zamo asset.
// We therefore assert on the phrase SHARED by both wordings, so the test
// validates the functional behavior (the inline validation appears and blocks
// the save) independent of the wording drift. The report screenshots capture
// the exact rendered copy, and TANGO_4_AC.Expected6 preserves the AC verbatim.
const VALIDATION_COPY_RENDERED = 'pricing type with a base price';

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

/** Navigate to a pricings grid by its ctype. Retries the hash navigation
 * if the grid doesn't mount within 30s — the app sometimes hijacks the
 * route to #dashboard on cold load, and a second History.add fixes it. */
async function gotoPricingsGrid(page: Page, ctype: 'subcontractorproductpricings' | 'clientproductpricings'): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate((c) => { (window as any).Ext.History.add(c); }, ctype);
    try {
      await page.waitForFunction(() => {
        return (window as any).Ext.ComponentQuery.query('accountingpricinggrid').length > 0;
      }, null, { timeout: 30_000 });
      await page.waitForTimeout(2000);
      return;
    } catch {
      // Re-trigger hash navigation after a short pause.
      await page.waitForTimeout(2000);
    }
  }
  throw new Error(`gotoPricingsGrid: ${ctype} grid never mounted after 3 attempts`);
}

/** Click "+" to open the new pricing form (uses TANGO-3 createItemBtn pattern). */
async function openNewPricingForm(page: Page): Promise<void> {
  const rect = await page.evaluate(() => {
    const btn = (window as any).Ext.ComponentQuery.query('button[reference=createItemBtn]')[0];
    const el = btn?.element?.dom;
    const r = el?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (!rect) throw new Error('createItemBtn not found');
  await page.mouse.click(rect.x, rect.y);
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('sideeditmenu').some((m: any) => m.isVisible?.());
  }, null, { timeout: 10_000 });
  await page.waitForTimeout(800);
}

/** Open existing pricing by name for edit — uses the showMenu(record) API. */
async function openPricingForEdit(page: Page, name: string): Promise<void> {
  const row = page.locator('.x-gridrow').filter({ hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.locator('.x-gridcell').first().dblclick();
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('sideeditmenu').some((m: any) => m.isVisible?.());
  }, null, { timeout: 10_000 });
  await page.waitForTimeout(500);
}

/**
 * Resolve an Ext field (queried by its `name` attribute) to a Playwright
 * Locator by its DOM id. Used to scope captureAcSnapshot's `focus` so the
 * report screenshots are guaranteed to actually show the AC-proving element.
 */
async function fieldLocator(page: Page, name: string): Promise<Locator> {
  const id = await page.evaluate((n) => {
    const Ext = (window as any).Ext;
    const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
    const f = menu?.query?.(`[name=${n}]`)[0];
    return f?.element?.dom?.id || f?.id;
  }, name);
  if (!id) throw new Error(`fieldLocator: no Ext field with name="${name}" in side edit menu`);
  return page.locator(`#${id}`);
}

/** Read a field's config / state from the open side edit menu. */
async function readField(page: Page, name: string) {
  return await page.evaluate((fieldName) => {
    const Ext = (window as any).Ext;
    const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
    if (!menu) return null;
    const f = menu.query(`[name=${fieldName}]`)[0];
    if (!f) return { exists: false };
    return {
      exists: true,
      visible: !!f.isVisible?.(),
      disabled: !!f.getDisabled?.(),
      value: f.getValue?.(),
      tooltip: f.tooltip || f.getConfig?.('tooltip'),
      label: f.getFieldLabel?.() || f.fieldLabel,
    };
  }, name);
}

/** Set a field's value on the open side edit menu. */
async function setField(page: Page, name: string, value: unknown): Promise<void> {
  await page.evaluate(({ n, v }) => {
    const Ext = (window as any).Ext;
    const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
    menu?.query?.(`[name=${n}]`)[0]?.setValue?.(v);
  }, { n: name, v: value });
}

/** Click the form's Save button. */
async function clickSave(page: Page): Promise<void> {
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const btn = Ext.ComponentQuery.query('button[reference=saveButton]')[0];
    btn?.element?.dom?.click?.();
  });
}

/** Click the form's Cancel button (without persisting). */
async function clickCancel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const btn = Ext.ComponentQuery.query('button[reference=cancelButton]')[0];
    btn?.element?.dom?.click?.();
  });
  await page.waitForTimeout(500);
}

/** Cleanup leftover test pricings (any "[QA]" or "TANGO-4 Test" names). */
function cleanupTestPricings(): void {
  try {
    execSync(
      `psql -U postgres -d fmdev -c "DELETE FROM product_pricings WHERE name LIKE '[QA]%' OR name LIKE 'TANGO-4 Test%'"`,
      { stdio: 'pipe' },
    );
  } catch (err) {
    console.warn('[cleanup] failed:', (err as Error).message);
  }
}

// --- Tests ----------------------------------------------------------------

test.describe('Enforcement toggle on pricing records (TANGO-4)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(150_000);   // generous to account for cumulative Sencha boot lag across the chain

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'Per AC Permissions #1, only pricing admins edit the toggle');
  });

  test.afterEach(() => { cleanupTestPricings(); });

  test('Toggle appears in the Subcontractor Pricing side edit panel below Base Price/Percent', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_4_AC.Expected2],
    });

    await test.step('Navigate to Subcontractor Pricings grid', async () => {
      await gotoPricingsGrid(page, 'subcontractorproductpricings');
    });
    await test.step('Open New Pricing form (click "+" on grid toolbar)', async () => {
      await openNewPricingForm(page);
    });
    const toggleFocus = await fieldLocator(page, 'prevent_price_modification');
    await captureAcSnapshot(testInfo, page, 'before', { focus: toggleFocus });

    await test.step('Verify the toggle field exists, is visible, and is positioned after Base Price and Percent', async () => {
      const probe = await page.evaluate(() => {
        const Ext = (window as any).Ext;
        const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
        const visibleNamedFields = menu.query('field').filter((f: any) => f.isVisible?.() && f.name).map((f: any) => f.name);
        const toggleIdx     = visibleNamedFields.indexOf('prevent_price_modification');
        const basePriceIdx  = visibleNamedFields.indexOf('base_price');
        const percentIdx    = visibleNamedFields.indexOf('percent');
        return { visibleNamedFields, toggleIdx, basePriceIdx, percentIdx };
      });
      expect(probe.toggleIdx).toBeGreaterThan(-1);
      expect(probe.toggleIdx).toBeGreaterThan(probe.basePriceIdx);
      expect(probe.toggleIdx).toBeGreaterThan(probe.percentIdx);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: toggleFocus });

    await clickCancel(page);
  });

  test(`Toggle field's label is "${TOGGLE_LABEL}"`, async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_4_AC.Expected3],
    });

    await gotoPricingsGrid(page, 'subcontractorproductpricings');
    await openNewPricingForm(page);
    const toggleFocus = await fieldLocator(page, 'prevent_price_modification');
    await captureAcSnapshot(testInfo, page, 'before', { focus: toggleFocus });

    await test.step(`Read the toggle's rendered label and confirm verbatim: "${TOGGLE_LABEL}"`, async () => {
      // The label may live on the field's own config OR on its sibling textfield wrapper.
      const labelText = await page.evaluate((expectedLabel) => {
        const Ext = (window as any).Ext;
        const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
        // Search the form's labels + adjacent text for the AC string.
        const haystack = (menu.element?.dom?.innerText || '');
        return { found: haystack.includes(expectedLabel), excerpt: haystack };
      }, TOGGLE_LABEL);
      expect(labelText.found).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: toggleFocus });

    await clickCancel(page);
  });

  test(`Toggle field's hover tooltip matches AC #4 copy`, async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_4_AC.Expected4],
    });

    await gotoPricingsGrid(page, 'subcontractorproductpricings');
    await openNewPricingForm(page);
    const toggleFocus = await fieldLocator(page, 'prevent_price_modification');
    await captureAcSnapshot(testInfo, page, 'before', { focus: toggleFocus });

    await test.step('Read the toggle field\'s tooltip config and assert it matches the AC text', async () => {
      const field = await readField(page, 'prevent_price_modification');
      expect(field?.exists).toBe(true);
      // tooltip can be a string OR an object with text; normalize.
      const tooltipText = typeof field?.tooltip === 'string'
        ? field?.tooltip
        : (field?.tooltip as any)?.text || (field?.tooltip as any)?.html || '';
      expect(tooltipText).toContain(TOGGLE_TOOLTIP);
    });

    // Hover the toggle so the tooltip actually renders in the DOM, then
    // capture the viewport with the tooltip visible. We bypass the standard
    // helper for the after-screenshot because (a) it would re-scroll and
    // may dismiss the tooltip, and (b) Sencha tooltips render on body —
    // a focus-locator scroll is unnecessary once we've already proven the
    // toggle is in-frame in the before snapshot.
    await test.step('Hover the toggle to surface the rendered tooltip and capture the viewport', async () => {
      await toggleFocus.hover();
      // The tooltip renders absolutely-positioned on body. Wait until the
      // AC copy is visible in the DOM (Sencha's modern toolkit doesn't use
      // a stable class name for tooltips, so we filter by AC text).
      const renderedTooltip = page
        .locator('div')
        .filter({ hasText: TOGGLE_TOOLTIP })
        .last();
      await renderedTooltip.waitFor({ state: 'visible', timeout: 5_000 });
      // Small settle so any fade-in animation completes before the capture.
      await page.waitForTimeout(300);
      const outPath = testInfo.outputPath('ac-snapshot-after.png');
      await page.screenshot({ path: outPath, animations: 'disabled', caret: 'hide' });
      await testInfo.attach('ac-snapshot-after', { path: outPath, contentType: 'image/png' });
    });

    await clickCancel(page);
  });

  test('Toggle can be enabled when Pricing Type=Flat Rate and Base Price > 0', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_4_AC.Expected5],
    });
    const testName = `TANGO-4 Test - Happy Path ${Date.now()}`;

    await gotoPricingsGrid(page, 'subcontractorproductpricings');
    await openNewPricingForm(page);

    await test.step(`Fill form: Name="${testName}", Product="${PRODUCT_NAME}", Vendor="${VENDOR_NAME}", Pricing Type="Flat Rate", Base Price=100, Active=true`, async () => {
      await setField(page, 'name', testName);
      await setField(page, 'active', true);
      await setField(page, 'product_id', SEED_IDS.productId);
      await setField(page, 'product_classification_id', SEED_IDS.productClassificationId);
      await setField(page, 'role_id', SEED_IDS.vendorRoleId);
      await setField(page, 'pricing_type', 'Flat Rate');
      await setField(page, 'base_price', 100);
      // Wait for InfiniteCombo role_id to settle.
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        const m = Ext.ComponentQuery.query('sideeditmenu')[0];
        return m?.query?.('[name=role_id]')[0]?.getValue?.() != null;
      }, null, { timeout: 15_000 });
    });
    const toggleFocus = await fieldLocator(page, 'prevent_price_modification');
    await captureAcSnapshot(testInfo, page, 'before', { focus: toggleFocus });

    await test.step('Toggle prevent_price_modification ON; verify the field accepts the value without error', async () => {
      await setField(page, 'prevent_price_modification', true);
      await page.waitForTimeout(500);
      const field = await readField(page, 'prevent_price_modification');
      expect(field?.value).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: toggleFocus });

    await clickCancel(page);
  });

  test('Inline validation appears when enabling toggle without a calculable rate (AC #6 — previously failed)', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_4_AC.Expected5, TANGO_4_AC.Expected6],
    });
    const testName = `TANGO-4 Test - Inline Validation ${Date.now()}`;

    await gotoPricingsGrid(page, 'subcontractorproductpricings');
    await openNewPricingForm(page);

    await test.step(`Fill form WITHOUT base_price: Name="${testName}", Product="${PRODUCT_NAME}", Vendor="${VENDOR_NAME}", Pricing Type="Flat Rate", Base Price=(empty)`, async () => {
      await setField(page, 'name', testName);
      await setField(page, 'active', true);
      await setField(page, 'product_id', SEED_IDS.productId);
      await setField(page, 'product_classification_id', SEED_IDS.productClassificationId);
      await setField(page, 'role_id', SEED_IDS.vendorRoleId);
      await setField(page, 'pricing_type', 'Flat Rate');
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        const m = Ext.ComponentQuery.query('sideeditmenu')[0];
        return m?.query?.('[name=role_id]')[0]?.getValue?.() != null;
      }, null, { timeout: 15_000 });
    });
    const toggleFocus = await fieldLocator(page, 'prevent_price_modification');
    await captureAcSnapshot(testInfo, page, 'before', { focus: toggleFocus });

    await test.step('Toggle prevent_price_modification ON and click Save', async () => {
      await setField(page, 'prevent_price_modification', true);
      await page.waitForTimeout(400);
      await clickSave(page);
      await page.waitForTimeout(2500);
    });

    await test.step(`Verify INLINE validation surfaced (not a Save-failure toast) with copy: "${VALIDATION_COPY_RENDERED}"`, async () => {
      const surfaces = await page.evaluate((expectedCopy: string) => {
        const Ext = (window as any).Ext;
        const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
        // Look in the form's DOM for the expected copy.
        const formText = (menu?.element?.dom?.innerText || '').toLowerCase();
        const formHasInline = formText.includes(expectedCopy.toLowerCase());
        // Also check the field's reported errors / invalid state.
        const field = menu?.query?.('[name=prevent_price_modification]')[0];
        const fieldErrors = field?.getErrors?.() || [];
        // Surface any visible toast for diagnostics (this WAS the failure mode).
        const visibleToasts = Array.from(document.querySelectorAll('.x-toast,.x-msgbox'))
          .filter((e: any) => e.offsetParent !== null)
          .map((e: any) => (e.innerText || '').trim());
        return { formHasInline, fieldErrors, visibleToasts };
      }, VALIDATION_COPY_RENDERED);
      // The inline message must be present somewhere in the form.
      expect(surfaces.formHasInline).toBe(true);
    });
    // Focus on the validation message itself in the after snapshot — proves
    // the inline copy is actually rendered, not a toast.
    const validationFocus = page.locator('.x-sideeditmenu, .x-sheet').filter({ hasText: VALIDATION_COPY_RENDERED }).first();
    await captureAcSnapshot(testInfo, page, 'after', { focus: validationFocus });

    await clickCancel(page);
  });

  test('Recovery: correcting base_price after the validation fires clears the error and saves (Michelle re-QA 2026-05-15)', async ({ page }, testInfo) => {
    // Reproduces the blocking finding that put TANGO-4 in `failed qa`
    // (michelle.klaer, 2026-05-15): "I did not select base price and it would
    // not let me save. Even after I did the right thing I could not save and
    // error would not go away." The CORRECT behavior: once a valid base price
    // is supplied, the inline error clears and the save succeeds. If the
    // stuck-error bug is still present, the form stays open with the error and
    // these assertions fail — that is the finding.
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_4_AC.Expected5, TANGO_4_AC.Expected6],
    });
    const testName = `TANGO-4 Test - Recovery ${Date.now()}`;

    await gotoPricingsGrid(page, 'subcontractorproductpricings');
    await openNewPricingForm(page);

    await test.step(`Fill form WITHOUT base_price and toggle ON: Name="${testName}", Product="${PRODUCT_NAME}", Vendor="${VENDOR_NAME}", Pricing Type="Flat Rate", Base Price=(empty), prevent_price_modification=true`, async () => {
      await setField(page, 'name', testName);
      await setField(page, 'active', true);
      await setField(page, 'product_id', SEED_IDS.productId);
      await setField(page, 'product_classification_id', SEED_IDS.productClassificationId);
      await setField(page, 'role_id', SEED_IDS.vendorRoleId);
      await setField(page, 'pricing_type', 'Flat Rate');
      await setField(page, 'prevent_price_modification', true);
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        const m = Ext.ComponentQuery.query('sideeditmenu')[0];
        return m?.query?.('[name=role_id]')[0]?.getValue?.() != null;
      }, null, { timeout: 15_000 });
    });
    const toggleFocus = await fieldLocator(page, 'prevent_price_modification');
    await captureAcSnapshot(testInfo, page, 'before', { focus: toggleFocus });

    await test.step('First Save (no base price) — expect the inline validation to BLOCK the save', async () => {
      await clickSave(page);
      await page.waitForTimeout(2500);
      const surfaces = await page.evaluate((expectedCopy: string) => {
        const Ext = (window as any).Ext;
        const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
        const stillOpen = !!menu?.isVisible?.();
        const hasInline = (menu?.element?.dom?.innerText || '').toLowerCase().includes(expectedCopy.toLowerCase());
        return { stillOpen, hasInline };
      }, VALIDATION_COPY_RENDERED);
      expect(surfaces.stillOpen, 'form should stay open and block the save when base price is missing').toBe(true);
      expect(surfaces.hasInline, 'inline validation copy should be shown on the blocked save').toBe(true);
    });
    const validationFocus = page.locator('.x-sideeditmenu, .x-sheet').filter({ hasText: VALIDATION_COPY_RENDERED }).first();
    await captureAcSnapshot(testInfo, page, 'after', { focus: validationFocus, label: 'Validation blocks save (no base price)' });

    await test.step('Correct the record: set Base Price=100 (the "did the right thing" step from the finding)', async () => {
      await setField(page, 'base_price', 100);
      await page.waitForTimeout(600);
    });
    const basePriceFocus = await fieldLocator(page, 'base_price');
    await captureAcSnapshot(testInfo, page, 'after', { focus: basePriceFocus, label: 'Base Price corrected to 100' });

    await test.step('Second Save — the error MUST clear and the pricing MUST persist (stuck-error must not reproduce)', async () => {
      await clickSave(page);
      await page.waitForTimeout(1500);
      // The corrected pricing shares product+vendor scope with the seeded
      // fixture (id 25), so TANGO-3's non-blocking overlap warning fires on
      // save. Continue past it — the overlap is expected and is not what this
      // test is checking (it would otherwise hold the form open).
      const overlap = page.locator('.x-dialog').filter({ hasText: /Overlapping Pricing Found/i });
      if (await overlap.isVisible().catch(() => false)) {
        await overlap.locator('.x-button').filter({ hasText: /^Continue$/ }).click();
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(2500);
      const state = await page.evaluate((expectedCopy: string) => {
        const Ext = (window as any).Ext;
        const menus = Ext.ComponentQuery.query('sideeditmenu');
        const anyOpen = menus.some((m: any) => m.isVisible?.());
        const anyInline = menus.some((m: any) => (m?.element?.dom?.innerText || '').toLowerCase().includes(expectedCopy.toLowerCase()));
        const toasts = Array.from(document.querySelectorAll('.x-toast,.x-msgbox'))
          .filter((e: any) => e.offsetParent !== null)
          .map((e: any) => (e.innerText || '').trim());
        return { anyOpen, anyInline, toasts };
      }, VALIDATION_COPY_RENDERED);
      // Michelle's stuck-error (2026-05-15) would leave the enforcement
      // validation showing and the form OPEN even after a valid base price was
      // supplied. The fix means: the validation clears and the save proceeds.
      // (NB: the corrected pricing overlaps the seed fixture, so TANGO-3's
      // check_overlap may emit a non-blocking `pricings.overlap_check_failed`
      // toast — GridController.js:183-185 lets the save proceed regardless;
      // that is a TANGO-3 concern, not the TANGO-4 enforcement behavior here.)
      expect(state.anyInline, 'enforcement validation must clear once a valid base price is supplied').toBe(false);
      expect(state.anyOpen, 'side edit panel should close — the corrected save proceeds').toBe(false);
    });

    await test.step('Corroborate persistence in the grid (best-effort — the closed form + cleared validation already prove the save proceeded)', async () => {
      // Scan the loaded store defensively (findRecord throws on this store type).
      const found = await page.evaluate((nm: string) => {
        try {
          const Ext = (window as any).Ext;
          const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
          const store = grid?.getStore?.();
          const items = (store?.getData?.()?.items) || (store?.data?.items) || [];
          const rec = items.find((r: any) => ((r?.data?.name) ?? r?.get?.('name')) === nm);
          if (rec && grid?.ensureVisible) { try { grid.ensureVisible(rec); } catch {} }
          return !!rec;
        } catch { return false; }
      }, testName);
      await page.waitForTimeout(600);
      if (found) {
        const gridRow = page.locator('.x-gridrow').filter({ hasText: testName }).first();
        try {
          await gridRow.waitFor({ state: 'visible', timeout: 4_000 });
          await captureAcSnapshot(testInfo, page, 'after', { focus: gridRow, label: 'Saved - row present in grid' });
          return;
        } catch { /* fall through to the grid-context shot */ }
      }
      // Form is closed; we're back on the grid. Focus the first grid row — a
      // reliable visible DOM element — so the shot proves we returned to the
      // grid (the save proceeded). The grid is always populated here.
      const gridFocus = page.locator('.x-gridrow').first();
      await captureAcSnapshot(testInfo, page, 'after', { focus: gridFocus, label: 'Saved - form closed, returned to grid' });
    });
  });

  test('Toggle is independent of active flag (can enable on inactive pricing)', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_4_AC.Expected7],
    });
    const testName = `TANGO-4 Test - Active Independence ${Date.now()}`;

    await gotoPricingsGrid(page, 'subcontractorproductpricings');
    await openNewPricingForm(page);

    await test.step(`Fill form with Active=false, Pricing Type="Flat Rate", Base Price=200`, async () => {
      await setField(page, 'name', testName);
      await setField(page, 'active', false);   // toggle is independent of active
      await setField(page, 'product_id', SEED_IDS.productId);
      await setField(page, 'product_classification_id', SEED_IDS.productClassificationId);
      await setField(page, 'role_id', SEED_IDS.vendorRoleId);
      await setField(page, 'pricing_type', 'Flat Rate');
      await setField(page, 'base_price', 200);
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        const m = Ext.ComponentQuery.query('sideeditmenu')[0];
        return m?.query?.('[name=role_id]')[0]?.getValue?.() != null;
      }, null, { timeout: 15_000 });
    });
    const toggleFocus = await fieldLocator(page, 'prevent_price_modification');
    await captureAcSnapshot(testInfo, page, 'before', { focus: toggleFocus });

    await test.step('Enable prevent_price_modification while Active is OFF; verify accepted', async () => {
      await setField(page, 'prevent_price_modification', true);
      await page.waitForTimeout(500);
      const probe = await page.evaluate(() => {
        const Ext = (window as any).Ext;
        const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
        return {
          active: menu?.query?.('[name=active]')[0]?.getValue?.(),
          toggle: menu?.query?.('[name=prevent_price_modification]')[0]?.getValue?.(),
        };
      });
      expect(probe.active).toBe(false);
      expect(probe.toggle).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: toggleFocus });

    await clickCancel(page);
  });

  test('Save validation error after clearing base_price on an already-enforced pricing (AC Edge #1)', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_4_AC.Edge1],
    });

    await gotoPricingsGrid(page, 'subcontractorproductpricings');

    await test.step(`Open seeded fixture "${LOCKED_FIXTURE}" (Flat Rate $100, toggle ON) for edit`, async () => {
      await openPricingForEdit(page, LOCKED_FIXTURE);
    });
    // Before snapshot focused on base_price — its current value will be cleared next.
    const basePriceFocus = await fieldLocator(page, 'base_price');
    await captureAcSnapshot(testInfo, page, 'before', { focus: basePriceFocus });

    await test.step('Clear Base Price (set to null/0) while leaving toggle ON, then click Save', async () => {
      await setField(page, 'base_price', null);
      await page.waitForTimeout(500);
      await clickSave(page);
      await page.waitForTimeout(2500);
    });

    await test.step(`Verify save was rejected with the inline validation surfaced (copy: "${VALIDATION_COPY_RENDERED}")`, async () => {
      const surfaces = await page.evaluate((expectedCopy: string) => {
        const Ext = (window as any).Ext;
        const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
        const stillOpen = !!menu?.isVisible?.();
        const formText = (menu?.element?.dom?.innerText || '').toLowerCase();
        const hasInline = formText.includes(expectedCopy.toLowerCase());
        return { stillOpen, hasInline };
      }, VALIDATION_COPY_RENDERED);
      expect(surfaces.stillOpen).toBe(true);
      expect(surfaces.hasInline).toBe(true);
    });
    // After snapshot focused on the validation copy itself — proves the
    // inline message is actually rendered after save was rejected.
    const validationFocus = page.locator('.x-sideeditmenu, .x-sheet').filter({ hasText: VALIDATION_COPY_RENDERED }).first();
    await captureAcSnapshot(testInfo, page, 'after', { focus: validationFocus });

    // Cancel to restore the fixture's original state (avoids polluting other runs).
    await clickCancel(page);
  });

  test('Toggle is NOT present on the Client Pricing side edit panel', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      // No specific AC bullet; verified during initial QA by Bryan (2026-05-08):
      // "Toggle only present on Subcontractor Pricing page".
      ac: [TANGO_4_AC.Expected2],
    });

    await test.step('Navigate to Client Pricings grid (#clientproductpricings)', async () => {
      await gotoPricingsGrid(page, 'clientproductpricings');
    });
    await test.step('Open New Pricing form on Client Pricing', async () => {
      await openNewPricingForm(page);
    });
    // Focus on a field that DOES exist (Pricing Type) — scrolls the side edit
    // menu into view so the viewer can confirm the toggle's absence in the
    // correct visual context. Screenshot is the full viewport (no crop).
    const pricingTypeFocus = await fieldLocator(page, 'pricing_type');
    await captureAcSnapshot(testInfo, page, 'before', { focus: pricingTypeFocus });

    await test.step('Verify the prevent_price_modification field is NOT present on the Client form', async () => {
      const field = await readField(page, 'prevent_price_modification');
      const truly_absent = !field || field.exists === false || field.visible === false;
      expect(truly_absent).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: pricingTypeFocus });

    await clickCancel(page);
  });
});
