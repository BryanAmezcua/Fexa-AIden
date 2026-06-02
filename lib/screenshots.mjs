// qa-bot/lib/screenshots.mjs — Screenshot capture + base64 encoding

import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { SCREENSHOT_DIR } from './config.mjs';

// Dismiss any stray open menus/dropdowns/overlays before taking a screenshot
async function dismissOverlays(page) {
  try {
    await page.evaluate(() => {
      // Close all ExtJS menus
      if (typeof Ext !== 'undefined' && Ext.ComponentQuery) {
        Ext.ComponentQuery.query('menu').forEach(m => { try { m.hide(); } catch(e) {} });
        // Close any open pickers/boundlists
        Ext.ComponentQuery.query('boundlist').forEach(l => { try { l.hide(); } catch(e) {} });
        Ext.ComponentQuery.query('picker').forEach(p => { try { p.hide(); } catch(e) {} });
        // Close floating panels that aren't the main viewport
        Ext.ComponentQuery.query('panel[floating=true]').forEach(p => {
          try { if (!p.el?.dom?.closest('.x-viewport')) p.hide(); } catch(e) {}
        });
      }
    });
    await page.waitForTimeout(200);
  } catch (e) {
    // Ignore — page may not have Ext loaded yet
  }
}

// Take a screenshot and save it with a descriptive name.
//
// opts.focus (Locator): REQUIRED for AC-evidence screenshots.
//   The helper asserts the locator is visible (test fails clearly if not),
//   scrolls it into view, then captures the full viewport at natural size.
//   This prevents the "test green, screenshot empty" failure mode where the
//   assertion passes against component state but the screenshot fires against
//   a viewport that scrolled wrong or dismissed the relevant transient UI.
//   Omit only for incidental captures (overview shots), never for AC evidence.
export async function capture(page, name, opts = {}) {
  const dir = page._qaConfig?.screenshotDir || SCREENSHOT_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (opts.focus) {
    const loc = typeof opts.focus === 'function' ? opts.focus(page) : opts.focus;
    try {
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
      await page.waitForTimeout(300);
    } catch (e) {
      throw new Error(`screenshot(${name}): focus locator not visible/scrollable within 5s — ${e.message}`);
    }
  }

  // Dismiss stray overlays unless this screenshot intentionally shows a menu
  if (!opts.keepOverlays) {
    await dismissOverlays(page);
  }

  const filename = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
  const filepath = join(dir, filename);

  await page.screenshot({
    path: filepath,
    fullPage: opts.fullPage || false,
    clip: opts.clip || undefined,
  });

  console.log(`  Screenshot saved: ${filename}`);
  return filepath;
}

// Take a screenshot of a specific element/selector
export async function captureElement(page, selector, name) {
  const dir = page._qaConfig?.screenshotDir || SCREENSHOT_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filename = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
  const filepath = join(dir, filename);

  const element = await page.$(selector);
  if (element) {
    await element.screenshot({ path: filepath });
    console.log(`  Element screenshot saved: ${filename}`);
  } else {
    // Fallback to full page
    await page.screenshot({ path: filepath });
    console.log(`  Element not found, full page screenshot saved: ${filename}`);
  }

  return filepath;
}

// Convert a screenshot file to a base64 data URI
export function toBase64(filepath) {
  const buffer = readFileSync(filepath);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

// Load all screenshots from a directory and return as { name: base64 } map
export function loadAllAsBase64(dir) {
  const { readdirSync } = require('fs');
  const files = readdirSync(dir).filter(f => f.endsWith('.png'));
  const map = {};
  for (const file of files) {
    const name = file.replace('.png', '');
    map[name] = toBase64(join(dir, file));
  }
  return map;
}
