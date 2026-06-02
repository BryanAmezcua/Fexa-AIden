// templates/ticket-template.mjs — Scaffold for a new ticket's QA spec.
//
// The `qa` mode copies this file to `tickets/<TICKET-KEY>.mjs` and fills it in.
// Replace every `<TICKET-KEY>` / `<SUMMARY>` placeholder and the AC stubs below.

import { navigateTo } from '../lib/navigation.mjs';
import { waitForLoad, componentExists } from '../lib/extjs.mjs';

export const metadata = {
  summary: '<SUMMARY from the ticket>',
  tester: 'Bryan',
  branch: '<TICKET-KEY-lowercased>',
  environment: 'Local Dev (WSL)',  // overridden at run time when --target is passed
};

// Verbatim AC clauses, captured from the ticket at test-write time.
// Source: https://facilitiesexchange.atlassian.net/browse/<TICKET-KEY>
//
// Each entry: { ref: 'Section #N', text: 'Verbatim text from ticket' }.
// DO NOT paraphrase the text — preserve quote marks, em-dashes, and typos exactly.
export const AC = {
  // Examples (delete and replace with the real clauses):
  //
  // Calculation1: { ref: 'Calculation #1', text: 'Verbatim text from ticket…' },
  // Display1:     { ref: 'Display #1',     text: 'Verbatim text from ticket…' },
  // Edge1:        { ref: 'Edge Case #1',   text: 'Verbatim text from ticket…' },
};

// Optional seed definition consumed by lib/seeds.mjs (cleanup runs automatically
// after the suite unless --no-cleanup is passed). Set to null when no seeding needed.
export const seed = null;
//
// Example:
// export const seed = {
//   tag: '<ticket_key_lowercased>',
//   impersonateEmail: 'adminofall@fexa.io',
//   lists: [/* see lib/seeds.mjs for shape */],
//   assignments: [/* … */],
// };

export const tests = [
  // {
  //   ac: [AC.Calculation1, AC.Display1],           // array of AC clause OBJECTS, not numbers
  //   name: '<domain-language description of the scenario>',
  //   run: async (page, step, screenshot) => {
  //     // Step labels MUST include input values so a reader can reproduce by hand.
  //     step('Navigate to Administration > Pricings (persona=admin)');
  //     await navigateTo(page, ['Administration', 'Pricings']);
  //
  //     // 'focus' locator REQUIRED for AC-evidence screenshots:
  //     //   1. asserts the element is visible (test fails clearly if not),
  //     //   2. scrolls it into view,
  //     //   3. captures the full viewport at natural size (no crop).
  //     await screenshot('before', { focus: page.locator('[name="base_price"]') });
  //
  //     step('Set base_price=150.00');
  //     // ... the AC-relevant action ...
  //
  //     await screenshot('after', { focus: page.locator('[name="base_price"]') });
  //   },
  // },
];
