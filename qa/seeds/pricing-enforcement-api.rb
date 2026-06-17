# Idempotent test fixtures for API-layer pricing enforcement (TANGO-49).
#
# TANGO-49 is an API-only story: the model-layer guard in
# app/models/concerns/subcontractor_pricing_enforcement.rb rejects an API
# write to unit_price on a Subcontractor [Invoice|Quote] Line Item when the
# matched pricing has prevent_price_modification = true and the submitted
# price != Products::ProductPricing.evaluate_data output. The EV1/V1
# api_controller.rb maps EnforcedPricingViolation -> 422.
#
# This seed stands up FRESH fixtures (its own invoice + quote, its own
# pricings) so the suite is isolated from TANGO-3/TANGO-6 fixtures:
#
#   - An ENFORCED Flat Rate pricing (prevent_price_modification=true) on the
#     enforced product + vendor role, with a wide effective window so it
#     matches the work order's comparison date.
#   - An UNENFORCED Flat Rate pricing (prevent_price_modification=false) on a
#     second product so "write proceeds as today" (AC 8) is testable.
#   - An OUT-OF-WINDOW enforced pricing (past effective window) used only by
#     the AC-4 model-layer check (pricing_id isn't API-writable).
#   - A fresh DRAFT SubcontractorInvoice + SubcontractorQuote linked to an
#     existing workorder assignment (so the matcher's comparison_date and
#     role_id resolve), plus an APPROVED invoice for the AC-10 model check.
#   - Doorkeeper bearer tokens for the vendor user (no override permission)
#     and the admin user (super_admin -> holds :can_override_enforced_pricing
#     per Permissions::Adjunct.user_has_permission?) so EV1 requests carry
#     real customer-API auth.
#
# It also runs MODEL-LAYER checks for the three AC#14 cases that are NOT
# reachable through the EV1 API (AC 4 out-of-window pricing_id, AC 10
# approved-invoice no-re-eval, AC 12 write-time pricing state) and records
# pass/fail in the manifest (same pattern as TANGO-10's backfill checks).
#
# Run via: npm run seed:pricing-enforcement-api

require 'json'
require 'fileutils'

FIXTURE_PREFIX          = '[QA-TANGO49] '.freeze
VENDOR_EMAIL            = 'subcontractor_user3083@fexa.io'.freeze
ADMIN_EMAIL             = 'bigbrother@fexa.io'.freeze   # super_admin -> override-capable
# Products with NO pre-existing subcontractor pricing for this vendor role, so
# our fixtures are the SOLE match (Regular/Overtime/Holiday Rate already carry
# competing pricings from base demo data + TANGO-3/6 that outrank ours).
ENFORCED_PRODUCT_NAME   = 'Material'.freeze
UNENFORCED_PRODUCT_NAME = 'Trip Charge'.freeze
ENFORCED_BASE_PRICE     = 150
OUT_OF_WINDOW_PRICE     = 999
UNENFORCED_BASE_PRICE   = 80

def banner( msg )
  puts( "\n=== #{msg} ===" )
end

# --- Step 1: ensure the vendor persona can authenticate ----------------------
# subcontractor_user3083 is seeded without a person_id, which breaks login and
# (more importantly here) role resolution. Mirror the TANGO-6 fix defensively.

vendor_user = User.find_by( email: VENDOR_EMAIL )
abort "Aborting: vendor user '#{VENDOR_EMAIL}' not found. Re-seed retailers_demo_data." unless vendor_user

if vendor_user.person_id.nil?
  org      = Entities::Organization.find( vendor_user.organization_id )
  org_addr = org.general_addresses.first

  person_addr = Addresses::GeneralAddress.create!(
    first_name:      'QA',
    last_name:       'Vendor',
    address1:        org_addr&.address1    || '1 QA Way',
    city:            org_addr&.city        || 'Test City',
    state:           org_addr&.state       || 'TX',
    country:         org_addr&.country     || 'US',
    postal_code:     org_addr&.postal_code || '00000',
    phone:           '0000000000',
    address_name:    'QA',
    default_address: true,
    active:          true,
  )
  person = Entities::Person.create!( general_addresses: [ person_addr ] )
  Roles::EntityRole::SubcontractorEmployeeRole.create!(
    start_date:             Time.now,
    active:                 true,
    entity_id:              person.id,
    organization_entity_id: org.id,
  )
  vendor_user.update!( person_id: person.id )
  puts "Fixed #{VENDOR_EMAIL} -> linked Person id=#{person.id}"
else
  puts "#{VENDOR_EMAIL} already has person_id=#{vendor_user.person_id}"
end

admin_user = User.find_by( email: ADMIN_EMAIL )
abort "Aborting: admin user '#{ADMIN_EMAIL}' not found." unless admin_user
puts "Admin user:     #{admin_user.email} (super_admin=#{admin_user.super_admin?})"

# --- Step 2: resolve pricing scope (vendor role + products) -------------------

vendor_role = Roles::EntityRole::SubcontractorRole.find_by(
  entity_id: vendor_user.organization_id, active: true,
)
abort "Aborting: no active SubcontractorRole for org #{vendor_user.organization_id}." unless vendor_role

enforced_product = Products::Product.find_by( name: ENFORCED_PRODUCT_NAME )
abort "Aborting: Products::Product '#{ENFORCED_PRODUCT_NAME}' missing." unless enforced_product
unenforced_product = Products::Product.find_by( name: UNENFORCED_PRODUCT_NAME )
abort "Aborting: Products::Product '#{UNENFORCED_PRODUCT_NAME}' missing." unless unenforced_product

# --- Step 3: find a template invoice for bill_to + a workorder assignment -----
# Reusing an existing invoice's bill_to + assignment guarantees valid FKs and a
# resolvable comparison_date without hand-building the whole workorder graph.

template_invoice = Invoices::SubcontractorInvoice
  .joins( 'JOIN roles ON roles.id = invoices.payable_to' )
  .where( 'roles.entity_id = ?', vendor_user.organization_id )
  .order( :id ).detect { |inv| inv.workorder_assignments.first.present? }
abort "Aborting: no existing subcontractor invoice with a workorder assignment for this vendor to use as a template." unless template_invoice

bill_to        = template_invoice.bill_to
assignment     = template_invoice.workorder_assignments.first
wo             = assignment.workorder
comparison_date = ( wo&.date_completed || wo&.created_at )&.to_date || Date.current
puts "Template invoice id=#{template_invoice.id}, bill_to=#{bill_to}, assignment id=#{assignment.id}, comparison_date=#{comparison_date}"

# --- Step 4: clean prior fixtures (idempotent) -------------------------------

banner 'Cleaning prior TANGO-49 fixtures'
[ Invoices::SubcontractorInvoiceLineItem, Invoices::SubcontractorQuoteLineItem ].each do |klass|
  n = klass.where( 'description LIKE ?', "#{FIXTURE_PREFIX}%" ).delete_all
  puts "  removed #{n} #{klass.name} line item(s)"
end
puts "  removed #{Invoices::SubcontractorInvoice.where( 'reference_number LIKE ?', "#{FIXTURE_PREFIX}%" ).destroy_all.size} invoice(s)"
puts "  removed #{Invoices::SubcontractorQuote.where( 'reference_number LIKE ?', "#{FIXTURE_PREFIX}%" ).destroy_all.size} quote(s)"
puts "  removed #{Products::SubcontractorProductPricing.where( 'name LIKE ?', "#{FIXTURE_PREFIX}%" ).destroy_all.size} pricing(s)"
Doorkeeper::AccessToken.where( application_id: Doorkeeper::Application.where( 'name LIKE ?', "#{FIXTURE_PREFIX}%" ).select( :id ) ).delete_all
puts "  removed #{Doorkeeper::Application.where( 'name LIKE ?', "#{FIXTURE_PREFIX}%" ).destroy_all.size} oauth application(s)"

# --- Step 5: create the pricing fixtures -------------------------------------

banner 'Creating pricing fixtures'
home_currency = SSetting.get( :home_currency )

pricing_common = {
  role_id:    vendor_role.id,
  active:     true,
  currency:   home_currency,
}

enforced_pricing = Products::SubcontractorProductPricing.create!( pricing_common.merge(
  name:                        "#{FIXTURE_PREFIX}Enforced Flat Rate $#{ENFORCED_BASE_PRICE}",
  product_id:                  enforced_product.id,
  product_classification_id:   enforced_product.product_classification_id,
  pricing_type:                'Flat Rate',
  base_price:                  ENFORCED_BASE_PRICE,
  effective_start_date:        Date.new( 2000, 1, 1 ),
  effective_end_date:          Date.new( 2100, 12, 31 ),
  prevent_price_modification:  true,
) )

out_of_window_pricing = Products::SubcontractorProductPricing.create!( pricing_common.merge(
  name:                        "#{FIXTURE_PREFIX}Enforced Out-Of-Window $#{OUT_OF_WINDOW_PRICE}",
  product_id:                  enforced_product.id,
  product_classification_id:   enforced_product.product_classification_id,
  pricing_type:                'Flat Rate',
  base_price:                  OUT_OF_WINDOW_PRICE,
  effective_start_date:        Date.new( 1990, 1, 1 ),
  effective_end_date:          Date.new( 1990, 12, 31 ),   # past -> excluded from matching, used for AC-4 model check
  prevent_price_modification:  true,
) )

unenforced_pricing = Products::SubcontractorProductPricing.create!( pricing_common.merge(
  name:                        "#{FIXTURE_PREFIX}Unenforced Flat Rate $#{UNENFORCED_BASE_PRICE}",
  product_id:                  unenforced_product.id,
  product_classification_id:   unenforced_product.product_classification_id,
  pricing_type:                'Flat Rate',
  base_price:                  UNENFORCED_BASE_PRICE,
  effective_start_date:        Date.new( 2000, 1, 1 ),
  effective_end_date:          Date.new( 2100, 12, 31 ),
  prevent_price_modification:  false,
) )

puts "  enforced       id=#{enforced_pricing.id} (prevent=true,  Flat Rate $#{ENFORCED_BASE_PRICE})"
puts "  out-of-window  id=#{out_of_window_pricing.id} (prevent=true,  window 1990)"
puts "  unenforced     id=#{unenforced_pricing.id} (prevent=false, Flat Rate $#{UNENFORCED_BASE_PRICE})"

# --- Step 6: fresh draft invoice + quote (+ approved invoice for AC10) --------

banner 'Creating fresh invoice / quote fixtures'
stamp = Time.now.to_i

def link_assignment_attrs( assignment )
  [ { invoiceable_id: assignment.id, invoiceable_type: 'Workorders::Assignment' } ]
end

draft_invoice = Invoices::SubcontractorInvoice.create!(
  transaction_date:          Date.current,
  due_date:                  Date.current,
  description:               "#{FIXTURE_PREFIX}Enforcement API invoice",
  reference_number:          "#{FIXTURE_PREFIX}INV-#{stamp}",
  bill_to:                   bill_to,
  payable_to:                vendor_role.id,
  object_invoices_attributes: link_assignment_attrs( assignment ),
)

draft_quote = Invoices::SubcontractorQuote.create!(
  transaction_date:          Date.current,
  due_date:                  Date.current,
  description:               "#{FIXTURE_PREFIX}Enforcement API quote",
  reference_number:          "#{FIXTURE_PREFIX}QTE-#{stamp}",
  bill_to:                   bill_to,
  payable_to:                vendor_role.id,
  object_invoices_attributes: link_assignment_attrs( assignment ),
)

approved_invoice = Invoices::SubcontractorInvoice.create!(
  transaction_date:          Date.current,
  due_date:                  Date.current,
  description:               "#{FIXTURE_PREFIX}Approved invoice (AC10 no-re-eval)",
  reference_number:          "#{FIXTURE_PREFIX}INV-APPROVED-#{stamp}",
  bill_to:                   bill_to,
  payable_to:                vendor_role.id,
  object_invoices_attributes: link_assignment_attrs( assignment ),
)

# Flip the approved-invoice fixture into an approved workflow status so
# enforcement_reevaluatable? returns false for it (AC 10).
approved_type_ids = SSetting.get_values( *Constants::Workflow::APPROVED_TYPE_SSETTINGS ).values.compact
approved_status   = Workflows::Workflow
  .find_by( object_type: 'Invoices::SubcontractorInvoice' )
  &.statuses&.where( workflow_type_id: approved_type_ids )&.first
if approved_status && approved_invoice.object_state
  approved_invoice.object_state.update!( status_id: approved_status.id )
  puts "  approved invoice id=#{approved_invoice.id} -> status '#{approved_status.name}' (in_approved_state?=#{approved_invoice.reload.in_approved_state?})"
else
  puts "  WARNING: could not resolve an approved status; AC-10 model check may be inconclusive."
end

puts "  draft invoice  id=#{draft_invoice.id} (editable?=#{draft_invoice.allow_user_editing?})"
puts "  draft quote    id=#{draft_quote.id}"

# --- Step 7: compute the exact Approved Rate via the guard itself -------------
# Build (don't save) an enforced line item with no unit_price; the
# before_validation fill_enforced_unit_price callback populates it with the
# currency-exchanged Approved Rate. This is the precise value the API write
# must match, immune to currency-exchange surprises.

probe = Invoices::SubcontractorInvoiceLineItem.new(
  invoice_id: draft_invoice.id, product_id: enforced_product.id, quantity: 1,
)
probe.valid?
approved_rate = probe.unit_price&.to_f
puts "  computed Approved Rate for enforced product = #{approved_rate.inspect}"
abort "Aborting: could not compute Approved Rate (guard did not fill unit_price; check pricing match)." if approved_rate.nil?

# --- Step 8: Doorkeeper bearer tokens ----------------------------------------

banner 'Minting Doorkeeper bearer tokens'
oauth_app = Doorkeeper::Application.create!(
  name:         "#{FIXTURE_PREFIX}API Client",
  redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
  owner:        admin_user,
)
vendor_token = Doorkeeper::AccessToken.create!(
  resource_owner_id: vendor_user.id, application_id: oauth_app.id, scopes: '', expires_in: 1.month.to_i,
)
admin_token = Doorkeeper::AccessToken.create!(
  resource_owner_id: admin_user.id, application_id: oauth_app.id, scopes: '', expires_in: 1.month.to_i,
)
puts "  oauth app id=#{oauth_app.id}"
puts "  vendor token (resource_owner=#{vendor_user.id}): #{vendor_token.token[0, 12]}…"
puts "  admin  token (resource_owner=#{admin_user.id}): #{admin_token.token[0, 12]}…"

# --- Step 9: model-layer checks for the non-API-reachable AC cases ------------
# pricing_id isn't whitelisted in the API params (the concern documents this as
# "insurance against a future endpoint"), approved invoices are blocked at the
# controller before the guard, and toggle-mid-edit is an in-process property.
# Verify those three at the model layer here and record the result.

banner 'Model-layer checks (AC 4 / 10 / 12)'
model_checks = []

# Helper: set the acting user context the concern reads.
Thread.current[:current_user] = vendor_user.id

# AC 4 — out-of-window pricing_id is rejected.
begin
  li = Invoices::SubcontractorInvoiceLineItem.new(
    invoice_id: draft_invoice.id, product_id: enforced_product.id, quantity: 1, unit_price: approved_rate,
  )
  li.pricing_id = out_of_window_pricing.id
  # The shipped guard rejects via a validation error on :pricing_id (no exception),
  # so .save returns false and the message lands in errors[:pricing_id].
  if li.save
    li.destroy
    model_checks << { ac: '4', name: 'Out-of-window pricing_id rejected', passed: false,
                      detail: 'expected a :pricing_id validation error; save succeeded' }
  else
    pid_errors = li.errors[:pricing_id]
    model_checks << { ac: '4', name: 'Out-of-window pricing_id rejected', passed: pid_errors.present?,
                      detail: "rejected on pricing_id: #{pid_errors.join('; ').presence || li.errors.full_messages.join('; ')}" }
  end
rescue => e
  model_checks << { ac: '4', name: 'Out-of-window pricing_id rejected', passed: false, detail: "unexpected #{e.class}: #{e.message}" }
end

# AC 10 — write to an already-approved invoice is NOT re-evaluated (a mismatched
# unit_price is accepted at the model layer because the guard short-circuits).
begin
  li = Invoices::SubcontractorInvoiceLineItem.new(
    invoice_id: approved_invoice.id, product_id: enforced_product.id, quantity: 1, unit_price: approved_rate.to_f + 5000,
  )
  # The guard short-circuits on approved invoices (enforcement_reevaluatable? == false),
  # so it must NOT add a :unit_price enforcement error even though the price mismatches.
  saved = li.save
  enforcement_blocked = li.errors[:unit_price].present?
  model_checks << { ac: '10', name: 'Approved invoice not re-evaluated', passed: !enforcement_blocked,
                    detail: enforcement_blocked ? "guard fired on approved invoice: #{li.errors[:unit_price].join('; ')} — should have skipped" : "mismatched unit_price not rejected by enforcement on approved invoice (saved=#{saved})" }
  li.destroy if li.persisted?
rescue => e
  model_checks << { ac: '10', name: 'Approved invoice not re-evaluated', passed: false, detail: "unexpected #{e.class}: #{e.message}" }
end

# AC 12 — the guard uses pricing state at WRITE time, not match/read time.
# With enforcement ON a mismatch is rejected; after toggling it OFF the same
# mismatch is accepted. Restore the flag afterwards.
begin
  # Enforcement ON: a mismatched write is rejected via a :unit_price validation error.
  on_li = Invoices::SubcontractorInvoiceLineItem.new(
    invoice_id: draft_invoice.id, product_id: enforced_product.id, quantity: 1, unit_price: 1,
    description: "#{FIXTURE_PREFIX}AC12 probe ON",
  )
  on_li.save
  on_rejected = on_li.errors[:unit_price].present?
  on_li.destroy if on_li.persisted?

  # Toggle enforcement OFF: the same mismatched write is now accepted (write-time state).
  enforced_pricing.update_columns( prevent_price_modification: false )
  off_li = Invoices::SubcontractorInvoiceLineItem.new(
    invoice_id: draft_invoice.id, product_id: enforced_product.id, quantity: 1, unit_price: 1,
    description: "#{FIXTURE_PREFIX}AC12 probe OFF",
  )
  off_li.save
  off_accepted = off_li.errors[:unit_price].blank?
  off_li.destroy if off_li.persisted?
  enforced_pricing.update_columns( prevent_price_modification: true )

  model_checks << { ac: '12', name: 'Guard uses write-time pricing state', passed: ( on_rejected && off_accepted ),
                    detail: "enforced-on rejected=#{on_rejected}; after toggle-off accepted=#{off_accepted}" }
rescue => e
  enforced_pricing.update_columns( prevent_price_modification: true ) rescue nil
  model_checks << { ac: '12', name: 'Guard uses write-time pricing state', passed: false, detail: "unexpected #{e.class}: #{e.message}" }
end

Thread.current[:current_user] = nil
model_checks.each { |c| puts "  AC#{c[:ac]}: #{c[:passed] ? 'PASS' : 'FAIL'} — #{c[:detail]}" }

# --- Step 10: emit manifest --------------------------------------------------

TANGO_ROOT    = File.expand_path( '..', __dir__ )
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-49.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

classification_name = Products::ProductClassification.find_by( id: enforced_product.product_classification_id )&.name rescue nil
vendor_company      = vendor_user.organization&.default_dispatch_address&.company rescue nil

def pricing_fixture_hash( rec, purpose )
  {
    id:                         rec.id,
    name:                       rec.name,
    active:                     rec.active,
    pricing_type:               rec.pricing_type,
    base_price:                 rec.base_price.to_s,
    currency:                   rec.currency,
    effective_start_date:       rec.effective_start_date&.iso8601,
    effective_end_date:         rec.effective_end_date&.iso8601,
    prevent_price_modification: !!rec.prevent_price_modification,
    purpose:                    purpose,
  }
end

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-49',
  source_seed:  'seeds/pricing-enforcement-api.rb',
  description:  'API-layer enforcement fixtures: enforced + unenforced subcontractor pricings, a fresh draft invoice/quote (+ approved invoice), and Doorkeeper bearer tokens. EV1 API tests assert 422-on-mismatch / accept-on-match / override-accept; model-layer checks cover AC 4/10/12 which are not API-reachable.',
  scope: {
    enforced_product:   { id: enforced_product.id, name: enforced_product.name, classification: classification_name },
    unenforced_product: { id: unenforced_product.id, name: unenforced_product.name },
    vendor:             { name: vendor_company, user_email: vendor_user.email, user_id: vendor_user.id, role_id: vendor_role.id, entity_id: vendor_role.entity_id },
    admin:              { user_email: admin_user.email, user_id: admin_user.id, super_admin: admin_user.super_admin? },
    approved_rate:      approved_rate,
    comparison_date:    comparison_date.iso8601,
    invoice_targets:    { draft_invoice_id: draft_invoice.id, draft_quote_id: draft_quote.id, approved_invoice_id: approved_invoice.id },
  },
  api_auth: {
    base_path:    '/api/ev1',
    token_type:   'Bearer',
    vendor_token: vendor_token.token,   # no override permission (expects 422 on mismatch)
    admin_token:  admin_token.token,    # super_admin -> :can_override_enforced_pricing (override accepts)
    oauth_application_id: oauth_app.id,
  },
  fixtures: [
    pricing_fixture_hash( enforced_pricing,      'Enforced pricing — mismatched API unit_price must be rejected with 422; matching price accepted.' ),
    pricing_fixture_hash( out_of_window_pricing, 'Enforced pricing with a past effective window — drives the AC-4 model-layer out-of-window pricing_id check (pricing_id is not API-writable).' ),
    pricing_fixture_hash( unenforced_pricing,    'Unenforced pricing — API writes proceed with any unit_price (AC 8).' ),
  ],
  model_checks: model_checks,
}
File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

banner 'TANGO-49 fixtures ready'
puts "Enforced product:   #{enforced_product.name} (id=#{enforced_product.id}), Approved Rate=#{approved_rate}"
puts "Unenforced product: #{unenforced_product.name} (id=#{unenforced_product.id})"
puts "Vendor:             #{vendor_company || 'unknown'} (role_id=#{vendor_role.id})"
puts "Draft invoice/quote: #{draft_invoice.id} / #{draft_quote.id}; Approved invoice: #{approved_invoice.id}"
puts "Model checks:        #{model_checks.count { |c| c[:passed] }}/#{model_checks.size} passed"
puts "Manifest:           #{MANIFEST_PATH}"
puts "Re-run safely with:  npm run seed:pricing-enforcement-api"
