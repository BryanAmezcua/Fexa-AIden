import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, captureAcSnapshot, TANGO_49_AC } from '../../src/support/qa-report';

/**
 * API-layer pricing enforcement — TANGO-49.
 *
 * This is an API-only story: the model-layer guard
 * (app/models/concerns/subcontractor_pricing_enforcement.rb) rejects an API
 * write to a Subcontractor [Invoice|Quote] Line Item unit_price when the
 * matched pricing has prevent_price_modification = true and the submitted
 * price != Products::ProductPricing.evaluate_data output.
 *
 * Shipped contract (verified against the running app, NOT a structured 422):
 * the guard rejects via a standard Rails validation error, surfaced by the EV1
 * responder as HTTP 201 (single line item) / 200 (nested parent) with body
 * { line_items|invoices: { ...attrs, id: null when rejected }, errors, success }.
 * A rejected write => success:false + an errors entry on the offending field
 * (e.g. errors.unit_price). There is NO error `code`, NO discrete `approved_rate`
 * field, and NO 4xx status — see the AC#7 deviation note in the QA report.
 *
 * There is no Ext JS screen to drive, so these tests exercise the EV1
 * endpoints directly with Doorkeeper bearer tokens (minted by the seed) and
 * render each request + response into the before/after report snapshots so
 * the standard ticket report still shows readable evidence.
 *
 * Pre-requisite: `npm run seed:pricing-enforcement-api` — creates the
 * enforced/unenforced pricings, a fresh draft invoice + quote, and the
 * vendor (no-override) + admin (super_admin -> override) bearer tokens, and
 * writes reports/seed-manifest-tango-49.json.
 *
 * Coverage note: three AC#14 cases are NOT reachable through the EV1 API and
 * are verified at the MODEL layer by the seed (recorded in the manifest's
 * model_checks block, asserted by the last test here):
 *   - AC 4  (out-of-window pricing_id) — pricing_id isn't an API-writable param.
 *   - AC 10 (approved invoice no re-eval) — controller blocks the edit first.
 *   - AC 12 (write-time pricing state) — an in-process property.
 * The bundle endpoint (AC 11) accepts no line-item prices, so "no bypass via
 * batched payloads" is demonstrated by the batched nested-invoice write below.
 */

const TICKET = 'TANGO-49';

interface Manifest {
  ticket: string;
  scope: {
    enforced_product: { id: number; name: string };
    unenforced_product: { id: number; name: string };
    vendor: { user_email: string; role_id: number };
    admin: { user_email: string; super_admin: boolean };
    approved_rate: number;
    invoice_targets: { draft_invoice_id: number; draft_quote_id: number; approved_invoice_id: number };
  };
  api_auth: {
    base_path: string;
    token_type: string;
    vendor_token: string;
    admin_token: string;
  };
  model_checks: Array<{ ac: string; name: string; passed: boolean; detail: string }>;
}

const MANIFEST_PATH = path.resolve(process.cwd(), 'reports', 'seed-manifest-tango-49.json');
const QA_DESC_PREFIX = '[QA-TANGO49]';

function loadManifest(): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

// --- Evidence rendering ----------------------------------------------------

interface ExchangeView {
  title: string;
  persona: string;
  method: string;
  url: string;
  requestBody: unknown;
  status?: number;
  responseBody?: unknown;
  note?: string;
}

/**
 * Render the API request (and, when present, the response) into the page as a
 * readable card, then capture it as an AC snapshot. Keeps the report's
 * before/after image contract meaningful for an API-only story: 'before'
 * shows the outbound request, 'after' shows the response + status.
 */
async function renderExchange(
  testInfo: import('@playwright/test').TestInfo,
  page: Page,
  moment: 'before' | 'after',
  view: ExchangeView,
): Promise<void> {
  const statusClass = view.status == null ? '' : view.status >= 200 && view.status < 300 ? 'ok' : 'err';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const json = (v: unknown) => esc(JSON.stringify(v, null, 2));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font: 14px/1.5 -apple-system, Menlo, monospace; margin: 0; background: #0f1115; color: #e6e6e6; padding: 24px; }
    .title { font-size: 18px; font-weight: 700; margin-bottom: 4px; color: #fff; }
    .persona { color: #9aa4b2; margin-bottom: 16px; }
    .card { background: #171a21; border: 1px solid #2a2f3a; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .card h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #9aa4b2; }
    .reqline { font-weight: 700; color: #7fd1ff; word-break: break-all; }
    pre { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; }
    .status { display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 700; }
    .status.ok { background: #14361f; color: #7ee29b; border: 1px solid #2f6b43; }
    .status.err { background: #3a1620; color: #ff9bb0; border: 1px solid #7a2c3f; }
    .note { color: #d7b65a; margin-top: 8px; }
  </style></head><body>
    <div class="title">${esc(view.title)}</div>
    <div class="persona">Persona: ${esc(view.persona)} &nbsp;·&nbsp; ${TICKET}</div>
    <div id="req-card" class="card">
      <h3>Request</h3>
      <div class="reqline">${esc(view.method)} ${esc(view.url)}</div>
      <pre>${json(view.requestBody)}</pre>
    </div>
    ${view.status != null ? `<div id="res-card" class="card">
      <h3>Response</h3>
      <div><span id="status" class="status ${statusClass}">HTTP ${view.status}</span></div>
      <pre>${json(view.responseBody)}</pre>
    </div>` : ''}
    ${view.note ? `<div class="note">${esc(view.note)}</div>` : ''}
  </body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  const focus = moment === 'after' && view.status != null
    ? page.locator('#res-card')
    : page.locator('#req-card');
  await captureAcSnapshot(testInfo, page, moment, { focus });
}

// --- API helpers -----------------------------------------------------------

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

interface ApiResult {
  status: number;
  body: unknown;
}

async function apiSend(
  request: APIRequestContext,
  method: 'post' | 'put',
  url: string,
  token: string,
  data: unknown,
): Promise<ApiResult> {
  const res = await request[method](url, { headers: authHeaders(token), data });
  const status = res.status();
  let body: unknown;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status, body };
}

// --- Shipped EV1 contract (observed) ---------------------------------------
// There is NO raised EnforcedPricingViolation and NO structured 422 { code,
// field, approved_rate } payload. The model guard rejects via standard Rails
// validation errors, surfaced by the EV1 responder as:
//   HTTP 201 (single line item) / 200 (nested parent), body:
//   { line_items|invoices: { ...attrs, id: null on reject }, errors: {...}, success: bool }
// A rejected write is signalled by success:false + an errors entry on the
// offending field (id stays null = nothing persisted). On the nested parent
// endpoint the error key is association-prefixed
// ("subcontractor_invoice_line_items.unit_price").

/** True when the write was rejected (not persisted). */
function isRejected(body: unknown): boolean {
  return (body as any)?.success === false;
}

/** Validation messages for a field, tolerant of the association-prefixed key on nested writes. */
function fieldErrors(body: unknown, field: string): string[] {
  const errs = (body as any)?.errors;
  if (!errs || typeof errs !== 'object') return [];
  const key = Object.keys(errs).find((k) => k === field || k.endsWith(`.${field}`));
  return key ? (errs[key] as string[]) : [];
}

// DB reads/cleanup go through `rails runner` (reliable in this WSL env, where
// psql peer-auth on the unix socket is unavailable). Mirrors the TANGO-10
// backfill helper. Ruby strings are double-quoted so the whole snippet can be
// wrapped in bash single quotes.
function railsEval(ruby: string): string {
  const cmd = `cd "${process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo'}" && DISABLE_SPRING=1 bundle exec rails runner '${ruby}'`;
  return execSync(cmd, { cwd: process.cwd(), shell: '/bin/bash', encoding: 'utf8', timeout: 120_000 });
}

function lineItemId(body: unknown): number | null {
  const li = (body as any)?.line_items;
  if (!li) return null;
  const rec = Array.isArray(li) ? li[0] : li;
  return rec?.id ?? null;
}

/** Count line_items rows matching a description — proves a rejected write created NO row. */
function lineItemCountByDesc(descLike: string): number {
  try {
    const out = railsEval(`puts "CNT="+Invoices::LineItem.where("description LIKE ?","${descLike}").count.to_s`);
    const line = out.split('\n').find((l) => l.startsWith('CNT='));
    return line ? parseInt(line.replace('CNT=', ''), 10) : -1;
  } catch {
    return -1;
  }
}

/** Read the most-recent override audit (count + comment) for a line item. */
function overrideAudit(lineItemId: number): { count: number; comment: string } {
  try {
    // audited records the STI base class ("Invoices::LineItem"), not the subclass.
    const ruby = `a=Audited::Audit.where(auditable_type:"Invoices::LineItem",auditable_id:${lineItemId}).where("comment ILIKE ?","%override%");require"json";puts "OVR="+{count:a.count,comment:a.order("created_at DESC").first&.comment.to_s}.to_json`;
    const out = railsEval(ruby);
    const line = out.split('\n').find((l) => l.startsWith('OVR='));
    return line ? JSON.parse(line.replace('OVR=', '')) : { count: -1, comment: '' };
  } catch {
    return { count: -1, comment: '' };
  }
}

/** Best-effort cleanup of this suite's line items (one Rails boot; runs in afterAll). */
function cleanupApiLineItems(): void {
  try {
    railsEval(`puts "DEL="+Invoices::LineItem.where("description LIKE ?","${QA_DESC_PREFIX}%").destroy_all.size.to_s`);
  } catch (err) {
    console.warn('[cleanup] failed:', (err as Error).message);
  }
}

// --- Suite -----------------------------------------------------------------

const manifest = loadManifest();

test.describe('API-layer pricing enforcement (TANGO-49)', () => {
  // One retry absorbs the first-test cold-start flake on a fresh worker
  // (global-setup login + first EV1 call warming at once); the retry runs warm
  // and passes reliably. Mirrors the TANGO-10 reporting spec.
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(120_000);

  const base = manifest?.api_auth.base_path ?? '/api/ev1';
  const vendorPersona = `Vendor integration · ${manifest?.scope.vendor.user_email ?? 'subcontractor_user3083@fexa.io'} (Bearer, no override permission)`;
  const adminPersona = `Admin · ${manifest?.scope.admin.user_email ?? 'bigbrother@fexa.io'} (Bearer, super_admin → :can_override_enforced_pricing)`;

  test.beforeEach(async ({}, testInfo) => {
    // Pure API tests using explicit bearer tokens — persona is the token, not
    // the Playwright project. Run once under the admin project to avoid
    // emitting the same ticket report three times.
    test.skip(testInfo.project.name !== 'admin', 'API tests carry explicit bearer tokens; run once under the admin project');
    test.skip(!manifest, `Seed manifest missing at ${MANIFEST_PATH}. Run: npm run seed:pricing-enforcement-api`);
  });

  test.afterAll(() => {
    cleanupApiLineItems();
  });

  test('enforced pricing: a write whose unit_price equals the Approved Rate is accepted', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.EnforcementScope2, TANGO_49_AC.Coverage14] });
    const m = manifest!;
    const url = `${base}/subcontractor_invoice_line_items`;
    const body = {
      line_items: {
        invoice_id: m.scope.invoice_targets.draft_invoice_id,
        product_id: m.scope.enforced_product.id,
        quantity: 1,
        unit_price: m.scope.approved_rate,
        description: `${QA_DESC_PREFIX} match-accept`,
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: `POST line item with matching Approved Rate ($${m.scope.approved_rate})`,
      persona: vendorPersona, method: 'POST', url, requestBody: body,
    });

    let result!: ApiResult;
    await test.step(`POST ${url} → line_items{ product_id=${m.scope.enforced_product.id} (${m.scope.enforced_product.name}), unit_price=${m.scope.approved_rate} (== Approved Rate) }`, async () => {
      result = await apiSend(request, 'post', url, m.api_auth.vendor_token, body);
    });

    await test.step('Verify the write is accepted (HTTP 201, success=true, line item persisted)', async () => {
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(201);
      expect((result.body as any)?.success).toBe(true);
      expect(lineItemId(result.body), 'persisted line item id').toBeTruthy();
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Matching Approved Rate accepted', persona: vendorPersona, method: 'POST', url,
      requestBody: body, status: result.status, responseBody: result.body,
    });
  });

  test('enforced pricing: a mismatched unit_price is rejected (success:false + structured unit_price error)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.EnforcementScope2, TANGO_49_AC.VendorExperience7, TANGO_49_AC.Coverage14] });
    const m = manifest!;
    const url = `${base}/subcontractor_invoice_line_items`;
    const submitted = m.scope.approved_rate + 50;
    const body = {
      line_items: {
        invoice_id: m.scope.invoice_targets.draft_invoice_id,
        product_id: m.scope.enforced_product.id,
        quantity: 1,
        unit_price: submitted,
        description: `${QA_DESC_PREFIX} mismatch-reject`,
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: `POST line item with mismatched unit_price ($${submitted} vs Approved $${m.scope.approved_rate})`,
      persona: vendorPersona, method: 'POST', url, requestBody: body,
    });

    let result!: ApiResult;
    await test.step(`POST ${url} → line_items{ product_id=${m.scope.enforced_product.id}, unit_price=${submitted} (Approved Rate is $${m.scope.approved_rate}) }`, async () => {
      result = await apiSend(request, 'post', url, m.api_auth.vendor_token, body);
    });

    await test.step('Verify rejection: success=false, unit_price error embeds both amounts, no row persisted (AC 7)', async () => {
      // Shipped contract: HTTP 201 + success:false + errors.unit_price (NOT a 422 with a code).
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(201);
      expect(isRejected(result.body), 'rejected write reports success=false').toBe(true);
      const msgs = fieldErrors(result.body, 'unit_price');
      expect(msgs.length, 'a unit_price validation error is present').toBeGreaterThan(0);
      const msg = msgs.join(' ');
      // AC#7: the message embeds BOTH amounts ("Submitted rate $X does not match approved rate $Y.").
      expect(msg).toContain('This rate is enforced by your client');
      expect(msg).toMatch(/does not match approved rate/);
      expect(msg, 'approved amount rendered in message').toContain(String(Math.trunc(m.scope.approved_rate)));
      expect(msg, 'submitted amount rendered in message').toContain(String(Math.trunc(submitted)));
      // The rejected write must have created NO line item.
      expect(lineItemId(result.body), 'no line item persisted (id null = nothing written)').toBeNull();
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Mismatched unit_price rejected (success:false + unit_price error)', persona: vendorPersona,
      method: 'POST', url, requestBody: body, status: result.status, responseBody: result.body,
    });
  });

  test('enforced pricing: an undercharge (unit_price BELOW the Approved Rate) is also rejected', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.EnforcementScope2, TANGO_49_AC.Coverage14] });
    const m = manifest!;
    const url = `${base}/subcontractor_invoice_line_items`;
    const submitted = m.scope.approved_rate - 25; // below approved — guard is equality, so both directions reject
    const body = {
      line_items: {
        invoice_id: m.scope.invoice_targets.draft_invoice_id,
        product_id: m.scope.enforced_product.id,
        quantity: 1,
        unit_price: submitted,
        description: `${QA_DESC_PREFIX} undercharge-reject`,
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: `POST undercharge: unit_price $${submitted} is BELOW Approved $${m.scope.approved_rate}`,
      persona: vendorPersona, method: 'POST', url, requestBody: body,
      note: 'AC 2 is "does not equal" — the guard rejects undercharges just like overcharges.',
    });

    let result!: ApiResult;
    await test.step(`POST ${url} → unit_price=${submitted} (below Approved Rate $${m.scope.approved_rate})`, async () => {
      result = await apiSend(request, 'post', url, m.api_auth.vendor_token, body);
    });

    await test.step('Verify the undercharge is rejected: success=false + unit_price error; no row created', async () => {
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(201);
      expect(isRejected(result.body)).toBe(true);
      expect(fieldErrors(result.body, 'unit_price').length, 'unit_price validation error').toBeGreaterThan(0);
      expect(lineItemId(result.body), 'no line item persisted').toBeNull();
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Undercharge rejected (success:false + unit_price error)', persona: vendorPersona,
      method: 'POST', url, requestBody: body, status: result.status, responseBody: result.body,
    });
  });

  test('a vendor without override permission gets a value rejection (success:false), not 401/403 (auth)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.Permissions6] });
    const m = manifest!;
    const url = `${base}/subcontractor_invoice_line_items`;
    const submitted = m.scope.approved_rate + 25;
    const body = {
      line_items: {
        invoice_id: m.scope.invoice_targets.draft_invoice_id,
        product_id: m.scope.enforced_product.id,
        quantity: 1,
        unit_price: submitted,
        description: `${QA_DESC_PREFIX} 422-not-403`,
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: 'Authenticated vendor submits a disallowed rate (no override permission)',
      persona: vendorPersona, method: 'POST', url, requestBody: body,
      note: 'Auth is valid; only the value is wrong — the write is rejected (success:false), never an auth 401/403.',
    });

    let result!: ApiResult;
    await test.step(`POST ${url} as authenticated vendor with disallowed unit_price=${submitted}`, async () => {
      result = await apiSend(request, 'post', url, m.api_auth.vendor_token, body);
    });

    await test.step('Verify the VALUE is rejected (success=false + unit_price error), and it is NOT an auth failure (401/403)', async () => {
      expect(result.status).not.toBe(401);
      expect(result.status).not.toBe(403);
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(201);
      expect(isRejected(result.body), 'value rejected via success=false, not an auth error').toBe(true);
      expect(fieldErrors(result.body, 'unit_price').length, 'unit_price validation error').toBeGreaterThan(0);
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Value rejected (success:false), not an auth failure', persona: vendorPersona,
      method: 'POST', url, requestBody: body, status: result.status, responseBody: result.body,
    });
  });

  test('unenforced pricing: any unit_price proceeds (no behavior change)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.VendorExperience8, TANGO_49_AC.Coverage14] });
    const m = manifest!;
    const url = `${base}/subcontractor_invoice_line_items`;
    const body = {
      line_items: {
        invoice_id: m.scope.invoice_targets.draft_invoice_id,
        product_id: m.scope.unenforced_product.id,
        quantity: 1,
        unit_price: 9999,
        description: `${QA_DESC_PREFIX} unenforced-accept`,
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: `POST line item on UNENFORCED product (${m.scope.unenforced_product.name}) with arbitrary unit_price $9999`,
      persona: vendorPersona, method: 'POST', url, requestBody: body,
    });

    let result!: ApiResult;
    await test.step(`POST ${url} → unenforced product_id=${m.scope.unenforced_product.id}, unit_price=9999`, async () => {
      result = await apiSend(request, 'post', url, m.api_auth.vendor_token, body);
    });

    await test.step('Verify the write proceeds (HTTP 201, success=true, persisted) — no enforced pricing matched', async () => {
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(201);
      expect((result.body as any)?.success).toBe(true);
      expect(lineItemId(result.body), 'persisted line item id').toBeTruthy();
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Unenforced pricing — arbitrary rate accepted', persona: vendorPersona,
      method: 'POST', url, requestBody: body, status: result.status, responseBody: result.body,
    });
  });

  // --- Quote source (AC#2 names SubcontractorQuoteLineItem too) ---------------
  // The EV1 quote controller resolves its parent from params[:line_items][:invoice_id]
  // (subcontractor_quote_line_items_controller.rb#create), so the quote id is passed
  // under invoice_id — same body shape as the invoice endpoint.

  test('quote line item: a write whose unit_price equals the Approved Rate is accepted', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.EnforcementScope2, TANGO_49_AC.Coverage14] });
    const m = manifest!;
    const url = `${base}/subcontractor_quote_line_items`;
    const body = {
      line_items: {
        invoice_id: m.scope.invoice_targets.draft_quote_id,
        product_id: m.scope.enforced_product.id,
        quantity: 1,
        unit_price: m.scope.approved_rate,
        description: `${QA_DESC_PREFIX} quote-match-accept`,
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: `POST quote line item with matching Approved Rate ($${m.scope.approved_rate})`,
      persona: vendorPersona, method: 'POST', url, requestBody: body,
      note: 'Same guard, quote source — AC 2 covers SubcontractorQuoteLineItem as well.',
    });

    let result!: ApiResult;
    await test.step(`POST ${url} → quote(invoice_id)=${m.scope.invoice_targets.draft_quote_id}, product_id=${m.scope.enforced_product.id}, unit_price=${m.scope.approved_rate} (== Approved Rate)`, async () => {
      result = await apiSend(request, 'post', url, m.api_auth.vendor_token, body);
    });

    await test.step('Verify the quote write is accepted (HTTP 201, success=true, persisted)', async () => {
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(201);
      expect((result.body as any)?.success).toBe(true);
      expect(lineItemId(result.body), 'persisted quote line item id').toBeTruthy();
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Quote source: matching Approved Rate accepted', persona: vendorPersona, method: 'POST', url,
      requestBody: body, status: result.status, responseBody: result.body,
    });
  });

  test('quote line item: a mismatched unit_price is rejected (success:false + unit_price error)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.EnforcementScope2, TANGO_49_AC.VendorExperience7, TANGO_49_AC.Coverage14] });
    const m = manifest!;
    const url = `${base}/subcontractor_quote_line_items`;
    const submitted = m.scope.approved_rate + 50;
    const body = {
      line_items: {
        invoice_id: m.scope.invoice_targets.draft_quote_id,
        product_id: m.scope.enforced_product.id,
        quantity: 1,
        unit_price: submitted,
        description: `${QA_DESC_PREFIX} quote-mismatch-reject`,
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: `POST quote line item with mismatched unit_price ($${submitted} vs Approved $${m.scope.approved_rate})`,
      persona: vendorPersona, method: 'POST', url, requestBody: body,
    });

    let result!: ApiResult;
    await test.step(`POST ${url} → quote line item, unit_price=${submitted} (Approved Rate is $${m.scope.approved_rate})`, async () => {
      result = await apiSend(request, 'post', url, m.api_auth.vendor_token, body);
    });

    await test.step('Verify rejection on the quote source: success=false + unit_price error; no row created', async () => {
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(201);
      expect(isRejected(result.body), 'quote write rejected (success=false)').toBe(true);
      expect(fieldErrors(result.body, 'unit_price').length, 'unit_price validation error on the quote source').toBeGreaterThan(0);
      expect(lineItemId(result.body), 'no quote line item persisted').toBeNull();
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Quote source: mismatched unit_price rejected (success:false)', persona: vendorPersona,
      method: 'POST', url, requestBody: body, status: result.status, responseBody: result.body,
    });
  });

  test('nested/batched parent write: an invoice payload with a mismatched line item is rejected (no bypass)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.EnforcementScope3, TANGO_49_AC.Edge11, TANGO_49_AC.Coverage14] });
    const m = manifest!;
    const url = `${base}/subcontractor_invoices/${m.scope.invoice_targets.draft_invoice_id}`;
    const submitted = m.scope.approved_rate + 75;
    // A batched payload: one valid line item + one disallowed line item. The
    // model-layer guard must reject the disallowed one even inside a batch.
    const body = {
      invoices: {
        subcontractor_invoice_line_items_attributes: [
          { product_id: m.scope.unenforced_product.id, quantity: 1, unit_price: 10, description: `${QA_DESC_PREFIX} nested-ok` },
          { product_id: m.scope.enforced_product.id, quantity: 1, unit_price: submitted, description: `${QA_DESC_PREFIX} nested-bad` },
        ],
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: 'PATCH parent invoice with a batched payload (one valid + one disallowed line item)',
      persona: vendorPersona, method: 'PUT', url, requestBody: body,
      note: 'Side-step attempt via the parent endpoint / batched payload.',
    });

    let result!: ApiResult;
    await test.step(`PUT ${url} → nested subcontractor_invoice_line_items_attributes with a disallowed unit_price=${submitted}`, async () => {
      result = await apiSend(request, 'put', url, m.api_auth.vendor_token, body);
    });

    await test.step('Verify the batched/nested write is rejected: HTTP 200, success=false, unit_price error on the nested item; no bypass', async () => {
      // Parent endpoint returns 200; rejection is success:false with an
      // association-prefixed error key ("subcontractor_invoice_line_items.unit_price").
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(200);
      expect(isRejected(result.body), 'parent payload rejected (success=false)').toBe(true);
      expect(fieldErrors(result.body, 'unit_price').length, 'unit_price error on the nested line item').toBeGreaterThan(0);
      expect(lineItemCountByDesc(`${QA_DESC_PREFIX} nested-bad`), 'disallowed nested line item not persisted (no bypass)').toBe(0);
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Batched nested write rejected (success:false) — no bypass via the parent endpoint', persona: vendorPersona,
      method: 'PUT', url, requestBody: body, status: result.status, responseBody: result.body,
    });
  });

  test('override requested without permission is refused (same rejection shape as a mismatch; not an auth 403)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.Permissions6, TANGO_49_AC.OverrideAudit9] });
    const m = manifest!;
    const url = `${base}/subcontractor_invoice_line_items`;
    const submitted = m.scope.approved_rate + 40;
    const body = {
      line_items: {
        invoice_id: m.scope.invoice_targets.draft_invoice_id,
        product_id: m.scope.enforced_product.id,
        quantity: 1,
        unit_price: submitted,
        override_enforced_price: true,
        enforced_price_override_reason: 'QA attempt without permission',
        description: `${QA_DESC_PREFIX} override-denied`,
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: 'Vendor requests an override they are not permitted to make',
      persona: vendorPersona, method: 'POST', url, requestBody: body,
    });

    let result!: ApiResult;
    await test.step(`POST ${url} with override_enforced_price=true as a vendor lacking :can_override_enforced_pricing`, async () => {
      result = await apiSend(request, 'post', url, m.api_auth.vendor_token, body);
    });

    await test.step('Verify the override is refused (success=false + unit_price error), not an auth 403. NOTE: shipped behavior returns the SAME mismatch error as a plain rejection — there is no distinct override-denied code/signal', async () => {
      expect(result.status).not.toBe(403);
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(201);
      expect(isRejected(result.body), 'unpermitted override refused (success=false)').toBe(true);
      expect(fieldErrors(result.body, 'unit_price').length, 'refused via the standard unit_price mismatch error').toBeGreaterThan(0);
      expect(lineItemId(result.body), 'no line item persisted').toBeNull();
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Override refused for unprivileged vendor (success:false)', persona: vendorPersona,
      method: 'POST', url, requestBody: body, status: result.status, responseBody: result.body,
    });
  });

  test('authorized override with a reason is accepted and audited', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_49_AC.OverrideAudit9, TANGO_49_AC.Coverage14] });
    const m = manifest!;
    const url = `${base}/subcontractor_invoice_line_items`;
    const submitted = m.scope.approved_rate + 60;
    const reason = 'Client approved a one-off correction (QA override)';
    const body = {
      line_items: {
        invoice_id: m.scope.invoice_targets.draft_invoice_id,
        product_id: m.scope.enforced_product.id,
        quantity: 1,
        unit_price: submitted,
        override_enforced_price: true,
        enforced_price_override_reason: reason,
        description: `${QA_DESC_PREFIX} override-accept`,
      },
    };

    await renderExchange(testInfo, page, 'before', {
      title: `Authorized admin overrides the enforced rate to $${submitted} with a reason`,
      persona: adminPersona, method: 'POST', url, requestBody: body,
    });

    let result!: ApiResult;
    await test.step(`POST ${url} as admin (super_admin → override permitted) with override_enforced_price=true + reason`, async () => {
      result = await apiSend(request, 'post', url, m.api_auth.admin_token, body);
    });

    let createdId: number | null = null;
    await test.step('Verify the override is accepted (HTTP 201, success=true) and the overridden price persisted', async () => {
      expect(result.status, `body: ${JSON.stringify(result.body)}`).toBe(201);
      expect((result.body as any)?.success).toBe(true);
      createdId = lineItemId(result.body);
      expect(createdId, 'expected created line item id in response').toBeTruthy();
      expect(Number((result.body as any)?.line_items?.unit_price), 'persisted at the overridden price').toBeCloseTo(submitted, 2);
    });

    await test.step('Verify the override audit captures the reason + original (approved) vs accepted price (AC 9)', async () => {
      const audit = overrideAudit(createdId!);
      expect(audit.count, 'an override audit row was written').toBeGreaterThan(0);
      // Audit format: "…override by <user>: approved rate $Y, accepted rate $X. Reason: <reason>"
      expect(audit.comment, 'audit records the required reason string').toContain(reason);
      expect(audit.comment, 'audit records the accepted (override) price').toContain(String(Math.trunc(submitted)));
      expect(audit.comment, 'audit records the original approved rate').toContain(String(Math.trunc(m.scope.approved_rate)));
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Authorized override accepted + audited', persona: adminPersona,
      method: 'POST', url, requestBody: body, status: result.status, responseBody: result.body,
      note: `Override audit rows for line item ${createdId}: ${createdId ? overrideAudit(createdId).count : 'n/a'}`,
    });
  });

  test('model-layer guard covers the non-API-reachable cases (AC 4, 10, 12)', async ({ page }, testInfo) => {
    annotateAc(testInfo, {
      ticket: TICKET,
      ac: [TANGO_49_AC.EnforcementScope4, TANGO_49_AC.Edge10, TANGO_49_AC.Edge12, TANGO_49_AC.EnforcementConsistency5, TANGO_49_AC.Coverage14],
    });
    const m = manifest!;
    const checks = m.model_checks ?? [];

    await renderExchange(testInfo, page, 'before', {
      title: 'Model-layer enforcement checks (seed-verified)', persona: 'rails runner (model layer)',
      method: 'SEED', url: 'seeds/pricing-enforcement-api.rb',
      requestBody: { note: 'AC 4 / 10 / 12 are not reachable through the EV1 API; the seed exercises the before_save guard directly and records results in the manifest.', checks_recorded: checks.map(c => `AC${c.ac}`) },
    });

    await test.step('Verify the seed recorded all three model-layer checks', async () => {
      expect(checks.length, 'expected AC 4/10/12 checks in manifest.model_checks').toBeGreaterThanOrEqual(3);
    });
    for (const c of checks) {
      await test.step(`AC ${c.ac} — ${c.name}: ${c.detail}`, async () => {
        expect(c.passed, `AC ${c.ac} model check failed: ${c.detail}`).toBe(true);
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'Model-layer checks passed (AC 4 / 10 / 12)', persona: 'rails runner (model layer)',
      method: 'SEED', url: 'seeds/pricing-enforcement-api.rb',
      requestBody: { checks: checks.map(c => ({ ac: c.ac, passed: c.passed })) },
      status: 200,
      responseBody: checks,
    });
  });
});
