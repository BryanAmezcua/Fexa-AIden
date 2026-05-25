// qa-bot/lib/navigation.mjs — Sidebar navigation helpers for ExtJS treelist

import { waitForLoad } from './extjs.mjs';

// Navigate the sidebar tree by clicking through a path of menu labels
// e.g., navigateTo(page, ['Administration', 'Pricings', 'Client Pricing'])
export async function navigateTo(page, menuPath) {
  console.log(`  Navigating to: ${menuPath.join(' > ')}...`);

  for (let i = 0; i < menuPath.length; i++) {
    const label = menuPath[i];
    const isLast = i === menuPath.length - 1;

    // ExtJS treelist items may be in micro (collapsed) mode.
    // Try clicking by text within treelist item containers.
    const clicked = await page.evaluate((text) => {
      // Find all treelist item text elements
      const items = document.querySelectorAll('.x-treelist-item-text, .x-treelist-item-wrap');
      for (const item of items) {
        if (item.textContent.trim() === text) {
          item.click();
          return true;
        }
      }

      // Fallback: try Ext.ComponentQuery on the navigation tree
      const tree = Ext.ComponentQuery.query('treelist')[0];
      if (!tree) return false;

      const store = tree.getStore();
      const node = store.findNode('text', text) || store.findNode('name', text);
      if (node) {
        tree.setSelection(node);
        return true;
      }
      return false;
    }, label);

    if (!clicked) {
      // Try a broader text-based click as last resort
      try {
        await page.click(`text="${label}"`, { timeout: 5000 });
      } catch (e) {
        console.error(`  Failed to find menu item: "${label}"`);
        throw new Error(`Navigation failed at: ${label}`);
      }
    }

    if (isLast) {
      // Wait for the target view to load
      await waitForLoad(page);
    } else {
      // Brief pause for submenu to expand
      await page.waitForTimeout(800);
    }
  }

  console.log(`  Arrived at: ${menuPath[menuPath.length - 1]}`);
}

// Click a tab within a detail/tabbed view
export async function clickTab(page, tabLabel) {
  console.log(`  Clicking tab: ${tabLabel}...`);

  await page.evaluate((text) => {
    const tabs = document.querySelectorAll('.x-tab .x-button-label, .x-tab-inner');
    for (const tab of tabs) {
      if (tab.textContent.trim() === text) {
        tab.closest('.x-tab, .x-button')?.click();
        return true;
      }
    }
    return false;
  }, tabLabel);

  await waitForLoad(page);
}

// Click a toolbar button by icon class or text, scoped to a grid/panel (not the global header)
export async function clickToolbarButton(page, identifier, scope = 'grid') {
  console.log(`  Clicking toolbar button: ${identifier} (scope: ${scope})...`);

  const byIcon = await page.evaluate(({ cls, scope }) => {
    // Build a scoped selector to avoid hitting the global header hamburger
    let containers;
    if (scope === 'grid') {
      // Look inside grid titlebars first, then any titlebar that's NOT in the global header
      containers = document.querySelectorAll('.x-grid .x-titlebar, .x-panel .x-titlebar');
      if (containers.length === 0) {
        // Fallback: any titlebar not in the main header
        containers = document.querySelectorAll('.x-titlebar');
      }
    } else {
      containers = document.querySelectorAll(scope);
    }

    for (const container of containers) {
      // Skip the global header bar
      if (container.closest('.x-viewport > .x-container > .x-titlebar')) continue;
      if (container.closest('[data-ref="headerbar"]')) continue;

      const icon = container.querySelector(`.x-fa.${cls}`);
      if (icon) {
        const btn = icon.closest('.x-button, .x-btn');
        if (btn) { btn.click(); return true; }
        icon.click();
        return true;
      }
    }

    // Last resort: use ExtJS ComponentQuery scoped to the active grid
    if (cls === 'fa-bars') {
      const btn = Ext.ComponentQuery.query('accountingpricinggrid button[reference=toolbarHamburgerButton]')[0]
               || Ext.ComponentQuery.query('button[reference=toolbarHamburgerButton]')[0];
      if (btn) { btn.el.dom.click(); return true; }
    }

    // Generic ComponentQuery fallback for any icon
    const allBtns = Ext.ComponentQuery.query('button');
    for (const btn of allBtns) {
      const ic = btn.getIconCls?.() || '';
      if (ic.includes(cls) && btn.isVisible() && !btn.el?.dom?.closest('.x-viewport > .x-container:first-child')) {
        btn.el?.dom?.click();
        return true;
      }
    }

    return false;
  }, { cls: identifier, scope });

  if (!byIcon) {
    await page.click(`.x-titlebar :text("${identifier}"), .x-toolbar :text("${identifier}")`, { timeout: 5000 });
  }

  await page.waitForTimeout(800);
}

// Click a menu item from an open dropdown/menu
export async function clickMenuItem(page, itemText) {
  console.log(`  Clicking menu item: ${itemText}...`);

  await page.evaluate((text) => {
    const items = document.querySelectorAll('.x-menu-item .x-text-el, .x-menuitem .x-text-el, .x-menu .x-button-label');
    for (const item of items) {
      if (item.textContent.trim() === text) {
        item.closest('.x-menu-item, .x-menuitem, .x-button')?.click();
        return true;
      }
    }
    // Broader fallback
    const allText = document.querySelectorAll('.x-menu *');
    for (const el of allText) {
      if (el.textContent.trim() === text && el.children.length === 0) {
        el.click();
        return true;
      }
    }
    return false;
  }, itemText);

  await page.waitForTimeout(1000);
}

// Click a row in a grid by text content in any cell
export async function clickGridRow(page, cellText) {
  console.log(`  Clicking grid row containing: ${cellText}...`);

  await page.evaluate((text) => {
    const cells = document.querySelectorAll('.x-grid-cell, .x-gridcell');
    for (const cell of cells) {
      if (cell.textContent.trim().includes(text)) {
        cell.closest('.x-grid-row, .x-gridrow')?.click();
        return true;
      }
    }
    return false;
  }, cellText);

  await waitForLoad(page);
}
