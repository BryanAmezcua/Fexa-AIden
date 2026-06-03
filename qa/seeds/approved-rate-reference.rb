# Idempotent test fixtures for the Approved Rate reference (TANGO-6).
#
# Sets up three editable SubcontractorProductPricings (one per pricing_type)
# on Product=Overtime Rate, Vendor=1st Quality Electric. Tests drive the
# subcontractor invoice / quote line-item form, select the product, and
# verify the "Approved Rate = $X" reference text appears with the value
# matching ProductPricing#evaluate_data().
#
# Run via: npm run seed:approved-rate-reference
#
# Also fixes the vendor persona (subcontractor_user3083) the first time it
# runs — that seeded user is created without a person_id, which causes
# post-login `undefined method 'role' for nil:NilClass`. We attach a
# minimal Person + SubcontractorEmployeeRole so the user can log in.

require 'json'

FIXTURE_PREFIX = 'Approved Rate Ref - '.freeze
VENDOR_EMAIL   = 'subcontractor_user3083@fexa.io'.freeze
PRODUCT_NAME   = 'Overtime Rate'.freeze  # distinct from TANGO-3's Regular Rate scope

# --- Step 1: ensure vendor persona is functional -----------------------------

vendor_user = User.find_by( email: VENDOR_EMAIL )
abort "Aborting: vendor user '#{VENDOR_EMAIL}' not found. Re-seed retailers_demo_data." unless vendor_user

if vendor_user.person_id.nil?
  org = Entities::Organization.find( vendor_user.organization_id )
  org_addr = org.general_addresses.first  # template

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
    start_date:           Time.now,
    active:               true,
    entity_id:            person.id,
    organization_entity_id: org.id,
  )

  vendor_user.update!( person_id: person.id )
  puts "Fixed #{VENDOR_EMAIL} → linked Person id=#{person.id}"
else
  puts "#{VENDOR_EMAIL} already has person_id=#{vendor_user.person_id}"
end

# --- Step 2: look up pricing scope -------------------------------------------

product      = Products::Product.find_by( name: PRODUCT_NAME )
abort "Aborting: Products::Product '#{PRODUCT_NAME}' missing." unless product

vendor_role  = Roles::EntityRole::SubcontractorRole.find_by(
  entity_id: vendor_user.organization_id, active: true,
)
abort "Aborting: no active SubcontractorRole for org #{vendor_user.organization_id}." unless vendor_role

# --- Step 3: clean previous fixtures -----------------------------------------

removed = Products::SubcontractorProductPricing
  .where( 'name LIKE ?', "#{FIXTURE_PREFIX}%" )
  .destroy_all.size
puts "Removed #{removed} prior fixture pricing(s)."

# --- Step 4: create editable pricings (one per pricing_type) ----------------

today  = Date.current
common = {
  product_id:                  product.id,
  product_classification_id:   product.product_classification_id,
  role_id:                     vendor_role.id,
  effective_start_date:        today.beginning_of_year,
  effective_end_date:          today.next_year.end_of_year,
  active:                      true,
  currency:                    SSetting.get( :home_currency ),
  prevent_price_modification:  false,   # the "Do not allow pricing to be modified" toggle from AC
}

baselines = [
  {
    name:         "#{FIXTURE_PREFIX}Flat Rate $100",
    pricing_type: 'Flat Rate',
    base_price:   100,
    purpose:      'Editable Flat Rate pricing. Expected Approved Rate display = $100.00 regardless of unit_price.',
  },
  {
    name:         "#{FIXTURE_PREFIX}Increase $25",
    pricing_type: 'Increase',
    base_price:   25,
    purpose:      'Editable Increase pricing. Expected Approved Rate = unit_price + $25 (per evaluate_data).',
  },
  {
    name:         "#{FIXTURE_PREFIX}Decrease $15",
    pricing_type: 'Decrease',
    base_price:   15,
    purpose:      'Editable Decrease pricing. Expected Approved Rate = unit_price − $15 (per evaluate_data).',
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
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-6.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

vendor_company    = vendor_user.organization&.default_dispatch_address&.company rescue nil
classification    = Products::ProductClassification.find_by( id: product.product_classification_id )&.name rescue nil

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-6',
  source_seed:  'seeds/approved-rate-reference.rb',
  description:  'Editable subcontractor pricings (prevent_price_modification=false) so the Approved Rate reference shows on subcontractor invoice / quote line items.',
  scope: {
    product: {
      id:                        product.id,
      name:                      product.name,
      classification:            classification,
      product_classification_id: product.product_classification_id,
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
      id:                              rec.id,
      name:                            rec.name,
      active:                          rec.active,
      pricing_type:                    rec.pricing_type,
      base_price:                      rec.base_price.to_s,
      currency:                        rec.currency,
      effective_start_date:            rec.effective_start_date&.iso8601,
      effective_end_date:              rec.effective_end_date&.iso8601,
      facility_id:                     rec.facility_id,
      prevent_price_modification:      !!rec.prevent_price_modification,
      purpose:                         purpose,
    }
  end
}
File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

puts ''
puts '--- TANGO-6 fixtures ---'
puts "Product:        #{product.name} (id=#{product.id}, classification: #{classification})"
puts "Vendor:         #{vendor_company || 'unknown'} (role_id=#{vendor_role.id}, entity_id=#{vendor_role.entity_id})"
puts "Vendor user:    #{vendor_user.email} (person_id=#{vendor_user.person_id})"
puts "Invoice target: SubcontractorInvoice id=#{existing_invoice&.id || '<none>'}, SubcontractorQuote id=#{existing_quote&.id || '<none>'}"
puts ''
created.each do |p, _purpose|
  puts "  [#{p.id.to_s.rjust(6)}] #{p.name}  #{p.pricing_type} $#{p.base_price}  prevent_price_modification=#{p.prevent_price_modification}"
end
puts ''
puts "Manifest:       #{MANIFEST_PATH}"
puts "Re-run safely with: npm run seed:approved-rate-reference"
