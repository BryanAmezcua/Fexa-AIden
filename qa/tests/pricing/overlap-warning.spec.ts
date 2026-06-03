import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { annotateAc, captureAcSnapshot, TANGO_3_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-3';

/**
 * Format a key/value bag as a `key="value", key="value"` string for use
 * in test.step() labels. Booleans/numbers print without quotes; strings
 * get quoted. Helps make each step reproducible from the report alone.
 */
function describeInputs(inputs: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(inputs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => typeof v === 'string' ? `${k}="${v}"` : `${k}=${v}`)
    .join(', ');
}

/**
 * Overlap warning for ProductPricing records — TANGO-3.
 *
 * Background: when an admin saves a SubcontractorProductPricing, the system
 * checks for other active pricings sharing the same product, vendor role,
 * and an overlapping effective date range. If any are found, a non-blocking
 * confirmation dialog is shown listing the conflicts; the admin can
 * Continue (persist anyway) or Cancel.
 *
 * Pre-requisite: run `npm run seed:pricing-overlap` to create the baseline
 * fixtures these tests collide with:
 *   - "Overlap Scenario - Baseline Annual"   (active, current year)
 *   - "Overlap Scenario - Future Window"     (active, next year)
 *   - "Overlap Scenario - Deactivated"       (inactive, current year)
 *   - "Overlap Scenario - Facility Scoped"   (active, current year, facility=1)
 *
 * All four baselines share the same product ('Regular Rate') and the same
 * subcontractor role; tests drive the UI to create *new* pricings against
 * that same product/vendor and verify the warning behavior.
 */

// --- Fixtures the seed creates (kept in sync with seeds/pricing-overlap.rb) ---
const FIXTURE = {
  baselineAnnual:   'Overlap Scenario - Baseline Annual',
  futureWindow:    'Overlap Scenario - Future Window',
  deactivated:     'Overlap Scenario - Deactivated',
  facilityScoped:  'Overlap Scenario - Facility Scoped',
} as const;

const PRODUCT_NAME = 'Regular Rate';
const VENDOR_NAME  = '1st Quality Electric, Inc';   // matches seeds/pricing-overlap.rb's first SubcontractorRole

// Seeded IDs the seed prints — kept here as constants so the form-fill helper
// doesn't have to look them up at runtime. If the local DB is reseeded with
// different IDs, update these or have the seed write them to a JSON file.
const SEED_IDS = {
  productId: 23,                  // Products::Product 'Regular Rate'
  productClassificationId: 1,     // 'Labor' classification on Regular Rate
  vendorRoleId: 183,              // SubcontractorRole for '1st Quality Electric, Inc'
  baselineFacilityId: 1,          // Pitstop 0006 — used by FIXTURE.facilityScoped
  otherFacilityId: 2,             // Pitstop 0033 — used by cross-facility test
} as const;

// --- Helpers ---

/**
 * Wait for the Fexa Ext JS app to be ready beyond just `Ext.isReady` — the
 * support widget loads first; we want the main app chrome (many containers
 * + the navigationTree). REQUIRES TANGO fast-mode (npm run fexa:fast-mode);
 * dev-mode Sencha takes 60–120s on a cold cache.
 */
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

/**
 * Navigate to the Subcontractor Pricings grid (the screen the AC concerns).
 * The app auto-routes to #dashboard on load, then we override the hash to
 * the pricings ctype. Direct `goto('/main/index#…')` doesn't work because
 * the app re-routes to dashboard during startup.
 */
async function gotoPricingsGrid(page: Page): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);
  // Retry hash navigation if the grid doesn't mount in 30s — the app
  // sometimes hijacks the route to #dashboard on cold load.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => { (window as any).Ext.History.add('subcontractorproductpricings'); });
    try {
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        return Ext?.ComponentQuery.query('accountingpricinggrid').length > 0;
      }, null, { timeout: 30_000 });
      await page.waitForTimeout(2000);
      return;
    } catch {
      await page.waitForTimeout(2000);
    }
  }
  throw new Error('gotoPricingsGrid: accountingpricinggrid never mounted after 3 attempts');
}

interface PricingFormInput {
  name: string;
  product: string;
  vendor: string;
  pricingType?: 'Flat Rate' | 'Increase' | 'Decrease';
  basePrice?: number;
  effectiveStart?: string;        // ISO yyyy-mm-dd
  effectiveEnd?: string;
  /** Facility ID, or null to clear, or undefined to leave unset. */
  facility?: number | null;
  active?: boolean;
}

/**
 * Click an Ext button via a real mouse click on its bounding rect (Sencha's
 * `tap` listeners aren't reached by synthetic fireEvent calls).
 */
async function clickExtComponent(page: Page, selector: string, label: string): Promise<void> {
  const rect = await page.evaluate((sel) => {
    const c = (window as any).Ext.ComponentQuery.query(sel)[0];
    const el = c?.element?.dom;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  if (!rect) throw new Error(`${label} not found (selector: ${selector})`);
  await page.mouse.click(rect.x, rect.y);
}

/** Open the "new pricing" form (sideeditmenu) and fill in fields. Does NOT click Save. */
async function openNewPricingForm(page: Page, input: PricingFormInput): Promise<void> {
  await clickExtComponent(page, 'button[reference=createItemBtn]', 'createItemBtn');
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('sideeditmenu').some((m: any) => m.isVisible?.());
  }, null, { timeout: 10_000 });
  await page.waitForTimeout(500);

  // Map the test-friendly input to the actual field names + values the
  // sideeditmenu expects. Combos require IDs (the seed's known values).
  const productId               = input.product === PRODUCT_NAME ? SEED_IDS.productId : null;
  const productClassificationId = SEED_IDS.productClassificationId;  // implicit for our test product
  const roleId                  = input.vendor  === VENDOR_NAME  ? SEED_IDS.vendorRoleId : null;
  const facilityId              = input.facility;  // undefined | null | number

  await page.evaluate((args) => {
    const menu = (window as any).Ext.ComponentQuery.query('sideeditmenu')[0];
    const set = (name: string, value: any) => {
      if (value === undefined) return;
      const f = menu.query(`[name=${name}]`)[0];
      if (f) f.setValue(value);
    };
    set('name', args.name);
    set('active', args.active);
    set('product_id', args.productId);
    set('product_classification_id', args.productClassificationId);
    set('role_id', args.roleId);
    set('pricing_type', args.pricingType);
    set('base_price', args.basePrice);
    // Build dates at UTC NOON. The form serializes Date via toISOString() →
    // UTC. Postgres takes the UTC date component, so we need the *UTC* date
    // to match the intended Y-M-D. UTC noon ensures both the UTC date AND the
    // local date display are correct for any user timezone from UTC-11 to UTC+12
    // (covers all practical QA envs). Local noon is wrong: it shifts to the
    // previous UTC day in any negative-offset timezone.
    const parseUtcNoon = (ymd: string): Date => {
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    };
    if (args.effectiveStartYmd) set('effective_start_date', parseUtcNoon(args.effectiveStartYmd));
    if (args.effectiveEndYmd)   set('effective_end_date',   parseUtcNoon(args.effectiveEndYmd));
    if (args.facilityId !== undefined) set('facility_id', args.facilityId);
  }, {
    name: input.name,
    active: input.active,
    productId, productClassificationId, roleId,
    pricingType: input.pricingType,
    basePrice: input.basePrice,
    // Pass YYYY-MM-DD; parsed inside the page via Ext.Date.parse (local time).
    effectiveStartYmd: input.effectiveStart,
    effectiveEndYmd:   input.effectiveEnd,
    facilityId,
  });

  // InfiniteCombo (vendor, facility, brand, zone) is async — setValue starts
  // a paginated store load via `loadTillValue` and the actual value isn't
  // set synchronously. Poll until the values we care about are persisted on
  // the form before Save can fire.
  const expectedRole     = roleId;
  const expectedFacility = facilityId;
  await page.waitForFunction((expected) => {
    const menu = (window as any).Ext.ComponentQuery.query('sideeditmenu')[0];
    if (!menu) return false;
    const get = (n: string) => menu.query(`[name=${n}]`)[0]?.getValue?.();
    if (expected.role !== null && get('role_id') !== expected.role) return false;
    if (expected.facility !== undefined && expected.facility !== null && get('facility_id') !== expected.facility) return false;
    return true;
  }, { role: expectedRole, facility: expectedFacility }, { timeout: 15_000 });
}

/**
 * Open an existing pricing row by name for editing. The pricings grid has
 * inline cell editing that hijacks dblclick on cells, so we invoke the
 * sideeditmenu's `showMenu(record)` directly — that's the same call the
 * SideEditMenu plugin's `childdoubletap` handler makes.
 *
 * Requires the grid's store to be loaded; the helper loads it explicitly
 * because virtual stores only load on interaction by default.
 */
async function openPricingForEdit(page: Page, name: string): Promise<void> {
  // Find the row by visible name; the grid uses virtual rendering so the
  // row must be in the viewport.
  const row = page.locator('.x-gridrow').filter({ hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  // The grid has CellEditingPlugin which hijacks dblclick on editable cells.
  // The ID column is read-only — dblclicking there falls through to the
  // SideEditMenu plugin's `childdoubletap` handler, which opens the menu
  // with the row's record.
  await row.locator('.x-gridcell').first().dblclick();
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('sideeditmenu').some((m: any) => m.isVisible?.());
  }, null, { timeout: 10_000 });

  // The record is bound to the inner formpanel (per SideEditMenu/Controller#
  // defaultRecordToForm: `form.setRecord(rec)`), not the menu itself.
  // InfiniteCombo fields don't auto-fire their setValue when the form
  // populates — they're set via the form's internal value sync, which keeps
  // the field's _value null until setValue() is called explicitly.
  // Re-trigger setValue for role_id and facility_id with the record's
  // values to kick off the InfiniteCombo's async paginated load.
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
    const record = menu.down('formpanel')?.getRecord?.();
    if (!record) return;
    for (const fieldName of ['role_id', 'facility_id']) {
      const f = menu.query(`[name=${fieldName}]`)[0];
      const v = record.get?.(fieldName);
      if (f && v != null) f.setValue(v);
    }
  });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
    const role = menu?.query('[name=role_id]')[0];
    return role?.getValue?.() != null;
  }, null, { timeout: 15_000 });
  await page.waitForTimeout(500);
}

/**
 * Modify specific fields on the currently-open sideeditmenu. Used for edit
 * flows where the form is already populated with an existing record's data
 * and we only want to change a few fields.
 */
async function modifyOpenPricingForm(page: Page, changes: {
  effectiveStart?: string;
  effectiveEnd?: string;
}): Promise<void> {
  await page.evaluate((args) => {
    const menu = (window as any).Ext.ComponentQuery.query('sideeditmenu')[0];
    const set = (name: string, value: any) => {
      if (value === undefined) return;
      const f = menu.query(`[name=${name}]`)[0];
      if (f) f.setValue(value);
    };
    const parseUtcNoon = (ymd: string): Date => {
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    };
    if (args.effectiveStartYmd) set('effective_start_date', parseUtcNoon(args.effectiveStartYmd));
    if (args.effectiveEndYmd)   set('effective_end_date',   parseUtcNoon(args.effectiveEndYmd));
  }, {
    effectiveStartYmd: changes.effectiveStart,
    effectiveEndYmd:   changes.effectiveEnd,
  });
}

/** Click Save on the open pricing form. */
async function clickSave(page: Page): Promise<void> {
  await clickExtComponent(page, 'button[reference=saveButton]', 'saveButton');
}

/**
 * Locator for the overlap-warning confirmation dialog. xtype `dialog`,
 * title "Overlapping Pricing Found", with Cancel/Continue buttons (no
 * reference attribute — match by text).
 */
function warningDialog(page: Page) {
  return page.locator('.x-dialog').filter({ hasText: /Overlapping Pricing Found/i });
}

/**
 * Cleanup helper — deletes any test-created pricings by name pattern.
 * Uses psql directly because tests run against a local DB; saves a round
 * trip through the API and avoids needing to know dynamic_index filter
 * syntax. Tests create pricings with names prefixed '[QA]'.
 */
function cleanupTestPricings(): void {
  try {
    execSync(
      `psql -U postgres -d fmdev -c "DELETE FROM product_pricings WHERE name LIKE '[QA]%'"`,
      { stdio: 'pipe' },
    );
  } catch (err) {
    // Don't fail tests if cleanup hiccups — log and proceed.
    console.warn('[cleanup] failed:', (err as Error).message);
  }
}

/**
 * Reliable DB-side check for whether a pricing with `name` was persisted.
 * More dependable than querying the Ext store, which may not have reloaded
 * by the time we assert.
 */
function pricingExistsInDb(name: string): boolean {
  const escaped = name.replace(/'/g, "''");
  const out = execSync(
    `psql -U postgres -d fmdev -tA -c "SELECT COUNT(*) FROM product_pricings WHERE name = '${escaped}'"`,
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString().trim();
  return parseInt(out, 10) > 0;
}

// --- Scenarios (one per AC clause) ---

test.describe('ProductPricing overlap warning', () => {
  // Run serially — each test navigates the Ext app from scratch which is
  // heavy; parallel workers overwhelm the dev server and trip beforeEach
  // timeouts. Bumped per-test timeout from the default 30s to 90s to give
  // the Sencha app room to settle.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  // Pricings administration is admin-only; skip for vendor and facility-manager
  // projects so we don't run permission-denied flows or noise the report.
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'Pricings management is admin-only');
    await gotoPricingsGrid(page);
  });

  // Each test creates [QA]-prefixed pricings; clear them after each test so
  // subsequent tests start with only the baseline fixtures present.
  test.afterEach(() => {
    cleanupTestPricings();
  });

  test('warns when saving a new pricing that overlaps on product, vendor, and effective dates', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_3_AC.ExpectedBehavior1, TANGO_3_AC.ExpectedBehavior2],
    });
    const testName = `[QA] Overlap Trigger ${Date.now()}`;
    const thisYear = new Date().getFullYear();
    const inputs = {
      Name: testName, Product: PRODUCT_NAME, Vendor: VENDOR_NAME,
      'Pricing Type': 'Flat Rate', 'Base Price': 200,
      'Effective Start Date': `${thisYear}-06-01`,
      'Effective End Date':   `${thisYear}-12-31`,
      Active: true,
    } as const;

    await test.step('Navigate to Subcontractor Pricings grid (Admin → Accounting → Subcontractor Pricing)', async () => {
      // Done by beforeEach. Listed here so the step shows up in the report.
    });
    await test.step(`Open New Pricing form (click "+" button on grid toolbar)`, async () => {
      await openNewPricingForm(page, {
        name: testName, product: PRODUCT_NAME, vendor: VENDOR_NAME,
        pricingType: 'Flat Rate', basePrice: 200,
        effectiveStart: `${thisYear}-06-01`, effectiveEnd: `${thisYear}-12-31`,
        active: true,
      });
    });
    await test.step(`Fill form fields → ${describeInputs(inputs)}`, async () => {
      // Form was filled by the previous step's helper; this step exists so the
      // report has an explicit "what was typed" line a reader can replay by hand.
    });
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step('Click "Save" button', async () => { await clickSave(page); });

    await test.step('Verify warning dialog "Overlapping Pricing Found" appears', async () => {
      await expect(warningDialog(page)).toBeVisible({ timeout: 10_000 });
    });
    // After snapshot focused on the dialog — proves the warning was actually
    // rendered (not just the form sitting in some state).
    await captureAcSnapshot(testInfo, page, 'after', { focus: warningDialog(page) });

    await test.step('Click "Cancel" in warning dialog (do not persist test data)', async () => {
      await warningDialog(page).locator('.x-button').filter({ hasText: /^Cancel$/ }).click();
      await expect(warningDialog(page)).toBeHidden({ timeout: 5_000 });
    });
  });

  test('lists the conflicting pricings in the warning dialog', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_3_AC.ExpectedBehavior2a],
    });
    const testName = `[QA] Conflict Listing ${Date.now()}`;
    const thisYear = new Date().getFullYear();
    const inputs = {
      Name: testName, Product: PRODUCT_NAME, Vendor: VENDOR_NAME,
      'Pricing Type': 'Flat Rate', 'Base Price': 200,
      'Effective Start Date': `${thisYear}-03-01`,
      'Effective End Date':   `${thisYear}-09-30`,
      Active: true,
    } as const;

    await test.step('Navigate to Subcontractor Pricings grid', async () => {});
    await test.step('Open New Pricing form', async () => {
      await openNewPricingForm(page, {
        name: testName, product: PRODUCT_NAME, vendor: VENDOR_NAME,
        pricingType: 'Flat Rate', basePrice: 200,
        effectiveStart: `${thisYear}-03-01`, effectiveEnd: `${thisYear}-09-30`,
        active: true,
      });
    });
    await test.step(`Fill form fields → ${describeInputs(inputs)}`, async () => {});
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step('Click "Save" button', async () => { await clickSave(page); });

    const dialog = warningDialog(page);
    await test.step('Verify dialog lists Baseline Annual; excludes Future Window (non-overlapping dates) and Deactivated (inactive)', async () => {
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText(FIXTURE.baselineAnnual);
      await expect(dialog).not.toContainText(FIXTURE.futureWindow);
      await expect(dialog).not.toContainText(FIXTURE.deactivated);
    });
    await test.step('Verify dialog shows columns: ID, Name, Product, Product Class, Vendor', async () => {
      for (const heading of ['ID', 'Name', 'Product', 'Product Class', 'Vendor']) {
        await expect(dialog).toContainText(heading);
      }
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: dialog });

    await test.step('Click "Cancel" in warning dialog', async () => {
      await dialog.locator('.x-button').filter({ hasText: /^Cancel$/ }).click();
    });
  });

  test('Continue persists the new pricing despite the overlap (non-blocking)', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_3_AC.ExpectedBehavior2],
    });
    const testName = `[QA] Continue Save ${Date.now()}`;
    const thisYear = new Date().getFullYear();
    const inputs = {
      Name: testName, Product: PRODUCT_NAME, Vendor: VENDOR_NAME,
      'Pricing Type': 'Flat Rate', 'Base Price': 200,
      'Effective Start Date': `${thisYear}-06-01`,
      'Effective End Date':   `${thisYear}-12-31`,
      Active: true,
    } as const;

    await test.step('Navigate to Subcontractor Pricings grid', async () => {});
    await test.step('Open New Pricing form', async () => {
      await openNewPricingForm(page, {
        name: testName, product: PRODUCT_NAME, vendor: VENDOR_NAME,
        pricingType: 'Flat Rate', basePrice: 200,
        effectiveStart: `${thisYear}-06-01`, effectiveEnd: `${thisYear}-12-31`,
        active: true,
      });
    });
    await test.step(`Fill form fields → ${describeInputs(inputs)}`, async () => {});
    await test.step('Click "Save" button', async () => { await clickSave(page); });

    const dialog = warningDialog(page);
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // Before snapshot: dialog visible (the moment user must decide).
    await captureAcSnapshot(testInfo, page, 'before', { focus: dialog });

    await test.step('Click "Continue" in warning dialog', async () => {
      await dialog.locator('.x-button').filter({ hasText: /^Continue$/ }).click();
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    });

    await test.step(`Verify pricing "${testName}" was persisted (queried via psql against product_pricings table)`, async () => {
      await expect.poll(() => pricingExistsInDb(testName), { timeout: 10_000 }).toBe(true);
    });
    // After snapshot: the pricing in the grid (proves persistence visually).
    const persistedRow = page.locator('.x-gridrow').filter({ hasText: testName }).first();
    await captureAcSnapshot(testInfo, page, 'after', { focus: persistedRow });
  });

  test('Cancel aborts the save and no new pricing is created', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_3_AC.ExpectedBehavior2],
    });
    const testName = `[QA] Cancel Save ${Date.now()}`;
    const thisYear = new Date().getFullYear();
    const inputs = {
      Name: testName, Product: PRODUCT_NAME, Vendor: VENDOR_NAME,
      'Pricing Type': 'Flat Rate', 'Base Price': 200,
      'Effective Start Date': `${thisYear}-06-01`,
      'Effective End Date':   `${thisYear}-12-31`,
      Active: true,
    } as const;

    await test.step('Navigate to Subcontractor Pricings grid', async () => {});
    await test.step('Open New Pricing form', async () => {
      await openNewPricingForm(page, {
        name: testName, product: PRODUCT_NAME, vendor: VENDOR_NAME,
        pricingType: 'Flat Rate', basePrice: 200,
        effectiveStart: `${thisYear}-06-01`, effectiveEnd: `${thisYear}-12-31`,
        active: true,
      });
    });
    await test.step(`Fill form fields → ${describeInputs(inputs)}`, async () => {});
    await test.step('Click "Save" button', async () => { await clickSave(page); });

    const dialog = warningDialog(page);
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await captureAcSnapshot(testInfo, page, 'before', { focus: dialog });

    await test.step('Click "Cancel" in warning dialog', async () => {
      await dialog.locator('.x-button').filter({ hasText: /^Cancel$/ }).click();
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    });

    await test.step(`Verify pricing "${testName}" was NOT written (queried via psql)`, async () => {
      await page.waitForTimeout(1000);
      expect(pricingExistsInDb(testName)).toBe(false);
    });
    // After snapshot: pricings grid (no new row should be present).
    const grid = page.locator('.x-grid').first();
    await captureAcSnapshot(testInfo, page, 'after', { focus: grid });
  });

  test('does not warn when effective date ranges do not overlap', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_3_AC.Scope2],
    });
    const testName = `[QA] Non Overlap ${Date.now()}`;
    const twoYearsOut = new Date().getFullYear() + 2;
    const inputs = {
      Name: testName, Product: PRODUCT_NAME, Vendor: VENDOR_NAME,
      'Pricing Type': 'Flat Rate', 'Base Price': 200,
      'Effective Start Date': `${twoYearsOut}-01-01`,
      'Effective End Date':   `${twoYearsOut}-12-31`,
      Active: true,
    } as const;

    await test.step('Navigate to Subcontractor Pricings grid', async () => {});
    await test.step('Open New Pricing form', async () => {
      await openNewPricingForm(page, {
        name: testName, product: PRODUCT_NAME, vendor: VENDOR_NAME,
        pricingType: 'Flat Rate', basePrice: 200,
        effectiveStart: `${twoYearsOut}-01-01`, effectiveEnd: `${twoYearsOut}-12-31`,
        active: true,
      });
    });
    await test.step(`Fill form fields → ${describeInputs(inputs)} (dates two years past any baseline)`, async () => {});
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step('Click "Save" button', async () => { await clickSave(page); });

    await test.step('Verify NO warning dialog appears (non-overlapping window)', async () => {
      await page.waitForTimeout(3000);
      await expect(warningDialog(page)).toHaveCount(0);
    });
    await test.step(`Verify pricing "${testName}" was persisted directly (queried via psql)`, async () => {
      await expect.poll(() => pricingExistsInDb(testName), { timeout: 10_000 }).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after');
  });

  test('warns when editing an existing pricing into an overlap', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_3_AC.Edge1],
    });
    const thisYear = new Date().getFullYear();
    const changes = {
      'Effective Start Date': `${thisYear}-06-01`,
      'Effective End Date':   `${thisYear}-08-31`,
    } as const;

    await test.step('Navigate to Subcontractor Pricings grid', async () => {});
    await test.step(`Open existing pricing "${FIXTURE.futureWindow}" for edit (double-click row's ID cell)`, async () => {
      await openPricingForEdit(page, FIXTURE.futureWindow);
    });
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step(`Change form fields → ${describeInputs(changes)} (shifts window into Baseline Annual's range)`, async () => {
      await modifyOpenPricingForm(page, {
        effectiveStart: `${thisYear}-06-01`, effectiveEnd: `${thisYear}-08-31`,
      });
    });
    await test.step('Click "Save" button', async () => { await clickSave(page); });

    const dialog = warningDialog(page);
    await test.step(`Verify warning dialog appears, listing "${FIXTURE.baselineAnnual}" as conflict`, async () => {
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText(FIXTURE.baselineAnnual);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: dialog });

    await test.step('Click "Cancel" in warning dialog (preserve fixture state)', async () => {
      // If we ever Continue here, the seed must be re-run to restore
      // Future Window's 2027 range.
      await dialog.locator('.x-button').filter({ hasText: /^Cancel$/ }).click();
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    });
  });

  test('ignores deactivated pricings when checking for overlap', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_3_AC.Edge2],
    });
    const twoYearsOut = new Date().getFullYear() + 2;
    const testName = `[QA] Deactivated Doesn't Conflict ${Date.now()}`;
    const inputs = {
      Name: testName, Product: PRODUCT_NAME, Vendor: VENDOR_NAME,
      'Pricing Type': 'Flat Rate', 'Base Price': 200,
      'Effective Start Date': `${twoYearsOut}-10-01`,
      'Effective End Date':   `${twoYearsOut}-10-31`,
      Active: true,
    } as const;

    await test.step('Navigate to Subcontractor Pricings grid', async () => {});
    await test.step('Open New Pricing form', async () => {
      await openNewPricingForm(page, {
        name: testName, product: PRODUCT_NAME, vendor: VENDOR_NAME,
        pricingType: 'Flat Rate', basePrice: 200,
        effectiveStart: `${twoYearsOut}-10-01`, effectiveEnd: `${twoYearsOut}-10-31`,
        active: true,
      });
    });
    await test.step(`Fill form fields → ${describeInputs(inputs)} (window only overlaps the DEACTIVATED baseline)`, async () => {});
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step('Click "Save" button', async () => { await clickSave(page); });

    await test.step('Verify NO warning dialog (Deactivated fixture is excluded from overlap check)', async () => {
      await page.waitForTimeout(3000);
      await expect(warningDialog(page)).toHaveCount(0);
    });
    await test.step(`Verify pricing "${testName}" was persisted (queried via psql)`, async () => {
      await expect.poll(() => pricingExistsInDb(testName), { timeout: 10_000 }).toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'after');
  });

  test('warns across different facilities (MVP: facility is not part of overlap scope)', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_3_AC.Scope3],
    });
    const testName = `[QA] Cross Facility ${Date.now()}`;
    const thisYear = new Date().getFullYear();
    const inputs = {
      Name: testName, Product: PRODUCT_NAME, Vendor: VENDOR_NAME,
      'Pricing Type': 'Flat Rate', 'Base Price': 200,
      'Effective Start Date': `${thisYear}-06-01`,
      'Effective End Date':   `${thisYear}-12-31`,
      Facility: 'Pitstop 0033 (id=2)',
      Active: true,
    } as const;

    await test.step('Navigate to Subcontractor Pricings grid', async () => {});
    await test.step('Open New Pricing form', async () => {
      await openNewPricingForm(page, {
        name: testName, product: PRODUCT_NAME, vendor: VENDOR_NAME,
        pricingType: 'Flat Rate', basePrice: 200,
        effectiveStart: `${thisYear}-06-01`, effectiveEnd: `${thisYear}-12-31`,
        facility: SEED_IDS.otherFacilityId,
        active: true,
      });
    });
    await test.step(`Fill form fields → ${describeInputs(inputs)} (different facility from Facility Scoped baseline)`, async () => {});
    await captureAcSnapshot(testInfo, page, 'before');

    await test.step('Click "Save" button', async () => { await clickSave(page); });

    const dialog = warningDialog(page);
    await test.step('Verify warning still fires (MVP: facility is not part of overlap scope)', async () => {
      await expect(dialog).toBeVisible({ timeout: 10_000 });
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: dialog });

    await test.step('Click "Cancel" in warning dialog', async () => {
      await dialog.locator('.x-button').filter({ hasText: /^Cancel$/ }).click();
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    });
  });
});
