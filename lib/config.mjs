// qa-bot/lib/config.mjs — Centralized path + env configuration
// All paths are relative to the project root (where run.mjs lives).

import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT = resolve(__dirname, '..');

// Load .env file if present (simple key=value, no interpolation)
const envPath = join(PROJECT_ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// Paths (all relative to project root)
export const TMP_DIR = join(PROJECT_ROOT, 'tmp');
export const SCREENSHOT_DIR = join(PROJECT_ROOT, 'screenshots');
export const REPORT_DIR = join(PROJECT_ROOT, 'reports');

// App under test
export const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
export const QA_EMAIL = process.env.QA_EMAIL || 'adminofall@fexa.io';
export const QA_PASSWORD = process.env.QA_PASSWORD || '';

// Rails root (for seed scripts — WSL path)
export const RAILS_ROOT = process.env.RAILS_ROOT || '/home/bryan/Fexy-Zamo';

// Jira
export const JIRA_HOST = process.env.JIRA_HOST || 'https://facilitiesexchange.atlassian.net';
export const JIRA_EMAIL = process.env.JIRA_EMAIL || 'bryan@trakref.com';
export const JIRA_TOKEN_PATH = resolve(process.env.JIRA_TOKEN_PATH || join(PROJECT_ROOT, 'token'));
