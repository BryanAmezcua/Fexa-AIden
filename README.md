# Fexa-AIden

Junior/mid-level dev assistant for the Fexy-Zamo (Fexa CMMS) codebase. A Claude Code skill with three active modes for ticket triage and automated AC verification:

| Subcommand          | What it does                                                                                                         |
|---|---|
| `/Fexa-AIden list`              | Print a compact table of every ticket assigned to you across all open sprints.                          |
| `/Fexa-AIden brief <TICKET>`    | Fetch a single ticket and render its description, comments, and metadata as readable markdown.          |
| `/Fexa-AIden qa <TICKET> [...]` | Run the full QA pipeline end-to-end: fetch AC → plan with user → scaffold tests → run → visually verify screenshots → post results back to Jira. |

A `spec` mode is planned — see `modes/spec.md` for the preserved conventions.

## Installation

The repo IS the skill — clone it directly into your Claude Code skills directory so Claude can discover it:

```powershell
git clone https://github.com/BryanAmezcua/Fexa-AIden.git $HOME\.claude\skills\Fexa-AIden
```

If you cloned elsewhere first, move the working tree:

```powershell
Move-Item C:\path\to\Fexa-AIden $HOME\.claude\skills\
```

The `.git/` directory rides along, so the GitHub remote stays connected.

## Setup (one-time, after install)

```bash
cd $HOME/.claude/skills/Fexa-AIden

# 1. Install Node deps + Playwright Chromium
npm install
npx playwright install chromium

# 2. Add your Jira API token (gitignored; never commit)
#    Generate at: https://id.atlassian.com/manage-profile/security/api-tokens
#    Paste one line, no quotes:
echo "<your-token>" > token

# 3. Copy and edit the env file
cp .env.example .env
# Edit .env to set QA_EMAIL, QA_PASSWORD (Devise creds for local Rails),
# and RAILS_ROOT if Fexy-Zamo is not at /home/<user>/Fexy-Zamo
```

Set `FEXA_AIDEN_ROOT` in your shell profile so the mode docs can reference it:

```powershell
# PowerShell ($PROFILE):
$env:FEXA_AIDEN_ROOT = "$HOME\.claude\skills\Fexa-AIden"
```

```bash
# WSL / Git Bash (.bashrc):
export FEXA_AIDEN_ROOT="$HOME/.claude/skills/Fexa-AIden"
```

## Prerequisites

- **Node.js 18+**
- **WSL with Ruby 2.7.8 + Rails** — for seed scripts (`lib/seeds.mjs` shells out via `wsl.exe`)
- **Fexy-Zamo running on `localhost:3000` in fast-mode** — `qa` mode targets it directly
- **`jq` installed in WSL** — `sudo apt install -y jq` (needed by `scripts/jira-*.sh`)
- **Atlassian MCP connector** (optional) — `qa` mode prefers it for ticket fetch but falls back to the bash scripts

## Manual usage (without the slash command)

The `qa` mode is just a structured wrapper around `run.mjs`. You can drive it directly:

```bash
cd $HOME/.claude/skills/Fexa-AIden

# Local target, no Jira post-back
node run.mjs TANGO-9

# Custom target URL (e.g. staging)
QA_BASE_URL=https://qa.fexa.io node run.mjs TANGO-9

# With Jira post-back (comment + report attachment)
node run.mjs TANGO-44 --post-to-jira

# Preserve seed data after the run (for debugging)
node run.mjs TANGO-44 --no-cleanup
```

Reports land at `reports/<TICKET>.html` as self-contained HTML.

## Repo structure

```
Fexa-AIden/
├── SKILL.md                   Top-level dispatcher (skill loader entry point)
├── README.md                  This file
├── package.json, .env.example, .gitignore
│
├── modes/                     Per-subcommand instructions, read by the dispatcher
│   ├── list.md
│   ├── brief.md
│   ├── qa.md
│   └── spec.md                NOT YET IMPLEMENTED — conventions archive
│
├── scripts/                   Bash helpers invoked by the modes
│   ├── env-precheck.sh
│   ├── jira-list.sh
│   ├── jira-fetch.sh
│   ├── jira-attachments.sh
│   └── jira-download-attachment.sh
│
├── templates/
│   └── ticket-template.mjs    Scaffold for new tickets/<KEY>.mjs files
│
├── lib/                       Node modules — Playwright + Jira + report generation
│   ├── auth.mjs, browser.mjs, config.mjs, evidence.mjs, extjs.mjs,
│   ├── import.mjs, jira.mjs, navigation.mjs, report.mjs,
│   ├── screenshots.mjs        (focus-locator support added)
│   ├── seeds.mjs, step-formatter.mjs
│
├── tickets/                   Per-ticket QA spec modules (one file per ticket)
│   ├── TANGO-9.mjs, TANGO-44.mjs
│
├── tools/                     One-off cleanup scripts
│
├── run.mjs                    Manual CLI entry point
│
├── reports/                   Generated HTML reports               (gitignored)
├── specs/                     Spec sheets from spec mode           (gitignored)
├── auth/                      Persisted Devise sessions (planned)  (gitignored)
├── _attachments/              Downloaded Jira attachments          (gitignored)
└── token                      Jira API token (one line)            (gitignored)
```

## Conventions

- **Branch naming**: `<TICKET-KEY>` (e.g. `TANGO-9`, `FIFI-12`), PRs target `develop`. Spec mode and qa mode both reference this convention.
- **Verbatim AC text**: tests and specs preserve acceptance criteria exactly as written in the ticket, even when the ticket text later drifts.
- **One report per ticket**: `reports/<TICKET>.html` — never combined.
- **Visual verification**: a green test is necessary but not sufficient — every AC-evidence screenshot is checked by eye before declaring the ticket QA'd. See `modes/qa.md` step 8.
- **No AI attribution in commits**: per global rules, never include `Co-Authored-By: Claude` or similar lines.

## Writing a new ticket (for `qa` mode)

When `qa` mode scaffolds `tickets/<KEY>.mjs` for a new ticket, it copies from `templates/ticket-template.mjs`. The structure:

```js
export const metadata = {
  summary: 'Ticket title from Jira',
  tester: 'Bryan',
  branch: 'TANGO-9',
  environment: 'Local Dev (WSL)',
};

// Verbatim AC clauses — typed constants, referenced by tests below.
export const AC = {
  Calculation1: { ref: 'Calculation #1', text: 'Verbatim text from ticket...' },
  Display1:     { ref: 'Display #1',     text: 'Verbatim text from ticket...' },
};

export const seed = null;   // or a seed definition consumed by lib/seeds.mjs

export const tests = [
  {
    ac: [AC.Calculation1, AC.Display1],
    name: 'Domain-language scenario description',
    run: async (page, step, screenshot) => {
      step('Navigate to Administration > Pricings (persona=admin)');
      await screenshot('before', { focus: page.locator('[name="base_price"]') });
      step('Set base_price=150.00');
      // ... AC-relevant action ...
      await screenshot('after',  { focus: page.locator('[name="base_price"]') });
    },
  },
];
```

Key rules:

- `ac:` is an array of AC clause **objects** (not numbers).
- `screenshot()` calls for AC evidence **require** a `focus` locator. The helper asserts visible + scrolls into view + captures the full viewport.
- Step labels **include input values** so the test is reproducible by hand from the report.
- Test names use domain language, never the ticket key.

See `modes/qa.md` for the full pipeline and hard rules.

## How the modes relate to the harness

```
/Fexa-AIden qa TANGO-9
        │
        ▼
   SKILL.md dispatcher
        │
        ▼
   modes/qa.md  ──► instructs Claude through the pipeline:
        │            env-precheck → ticket fetch → plan → scaffold ticket
        │            file from templates/ → node run.mjs → visual verify →
        │            post to Jira → commit
        │
        ▼
   node run.mjs TANGO-9   ◄── the existing Playwright harness
        │
        ▼
   lib/* modules + tickets/TANGO-9.mjs   ──►  reports/TANGO-9.html
```

The slash command is the disciplined entry point. `node run.mjs` is the underlying engine you can also invoke directly.
