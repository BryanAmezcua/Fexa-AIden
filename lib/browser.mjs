// qa-bot/lib/browser.mjs — Browser lifecycle + page setup
import { chromium } from 'playwright';
import { SCREENSHOT_DIR, BASE_URL } from './config.mjs';

const DEFAULTS = {
  viewport: { width: 1920, height: 1080 },
  baseUrl: BASE_URL,
  timeout: 60000,
  screenshotDir: process.env.QA_SCREENSHOT_DIR || SCREENSHOT_DIR,
};

let _browser = null;
let _page = null;

export async function launch(opts = {}) {
  const config = { ...DEFAULTS, ...opts };

  _browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  _page = await _browser.newPage({
    viewport: config.viewport,
    ignoreHTTPSErrors: true,
  });

  _page.setDefaultTimeout(config.timeout);
  _page._qaConfig = config;

  return _page;
}

export async function close() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _page = null;
  }
}

export function getPage() {
  return _page;
}
