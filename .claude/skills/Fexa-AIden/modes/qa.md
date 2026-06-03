# QA mode — automated AC verification (native Playwright engine)

Run this when the user types `/Fexa-AIden qa <TICKET-KEY>` (e.g. `qa TANGO-5`) or
asks conversationally ("qa this ticket", "run QA on TANGO-9").

The QA engine is a native **Playwright Test** project at `qa/` (run Claude from
the repo root). Your job: extend it to cover a new ticket — AC constants + seed +
spec — run it against the local Fexy-Zamo in **fast mode**, produce a
self-contained `qa/reports/latest/<TICKET>.html`, then critique coverage.

`<TICKET>` = full key (`TANGO-5`); `<PROJECT>` = prefix (`TANGO`); `<N>` = number.
Flags: `--no-post` (default — never auto-post to Jira), `--no-commit` (skip commit).

## Environment cheatsheet (WSL — learned the hard way)

All commands run in WSL from `qa/`. The non-interactive shell does NOT load the
interactive PATH, so prepend tools explicitly:

```bash
# Ruby (seeds) + Sencha (fast-mode build). Cmd order matters — the project needs
# Sencha Cmd 7.7.0.36, which is ~/bin/Sencha/Cmd/sencha (NOT ~/bin/Sencha/sencha).
export PATH="$HOME/bin/Sencha/Cmd:$HOME/bin/Sencha:$HOME/.rbenv/shims:$HOME/.rbenv/bin:$PATH"
eval "$(rbenv init - bash 2>/dev/null)"
export FEXY_ZAMO_PATH="$HOME/work/Fexy-Zamo"
```

## Pipeline

### 1. Get ticket details
Use the Jira connector (MCP `mcp__*__getJiraIssue`) if available, else the bundled
script: `bash .claude/skills/Fexa-AIden/scripts/jira-fetch.sh <TICKET>` (needs the
`token` file at the skill root). Capture: summary, **verbatim AC** grouped by
section, comments (esp. "Dev Context — Grooming"), status/assignee/parent.
Summarize to the user: title, AC count, comment count, dev-context findings.

### 2. Verify environment + fast mode
```bash
curl -s -o /dev/null -w "%{redirect_url}\n" --max-time 10 http://localhost:3000/
```
- `→ /main/index` = fast mode ✓. Proceed.
- `→ /main/development` = dev mode → tests time out. Flip it:
  ```bash
  cd qa && npm run fexa:fast-mode          # sencha prod build (~2 min) + patches routes.rb
  cd ~/work/Fexy-Zamo && overmind restart web   # reload routes; wait for /main/index
  ```
- Not listening → ask the user to start Fexy-Zamo (`bin/dev`).

Revert when done: `cd qa && npm run fexa:dev-mode` + `overmind restart web`.

### 3. Plan with the user
`AskUserQuestion` for 2–4 high-leverage calls: **persona(s)** (`admin` always;
`vendor`/`facility-manager` need creds in `qa/.env`), **scope** (models/xtypes/
screens, reuse vs new fixtures), **scenarios** (one per AC clause + edges, each
mapped to its AC ref; fold in comment-sourced edges), **seed needs**.

### 4. Add AC constants
Append `<PROJECT>_<N>_AC` to `qa/src/support/qa-report.ts`:
```ts
export const TANGO_7_AC = {
  Calculation1: { ref: 'Calculation #1', text: 'Verbatim text…' },
} as const satisfies Record<string, AcClause>;
```
**Verbatim** — no paraphrasing, preserve quotes/em-dashes/typos.

### 5. Write the seed
`qa/seeds/<descriptor>.rb` — idempotent (clean prior fixtures by name prefix),
reuse existing seeded entities, emit `qa/reports/seed-manifest-<lower-ticket>.json`
(`ticket`, `source_seed`, `generated_at`, `scope`, `fixtures[]`). Add an npm
script mirroring the pattern, then run it:
```bash
export PATH/eval rbenv/FEXY_ZAMO_PATH   # (cheatsheet above)
cd qa && npm run seed:<descriptor>
```

### 6. Explore if the UI is new
`qa/tests/_explore/<descriptor>.explore.spec.ts` that navigates + dumps component
metadata to `qa/exploration/`. Run:
`cd qa && TANGO_INCLUDE_EXPLORE=1 npx playwright test tests/_explore/<descriptor>.explore.spec.ts --project=admin`.
Read the JSON to discover real selectors before asserting. Common Ext patterns:
deep-link `Ext.History.add('<ctype>/<id>')`; `button[reference=…Btn]`;
`formpanel [name=…]`; InfiniteCombo = setValue then poll `getValue()!=null`.

### 7. Write the spec
`qa/tests/<area>/<descriptor>.spec.ts` — domain-language filename (never the
ticket key). Structure: `test.describe.configure({mode:'serial'})`,
`test.setTimeout(180_000)`, `annotateAc(testInfo, {ticket, ac:[…]})`,
`test.skip(testInfo.project.name !== '<persona>', …)`, `test.step()` labels
**with input values**, and `captureAcSnapshot(testInfo, page, 'before'|'after',
{focus})` bracketing the AC action (`focus` REQUIRED for positive assertions).
Reuse the proven helpers in `tests/pricing/enforced-rate.spec.ts`
(`gotoInvoice` cold-start retry, `openNewLineItemForm`, `selectProduct`).

### 8. Run + iterate
```bash
cd qa && npx playwright test tests/<area>/<descriptor>.spec.ts --project=admin
```
Run `--project=admin` (avoids missing vendor/fm `auth/*.json`). Common fixes:
InfiniteCombo retry 5×; form-open defensive close + retry 3×; dates via
`Date.UTC(...)` (tz pinned UTC); bump `setTimeout`; first-test cold-start is
covered by helper retries. **Don't skip failures** — fix or document as an AC
deviation.

### 9. Verify the report + screenshots
`ls -lh qa/reports/latest/<TICKET>.html` (one file per ticket). **A green test is
necessary but not sufficient** — open every before/after PNG (or eyeball in the
report) and confirm each shows the AC-proving element (locked field greyed, helper
text rendered, dialog copy, persisted row, or the empty region for absence
assertions). Fix transient-UI captures (hover/tooltip) by triggering state +
`waitFor({state:'visible'})` then a direct `page.screenshot()`, bypassing the
helper's scroll. Re-run and re-verify before declaring done.

### 10. Critique the coverage (multi-agent)
After the report is green, spawn **multiple Agent subagents in parallel** to
critique whether the suite truly tests every aspect of the AC — distinct lenses:
(a) **coverage completeness** (each AC clause has a real assertion, not just
navigation), (b) **edge/negative rigor** (absence assertions prove the area is
empty; missing edges from AC + dev-context, e.g. server-side enforcement on save),
(c) **evidence validity** (each `focus`/assertion actually proves its AC per §9).
Give each agent the verbatim AC + the spec path; synthesize their findings into a
prioritized gap list for the user. Fix high-value gaps and re-run before finishing.

### 11. Report to the user (NO auto-post to Jira)
Tell the user: report path (`qa/reports/latest/<TICKET>.html`), pass/fail summary,
any AC deviations, that you visually verified the screenshots (§9), and the
critique gap list (§10). **Never post to Jira unless explicitly asked.** Commit
only with approval (`--no-commit` skips); don't push.

## Hard rules
- **Verbatim AC text** — never paraphrase.
- **Domain-language names** — never the ticket key in file/test names.
- **`focus` locator required** for positive-assertion snapshots.
- **`test.step()` labels include input values** — the report is the repro script.
- **One report file per ticket** — `qa/reports/latest/<TICKET>.html`.
- **Don't modify Fexy-Zamo source** beyond the routes fast-mode toggle (handled by
  `qa/bin/fexa-fast-mode.sh`).
- **Don't post to Jira / don't push** without explicit user instruction.
