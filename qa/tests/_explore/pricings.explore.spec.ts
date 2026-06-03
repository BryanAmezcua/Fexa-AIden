import { test, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Exploration harness — not a real test. Drives the app to find the
 * navigation path to the pricings grid + the selectors needed for the
 * overlap-warning spec. Run with:
 *
 *   npx playwright test tests/_explore/ --project=admin --headed
 *
 * Each "step" snapshots the page state to ./exploration/.
 */

const OUT = path.resolve(__dirname, '../../exploration');
fs.mkdirSync(OUT, { recursive: true });

interface ComponentInfo {
  xtype: string;
  id: string;
  text?: string;
  iconCls?: string;
}

async function snapshot(page: Page, label: string): Promise<void> {
  const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const jsonPath = path.join(OUT, `${slug}.json`);

  // Dump the navigation tree (left rail) so we can find the path to any
  // screen by name — every menu/screen entry is a treelistitem with a
  // text label and a routeId / data attribute that maps to a hash route.
  const navTree = await page.evaluate(() => {
    const w = window as any;
    const Ext = w.Ext;
    if (!Ext) return { items: [] };
    const items = Ext.ComponentQuery.query('treelistitem')
      .map((n: any) => {
        const node = n.getNode?.();
        const data = node?.data ?? {};
        return {
          text: (data.text || n.getText?.() || '').replace(/<[^>]+>/g, '').trim(),
          routeId: data.routeId || data.route || data.viewType,
          iconCls: data.iconCls,
          expanded: !!data.expanded,
          depth: n.getDepth?.(),
          children: data.children?.length || 0,
        };
      })
      .filter((i: any) => i.text);
    return { items };
  });
  fs.writeFileSync(path.join(OUT, `${slug}-nav.json`), JSON.stringify(navTree, null, 2));

  const state = await page.evaluate((): {
    url: string;
    hash: string;
    extReady: boolean;
    extToken?: string;
    visibleText: string;
    buttonsWithText: ComponentInfo[];
    menuItems: ComponentInfo[];
    gridXtypes: { xtype: string; id: string }[];
    windows: ComponentInfo[];
    fields: { xtype: string; id: string; name?: string; label?: string }[];
  } => {
    const w = window as any;
    const Ext = w.Ext;
    const visibleText = (document.body?.innerText || '').slice(0, 4000);
    if (!Ext || !Ext.ComponentQuery) {
      return { url: location.href, hash: location.hash, extReady: false, visibleText,
               buttonsWithText: [], menuItems: [], gridXtypes: [], windows: [], fields: [] };
    }
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    const buttons = Ext.ComponentQuery.query('button')
      .filter((b: any) => b.isVisible?.() && trim(b.getText?.() ?? b.text))
      .map((b: any) => ({ xtype: b.xtype, id: b.id, text: trim(b.getText?.() ?? b.text), iconCls: b.iconCls }))
      .slice(0, 100);
    const menuItems = Ext.ComponentQuery.query('menuitem')
      .filter((m: any) => m.isVisible?.())
      .map((m: any) => ({ xtype: m.xtype, id: m.id, text: trim(m.text), iconCls: m.iconCls }))
      .slice(0, 100);
    const grids = Ext.ComponentQuery.query('grid,gridpanel')
      .filter((g: any) => g.isVisible?.())
      .map((g: any) => ({ xtype: g.xtype, id: g.id }));
    const windows = Ext.ComponentQuery.query('window,dialog')
      .filter((w: any) => w.isVisible?.())
      .map((w: any) => ({ xtype: w.xtype, id: w.id, text: trim(w.title) }));
    const fields = Ext.ComponentQuery.query('field')
      .filter((f: any) => f.isVisible?.())
      .map((f: any) => ({ xtype: f.xtype, id: f.id, name: f.name, label: trim(f.fieldLabel) }))
      .slice(0, 60);
    return {
      url: location.href, hash: location.hash,
      extReady: !!Ext.isReady,
      extToken: (() => { try { return Ext.History?.getToken?.(); } catch { return undefined; } })(),
      visibleText, buttonsWithText: buttons, menuItems, gridXtypes: grids, windows, fields,
    };
  });

  fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2));
  console.log(`[snapshot] ${label}: url=${state.url} hash=${state.hash} extReady=${state.extReady} buttons=${state.buttonsWithText.length}`);
}

async function waitForApp(page: Page): Promise<void> {
  // Poll until the main Fexa app chrome renders (multiple top-level
  // containers/panels — not just the FEXA Support chat widget that
  // loads first and is the only thing present when Ext first signals ready).
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const w = window as any;
    const Ext = w.Ext;
    if (!Ext || !Ext.ComponentQuery) return false;
    try {
      // The main app shell has many components — wait for a non-trivial count.
      return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8;
    } catch { return false; }
  }, null, { timeout: 150_000, polling: 1000 });
  // Settle for any final layout / data fetches.
  await page.waitForTimeout(3000);
}

test.use({ storageState: 'auth/admin.json' });
test.setTimeout(180_000);

test('step 1: land on home and capture initial chrome', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' });
  await waitForApp(page);
  await snapshot(page, '01-home');
});

test('step 2c: dump nav store records for pricing entries', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' });
  await waitForApp(page);
  const records = await page.evaluate(() => {
    const w = window as any;
    const nav = w.Ext.ComponentQuery.query('navigationTree')[0];
    const store = nav?.getStore?.();
    if (!store) return { error: 'no store' };
    const out: any[] = [];
    store.each((rec: any) => {
      const data = rec.data || {};
      const text = (data.text || '').replace(/<[^>]+>/g, '').trim();
      if (/pric|admin|account/i.test(text)) {
        out.push({ text, allFields: data });
      }
    }, null, { recursive: true });
    return { recordCount: store.getCount(), matches: out };
  });
  fs.writeFileSync(path.join(OUT, '02c-nav-records.json'), JSON.stringify(records, null, 2));
  console.log(`[records] ${records.matches?.length || 0} relevant records`);
});

test('step 2b: probe nav tree visibility and find expand toggle', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' });
  await waitForApp(page);
  const probe = await page.evaluate(() => {
    const w = window as any;
    const Ext = w.Ext;
    const nav = Ext.ComponentQuery.query('navigationTree')[0];
    const navInfo = nav ? {
      id: nav.id, hidden: !!nav.hidden, visible: !!nav.isVisible?.(),
      micro: !!nav.getMicro?.(),
      width: nav.element?.getWidth?.(),
      classList: Array.from(nav.element?.dom?.classList || []),
    } : null;
    // Look for any toggle button — typically a hamburger or chevron icon.
    const toggles = Ext.ComponentQuery.query('button[iconCls*=fa-bars],button[iconCls*=menu],button[iconCls*=chevron]')
      .filter((b: any) => b.isVisible?.())
      .map((b: any) => ({ id: b.id, iconCls: b.iconCls, text: b.getText?.(), xtype: b.xtype }));
    // Sample 5 treelistitem elements with computed visibility.
    const sample = Ext.ComponentQuery.query('treelistitem').slice(0, 5).map((n: any) => {
      const text = (n.getNode?.()?.data?.text || '').replace(/<[^>]+>/g, '').trim();
      const el = n.element?.dom;
      return {
        text,
        offsetWidth: el?.offsetWidth, offsetHeight: el?.offsetHeight,
        display: el ? getComputedStyle(el).display : null,
        visibility: el ? getComputedStyle(el).visibility : null,
      };
    });
    return { navInfo, toggles, sample };
  });
  fs.writeFileSync(path.join(OUT, '02b-nav-probe.json'), JSON.stringify(probe, null, 2));
  console.log('[probe]', JSON.stringify(probe, null, 2));
});

test('step 2a: inspect treelistitem DOM structure', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' });
  await waitForApp(page);
  const sample = await page.evaluate(() => {
    const w = window as any;
    const items = w.Ext.ComponentQuery.query('treelistitem');
    const first = items.find((i: any) => {
      const t = (i.getNode?.()?.data?.text || '').replace(/<[^>]+>/g, '').trim();
      return t === 'Administration';
    });
    if (!first) return { found: false };
    const el = first.element?.dom || first.el?.dom;
    return {
      found: true,
      outerHTML: el?.outerHTML?.slice(0, 1500),
      tagName: el?.tagName,
      className: el?.className,
      id: el?.id,
    };
  });
  fs.writeFileSync(path.join(OUT, '02a-treelistitem-dom.json'), JSON.stringify(sample, null, 2));
  console.log('[sample]', JSON.stringify(sample, null, 2).slice(0, 800));
});

test('step 2: navigate to subcontractor pricings via correct hash', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  // App auto-routes to #dashboard on load; wait for that to settle, then
  // change the hash to the pricings ctype.
  await page.evaluate(() => {
    (window as any).Ext.History.add('subcontractorproductpricings');
  });
  // Wait for the pricings grid to actually mount.
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    if (!Ext) return false;
    return Ext.ComponentQuery.query('grid,gridpanel').length > 0;
  }, null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await snapshot(page, '02-subcontractor-pricings');
});

test('step 7: open existing pricing for edit (double-click)', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await page.evaluate(() => { (window as any).Ext.History.add('subcontractorproductpricings'); });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    return Ext?.ComponentQuery.query('accountingpricinggrid').length > 0;
  }, null, { timeout: 30_000 });
  // Trigger the grid's virtual store to load (it only loads on interaction
  // by default) and wait for it to have data.
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    grid?.getStore?.()?.load?.();
  });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    const store = grid?.getStore?.();
    return (store?.getTotalCount?.() ?? 0) > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);

  // Find the Future Window row by visible text (its cell content) and dblclick.
  // Per components/SideEditMenu/GridPlugin.js: childdoubletap → showMenu(record).
  const row = page.locator('.x-gridrow').filter({ hasText: 'Overlap Scenario - Future Window' }).first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.dblclick();
  await page.waitForTimeout(2500);

  // Capture what opened.
  const after = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    const menus = Ext.ComponentQuery.query('sideeditmenu')
      .filter((m: any) => m.isVisible?.())
      .map((m: any) => {
        // Read what's pre-filled in the form (i.e. the existing record's values).
        const get = (n: string) => {
          const f = m.query(`[name=${n}]`)[0];
          const v = f?.getValue?.();
          return v instanceof Date ? v.toISOString() : v;
        };
        return {
          xtype: m.xtype, id: m.id,
          fields: {
            name: get('name'),
            product_id: get('product_id'),
            role_id: get('role_id'),
            effective_start_date: get('effective_start_date'),
            effective_end_date: get('effective_end_date'),
            active: get('active'),
          },
        };
      });
    return { menus };
  });
  fs.writeFileSync(path.join(OUT, '07-edit-side-menu.json'), JSON.stringify(after, null, 2));
  console.log('[after dblclick]', JSON.stringify(after));
});

test('step 6: fill form to overlap with baseline and click Save', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await page.evaluate(() => { (window as any).Ext.History.add('subcontractorproductpricings'); });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    return Ext?.ComponentQuery.query('accountingpricinggrid').length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Open the create menu.
  const rect = await page.evaluate(() => {
    const btn = (window as any).Ext.ComponentQuery.query('button[reference=createItemBtn]')[0];
    const el = btn?.element?.dom;
    const r = el?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (rect) {
    await page.mouse.click(rect.x, rect.y);
    await page.waitForFunction(() => {
      return (window as any).Ext.ComponentQuery.query('sideeditmenu').some((m: any) => m.isVisible?.());
    }, null, { timeout: 10_000 });
    await page.waitForTimeout(1500);
  }

  // Fill fields to overlap with the "Overlap Scenario - Baseline Annual"
  // fixture: Product id=23 (Regular Rate), Role id=183, dates inside 2026.
  const fillResult = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const menu = Ext.ComponentQuery.query('sideeditmenu')[0];
    if (!menu) return { error: 'no menu' };
    const set = (name: string, value: any): boolean => {
      const f = menu.query(`[name=${name}]`)[0];
      if (!f) return false;
      try { f.setValue(value); return true; } catch (e) { return false; }
    };
    const set_results = {
      name:                      set('name', '[QA Probe] Overlap Save Test'),
      active:                    set('active', true),
      product_id:                set('product_id', 23),
      product_classification_id: set('product_classification_id', 1),
      role_id:                   set('role_id', 183),
      pricing_type:              set('pricing_type', 'Flat Rate'),
      base_price:                set('base_price', 200),
      effective_start_date:      set('effective_start_date', new Date('2026-06-01')),
      effective_end_date:        set('effective_end_date', new Date('2026-12-31')),
    };
    return { set_results };
  });
  console.log('[fill]', JSON.stringify(fillResult));
  await page.waitForTimeout(1500);

  // Click Save via real DOM click on button[reference=saveButton].
  const saveRect = await page.evaluate(() => {
    const btn = (window as any).Ext.ComponentQuery.query('button[reference=saveButton]')[0];
    const el = btn?.element?.dom;
    const r = el?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (saveRect) {
    await page.mouse.click(saveRect.x, saveRect.y);
    await page.waitForTimeout(3000);  // let the server respond, dialog render
  }

  // Capture whatever appeared.
  const after = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    const windows = Ext.ComponentQuery.query('window,dialog,messagebox')
      .filter((w: any) => w.isVisible?.())
      .map((w: any) => ({
        xtype: w.xtype,
        id: w.id,
        title: trim(w.getTitle?.() ?? w.title),
        text: trim((w.el?.dom?.innerText || '').slice(0, 500)),
        buttons: w.query?.('button').filter((b: any) => b.isVisible?.()).map((b: any) => ({
          text: trim(b.getText?.() ?? b.text),
          itemId: b.itemId, reference: b.reference,
        })),
      }));
    return { windows };
  });
  fs.writeFileSync(path.join(OUT, '06-after-save.json'), JSON.stringify(after, null, 2));
  console.log(`[after-save] ${after.windows?.length || 0} visible dialog(s)`);
});

test('step 5: dump sideeditmenu field structure', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await page.evaluate(() => { (window as any).Ext.History.add('subcontractorproductpricings'); });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    return Ext?.ComponentQuery.query('accountingpricinggrid').length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Click + to open the side edit menu (same path as step 4).
  const rect = await page.evaluate(() => {
    const btn = (window as any).Ext.ComponentQuery.query('button[reference=createItemBtn]')[0];
    const el = btn?.element?.dom;
    const r = el?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (rect) {
    await page.mouse.click(rect.x, rect.y);
    await page.waitForFunction(() => {
      return (window as any).Ext.ComponentQuery.query('sideeditmenu').some((m: any) => m.isVisible?.());
    }, null, { timeout: 10_000 });
    await page.waitForTimeout(2000);
  }

  // Now dump everything inside the sideeditmenu.
  const menu = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const m = Ext.ComponentQuery.query('sideeditmenu')[0];
    if (!m) return { error: 'no sideeditmenu' };
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    // Every form-y field inside the menu — combos, dates, numbers, toggles, etc.
    const fields = m.query('field,combobox,combo,datepickerfield,datefield,numberfield,togglefield,searchfield,textfield')
      .filter((f: any) => f.isVisible?.())
      .map((f: any) => ({
        xtype: f.xtype,
        id: f.id,
        name: f.name,
        label: trim(f.getFieldLabel?.() ?? f.fieldLabel),
        reference: f.reference,
        placeholder: f.placeholder,
        value: f.getValue?.(),
        required: !!f.required,
      }));
    const buttons = m.query('button')
      .filter((b: any) => b.isVisible?.())
      .map((b: any) => ({
        xtype: b.xtype, id: b.id,
        text: trim(b.getText?.() ?? b.text),
        reference: b.reference, iconCls: b.iconCls,
      }));
    return { menuXtype: m.xtype, fields, buttons };
  });
  fs.writeFileSync(path.join(OUT, '05-sideeditmenu-fields.json'), JSON.stringify(menu, null, 2));
  console.log(`[menu] fields=${menu.fields?.length || 0} buttons=${menu.buttons?.length || 0}`);
});

test('step 4: open new pricing form (side edit menu)', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await page.evaluate(() => { (window as any).Ext.History.add('subcontractorproductpricings'); });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    return Ext?.ComponentQuery.query('accountingpricinggrid').length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Click the createItemBtn (defined in components/SideEditMenu/GridPlugin.js).
  const clicked = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const btn = Ext.ComponentQuery.query('button[reference=createItemBtn]')[0];
    if (!btn) return { ok: false, reason: 'not found' };
    const el = btn.element?.dom;
    if (!el) return { ok: false, reason: 'no DOM element' };
    // Tap simulation — the listener is `tap`. fireEvent on Ext won't reach
    // the listener bound through Ext's event system, so dispatch a real
    // pointer event sequence on the DOM.
    const rect = el.getBoundingClientRect();
    return { ok: true, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  });
  console.log('[createItemBtn]', JSON.stringify(clicked));

  if (clicked.ok && clicked.rect) {
    await page.mouse.click(clicked.rect.x + clicked.rect.w / 2, clicked.rect.y + clicked.rect.h / 2);
    await page.waitForTimeout(2500);
  }
  await snapshot(page, '04-new-pricing-form');

  // Also dump any windows / dialogs / side menus that opened.
  const menu = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const sidemenus = Ext.ComponentQuery.query('sideeditmenu,sidemenu')
      .map((m: any) => ({ xtype: m.xtype, id: m.id, visible: m.isVisible?.() }));
    const allVisible = Ext.ComponentQuery.query('container,panel').filter((c: any) => c.isVisible?.()).length;
    return { sidemenus, allVisible };
  });
  fs.writeFileSync(path.join(OUT, '04-after-create-click.json'), JSON.stringify(menu, null, 2));
});

test('step 3: discover grid toolbar / new-pricing button', async ({ page }) => {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);
  await page.evaluate(() => { (window as any).Ext.History.add('subcontractorproductpricings'); });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    return Ext?.ComponentQuery.query('grid,gridpanel').length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(3000);

  // Dump the grid's toolbar buttons + all action-y buttons in the visible area.
  const probe = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    const trim = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : '');
    // All buttons inside or near the grid (its container + tab panel).
    const container = grid?.up?.('container') || grid;
    const allButtons = container.query('button,actionbutton')
      .map((b: any) => ({
        xtype: b.xtype, id: b.id, itemId: b.itemId,
        text: trim(b.getText?.() ?? b.text),
        iconCls: b.iconCls, tooltip: b.tooltip,
        action: b.action, handler: typeof b.handler,
      }));
    // Tools (gear/plus icons that aren't full buttons).
    const tools = container.query('tool')
      .map((t: any) => ({ id: t.id, type: t.type, tooltip: t.tooltip }));
    return { gridXtype: grid?.xtype, allButtons, tools };
  });
  fs.writeFileSync(path.join(OUT, '03-grid-toolbar.json'), JSON.stringify(probe, null, 2));
  console.log(`[probe] grid=${probe.gridXtype} buttons=${probe.allButtons.length} tools=${probe.tools.length}`);
});

test.skip('step 2x: drive nav tree to subcontractor pricings', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' });
  await waitForApp(page);

  // Expand the nav tree out of micro mode so text labels become clickable.
  await page.evaluate(() => {
    const w = window as any;
    const nav = w.Ext.ComponentQuery.query('navigationTree')[0];
    nav?.setMicro?.(false);
  });
  await page.waitForTimeout(1500);

  const trail: { label: string; hashAfter: string }[] = [];
  for (const label of ['Administration', 'Accounting', 'Pricings', 'Subcontractor Pricing']) {
    const target = page.locator('.x-treelist-item-text').filter({ hasText: new RegExp(`^${label}$`) }).first();
    try {
      await target.click({ timeout: 8000 });
      await page.waitForTimeout(1500);
      trail.push({ label, hashAfter: await page.evaluate(() => location.hash) });
    } catch (err) {
      trail.push({ label, hashAfter: `<failed: ${(err as Error).message.split('\n')[0].slice(0, 100)}>` });
      break;
    }
  }
  console.log('[trail]', JSON.stringify(trail, null, 2));
  await page.waitForTimeout(5000);
  await snapshot(page, '02-subcontractor-pricings');
});
