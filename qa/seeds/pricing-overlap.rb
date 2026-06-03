# Idempotent test fixtures for the ProductPricing overlap-warning scenarios.
#
# Run from this project via:
#   npm run seed:pricing-overlap
#
# Or directly:
#   cd <fexy-zamo-root>
#   DISABLE_SPRING=1 bundle exec rails runner /absolute/path/to/TANGO/seeds/pricing-overlap.rb
#
# What this creates:
#   Four Products::SubcontractorProductPricing rows, all on the same
#   (product, vendor role) scope. Tests drive the UI to create *new*
#   pricings that collide (or don't) with these baselines, then assert
#   the warning behavior described in the acceptance criteria.
#
# All fixture names are prefixed "Overlap Scenario - " so this script
# can locate and replace them on re-run without touching real seed data.

FIXTURE_PREFIX = 'Overlap Scenario - '.freeze

# Legacy QA test data prefixes — created by prior, unrelated test setups
# that pre-dated TANGO. Removed on every seed run so the pricings grid
# only shows data this harness owns.
LEGACY_PREFIXES = [ '[TANGO-3]%', '[TANGO-5 SEED]%' ].freeze

# --- Clean up legacy QA seed data ---
#
# Delete order matters because of FK constraints:
#   1. ProductPricing rows (reference product_id + product_classification_id)
#   2. Product rows (referenced by ProductPricing)
#   3. ProductClassification rows (referenced by ProductPricing.product_classification_id)
# Wrapped in a transaction so a partial failure leaves no orphans.

ActiveRecord::Base.transaction do
  legacy_pricings = Products::ProductPricing.where(
    LEGACY_PREFIXES.map { 'name LIKE ?' }.join(' OR '),
    *LEGACY_PREFIXES,
  )
  pricings_removed = legacy_pricings.destroy_all.size
  puts "Removed #{pricings_removed} legacy QA pricing(s)."

  legacy_products = Products::Product.where(
    LEGACY_PREFIXES.map { 'name LIKE ?' }.join(' OR '),
    *LEGACY_PREFIXES,
  )
  products_removed = legacy_products.destroy_all.size
  puts "Removed #{products_removed} legacy QA product(s)."

  legacy_classifications = Products::ProductClassification.where(
    LEGACY_PREFIXES.map { 'name LIKE ?' }.join(' OR '),
    *LEGACY_PREFIXES,
  )
  classifications_removed = legacy_classifications.destroy_all.size
  puts "Removed #{classifications_removed} legacy QA classification(s)."
end

# --- Look up prerequisites from the existing seeded retailers_demo_data ---

product = Products::Product.find_by( name: 'Regular Rate' )
abort "Aborting: no Products::Product named 'Regular Rate'. Run retailers_demo_data seeds first." unless product

subcontractor_role = Roles::EntityRole::SubcontractorRole
  .joins( 'INNER JOIN entities ON entities.id = roles.entity_id' )
  .where( active: true )
  .order( :id )
  .first
abort "Aborting: no active SubcontractorRole found. Run retailers_demo_data seeds first." unless subcontractor_role

facility = Facilities::Store.order( :id ).first
abort "Aborting: no Facilities::Store records found." unless facility

# --- Clean slate (idempotent re-runs) ---

removed = Products::SubcontractorProductPricing
  .where( 'name LIKE ?', "#{FIXTURE_PREFIX}%" )
  .destroy_all
  .size
puts "Removed #{removed} prior fixture pricing(s)."

# --- Recreate baselines ---

today = Date.current
common = {
  product_id: product.id,
  product_classification_id: product.product_classification_id,
  role_id: subcontractor_role.id,
  pricing_type: 'Flat Rate',
  base_price: 150,
  currency: SSetting.get( :home_currency ),
}

# `purpose` is metadata for the seed manifest only — it's NOT a column on
# the model. Deleted from attrs before create!.
baselines = [
  {
    name: "#{FIXTURE_PREFIX}Baseline Annual",
    active: true,
    effective_start_date: today.beginning_of_year,
    effective_end_date:   today.end_of_year,
    purpose: 'Active baseline covering the entire current year. Most overlap scenarios trigger against this fixture.',
  },
  {
    name: "#{FIXTURE_PREFIX}Future Window",
    active: true,
    effective_start_date: today.next_year.beginning_of_year,
    effective_end_date:   today.next_year.end_of_year,
    purpose: "Active pricing in the year AFTER Baseline Annual. Used to verify that non-overlapping date ranges are NOT flagged (Scope #2).",
  },
  {
    name: "#{FIXTURE_PREFIX}Deactivated",
    active: false,
    effective_start_date: today.beginning_of_year,
    effective_end_date:   today.end_of_year,
    purpose: "Inactive pricing overlapping Baseline Annual's window. Used to verify that deactivated pricings are EXCLUDED from overlap detection (Edge #2).",
  },
  {
    name: "#{FIXTURE_PREFIX}Facility Scoped",
    active: true,
    effective_start_date: today.beginning_of_year,
    effective_end_date:   today.end_of_year,
    facility_id: facility.id,
    purpose: "Active pricing scoped to a specific facility (id=#{facility.id}). Used to verify overlap detection IGNORES facility scope in MVP (Scope #3).",
  },
]

created = baselines.map do |attrs|
  purpose = attrs.delete( :purpose )
  record  = Products::SubcontractorProductPricing.create!( common.merge( attrs ) )
  [ record, purpose ]
end

# Look up human-readable names for the manifest. Best-effort — fall back
# to IDs if a lookup fails.
vendor_name           = subcontractor_role.entity&.default_dispatch_address&.company rescue nil
classification_name   = Products::ProductClassification.find_by( id: product.product_classification_id )&.name rescue nil

# Write a JSON manifest the QA reporter can render in its "Test setup" section.
# Path is derived from the seed file's location so it works regardless of
# the rails runner's cwd.
require 'json'
TANGO_ROOT    = File.expand_path( '..', __dir__ )
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-3.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-3',
  source_seed:  'seeds/pricing-overlap.rb',
  description:  'Baseline pricings for TANGO-3 overlap warning test scenarios',
  scope: {
    product: {
      id:             product.id,
      name:           product.name,
      classification: classification_name,
      product_classification_id: product.product_classification_id,
    },
    vendor: {
      name:      vendor_name,
      role_id:   subcontractor_role.id,
      entity_id: subcontractor_role.entity_id,
    },
    facility: {
      id:         facility.id,
      identifier: facility.identifier,
    },
    currency:     common[ :currency ],
    pricing_type: common[ :pricing_type ],
    base_price:   common[ :base_price ].to_s,
  },
  fixtures: created.map do |rec, purpose|
    {
      id:                   rec.id,
      name:                 rec.name,
      active:               rec.active,
      effective_start_date: rec.effective_start_date&.iso8601,
      effective_end_date:   rec.effective_end_date&.iso8601,
      facility_id:          rec.facility_id,
      purpose:              purpose,
    }
  end
}
File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

puts ''
puts '--- Created fixtures ---'
puts "Product:        #{product.name} (id=#{product.id}, classification: #{classification_name || 'unknown'})"
puts "Vendor:         #{vendor_name || 'unknown'} (role_id=#{subcontractor_role.id}, entity_id=#{subcontractor_role.entity_id})"
puts "Facility:       #{facility.identifier} (id=#{facility.id})"
puts ''
created.each do |p, _purpose|
  puts "  [#{p.id.to_s.rjust(6)}] #{p.name}  active=#{p.active}  #{p.effective_start_date}..#{p.effective_end_date}#{p.facility_id ? "  facility=#{p.facility_id}" : ''}"
end
puts ''
puts "Manifest written: #{MANIFEST_PATH}"
puts "Re-run safely with: npm run seed:pricing-overlap"
