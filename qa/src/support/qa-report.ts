/**
 * Conventions and helpers for TANGO QA reports.
 *
 * Every test that appears in the standard QA report needs:
 *
 *   1. Ticket reference + AC clauses (verbatim text quoted from the ticket
 *      at the time the test was written) via `annotateAc(testInfo, { ... })`.
 *      Verbatim text is preserved so the report shows what AC was tested
 *      *at the time of the run* — useful when AC text drifts later.
 *
 *   2. `test.step()` wrappers around each meaningful user action. Step
 *      labels should spell out the INPUT VALUES being set (e.g.,
 *      `Fill: Name="[QA] ...", Product="Regular Rate", ...`) so someone
 *      reading the report can reproduce the test by hand.
 *
 *   3. Before/after `captureAcSnapshot(testInfo, page, ...)` calls
 *      bracketing the action that proves the acceptance criteria.
 *
 * Tests with no `test.step()` calls are dropped from the report — the
 * reporter requires at least one step to consider a test reproducible.
 */

import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import * as path from 'path';

/** A single AC clause: a short reference + the verbatim text from the ticket. */
export interface AcClause {
  /** Short reference, e.g., 'Expected Behavior #1'. */
  ref: string;
  /** Verbatim text from the ticket. Preserved as-typed (no Markdown). */
  text: string;
}

export interface AcAnnotation {
  /** Ticket key, e.g., 'TANGO-3'. */
  ticket: string;
  /** One or more AC clauses the test covers. */
  ac: AcClause[];
}

export const ANNOTATION_TICKET = 'ticket' as const;
export const ANNOTATION_AC     = 'ac'     as const;

/**
 * Mapping from Playwright project name to human-readable persona/role
 * description. Update when adding new auth roles to playwright.config.
 */
export const PERSONAS: Record<string, string> = {
  admin:              'Super Admin · bigbrother@fexa.io',
  vendor:             'Vendor / Subcontractor user · subcontractor_user3083@fexa.io',
  'facility-manager': 'Facility Manager · facility_manager1@fexa.io',
};

/**
 * Verbatim AC clauses for TANGO-2 (Expired pricing indicator in admin grid).
 * Captured directly from the ticket at the time tests were written.
 *
 * Markdown emphasis markers (** **, backticks) from the ticket source are
 * dropped to match the plain-text convention of the other AC constants;
 * wording, quotes, and em-dashes are otherwise preserved verbatim.
 *
 * AC deviation surfaced at test-write time: AC #2 reads "red tag", but the
 * shipped design (Caroline Lamb, 2026-04-29 comment: "updated colors to
 * match code") renders the Expired indicator as TAN (#D2B48C), not red —
 * alongside Active #90BF00 (yellow-green) and Inactive #999999. The
 * ExpectedBehavior2 scenario asserts the "Expired" tag's presence + text
 * (not the literal red color) and documents the rendered color, so the
 * test reflects the shipped behavior rather than failing on a stale AC word.
 *
 * Status field keys off effective_end_date (per Bryan's comment: PR #6901
 * moved from `end_date` to `effective_end_date`, matching the AC + model).
 *
 * Source: https://facilitiesexchange.atlassian.net/browse/TANGO-2
 */
export const TANGO_2_AC = {
  ExpectedBehavior1: {
    ref: 'Expected Behavior #1',
    text: 'New visual indicator in accountingpricinggrid on rows where effective_end_date < today AND effective_end_date IS NOT NULL',
  },
  ExpectedBehavior2: {
    ref: 'Expected Behavior #2',
    text: 'Indicator displays as a red tag reading "Expired" in the row.',
  },
  ExpectedBehavior3: {
    ref: 'Expected Behavior #3',
    text: 'New column "Pricing Effective Date Status" in the pricing grid showing: "Active", "Expired", or "Inactive" (where Inactive = active = false)',
  },
  ExpectedBehavior4: {
    ref: 'Expected Behavior #4',
    text: 'Grid filterable by status — admin can filter to show only expired pricings',
  },
  Edge1: {
    ref: 'Edge Case #5',
    text: 'Pricing with no effective_end_date is never marked expired',
  },
  Edge2: {
    ref: 'Edge Case #6',
    text: 'Pricing with effective_end_date = today is NOT expired (inclusive — per effective dates story AC #9)',
  },
  Edge3: {
    ref: 'Edge Case #7',
    text: 'Expired pricings remain visible in the grid — they are not hidden or deleted',
  },
} as const satisfies Record<string, AcClause>;

/**
 * Verbatim AC clauses for TANGO-3 (Pricing Overlap Warning). Captured
 * directly from the ticket at the time tests were written. Tests reference
 * these constants so the report always shows the exact AC text that the
 * scenario validated.
 *
 * Source: https://facilitiesexchange.atlassian.net/browse/TANGO-3
 */
export const TANGO_3_AC = {
  ExpectedBehavior1: {
    ref: 'Expected Behavior #1',
    text: 'On save of a pricing record (create or edit), system checks for other active pricings that match on the same scope dimensions: (Vendor + Class & Product)',
  },
  ExpectedBehavior2: {
    ref: 'Expected Behavior #2',
    text: 'If overlap found, show warning on save: "Other pricing(s) exist for this product and vendor scope. Are you sure you would like to continue and save?" — warning is non-blocking (admin can still save) CTA - Continue or Cancel.',
  },
  ExpectedBehavior2a: {
    ref: 'Expected Behavior #2a',
    text: 'The other pricings that are contradictory show in the alert',
  },
  Scope1: {
    ref: 'Scope of Overlap Check #1',
    text: 'Overlap = two or more pricings where active = true AND matching product_id AND matching role_id (or both role_id IS NULL for universal pricings) AND overlapping effective_start_date / effective_end_date date ranges (Vendor should match also)',
  },
  Scope2: {
    ref: 'Scope of Overlap Check #2',
    text: 'Pricings with non-overlapping effective date ranges are NOT flagged even if they share product/vendor scope',
  },
  Scope3: {
    ref: 'Scope of Overlap Check #3',
    text: 'Geographic and classification dimensions are not checked in MVP — a pricing for Vendor Y / Product X in Facility A and another for Vendor Y / Product X in Facility B WILL both be flagged as overlapping',
  },
  Edge1: {
    ref: 'Edge Case #1',
    text: 'Warning appears on both create and edit — if editing a pricing causes a new overlap, warn',
  },
  Edge2: {
    ref: 'Edge Case #2',
    text: 'Deleting or deactivating a pricing removes it from overlap calculations',
  },
  Edge3: {
    ref: 'Edge Case #3',
    text: 'Overlap check runs on save, not in real-time as fields are edited',
  },
} as const satisfies Record<string, AcClause>;

/**
 * Verbatim AC clauses for TANGO-4 (Enforcement toggle on pricing records).
 * Captured directly from the ticket. Ticket was in `failed qa` at QA-write
 * time due to AC #6 (inline validation copy / surface) — comments confirm
 * the fix shipped in PR #6916.
 *
 * Latest scope clarification from PM (michelle.klaer, 2026-05-21):
 *   "Flat rate and base price are the fields and values we care about
 *   for this change"
 *
 * Source: https://facilitiesexchange.atlassian.net/browse/TANGO-4
 */
export const TANGO_4_AC = {
  Expected1: {
    ref: 'Expected Behavior #1',
    text: 'New boolean field do_not_allow_price_modification on product_pricings (default: false)',
  },
  Expected2: {
    ref: 'Expected Behavior #2',
    text: 'Toggle appears in the Subcontractor Product Pricing side edit panel, below Base Price and Base Percent near the bottom of the page.',
  },
  Expected3: {
    ref: 'Expected Behavior #3',
    text: 'User-facing label: "Do not allow pricing to be modified"',
  },
  Expected4: {
    ref: 'Expected Behavior #4',
    text: 'Hover tooltip: "At invoicing, you can enforce prices on line items and allow/disallow modifications or overrides. Turning this on disallows price overrides"',
  },
  Expected5: {
    ref: 'Expected Behavior #5',
    text: 'Toggle only settable to true when the pricing can calculate a rate: pricing_type is set AND (base_price > 0 )',
  },
  Expected6: {
    ref: 'Expected Behavior #6',
    text: 'If admin attempts to enable on a pricing without a calculable rate, show inline validation: "Enforcement requires a pricing type with a base price or percent configured"',
  },
  Expected7: {
    ref: 'Expected Behavior #7',
    text: 'do_not_allow_price_modification is independent of active — a pricing can be active but unenforced, or inactive and previously enforced',
  },
  Expected8: {
    ref: 'Expected Behavior #8',
    text: 'When active = false, the toggle has no effect (inactive pricings excluded from matching regardless)',
  },
  Permissions1: {
    ref: 'Permissions #1',
    text: 'Only users with pricing admin permissions can edit the toggle',
  },
  Edge1: {
    ref: 'Edge Case #1',
    text: 'If admin enables the toggle then later clears base_price , show validation error on save: cannot have enforcement without a calculable rate',
  },
  Edge2: {
    ref: 'Edge Case #2',
    text: 'Bulk toggle via mass update (covered in mass update story)',
  },
} as const satisfies Record<string, AcClause>;

/**
 * Verbatim AC clauses for TANGO-5 (Lock rate field when enforcement is ON).
 * Captured directly from the ticket at the time tests were written.
 *
 * Implementation deviation discovered at test-write time: AC #7 ("Approved
 * Rate = $[amount] displays in the line item side edit panel pre filled and
 * uneditable") is satisfied by pre-filling the Approved Rate value INTO the
 * locked unit_price field itself rather than as a separate display element.
 * Functionally equivalent (pre-filled + uneditable). See the inline comment
 * near `applyUnitPriceEnforcement` in LineItemGrid.js.
 *
 * Source: https://facilitiesexchange.atlassian.net/browse/TANGO-5
 */
export const TANGO_5_AC = {
  Calculation1: {
    ref: 'Calculation #1',
    text: 'When vendor selects a product on a line item, system matches pricing via existing SubcontractorProductPricing.get_pricing() with full context (product_id, role_id, workorder_class_id, category_id, facility_id, geographic dimensions)',
  },
  Calculation2: {
    ref: 'Calculation #2',
    text: 'If matched pricing has do_not_allow_price_modification = true, calculate Approved Rate using Products::ProductPricing#evaluate_data()',
  },
  Calculation3: {
    ref: 'Calculation #3',
    text: 'Calculation follows existing pricing_type behavior (Flat Rate, Increase, Decrease) — no new calculation logic',
  },
  RateLocking1: {
    ref: 'Rate Locking #1',
    text: 'unit_price field in lineitemgrid is set to the calculated Approved Rate and made read-only (non-editable)',
  },
  RateLocking2: {
    ref: 'Rate Locking #2',
    text: 'Read-only field has visual treatment distinguishing it from editable fields-pre filled with grey disabled text',
  },
  RateLocking3: {
    ref: 'Rate Locking #3',
    text: 'Helper text displayed below the locked field: "This rate is enforced. Contact your client to request a change."',
  },
  RateLocking4: {
    ref: 'Rate Locking #4',
    text: '"Approved Rate = $[amount]" displays in the line item side edit panel pre filled and uneditable.',
  },
  Scope1: {
    ref: 'Scope #1',
    text: 'Applies to Invoices::SubcontractorInvoiceLineItem and Invoices::SubcontractorQuoteLineItem via shared lineitemgrid',
  },
  Scope2: {
    ref: 'Scope #2',
    text: 'Internal users (non-vendor) see the locked rate but are also restricted — enforcement applies to all users on vendor line items',
  },
  Edge1: {
    ref: 'Edge Case #1',
    text: "If vendor clears the product and re-selects, enforcement re-evaluates against the new product's pricing",
  },
  Edge2: {
    ref: 'Edge Case #2',
    text: 'If no pricing matches, rate field remains editable (enforcement only applies when a pricing with do_not_allow_price_modification = true is matched)',
  },
  Edge3: {
    ref: 'Edge Case #3',
    text: 'If matched pricing has do_not_allow_price_modification = false, this story does not apply — see reference rate story',
  },
  Edge4: {
    ref: 'Edge Case #4',
    text: "If the matched pricing's effective dates exclude this work order's completion date, the pricing is not matched and rate field remains editable",
  },
} as const satisfies Record<string, AcClause>;

/**
 * Verbatim AC clauses for TANGO-6 (Approved Rate as editable reference
 * when enforcement is OFF). Captured directly from the ticket.
 *
 * Source: https://facilitiesexchange.atlassian.net/browse/TANGO-6
 */
export const TANGO_6_AC = {
  Calculation1: {
    ref: 'Calculation #1',
    text: 'When vendor selects a product on a line item, system matches pricing via existing SubcontractorProductPricing.get_pricing() with full context',
  },
  Calculation2: {
    ref: 'Calculation #2',
    text: 'If matched pricing has do_not_allow_price_modification = false, calculate Approved Rate using Products::ProductPricing#evaluate_data()',
  },
  Calculation3: {
    ref: 'Calculation #3',
    text: 'Calculation follows existing pricing_type behavior — no new calculation logic',
  },
  Display1: {
    ref: 'Display #1',
    text: '"Approved Rate = $[amount]" displayed in highlighted box below the editable rate field in the line item side edit panel',
  },
  Display2: {
    ref: 'Display #2',
    text: 'unit_price field remains fully editable — vendor can enter any value',
  },
  Display3: {
    ref: 'Display #3',
    text: 'No warning or block when vendor enters a rate different from the Approved Rate (deviation flagging is visual only via Approved Rate column story)',
  },
  Scope1: {
    ref: 'Scope #1',
    text: 'Applies to Invoices::SubcontractorInvoiceLineItem and Invoices::SubcontractorQuoteLineItem via shared lineitemgrid',
  },
  Scope2: {
    ref: 'Scope #2',
    text: 'Internal users also see the Approved Rate on vendor line items',
  },
  Edge1: {
    ref: 'Edge Case #1',
    text: 'If no pricing matches, no reference rate displayed — field behaves as it does today',
  },
  Edge2: {
    ref: 'Edge Case #2',
    text: 'If vendor clears product and re-selects, reference rate recalculates',
  },
  Edge3: {
    ref: 'Edge Case #3',
    text: "Reference rate does not interact with discount_rate — discount applies to the vendor's entered unit_price, not the Approved Rate",
  },
} as const satisfies Record<string, AcClause>;

/**
 * Verbatim AC clauses for TANGO-44 (Add Vendor NTE to Assignments mass
 * manage + surface failure reasons). Captured directly from the ticket
 * at the time tests were written.
 *
 * Source: https://facilitiesexchange.atlassian.net/browse/TANGO-44
 */
export const TANGO_44_AC = {
  Functional1: {
    ref: 'Functional #1',
    text: 'The Vendor NTE column on the Assignments grid is wired into mass manage and appears in the field-selection panel labeled "Vendor NTE."',
  },
  Functional2: {
    ref: 'Functional #2',
    text: "The field accepts a numeric amount, interpreted in the vendor's currency for each selected Assignment.",
  },
  Functional3: {
    ref: 'Functional #3',
    text: "When Vendor NTE is selected and a value entered, applying the action enqueues a mass update that writes each Assignment's active Vendor NTE record. Existing currency-conversion logic handles vendor-currency input → canonical stored amount.",
  },
  Functional4: {
    ref: 'Functional #4',
    text: 'If Vendor NTE is not selected in the field panel, NTE is not touched (no incidental writes).',
  },
  Functional5: {
    ref: 'Functional #5',
    text: 'Updates respect all existing callbacks and validators on the Vendor NTE record. No bypass.',
  },
  Functional6: {
    ref: 'Functional #6',
    text: 'Audit trail records each NTE change per existing pattern.',
  },
  Permissions7: {
    ref: 'Permissions #7',
    text: 'The bulk update gates on the Vendor NTE update permission, not the Assignment update permission. A user with Assignment edit but no NTE edit cannot bulk-update NTE.',
  },
  Permissions8: {
    ref: 'Permissions #8',
    text: 'The per-record user-limit check (vendor_nte_amount cap) continues to run on top.',
  },
  AutoCreate9: {
    ref: 'Auto-create on missing #9',
    text: 'If Vendor NTE is selected and a value entered, Assignments with no active Vendor NTE record get a new active record created at the entered amount, subject to permission.',
  },
  AutoCreate10: {
    ref: 'Auto-create on missing #10',
    text: 'Workflow-status edge case: Assignments in a status configured to clear NTE  (bulk deleting/removing NTE)— engineering to validate whether auto-create still applies or these skip with reason "NTE cleared by workflow status." PM position: auto-create unless permission-denied (warn that all will be removed?)',
  },
  ReasonSurfacing11: {
    ref: 'Reason surfacing #11',
    text: 'The result email\'s failed-records section names the specific reason per record, not generic "Not permissed." Reasons covered at minimum:\n    - User vendor NTE limit exceeded\n    - NTE update permission denied\n    - Workflow restriction (e.g., pending approval)',
  },
  Edge12: {
    ref: 'Edge cases #12',
    text: 'Records where the new amount equals the current amount are reported as "skipped — no change" (not failed).',
  },
  Edge13: {
    ref: 'Edge cases #13',
    text: 'Batch size honors the existing mass update batch size site setting.',
  },
  Instrumentation14: {
    ref: 'Instrumentation #14',
    text: 'Each mass NTE run logs: user, run id, list id, count of selected, count of updated / skipped / failed, started/finished timestamps. Sufficient to track adoption vs. import-based NTE workflow.',
  },
} as const satisfies Record<string, AcClause>;

/**
 * Verbatim AC clauses for TANGO-10 (Enforcement fields for DW + invoice
 * table reporting). Captured directly from the ticket at the time tests
 * were written.
 *
 * This is a reporting / data-warehouse story. Several clauses are NOT
 * exercisable through the Fexa UI and are covered elsewhere:
 *   - #4 (Pricing Effective Date Status) is explicitly DW-only.
 *   - #9 (ETL → DW) is a warehouse concern.
 *   - #13-16 (backfill) are verified via a rails-runner data check baked
 *     into seeds/pricing-enforcement-reporting.rb (manifest `backfill`
 *     block), not the UI.
 *   - #17 is out of scope for the implementation.
 * The Playwright suite covers the UI-reportable clauses: #1-3 / #12
 * (Subcontractor Product Pricing reporting) and #5-8 / #10-11
 * (line-item fields on the Subcontractor [Invoice] Line Item and
 * Subcontractor Quote Line Item data sources).
 *
 * Label note: the reporting framework prefixes every column label with the
 * data source's COLUMN_PREFIX (e.g. "Subcontractor Product Pricing Pricing
 * Restricted", "Subcontractor Line Item Approved Rate"). The AC labels
 * ("Pricing Restricted", "Effective Start Date", …) are the suffix —
 * consistent with the existing columns on the same sources.
 *
 * Source: https://facilitiesexchange.atlassian.net/browse/TANGO-10
 */
export const TANGO_10_AC = {
  Pricing1: {
    ref: 'Pricing Fields #1',
    text: 'prevent_price_modification (boolean) available in DW pricing table AND Subcontractor Product Pricing reporting (label: "Pricing Restricted")',
  },
  Pricing2: {
    ref: 'Pricing Fields #2',
    text: 'effective_start_date (date) available in DW pricing table AND Subcontractor Product Pricing reporting (label: "Effective Start Date")',
  },
  Pricing3: {
    ref: 'Pricing Fields #3',
    text: 'effective_end_date (date) available in DW pricing table AND Subcontractor Product Pricing reporting (label: "Effective End Date")',
  },
  Pricing4: {
    ref: 'Pricing Fields #4',
    text: 'Derived field Pricing Effective Date Status ("Active", "Expired", "Inactive") available as DW-only computed column or view',
  },
  LineItem5: {
    ref: 'Line Item Fields #5',
    text: 'approved_rate (decimal): the Approved Rate from the pricing rule that matched at the moment the invoice/quote was approved. Snapshot is final per TANGO-1 AC #14.',
  },
  LineItem6: {
    ref: 'Line Item Fields #6',
    text: 'rate_deviation (boolean): true when unit_price != approved_rate. Covers both overcharges (vendor billed more than approved) and undercharges (vendor billed less than approved).',
  },
  LineItem7: {
    ref: 'Line Item Fields #7',
    text: 'rate_deviation_amount (decimal): unit_price - approved_rate. Positive values indicate overcharge, negative values indicate undercharge. UI should preserve sign in display.',
  },
  LineItem8: {
    ref: 'Line Item Fields #8',
    text: 'pricing_matched (boolean): whether a pricing rule was resolved for this line item.',
  },
  Scope9: {
    ref: 'Scope #9',
    text: 'ALL fields available in DW via existing ETL pipeline',
  },
  Scope10: {
    ref: 'Scope #10',
    text: 'Applies to SubcontractorInvoiceLineItem AND SubcontractorQuoteLineItem',
  },
  Scope11: {
    ref: 'Scope #11',
    text: 'Line item fields (#5–8) available in Fexa reporting on both data sources: Subcontractor Invoice Line Item AND Subcontractor Quote Line Item. Users can add as columns, filter, and sort.',
  },
  Scope12: {
    ref: 'Scope #12',
    text: 'Pricing-level fields (#1–3) available in Fexa Subcontractor Product Pricing reporting. Field #4 (Pricing Effective Date Status) is DW-only.',
  },
  Backfill13: {
    ref: 'Backfill #13',
    text: 'On enforcement feature launch, the system attempts to resolve the currently matching pricing rule for each historical line item.',
  },
  Backfill14: {
    ref: 'Backfill #14',
    text: 'Backfill is limited to line items on invoices/quotes in non-final states (draft, pending, approved-but-not-paid). Final-state records (paid, closed) preserve NULL to avoid retroactively re-stating audited financial records.',
  },
  Backfill15: {
    ref: 'Backfill #15',
    text: 'If a pricing rule matches: populate approved_rate from base_price, set pricing_matched = true, compute rate_deviation and rate_deviation_amount.',
  },
  Backfill16: {
    ref: 'Backfill #16',
    text: 'If no match: all four fields remain NULL.',
  },
  OutOfScope17: {
    ref: 'Out of Scope #17',
    text: 'Client Invoice Line Item and Client Quote Line Item are not modified by this story. Vendor pricing enforcement only.',
  },
} as const satisfies Record<string, AcClause>;

/**
 * Verbatim AC clauses for TANGO-49 (API-layer enforcement for pricing
 * modification + effective dates). Captured directly from the ticket at the
 * time tests were written.
 *
 * This is an API-only story (no Figma / no UI). Enforcement lives in
 * app/models/concerns/subcontractor_pricing_enforcement.rb (model-layer
 * before_save / before_validation guard raising EnforcedPricingViolation),
 * mapped to a structured 422 by the EV1/V1 api_controller.rb rescue_from.
 * Tests exercise the EV1 customer API directly with Doorkeeper bearer tokens
 * and render each request + response into the before/after report snapshots.
 *
 * Markdown emphasis markers (** **, backticks, _ _) from the ticket source
 * are dropped to match the plain-text convention of the other AC constants;
 * wording is otherwise preserved verbatim.
 *
 * Numbering note: the ticket has TWO clauses numbered "5" — one under
 * "Enforcement scope" (API docs) and one under "Enforcement consistency"
 * (model-layer guard). The refs below disambiguate by section.
 *
 * Source: https://facilitiesexchange.atlassian.net/browse/TANGO-49
 */
export const TANGO_49_AC = {
  EnforcementScope1: {
    ref: 'Enforcement scope #1',
    text: 'This impacts EV1 - our customer facing API',
  },
  EnforcementScope2: {
    ref: 'Enforcement scope #2',
    text: 'API writes to unit_price on Invoices::SubcontractorInvoiceLineItem and Invoices::SubcontractorQuoteLineItem are rejected when the matched pricing has prevent_price_modification = true and the submitted price does not equal Products::ProductPricing.evaluate_data output.',
  },
  EnforcementScope3: {
    ref: 'Enforcement scope #3',
    text: 'The same guard applies to nested writes through SubcontractorInvoice / SubcontractorQuote create + update payloads (so vendors cannot side-step via the parent endpoint).',
  },
  EnforcementScope4: {
    ref: 'Enforcement scope #4',
    text: "Effective-date guard on client-supplied pricing references: TANGO-1 already filters out-of-window pricings from the matching path (via subcontractor_product_pricing.rb:423-424). This story closes the remaining hole. When an API caller explicitly passes a pricing_id whose effective_start_date / effective_end_date excludes the work order's completed date (fallback: created_at), the write is rejected rather than silently honored.",
  },
  EnforcementScope5: {
    ref: 'Enforcement scope #5',
    text: 'Update API documentation as well.',
  },
  EnforcementConsistency5: {
    ref: 'Enforcement consistency #5',
    text: 'Guard fires at the model layer (before_save on the line item) so every write path is covered: controllers, Sidekiq jobs, imports, mass updates, console. Not just the API controller. The API controller returns a clean 422 when the model guard rejects.',
  },
  Permissions6: {
    ref: 'Permissions #6',
    text: 'A vendor user with no override permission receives 422 with the structured payload from AC 7, not a 403 (auth is fine; the value is rejected).',
  },
  VendorExperience7: {
    ref: 'Vendor experience #7',
    text: 'API error response includes a structured payload: error code, the offending field, the matched pricing\'s Approved Rate, and a human-readable message ("This rate is enforced by your client. Submitted rate $X does not match approved rate $Y.").',
  },
  VendorExperience8: {
    ref: 'Vendor experience #8',
    text: 'If no enforced pricing matches, write proceeds as today (no behavior change).',
  },
  OverrideAudit9: {
    ref: 'Override + audit #9',
    text: 'An authorized override path exists (Finance/CS role, TBD by Eng) so support can correct legitimate edge cases; every override is audited with user, timestamp, original vs. accepted price, and a required reason string.',
  },
  Edge10: {
    ref: 'Edge cases #10',
    text: 'Writes against an already-approved or completed invoice are not re-evaluated: rate at time of approval is final (matches TANGO-1 AC 14). Re-evaluation only applies to invoices in draft or pending status.',
  },
  Edge11: {
    ref: 'Edge cases #11',
    text: 'Bulk and import writes (e.g., subcontractor invoice bundles via api/v1/subcontractor_invoice_bundles_controller.rb, V2 imports per TANGO-9) fire the same guard. No bypass via batched payloads.',
  },
  Edge12: {
    ref: 'Edge cases #12',
    text: 'If the matched pricing\'s prevent_price_modification is toggled mid-edit, the guard uses pricing state at write time, not at read/match time.',
  },
  Reporting13: {
    ref: 'Reporting coordination #13',
    text: "Override events written by AC 9 must be visible to TANGO-10's enforcement reporting fields (DW + invoice table). Coordinate column shape with Kevin during grooming so this story doesn't ship audit data the warehouse can't see.",
  },
  Coverage14: {
    ref: 'Coverage #14',
    text: 'Request specs cover: enforced + matching price (accept), enforced + mismatched price (reject), enforced + out-of-window pricing_id (reject), unenforced pricing (accept any price), nested parent write (reject), bundle/import write (reject), already-approved invoice (no re-eval), and override path (accept + audit row written).',
  },
} as const satisfies Record<string, AcClause>;

/**
 * Attach ticket + AC metadata to the running test. The reporter parses
 * these annotations to group tests by ticket and render the verbatim AC.
 *
 * The AC clauses are JSON-encoded into a single annotation so multiple
 * clauses round-trip cleanly through Playwright's annotation system.
 */
export function annotateAc(testInfo: TestInfo, { ticket, ac }: AcAnnotation): void {
  testInfo.annotations.push({ type: ANNOTATION_TICKET, description: ticket });
  testInfo.annotations.push({ type: ANNOTATION_AC,     description: JSON.stringify(ac) });
}

export interface AcSnapshotOptions {
  /**
   * Locator for the element that proves the acceptance criterion. The
   * helper asserts this element is visible (test FAILS if not) and scrolls
   * it into view before the screenshot — so the captured viewport image
   * always contains evidence of the AC.
   *
   * The screenshot itself is ALWAYS the full viewport at its natural size
   * — the focus locator is only used to (a) assert visibility and (b)
   * scroll the element into view. We never crop or zoom around the focus,
   * because cropped screenshots strip away surrounding context that's
   * useful when reading the report.
   */
  focus?: Locator;
  /**
   * Optional Locator to crop the screenshot to. Use this only when you
   * genuinely want a tight, element-bounded capture (e.g. an isolated
   * modal). Most tests should leave this unset and rely on the viewport
   * screenshot with `focus` scrolling.
   *
   * Default: unset — capture the full viewport.
   */
  container?: Locator;
  /**
   * Optional short label rendered as the caption of this snapshot in the
   * report ("Form opened", "Class set to Labor", "Rate locked at $150"…).
   *
   * When set, multiple captures per `moment` are allowed and rendered as an
   * ordered sequence within the corresponding Before/After section. The
   * underlying Playwright attachment is named
   * `ac-snapshot-{moment}:{label}` and the reporter splits on the first
   * colon — so the label may contain spaces and most punctuation, but NOT
   * the `:` character.
   *
   * When omitted, the legacy single-snapshot path is used (attachment name
   * `ac-snapshot-{moment}`). Existing specs that don't pass a label are
   * unaffected.
   */
  label?: string;
}

/**
 * Capture an "AC-relevant" screenshot and attach it to the test. The reporter
 * picks these up by attachment name and inlines them as base64 in the HTML.
 *
 * - 'before' = state just prior to the AC-relevant action
 * - 'after'  = state just after the assertion fires
 *
 * Pass `options.focus` with a Locator for the element that proves the AC.
 * The helper will (a) assert it's visible and (b) scroll it into view, then
 * (c) capture the FULL viewport at its natural size. The focus element is
 * never used to crop the image — cropping strips out context that's useful
 * for reading the report. If a tight crop is genuinely needed, pass an
 * explicit `container` locator.
 *
 * Pass `options.label` to capture multiple snapshots per moment. Each
 * labeled call appears in the report in invocation order, with the label
 * as its caption. Labels are useful for showing a sequence of meaningful
 * UI states (form opened, value entered, lock applied, …) rather than just
 * a single before/after pair. Unlabeled calls keep the legacy behavior.
 */
export async function captureAcSnapshot(
  testInfo: TestInfo,
  page: Page,
  moment: 'before' | 'after',
  options?: AcSnapshotOptions,
): Promise<void> {
  const labelRaw = options?.label?.trim();
  if (labelRaw && labelRaw.includes(':')) {
    throw new Error(
      `captureAcSnapshot: label must not contain ':' (got ${JSON.stringify(labelRaw)}). ` +
      `The reporter splits the attachment name on the first colon to extract the label.`,
    );
  }
  // Playwright derives the attachment's on-disk filename from the attachment
  // NAME (slugified + hash-suffixed). macOS APFS and most Linux filesystems
  // cap a single path component at 255 bytes. Labels over ~120 chars push the
  // generated filename past that limit (ENAMETOOLONG). Enforce the cap here
  // with a clear error so the test author fixes the label, not a mystery
  // copyfile failure mid-run.
  const MAX_LABEL_LEN = 120;
  if (labelRaw && labelRaw.length > MAX_LABEL_LEN) {
    throw new Error(
      `captureAcSnapshot: label too long (${labelRaw.length} chars, max ${MAX_LABEL_LEN}). ` +
      `Labels appear in Playwright attachment names which become on-disk filenames; the OS rejects components over 255 bytes. ` +
      `Tighten the wording. Got: ${JSON.stringify(labelRaw.slice(0, 80) + '…')}`,
    );
  }

  const attachmentName = labelRaw
    ? `ac-snapshot-${moment}:${labelRaw}`
    : `ac-snapshot-${moment}`;

  // Filename slug — keep the moment + label readable on disk, and append an
  // ordinal derived from how many same-moment labeled captures already exist
  // on this test. Guarantees uniqueness even if two captures share a label.
  //
  // Cap the slug aggressively: Playwright also appends a content-hash to the
  // attachment path on its side. macOS APFS (and most Linux filesystems) cap
  // a single path component at 255 bytes, and we've seen labels in the
  // 200-char range push past that limit. 50 chars of label is plenty to
  // disambiguate; the full label is preserved in the attachment NAME and
  // surfaced verbatim in the report.
  const MAX_LABEL_SLUG_LEN = 50;
  const labelSlugRaw = labelRaw
    ? labelRaw.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
    : '';
  const labelSlug = labelSlugRaw.slice(0, MAX_LABEL_SLUG_LEN).replace(/-+$/, '');
  const sameMomentCount = labelRaw
    ? testInfo.attachments.filter((a) => a.name.startsWith(`ac-snapshot-${moment}:`)).length
    : 0;
  const fileSlug = labelRaw
    ? `ac-snapshot-${moment}-${sameMomentCount + 1}-${labelSlug || 'step'}`
    : `ac-snapshot-${moment}`;
  const outPath = testInfo.outputPath(`${fileSlug}.png`);

  try {
    if (options?.focus) {
      // Real assertion — if the focus element isn't visible, the test fails
      // here rather than producing a misleading screenshot.
      await expect(options.focus, `AC focus element must be visible at "${moment}" snapshot${labelRaw ? ` (label: ${labelRaw})` : ''}`).toBeVisible({ timeout: 5_000 });
      await options.focus.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await page.waitForTimeout(300);   // small settle for any post-scroll layout
    }

    if (options?.container) {
      // Explicit container — caller wants an element-bounded crop. Keep the
      // viewport for downstream tests; only the screenshot is bounded.
      await options.container.screenshot({
        path: outPath,
        animations: 'disabled',
        caret: 'hide',
        timeout: 10_000,
      });
    } else {
      // Default — full viewport at natural size. Focus (if any) has already
      // been scrolled into view, so the AC-relevant element is guaranteed
      // to be in-frame without zooming or cropping.
      await page.screenshot({
        path: outPath,
        animations: 'disabled',
        caret: 'hide',
        timeout: 10_000,
      });
    }
    await testInfo.attach(attachmentName, { path: outPath, contentType: 'image/png' });
  } catch (err) {
    await testInfo.attach(`${attachmentName}-error`, {
      body: `Screenshot capture failed: ${(err as Error).message}`,
      contentType: 'text/plain',
    });
    // Re-throw so the test fails cleanly when the AC focus isn't visible.
    if (options?.focus) throw err;
  }
}

/** Helper to build a clickable ticket URL from a ticket key. */
export function ticketUrl(ticket: string): string {
  const base = process.env.QA_TICKET_BASE_URL || 'https://facilitiesexchange.atlassian.net/browse';
  return `${base}/${ticket}`;
}

export function reportOutputDir(): string {
  return process.env.QA_REPORT_DIR || path.resolve(process.cwd(), 'reports');
}
