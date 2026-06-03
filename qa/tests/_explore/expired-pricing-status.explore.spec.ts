import { test, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Exploration harness for TANGO-2 (expired pricing indicator) — not a real
 * test. Drives the pricings grid to discover the net-new UI the spec needs:
 *   - the "Pricing Effective Date Status" column (header text + dataIndex +
 *     how its computed value is rendered, since it's a client-side renderer)
 *   - the Expired tag DOM (class + rendered color — AC #2 says "red" but a
 *     comment shipped tan #D2B48C)
 *   - the status filter mechanism (ListBuilder filter panel per dev grooming)
 *
 * Pre-req: `npm run seed:expired-pricing-indicator` so the fixture rows exist.
 *
 * Run with:
 *   TANGO_INCLUDE_EXPLORE=1 npx playwright test \
 *     tests/_explore/expired-pricing-status.explore.spec.ts --project=admin
 *
 * Output lands in ./exploration/.
 */

const OUT = path.resolve(__dirname, '../../exploration');
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_PREFIX = 'Expired Indicator - ';
const FIXTURE_NAMES = [
  `${FIXTURE_PREFIX}Expired Last Year`,
  `${FIXTURE_PREFIX}Active Future`,
  `${FIXTURE_PREFIX}Inactive`,
  `${FIXTURE_PREFIX}No End Date`,
  `${FIXTURE_PREFIX}Ends Today`,
];

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    if (!Ext?.ComponentQuery) return false;
    try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; }
    catch { return false; }
  }, null, { timeout: 150_000, polling: 1000 });
  await page.waitForTimeout(3000);
}

async function gotoGridWithData(page: Page): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await page.evaluate(() => { (window as any).Ext.History.add('subcontractorproductpricings'); });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    return Ext?.ComponentQuery.query('accountingpricinggrid').length > 0;
  }, null, { timeout: 30_000 });
  // Force the virtual store to load and wait for data.
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    Ext.ComponentQuery.query('accountingpricinggrid')[0]?.getStore?.()?.load?.();
  });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const store = Ext.ComponentQuery.query('accountingpricinggrid')[0]?.getStore?.();
    return (store?.getTotalCount?.() ?? 0) > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(2000);
}

test.use({ storageState: 'auth/admin.json' });
test.setTimeout(180_000);

test('dump grid columns + per-fixture cell HTML', async ({ page }) => {
  await gotoGridWithData(page);

  const cols = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    const columns = (grid?.getColumns?.() || grid?.query?.('column') || []).map((c: any) => ({
      text: trim(c.getText?.() ?? c.text),
      dataIndex: c.getDataIndex?.() ?? c.dataIndex,
      hidden: !!c.isHidden?.(),
      width: c.getWidth?.(),
      xtype: c.xtype,
      cls: c.cls,
    }));
    return { gridXtype: grid?.xtype, columnCount: columns.length, columns };
  });
  fs.writeFileSync(path.join(OUT, 'tango2-01-columns.json'), JSON.stringify(cols, null, 2));
  console.log(`[columns] ${cols.columnCount} columns`);

  // For each fixture row, capture the rendered HTML of every cell + each
  // record's raw store fields. The status is computed by a renderer, so the
  // proof of "Active"/"Expired"/"Inactive" is in the rendered cell text/HTML,
  // not necessarily a store field.
  const rows: any = {};
  for (const name of [
    'Expired Indicator - Expired Last Year',
    'Expired Indicator - Active Future',
    'Expired Indicator - Inactive',
    'Expired Indicator - No End Date',
    'Expired Indicator - Ends Today',
  ]) {
    const rowLoc = page.locator('.x-gridrow').filter({ hasText: name }).first();
    let info: any = { found: false };
    try {
      await rowLoc.scrollIntoViewIfNeeded({ timeout: 5000 });
      await rowLoc.waitFor({ state: 'visible', timeout: 8000 });
      info = await rowLoc.evaluate((rowEl) => {
        const cells = Array.from(rowEl.querySelectorAll('.x-gridcell')).map((c: any) => ({
          text: (c.innerText || '').trim(),
          html: c.innerHTML.slice(0, 600),
          dataColumnId: c.getAttribute('data-columnid'),
        }));
        // Any tag-like span inside the row + its computed color.
        const tags = Array.from(rowEl.querySelectorAll('span,div')).filter((e: any) => {
          const t = (e.innerText || '').trim();
          return /^(Active|Expired|Inactive)$/i.test(t);
        }).map((e: any) => {
          const cs = getComputedStyle(e);
          return {
            text: (e.innerText || '').trim(),
            className: e.className,
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            outerHTML: e.outerHTML.slice(0, 400),
          };
        });
        return { found: true, cells, tags };
      });
    } catch (e) {
      info = { found: false, error: (e as Error).message };
    }
    rows[name] = info;
  }
  fs.writeFileSync(path.join(OUT, 'tango2-02-rows.json'), JSON.stringify(rows, null, 2));
  console.log('[rows] dumped fixture cell HTML');
  void FIXTURE_NAMES;
});

test('probe status filter mechanism (ListBuilder / filter panel)', async ({ page }) => {
  await gotoGridWithData(page);

  // Broad sweep of filter-related components so we can find how status
  // filtering is wired (dev grooming pointed at the ListBuilder filter panel).
  const probe = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    const container = grid?.up?.('panel') || grid?.up?.('container') || grid;

    const filterish = (container?.query?.(
      'listbuilder,filterpanel,filterfield,combobox,searchfield,gridfilters,' +
      'menucheckitem,checkboxfield,radiofield,segmentedbutton,tagfield',
    ) || []).filter((c: any) => c.isVisible?.()).map((c: any) => ({
      xtype: c.xtype, id: c.id, name: c.name, reference: c.reference,
      label: trim(c.getFieldLabel?.() ?? c.fieldLabel),
      emptyText: c.emptyText,
    }));

    // All buttons in/near the grid that might open a filter panel.
    const buttons = (container?.query?.('button') || [])
      .filter((b: any) => b.isVisible?.())
      .map((b: any) => ({
        text: trim(b.getText?.() ?? b.text), reference: b.reference,
        iconCls: b.iconCls, tooltip: b.tooltip,
      }))
      .filter((b: any) => b.text || b.iconCls);

    // Store fields — does a status field exist on the record, or is it purely
    // a column renderer (no store field)?
    const store = grid?.getStore?.();
    const sampleRec = store?.getAt?.(0);
    const fieldNames = sampleRec ? Object.keys(sampleRec.data || {}) : [];

    return { filterish, buttons, fieldNames };
  });
  fs.writeFileSync(path.join(OUT, 'tango2-03-filter.json'), JSON.stringify(probe, null, 2));
  console.log(`[filter] filterish=${probe.filterish.length} buttons=${probe.buttons.length}`);
});
