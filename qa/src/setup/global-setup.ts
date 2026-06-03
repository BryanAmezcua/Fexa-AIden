import { chromium, FullConfig } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// Re-load .env here because globalSetup runs in its own module context.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

interface RoleCredentials {
  name: string;
  email: string | undefined;
  password: string | undefined;
}

const ROLES: RoleCredentials[] = [
  { name: 'admin',            email: process.env.ADMIN_EMAIL,            password: process.env.ADMIN_PASSWORD },
  { name: 'vendor',           email: process.env.VENDOR_EMAIL,           password: process.env.VENDOR_PASSWORD },
  { name: 'facility-manager', email: process.env.FACILITY_MANAGER_EMAIL, password: process.env.FACILITY_MANAGER_PASSWORD },
];

/**
 * Probe whether the target Rails server is in TANGO "fast mode" — i.e. is
 * serving the production-built Sencha bundle instead of dev-mode unpacked
 * sources. Returns true if the root URL redirects to /main/index (fast),
 * false if it goes to /main/development (slow).
 */
async function isFastMode(baseURL: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${baseURL}/`, { redirect: 'manual' });
    const location = res.headers.get('location') || '';
    if (location.includes('/main/index')) return true;
    if (location.includes('/main/development')) return false;
    return null; // unknown
  } catch {
    return null;
  }
}

/**
 * Runs once before the suite. For each role that has credentials in .env,
 * performs a real Devise sign-in against TEST_BASE_URL and saves the
 * resulting session cookies to auth/<role>.json. Tests then start logged in
 * via the per-project `storageState` setting in playwright.config.ts.
 *
 * If a role's credentials are missing, that role is skipped — any test
 * targeting that project will fail with a missing-storage-state error,
 * which is the signal to fill in .env.
 *
 * Also probes for TANGO fast mode (production-built Sencha bundle). If the
 * target is in dev mode, prints a warning pointing to `npm run fexa:fast-mode`
 * but does NOT abort — login still works either way, and the user may have
 * intentionally chosen to test against dev-mode Rails.
 */
async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = process.env.TEST_BASE_URL || 'http://localhost:3000';
  const authDir = path.resolve(__dirname, '../../auth');

  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const fastMode = await isFastMode(baseURL);
  if (fastMode === true) {
    console.log('[global-setup] ✅ Rails is in fast mode (production Sencha build)');
  } else if (fastMode === false) {
    console.warn('[global-setup] ⚠️  Rails is in DEV mode — Sencha will be slow to boot.');
    console.warn('[global-setup]    Run `npm run fexa:fast-mode` and restart Rails for fast tests.');
  } else {
    console.warn('[global-setup] ⚠️  Could not determine Rails mode (no redirect at /)');
  }

  console.log(`[global-setup] Logging in against ${baseURL}`);

  for (const role of ROLES) {
    if (!role.email || !role.password) {
      console.warn(`[global-setup] Skipping ${role.name}: credentials not set in .env`);
      continue;
    }

    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`${baseURL}/users/sign_in`, { waitUntil: 'domcontentloaded' });

      // Devise default field names. If Fexy-Zamo's login page uses custom
      // selectors, adjust here.
      await page.fill('input[name="user[email]"]', role.email);
      await page.fill('input[name="user[password]"]', role.password);

      // Sencha/Ext JS apps keep loading assets indefinitely, so the default
      // `waitUntil: 'load'` never resolves. Use 'commit' — fires the moment
      // the server responds to the post-login redirect, which is all we need
      // to know auth succeeded.
      await Promise.all([
        page.waitForURL(
          (url) => !url.pathname.includes('/users/sign_in'),
          { timeout: 30_000, waitUntil: 'commit' },
        ),
        page.click('input[type="submit"], button[type="submit"]'),
      ]);

      const statePath = path.join(authDir, `${role.name}.json`);
      await context.storageState({ path: statePath });
      console.log(`[global-setup] Saved auth for ${role.name} -> ${statePath}`);
    } catch (err) {
      // Don't abort the whole suite on one bad cred — log and continue.
      // Tests targeting this role's project will fail with a missing
      // storage-state error, which is the signal to fix the .env entry.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[global-setup] Login failed for ${role.name}: ${msg}`);
      try {
        const shotPath = path.join(authDir, `${role.name}-failure.png`);
        await page.screenshot({ path: shotPath, fullPage: true });
        const flash = await page.locator('.flash, .alert, [role="alert"]').allTextContents().catch(() => []);
        console.error(`[global-setup]   page URL: ${page.url()}`);
        console.error(`[global-setup]   flash/alert: ${JSON.stringify(flash)}`);
        console.error(`[global-setup]   screenshot: ${shotPath}`);
      } catch { /* best-effort diagnostics */ }
    } finally {
      await browser.close();
    }
  }
}

export default globalSetup;
