---
name: Fexa-AIden
description: Junior/mid-level dev assistant for the Fexy-Zamo (Fexa CMMS) codebase. Drives ticket-scoped Jira and QA automation against a locally running WSL Rails instance. Subcommands - `list` shows the user's open-sprint tickets as a compact table; `brief <TICKET-KEY>` fetches a single ticket and renders the description, comments, and metadata as readable markdown; `qa <TICKET-KEY>` drives the native Playwright QA engine (qa/) end to end (fetch AC → plan → scaffold spec + seed → run in fast mode → visually verify screenshots → multi-agent coverage critique) and writes a self-contained HTML report. Never auto-posts to Jira. A `spec` mode for drafting spec sheets is planned. Invoke as `/Fexa-AIden list`, `/Fexa-AIden brief TANGO-9`, or `/Fexa-AIden qa TANGO-9`.
---

# Fexa-AIden

One skill, multiple modes. This `SKILL.md` is the dispatcher; `modes/` holds the per-phase instructions; `lib/` + `scripts/` hold the Jira helpers for `list`/`brief`. The `qa` mode drives a native **Playwright Test** engine that lives at `qa/` in the repo root.

## Dispatcher

The user's input is `/Fexa-AIden <subcommand> [args...]`. Route based on subcommand:

| Subcommand          | Mode file        | Status      |
|---|---|---|
| `list`              | `modes/list.md`  | **active**  |
| `brief <TICKET>`    | `modes/brief.md` | **active**  |
| `qa <TICKET> [...]` | `modes/qa.md`    | **active**  |
| `spec <TICKET>`     | `modes/spec.md`  | planned     |

When the user invokes a subcommand (e.g. `/Fexa-AIden qa TANGO-9 [--target=...] [--no-post] [--no-commit]`):

1. Read the matching `modes/<sub>.md` and follow its instructions precisely.
2. Substitute `<TICKET>` everywhere with the user-supplied key.
3. Pass through any flags.

If the user invokes a subcommand whose mode file doesn't exist yet, surface that clearly:

> The `<name>` mode hasn't been implemented yet. Currently supported: `list`, `brief`, `qa`. The `spec` mode is planned.

If the user invokes `/Fexa-AIden` with no subcommand, ask which mode they want before doing anything.

## Running

This skill is part of a self-contained repo. Run Claude Code from the **repo root**
(cloned into WSL on ext4, e.g. `~/work/aiden`) so this skill is discovered as a
project skill. The QA engine is a native Playwright project at `qa/`; see the repo
root `CLAUDE.md` for setup (`bin/setup.sh`), fast-mode, and run commands.

## Global hard rules (apply to every mode)

- **Never include AI-attribution lines in commit messages** — no `Co-Authored-By: Claude`, no `🤖 Generated with Claude Code`, no "committed by AI" preamble. Per the user's global rules.
- **Never commit without explicit user approval.** Stage and propose; let the user say go.
- **Never push to remote without explicit user instruction.**
- **Never modify Fexy-Zamo source from inside Fexa-AIden** beyond the documented routes-fastmode toggle, which is handled by Fexy-Zamo's own scripts.
- **Never bypass hooks or signing** (`--no-verify`, `--no-gpg-sign`, etc.) unless the user explicitly asks.

## Where things live

Inside this skill (`.claude/skills/Fexa-AIden/`):
- `modes/` — per-subcommand instructions (the dispatcher reads from here)
- `lib/` — `jira.mjs` + `config.mjs` (Jira fetch for `list`/`brief`)
- `scripts/` — `jira-*.sh` bash helpers (need a `token` file at this skill root)

The QA engine lives at the repo root, outside this skill:
- `qa/` — native Playwright project: `tests/<area>/*.spec.ts`, `tests/_explore/`,
  `src/support/qa-report.ts` (AC constants + snapshot helpers),
  `src/reporters/qa-report.ts` (HTML reporter — dark theme), `seeds/*.rb`,
  `bin/fexa-{fast,dev}-mode.sh`, `playwright.config.ts`
- `qa/reports/latest/<TICKET>.html` — generated reports (gitignored)
- repo-root `CLAUDE.md` + `bin/setup.sh` — orientation + one-shot install
