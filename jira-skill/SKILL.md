---
name: Jira-Ticket
description: Fetch the user's Jira tickets in any open sprint, or pull the full details of a specific ticket. With no argument, lists all tickets currently assigned to the user across open sprints in a compact table. With a ticket key like "TANGO-123", fetches that ticket's full description, comments, parent, and metadata. Use this skill when the user asks what they have assigned, what they should work on, or for the details of a specific ticket.
---

# Jira-Ticket

Two modes, chosen by the user's input:

| User said | Mode | Action |
|---|---|---|
| `/Jira-Ticket` (no args) | **List** | Run `list.sh`. Print the resulting compact table verbatim. |
| `/Jira-Ticket TANGO-123` (or any ticket key) | **Detail** | Run `details.sh <KEY>`. Parse the JSON. Render as readable markdown using the rules below. |

## Memory bank — read every invocation (Fexy-Zamo)

Before running either mode, read **all four** Fexy-Zamo memory-bank files to load codebase context:

- `projectbrief.md` — what Fexy-Zamo is, scope, what's active vs not active
- `productContext.md` — domain glossary, user roles, navigation, core flows, integrations
- `systemPatterns.md` — architecture, conventions, the two big surprises (deployment-level multi-tenancy, state-machine pattern), anti-patterns
- `techContext.md` — stack versions, gems, commands, CI/deploy, gotchas

Locations:

- **From Windows-side Claude Code** (Read tool): `\\wsl.localhost\Ubuntu-24.04\home\<user>\work\Fexy-Zamo\memory-bank\<file>.md`
- **From WSL Bash tool**: `~/work/Fexy-Zamo/memory-bank/<file>.md`

Read order: **memory bank first**, then run the script (`list.sh` or `details.sh`), then synthesize the response. The bank is git-ignored — local to Bryan's machine, not shared with the team.

Don't quote these files back to the user. Use them silently to interpret ticket terms in domain language, propose solutions consistent with the codebase's conventions, and flag when a ticket conflicts with an established pattern.

If a file is missing or empty, surface that immediately and stop — the bank needs to be regenerated before useful work can resume.

> **Trakref note:** The product domain is Fexy-Zamo (enterprise facilities management). "Trakref" was a previous HVAC-specific repo at this company; in *this* codebase it appears only as one external integration. Don't apply HVAC-only assumptions to Fexy-Zamo tickets.

## Environment

- **Jira host**: `https://facilitiesexchange.atlassian.net`
- **User email**: `bryan@trakref.com`
- **Token**: file `token` in this skill's own directory (already populated). **Never print, echo, or include the token in any user-facing output.** If a token rotation is needed, regenerate at `https://id.atlassian.com/manage-profile/security/api-tokens` and overwrite the file with the new value.
- **JQL filter**: `assignee = currentUser() AND sprint in openSprints()` (auto-follows the current sprint, no hardcoded sprint name)
- **Branch convention** (relevant when this skill is later extended): `TANGO-<ticket-id>` for any ticket key, with PRs targeting `develop`.

## Running the scripts

This skill is invoked from a Windows-side Claude Code instance, but the scripts execute in WSL (curl, jq, and the token all live in the right places to make WSL the simpler shell to invoke). Use the **Bash tool** to run:

**List mode:**

```bash
wsl.exe -- bash "<path-to-repo>/jira-skill/list.sh"
```

**Detail mode** (substitute the actual ticket key the user gave):

```bash
wsl.exe -- bash "<path-to-repo>/jira-skill/details.sh" TANGO-123
```

The scripts handle token loading, error surfacing, and empty-result cases. Don't try to invoke curl yourself — always go through the scripts so token handling stays consistent and the token never appears in command output.

## Detail mode — rendering instructions

`details.sh` returns raw JSON from Jira's `/rest/api/3/issue/{key}` endpoint. Parse it and render readable markdown like this:

### Header (always)

```
# {key}: {fields.summary}

- **Status**: {fields.status.name}
- **Type**: {fields.issuetype.name}
- **Priority**: {fields.priority.name}     ← omit this line if priority is null
- **Labels**: {fields.labels joined with ", "}    ← omit this line if labels is empty
- **Reporter**: {fields.reporter.displayName}
- **Assignee**: {fields.assignee.displayName}
- **Parent**: [{fields.parent.key}] {fields.parent.fields.summary}    ← omit this line if no parent
- **Created**: {fields.created formatted YYYY-MM-DD}
- **Updated**: {fields.updated formatted YYYY-MM-DD}
```

### Description

The description is at `fields.description` and is in **Atlassian Document Format (ADF)** — a structured JSON tree, not markdown. Walk the tree and convert to markdown.

Common node types you'll encounter:

| ADF node | Markdown output |
|---|---|
| `paragraph` | text content, then a blank line |
| `heading` (level 1–6) | `#` / `##` / `###` (matching the level) |
| `bulletList` | `-` items, walk each `listItem` for content |
| `orderedList` | `1.` items, walk each `listItem` for content |
| `codeBlock` | fenced code block; use `attrs.language` if present |
| `blockquote` | `>` prefix on each line |
| `rule` | `---` |
| `text` with `marks: [{type: 'strong'}]` | `**text**` |
| `text` with `marks: [{type: 'em'}]` | `*text*` |
| `text` with `marks: [{type: 'code'}]` | `` `text` `` |
| `text` with `marks: [{type: 'link', attrs: {href}}]` | `[text](href)` |
| `mention` | `@{attrs.text \|\| attrs.displayName}` |
| `inlineCard` / `blockCard` | `[{attrs.url}]({attrs.url})` |
| `media`, `mediaSingle`, `mediaGroup` | `[attachment: {attrs.alt \|\| 'image'}]` (ADF media nodes don't carry direct URLs without an additional API call — leave a placeholder) |
| Anything else | walk children, ignore the wrapper |

If `fields.description` is null or has no content, write `_(no description)_`.

Output the description under a `## Description` heading.

### Comments

Comments are at `fields.comment.comments` (an array). Show **the 5 most recent in chronological order (oldest of those 5 first, newest last)**.

For each comment:

```
### {comment.author.displayName} — {comment.created formatted YYYY-MM-DD HH:MM}

{comment.body rendered from ADF using the same conversion rules as description}
```

If the comments array is empty, write `_(no comments)_`.

Output under a `## Comments` heading.

### Subtasks

Skip subtasks by default. If the ticket has subtasks (`fields.subtasks` non-empty) AND the user explicitly asks for them, list them as a `## Subtasks` table:

```
| Key | Status | Summary |
|---|---|---|
| TANGO-456 | In Progress | Update something |
```

## Errors

Surface error output verbatim. Specific cases:

| Error | What to tell the user |
|---|---|
| HTTP 401 in script output | "Jira token is invalid or expired. Regenerate at https://id.atlassian.com/manage-profile/security/api-tokens and overwrite the `token` file in the jira-skill directory with the new value." |
| Script error: token file missing or empty | Same as above — token file got deleted or wiped. Recreate it. |
| `jq: command not found` | "Run `sudo apt install -y jq` in WSL once. The skill needs `jq` for JSON parsing." |
| Jira returned `errorMessages[]` | Show each message verbatim. |

## Spec sheet output location (Fexy-Zamo)

When the user asks for a spec sheet/markdown for a ticket (a planning doc derived from the AC, comments, and any open questions), write it to the repo's `.claude-specs/` directory:

- **From Windows-side Claude Code** (Write tool): `\\wsl.localhost\Ubuntu-24.04\home\<user>\work\Fexy-Zamo\.claude-specs\<KEY>.md`
- **From WSL Bash tool**: `~/work/Fexy-Zamo/.claude-specs/<KEY>.md`

Filename convention: `<TICKET-KEY>.md` (e.g. `TANGO-3.md`). The folder is git-ignored via `.git/info/exclude`, so specs stay local and never get committed. Do not place them anywhere else, and do not commit them.

## What this skill does NOT do (current scope)

After fetching ticket details, **do not auto-start writing code, branching, or running tests**. Wait for the user's next instruction. Spec sheet creation is allowed when the user explicitly asks (output goes to `.claude-specs/` per above) — but everything past that (branching, code, tests, PR) is the user's call.
