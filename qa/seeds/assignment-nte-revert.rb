# Idempotent test fixtures for the stale-NTE-overwrite fix (TANGO-78).
#
# Creates QA-tagged work orders + assignments (each with a known active
# SubcontractorNotToExceed amount) so a Playwright spec can:
#   1. Open a Work Order Overview and hold it (stale) in the browser
#   2. Mutate the assignment NTE server-side via rails runner — exactly the
#      write proposal approval performs (update_attribute on the same row)
#   3. Edit an UNRELATED field on the assignment sheet and save
#   4. Assert the server-side NTE amount survives (payload omitted the NTE)
#   5. Assert the edit sheet re-fetches and shows the fresh amount on open
#   6. Assert a deliberate NTE edit still persists to the SAME row
#
# One fixture per persona project (fullyParallel: the three Playwright
# projects run concurrently, so they must not share mutable NTE state):
#   core_admin / core_vendor / core_fm — the stale-echo scenario
#   edit — admin-only fresh-on-open + deliberate-edit + no-op scenarios
#
# The assignment vendor is the QA vendor org (subcontractor_user3083) so the
# vendor persona can see its fixture. The FM fixture uses a facility derived
# from facility_manager1's role when derivable; access is runtime-guarded in
# the spec otherwise.
#
# Run via: npm run seed:assignment-nte-revert

require 'json'

DESCRIPTION_PREFIX = '[QA] TANGO-78'.freeze
SEED_NTE_AMOUNT    = 100.00        # every fixture starts here

WO_DESCRIPTIONS = {
  core_admin:  "#{DESCRIPTION_PREFIX} stale-echo target — admin persona",
  core_vendor: "#{DESCRIPTION_PREFIX} stale-echo target — vendor persona",
  core_fm:     "#{DESCRIPTION_PREFIX} stale-echo target — facility-manager persona",
  edit:        "#{DESCRIPTION_PREFIX} edit target — fresh-on-open + deliberate NTE edit",
  merge:       "#{DESCRIPTION_PREFIX} refetch-merge target — category/status integrity on sheet open",
}.freeze

# Separate bare WO (no assignment): the create-flow spec attaches a UI-built
# phantom assignment to it via store.sync, mirroring CreateController#saveAssignments.
CREATE_FLOW_DESCRIPTION = "#{DESCRIPTION_PREFIX} create-flow sync target — assignment attaches via store.sync".freeze

VENDOR_USER_EMAIL = 'subcontractor_user3083@fexa.io'.freeze
FM_USER_EMAIL     = 'facility_manager1@fexa.io'.freeze

# --- Step 0: bootstrap ------------------------------------------------------

admin_user = User.find_by( email: 'bigbrother@fexa.io' )
abort "Aborting: admin user 'bigbrother@fexa.io' missing." unless admin_user

vendor_user = User.find_by( email: VENDOR_USER_EMAIL )
abort "Aborting: vendor user '#{VENDOR_USER_EMAIL}' missing — re-seed retailers_demo_data." unless vendor_user

vendor_role = Roles::EntityRole::SubcontractorRole.find_by(
  entity_id: vendor_user.organization_id, active: true,
)
abort "Aborting: no active SubcontractorRole for vendor org #{vendor_user.organization_id}." unless vendor_role

end_user_customer_role_id = SSetting.get( :site_end_user_customer_id )
end_user_customer_role    = Roles::EntityRole::EndUserCustomerRole.find_by( id: end_user_customer_role_id )
abort "Aborting: SSetting site_end_user_customer_id is unset/invalid." unless end_user_customer_role

workorder_class = Workorders::WorkorderClass.where( active: true ).order( :id ).first
abort "Aborting: no active Workorders::WorkorderClass found." unless workorder_class

priority = Administration::Priority.order( :id ).first
abort "Aborting: no Administration::Priority found." unless priority

category = Workorders::Category.where.not( category: nil ).order( :id ).first
abort "Aborting: no Workorders::Category found." unless category
category_problem = category.category_problems.order( :id ).first
abort "Aborting: category '#{category.category}' has no problems." unless category_problem

# For the refetch-merge fixture prefer a CHILD category (has a parent) so the
# model's category convert produces the joined "Parent | Child" string — the
# exact value the non-idempotent convert corrupts when re-run on itself.
merge_category = Workorders::Category.where.not( parent_id: nil ).order( :id ).first || category

facility = Facilities::Facility.order( :id ).first
abort "Aborting: no Facilities::Facility found." unless facility

internal_employee = Roles::EntityRole::InternalEmployeeRole.find_by(
  entity_id: admin_user.person_id, active: true,
)
abort "Aborting: no active InternalEmployeeRole for admin person #{admin_user.person_id}." unless internal_employee

# FM fixture facility: prefer a facility the FM role can actually reach.
fm_facility = facility
fm_user = User.find_by( email: FM_USER_EMAIL )
if fm_user
  fm_role = Roles::Role.where( entity_id: [ fm_user.organization_id, fm_user.person_id ].compact, active: true )
                       .where( "type LIKE '%FacilityManagerRole%'" ).first
  if fm_role.respond_to?( :facilities ) && fm_role.facilities&.first
    fm_facility = fm_role.facilities.first
  end
end

# --- Step 1: clean up prior fixture runs ------------------------------------

Workorders::Workorder.where( "description LIKE ?", "#{DESCRIPTION_PREFIX}%" ).find_each do |wo|
  # destroy_all on assignments → cascades to subcontractor_not_to_exceeds
  wo.assignments.destroy_all
  wo.destroy
end

# --- Step 2: helper to create a QA workorder + assignment -------------------

def create_qa_assignment!( description:, facility:, vendor_role:, end_user_customer_role:, workorder_class:, priority:, category:, category_problem:, internal_employee:, nte_amount:, assignment_category: nil )
  Workorders::Workorder.skip_callback( :save, :after, :check_for_assignment ) rescue nil

  wo = Workorders::Workorder.create!(
    placed_for:                 end_user_customer_role.id,
    placed_by:                  end_user_customer_role.id,
    assigned_to:                internal_employee.id,
    created_by:                 1,
    workorder_class_id:         workorder_class.id,
    priority_id:                priority.id,
    description:                description,
    category_problem_id:        category_problem.id,
    category_id:                category.id,
    client_eta:                 Time.now + 7.days,
    no_assignment_at_creation:  true,
    workorder_facilities_attributes: [ { facility_id: facility.id } ],
  )

  asn = Workorders::Assignment.create!(
    facility_id:              facility.id,
    created_by:               1,
    workorder_id:             wo.id,
    role_id:                  vendor_role.id,
    scope:                    "#{description} — seeded scope",
    category_id:              ( assignment_category || category ).id,
    spoke_with:               'QA',
    initial_arrival_deadline: Time.now + 1.day,
  )

  # The before_create callback auto-creates an active NTE; pin its amount.
  nte = asn.subcontractor_not_to_exceed
  if nte
    nte.update!( amount: nte_amount, active: true )
  else
    nte = Workorders::SubcontractorNotToExceed.create!(
      assignment_id: asn.id,
      amount:        nte_amount,
      active:        true,
    )
  end

  { workorder: wo, assignment: asn.reload, nte: asn.subcontractor_not_to_exceed }
end

# --- Step 3: create the fixture set -----------------------------------------

fixtures = {}
WO_DESCRIPTIONS.each do |key, description|
  fixtures[ key ] = create_qa_assignment!(
    description:            description,
    facility:               key == :core_fm ? fm_facility : facility,
    vendor_role:            vendor_role,
    end_user_customer_role: end_user_customer_role,
    workorder_class:        workorder_class,
    priority:               priority,
    category:               category,
    category_problem:       category_problem,
    internal_employee:      internal_employee,
    nte_amount:             SEED_NTE_AMOUNT,
    assignment_category:    key == :merge ? merge_category : nil,
  )
  puts "[seed] #{key}: WO ##{fixtures[key][:workorder].id} / assignment ##{fixtures[key][:assignment].id} / NTE ##{fixtures[key][:nte].id} @ $#{'%.2f' % SEED_NTE_AMOUNT}"
end

# Bare WO for the create-flow spec (no assignment — the spec adds one via the UI).
Workorders::Workorder.skip_callback( :save, :after, :check_for_assignment ) rescue nil
create_flow_wo = Workorders::Workorder.create!(
  placed_for:                 end_user_customer_role.id,
  placed_by:                  end_user_customer_role.id,
  assigned_to:                internal_employee.id,
  created_by:                 1,
  workorder_class_id:         workorder_class.id,
  priority_id:                priority.id,
  description:                CREATE_FLOW_DESCRIPTION,
  category_problem_id:        category_problem.id,
  category_id:                category.id,
  client_eta:                 Time.now + 7.days,
  no_assignment_at_creation:  true,
  workorder_facilities_attributes: [ { facility_id: facility.id } ],
)
puts "[seed] create_flow: WO ##{create_flow_wo.id} (no assignment)"

# --- Step 4: emit manifest ---------------------------------------------------

TANGO_ROOT    = ENV[ 'OLDPWD' ] && File.exist?( File.join( ENV[ 'OLDPWD' ], 'package.json' ) ) ? ENV[ 'OLDPWD' ] : File.expand_path( '..', __dir__ )
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-78.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

manifest = {
  ticket:       'TANGO-78',
  source_seed:  'seeds/assignment-nte-revert.rb',
  generated_at: Time.now.iso8601,
  scope: {
    description_prefix: DESCRIPTION_PREFIX,
    seed_nte_amount:    SEED_NTE_AMOUNT,
  },
  # Inputs the create-flow spec needs to build a valid assignment through the
  # Create Work Order UI and sync it (mirroring CreateController#saveAssignments).
  create_flow: {
    workorder_id:   create_flow_wo.id,
    facility_id:    facility.id,
    vendor_role_id: vendor_role.id,
    category_id:    category.id,
  },
  fixtures: fixtures.map do |key, f|
    {
      key:           key,
      workorder_id:  f[ :workorder ].id,
      assignment_id: f[ :assignment ].id,
      nte:           { id: f[ :nte ].id, amount: f[ :nte ].amount.to_f, active: f[ :nte ].active },
    }
  end,
}

File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )
puts "[seed] manifest written: #{MANIFEST_PATH}"
