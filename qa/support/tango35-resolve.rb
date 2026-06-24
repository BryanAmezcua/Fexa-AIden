# TANGO-35 resolver — emits the permission-resolution matrix for the three
# seeded users as a single JSON line (RESOLVE_JSON=...). Exercises the REAL
# fixed code: ApplicationController#user_permission (+ permission_resource_candidates)
# and CanCan Ability. Invoked by tests/permissions/nte-permission-inheritance.spec.ts
# via `rails runner`. Requires seeds/nte-permission-inheritance.rb to have run.
require 'json'

CH  = Administration::ClientDefaultNotToExceed
SUB = Administration::SubcontractorDefaultNotToExceed
PAR = Administration::DefaultNotToExceed
controller = Api::V1::DefaultNotToExceedsController.new

def resolves?(controller, user, klass)
  controller.define_singleton_method(:current_user) { user }
  !controller.send(:user_permission, :read, klass).nil?
end

def cancan?(user, klass)
  Ability.new(user).can?(:read, klass)
end

emails = {
  client_only: 'qa.tango35.client_only@fexa.io',
  sub_only:    'qa.tango35.sub_only@fexa.io',
  parent:      'qa.tango35.parent@fexa.io',
}

out = { users: {}, candidates: {} }
emails.each do |label, email|
  u = User.find_by(email: email)
  raise "TANGO-35 fixture user missing: #{email} (run npm run seed:nte-permission-inheritance)" unless u
  out[:users][label] = {
    user_id:     u.id,
    super_admin: u.super_admin?,
    up_client:   resolves?(controller, u, CH),
    up_sub:      resolves?(controller, u, SUB),
    up_parent:   resolves?(controller, u, PAR),
    can_client:  cancan?(u, CH),
    can_sub:     cancan?(u, SUB),
  }
end

out[:candidates] = {
  client: controller.send(:permission_resource_candidates, CH),
  string: controller.send(:permission_resource_candidates, 'Some::StringResource'),
}

puts 'RESOLVE_JSON=' + out.to_json
