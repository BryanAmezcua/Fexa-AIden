// qa-bot/lib/auth.mjs — Login/logout/persona-switching helpers

import { waitForAppReady } from './extjs.mjs';

const DEFAULT_CREDENTIALS = {
  email: process.env.QA_EMAIL || 'adminofall@fexa.io',
  password: process.env.QA_PASSWORD || 'testPassword1',
};

// Navigate to the app and log in
export async function login(page, credentials = {}) {
  const creds = { ...DEFAULT_CREDENTIALS, ...credentials };
  const persona = creds.persona || creds.email;
  const baseUrl = page._qaConfig?.baseUrl || 'http://localhost:3000';

  console.log(`  Navigating to ${baseUrl}...`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for ExtJS to load enough to show the login form
  await waitForAppReady(page);

  // Check if we're already logged in (viewport has navigation)
  const alreadyLoggedIn = await page.evaluate(() => {
    return Ext.ComponentQuery.query('navigationTree').length > 0;
  }).catch(() => false);

  if (alreadyLoggedIn) {
    console.log(`  Already logged in (persona: ${persona}).`);
    return;
  }

  console.log(`  Logging in as ${creds.email} (persona: ${persona})...`);

  // Fill login form
  await page.fill('input[name="email"]', creds.email);
  await page.fill('input[name="pass"]', creds.password);

  // Click the visible LOGIN button
  await page.click('.login-box .x-button:visible');

  // Wait for the app to load after login (nav tree appears)
  await page.waitForFunction(() => {
    return Ext.ComponentQuery.query('navigationTree').length > 0;
  }, { timeout: 30000 });

  // Wait for loadLists() to finish — MainController fires it after a 1500ms
  // setTimeout on login, so we need enough time for both the delay and the
  // actual AJAX calls to complete.
  await page.waitForTimeout(4000);
  console.log(`  Login successful (persona: ${persona}).`);
}

// Robust logout via the global header hamburger menu -> Sign Out
export async function logout(page) {
  console.log('  Logging out...');

  // The global header hamburger is in the top-right area of the header,
  // near the user's display name. It is NOT the grid/column hamburger.
  // Look for the header menu button using ComponentQuery first.
  const menuClicked = await page.evaluate(() => {
    // The header hamburger menu button — typically an ExtJS button in the
    // top toolbar/header with a menu icon (fa-bars or similar).
    // Try several selectors that match the global header menu trigger.
    const candidates = [
      ...Ext.ComponentQuery.query('app-header button[iconCls~=fa-bars]'),
      ...Ext.ComponentQuery.query('app-header button[iconCls~=x-fa-bars]'),
      ...Ext.ComponentQuery.query('main-header button[iconCls~=fa-bars]'),
      ...Ext.ComponentQuery.query('toolbar button[iconCls~=fa-bars]'),
      ...Ext.ComponentQuery.query('container[cls~=app-header] button'),
    ];

    // Pick the rightmost candidate (the global menu, not a grid menu)
    // by sorting on the x position — highest x = rightmost.
    const visible = candidates.filter(b => b.el && b.el.isVisible());
    if (visible.length === 0) return false;

    // Sort descending by x position to get the one nearest the right edge
    visible.sort((a, b) => {
      const ax = a.el.getX();
      const bx = b.el.getX();
      return bx - ax;
    });

    visible[0].fireEvent('tap', visible[0]);
    return true;
  }).catch(() => false);

  if (!menuClicked) {
    // Fallback: try clicking the DOM element directly — look for the
    // hamburger icon in the header region (top-right area).
    console.log('  ComponentQuery missed header menu; trying DOM click...');
    try {
      // The header bar is typically in the first 60px of the page.
      // Look for a bars icon or a button near the username.
      const headerMenu = page.locator(
        '.app-header .x-button:has(.fa-bars), ' +
        '.x-toolbar .x-button:has(.fa-bars)'
      ).last(); // .last() picks the rightmost/last one in DOM order
      await headerMenu.click({ timeout: 5000 });
    } catch {
      console.warn('  Could not find header hamburger menu — trying keyboard shortcut or direct Sign Out.');
    }
  }

  // Small pause for the menu to animate open
  await page.waitForTimeout(500);

  // Click "Sign Out" from the dropdown menu
  const signedOut = await page.evaluate(() => {
    // Look for a menu item with text "Sign Out" (case-insensitive)
    const menuItems = Ext.ComponentQuery.query('menuitem');
    const signOut = menuItems.find(mi => {
      const text = (mi.getText && mi.getText()) || (mi.text) || '';
      return /sign\s*out/i.test(text);
    });
    if (signOut) {
      signOut.fireEvent('tap', signOut);
      return true;
    }

    // Fallback: look for any visible element with "Sign Out" text
    const els = document.querySelectorAll('.x-menuitem, .x-button, [role="menuitem"]');
    for (const el of els) {
      if (/sign\s*out/i.test(el.textContent)) {
        el.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);

  if (!signedOut) {
    // Last resort: click by visible text
    console.log('  Trying text-based Sign Out click...');
    try {
      await page.getByText('Sign Out', { exact: false }).click({ timeout: 5000 });
    } catch {
      console.warn('  Could not click Sign Out — logout may have failed.');
    }
  }

  // Handle any confirmation dialog (e.g., "Are you sure you want to sign out?")
  try {
    const confirmBtn = page.locator(
      '.x-messagebox .x-button:has-text("Yes"), ' +
      '.x-messagebox .x-button:has-text("OK"), ' +
      '.x-dialog .x-button:has-text("Yes"), ' +
      '.x-dialog .x-button:has-text("OK")'
    ).first();
    await confirmBtn.click({ timeout: 3000 });
  } catch {
    // No confirmation dialog — that's fine
  }

  // Wait for redirect back to the login page
  try {
    await page.waitForFunction(() => {
      // Login page: no nav tree, login box is present
      const hasLogin = document.querySelector('input[name="email"]') !== null
                    || document.querySelector('.login-box') !== null;
      const noNav = typeof Ext === 'undefined'
                 || Ext.ComponentQuery.query('navigationTree').length === 0;
      return hasLogin && noNav;
    }, { timeout: 15000 });
  } catch {
    // Fallback: just wait and hope the page redirected
    await page.waitForTimeout(3000);
  }

  console.log('  Logout complete.');
}

// Switch persona: logout current user, then login as a different user
export async function switchPersona(page, credentials = {}) {
  const persona = credentials.persona || credentials.email || 'unknown';
  console.log(`  Switching persona to "${persona}"...`);

  await logout(page);

  // Brief pause to let the login page fully settle after logout
  await page.waitForTimeout(1000);

  await login(page, credentials);

  console.log(`  Persona switch to "${persona}" complete.`);
  return persona;
}
