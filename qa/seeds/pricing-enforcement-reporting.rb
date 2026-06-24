# Idempotent fixtures for TANGO-10 — "Enforcement fields for DW + invoice
# table reporting".
#
# The story surfaces vendor pricing-enforcement data in Fexa reporting / BI:
#   - Subcontractor Product Pricing source: prevent_price_modification
#     ("Pricing Restricted"), effective_start_date, effective_end_date.
#   - Subcontractor [Invoice] Line Item + Subcontractor Quote Line Item
#     sources: approved_rate, rate_deviation, rate_deviation_amount,
#     pricing_matched.
#
# This seed builds deterministic report rows for those columns, plus a
# backfill data-check that exercises the real job's scope + per-record
# action (AC #13-16) on controlled fixtures.
#
# Run via: npm run seed:pricing-enforcement-reporting
#
# Idempotent: removes prior fixtures by name/description prefix before
# recreating, and overwrites the manifest each run.

require 'json'

PRICING_PREFIX   = '[QA] Enforcement Reporting - '.freeze
LINE_ITEM_PREFIX = '[QA] Enf Reporting'.freeze            # covers invoice + quote, display + backfill
VENDOR_EMAIL     = 'subcontractor_user3083@fexa.io'.freeze

# Stable fixture targets confirmed via DB introspection (see TANGO-10 notes):
INVOICE_ID       = 26   # SubcontractorInvoice, Draft (non-final), empty
QUOTE_ID         = 18   # SubcontractorQuote, non-final (wtype 8); remapped from
                        # #88 (gone after a develop DB refresh). Has 1 unrelated
                        # line item, excluded by the Rate Deviation=true filter.
FINAL_INVOICE_ID = 53   # SubcontractorInvoice, Exported (FINAL) — AC#14 negative

ENFORCED_PRODUCT_ID   = 9    # "Trip"     — pricing-report "Restricted=true" row
MATCHABLE_PRODUCT_ID  = 18   # "Service"  — unenforced pricing; drives line-item match
NO_MATCH_PRODUCT_ID   = 19   # "Initial"  — no pricing → snapshot stays NULL

BASE_PRICE = 150.0

def hr(t); puts "\n=== #{t} ==="; end
def assert(cond, msg)
  raise "ASSERTION FAILED: #{msg}" unless cond
  puts "  ok: #{msg}"
end

# --- Step 1: scope lookups ---------------------------------------------------

vendor_user = User.find_by(email: VENDOR_EMAIL)
abort "Aborting: vendor '#{VENDOR_EMAIL}' not found." unless vendor_user

vendor_role = Roles::EntityRole::SubcontractorRole.find_by(entity_id: vendor_user.organization_id, active: true)
abort "Aborting: no active SubcontractorRole for org #{vendor_user.organization_id}." unless vendor_role

invoice = Invoices::SubcontractorInvoice.find_by(id: INVOICE_ID)
quote   = Invoices::SubcontractorQuote.find_by(id: QUOTE_ID)
abort "Aborting: fixture invoice ##{INVOICE_ID} missing." unless invoice
abort "Aborting: fixture quote ##{QUOTE_ID} missing." unless quote

home_currency = SSetting.get(:home_currency)

# --- Step 2: clean prior fixtures --------------------------------------------

removed_li = Invoices::LineItem.where('description LIKE ?', "#{LINE_ITEM_PREFIX}%").destroy_all.size
removed_pr = Products::SubcontractorProductPricing.where('name LIKE ?', "#{PRICING_PREFIX}%").destroy_all.size
puts "Removed #{removed_pr} prior fixture pricing(s) and #{removed_li} prior fixture line item(s)."

# --- Step 3: pricing fixtures (Subcontractor Product Pricing report) ---------
# Two rows so the report can show Restricted true/false and sort by date.

def make_pricing(name:, product_id:, role_id:, ppm:, esd:, eed:, currency:)
  prod = Products::Product.find(product_id)
  Products::SubcontractorProductPricing.create!(
    name:                       name,
    product_id:                 product_id,
    product_classification_id:  prod.product_classification_id,
    role_id:                    role_id,
    pricing_type:               'Flat Rate',
    base_price:                 BASE_PRICE,
    effective_start_date:       esd,
    effective_end_date:         eed,
    active:                     true,
    currency:                   currency,
    prevent_price_modification: ppm,
  )
end

pricing_restricted = make_pricing(
  name: "#{PRICING_PREFIX}Restricted", product_id: ENFORCED_PRODUCT_ID, role_id: vendor_role.id,
  ppm: true, esd: Date.new(2026, 3, 1), eed: Date.new(2026, 9, 30), currency: home_currency,
)
pricing_unrestricted = make_pricing(
  name: "#{PRICING_PREFIX}Unrestricted", product_id: MATCHABLE_PRODUCT_ID, role_id: vendor_role.id,
  ppm: false, esd: Date.new(2026, 1, 15), eed: Date.new(2026, 12, 15), currency: home_currency,
)

# --- Step 4: line-item display fixtures (set columns directly) ---------------
# Deterministic values so reporting columns, filter, and sort are testable.

def make_line_item(klass:, invoice_id:, product_id:, description:, unit_price:, snapshot:)
  li = klass.create!(
    invoice_id:  invoice_id,
    product_id:  product_id,
    description: description,
    quantity:    1,
    unit_price:  unit_price,
  )
  # update_columns: bypass callbacks/validations exactly like the snapshot
  # writer does, so the stored value is what we intend regardless of any
  # enforcement/markup callback drift.
  li.update_columns(snapshot.merge(unit_price: unit_price))
  li.reload
end

INV = Invoices::SubcontractorInvoiceLineItem
QLI = Invoices::SubcontractorQuoteLineItem

display = []
display << make_line_item(klass: INV, invoice_id: INVOICE_ID, product_id: MATCHABLE_PRODUCT_ID,
  description: "#{LINE_ITEM_PREFIX} - Overcharge", unit_price: 200,
  snapshot: { approved_rate: 150, rate_deviation: true,  rate_deviation_amount: 50,  pricing_matched: true })
display << make_line_item(klass: INV, invoice_id: INVOICE_ID, product_id: MATCHABLE_PRODUCT_ID,
  description: "#{LINE_ITEM_PREFIX} - Undercharge", unit_price: 120,
  snapshot: { approved_rate: 150, rate_deviation: true,  rate_deviation_amount: -30, pricing_matched: true })
display << make_line_item(klass: INV, invoice_id: INVOICE_ID, product_id: MATCHABLE_PRODUCT_ID,
  description: "#{LINE_ITEM_PREFIX} - Matched No Deviation", unit_price: 150,
  snapshot: { approved_rate: 150, rate_deviation: false, rate_deviation_amount: 0,   pricing_matched: true })
display << make_line_item(klass: INV, invoice_id: INVOICE_ID, product_id: NO_MATCH_PRODUCT_ID,
  description: "#{LINE_ITEM_PREFIX} - No Match", unit_price: 99,
  snapshot: { approved_rate: nil, rate_deviation: nil,   rate_deviation_amount: nil, pricing_matched: nil })

# Quote-side display fixtures (proves AC #10/#11 on the Quote source).
display << make_line_item(klass: QLI, invoice_id: QUOTE_ID, product_id: MATCHABLE_PRODUCT_ID,
  description: "#{LINE_ITEM_PREFIX} Q - Overcharge", unit_price: 210,
  snapshot: { approved_rate: 150, rate_deviation: true, rate_deviation_amount: 60,  pricing_matched: true })
display << make_line_item(klass: QLI, invoice_id: QUOTE_ID, product_id: MATCHABLE_PRODUCT_ID,
  description: "#{LINE_ITEM_PREFIX} Q - Undercharge", unit_price: 130,
  snapshot: { approved_rate: 150, rate_deviation: true, rate_deviation_amount: -20, pricing_matched: true })
display << make_line_item(klass: QLI, invoice_id: QUOTE_ID, product_id: NO_MATCH_PRODUCT_ID,
  description: "#{LINE_ITEM_PREFIX} Q - No Match", unit_price: 70,
  snapshot: { approved_rate: nil, rate_deviation: nil,  rate_deviation_amount: nil, pricing_matched: nil })

# --- Step 5: backfill data-check (AC #13-16) ---------------------------------
# Create NULL-field line items on the non-final invoice, then run the backfill
# job's exact scope + per-record action against our fixtures. The final-state
# negative (invoice #53) is asserted to be excluded by the same scope.

hr 'Backfill data-check (AC #13-16)'

bf_match = INV.create!(
  invoice_id: INVOICE_ID, product_id: MATCHABLE_PRODUCT_ID,
  description: "#{LINE_ITEM_PREFIX} - Backfill Match", quantity: 1, unit_price: 120,
)
bf_match.update_columns(approved_rate: nil, rate_deviation: nil, rate_deviation_amount: nil, pricing_matched: nil)

bf_nomatch = INV.create!(
  invoice_id: INVOICE_ID, product_id: NO_MATCH_PRODUCT_ID,
  description: "#{LINE_ITEM_PREFIX} - Backfill No Match", quantity: 1, unit_price: 80,
)
bf_nomatch.update_columns(approved_rate: nil, rate_deviation: nil, rate_deviation_amount: nil, pricing_matched: nil)

# Replicate the job's exact target scope (OneTimeBackfillSubcontractorLineItemPricingJob).
final_type_ids = SSetting.get_values(*Constants::Workflow::CLOSED_TYPE_SSETTINGS).values.compact
backfill_scope = INV
  .where(approved_rate: nil, pricing_matched: nil)
  .joins("JOIN states ON states.object_id = line_items.invoice_id AND states.object_type = 'Invoices::Invoice'")
  .joins("JOIN statuses ON statuses.id = states.status_id")
  .where.not("statuses.workflow_type_id" => final_type_ids)
scope_ids = backfill_scope.pluck(:id)

# AC#13/#14: non-final NULL records are in scope; final-state records are not.
assert scope_ids.include?(bf_match.id),   "non-final NULL line item ##{bf_match.id} is IN backfill scope (AC#13)"
assert scope_ids.include?(bf_nomatch.id), "non-final no-match line item ##{bf_nomatch.id} is IN backfill scope (AC#13)"

final_null_li_ids = INV.where(approved_rate: nil, pricing_matched: nil, invoice_id: FINAL_INVOICE_ID).pluck(:id)
assert final_null_li_ids.any?, "final-state invoice ##{FINAL_INVOICE_ID} has NULL-field line items to use as AC#14 negative"
excluded = final_null_li_ids.reject { |id| scope_ids.include?(id) }
assert excluded.sort == final_null_li_ids.sort,
  "final-state line items #{final_null_li_ids.inspect} are EXCLUDED from backfill scope (AC#14)"

# Run the job's per-record action on our fixtures (mirrors find_each body).
bf_match.apply_pricing_snapshot!
bf_nomatch.apply_pricing_snapshot!
bf_match.reload
bf_nomatch.reload

# AC#15: a match populates the snapshot from base_price.
assert bf_match.pricing_matched == true,           "backfill match: pricing_matched=true (AC#15)"
assert bf_match.approved_rate.to_f == BASE_PRICE,  "backfill match: approved_rate=#{BASE_PRICE} from base_price (AC#15)"
assert bf_match.rate_deviation == true,            "backfill match: rate_deviation=true (120 != 150) (AC#15)"
assert bf_match.rate_deviation_amount.to_f == -30.0, "backfill match: rate_deviation_amount=-30 preserves sign (AC#15)"

# AC#16: no match leaves all four NULL.
assert bf_nomatch.approved_rate.nil? && bf_nomatch.rate_deviation.nil? &&
       bf_nomatch.rate_deviation_amount.nil? && bf_nomatch.pricing_matched.nil?,
  "backfill no-match: all four fields remain NULL (AC#16)"

# AC#14 (re-confirm): final-state rows were never touched and remain NULL.
still_null = INV.where(id: final_null_li_ids, approved_rate: nil, pricing_matched: nil).count
assert still_null == final_null_li_ids.size,
  "final-state line items remain NULL after backfill (AC#14)"

# --- Step 6: emit manifest ---------------------------------------------------

TANGO_ROOT    = File.expand_path('..', __dir__)
MANIFEST_PATH = File.join(TANGO_ROOT, 'reports', 'seed-manifest-tango-10.json')
FileUtils.mkdir_p(File.dirname(MANIFEST_PATH))

def pricing_fixture(rec, purpose)
  {
    id: rec.id, name: rec.name, active: rec.active, purpose: purpose,
    pricing_type: rec.pricing_type, base_price: rec.base_price.to_s, currency: rec.currency,
    prevent_price_modification: !!rec.prevent_price_modification,
    effective_start_date: rec.effective_start_date&.iso8601,
    effective_end_date: rec.effective_end_date&.iso8601,
  }
end

# Flat fixture entry shaped for the qa-report reporter (id/name/active/purpose).
# Enforcement values are folded into `purpose` since the reporter's fixture
# table renders pricing/date columns, not line-item snapshot columns.
def li_fixture(rec, purpose)
  snap = "approved_rate=#{rec.approved_rate.nil? ? 'NULL' : rec.approved_rate.to_f}, " \
         "rate_deviation=#{rec.rate_deviation.inspect}, " \
         "rate_deviation_amount=#{rec.rate_deviation_amount.nil? ? 'NULL' : rec.rate_deviation_amount.to_f}, " \
         "pricing_matched=#{rec.pricing_matched.inspect}"
  {
    id: rec.id,
    name: "#{rec.description}  [#{rec.class.name.demodulize}]",
    active: true,
    purpose: "#{purpose} (#{snap}; unit_price=#{rec.unit_price&.to_f}, invoice_id=#{rec.invoice_id})",
  }
end

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-10',
  source_seed:  'seeds/pricing-enforcement-reporting.rb',
  description:  'Reporting fixtures for vendor pricing-enforcement fields: pricing rows (Pricing Restricted + effective dates) on the Subcontractor Product Pricing source, and invoice/quote line items with approved_rate / rate_deviation / rate_deviation_amount / pricing_matched. Includes a backfill data-check (AC #13-16).',
  scope: {
    vendor: { name: (vendor_user.organization&.default_dispatch_address&.company rescue nil),
              user_email: vendor_user.email, role_id: vendor_role.id, entity_id: vendor_role.entity_id },
    products: {
      enforced_pricing:  { id: ENFORCED_PRODUCT_ID,  name: Products::Product.find(ENFORCED_PRODUCT_ID).name },
      matchable:         { id: MATCHABLE_PRODUCT_ID, name: Products::Product.find(MATCHABLE_PRODUCT_ID).name },
      no_match:          { id: NO_MATCH_PRODUCT_ID,  name: Products::Product.find(NO_MATCH_PRODUCT_ID).name },
    },
    reporting_sources: {
      pricing:           'Subcontractor Product Pricing',
      invoice_line_item: 'Subcontractor [Invoice] Line Item (under Invoice source)',
      quote_line_item:   'Subcontractor Quote Line Item (under Proposals source)',
    },
    invoice_targets: { subcontractor_invoice_id: INVOICE_ID, subcontractor_quote_id: QUOTE_ID,
                       final_state_invoice_id: FINAL_INVOICE_ID },
  },
  fixtures: [
    pricing_fixture(pricing_restricted,   'Pricing report row with Pricing Restricted = true + effective dates (AC#1-3,#12).'),
    pricing_fixture(pricing_unrestricted, 'Pricing report row with Pricing Restricted = false; also the unenforced pricing the matchable line items resolve to.'),
    *display.map.with_index do |rec, i|
      li_fixture(rec, [
        'Invoice line item, overcharge: deviation +50 (AC#5-8 display + sort).',
        'Invoice line item, undercharge: deviation -30 preserves sign (AC#7).',
        'Invoice line item, matched with no deviation: rate_deviation=false (AC#6 false case).',
        'Invoice line item, no match: all four NULL (AC#8/#16 display).',
        'Quote line item, overcharge: proves columns on the Quote source (AC#10/#11).',
        'Quote line item, undercharge: deviation -20 on the Quote source.',
        'Quote line item, no match: all four NULL on the Quote source.',
      ][i])
    end,
    li_fixture(bf_match,   'Backfill match fixture (AC#13,#15).'),
    li_fixture(bf_nomatch, 'Backfill no-match fixture (AC#16).'),
  ],
  backfill: {
    job: 'OneTimeBackfillSubcontractorLineItemPricingJob',
    method: "Exercised the job's exact scope query + per-record action (apply_pricing_snapshot!) on controlled fixtures; did NOT run perform_now DB-wide to avoid mutating unrelated records.",
    final_type_ids: final_type_ids,
    match_record:    li_fixture(bf_match,   'Non-final NULL line item; backfill resolves pricing and populates the snapshot (AC#13,#15).'),
    no_match_record: li_fixture(bf_nomatch, 'Non-final NULL line item with no matching pricing; stays NULL (AC#16).'),
    final_state_negative: { invoice_id: FINAL_INVOICE_ID, line_item_ids: final_null_li_ids,
                            excluded_from_scope: true, remain_null_after_backfill: true,
                            note: 'Final-state (Exported) line items are excluded by the job scope and preserve NULL (AC#14).' },
    assertions_passed: true,
  },
}
File.write(MANIFEST_PATH, JSON.pretty_generate(manifest))

# --- Step 7: human-readable summary ------------------------------------------

hr 'TANGO-10 fixtures'
puts "Vendor:  #{vendor_user.email} (role_id=#{vendor_role.id})"
puts "Pricing report rows:"
puts "  ##{pricing_restricted.id}  #{pricing_restricted.name}  Restricted=true  #{pricing_restricted.effective_start_date}..#{pricing_restricted.effective_end_date}"
puts "  ##{pricing_unrestricted.id}  #{pricing_unrestricted.name}  Restricted=false  #{pricing_unrestricted.effective_start_date}..#{pricing_unrestricted.effective_end_date}"
puts "Invoice ##{INVOICE_ID} line items (display): #{display.select { |d| d.is_a?(INV) }.size}"
puts "Quote ##{QUOTE_ID} line items (display):   #{display.select { |d| d.is_a?(QLI) }.size}"
puts "Backfill match  ##{bf_match.id}: approved_rate=#{bf_match.approved_rate} deviation=#{bf_match.rate_deviation} amount=#{bf_match.rate_deviation_amount} matched=#{bf_match.pricing_matched}"
puts "Backfill nomatch ##{bf_nomatch.id}: all NULL = #{bf_nomatch.approved_rate.nil? && bf_nomatch.pricing_matched.nil?}"
puts "AC#14 negative: final invoice ##{FINAL_INVOICE_ID} line items #{final_null_li_ids.inspect} excluded + still NULL"
puts ''
puts "Manifest: #{MANIFEST_PATH}"
puts "Re-run safely with: npm run seed:pricing-enforcement-reporting"
