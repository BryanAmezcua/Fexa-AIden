/**
 * TANGO-35 — Decouple Client/Subcontractor DefaultNotToExceed permission
 * inheritance so granular read works on the workorder NTE lookup.
 *
 * This is a BACKEND AUTHORIZATION bug, not a UI feature, so it is verified at
 * the exact layer the fix changed rather than by clicking the workorder form as
 * three different narrowly-permissioned users (which the admin/vendor/fm persona
 * model doesn't support). A rails-runner (support/tango35-resolve.rb) exercises
 * the real ApplicationController#user_permission (+ permission_resource_candidates,
 * the STI ancestry walk the fix introduced) and CanCan Ability against three
 * seeded users granted read on EXACTLY one of the Client child / Subcontractor
 * child / parent class. The resolution matrix is attached as report evidence and
 * each assertion's step label carries the actual resolved values.
 *
 * Fixtures: seeds/nte-permission-inheritance.rb (npm run seed:nte-permission-inheritance).
 * Fix: PR #6985 / commit 7bbe09fa51.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as path from 'path';
import { annotateAc, TANGO_35_AC } from '../../src/support/qa-report';

const TICKET = 'TANGO-35';

test.describe('NTE permission inheritance (TANGO-35)', () => {
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(180_000);

  let data: any = null;

  test.beforeAll(() => {
    const resolver = path.resolve(__dirname, '../../support/tango35-resolve.rb');
    const fz = process.env.FEXY_ZAMO_PATH || '../Fexy-Zamo';
    const cmd = `cd "${fz}" && DISABLE_SPRING=1 RUBYOPT='-W0' bundle exec rails runner "${resolver}"`;
    const out = execSync(cmd, { cwd: process.cwd(), shell: '/bin/bash', encoding: 'utf8', timeout: 150_000 });
    const line = out.split('\n').find((l) => l.startsWith('RESOLVE_JSON='));
    if (!line) throw new Error(`resolver produced no RESOLVE_JSON line. Output:\n${out}`);
    data = JSON.parse(line.replace('RESOLVE_JSON=', ''));
  });

  test('AC#1 — read on ClientDefaultNotToExceed alone is sufficient for the Client NTE lookup', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_35_AC.Ac1ClientChildSufficient] });
    await testInfo.attach('permission-resolution-matrix', { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
    const u = data.users.client_only;
    await test.step(`Client-only user (id=${u.user_id}, super_admin=${u.super_admin}) resolves the Client NTE permission WITHOUT a parent grant: user_permission(:read, ClientDefaultNotToExceed)=${u.up_client}, Ability.can?(:read, Client)=${u.can_client}`, async () => {
      expect(u.super_admin, 'fixture user must not be super_admin (else checks are bypassed)').toBe(false);
      expect(u.up_client, 'user_permission(:read, ClientDefaultNotToExceed) resolves for a child-only grant').toBe(true);
      expect(u.can_client, 'Ability.can?(:read, ClientDefaultNotToExceed)').toBe(true);
    });
  });

  test('AC#2 — that same Client-only user CANNOT access SubcontractorDefaultNotToExceed', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_35_AC.Ac2NoSubLeak] });
    const u = data.users.client_only;
    await test.step(`Client-only user is denied the sibling: Ability.can?(:read, SubcontractorDefaultNotToExceed)=${u.can_sub}, user_permission(:read, Sub)=${u.up_sub} (both must be false — no leak)`, async () => {
      expect(u.can_sub, 'Ability.can?(:read, SubcontractorDefaultNotToExceed) is DENIED').toBe(false);
      expect(u.up_sub, 'user_permission(:read, SubcontractorDefaultNotToExceed) does not resolve').toBe(false);
    });
  });

  test('AC#3 — symmetric: read on SubcontractorDefaultNotToExceed alone is sufficient for the Vendor NTE lookup', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_35_AC.Ac3SubChildSymmetric] });
    const u = data.users.sub_only;
    await test.step(`Sub-only user (id=${u.user_id}) resolves the Sub lookup and not the Client sibling: up(Sub)=${u.up_sub}, can(Sub)=${u.can_sub}, up(Client)=${u.up_client}, can(Client)=${u.can_client}`, async () => {
      expect(u.up_sub, 'user_permission(:read, SubcontractorDefaultNotToExceed) resolves for a child-only grant').toBe(true);
      expect(u.can_sub, 'Ability.can?(:read, SubcontractorDefaultNotToExceed)').toBe(true);
      expect(u.up_client, 'sub-only user does NOT resolve Client lookup').toBe(false);
      expect(u.can_client, 'sub-only user cannot read the Client sibling').toBe(false);
    });
  });

  test('AC#4 — no regression: a user with read on the parent class still resolves BOTH lookups', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_35_AC.Ac4NoParentRegression] });
    const u = data.users.parent;
    await test.step(`Parent-read user (id=${u.user_id}) retains access to both children: up(Client)=${u.up_client}, up(Sub)=${u.up_sub}, can(Client)=${u.can_client}, can(Sub)=${u.can_sub}`, async () => {
      expect(u.up_client, 'parent-read user still resolves the Client lookup').toBe(true);
      expect(u.up_sub, 'parent-read user still resolves the Sub lookup').toBe(true);
      expect(u.can_client && u.can_sub, 'parent-read user retains CanCan access to both children').toBe(true);
    });
  });

  test('Fix mechanism — STI ancestry candidates for an AR Class, single candidate for a String resource', async ({}, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_35_AC.Ac1ClientChildSufficient, TANGO_35_AC.Ac4NoParentRegression] });
    await test.step(`permission_resource_candidates(ClientDefaultNotToExceed) = ${JSON.stringify(data.candidates.client)} (walks child -> parent); permission_resource_candidates('Some::StringResource') = ${JSON.stringify(data.candidates.string)} (single candidate — other controllers unchanged)`, async () => {
      expect(data.candidates.client).toEqual(['Administration::ClientDefaultNotToExceed', 'Administration::DefaultNotToExceed']);
      expect(data.candidates.string).toEqual(['Some::StringResource']);
    });
  });
});
