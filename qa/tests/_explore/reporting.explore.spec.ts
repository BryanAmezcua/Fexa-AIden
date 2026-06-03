import { test, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Exploration for the Fexa report builder (TANGO-10). No prior spec automates
 * it. Dumps the builder's references, the data-source/column store contents,
 * the results-grid format, and the filter dialog structure to exploration/.
 *
 * Run: TANGO_INCLUDE_EXPLORE=1 npx playwright test tests/_explore/reporting.explore.spec.ts --project=admin
 */

const OUT_DIR = path.resolve(process.cwd(), 'exploration');

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

async function gotoBuilder(page: Page): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);
  // The builder (createreport) is a lazy nav child; reach it the way the app
  // does — open the reports list, then click the "create report" button.
  await page.evaluate(() => (window as any).Ext.History.add('reports'));
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('reports').length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const btn = Ext.ComponentQuery.query('button[reference=createReportBtn]')[0];
    btn?.element?.dom?.click?.();
  });
  await page.waitForFunction(() => {
    return (window as any).Ext.ComponentQuery.query('createreport').length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(2500);
}

test.describe('Reporting builder exploration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('dump report builder structure + drive a Pricing and Invoice report', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'admin only');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const dump: any = {};

    await gotoBuilder(page);

    // 1. References available on the report view + key component presence.
    dump.refs = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const view = Ext.ComponentQuery.query('createreport')[0];
      const refs = view && view.getReferences ? Object.keys(view.getReferences()) : [];
      const present = (sel: string) => Ext.ComponentQuery.query(sel).length;
      return {
        viewXtype: view && view.xtype,
        referenceKeys: refs,
        runReportButton: present('button[reference=runReportButton]'),
        reportOutput: present('[reference=reportOutput]'),
        addFilterButton: present('button[reference=addFilterButton]'),
        dataSource: present('[reference=dataSource]'),
        linkedDataSources: present('[reference=linkedDataSources]'),
        dataColumns: present('[reference=dataColumns]'),
      };
    });

    // 2. dataSource store options.
    dump.dataSourceOptions = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const f = Ext.ComponentQuery.query('[reference=dataSource]')[0];
      return (f?.getStore()?.getRange() || []).map((r: any) => ({ text: r.data.text, value: r.data.value }));
    });

    // 3. Select Pricing source, dump its column options.
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      Ext.ComponentQuery.query('[reference=dataSource]')[0].setValue('Products::SubcontractorProductPricing');
    });
    await page.waitForTimeout(3500);
    dump.pricingColumns = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const f = Ext.ComponentQuery.query('[reference=dataColumns]')[0];
      return (f?.getStore()?.getRange() || []).map((r: any) => ({ text: r.data.text, value: r.data.value, type: r.data.type }));
    });

    // 4. Select pricing columns + run, dump results grid format.
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const f = Ext.ComponentQuery.query('[reference=dataColumns]')[0];
      f.setValue([
        'subcontractor_product_pricing.name',
        'subcontractor_product_pricing.prevent_price_modification',
        'subcontractor_product_pricing.effective_start_date',
        'subcontractor_product_pricing.effective_end_date',
      ]);
    });
    await page.waitForTimeout(1000);
    dump.dataColumnsAfterSet = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const f = Ext.ComponentQuery.query('[reference=dataColumns]')[0];
      return { getValue: f.getValue(), publishedSelected: (f.publishedState?.selected || []).map((s: any) => s.data?.value) };
    });
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const view = Ext.ComponentQuery.query('createreport')[0];
      view.getController().runReport(Ext.ComponentQuery.query('button[reference=runReportButton]')[0]);
    });
    await page.waitForTimeout(4000);
    dump.pricingResults = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const output = Ext.ComponentQuery.query('[reference=reportOutput]')[0];
      const grid = output?.down?.('grid');
      if (!grid) return { gridFound: false };
      const cols = grid.getColumns().map((c: any) => ({ text: c.getText?.(), dataIndex: c.getDataIndex?.() }));
      const rows = grid.getStore().getRange().slice(0, 40).map((r: any) => r.data);
      const mine = rows.filter((d: any) => JSON.stringify(d).includes('[QA] Enforcement Reporting'));
      return { gridFound: true, cols, rowCount: grid.getStore().getCount(), sampleRow: rows[0], myRows: mine };
    });

    // 5. Filter dialog structure (open + dump + cancel).
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const btn = Ext.ComponentQuery.query('button[reference=addFilterButton]')[0];
      btn?.element?.dom?.click?.();
    });
    await page.waitForTimeout(2000);
    dump.filterDialog = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      // Grab the topmost floated dialog/panel that appeared.
      const dialogs = Ext.ComponentQuery.query('dialog,formpanel,panel').filter((c: any) => c.isVisible?.() && c.getFloated?.());
      const fields = Ext.ComponentQuery.query('field').filter((f: any) => f.isVisible?.()).map((f: any) => ({
        xtype: f.xtype, reference: f.getReference?.(), label: f.getLabel?.(), name: f.getName?.(),
      }));
      const buttons = Ext.ComponentQuery.query('button').filter((b: any) => b.isVisible?.() && b.getText?.()).map((b: any) => ({ text: b.getText(), reference: b.getReference?.() }));
      return { floatedCount: dialogs.length, visibleFields: fields.slice(0, 40), visibleButtons: buttons.slice(0, 40) };
    });
    // Close any open dialog defensively.
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      Ext.ComponentQuery.query('button').filter((b: any) => /cancel/i.test(b.getText?.() || '') && b.isVisible?.())
        .forEach((b: any) => b.element?.dom?.click?.());
    });
    await page.waitForTimeout(1000);

    // 6. Invoice + linked Line Items: confirm linked-source selection + columns + results.
    await gotoBuilder(page);
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      Ext.ComponentQuery.query('[reference=dataSource]')[0].setValue('Invoices::SubcontractorInvoice');
    });
    await page.waitForTimeout(3000);
    dump.invoiceLinkableOptions = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const f = Ext.ComponentQuery.query('[reference=linkedDataSources]')[0];
      return (f?.getStore()?.getRange() || []).map((r: any) => ({ text: r.data.text, value: r.data.value }));
    });
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      Ext.ComponentQuery.query('[reference=linkedDataSources]')[0].setValue(['subcontractor_invoice_line_items']);
    });
    await page.waitForTimeout(3500);
    dump.invoiceLineItemColumns = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const f = Ext.ComponentQuery.query('[reference=dataColumns]')[0];
      return (f?.getStore()?.getRange() || []).map((r: any) => ({ text: r.data.text, value: r.data.value, type: r.data.type }))
        .filter((c: any) => /Approved Rate|Rate Deviation|Pricing Matched|Invoice ID|Line Item/i.test(c.text));
    });
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const f = Ext.ComponentQuery.query('[reference=dataColumns]')[0];
      f.setValue([
        'subcontractor_invoice_line_item.invoice_id',
        'subcontractor_invoice_line_item.approved_rate',
        'subcontractor_invoice_line_item.rate_deviation',
        'subcontractor_invoice_line_item.rate_deviation_amount',
        'subcontractor_invoice_line_item.pricing_matched',
      ]);
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const view = Ext.ComponentQuery.query('createreport')[0];
      view.getController().runReport(Ext.ComponentQuery.query('button[reference=runReportButton]')[0]);
    });
    await page.waitForTimeout(4000);
    dump.invoiceResults = await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const output = Ext.ComponentQuery.query('[reference=reportOutput]')[0];
      const grid = output?.down?.('grid');
      if (!grid) return { gridFound: false };
      const cols = grid.getColumns().map((c: any) => ({ text: c.getText?.(), dataIndex: c.getDataIndex?.() }));
      const rows = grid.getStore().getRange().map((r: any) => r.data);
      const mine = rows.filter((d: any) => String(JSON.stringify(d)).includes('"26"') || JSON.stringify(d).includes(':26'));
      return { gridFound: true, cols, rowCount: grid.getStore().getCount(), sampleRow: rows[0], invoice26Rows: mine.slice(0, 12) };
    });

    fs.writeFileSync(path.join(OUT_DIR, 'reporting-explore.json'), JSON.stringify(dump, null, 2));
    console.log('WROTE exploration/reporting-explore.json');
    console.log('refs:', JSON.stringify(dump.refs));
    console.log('pricingResults.cols:', JSON.stringify(dump.pricingResults?.cols));
    console.log('pricingResults.myRows:', JSON.stringify(dump.pricingResults?.myRows));
    console.log('invoiceResults.cols:', JSON.stringify(dump.invoiceResults?.cols));
    console.log('invoiceResults.invoice26Rows:', JSON.stringify(dump.invoiceResults?.invoice26Rows));
  });
});
