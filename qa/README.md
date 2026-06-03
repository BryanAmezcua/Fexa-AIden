# TANGO

QA automation harness for Fexy-Zamo. Generates ticket-scoped Playwright suites that exercise the Fexa CMMS UI and emit self-contained HTML reports suitable for attaching to a JIRA ticket.

The expected entry point is the **`qa-ticket` Claude skill** — you point it at any Fexa JIRA ticket key (`TANGO-N`, `FIFI-N`, `FUN-N`, etc.) and it handles ticket parsing, AC extraction, seed design, test scaffolding, execution, and report generation end-to-end. Manual usage is also supported.

---

## Prerequisites

| Dependency | Why | Notes |
|---|---|---|
| **Node.js 20+** | Playwright runtime, TypeScript | `node --version` |
| **Sencha Cmd 6.5.3+** | Builds the production Ext JS bundle that `fexa:fast-mode` relies on | Must be on `PATH` as `sencha` |
| **Fexy-Zamo checkout** | The Rails app under test | Default sibling path `../Fexy-Zamo`; override via `FEXY_ZAMO_PATH` |
| **Running Rails server** | `localhost:3000` (or `TEST_BASE_URL`) reachable, redirecting to `/main/index` (fast mode) | Skill aborts if dev-mode is detected |
| **Postgres + Redis + Elasticsearch** | Whatever Fexy-Zamo needs | Out of scope for this README — see Fexy-Zamo's own setup |
| **Claude Code** with the **Atlassian MCP connector** | Used by the `qa-ticket` skill to fetch ticket details + comments | XML download is a fallback if the connector isn't connected |
| **Test accounts** in the target environment | Devise sign-in per persona (admin / vendor / facility-manager) | Credentials go in `.env` |

Playwright's Chromium is installed automatically by `npm install` (the `@playwright/test` postinstall hook). If it skipped for any reason, run `npx playwright install chromium`.

---

## Initial setup

```bash
# 1. Clone next to your Fexy-Zamo checkout, then install deps
cd ~/labs/TANGO
npm install

# 2. Configure test-account credentials
cp .env.example .env
$EDITOR .env        # fill in ADMIN_*, VENDOR_*, FACILITY_MANAGER_* (empties are skipped)

# 3. Put Fexy-Zamo into fast mode (production Sencha bundle + routes patch)
npm run fexa:fast-mode
# ⚠️ Restart your Rails server after this completes.

# 4. Sanity check — the suite logs in once via globalSetup before any test runs.
npm run test:admin -- --grep 'Vendor can navigate'   # fast smoke
```

`fexa:fast-mode` is idempotent (set `FORCE_REBUILD=1` to rebuild) and reversible (`npm run fexa:dev-mode`).

---

## Recommended workflow — drive it through the Claude skill

The `qa-ticket` skill lives at `.claude/skills/qa-ticket/SKILL.md` and is auto-discovered by Claude Code when this directory is the working tree. Invoke it with a JIRA ticket key from any pod:

```
/qa-ticket TANGO-N
/qa-ticket FIFI-N
/qa-ticket FUN-N
```

The skill runs this pipeline:

1. **Fetch ticket** via the Atlassian JIRA connector — pulls title, description, AC, and comments (dev-grooming notes that materially shape test design). XML fallback if the connector isn't connected.
2. **Verify environment** — confirms Rails is up and in fast mode; pauses with instructions otherwise.
3. **Plan with you** — surfaces high-leverage decisions (personas, scope breadth, seed reuse) via questions before writing any code.
4. **Add AC constants** — appends `<PROJECT>_<N>_AC` (e.g. `TANGO_7_AC`, `FIFI_12_AC`) to [`src/support/qa-report.ts`](src/support/qa-report.ts) with verbatim AC text.
5. **Write the seed** — creates `seeds/<descriptor>.rb` plus an `seed:<descriptor>` npm script and a JSON manifest at `reports/seed-manifest-<lowercased-ticket>.json`.
6. **Explore the UI** — only if the screen isn't already covered by prior specs.
7. **Write the spec** — emits `tests/<area>/<descriptor>.spec.ts` with one scenario per AC clause + edges.
8. **Run + iterate** — keeps running until the suite is green; investigates flakes (form-mount timing, InfiniteCombo loads, timezone drift).
9. **Visually verify each before/after PNG** — the skill mandates eyeballing every screenshot to confirm the AC-proving element is in-frame, before declaring done.
10. **Commit** in Conventional Commits style (does not push).

The deliverable is `reports/latest/<TICKET>.html` — one self-contained HTML file per ticket exercised in the run, with the ticket card, seed card, and every scenario's before/after screenshots inlined.

Invocations the skill recognises:

```
test TANGO-7
qa ticket FIFI-12
/qa-ticket FUN-9
```

---

## Manual usage

If you'd rather drive Playwright yourself:

```bash
# Run everything (admin + vendor + facility-manager projects)
npm test

# Run one project
npm run test:admin
npm run test:vendor
npm run test:fm

# Run a single spec
npx playwright test tests/pricing/enforced-rate.spec.ts

# Run a single project + spec
npx playwright test tests/pricing/enforced-rate.spec.ts --project=admin

# Re-seed fixtures (idempotent — safe to re-run)
npm run seed:all
npm run seed:enforced-rate           # one ticket only

# Open the Playwright HTML report (raw, not the qa-report)
npm run report

# Type-check without running
npm run typecheck
```

**Useful env vars** when invoking Playwright directly:

| Var | Effect |
|---|---|
| `TEST_BASE_URL` | Point at QA or a non-default port |
| `TANGO_INCLUDE_EXPLORE=1` | Include `tests/_explore/**` specs (excluded by default) |
| `FEXY_ZAMO_PATH` | Override the `../Fexy-Zamo` default for `fexa:fast-mode` and seed scripts |
| `FORCE_REBUILD=1` | Force a Sencha rebuild even if a build already exists |
| `SKIP_ES_LOCALE=1` | Drop the Spanish locale from the build for faster builds |

---

## Project layout

```
.claude/skills/qa-ticket/SKILL.md   The pipeline definition Claude executes for /qa-ticket
bin/
  fexa-fast-mode.sh                 Build Sencha bundle + patch routes.rb
  fexa-dev-mode.sh                  Revert
seeds/                              Idempotent Rails-runner fixture scripts, one per ticket
src/
  support/qa-report.ts              AC constants (<PROJECT>_<N>_AC, e.g. TANGO_7_AC, FIFI_12_AC), annotateAc, captureAcSnapshot
  reporters/qa-report.ts            Custom reporter that emits reports/latest/<TICKET>.html
  setup/global-setup.ts             One-shot Devise sign-in per persona → auth/<role>.json
tests/
  pricing/*.spec.ts                 Ticket-scoped suites
  _explore/*.explore.spec.ts        Selector exploration; gated by TANGO_INCLUDE_EXPLORE
auth/                               Persona session state (gitignored)
exploration/                        Output dumps from _explore specs (gitignored)
reports/
  latest/<TICKET>.html              One self-contained report per ticket (e.g. TANGO-7.html, FIFI-12.html)
  seed-manifest-<ticket>.json       Per-ticket fixture manifest (e.g. seed-manifest-tango-7.json)
test-results/                       Playwright raw artefacts (PNG, video, trace)
playwright.config.ts                Projects (admin/vendor/facility-manager), reporter wiring
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `globalSetup` warns "Rails is in DEV mode" | Run `npm run fexa:fast-mode` and restart Rails. |
| First admin test times out at `waitForFexaApp` | Cold-start contention. Re-run with `--workers=1`; subsequent tests run warm. |
| `Skipping <role>: credentials not set in .env` | Fill in the credentials in `.env` for that persona. |
| Sencha build fails with "no remote package repository" warnings | Usually benign — the build still completes. If it actually errors, run `sencha app refresh`. |
| Report missing or only contains some tickets | The reporter writes one file per ticket exercised in the run. Run the spec for the ticket you want; running the whole suite emits one file per ticket. |
| Spec works locally but fails on date-sensitive assertions | The browser timezone is pinned to UTC in `playwright.config.ts`. Use `new Date(Date.UTC(y, m-1, d, 12, 0, 0))` for fixture dates. |
