// qa-bot/lib/extjs.mjs — ExtJS-specific helpers (wait for render, component queries)

// Wait for the ExtJS app to fully bootstrap (viewport rendered, no loading masks)
export async function waitForAppReady(page, timeout = 60000) {
  console.log('  Waiting for ExtJS app to load...');

  // Wait for the Ext global to exist
  await page.waitForFunction(() => typeof Ext !== 'undefined' && Ext.isReady, { timeout });

  // Wait for viewport to render
  await page.waitForSelector('.x-viewport', { timeout });

  // Wait for any loading masks to clear
  await page.waitForFunction(() => {
    const masks = document.querySelectorAll('.x-mask:not([style*="display: none"])');
    return masks.length === 0;
  }, { timeout: 15000 }).catch(() => {});

  // Let layout settle
  await page.waitForTimeout(1500);
  console.log('  ExtJS app ready.');
}

// Wait for a loading mask to appear and then disappear (after a navigation/action)
export async function waitForLoad(page, timeout = 30000) {
  // Brief pause for mask to appear
  await page.waitForTimeout(500);

  // Wait for masks to clear
  await page.waitForFunction(() => {
    const masks = document.querySelectorAll('.x-mask:not([style*="display: none"])');
    return masks.length === 0;
  }, { timeout }).catch(() => {});

  await page.waitForTimeout(1000);
}

// Run an Ext.ComponentQuery and return the count of matches
export async function componentQueryCount(page, query) {
  return page.evaluate((q) => {
    return Ext.ComponentQuery.query(q).length;
  }, query);
}

// Check if a specific ExtJS component exists
export async function componentExists(page, query) {
  return (await componentQueryCount(page, query)) > 0;
}

// Wait for an ExtJS component to be rendered
export async function waitForComponent(page, query, timeout = 15000) {
  await page.waitForFunction((q) => {
    return Ext.ComponentQuery.query(q).length > 0;
  }, query, { timeout });
}

// Click an element by its visible text content
export async function clickByText(page, text, parentSelector = 'body') {
  const escaped = text.replace(/'/g, "\\'");
  await page.click(`${parentSelector} >> text="${text}"`);
}

// Get all visible text from a component's element
export async function getComponentText(page, query) {
  return page.evaluate((q) => {
    const cmp = Ext.ComponentQuery.query(q)[0];
    return cmp ? cmp.el.dom.innerText : null;
  }, query);
}
