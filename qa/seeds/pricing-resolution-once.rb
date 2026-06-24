# Idempotent fixtures + model-layer instrumentation for TANGO-58.
#
# TANGO-58 (Bug): on CREATE of an Invoices::SubcontractorInvoiceLineItem, two
# before_validation callbacks each resolved Products::SubcontractorProductPricing
# .get_pricing (the PermutationRankable CTE). Kevin's fix (PR #7017, merged into
# develop 2026-06-17) routes set_unit_price through the enforcement memo and
# replaces the dirty-tracking cache reset with a product-staleness check, so a
# create resolves pricing AT MOST ONCE.
#
# The AC are query-count / model-behavior assertions, so the core proof is done
# HERE, at the model layer, exactly the way the AC says it is "verifiable via SQL
# log or method-call instrumentation": this seed stands up the real
# invoice/assignment/pricing graph and counts actual executions of the pricing
# CTE (`WITH any_matches ... from product_pricings`) via sql.active_record
# notifications during a REAL `create!`, for four scenarios. Results land in the
# manifest's `model_checks` block, which the spec asserts + renders.
#
# Independent of Kevin's own test harness (test/.../*_pricing_query_count_test.rb):
# this is a from-scratch counter run against the dev DB, not his Minitest fixtures.
#
# Each instrumented create runs inside a rolled-back transaction, so nothing
# persists — the dev DB is left clean apart from the one persistent UI fixture.
#
# UI track (admin, Ext grid): one persistent locked pricing on the real demo
# product "Holiday Rate" (proven selectable by the TANGO-5 suite; currently has
# zero vendor pricings, so the match is unambiguous) drives AC #3 — the rate
# auto-fills + locks in the line-item form, and a tampered save is forced back to
# the approved rate server-side.
#
# Run via: npm run seed:pricing-resolution-once

require 'json'

PREFIX        = '[QA] TANGO-58'.freeze
VENDOR_EMAIL  = 'subcontractor_user3083@fexa.io'.freeze
INVOICE_ID    = 24                      # SubcontractorInvoice payable_to the vendor role, has assignment+WO
UI_PRODUCT    = 'Holiday Rate'.freeze   # real demo product, classification "Labor" (id 1), 0 prior pricings
LABOR_CLASS_ID = 1

# --- Step 1: look up the vendor role + invoice graph ------------------------

vendor_user = User.find_by( email: VENDOR_EMAIL )
abort "Aborting: vendor user '#{VENDOR_EMAIL}' not found. Re-seed retailers_demo_data." unless vendor_user

vendor_role = Roles::EntityRole::SubcontractorRole.find_by(
  entity_id: vendor_user.organization_id, active: true,
)
abort "Aborting: no active SubcontractorRole for org #{vendor_user.organization_id}." unless vendor_role

invoice = Invoices::SubcontractorInvoice.find_by( id: INVOICE_ID )
abort "Aborting: SubcontractorInvoice ##{INVOICE_ID} not found." unless invoice

assignment      = invoice.workorder_assignments.first
wo              = invoice.workorders.first || assignment&.workorder
comparison_date = ( wo&.date_completed || wo&.created_at )&.to_date || Date.current
abort "Aborting: invoice ##{INVOICE_ID} has no assignment/workorder to derive pricing context." unless wo

home_currency = SSetting.get( :home_currency )

# --- Step 2: clean prior TANGO-58 fixtures (idempotent) ---------------------

removed_pricings = Products::SubcontractorProductPricing
  .where( 'name LIKE ?', "#{PREFIX}%" ).destroy_all.size
puts "Removed #{removed_pricings} prior TANGO-58 fixture pricing(s)."

# Clean any persisted QA line items from prior runs (e.g. a super_admin override
# tamper row). The instrumentation creates are rolled back, so normally none
# persist — this is belt-and-suspenders for re-runs.
removed_items = Invoices::SubcontractorInvoiceLineItem
  .where( 'description LIKE ?', "#{PREFIX}%" ).destroy_all.size
puts "Removed #{removed_items} prior TANGO-58 QA line item(s)."

# --- Step 3: model-instrumentation probe product (fresh, no UI dependency) ---
# A dedicated product guarantees a clean slate (zero pre-existing pricings) so
# the per-scenario CTE count is deterministic. Uses the real "Labor"
# classification so it's a structurally normal line-item product.

probe_product = Products::Service.find_or_create_by!( name: "#{PREFIX} Resolution Probe" ) do |p|
  p.code                      = 'QT58PROBE'
  p.description               = 'TANGO-58 model-instrumentation probe (get_pricing CTE counting). Safe to delete.'
  p.product_classification_id = LABOR_CLASS_ID
  p.reorder_level             = 10
  p.reorder_quantity          = 100
  p.active                    = true
end
puts "Probe product: ##{probe_product.id} #{probe_product.name}"

# Count executions of the pricing PermutationRankable CTE only. Other rankable
# models (GL mappings, default assignments, NTEs) emit the same `WITH any_matches`
# shape during the save cascade and must NOT count — filter on the table too.
def count_pricing_ctes
  count = 0
  callback = lambda do |_name, _start, _finish, _id, payload|
    sql = payload[ :sql ].to_s
    count += 1 if sql.include?( 'WITH any_matches' ) && sql.include?( 'from product_pricings' )
  end
  ActiveSupport::Notifications.subscribed( callback, 'sql.active_record' ) { yield }
  count
end

# Create a SubcontractorInvoiceLineItem with NO unit_price (the typical API
# create) inside a rolled-back transaction, counting pricing-CTE executions.
# Returns { cte:, unit_price: } captured before rollback — nothing persists.
def instrumented_create( invoice_id, product_id )
  result = {}
  ActiveRecord::Base.transaction do
    line_item = nil
    cte = count_pricing_ctes do
      line_item = Invoices::SubcontractorInvoiceLineItem.create!(
        description: '[QA] TANGO-58 probe', quantity: 1, taxable: false, tax_rate: 0,
        invoice_id: invoice_id, incurred: false, product_id: product_id,
      )
    end
    result = { cte: cte, unit_price: line_item.unit_price.to_f }
    raise ActiveRecord::Rollback
  end
  result
end

def make_pricing( prefix:, vendor_role:, product:, base_price:, enforced:, currency:, start_date: nil, end_date: nil )
  Products::SubcontractorProductPricing.create!(
    name:                       "#{prefix} #{enforced ? 'Enforced' : 'NonEnforcing'} $#{base_price}",
    role_id:                    vendor_role.id,
    product_id:                 product.id,
    pricing_type:               'Flat Rate',         # enforcement applies to Flat Rate (TANGO-4 AC)
    base_price:                 base_price,
    active:                     true,
    prevent_price_modification: enforced,
    currency:                   currency,
    country:                    nil,
    effective_start_date:       start_date,
    effective_end_date:         end_date,
  )
end

# --- Step 4: run the four instrumented scenarios ----------------------------

NON_ENFORCING_RATE = 42.5
ENFORCED_RATE      = 99.99
EXPIRED_RATE       = 500.0  # what the OLD inline hash (comparison_date: nil) would have wrongly filled

model_checks = []

# Scenario A — no pricing match: CTE runs once, unit_price defaults to 0.0.
res = instrumented_create( invoice.id, probe_product.id )
model_checks << {
  ac: '1, 2', scenario: 'no_match',
  name: 'no pricing match — get_pricing CTE runs exactly once; unit_price defaults to 0.0',
  cte_count: res[:cte], unit_price: res[:unit_price],
  expected_cte: 1, expected_unit_price: 0.0,
  passed: ( res[:cte] == 1 && res[:unit_price] == 0.0 ),
  detail: "A create with no matching pricing executed the pricing CTE #{res[:cte]}x (expected 1) and left unit_price=#{res[:unit_price]} (expected 0.0). Pre-fix this was 3x.",
}

# Scenario B — non-enforcing match: CTE once, unit_price filled from base_price (AC#2).
p_non = make_pricing( prefix: PREFIX, vendor_role: vendor_role, product: probe_product,
                      base_price: NON_ENFORCING_RATE, enforced: false, currency: home_currency )
res = instrumented_create( invoice.id, probe_product.id )
model_checks << {
  ac: '1, 2', scenario: 'non_enforcing',
  name: 'non-enforcing match — get_pricing CTE runs exactly once; unit_price filled from base_price',
  cte_count: res[:cte], unit_price: res[:unit_price],
  expected_cte: 1, expected_unit_price: NON_ENFORCING_RATE,
  passed: ( res[:cte] == 1 && res[:unit_price] == NON_ENFORCING_RATE ),
  detail: "A create where the client omitted unit_price filled it from the matched base_price ($#{NON_ENFORCING_RATE}) in #{res[:cte]} CTE execution(s) (expected 1). Pre-fix this was 3x.",
}
p_non.destroy

# Scenario C — enforcing match (prevent_price_modification=true): CTE once, unit_price = locked Approved Rate (AC#3).
p_enf = make_pricing( prefix: PREFIX, vendor_role: vendor_role, product: probe_product,
                      base_price: ENFORCED_RATE, enforced: true, currency: home_currency )
res = instrumented_create( invoice.id, probe_product.id )
model_checks << {
  ac: '1, 3', scenario: 'enforcing',
  name: 'enforcing match — get_pricing CTE runs exactly once; unit_price locks to the Approved Rate',
  cte_count: res[:cte], unit_price: res[:unit_price],
  expected_cte: 1, expected_unit_price: ENFORCED_RATE,
  passed: ( res[:cte] == 1 && res[:unit_price] == ENFORCED_RATE ),
  detail: "A create against an enforcing pricing (prevent_price_modification=true) filled+locked unit_price to the Approved Rate ($#{ENFORCED_RATE}) in #{res[:cte]} CTE execution(s) (expected 1). Pre-fix this was 2x.",
}
p_enf.destroy

# Scenario C2 — enforcing pricing + a MISMATCHED unit_price → rejected server-side
# (AC#3 "enforcement still locks"). Run with no current_user (rails runner), so
# no :can_override_enforced_pricing — the model-layer enforcement validation must
# reject the write. (Note: the super_admin UI persona CAN override, which is why
# this is proven persona-free at the model layer rather than via an admin tamper.)
p_enf2 = make_pricing( prefix: PREFIX, vendor_role: vendor_role, product: probe_product,
                       base_price: ENFORCED_RATE, enforced: true, currency: home_currency )
mismatch_submitted = ENFORCED_RATE + 50
mismatch_rejected  = false
mismatch_errors    = nil
mismatch_persisted_price = nil
ActiveRecord::Base.transaction do
  li = Invoices::SubcontractorInvoiceLineItem.new(
    description: '[QA] TANGO-58 mismatch', quantity: 1, taxable: false, tax_rate: 0,
    invoice_id: invoice.id, incurred: false, product_id: probe_product.id,
    unit_price: mismatch_submitted,
  )
  saved             = li.save
  mismatch_rejected = !saved
  mismatch_errors   = li.errors[ :unit_price ].join( '; ' )
  mismatch_persisted_price = li.unit_price.to_f
  raise ActiveRecord::Rollback
end
p_enf2.destroy
model_checks << {
  ac: '3', scenario: 'enforcing_mismatch_rejected',
  name: 'enforced pricing still LOCKS — a mismatched unit_price is rejected server-side',
  submitted_price: mismatch_submitted, approved_rate: ENFORCED_RATE,
  rejected: mismatch_rejected, errors: mismatch_errors,
  cte_count: nil, unit_price: nil, expected_cte: nil, expected_unit_price: nil,
  passed: mismatch_rejected,
  detail: "Submitting $#{mismatch_submitted} against the enforced Approved Rate $#{ENFORCED_RATE} (no override permission) was #{mismatch_rejected ? 'REJECTED' : 'ACCEPTED'} by the model-layer enforcement guard#{mismatch_rejected ? " (errors.unit_price: #{mismatch_errors})" : " — persisted at $#{mismatch_persisted_price}"}.",
}

# Scenario D — expired-only pricing (AC#5 correctness): the resolved context
# carries comparison_date, so the out-of-window pricing is excluded. The OLD
# inline hash (comparison_date: nil) disabled the date filter and would have
# filled unit_price from this EXPIRED pricing. Post-fix it must land at 0.0.
p_exp = make_pricing( prefix: PREFIX, vendor_role: vendor_role, product: probe_product,
                      base_price: EXPIRED_RATE, enforced: false, currency: home_currency,
                      start_date: Date.new( 2020, 1, 1 ), end_date: Date.new( 2020, 12, 31 ) )
res = instrumented_create( invoice.id, probe_product.id )
model_checks << {
  ac: '1, 5', scenario: 'expired_only',
  name: 'expired-only pricing — excluded by the effective-date filter; unit_price stays 0.0 (NOT the expired rate)',
  cte_count: res[:cte], unit_price: res[:unit_price],
  expected_cte: 1, expected_unit_price: 0.0,
  passed: ( res[:cte] == 1 && res[:unit_price] == 0.0 ),
  detail: "Only pricing is expired (2020 window) vs comparison_date #{comparison_date}; the shipped code resolves a dated pricing context and excludes it → unit_price=#{res[:unit_price]} (expected 0.0), CTE ran #{res[:cte]}x (expected 1). NOTE: invoice ##{invoice.id} has a DIRECT workorder (inv.workorders not empty), so this confirms shipped behaviour end-to-end but does not by itself discriminate old-vs-new (old code would also derive comparison_date from the direct WO here). The discriminating proof of the assignment→workorder fallback divergence — where inv.workorders is empty so the OLD inline hash passed comparison_date: nil and would have filled the expired $#{EXPIRED_RATE} — is the merged Minitest 'set_unit_price resolves the workorder through the assignment when the invoice has no direct workorder (TANGO-58)', run under AC #4.",
}
p_exp.destroy

# --- Step 5: persistent UI fixture (AC#3) — locked Holiday Rate $150 ---------

ui_product = Products::Product.find_by( name: UI_PRODUCT )
abort "Aborting: UI product '#{UI_PRODUCT}' missing." unless ui_product

UI_RATE = 150
ui_pricing = make_pricing( prefix: "#{PREFIX} UI", vendor_role: vendor_role, product: ui_product,
                           base_price: UI_RATE, enforced: true, currency: home_currency )
puts "UI fixture: ##{ui_pricing.id} #{ui_pricing.name} (locked $#{UI_RATE} on '#{UI_PRODUCT}' id=#{ui_product.id})"

# --- Step 6: emit manifest --------------------------------------------------

TANGO_ROOT    = File.expand_path( '..', __dir__ )
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-58.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-58',
  source_seed:  'seeds/pricing-resolution-once.rb',
  description:  'Model-layer instrumentation (get_pricing CTE counting on real creates) proving a SubcontractorInvoiceLineItem create resolves subcontractor pricing at most once, fills unit_price correctly, locks enforced rates, and no longer fills from expired/mis-scoped pricings. Plus one persistent locked Holiday Rate fixture for the Ext-grid AC#3 lock test.',
  scope: {
    vendor:          { user_email: vendor_user.email, role_id: vendor_role.id, entity_id: vendor_role.entity_id },
    invoice_id:      invoice.id,
    assignment_id:   assignment&.id,
    workorder_id:    wo&.id,
    # In this dev DB every subcontractor invoice has a DIRECT workorder, so the
    # comparison_date: nil bug condition (inv.workorders empty) is not reproducible
    # at the instrumentation layer — the discriminating fallback proof is the
    # merged Minitest, run under AC #4. See the expired_only model_check detail.
    invoice_has_direct_workorder: invoice.workorders.count > 0,
    comparison_date: comparison_date.iso8601,
    probe_product:   { id: probe_product.id, name: probe_product.name },
    ui_product:      { id: ui_product.id, name: ui_product.name, classification_id: LABOR_CLASS_ID },
    ui_enforced_rate: UI_RATE,
    rates:           { non_enforcing: NON_ENFORCING_RATE, enforcing: ENFORCED_RATE, expired: EXPIRED_RATE },
  },
  ui_fixture: {
    id:                         ui_pricing.id,
    name:                       ui_pricing.name,
    product_id:                 ui_product.id,
    product_name:               ui_product.name,
    base_price:                 ui_pricing.base_price.to_s,
    prevent_price_modification: !!ui_pricing.prevent_price_modification,
    currency:                   ui_pricing.currency,
  },
  # Rendered as the "Test setup" fixture table by the QA reporter. Covers the
  # one persistent UI fixture + the four transient probe pricings the model
  # instrumentation cycles through (created, measured in a rolled-back create,
  # then destroyed — hence id: nil).
  fixtures: [
    {
      id: ui_pricing.id, name: ui_pricing.name, active: true,
      pricing_type: 'Flat Rate', base_price: UI_RATE.to_s,
      effective_start_date: nil, effective_end_date: nil,
      prevent_price_modification: true, facility_id: nil,
      purpose: "Persistent UI fixture on '#{ui_product.name}' (locked $#{UI_RATE}). Drives the Ext-grid test: rate auto-fills + locks read-only (AC #3 + AC #2 populate-on-omit).",
    },
    {
      id: nil, name: "#{PREFIX} probe · non-enforcing $#{NON_ENFORCING_RATE}", active: true,
      pricing_type: 'Flat Rate', base_price: NON_ENFORCING_RATE.to_s,
      effective_start_date: nil, effective_end_date: nil,
      prevent_price_modification: false, facility_id: nil,
      purpose: 'Transient probe pricing. Model instrumentation: omit-unit_price create fills from base_price in ONE get_pricing CTE (AC #1, #2).',
    },
    {
      id: nil, name: "#{PREFIX} probe · enforcing $#{ENFORCED_RATE}", active: true,
      pricing_type: 'Flat Rate', base_price: ENFORCED_RATE.to_s,
      effective_start_date: nil, effective_end_date: nil,
      prevent_price_modification: true, facility_id: nil,
      purpose: 'Transient probe pricing. Model instrumentation: enforced create fills+locks the Approved Rate in ONE CTE (AC #1, #3); a mismatched unit_price is rejected server-side (AC #3).',
    },
    {
      id: nil, name: "#{PREFIX} probe · expired $#{EXPIRED_RATE}", active: true,
      pricing_type: 'Flat Rate', base_price: EXPIRED_RATE.to_s,
      effective_start_date: '2020-01-01', effective_end_date: '2020-12-31',
      prevent_price_modification: false, facility_id: nil,
      purpose: "Transient probe pricing (expired 2020 window). Model instrumentation: excluded by the dated context; unit_price stays 0.0 not $#{EXPIRED_RATE} (AC #5).",
    },
  ],
  model_checks: model_checks,
}
File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

puts ''
puts '--- TANGO-58 model checks (get_pricing CTE count per create) ---'
model_checks.each do |c|
  status = c[:passed] ? 'PASS' : 'FAIL'
  puts "  [#{status}] AC #{c[:ac]} — #{c[:scenario]}: cte=#{c[:cte_count]} (exp #{c[:expected_cte]}), unit_price=#{c[:unit_price]} (exp #{c[:expected_unit_price]})"
end
puts ''
puts "Vendor:    role_id=#{vendor_role.id} (#{vendor_user.email})"
puts "Invoice:   ##{invoice.id}  assignment=#{assignment&.id}  wo=#{wo&.id}  comparison_date=#{comparison_date}"
puts "Manifest:  #{MANIFEST_PATH}"
puts "Re-run safely with: npm run seed:pricing-resolution-once"
