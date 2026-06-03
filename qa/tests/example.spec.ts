import { test, expect } from '@playwright/test';

/**
 * Sanity check that storageState-based auth is working. Runs once per
 * configured project (admin, vendor, facility-manager) — if any role can't
 * reach a logged-in page, the assertion fails and an artifact is captured.
 *
 * Delete this once you have real ticket tests; it's only here as a smoke
 * test for the harness itself.
 */
test('starts logged in (not redirected to sign-in)', async ({ page }) => {
  // Sencha Ext JS keeps loading assets for a long time after DOM is ready,
  // so the default `waitUntil: 'load'` will time out on every page.goto.
  // 'commit' returns as soon as the server response is received, which is
  // all we need to read the final URL after any post-login redirect.
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page).not.toHaveURL(/\/users\/sign_in/);
});
