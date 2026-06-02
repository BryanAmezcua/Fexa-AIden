# QA mode — automated AC verification

You run this mode when the user types `/Fexa-AIden qa <TICKET-KEY>` (e.g. `qa TANGO-44`) or invokes it conversationally ("qa this ticket against the local app", "run QA on TANGO-9 against the staging URL").

Your job: produce a runnable test suite for the ticket that exercises every relevant AC clause, generate an HTML report with **visually verified** evidence, and post results back to Jira.

## When invoked

The user supplies:

- A ticket key in the form `<PROJECT>-<N>` (e.g. `TANGO-9`, `FIFI-12`, `FUN-3`). Throughout this mode, `<TICKET>` means the full key as typed, `<PROJECT>` the uppercase project prefix, `<N>` the numeric portion.
- (Optional) `--target=local` (default) or `--target=qa` or `--target=<url>` to pick the environment. **Translation for `run.mjs`**: local → no env override; `qa` or a custom URL → prepend `QA_BASE_URL=<url>` to the `node run.mjs` invocation.
- (Optional) `--no-post` to suppress the Jira post-back. **Translation**: omit the `--post-to-jira` flag (it's off by default in `run.mjs`).
- (Optional) `--no-commit` to suppress the commit. **Translation**: this flag is owned by this mode (step 11), not by `run.mjs` — just skip the commit step.

## Pipeline

### 1. Verify the environment

For `--target=local` (default):

```bash
$FEXA_AIDEN_ROOT/scripts/env-precheck.sh
```

The script confirms Rails is up at `localhost:3000` AND that it redirects to `/main/index` (fast-mode). If it exits 2 (dev-mode detected), tell the user verbatim:

> Fexy-Zamo is in dev-mode. Run `npm run fexa:fast-mode` in the Fexy-Zamo repo, restart `rails server`, then reply when ready.

Pause until they confirm. Do not proceed.

For `--target=qa` or `--target=<url>`:

```bash
$FEXA_AIDEN_ROOT/scripts/env-precheck.sh --url <url>
```

This skips the fast-mode redirect check and just verifies reachability. Bail with a clear message on a non-2xx/3xx response.

### 2. Get ticket details

Prefer the Atlassian MCP connector if available (tool names look like `mcp__*__getJiraIssue`). Use `ToolSearch` if it's not yet loaded in this session.

Fallback when MCP isn't available:

```bash
node -e "import('$FEXA_AIDEN_ROOT/lib/jira.mjs').then(m => m.fetchTicketWithAC('<TICKET>').then(t => console.log(JSON.stringify(t, null, 2))))"
```

Capture:

- `summary` — ticket title (strip any `[<TICKET>]` prefix)
- `description` — user story + AC sections
- **Acceptance Criteria** — *verbatim text from the ticket*, grouped by section heading (e.g. "Calculation", "Display", "Edge Cases"). Preserve the section label + numeric ref (e.g., "Calculation #1") for the AC constant.
- Comments — especially "Dev Context" notes, PM clarifications, prior QA findings, related ticket references.
- Metadata — status, priority, assignee, parent.

Summarize to the user: title, AC clause count, comment count, any dev-context findings that should shape test design.

### 3. Plan with the user

Use `AskUserQuestion` for 2–4 high-leverage decisions. Default to recommendations rather than open-ended questions. Typical decisions:

- **Personas** the AC implies (admin / vendor / facility-manager / multiple)
- **Scope** — which Ext xtypes, screens, models. Whether existing seed data is enough or new fixtures are required.
- **Test scenarios** — one row per AC clause + edges, mapping each back to its AC ref. If comments mention edge cases not in the AC bullets (or QA findings from a prior failed run), add those as additional scenarios with a brief note about their source.
- **Seed needs** — what records, on which scope (product / vendor / facility), with which attributes. Comments occasionally reveal which existing seeded entities to reuse — surface those.

### 4. Define AC constants

Edit `tickets/<TICKET>.mjs` (or scaffold it from `templates/ticket-template.mjs` if it doesn't exist). Define typed AC constants at the top of the file:

```js
// Verbatim AC clauses for <TICKET>. Captured at test-write time.
// Source: https://facilitiesexchange.atlassian.net/browse/<TICKET>
export const AC = {
  Calculation1: { ref: 'Calculation #1', text: 'Verbatim text from ticket…' },
  Calculation2: { ref: 'Calculation #2', text: 'Verbatim text from ticket…' },
  Display1:     { ref: 'Display #1',     text: 'Verbatim text from ticket…' },
  Edge1:        { ref: 'Edge Case #1',   text: 'Verbatim text from ticket…' },
  // …
};
```

**Verbatim text MUST match the ticket exactly** — don't paraphrase, don't fix typos, don't normalize quote marks or em-dashes. The report shows the AC as it was at test-write time, even if the ticket text drifts later.

### 5. Write or update the seed

If the ticket needs fixtures the existing seed doesn't cover, extend the seed definition in the ticket file (consumed by `lib/seeds.mjs`) or write a new Ruby seed under `seeds/<descriptor>.rb`.

Whatever the seed creates, also emit a manifest at `reports/seed-manifest-<lowercased-ticket>.json` with this shape:

```json
{
  "ticket": "<TICKET>",
  "source_seed": "<descriptor>",
  "generated_at": "<ISO-8601>",
  "scope": { "product": {}, "vendor": {}, "facility": {}, "invoice_targets": {} },
  "fixtures": [
    { "id": 123, "name": "…", "active": true, "purpose": "one-sentence why-this-exists" }
  ]
}
```

The report renders a Seed card from any `seed-manifest-*.json` whose `ticket` matches the run.

**For `--target=qa` or remote URLs: skip seeding by default.** Do not seed shared environments without explicit confirmation — ask the user before proceeding.

### 6. Scaffold (or update) the ticket file

If `tickets/<TICKET>.mjs` doesn't exist, copy `templates/ticket-template.mjs` to that path and fill in. The file must export:

- `metadata: { summary, tester, branch, environment }`
- `AC: { ... }` — the typed constants from step 4
- `seed: { ... }` (optional) — definition consumed by `lib/seeds.mjs`
- `tests: [ ... ]` — array of test scenarios

Each test entry:

```js
{
  ac: [AC.Calculation1, AC.Display1],   // array of AC clause OBJECTS, not numbers
  name: '<domain-language scenario name>',
  run: async (page, step, screenshot) => {
    step('Navigate to Administration > Pricings (persona=admin)');
    await navigateTo(page, ['Administration', 'Pricings']);

    // 'focus' locator REQUIRED for AC-evidence screenshots.
    await screenshot('before', { focus: page.locator('[name="base_price"]') });

    step('Set base_price=150.00');
    await /* the AC-relevant action */;

    await screenshot('after', { focus: page.locator('[name="base_price"]') });
  },
}
```

**Required conventions:**

- `ac:` is an array of AC clause *objects* (`AC.Foo`), not numbers. The report shows the verbatim text from each clause.
- Each `screenshot()` call MUST pass a `focus` locator for the element that proves the AC. The helper asserts it visible, scrolls it into view, and captures the full viewport. **A screenshot without `focus` is allowed only for incidental captures (overview shots), never for AC evidence.**
- **Step labels MUST include input values**: `Fill: Name="[QA] X", Product="Regular Rate", Vendor="1st Quality Electric"`. A reader should be able to reproduce the test by hand from the step list alone. No `step('Fill the form')` — instead `step('Fill: Name="…", Product="…"')`.
- Use **domain language** in `name` — never `'AC #1 test'`, always `'Hamburger menu shows Export/Template/Upload items'`.
- For multi-step ACs, call `screenshot('after', { focus, label: 'Form opened' })` multiple times with distinct labels — each labeled capture appears in invocation order in the report (`label` becomes the figcaption).

### 7. Run the suite

```bash
cd $FEXA_AIDEN_ROOT
# Local target (default):
node run.mjs <TICKET> [--no-cleanup]
# Remote target:
QA_BASE_URL=https://qa.fexa.io node run.mjs <TICKET> [--no-cleanup]
```

`run.mjs` reads `QA_BASE_URL` and `lib/config.mjs` does the rest. The `--no-cleanup` flag preserves seeded data after the run for debugging.

When tests fail, common causes:

- **InfiniteCombo never loads**: set value, then poll `getValue() != null`. Retry up to 5×.
- **Form doesn't open**: defensively close any open form; scroll button into view; retry click up to 3×.
- **`new Date('YYYY-MM-DD')` off by one**: use `new Date(Date.UTC(y, m-1, d, 12, 0, 0))`.
- **Sencha never finishes loading**: confirm fast-mode is on. Dev mode times out everything.
- **Test timeout**: bump the per-test timeout in the test definition or `run.mjs` default.

**Do NOT skip past failing tests.** Investigate and fix, or document the AC deviation explicitly.

### 8. Visual verification — a green test is NECESSARY but not SUFFICIENT

A test can pass while its before/after screenshots show nothing useful — the assertion runs on Ext state, but the screenshot fires moments later against a viewport that scrolled wrong, dismissed the relevant transient UI, or focused the wrong element. This has happened in this project before and made it into reports.

**Before declaring done, open every PNG in the screenshot directory (or eyeball them inside the rendered HTML report) and confirm:**

| Scenario type                              | What MUST be visible in the after-shot                                                |
|---|---|
| "Field appears / is positioned …"          | The field itself, in-frame within its container, not cropped                          |
| "Field has label X"                        | The label text rendered on screen                                                     |
| "Field has tooltip X"                      | The tooltip element itself — hover MUST be triggered before the screenshot fires      |
| "Warning dialog appears with copy X"       | The dialog and its full copy text                                                     |
| "Inline validation appears with copy X"    | The validation message rendered inline in the form, not just the field                |
| "Persisted row in grid"                    | The new row visible in the grid                                                       |
| "Calculated value displays $X"             | The highlighted box / label with the calculated amount                                |
| Absence assertions ("no X when Y")         | The surrounding context where X would have appeared, proving the area is empty        |

If a screenshot doesn't show the AC-proving element, **fix the test BEFORE telling the user it's done:**

- **Transient UI** (tooltips, hover menus, ephemeral focus rings): explicitly trigger the state (`hover()`, `focus()`, click), wait for the rendered DOM (`waitFor({ state: 'visible' })`), then screenshot. You may need to bypass the `screenshot()` helper's focus-scroll for hover states — its `scrollIntoViewIfNeeded` step can dismiss the hover. Inline: call `page.screenshot({ path: ... })` directly and skip the helper.
- **Wrong focus element**: pick a locator that actually proves the AC (e.g. for inline validation, the validation copy itself, not the toggle).
- **Off-frame element**: pass a `focus` locator that's actually visible; if the element is in a popup that scrolls separately from the page, scroll the popup body, not the page.

Re-run the spec, re-verify the PNG, and only then proceed.

### 9. Confirm the report

After a passing run:

```bash
ls -lh $FEXA_AIDEN_ROOT/reports/<TICKET>.html
```

Tell the user:

- Path: `reports/<TICKET>.html`
- How to open: `start reports/<TICKET>.html` (Windows) or `open reports/<TICKET>.html` (mac/WSL)
- Pass/fail summary (e.g., "10 passed / 0 failed")
- Any AC deviations discovered (wording differences, edge case behavior)
- **Explicitly state that you visually verified the before/after screenshots** per step 8 — list one example per scenario type if helpful

### 10. Post to Jira

Unless `--no-post` was passed (i.e. unless the user explicitly suppressed it), append `--post-to-jira` to the run command. You can either do this on the original run:

```bash
[QA_BASE_URL=<url>] node run.mjs <TICKET> [--no-cleanup] --post-to-jira
```

…or, if the run already completed and you want to post the existing report without re-running tests, call `lib/jira.mjs::postQAComment` directly via a one-liner Node invocation. Either way: this posts a structured ADF comment to the ticket with per-AC pass/fail rows and attaches `reports/<TICKET>.html`.

### 11. Commit

Commit step is owned by this mode (not by `run.mjs`). Unless `--no-commit` was passed, commit (do NOT push). Conventional Commits style. Include:

- What the new ticket covers
- Test count + pass status
- Any AC deviations or findings worth raising

Branch convention (per Fexa-AIden global rules): `TANGO-<ticket-id>` for any ticket key, PRs target `develop`. See `modes/spec.md` for the full convention.

User decides when to push.

## Hard rules

- **Verbatim AC text** — quote the ticket exactly. Tests must show the AC as it was at test-write time, even if the ticket drifts later.
- **`focus` locator REQUIRED for AC-evidence screenshots** — the helper asserts visible + scrolls into view. Without `focus`, you risk capturing nothing useful.
- **Step labels include input values** — `Fill: Name="[QA] X", …`. A reader should be able to reproduce by hand from the step list alone.
- **Domain language in test names** — never put the ticket key in `name`. Use Fexy-Zamo terms.
- **One ticket per report file** — `reports/<TICKET>.html`. Never combine.
- **Don't push to remote** — only commit. User decides when to push.
- **Don't seed shared environments without confirmation** — for `--target=qa` or remote URLs, skip seeding unless explicitly confirmed.
- **Don't modify Fexy-Zamo source** beyond the routes-fastmode toggle (which is handled by Fexy-Zamo's own scripts, not Fexa-AIden).
- **Don't delete or modify other tickets' tests, seeds, or AC constants.**

## Out-of-scope (don't do)

- Don't push to remote.
- Don't add new personas / projects without user approval — ask first.
- Don't auto-rerun tests on failure without first investigating the cause.
- Don't paraphrase AC text to fit a code style — preserve exactly.
- Don't generate "passes by skipping" — failing tests must either be fixed or documented as a real AC deviation.

## What success looks like

After invocation with a ticket key:

1. `tickets/<TICKET>.mjs` exists with `metadata`, `AC` constants, `seed` (if needed), `tests[]` exercising every relevant clause.
2. A `seeds/<descriptor>.rb` exists if new fixtures were needed, plus a manifest at `reports/seed-manifest-<lowercased-ticket>.json`.
3. All scenarios pass (or failures are clearly documented as AC deviations).
4. `reports/<TICKET>.html` opens to show only that ticket's results — one ticket card, seed card if applicable, all scenarios with before/after screenshots.
5. **Every before/after screenshot was visually verified** to actually show the AC-proving element (per step 8) — not just "tests are green."
6. The Jira ticket has a structured QA comment + report attachment (unless `--no-post`).
7. A clean Conventional Commit captures the work (unless `--no-commit`). Not pushed.

Report the path + summary to the user when done.
