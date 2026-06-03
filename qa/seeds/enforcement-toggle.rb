# Idempotent test fixtures for the Enforcement toggle scenarios (TANGO-4).
#
# AC scope (per ticket + michelle.klaer 2026-05-21 comment): the toggle is
# only meaningful when pricing_type = 'Flat Rate' AND base_price > 0.
# Most TANGO-4 tests CREATE new pricings via the UI to exercise the form;
# this seed only sets up the small amount of pre-existing data needed for
# the clear-base-price scenario (AC Edge #1).
#
# Run via: npm run seed:enforcement-toggle
#
# Uses Materials Incurred (id=20) to stay isolated from TANGO-3 (Regular
# Rate, id=23) and TANGO-6 (Overtime Rate, id=24) so the existing fixtures
# don't trigger overlap warnings against this work.

require 'json'

FIXTURE_PREFIX = 'Enforcement Toggle - '.freeze
PRODUCT_NAME   = 'Materials Incurred'.freeze   # distinct from TANGO-3 / TANGO-6 scopes
VENDOR_EMAIL   = 'subcontractor_user3083@fexa.io'.freeze

# --- Step 1: look up pricing scope ------------------------------------------

product = Products::Product.find_by( name: PRODUCT_NAME )
abort "Aborting: Products::Product '#{PRODUCT_NAME}' not found." unless product

vendor_user = User.find_by( email: VENDOR_EMAIL )
abort "Aborting: vendor user '#{VENDOR_EMAIL}' missing." unless vendor_user

vendor_role = Roles::EntityRole::SubcontractorRole.find_by(
  entity_id: vendor_user.organization_id, active: true,
)
abort "Aborting: no active SubcontractorRole for org #{vendor_user.organization_id}." unless vendor_role

# --- Step 2: clean prior fixtures -------------------------------------------

removed = Products::SubcontractorProductPricing
  .where( 'name LIKE ?', "#{FIXTURE_PREFIX}%" )
  .destroy_all.size
puts "Removed #{removed} prior fixture pricing(s)."

# --- Step 3: create the "pre-enforced" pricing for Edge #1 -----------------

today  = Date.current
common = {
  product_id:                product.id,
  product_classification_id: product.product_classification_id,
  role_id:                   vendor_role.id,
  effective_start_date:      today.beginning_of_year,
  effective_end_date:        today.next_year.end_of_year,
  active:                    true,
  currency:                  SSetting.get( :home_currency ),
}

baselines = [
  {
    name:                       "#{FIXTURE_PREFIX}Locked Flat Rate $100",
    pricing_type:               'Flat Rate',
    base_price:                 100,
    prevent_price_modification: true,
    purpose: 'Pre-existing pricing with the enforcement toggle already ON. AC Edge #1 test edits this record, clears base_price, and expects a save-time validation error.',
  },
]

created = baselines.map do |attrs|
  purpose = attrs.delete( :purpose )
  rec     = Products::SubcontractorProductPricing.create!( common.merge( attrs ) )
  [ rec, purpose ]
end

# --- Step 4: emit manifest --------------------------------------------------

vendor_company  = vendor_user.organization&.default_dispatch_address&.company rescue nil
classification  = Products::ProductClassification.find_by( id: product.product_classification_id )&.name rescue nil

TANGO_ROOT    = File.expand_path( '..', __dir__ )
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-4.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-4',
  source_seed:  'seeds/enforcement-toggle.rb',
  description:  'Pre-existing pricing with the prevent_price_modification (enforcement) toggle ON. Used by the AC Edge #1 scenario to verify the clear-base-price validation. Other TANGO-4 scenarios create their pricings via the UI and Cancel without persisting.',
  scope: {
    product: {
      id:                        product.id,
      name:                      product.name,
      classification:            classification,
      product_classification_id: product.product_classification_id,
    },
    vendor: {
      name:      vendor_company,
      role_id:   vendor_role.id,
      entity_id: vendor_role.entity_id,
    },
  },
  fixtures: created.map do |rec, purpose|
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
  end,
}
File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

puts ''
puts '--- TANGO-4 fixtures ---'
puts "Product:   #{product.name} (id=#{product.id}, classification: #{classification})"
puts "Vendor:    #{vendor_company || 'unknown'} (role_id=#{vendor_role.id})"
puts ''
created.each do |p, _purpose|
  puts "  [#{p.id.to_s.rjust(6)}] #{p.name}  #{p.pricing_type} $#{p.base_price}  prevent_price_modification=#{p.prevent_price_modification}"
end
puts ''
puts "Manifest:  #{MANIFEST_PATH}"
puts "Re-run safely with: npm run seed:enforcement-toggle"
