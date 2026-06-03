# Aiden — agent skill bundle for Fexa CMMS (Fexy-Zamo)

This repo is a self-contained Claude Code agent: clone it, run Claude Code **from
the repo root**, and the skills under `.claude/skills/` are discovered as
project skills. It bundles Jira helpers and an automated GUI-QA harness for the
Fexy-Zamo / Fexa CMMS app.

## Layout

```
.claude/skills/Fexa-AIden/   The skill (dispatcher + modes)
  SKILL.md                   Routes subcommands: list | brief | qa
  modes/list.md              List my open-sprint Jira tickets
  modes/brief.md             Render one ticket (description, comments, AC)
  modes/qa.md                Generate + run a Playwright QA suite for a ticket
  lib/{jira,config}.mjs      Jira fetch helpers (list/brief)
  scripts/jira-*.sh          Jira REST helpers (need a `token` file, gitignored)
qa/                          The QA engine (native Playwright Test, ex-"TANGO")
  playwright.config.ts       Projects (admin/vendor/facility-manager) + reporters
  tests/<area>/*.spec.ts     One spec file per ticket; tests/_explore = throwaway
  src/support/qa-report.ts   Verbatim AC constants + annotateAc/captureAcSnapshot
  src/reporters/qa-report.ts Custom reporter → reports/latest/<TICKET>.html
  seeds/*.rb                 Idempotent rails-runner fixtures
  bin/fexa-{fast,dev}-mode.sh Toggle Fexy-Zamo fast vs dev mode
bin/setup.sh                 One-shot install (deps + browser + .env scaffold)
```

## Environment (WSL, important)

- **Run everything in WSL on ext4** (`~/work/aiden`), never under `/mnt/c` —
  `node_modules` + Playwright browsers + Sencha builds are slow/flaky across the
  Windows↔WSL filesystem boundary.
- The QA engine drives the app over `http://localhost:3000` (works from WSL) and
  runs the **seeds via Rails directly** (`bundle exec rails runner`), so Ruby
  must be on PATH — init rbenv in the shell first.
- Point the harness at your Fexy-Zamo checkout:
  `export FEXY_ZAMO_PATH=~/work/Fexy-Zamo` (add to `~/.bashrc`).

## First-time setup

```bash
bin/setup.sh                       # installs qa/ deps + chromium, scaffolds qa/.env
# then fill in:
#   qa/.env                        TEST_BASE_URL + per-role creds (admin/vendor/fm)
#   .claude/skills/Fexa-AIden/token   your Jira API token (one line)
```

## QA run (per ticket)

```bash
cd qa
npm run fexa:fast-mode             # builds prod Sencha + patches routes; restart Rails after
npm run seed:<descriptor>          # create the ticket's fixtures
npx playwright test tests/<area>/<descriptor>.spec.ts   # → reports/latest/<TICKET>.html
```

Fast mode is required: in dev mode Sencha boots too slowly and every test times
out. `bin/fexa-fast-mode.sh` flips it; `bin/fexa-dev-mode.sh` reverts. The app
must be restarted after either toggle.

## Conventions

- Verbatim AC text in `src/support/qa-report.ts` — never paraphrase.
- Domain-language file/test names (`enforced-rate`, not `TANGO-5`).
- `test.step()` labels include input values so a human can reproduce by hand.
- Every positive-assertion `captureAcSnapshot` passes a `focus` locator.
- Don't commit `qa/.env`, `auth/*.json`, `token`, or `reports/` (gitignored).
