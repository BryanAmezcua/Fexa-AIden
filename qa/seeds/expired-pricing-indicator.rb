# Idempotent test fixtures for the TANGO-2 expired-pricing-indicator scenarios.
#
# Run from this project via:
#   npm run seed:expired-pricing-indicator
#
# Or directly:
#   cd <fexy-zamo-root>
#   DISABLE_SPRING=1 bundle exec rails runner /absolute/path/to/TANGO/seeds/expired-pricing-indicator.rb
#
# What this creates:
#   Five Products::SubcontractorProductPricing rows on the same
#   (product, vendor role) scope as the overlap fixtures, each exercising a
#   distinct "Pricing Effective Date Status" outcome the admin grid must
#   render (AC #1-3) and one boundary edge (AC #5, #6):
#
#     Expired Last Year  active=true,  end < today        -> "Expired"
#     Active Future      active=true,  end = next year    -> "Active"
#     Inactive           active=false, end < today        -> "Inactive"
#     No End Date        active=true,  end = NULL          -> "Active" (never expired, AC #5)
#     Ends Today         active=true,  end = today         -> "Active" (inclusive, AC #6)
#
# All fixture names are prefixed "Expired Indicator - " so this script can
# locate and replace them on re-run without touching real seed data.

require 'json'

FIXTURE_PREFIX = 'Expired Indicator - '.freeze

# --- Clean slate (idempotent re-runs) ---

removed = Products::SubcontractorProductPricing
  .where( 'name LIKE ?', "#{FIXTURE_PREFIX}%" )
  .destroy_all
  .size
puts "Removed #{removed} prior fixture pricing(s)."

# --- Look up prerequisites from the existing seeded retailers_demo_data ---
#
# Same scope as seeds/pricing-overlap.rb: Product 'Regular Rate' on the first
# active SubcontractorRole. Reusing the scope keeps these fixtures in a known
# location in the pricings grid.

product = Products::Product.find_by( name: 'Regular Rate' )
abort "Aborting: no Products::Product named 'Regular Rate'. Run retailers_demo_data seeds first." unless product

subcontractor_role = Roles::EntityRole::SubcontractorRole
  .joins( 'INNER JOIN entities ON entities.id = roles.entity_id' )
  .where( active: true )
  .order( :id )
  .first
abort "Aborting: no active SubcontractorRole found. Run retailers_demo_data seeds first." unless subcontractor_role

# --- Recreate fixtures ---

today = Date.current
common = {
  product_id: product.id,
  product_classification_id: product.product_classification_id,
  role_id: subcontractor_role.id,
  pricing_type: 'Flat Rate',
  base_price: 150,
  currency: SSetting.get( :home_currency ),
}

# `purpose` and `expected_status` are metadata for the seed manifest only —
# they are NOT columns on the model. Deleted from attrs before create!.
fixtures = [
  {
    name: "#{FIXTURE_PREFIX}Expired Last Year",
    active: true,
    effective_start_date: today.last_year.beginning_of_year,
    effective_end_date:   today.last_year.end_of_year,
    expected_status: 'Expired',
    purpose: 'Active pricing whose effective_end_date is in the past. Must render the "Expired" indicator + status (AC #1, #2, #3).',
  },
  {
    name: "#{FIXTURE_PREFIX}Active Future",
    active: true,
    effective_start_date: today.beginning_of_year,
    effective_end_date:   today.next_year.end_of_year,
    expected_status: 'Active',
    purpose: 'Active pricing whose effective_end_date is in the future. Status = "Active"; proves expired styling is not applied to live rates (AC #3).',
  },
  {
    name: "#{FIXTURE_PREFIX}Inactive",
    active: false,
    effective_start_date: today.last_year.beginning_of_year,
    effective_end_date:   today.last_year.end_of_year,
    expected_status: 'Inactive',
    purpose: 'Inactive pricing (active=false) with a past end date. Status = "Inactive" — Inactive takes precedence over Expired (AC #3).',
  },
  {
    name: "#{FIXTURE_PREFIX}No End Date",
    active: true,
    effective_start_date: today.beginning_of_year,
    effective_end_date:   nil,
    expected_status: 'Active',
    purpose: 'Active pricing with NULL effective_end_date. Never marked expired regardless of age (AC #5).',
  },
  {
    name: "#{FIXTURE_PREFIX}Ends Today",
    active: true,
    effective_start_date: today.beginning_of_year,
    effective_end_date:   today,
    expected_status: 'Active',
    purpose: 'Active pricing whose effective_end_date is exactly today. NOT expired — boundary is inclusive (AC #6).',
  },
]

created = fixtures.map do |attrs|
  purpose         = attrs.delete( :purpose )
  expected_status = attrs.delete( :expected_status )
  record          = Products::SubcontractorProductPricing.create!( common.merge( attrs ) )
  [ record, purpose, expected_status ]
end

# Look up human-readable names for the manifest. Best-effort — fall back
# to IDs if a lookup fails.
vendor_name         = subcontractor_role.entity&.default_dispatch_address&.company rescue nil
classification_name = Products::ProductClassification.find_by( id: product.product_classification_id )&.name rescue nil

# Write a JSON manifest the QA reporter can render in its "Test setup" section.
# Path is derived from the seed file's location so it works regardless of
# the rails runner's cwd.
TANGO_ROOT    = File.expand_path( '..', __dir__ )
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-2.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-2',
  source_seed:  'seeds/expired-pricing-indicator.rb',
  description:  'Pricings spanning Active / Expired / Inactive status plus null-end-date and ends-today boundaries, for the TANGO-2 expired-indicator admin grid scenarios.',
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
    today:        today.iso8601,
    currency:     common[ :currency ],
    pricing_type: common[ :pricing_type ],
    base_price:   common[ :base_price ].to_s,
  },
  fixtures: created.map do |rec, purpose, expected_status|
    {
      id:                   rec.id,
      name:                 rec.name,
      active:               rec.active,
      effective_start_date: rec.effective_start_date&.iso8601,
      effective_end_date:   rec.effective_end_date&.iso8601,
      expected_status:      expected_status,
      purpose:              purpose,
    }
  end
}
File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

puts ''
puts '--- Created fixtures (TANGO-2) ---'
puts "Product:        #{product.name} (id=#{product.id}, classification: #{classification_name || 'unknown'})"
puts "Vendor:         #{vendor_name || 'unknown'} (role_id=#{subcontractor_role.id}, entity_id=#{subcontractor_role.entity_id})"
puts "Today:          #{today}"
puts ''
created.each do |p, _purpose, expected_status|
  end_str = p.effective_end_date ? p.effective_end_date.to_s : '<none>'
  puts "  [#{p.id.to_s.rjust(6)}] #{p.name.ljust(34)} active=#{p.active.to_s.ljust(5)} end=#{end_str.ljust(12)} => #{expected_status}"
end
puts ''
puts "Manifest written: #{MANIFEST_PATH}"
puts "Re-run safely with: npm run seed:expired-pricing-indicator"
