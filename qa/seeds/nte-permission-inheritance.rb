# Idempotent fixtures for TANGO-35 — "Decouple Client/Subcontractor
# DefaultNotToExceed permission inheritance so granular read works on the
# workorder NTE lookup".
#
# The fix (PR #6985 / commit 7bbe09fa51) makes ApplicationController#user_permission
# resolve a permission through the STI ancestry (child -> parent) so a grant on an
# STI child (Administration::ClientDefaultNotToExceed) is honored without granting
# the parent (Administration::DefaultNotToExceed), which would also leak access to
# the sibling (Administration::SubcontractorDefaultNotToExceed).
#
# This seed creates three dedicated users, each in a custom permission group whose
# single Resource grant is read on EXACTLY one of:
#   - client_only : Administration::ClientDefaultNotToExceed         (AC #1, #2)
#   - sub_only    : Administration::SubcontractorDefaultNotToExceed  (AC #3)
#   - parent      : Administration::DefaultNotToExceed (legacy umbrella) (AC #4 no-regression)
#
# The spec exercises the REAL fixed code (ApplicationController#user_permission +
# permission_resource_candidates) and CanCan Ability against these users.
#
# Run via: npm run seed:nte-permission-inheritance

require 'json'

GROUP_PREFIX = '[QA] TANGO-35'.freeze
QA_PASSWORD  = 'qa-tango-35-pass1'.freeze

CLIENT_CLASS = 'Administration::ClientDefaultNotToExceed'.freeze
SUB_CLASS    = 'Administration::SubcontractorDefaultNotToExceed'.freeze
PARENT_CLASS = 'Administration::DefaultNotToExceed'.freeze

USERS = {
  client_only: { email: 'qa.tango35.client_only@fexa.io', resource: CLIENT_CLASS, group: "#{GROUP_PREFIX} Client-NTE read only" },
  sub_only:    { email: 'qa.tango35.sub_only@fexa.io',    resource: SUB_CLASS,    group: "#{GROUP_PREFIX} Sub-NTE read only" },
  parent:      { email: 'qa.tango35.parent@fexa.io',      resource: PARENT_CLASS, group: "#{GROUP_PREFIX} Parent-NTE read (legacy)" },
}.freeze

def hr(t); puts "\n=== #{t} ==="; end
def assert(cond, msg)
  raise "ASSERTION FAILED: #{msg}" unless cond
  puts "  ok: #{msg}"
end

# --- Step 0: bootstrap -------------------------------------------------------

admin_user = User.find_by(email: 'bigbrother@fexa.io')
abort "Aborting: admin user 'bigbrother@fexa.io' missing." unless admin_user
org_id = admin_user.organization_id
abort "Aborting: admin user has no organization." unless org_id

# Reference group to copy a valid role_type from (custom groups need one).
ref_group = Permissions::Group.find_by(name: 'Corporate User - Level 1') ||
            Permissions::Group.where.not(role_type: nil).first
ref_role_type = ref_group&.role_type

# Read-grant readable_attrs = the model's columns (full read), so the resolved
# permission carries realistic attrs. Stored on the Resource row.
READABLE = {
  CLIENT_CLASS => Administration::ClientDefaultNotToExceed.column_names,
  SUB_CLASS    => Administration::SubcontractorDefaultNotToExceed.column_names,
  PARENT_CLASS => Administration::DefaultNotToExceed.column_names,
}.freeze

# --- Step 1: person + user factory (mirrors vendor-nte-mass-update.rb) -------

def find_or_make_qa_user!(email:, password:, organization_id:, permission_group_id:)
  user = User.find_by(email: email)
  if user
    user.update!(active: true, password: password, organization_id: organization_id, permission_group_id: permission_group_id)
    return user
  end
  person_addr = Addresses::GeneralAddress.create!(
    first_name: 'QA', last_name: email.split('@').first,
    address1: '1 QA Way', city: 'Haddon Heights', state: 'NJ', country: 'US',
    postal_code: '08035', phone: '0000000000', address_name: 'QA',
    default_address: true, active: true,
  )
  person = Entities::Person.create!(general_addresses: [person_addr])
  Roles::EntityRole::InternalEmployeeRole.create!(
    start_date: Time.now, active: true, entity_id: person.id, organization_entity_id: organization_id,
  )
  User.create!(
    active: true, email: email, password: password,
    organization_id: organization_id, person_id: person.id, permission_group_id: permission_group_id,
  )
end

# --- Step 2: build the three single-grant groups + users --------------------

results = {}
USERS.each do |key, cfg|
  hr "#{key} — read on #{cfg[:resource]}"

  group = Permissions::Group.find_by(name: cfg[:group])
  unless group
    group = Permissions::Group.create!(
      name: cfg[:group],
      description: "QA-only (TANGO-35): single Resource grant 'read' on #{cfg[:resource]}. Safe to delete when TANGO-35 QA fixtures are dropped.",
      internal_description: 'Auto-created by seeds/nte-permission-inheritance.rb.',
      internal_name: "QA T35 #{key}",
      role_type: ref_role_type,
    )
  end

  set = Permissions::Set.find_by(permission_group_id: group.id) ||
        Permissions::Set.create!(name: cfg[:group], permission_group_id: group.id)

  # Reset grants on this set so re-runs yield EXACTLY one read grant.
  Permissions::Resource.where(permission_set_id: set.id).delete_all
  grant = Permissions::Resource.create!(
    action: 'read', resource: cfg[:resource], can: true,
    readable_attrs: READABLE[cfg[:resource]],
    permission_set_id: set.id,
  )

  user = find_or_make_qa_user!(email: cfg[:email], password: QA_PASSWORD, organization_id: org_id, permission_group_id: group.id)
  user.reload

  # Fail-fast wiring assertions: the user must resolve EXACTLY this one grant.
  rp = user.resource_permissions.to_a
  assert(rp.size == 1, "#{key}: user resolves exactly 1 resource_permission (got #{rp.size})")
  assert(rp.first.resource == cfg[:resource] && rp.first.action == 'read' && rp.first.can,
         "#{key}: the single grant is read/can on #{cfg[:resource]}")
  assert(!user.super_admin?, "#{key}: user is NOT super_admin (so permission checks are exercised)")

  results[key] = { email: cfg[:email], user_id: user.id, group_id: group.id, set_id: set.id, grant_id: grant.id, resource: cfg[:resource] }
end

# --- Step 3: manifest --------------------------------------------------------

TANGO_ROOT    = File.expand_path('..', __dir__)
MANIFEST_PATH = File.join(TANGO_ROOT, 'reports', 'seed-manifest-tango-35.json')
FileUtils.mkdir_p(File.dirname(MANIFEST_PATH))
File.write(MANIFEST_PATH, JSON.pretty_generate(
  generated_at: Time.now.iso8601,
  ticket: 'TANGO-35',
  source_seed: 'seeds/nte-permission-inheritance.rb',
  description: 'Three dedicated users each in a custom permission group whose single Resource grant is read on exactly one of the Client child / Subcontractor child / parent DefaultNotToExceed classes. Used to verify STI-aware permission resolution (PR #6985).',
  scope: {
    classes: { client: CLIENT_CLASS, subcontractor: SUB_CLASS, parent: PARENT_CLASS },
    password: QA_PASSWORD,
  },
  fixtures: results.map do |label, v|
    {
      id:      v[:user_id],
      name:    "#{v[:email]}  [#{label}]",
      active:  true,
      purpose: "Permission group with a single 'read' grant on #{v[:resource]} (group_id=#{v[:group_id]}, set_id=#{v[:set_id]}).",
    }
  end,
))

hr 'TANGO-35 fixtures'
results.each { |k, v| puts "  #{k.to_s.ljust(12)} #{v[:email]}  user_id=#{v[:user_id]}  grant=read #{v[:resource]}" }
puts "\nManifest: #{MANIFEST_PATH}"
puts "Re-run safely with: npm run seed:nte-permission-inheritance"
