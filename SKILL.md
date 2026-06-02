---
name: Fexa-AIden
description: Junior/mid-level dev assistant for the Fexy-Zamo (Fexa CMMS) codebase. Drives ticket-scoped Jira and QA automation against either a locally running WSL Rails instance or a remote QA URL. Subcommands - `list` shows the user's open-sprint tickets as a compact table; `brief <TICKET-KEY>` fetches a single ticket and renders the description, comments, and metadata as readable markdown; `qa <TICKET-KEY>` runs the full QA pipeline end to end (fetch AC → plan with user → scaffold tests → run → visually verify screenshots → post results back to Jira). A `spec` mode for drafting spec sheets is planned. Invoke as `/Fexa-AIden list`, `/Fexa-AIden brief TANGO-9`, or `/Fexa-AIden qa TANGO-9 [--target=qa]`.
---

# Fexa-AIden

One skill, multiple modes. This `SKILL.md` is the dispatcher; `modes/` holds the per-phase instructions; `lib/` and `scripts/` hold the shared implementation that modes invoke.

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

## Repo root

The repo is expected at `$FEXA_AIDEN_ROOT` (env var; defaults to `~/Fexa-AIden` if unset). All scripts, library modules, and templates resolve paths relative to this root.

## Global hard rules (apply to every mode)

- **Never include AI-attribution lines in commit messages** — no `Co-Authored-By: Claude`, no `🤖 Generated with Claude Code`, no "committed by AI" preamble. Per the user's global rules.
- **Never commit without explicit user approval.** Stage and propose; let the user say go.
- **Never push to remote without explicit user instruction.**
- **Never modify Fexy-Zamo source from inside Fexa-AIden** beyond the documented routes-fastmode toggle, which is handled by Fexy-Zamo's own scripts.
- **Never bypass hooks or signing** (`--no-verify`, `--no-gpg-sign`, etc.) unless the user explicitly asks.

## Where things live

- `modes/` — per-subcommand instructions (the dispatcher reads from here)
- `lib/` — Node modules (browser, Jira API, screenshots, report generation, seeds, etc.)
- `scripts/` — bash helpers (env precheck; future: Jira fetch, attachment download)
- `templates/` — file scaffolds (`ticket-template.mjs`)
- `tickets/` — per-ticket QA spec modules
- `seeds/` — Ruby seed scripts (optional)
- `reports/` — generated HTML reports (gitignored)
- `run.mjs` — manual CLI entry point: `node run.mjs <TICKET-KEY> [--target=...]`
