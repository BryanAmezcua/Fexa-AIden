# Idempotent test fixtures for Rate Locking (TANGO-5).
#
# AC scope: when matched SubcontractorProductPricing has
# prevent_price_modification=true, unit_price auto-fills with the calculated
# Approved Rate AND is locked (read-only). Helper text appears below.
#
# Fixtures created here (on subcontractor_user3083's vendor scope, on products
# distinct from TANGO-3/4/6 so no overlap warnings fire):
#   - "Enforced Rate - Locked Holiday Rate $150"
#     product=Holiday Rate, current dates → drives AC #1-7 + #9-10 happy path
#   - "Enforced Rate - Locked Labor Incurred Expired"
#     product=Labor Incurred, expired dates 2020-01-01..2020-12-31 → AC #13
#     (get_pricing's date filter excludes this so the rate stays editable)
#
# Two more products are referenced WITHOUT a TANGO-5 fixture (the tests look
# them up at runtime):
#   - Labor Emergency  (no pricing at all for this vendor)         → AC #11
#   - Overtime Rate    (TANGO-6 fixtures, prevent_price_modification=false) → AC #12
#
# Run via: npm run seed:enforced-rate

require 'json'

FIXTURE_PREFIX         = 'Enforced Rate - '.freeze
VENDOR_EMAIL           = 'subcontractor_user3083@fexa.io'.freeze
HOLIDAY_PRODUCT_NAME   = 'Holiday Rate'.freeze
LABOR_INC_PRODUCT_NAME = 'Labor Incurred'.freeze

# --- Step 1: ensure vendor persona is functional ----------------------------
# Same defensive fix as the TANGO-6 seed — idempotent so safe to repeat. The
# seeded subcontractor_user3083 ships with person_id=NULL which crashes login.

vendor_user = User.find_by( email: VENDOR_EMAIL )
abort "Aborting: vendor user '#{VENDOR_EMAIL}' not found. Re-seed retailers_demo_data." unless vendor_user

if vendor_user.person_id.nil?
  org      = Entities::Organization.find( vendor_user.organization_id )
  org_addr = org.general_addresses.first

  person_addr = Addresses::GeneralAddress.create!(
    first_name:      'QA',
    last_name:       'Vendor',
    address1:        org_addr&.address1   || '1 QA Way',
    city:            org_addr&.city       || 'Test City',
    state:           org_addr&.state      || 'TX',
    country:         org_addr&.country    || 'US',
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
  puts "Fixed #{VENDOR_EMAIL} → linked Person id=#{person.id}"
else
  puts "#{VENDOR_EMAIL} already has person_id=#{vendor_user.person_id}"
end

# --- Step 1b: ensure the vendor user has a known QA password -----------------
# subcontractor_user3083 ships without a known password, but the `vendor`
# Playwright project logs in as this user to prove Scope #2 (enforcement applies
# to the vendor persona too). Reset it idempotently to a fixed QA value and
# surface it so it can be dropped into qa/.env (VENDOR_PASSWORD).
QA_VENDOR_PASSWORD = 'qa-tango-5-pass1'.freeze
vendor_user.password              = QA_VENDOR_PASSWORD
vendor_user.password_confirmation = QA_VENDOR_PASSWORD
vendor_user.save!
puts "Set QA password for #{VENDOR_EMAIL} (qa/.env VENDOR_PASSWORD=#{QA_VENDOR_PASSWORD})"

# --- Step 2: look up products + vendor role ---------------------------------

holiday_product   = Products::Product.find_by( name: HOLIDAY_PRODUCT_NAME )
labor_inc_product = Products::Product.find_by( name: LABOR_INC_PRODUCT_NAME )
# Edge-gap fixtures (added to close the multi-agent review's transition + boundary gaps):
regular_product   = Products::Product.find_by( name: 'Regular Rate' )  # 2nd enforced rate
regency_product   = Products::Product.find_by( name: 'Regency' )       # inclusive-boundary fixture
abort "Aborting: Products::Product '#{HOLIDAY_PRODUCT_NAME}' missing."   unless holiday_product
abort "Aborting: Products::Product '#{LABOR_INC_PRODUCT_NAME}' missing." unless labor_inc_product
abort "Aborting: Products::Product 'Regular Rate' missing." unless regular_product
abort "Aborting: Products::Product 'Regency' missing."      unless regency_product

# Inclusive-boundary date = invoice #24's WO completion date (falls back to created_at).
# get_pricing must treat effective_end_date == this date as still-in-window (inclusive).
boundary_invoice = Invoices::SubcontractorInvoice.find_by( id: 24 )
boundary_wo      = boundary_invoice&.workorders&.first || boundary_invoice&.workorder_assignments&.first&.workorder
boundary_date    = ( boundary_wo&.date_completed || boundary_wo&.created_at )&.to_date || Date.current

vendor_role = Roles::EntityRole::SubcontractorRole.find_by(
  entity_id: vendor_user.organization_id, active: true,
)
abort "Aborting: no active SubcontractorRole for org #{vendor_user.organization_id}." unless vendor_role

# --- Step 3: clean prior fixtures -------------------------------------------

removed = Products::SubcontractorProductPricing
  .where( 'name LIKE ?', "#{FIXTURE_PREFIX}%" )
  .destroy_all.size
puts "Removed #{removed} prior fixture pricing(s)."

# --- Step 4: create fixtures ------------------------------------------------

today  = Date.current
common = {
  role_id:      vendor_role.id,
  active:       true,
  currency:     SSetting.get( :home_currency ),
  pricing_type: 'Flat Rate',  # Per TANGO-4 final AC: enforcement only applies to Flat Rate
}

baselines = [
  {
    name:                       "#{FIXTURE_PREFIX}Locked Holiday Rate $150",
    product_id:                 holiday_product.id,
    product_classification_id:  holiday_product.product_classification_id,
    base_price:                 150,
    prevent_price_modification: true,
    effective_start_date:       today.beginning_of_year,
    effective_end_date:         today.next_year.end_of_year,
    purpose:                    'Primary locked-rate fixture. Flat Rate $150 with enforcement ON. Drives AC #1-7 (rate auto-fills + locked + helper text), AC #9 (admin sees lock), AC #10 (re-select re-evaluates).',
  },
  {
    name:                       "#{FIXTURE_PREFIX}Locked Labor Incurred Expired",
    product_id:                 labor_inc_product.id,
    product_classification_id:  labor_inc_product.product_classification_id,
    base_price:                 80,
    prevent_price_modification: true,
    effective_start_date:       Date.new( 2020, 1, 1 ),
    effective_end_date:         Date.new( 2020, 12, 31 ),
    purpose:                    "Expired locked-rate fixture (dates 2020-01-01..2020-12-31). Proves get_pricing's date filter excludes this pricing so the rate remains editable on a WO with a current completion date — AC #13.",
  },
  {
    name:                       "#{FIXTURE_PREFIX}Locked Regular Rate $90",
    product_id:                 regular_product.id,
    product_classification_id:  regular_product.product_classification_id,
    base_price:                 90,
    prevent_price_modification: true,
    effective_start_date:       today.beginning_of_year,
    effective_end_date:         today.next_year.end_of_year,
    purpose:                    'Second locked fixture at a DIFFERENT rate ($90). Drives the enforced->enforced re-select edge: switching from Holiday Rate ($150) to this product must recompute the locked value to $90, not keep the stale $150.',
  },
  {
    name:                       "#{FIXTURE_PREFIX}Locked Regency Boundary",
    product_id:                 regency_product.id,
    product_classification_id:  regency_product.product_classification_id,
    base_price:                 110,
    prevent_price_modification: true,
    effective_start_date:       boundary_date - 90,
    effective_end_date:         boundary_date,
    purpose:                    "Inclusive-boundary fixture: effective_end_date == invoice #24 WO date (#{boundary_date}). Proves get_pricing's date filter is INCLUSIVE — the pricing still matches and the rate locks on the last valid day, not only for far-past dates.",
  },
]

created = baselines.map do |attrs|
  purpose = attrs.delete( :purpose )
  rec     = Products::SubcontractorProductPricing.create!( common.merge( attrs ) )
  [ rec, purpose ]
end

# --- Step 5: locate existing invoice + quote for this vendor ----------------

existing_invoice = Invoices::SubcontractorInvoice
  .joins( 'JOIN roles ON roles.id = invoices.payable_to' )
  .where( 'roles.entity_id = ?', vendor_user.organization_id )
  .order( :id ).first

existing_quote = Invoices::SubcontractorQuote
  .joins( 'JOIN roles ON roles.id = invoices.payable_to' )
  .where( 'roles.entity_id = ?', vendor_user.organization_id )
  .order( :id ).first

# --- Step 6: emit manifest --------------------------------------------------

TANGO_ROOT    = File.expand_path( '..', __dir__ )
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-5.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

vendor_company        = vendor_user.organization&.default_dispatch_address&.company rescue nil
holiday_classification = Products::ProductClassification.find_by( id: holiday_product.product_classification_id )&.name rescue nil
labor_classification   = Products::ProductClassification.find_by( id: labor_inc_product.product_classification_id )&.name rescue nil

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-5',
  source_seed:  'seeds/enforced-rate.rb',
  description:  'Locked subcontractor pricings (prevent_price_modification=true) so the unit_price field is auto-filled and read-only on subcontractor invoice/quote line items. Includes one current-dated fixture for the happy path and one expired-dated fixture for AC #13.',
  scope: {
    products: [
      {
        id:                        holiday_product.id,
        name:                      holiday_product.name,
        classification:            holiday_classification,
        product_classification_id: holiday_product.product_classification_id,
        purpose:                   'Primary product with locked current-dated pricing — drives the happy-path lock scenarios.',
      },
      {
        id:                        labor_inc_product.id,
        name:                      labor_inc_product.name,
        classification:            labor_classification,
        product_classification_id: labor_inc_product.product_classification_id,
        purpose:                   'Product whose only pricing is expired-and-locked — proves the date-filter exclusion (AC #13).',
      },
    ],
    no_pricing_product: {
      name:    'Labor Emergency',
      purpose: 'Referenced from tests for AC #11 — vendor has zero SubcontractorProductPricings for this product, so get_pricing returns no match and the rate field remains editable.',
    },
    reference_rate_product: {
      name:    'Overtime Rate',
      purpose: 'Referenced from tests for AC #12 — uses the TANGO-6 fixtures (prevent_price_modification=false) to prove the not-this-story branch: rate stays editable, Approved Rate displays as reference.',
    },
    vendor: {
      name:       vendor_company,
      user_email: vendor_user.email,
      role_id:    vendor_role.id,
      entity_id:  vendor_role.entity_id,
    },
    invoice_targets: {
      subcontractor_invoice_id: existing_invoice&.id,
      subcontractor_quote_id:   existing_quote&.id,
    },
  },
  fixtures: created.map do |rec, purpose|
    {
      id:                         rec.id,
      name:                       rec.name,
      active:                     rec.active,
      product_id:                 rec.product_id,
      pricing_type:               rec.pricing_type,
      base_price:                 rec.base_price.to_s,
      currency:                   rec.currency,
      effective_start_date:       rec.effective_start_date&.iso8601,
      effective_end_date:         rec.effective_end_date&.iso8601,
      prevent_price_modification: !!rec.prevent_price_modification,
      purpose:                    purpose,
    }
  end,
}
File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

puts ''
puts '--- TANGO-5 fixtures ---'
puts "Vendor:        #{vendor_company || 'unknown'} (role_id=#{vendor_role.id}, entity_id=#{vendor_role.entity_id})"
puts "Vendor user:   #{vendor_user.email} (person_id=#{vendor_user.person_id})"
puts "Invoice:       SubcontractorInvoice id=#{existing_invoice&.id || '<none>'}, SubcontractorQuote id=#{existing_quote&.id || '<none>'}"
puts ''
created.each do |p, _purpose|
  puts "  [#{p.id.to_s.rjust(6)}] #{p.name}  #{p.pricing_type} $#{p.base_price}  prevent_price_modification=#{p.prevent_price_modification}  dates=#{p.effective_start_date}..#{p.effective_end_date}"
end
puts ''
puts "Manifest:      #{MANIFEST_PATH}"
puts "Re-run safely with: npm run seed:enforced-rate"
