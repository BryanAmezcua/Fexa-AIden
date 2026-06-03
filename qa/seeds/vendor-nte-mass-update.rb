# Idempotent test fixtures for the Vendor NTE mass-manage flow (TANGO-44).
#
# Creates QA-tagged work orders + assignments wired to a single vendor so a
# Playwright spec can:
#   1. Navigate to the Assignments grid filtered by description "[QA] TANGO-44"
#   2. Drive the mass-manage Updater dialog, picking "Vendor NTE" as the field
#   3. Apply different amounts and assert the per-record outcomes:
#        - existing-NTE update
#        - auto-create when no active NTE row exists
#        - no-op skip when the new amount equals the current amount
#        - permission denied (alt user lacking Workorders::SubcontractorNotToExceed update)
#        - user-limit cap exceeded (alt user with low vendor_nte_amount limit)
#        - workflow restriction (status transition requiring approval)
#
# Two dedicated QA users are seeded:
#   - qa.tango44.nte_denied@fexa.io
#       permission_group: Corporate User - Level 3 (NTE read-only, Assignment edit)
#   - qa.tango44.nte_limited@fexa.io
#       permission_group: Corporate User - Level 1 (full NTE access)
#       vendor_nte_amount limit: $1000 USD
#
# Both share password 'qa-tango-44-pass1' for dynamic login in the spec.
#
# Run via: npm run seed:vendor-nte-mass-update

require 'json'

DESCRIPTION_PREFIX = '[QA] TANGO-44'.freeze   # used by the grid filter in the spec
WO_DESCRIPTIONS = {
  update:     "#{DESCRIPTION_PREFIX} update target — existing NTE",
  autocreate: "#{DESCRIPTION_PREFIX} auto-create target — no active NTE",
  noop:       "#{DESCRIPTION_PREFIX} no-op target — amount matches new value",
  limited:    "#{DESCRIPTION_PREFIX} user-limit target — entered amount trips cap",
  denied:     "#{DESCRIPTION_PREFIX} permission-denied target — alt user lacks NTE update",
}.freeze

QA_PASSWORD = 'qa-tango-44-pass1'.freeze
DENIED_EMAIL  = 'qa.tango44.nte_denied@fexa.io'.freeze
LIMITED_EMAIL = 'qa.tango44.nte_limited@fexa.io'.freeze

VENDOR_USER_EMAIL = 'subcontractor_user3083@fexa.io'.freeze

# --- Step 0: bootstrap ------------------------------------------------------

admin_user = User.find_by( email: 'bigbrother@fexa.io' )
abort "Aborting: admin user 'bigbrother@fexa.io' missing." unless admin_user

# Use the admin's organization as the operating org (the demo-data "site-owning" client).
client_org = admin_user.organization
abort "Aborting: admin user has no organization." unless client_org

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

facility = Facilities::Facility.order( :id ).first
abort "Aborting: no Facilities::Facility found." unless facility

internal_employee = Roles::EntityRole::InternalEmployeeRole.find_by(
  entity_id: admin_user.person_id, active: true,
)
abort "Aborting: could not resolve admin's InternalEmployeeRole (person_id=#{admin_user.person_id.inspect})." unless internal_employee

# --- Step 1: clean up prior fixtures ---------------------------------------

prior_wos = Workorders::Workorder.where(
  'description LIKE ?', "#{DESCRIPTION_PREFIX}%"
).order( :id )
puts "Removing #{prior_wos.count} prior [QA] TANGO-44 workorder(s)..."
prior_wos.each do |wo|
  # destroy_all on assignments → cascades to subcontractor_not_to_exceeds via dependent
  wo.assignments.destroy_all
  wo.destroy
end

# Idempotency: keep the QA users across runs but reset their permission state. The
# linked Person/Role rows persist so prior Mass Updates that point at them remain
# inspectable.
[ DENIED_EMAIL, LIMITED_EMAIL ].each do |email|
  if ( u = User.find_by( email: email ) )
    Permissions::UserLimit.where( user_id: u.id, field_name: :vendor_nte_amount ).delete_all
  end
end

# Stale saved-list cleanup. Earlier seed iterations left rows with
# created_by=1 (the rails-runner Thread.current default) that the API filters
# from view because they're not owned by any listed user. Remove every
# previous QA list so the new run's lists are the only ones visible.
prior_lists = Lists::List.where( 'name LIKE ?', '%TANGO-44%' )
puts "Removing #{prior_lists.count} prior TANGO-44 saved list(s)..."
prior_lists.destroy_all

# --- Step 2: dedicated QA users --------------------------------------------

# Custom permission group for nte_denied: clones Corporate Level 3 (which
# has Workorders::Assignment update + can_view_assignments_grid but NO
# Workorders::SubcontractorNotToExceed update) and ADDS Lists::MassUpdate
# create — so the user can enter the mass-update flow yet still hit a
# per-record NTE permission denial (AC #7 / AC #11).
TANGO_44_DENIED_GROUP_NAME = '[QA] TANGO-44 Asn-edit No-NTE'.freeze

denied_pg = Permissions::Group.find_by( name: TANGO_44_DENIED_GROUP_NAME )
unless denied_pg
  source_pg = Permissions::Group.find_by!( name: 'Corporate User - Level 3' )
  source_set = Permissions::Set.where( permission_group_id: source_pg.id ).first!

  denied_pg = Permissions::Group.create!(
    name:                  TANGO_44_DENIED_GROUP_NAME,
    description:           'QA-only — clone of Corporate Level 3 with Lists::MassUpdate create granted. Drives the TANGO-44 AC #7 / #11 NTE-permission-denied scenario.',
    internal_description:  'Auto-created by seeds/vendor-nte-mass-update.rb; safe to delete when TANGO-44 QA fixtures are dropped.',
    internal_name:         'QA — Asn Edit No NTE',
    role_type:             source_pg.role_type,
  )
  denied_set = Permissions::Set.create!( name: TANGO_44_DENIED_GROUP_NAME, permission_group_id: denied_pg.id )

  # Mirror every Resource + Adjunct grant from the source set.
  Permissions::Resource.where( permission_set_id: source_set.id ).find_each do |r|
    Permissions::Resource.create!(
      action:           r.action,
      resource:         r.resource,
      can:              r.can,
      cannot:           r.cannot,
      permission_set_id: denied_set.id,
      sql_string:        r.sql_string,
      sql_args:          r.sql_args,
      instance_methods:  r.instance_methods,
      instance_operators: r.instance_operators,
      instance_values:   r.instance_values,
    )
  end
  Permissions::Adjunct.where( permission_set_id: source_set.id ).find_each do |a|
    Permissions::Adjunct.create!( name: a.name, permission_set_id: denied_set.id )
  end

  # ADD Lists::MassUpdate create so the mass-update flow can be entered.
  unless Permissions::Resource.where( permission_set_id: denied_set.id, resource: 'Lists::MassUpdate', action: 'create' ).exists?
    Permissions::Resource.create!(
      action:           'create',
      resource:         'Lists::MassUpdate',
      can:              true,
      permission_set_id: denied_set.id,
    )
  end
end
limited_pg = Permissions::Group.find_by!( name: 'Corporate User - Level 1' )  # NTE manage + high limit

def find_or_make_qa_user!( email:, password:, organization_id:, permission_group_id: )
  user = User.find_by( email: email )
  if user
    user.update!(
      active:              true,
      password:            password,
      organization_id:     organization_id,
      permission_group_id: permission_group_id,
    )
    return user
  end

  # Mirror end-user-customer pattern: minimal Person attached so post-login
  # `current_user.role` resolves.
  person_addr = Addresses::GeneralAddress.create!(
    first_name:      'QA',
    last_name:       email.split( '@' ).first,
    address1:        '1 QA Way',
    city:            'Haddon Heights',
    state:           'NJ',
    country:         'US',
    postal_code:     '08035',
    phone:           '0000000000',
    address_name:    'QA',
    default_address: true,
    active:          true,
  )
  person = Entities::Person.create!( general_addresses: [ person_addr ] )

  Roles::EntityRole::InternalEmployeeRole.create!(
    start_date:             Time.now,
    active:                 true,
    entity_id:              person.id,
    organization_entity_id: organization_id,
  )

  User.create!(
    active:              true,
    email:               email,
    password:            password,
    organization_id:     organization_id,
    person_id:           person.id,
    permission_group_id: permission_group_id,
  )
end

nte_denied_user = find_or_make_qa_user!(
  email:               DENIED_EMAIL,
  password:            QA_PASSWORD,
  organization_id:     client_org.id,
  permission_group_id: denied_pg.id,
)

nte_limited_user = find_or_make_qa_user!(
  email:               LIMITED_EMAIL,
  password:            QA_PASSWORD,
  organization_id:     client_org.id,
  permission_group_id: limited_pg.id,
)

Permissions::UserLimit.create!(
  user_id:    nte_limited_user.id,
  field_name: :vendor_nte_amount,
  amount:     1000.00,
  currency:   'USD',
)

# --- Step 3: workflow restriction notice -----------------------------------
#
# AC #11 lists "Workflow restriction (e.g., pending approval)" as one of the
# surfaced reasons. validate_workflow_restriction in mass_update.rb only fires
# when the update payload includes object_state_attributes.status_id — i.e. the
# user must select BOTH "Vendor NTE" AND "Status" in mass-manage, with the
# chosen status needing approval.
#
# The demo-data DB this seed runs against has zero approval rules on
# Workorders::Assignment (Administration::ApprovalRule.pluck(:source).uniq =>
# ["Invoices::SubcontractorInvoice"]), so we cannot exercise that path
# end-to-end without first seeding an approval rule + definition. The Playwright
# spec documents this as an AC #11 deviation; the workflow-restriction unit
# coverage lives in test/models/lists/mass_update_test.rb (extended in
# TANGO-44 commit 1b3f8bd0f8) and remains the source of truth for that branch.
workflow_restriction_notice = 'AC #11 workflow-restriction reason not exercisable in this demo DB (no approval rules on Workorders::Assignment). Covered by merged minitest suite.'

# --- Step 4: helper to create a QA workorder + assignment ------------------

def create_qa_assignment!( description:, facility:, vendor_role:, end_user_customer_role:, workorder_class:, priority:, category:, category_problem:, internal_employee:, nte_amount:, nte_active: true )
  Workorders::Workorder.skip_callback(:save, :after, :check_for_assignment) rescue nil

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
    scope:                    '[QA] TANGO-44 mass-update scope',
    category_id:              category.id,
    spoke_with:               'QA',
    initial_arrival_deadline: Time.now + 1.day,
  )

  # Auto-created active NTE record — set the seed value, or deactivate it
  # entirely for the auto-create scenario.
  nte = asn.subcontractor_not_to_exceed
  if nte
    if nte_active
      nte.update!( amount: nte_amount, active: true )
    else
      nte.update!( active: false )
    end
  elsif nte_active
    Workorders::SubcontractorNotToExceed.create!(
      assignment_id: asn.id,
      amount:        nte_amount,
      active:        true,
    )
  end

  { workorder: wo, assignment: asn.reload, nte: asn.subcontractor_not_to_exceed }
end

# --- Step 5: create the fixture set ----------------------------------------

NEW_AMOUNT = 250.00.freeze         # what the spec enters in the Vendor NTE field
NOOP_AMOUNT = NEW_AMOUNT.freeze    # matches NEW_AMOUNT → triggers no-op
LIMITED_AMOUNT = 5000.00.freeze    # tips the nte_limited_user's $1000 cap

fixtures_in = {
  update:     { nte_amount:  50.00, nte_active: true  },
  autocreate: { nte_amount:   0.00, nte_active: false },
  noop:       { nte_amount: NOOP_AMOUNT, nte_active: true },
  limited:    { nte_amount: 100.00, nte_active: true  },
  denied:     { nte_amount:  75.00, nte_active: true  },
}.freeze
# Note: the `:workflow` fixture is intentionally absent — see Step 3.

created = {}
fixtures_in.each do |key, attrs|
  created[ key ] = create_qa_assignment!(
    description:            WO_DESCRIPTIONS[ key ],
    facility:               facility,
    vendor_role:            vendor_role,
    end_user_customer_role: end_user_customer_role,
    workorder_class:        workorder_class,
    priority:               priority,
    category:               category,
    category_problem:       category_problem,
    internal_employee:      internal_employee,
    nte_amount:             attrs[ :nte_amount ],
    nte_active:             attrs[ :nte_active ],
  )
  puts "  ✓ #{key.to_s.ljust(11)}  WO=#{created[key][:workorder].id}  Asn=#{created[key][:assignment].id}  NTE=#{created[key][:nte]&.amount&.to_s || '<inactive>'}"
end

# --- Step 6: saved Lists::List (mass-manage requires saved-list context) ---
#
# Updater.js init() bails when `grid.up().listData` is empty — the mass-manage
# button only renders for assignments viewed from a saved list. We create one
# private list per relevant user (admin / nte_denied / nte_limited) so each
# spec scenario can navigate to its own list via `#listassignments/<list_id>`.
#
# Filter narrows to `assignments.scope ilike '%[QA] TANGO-44%'` (the
# dynamic_index condition in assignments_controller.rb does substring match
# regardless of operator), so the list always contains exactly the five QA
# fixtures created above.

ASSIGNMENT_SCOPE = '[QA] TANGO-44 mass-update scope'.freeze
LIST_NAME = '[QA] TANGO-44 Vendor NTE Mass Update'.freeze

def find_or_make_list!( name:, user:, scope_filter: )
  # ApplicationRecord#update_created_by overrides created_by/updated_by from
  # Thread.current[:current_user]. Impersonate the target user so the resulting
  # row passes the LISTS controller's `created_by: current_user.id` visibility
  # filter when *that* user logs in.
  prior = Thread.current[ :current_user ]
  Thread.current[ :current_user ] = user.id
  begin
    list = Lists::List.where( 'name = ? AND created_by = ?', name, user.id ).first
    attrs = {
      name:           name,
      object_type:    'listassignments',
      active:         true,
      is_shared_list: false,
      fields: {
        'filterName'        => name,
        'assignment_scope'  => scope_filter,
      },
      filters: {
        'filters' => [
          { 'value' => scope_filter, 'operator' => 'eq', 'property' => 'assignment_scope' },
        ],
      },
      column_configuration: [],
      sort_order:            [],
    }
    if list
      list.update!( attrs )
    else
      list = Lists::List.create!( attrs )
    end
    # Defense-in-depth — if the impersonation didn't stick (e.g. before_create
    # short-circuited because current_logged_user_id read elsewhere), force
    # created_by + updated_by to the intended owner.
    list.update_columns( created_by: user.id, updated_by: user.id ) if list.created_by != user.id
    list
  ensure
    Thread.current[ :current_user ] = prior
  end
end

lists_by_user = {
  admin:       find_or_make_list!( name: LIST_NAME, user: admin_user,       scope_filter: ASSIGNMENT_SCOPE ),
  nte_denied:  find_or_make_list!( name: LIST_NAME, user: nte_denied_user,  scope_filter: ASSIGNMENT_SCOPE ),
  nte_limited: find_or_make_list!( name: LIST_NAME, user: nte_limited_user, scope_filter: ASSIGNMENT_SCOPE ),
}

# --- Step 7: emit manifest --------------------------------------------------

TANGO_ROOT    = File.expand_path( '..', __dir__ )
MANIFEST_PATH = File.join( TANGO_ROOT, 'reports', 'seed-manifest-tango-44.json' )
FileUtils.mkdir_p( File.dirname( MANIFEST_PATH ) )

vendor_company = vendor_user.organization&.default_dispatch_address&.company rescue nil

manifest = {
  generated_at: Time.now.iso8601,
  ticket:       'TANGO-44',
  source_seed:  'seeds/vendor-nte-mass-update.rb',
  description:  'QA-tagged Workorders + Assignments for the Vendor NTE mass-manage flow. Includes update / auto-create / no-op / permission-denied / user-limit / workflow scenarios.',
  scope: {
    description_prefix: DESCRIPTION_PREFIX,
    workorder_class: { id: workorder_class.id, name: workorder_class.name },
    vendor: {
      name:      vendor_company,
      role_id:   vendor_role.id,
      entity_id: vendor_role.entity_id,
    },
    facility: {
      id:   facility.id,
      name: facility.respond_to?(:name) ? facility.name : nil,
    },
    workflow_restriction_notice: workflow_restriction_notice,
    new_amount:      NEW_AMOUNT,
    noop_amount:     NOOP_AMOUNT,
    limited_amount:  LIMITED_AMOUNT,
  },
  users: {
    admin: {
      email:           admin_user.email,
      saved_list_id:   lists_by_user[ :admin ].id,
      saved_list_name: lists_by_user[ :admin ].name,
      purpose:         'Default super-admin driver for happy-path scenarios.',
    },
    nte_denied: {
      email:           DENIED_EMAIL,
      password:        QA_PASSWORD,
      saved_list_id:   lists_by_user[ :nte_denied ].id,
      saved_list_name: lists_by_user[ :nte_denied ].name,
      permission_group: TANGO_44_DENIED_GROUP_NAME,
      purpose:         "Has Lists::MassUpdate create + Workorders::Assignment update but NO Workorders::SubcontractorNotToExceed update. Drives the AC #7 per-record NTE-permission-denied scenario.",
    },
    nte_limited: {
      email:           LIMITED_EMAIL,
      password:        QA_PASSWORD,
      saved_list_id:   lists_by_user[ :nte_limited ].id,
      saved_list_name: lists_by_user[ :nte_limited ].name,
      permission_group: 'Corporate User - Level 1',
      vendor_nte_amount_limit: 1000.00,
      purpose:         'Has full NTE permission but $1000 vendor_nte_amount user-limit. Drives the AC #8 / AC #11 user-limit-exceeded scenario when LIMITED_AMOUNT ($5000) is entered.',
    },
  },
  fixtures: created.map do |key, h|
    {
      key:            key,
      workorder_id:   h[ :workorder ].id,
      description:    h[ :workorder ].description,
      assignment_id:  h[ :assignment ].id,
      vendor_role_id: h[ :assignment ].role_id,
      facility_id:    h[ :assignment ].facility_id,
      current_status: h[ :assignment ].object_state&.status&.name,
      nte: h[ :nte ] ? {
        id:       h[ :nte ].id,
        amount:   h[ :nte ].amount.to_f,
        active:   h[ :nte ].active,
        currency: h[ :nte ].respond_to?(:currency) ? h[ :nte ].currency : nil,
      } : nil,
      purpose: WO_DESCRIPTIONS[ key ],
    }
  end,
}

File.write( MANIFEST_PATH, JSON.pretty_generate( manifest ) )

puts ''
puts '--- TANGO-44 fixtures ---'
puts "Vendor:    #{vendor_company || vendor_role.id}  (role_id=#{vendor_role.id})"
puts "Facility:  #{facility.respond_to?(:name) ? facility.name : facility.id}  (id=#{facility.id})"
puts "Workflow restriction: #{workflow_restriction_notice}"
puts "Users + their saved list IDs:"
puts "  admin       = bigbrother@fexa.io                       list_id=#{lists_by_user[:admin].id}"
puts "  nte_denied  = #{DENIED_EMAIL} (pw=#{QA_PASSWORD})  list_id=#{lists_by_user[:nte_denied].id}"
puts "  nte_limited = #{LIMITED_EMAIL} (pw=#{QA_PASSWORD}, $1000 cap)  list_id=#{lists_by_user[:nte_limited].id}"
puts ''
puts "Re-run safely with: npm run seed:vendor-nte-mass-update"
puts "Manifest:  #{MANIFEST_PATH}"
