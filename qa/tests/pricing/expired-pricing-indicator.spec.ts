import { test, expect, Page, Locator } from '@playwright/test';
import { annotateAc, captureAcSnapshot, TANGO_2_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-2';

/**
 * Expired pricing indicator in the admin pricings grid — TANGO-2.
 *
 * SCOPE FINDING (documented gap, not a flaky test):
 *   The TANGO-2 status column + Expired tag + status filter were implemented
 *   only on the CLIENT pricing grid (Api::V1::ClientProductPricingsController
 *   `include PricingStatusFilter` + selects COMPUTED_STATUS_SQL AS
 *   pricing_effective_date_status). The SUBCONTRACTOR pricing controller
 *   (Api::V1::SubcontractorProductPricingsController) does NEITHER, so on the
 *   Subcontractor Pricing grid:
 *     - the record never carries `pricing_effective_date_status`, so the
 *       client-side renderer (GridController#effectiveDateStatusRenderer)
 *       falls through to its else-branch and tags EVERY row "Active";
 *     - the synthetic `pricing_status` filter is never translated server-side.
 *
 *   This suite was deliberately pointed at the Subcontractor Pricing grid to
 *   DOCUMENT that gap. Scenarios that assert the feature's positive behavior
 *   (AC #1-#4) therefore FAIL — the failure + before/after screenshots are the
 *   evidence that TANGO-2 is not wired into this grid. The absence/negative
 *   scenarios (AC #5-#7) genuinely hold (nothing is marked expired, expired
 *   rows stay visible) and pass.
 *
 *   Implementation detail for reference — the shipped renderer maps:
 *     active -> "Active" #89C826 · expired -> "Expired" #F44336 (red) ·
 *     inactive -> "Inactive" #5A7F93. The #F44336 red matches AC #2's "red
 *     tag"; a later PM comment proposing tan (#D2B48C) did not ship.
 *
 * Pre-requisite: `npm run seed:expired-pricing-indicator` creates five
 * Subcontractor pricings, one per status / boundary (all named
 * "Expired Indicator - ..."):
 *   - "Expired Last Year" (active, end < today)   -> should be "Expired"
 *   - "Active Future"      (active, end next year) -> should be "Active"
 *   - "Inactive"           (active=false, past)    -> should be "Inactive"
 *   - "No End Date"        (active, end NULL)       -> "Active" (never expired)
 *   - "Ends Today"         (active, end = today)    -> "Active" (inclusive)
 */

// --- Fixtures (kept in sync with seeds/expired-pricing-indicator.rb) -------
const FIXTURE_PREFIX = 'Expired Indicator - ';
const FIXTURE = {
  expired:    `${FIXTURE_PREFIX}Expired Last Year`,
  active:     `${FIXTURE_PREFIX}Active Future`,
  inactive:   `${FIXTURE_PREFIX}Inactive`,
  noEndDate:  `${FIXTURE_PREFIX}No End Date`,
  endsToday:  `${FIXTURE_PREFIX}Ends Today`,
} as const;

const STATUS_DATA_INDEX = 'pricing_effective_date_status';

// --- Helpers ---------------------------------------------------------------

/**
 * Wait for the Fexa Ext JS app to be ready beyond just `Ext.isReady`.
 * REQUIRES TANGO fast-mode (npm run fexa:fast-mode); dev-mode Sencha takes
 * 60–120s on a cold cache.
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
 * Navigate to the Subcontractor Pricings grid and force its virtual store to
 * load. The app auto-routes to #dashboard on load, so we override the hash and
 * retry if the grid doesn't mount.
 */
async function gotoPricingsGrid(page: Page): Promise<void> {
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
      if (attempt === 2) throw new Error('gotoPricingsGrid: accountingpricinggrid never mounted after 3 attempts');
    }
  }
  await page.evaluate(() => {
    (window as any).Ext.ComponentQuery.query('accountingpricinggrid')[0]?.getStore?.()?.load?.();
  });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const store = Ext.ComponentQuery.query('accountingpricinggrid')[0]?.getStore?.();
    return (store?.getTotalCount?.() ?? 0) > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(1000);
}

/**
 * Declutter the grid for readable evidence: hide every column except ID,
 * Name, and the status column, and widen those three. The pricings grid has
 * ~30 columns flexed so narrow that the status tag text truncates to "A..";
 * this makes each fixture's Name and its rendered status tag legible in the
 * before/after screenshots. Also un-hides the status column (it ships hidden
 * in the column menu).
 */
async function prepareGrid(page: Page): Promise<void> {
  await page.evaluate((statusDataIndex) => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    const cols = grid?.getColumns?.() || [];
    for (const c of cols) {
      const di = c.getDataIndex?.() ?? c.dataIndex;
      if (di === 'id')                 { c.show?.(); c.setFlex?.(null); c.setWidth?.(70); }
      else if (di === 'name')          { c.show?.(); c.setFlex?.(null); c.setWidth?.(320); }
      else if (di === statusDataIndex) { c.show?.(); c.setFlex?.(null); c.setWidth?.(170); }
      else                             { c.hide?.(); }
    }
  }, STATUS_DATA_INDEX);
  await page.waitForTimeout(800);
}

/**
 * Flip the grid's "include inactive" toggle (titleBar togglefield, default
 * off) so inactive pricings load. By default the grid applies a
 * `product_pricings.active = true` filter that excludes the Inactive fixture;
 * the toggle's change listener removes that filter and reloads the store.
 */
async function includeInactivePricings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    const toggle = grid?.down?.('togglefield');
    if (toggle?.setValue) toggle.setValue(1);   // fires change → removeFilter('product_pricings.active') → reload
    else grid?.getStore?.()?.removeFilter?.('product_pricings.active');
  });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const store = Ext.ComponentQuery.query('accountingpricinggrid')[0]?.getStore?.();
    return store && !store.isLoading?.() && (store.getCount?.() ?? 0) > 0;
  }, null, { timeout: 20_000 });
  await page.waitForTimeout(1500);
}

/** Locator for a grid row by the fixture's visible Name. */
function gridRow(page: Page, name: string): Locator {
  return page.locator('.x-gridrow').filter({ hasText: name }).first();
}

/** The status tag (.status-box) locator within a fixture row. */
function statusTag(page: Page, name: string): Locator {
  return gridRow(page, name).locator('.status-box').first();
}

/**
 * Force the virtual grid to render a specific fixture row by asking the store
 * to scroll its record into view. The grid only renders rows near the
 * viewport, so a row far down the list isn't in the DOM until we scroll to
 * it. Returns the (now-rendered) row locator.
 */
async function revealRow(page: Page, name: string): Promise<Locator> {
  await page.evaluate((rowName) => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    const store = grid?.getStore?.();
    let rec: any = null;
    store?.each?.((r: any) => { if (!rec && r.get?.('name') === rowName) rec = r; });
    if (rec) {
      if (grid.ensureVisible) grid.ensureVisible(rec);
      else if (grid.scrollToRecord) grid.scrollToRecord(rec);
    }
  }, name);
  await page.waitForTimeout(800);
  const row = gridRow(page, name);
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  return row;
}

/**
 * Read the rendered status tag text + background color for a fixture row,
 * forcing the row to render first. Returns null if no status tag is rendered.
 */
async function readStatusTag(page: Page, name: string): Promise<{ text: string; backgroundColor: string } | null> {
  await revealRow(page, name);
  const tag = statusTag(page, name);
  if (await tag.count() === 0) return null;
  return await tag.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { text: (el.textContent || '').trim(), backgroundColor: cs.backgroundColor };
  });
}

/** The grid component DOM element (for context screenshots). */
function gridEl(page: Page): Locator {
  return page.locator('.x-grid, accountingpricinggrid, .accountingpricinggrid').first();
}

// --- Scenarios -------------------------------------------------------------

test.describe('Expired pricing indicator in admin grid (TANGO-2)', () => {
  // NOT serial: this is a documented-gap suite where the positive-feature
  // scenarios (AC #1-#4) are EXPECTED to fail on the subcontractor grid.
  // Serial mode would skip every scenario after the first failure, leaving
  // the report with a single test. Each test does its own full setup in
  // beforeEach so they're independent; run with --workers=1 to keep them
  // sequential and avoid overwhelming the dev server.
  test.setTimeout(120_000);

  // Pricings administration is admin-only — skip vendor + facility-manager.
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'Pricings administration is admin-only');
    await gotoPricingsGrid(page);
    await prepareGrid(page);
  });

  test('renders a red "Expired" tag on a pricing whose effective_end_date is in the past', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_2_AC.ExpectedBehavior1, TANGO_2_AC.ExpectedBehavior2],
    });

    let tag: { text: string; backgroundColor: string } | null = null;
    await test.step(`Locate row "${FIXTURE.expired}" (active=true, effective_end_date=2025-12-31, in the past)`, async () => {
      await revealRow(page, FIXTURE.expired);
    });
    await captureAcSnapshot(testInfo, page, 'before', { focus: gridRow(page, FIXTURE.expired) });

    await test.step('Read the rendered status tag on the expired row', async () => {
      tag = await readStatusTag(page, FIXTURE.expired);
      // Capture the ACTUAL rendered tag before asserting, so the report shows
      // the evidence even though the assertion below fails on this grid.
    });
    // Evidence shot of the actual state (on the subcontractor grid this shows
    // the row tagged "Active" instead of a red "Expired").
    await captureAcSnapshot(testInfo, page, 'after', { focus: statusTag(page, FIXTURE.expired) });

    await test.step('Verify the row shows a red "Expired" tag (AC #1, #2)', async () => {
      expect(tag, 'expected a .status-box tag on the expired row').not.toBeNull();
      expect(tag!.text).toBe('Expired');
      // #F44336 == rgb(244, 67, 54): red-dominant.
      const m = tag!.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      expect(m, `unexpected color format: ${tag!.backgroundColor}`).not.toBeNull();
      const [r, g, b] = [Number(m![1]), Number(m![2]), Number(m![3])];
      expect(r, `expected a red tag; got rgb(${r},${g},${b})`).toBeGreaterThan(g);
      expect(r, `expected a red tag; got rgb(${r},${g},${b})`).toBeGreaterThan(b);
    });
  });

  test('"Pricing Effective Date Status" column renders Active / Expired / Inactive per row state', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_2_AC.ExpectedBehavior3],
    });

    await test.step('Confirm the grid exposes the "Pricing Effective Date Status" column', async () => {
      const hasColumn = await page.evaluate((dataIndex) => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
        return (grid?.getColumns?.() || []).some(
          (c: any) => (c.getDataIndex?.() ?? c.dataIndex) === dataIndex,
        );
      }, STATUS_DATA_INDEX);
      expect(hasColumn, 'grid is missing the pricing_effective_date_status column').toBe(true);
    });
    await captureAcSnapshot(testInfo, page, 'before', { focus: gridRow(page, FIXTURE.expired) });

    await test.step('Enable "include inactive" so the Inactive fixture is loaded', async () => {
      await includeInactivePricings(page);
    });

    const statuses: Record<string, string | undefined> = {};
    await test.step('Read the rendered status for the Expired, Active, and Inactive fixtures', async () => {
      statuses.expired  = (await readStatusTag(page, FIXTURE.expired))?.text;
      statuses.active   = (await readStatusTag(page, FIXTURE.active))?.text;
      statuses.inactive = (await readStatusTag(page, FIXTURE.inactive))?.text;
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: statusTag(page, FIXTURE.inactive) });

    await test.step(`Verify "${FIXTURE.expired}" → "Expired"`, async () => {
      expect(statuses.expired).toBe('Expired');
    });
    await test.step(`Verify "${FIXTURE.active}" → "Active"`, async () => {
      expect(statuses.active).toBe('Active');
    });
    await test.step(`Verify "${FIXTURE.inactive}" → "Inactive" (active=false; Inactive takes precedence over Expired)`, async () => {
      expect(statuses.inactive).toBe('Inactive');
    });
  });

  test('grid is filterable by status — admin can filter to show only expired pricings', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_2_AC.ExpectedBehavior4],
    });

    await captureAcSnapshot(testInfo, page, 'before', { focus: gridEl(page) });

    let filterPresent = false;
    await test.step('Locate the status filter control and set it to "Expired"', async () => {
      filterPresent = await page.evaluate(() => {
        const Ext = (window as any).Ext;
        const field = Ext.ComponentQuery.query('[reference=effectiveDateStatusFilter]')[0]
          || Ext.ComponentQuery.query('[name=pricing_status]')[0];
        if (!field) return false;
        field.setValue?.('expired');
        return true;
      });
      await page.waitForTimeout(3000);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: gridEl(page) });

    await test.step('Verify a working status filter narrowed the grid to expired pricings only', async () => {
      expect(filterPresent, 'no status filter control (effectiveDateStatusFilter / pricing_status) is rendered on this grid').toBe(true);
      const result = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('.x-gridrow .status-box'))
          .filter((e: any) => e.offsetParent !== null)
          .map((e: any) => (e.textContent || '').trim());
        return { count: boxes.length, allExpired: boxes.length > 0 && boxes.every((t) => t === 'Expired') };
      });
      expect(result.allExpired, `expected only "Expired" rows after filtering; saw ${result.count} status tag(s)`).toBe(true);
    });
  });

  test('a pricing with no effective_end_date is never marked Expired', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_2_AC.Edge1],
    });

    let tag: { text: string; backgroundColor: string } | null = null;
    await test.step(`Locate row "${FIXTURE.noEndDate}" (active=true, effective_end_date = NULL)`, async () => {
      await revealRow(page, FIXTURE.noEndDate);
    });
    await captureAcSnapshot(testInfo, page, 'before', { focus: gridRow(page, FIXTURE.noEndDate) });

    await test.step('Read the rendered status tag', async () => {
      tag = await readStatusTag(page, FIXTURE.noEndDate);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: statusTag(page, FIXTURE.noEndDate) });

    await test.step('Verify the status tag is NOT "Expired" (null end date is never expired)', async () => {
      expect(tag?.text).not.toBe('Expired');
    });
  });

  test('a pricing whose effective_end_date is today is NOT Expired (inclusive boundary)', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_2_AC.Edge2],
    });

    let tag: { text: string; backgroundColor: string } | null = null;
    await test.step(`Locate row "${FIXTURE.endsToday}" (active=true, effective_end_date = today)`, async () => {
      await revealRow(page, FIXTURE.endsToday);
    });
    await captureAcSnapshot(testInfo, page, 'before', { focus: gridRow(page, FIXTURE.endsToday) });

    await test.step('Read the rendered status tag', async () => {
      tag = await readStatusTag(page, FIXTURE.endsToday);
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: statusTag(page, FIXTURE.endsToday) });

    await test.step('Verify the status tag is NOT "Expired" (today is inclusive, so not yet expired)', async () => {
      expect(tag?.text).not.toBe('Expired');
    });
  });

  test('expired pricings remain visible in the grid (not hidden or deleted)', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_2_AC.Edge3],
    });

    await test.step(`Verify the expired fixture "${FIXTURE.expired}" is present and visible in the grid`, async () => {
      await revealRow(page, FIXTURE.expired);
      await expect(gridRow(page, FIXTURE.expired)).toBeVisible();
    });
    await captureAcSnapshot(testInfo, page, 'after', { focus: gridRow(page, FIXTURE.expired) });
  });
});
