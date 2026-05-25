// qa-bot/lib/seeds.mjs — Seed script generation, execution, and cleanup
//
// Generates Ruby seed scripts, executes them via `rails runner`,
// tracks created records in a manifest for deterministic cleanup.

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TMP_DIR, RAILS_ROOT } from './config.mjs';

const QA_PREFIX = 'qa_bot_';

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

// ── Run Ruby via rails runner ────────────────────────────────────────────────

export function runRuby(rubyCode, timeout = 120000) {
  ensureTmpDir();
  const scriptPath = join(TMP_DIR, `seed_${Date.now()}.rb`);

  // Write Ruby to a temp file to avoid shell escaping issues
  writeFileSync(scriptPath, rubyCode, 'utf8');

  try {
    const isWSL = process.platform === 'linux';
    const shellCmd = `export PATH='/root/.rbenv/versions/2.7.8/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'; export RUBYOPT='-W0'; cd ${RAILS_ROOT} && bundle exec rails runner ${scriptPath} 2>&1`;
    const cmd = isWSL ? `bash -c "${shellCmd.replace(/"/g, '\\"')}"` : `wsl.exe -d Ubuntu-22.04 -e bash -c "${shellCmd.replace(/"/g, '\\"')}"`;
    const result = execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 });
    return result.trim();
  } finally {
    try { unlinkSync(scriptPath); } catch (_) {}
  }
}

// ── Generate Ruby seed script from seed definition ───────────────────────────

export function generateSeedScript(seedDef) {
  const tag = seedDef.tag;
  const email = seedDef.impersonateEmail || 'adminofall@fexa.io';

  const parts = [];

  // Preamble
  parts.push(`
# QA Bot Seed: ${tag}
# Generated: ${new Date().toISOString()}
require 'json'

include RequestSourceInfo rescue nil
self.current_request_source = :seeds rescue nil

qa_user = User.find_by!(email: '${email}')
Thread.current[:current_user] = qa_user.id

manifest = {
  tag: '${tag}',
  lists: [], users: [], permission_groups: [], permission_sets: [],
  entities: [], workorders: [], assignments: [], ntes: [],
  user_limits: [],
  adjunct_permissions_added: []
}

# Suppress noisy callbacks during seeding
begin
  Workorders::Workorder.skip_callback(:save, :after, :check_for_assignment) rescue nil
  Workorders::Workorder.skip_callback(:create, :after, :check_for_assignment) rescue nil
`);

  // Adjunct permissions — grant to the QA user's permission set
  if (seedDef.adjunctPermissions) {
    for (const ap of seedDef.adjunctPermissions) {
      parts.push(`
  # Adjunct Permission: ${ap.permission}
  # Reason: ${ap.reason || 'Required for testing'}
  _ps = qa_user.permission_group.permission_sets.first
  if _ps
    unless Permissions::Adjunct.exists?(name: '${ap.permission}', permission_set_id: _ps.id)
      _adj = Permissions::Adjunct.create!(name: '${ap.permission}', permission_set_id: _ps.id)
      manifest[:adjunct_permissions_added] << { id: _adj.id, name: '${ap.permission}', permission_set_id: _ps.id }
      $stderr.puts "Granted adjunct permission: ${ap.permission} (ID: #{_adj.id})"
    else
      $stderr.puts "Adjunct permission already present: ${ap.permission}"
    end
  else
    $stderr.puts "No permission set found for user's permission group"
  end
`);
    }
  }

  // Lists
  if (seedDef.lists) {
    for (const list of seedDef.lists) {
      parts.push(`
  # List: ${list.name}
  # Reason: ${list.reason || 'Required for testing'}
  _list = Lists::List.find_or_create_by!(
    name: '${QA_PREFIX}${tag}_${list.name}',
    object_type: '${list.objectType}'
  ) do |l|
    l.fields = ${JSON.stringify(list.fields || { filterName: `${QA_PREFIX}${tag}_${list.name}` })}
    l.filters = ${JSON.stringify(list.filters || { filters: [] })}
    l.is_shared_list = ${list.isShared ? 'true' : 'false'}
    l.permission_group_id = ${list.permissionGroupId || 'qa_user.permission_group_id'}
    l.created_by = qa_user.id
  end
  manifest[:lists] << _list.id
  $stderr.puts "Created list: #{_list.name} (ID: #{_list.id})"
`);
    }
  }

  // Permission groups + users
  if (seedDef.users) {
    for (const user of seedDef.users) {
      const pgName = `${QA_PREFIX}${tag}_${user.permGroupName || 'group'}`;
      parts.push(`
  # Permission Group: ${pgName}
  # Reason: ${user.reason || 'Test user'}
  _pg = Permissions::Group.find_or_create_by!(name: '${pgName}') do |pg|
    pg.role_type = '${user.roleType || 'Roles::EntityRole::InternalEmployeeRole'}'
  end
  manifest[:permission_groups] << _pg.id

  _ps = Permissions::Set.find_or_create_by!(
    name: '${pgName}',
    permission_group_id: _pg.id
  )
  manifest[:permission_sets] << _ps.id
`);

      // Resource permissions
      if (user.permissions) {
        for (const perm of user.permissions) {
          parts.push(`
  Permissions::Resource.find_or_create_by!(
    action: '${perm.action}',
    resource: '${perm.resource}',
    permission_set_id: _ps.id
  ) do |r|
    r.can = ${perm.can ? 'true' : 'false'}
  end
`);
        }
      }

      // Create the user
      parts.push(`
  # User: ${user.email}
  unless User.exists?(email: '${user.email}')
    _org = Roles::EntityRole::EndUserCustomerRole.first&.entity || Entities::Entity.first
    _person = Entities::Person.create!(
      addresses: [Addresses::GeneralAddress.new(
        address1: '123 QA Street', city: 'Test', state: 'TX',
        postal_code: '78201', country: 'US', phone: '555-555-0099',
        default_address: true, first_name: '${user.firstName || 'QA'}', last_name: '${user.lastName || 'Bot'}'
      )]
    )
    manifest[:entities] << _person.id

    Roles::EntityRole::InternalEmployeeRole.create!(
      entity_id: _person.id, start_date: Time.now
    ) rescue nil

    _user = User.create!(
      email: '${user.email}',
      password: '${user.password || 'testPassword1'}',
      active: true,
      person_id: _person.id,
      organization_id: _org.id,
      permission_group_id: _pg.id
    )
    manifest[:users] << _user.id
    $stderr.puts "Created user: #{_user.email} (ID: #{_user.id})"
  else
    _user = User.find_by!(email: '${user.email}')
    $stderr.puts "User already exists: ${user.email}"
  end
`);

      // User limits
      if (user.userLimits) {
        for (const ul of user.userLimits) {
          parts.push(`
  # UserLimit: ${ul.field_name} = ${ul.amount} ${ul.currency}
  _ul = Permissions::UserLimit.create!(
    user_id: _user.id,
    field_name: '${ul.field_name}',
    amount: ${ul.amount},
    currency: '${ul.currency || 'USD'}'
  )
  manifest[:user_limits] << _ul.id
  $stderr.puts "Created user limit: #{_ul.field_name} = #{_ul.amount} #{_ul.currency} (ID: #{_ul.id})"
`);
        }
      }

      // Adjunct permissions for user
      if (user.adjunctPermissions) {
        for (const apName of user.adjunctPermissions) {
          parts.push(`
  # Adjunct Permission for ${user.email}: ${apName}
  unless Permissions::Adjunct.exists?(name: '${apName}', permission_set_id: _ps.id)
    _adj = Permissions::Adjunct.create!(name: '${apName}', permission_set_id: _ps.id)
    manifest[:adjunct_permissions_added] << { id: _adj.id, name: '${apName}', permission_set_id: _ps.id }
    $stderr.puts "Granted adjunct permission to ${user.email}: ${apName} (ID: #{_adj.id})"
  end
`);
        }
      }
    }
  }

  // Assignments
  if (seedDef.assignments) {
    parts.push(`
  # Find base records for assignment creation
  _store = Facilities::Store.first
  _category = Workorders::Category.without_children.first || Workorders::Category.first
  _priority = Administration::Priority.first
  _ie_role = Roles::EntityRole::InternalEmployeeRole.first
  _sub_role = Roles::EntityRole::SubcontractorRole.first
  _wo_class = Workorders::WorkorderClass.find_by(default: true) || Workorders::WorkorderClass.first
  _euc = Roles::EntityRole::EndUserCustomerRole.first
`);

    for (const asgGroup of seedDef.assignments) {
      const count = asgGroup.count || 1;
      const purpose = asgGroup.purpose || asgGroup.reason || 'Test data';
      const descLabel = purpose || (asgGroup.withNte ? 'with NTE' : 'no NTE');
      parts.push(`
  # Assignments: ${count}x — ${purpose}
  ${count}.times do |i|
    _wo = Workorders::Workorder.new(
      placed_for: _euc.id,
      placed_by: _euc.id,
      assigned_to: _ie_role.id,
      workorder_class_id: _wo_class.id,
      priority_id: _priority.id,
      description: "${QA_PREFIX}${tag} WO #{i} (${descLabel.replace(/"/g, '\\"')})",
      category_id: _category.id,
      client_eta: Time.now + 30.days,
      no_assignment_at_creation: true
    )
    _wo.workorder_facilities.build(facility_id: _store.id)
    _wo.save!(validate: false)
    manifest[:workorders] << _wo.id

    _asg = Workorders::Assignment.create!(
      workorder_id: _wo.id,
      role_id: _sub_role.id,
      facility_id: _store.id,
      category_id: _category.id,
      workorder_class_id: _wo_class.id,
      priority_id: _priority.id
    )
    manifest[:assignments] << _asg.id
    $stderr.puts "Created assignment: #{_asg.id} (WO: #{_wo.id}, purpose: ${descLabel.replace(/"/g, '\\"')})"
`);

      if (asgGroup.withNte) {
        parts.push(`
    # Update the auto-created NTE to the desired amount (bypassing callbacks)
    _nte = _asg.subcontractor_not_to_exceed || Workorders::SubcontractorNotToExceed.find_by(assignment_id: _asg.id, active: true)
    if _nte
      _nte.update_columns(amount: ${asgGroup.nteAmount || 500.0}, active: true)
    else
      _nte = Workorders::SubcontractorNotToExceed.create!(assignment_id: _asg.id, amount: ${asgGroup.nteAmount || 500.0}, active: true)
    end
    manifest[:ntes] << _nte.id
    $stderr.puts "NTE set to ${asgGroup.nteAmount || 500.0} for assignment: #{_asg.id} (NTE ID: #{_nte.id})"
`);
      } else if (asgGroup.nteAmount === null) {
        parts.push(`
    _del_count = Workorders::SubcontractorNotToExceed.where(assignment_id: _asg.id).delete_all
    $stderr.puts "Deleted #{_del_count} NTE record(s) for assignment: #{_asg.id} — now has NO active NTE"
`);
      }

      parts.push(`  end\n`);
    }
  }

  // SSettings overrides
  if (seedDef.sSettings) {
    parts.push(`\n  # SSetting overrides\n`);
    for (const ss of seedDef.sSettings) {
      parts.push(`
  _old_${ss.key} = SSetting.get(:${ss.key}) rescue nil
  SSetting.set(${ss.key}: ${ss.value === 'true' || ss.value === true ? 'true' : ss.value === 'false' || ss.value === false ? 'false' : `'${ss.value}'`})
  manifest[:ssettings_restore] ||= []
  manifest[:ssettings_restore] << { key: '${ss.key}', old_value: _old_${ss.key} }
`);
    }
  }

  // Closing
  parts.push(`
rescue => e
  $stderr.puts "SEED ERROR: #{e.message}"
  $stderr.puts e.backtrace.first(5).join("\\n")
ensure
  Workorders::Workorder.set_callback(:save, :after, :check_for_assignment) rescue nil
  Workorders::Workorder.set_callback(:create, :after, :check_for_assignment) rescue nil
end

# Output manifest as JSON on the last line of stdout
puts manifest.to_json
`);

  return parts.join('');
}

// ── Execute seed script ──────────────────────────────────────────────────────

export function executeSeed(seedDef) {
  console.log(`  Generating seed script for ${seedDef.tag}...`);
  const script = generateSeedScript(seedDef);

  ensureTmpDir();
  const scriptPath = join(TMP_DIR, `seed_${seedDef.tag}.rb`);
  writeFileSync(scriptPath, script, 'utf8');

  console.log(`  Running seed script (this may take 30-60s)...`);
  let output;
  try {
    // Detect if we're already inside WSL or on Windows
    const isWSL = process.platform === 'linux';
    const cmd = isWSL
      ? `bash -c "export PATH='/root/.rbenv/versions/2.7.8/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'; export RUBYOPT='-W0'; cd ${RAILS_ROOT} && bundle exec rails runner ${scriptPath}"`
      : `wsl.exe -d Ubuntu-22.04 -e bash -c "export PATH='/root/.rbenv/versions/2.7.8/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'; export RUBYOPT='-W0'; cd ${RAILS_ROOT} && bundle exec rails runner ${scriptPath}"`;
    output = execSync(cmd, { encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    console.error(`  Seed execution failed: ${e.message}`);
    if (e.stderr) console.error(`  STDERR: ${e.stderr.substring(0, 500)}`);
    throw e;
  }

  // Parse manifest from last line of stdout
  const lines = output.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  let manifest;
  try {
    manifest = JSON.parse(lastLine);
  } catch (e) {
    console.error(`  Failed to parse seed manifest. Output:\n${output.substring(0, 500)}`);
    throw new Error('Seed manifest not found in output');
  }

  // Save manifest for cleanup
  const manifestPath = join(TMP_DIR, `manifest_${seedDef.tag}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`  Seed complete. Manifest saved: ${manifestPath}`);
  console.log(`  Created: ${manifest.lists?.length || 0} lists, ${manifest.assignments?.length || 0} assignments, ${manifest.ntes?.length || 0} NTEs, ${manifest.users?.length || 0} users, ${manifest.user_limits?.length || 0} user limits`);

  return manifest;
}

// ── Cleanup seeded data ──────────────────────────────────────────────────────

export function cleanup(tag) {
  const manifestPath = join(TMP_DIR, `manifest_${tag}.json`);
  if (!existsSync(manifestPath)) {
    console.log(`  No manifest found for ${tag} — skipping cleanup`);
    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  console.log(`  Cleaning up seed data for ${tag}...`);

  const cleanupScript = `
require 'json'
manifest = JSON.parse('${JSON.stringify(manifest).replace(/'/g, "\\'")}')

Thread.current[:current_user] = 1

deleted = {}

# Reverse dependency order
if manifest['user_limits']&.any?
  deleted[:user_limits] = Permissions::UserLimit.where(id: manifest['user_limits']).delete_all
end
if manifest['ntes']&.any?
  deleted[:ntes] = Workorders::SubcontractorNotToExceed.where(id: manifest['ntes']).delete_all
end
if manifest['assignments']&.any?
  deleted[:assignments] = Workorders::Assignment.where(id: manifest['assignments']).delete_all
end
if manifest['workorders']&.any?
  # Clean up workorder_facilities first
  Workorders::WorkorderFacility.where(workorder_id: manifest['workorders']).delete_all rescue nil
  deleted[:workorders] = Workorders::Workorder.where(id: manifest['workorders']).delete_all
end
if manifest['lists']&.any?
  deleted[:lists] = Lists::List.where(id: manifest['lists']).delete_all
end
if manifest['users']&.any?
  deleted[:users] = User.where(id: manifest['users']).delete_all
end
if manifest['permission_sets']&.any?
  Permissions::Resource.where(permission_set_id: manifest['permission_sets']).delete_all
  deleted[:permission_sets] = Permissions::Set.where(id: manifest['permission_sets']).delete_all
end
if manifest['permission_groups']&.any?
  deleted[:permission_groups] = Permissions::Group.where(id: manifest['permission_groups']).delete_all
end
if manifest['entities']&.any?
  Addresses::GeneralAddress.where(addressable_id: manifest['entities'], addressable_type: 'Entities::Entity').delete_all rescue nil
  Roles::EntityRole.where(entity_id: manifest['entities']).delete_all rescue nil
  deleted[:entities] = Entities::Entity.where(id: manifest['entities']).delete_all
end

# Restore SSettings
if manifest['ssettings_restore']
  manifest['ssettings_restore'].each do |ss|
    SSetting.set(ss['key'].to_sym => ss['old_value'])
  end
end

# Remove adjunct permissions that were added
if manifest['adjunct_permissions_added']&.any?
  ids = manifest['adjunct_permissions_added'].map { |a| a.is_a?(Hash) ? a['id'] : a }.compact
  deleted[:adjunct_permissions] = Permissions::Adjunct.where(id: ids).delete_all
end

puts deleted.to_json
`;

  try {
    const result = runRuby(cleanupScript, 60000);
    console.log(`  Cleanup complete: ${result}`);
  } catch (e) {
    console.error(`  Cleanup failed: ${e.message}`);
  }

  // Remove manifest file
  try { unlinkSync(manifestPath); } catch (_) {}
}
