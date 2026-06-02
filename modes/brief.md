# Brief mode — fetch and render a single ticket

You run this mode when the user types `/Fexa-AIden brief <TICKET-KEY>` (or invokes it conversationally: "show me TANGO-9", "what's in FIFI-12", "pull the details for FUN-3").

Your job: fetch the ticket's full content from Jira and render it as readable markdown — header, description, comments, optional subtasks. After rendering, **stop**. Don't auto-start writing code, branching, or running tests. Wait for the user's next instruction.

## When invoked

The user supplies a single ticket key in the form `<PROJECT>-<N>` (e.g. `TANGO-9`, `FIFI-12`, `FUN-3`). If they don't provide one or it's malformed, ask for the key. Don't guess.

## Pipeline

### 1. Load the Fexy-Zamo memory bank

Before fetching the ticket, read **all four** Fexy-Zamo memory-bank files to load codebase context:

- `projectbrief.md` — what Fexy-Zamo is, scope, what's active vs not active
- `productContext.md` — domain glossary, user roles, navigation, core flows, integrations
- `systemPatterns.md` — architecture, conventions, anti-patterns
- `techContext.md` — stack versions, gems, commands, CI/deploy, gotchas

Locations:

- **From Windows-side Claude Code** (Read tool): `\\wsl.localhost\Ubuntu-24.04\home\<user>\work\Fexy-Zamo\memory-bank\<file>.md`
- **From WSL Bash tool**: `~/work/Fexy-Zamo/memory-bank/<file>.md`

Read order: **memory bank first**, then run the fetch script, then synthesize the response. The bank is git-ignored — local to Bryan's machine, not shared with the team.

**Don't quote these files back to the user.** Use them silently to:
- Interpret ticket terms in domain language
- Flag when a ticket conflicts with an established pattern
- Surface relevant existing conventions when summarizing the ticket

**If a file is missing or empty**, surface that immediately and stop — the bank needs to be regenerated before useful work can resume.

> **Trakref note:** The product domain is Fexy-Zamo (enterprise facilities management). "Trakref" was a previous HVAC-specific repo at this company; in *this* codebase it appears only as one external integration. Don't apply HVAC-only assumptions to Fexy-Zamo tickets.

### 2. Fetch the ticket

The script needs `jq`, which Git Bash typically lacks. Invoke via WSL:

```bash
wsl -- bash <REPO-ROOT-AS-WSL-PATH>/scripts/jira-fetch.sh <TICKET-KEY>
```

Where `<REPO-ROOT-AS-WSL-PATH>` is the Fexa-AIden repo root in WSL form. Use `wslpath` to translate from a Windows path if needed.

The script returns raw JSON from `/rest/api/3/issue/{key}` — no transformation. Parse it and render per the rules below.

### 3. Render the ticket

#### Header (always)

```
# <key>: <fields.summary>

- **Status**: <fields.status.name>
- **Type**: <fields.issuetype.name>
- **Priority**: <fields.priority.name>     ← omit this line if priority is null
- **Labels**: <fields.labels joined with ", ">    ← omit this line if labels is empty
- **Reporter**: <fields.reporter.displayName>
- **Assignee**: <fields.assignee.displayName>
- **Parent**: [<fields.parent.key>] <fields.parent.fields.summary>    ← omit if no parent
- **Created**: <fields.created formatted YYYY-MM-DD>
- **Updated**: <fields.updated formatted YYYY-MM-DD>
```

#### Description

`fields.description` is in **Atlassian Document Format (ADF)** — a structured JSON tree, not markdown. Walk the tree and convert to markdown. Common nodes:

| ADF node                                          | Markdown output                                                |
|---|---|
| `paragraph`                                       | text content, then a blank line                                |
| `heading` (level 1–6)                            | `#` / `##` / `###` matching the level                          |
| `bulletList`                                      | `-` items, walk each `listItem` for content                    |
| `orderedList`                                     | `1.` items, walk each `listItem` for content                   |
| `codeBlock`                                       | fenced code block; use `attrs.language` if present             |
| `blockquote`                                      | `>` prefix on each line                                        |
| `rule`                                            | `---`                                                          |
| `text` with `marks: [{type: 'strong'}]`           | `**text**`                                                     |
| `text` with `marks: [{type: 'em'}]`               | `*text*`                                                       |
| `text` with `marks: [{type: 'code'}]`             | `` `text` ``                                                   |
| `text` with `marks: [{type: 'link', attrs:{href}}]` | `[text](href)`                                                |
| `mention`                                         | `@<attrs.text \|\| attrs.displayName>`                         |
| `inlineCard` / `blockCard`                        | `[<attrs.url>](<attrs.url>)`                                   |
| `media`, `mediaSingle`, `mediaGroup`              | `[attachment: <attrs.alt \|\| 'image'>]` (placeholder)         |
| Anything else                                     | walk children, ignore the wrapper                              |

If `fields.description` is null or has no content, write `_(no description)_`.

Output under a `## Description` heading.

#### Comments

Comments are at `fields.comment.comments` (an array). Show **the 5 most recent in chronological order (oldest of those 5 first, newest last)**.

For each comment:

```
### <comment.author.displayName> — <comment.created formatted YYYY-MM-DD HH:MM>

<comment.body rendered from ADF using the same rules as description>
```

If the comments array is empty, write `_(no comments)_`.

Output under a `## Comments` heading.

#### Subtasks

Skip subtasks by default. If `fields.subtasks` is non-empty AND the user explicitly asks for them, render as a `## Subtasks` table:

```
| Key | Status | Summary |
|---|---|---|
| TANGO-456 | In Progress | Update something |
```

### 4. Attachments (only when asked)

If the user asks to see attachments, list them:

```bash
wsl -- bash <REPO-ROOT-AS-WSL-PATH>/scripts/jira-attachments.sh <TICKET-KEY>
```

To download a specific attachment:

```bash
wsl -- bash <REPO-ROOT-AS-WSL-PATH>/scripts/jira-download-attachment.sh <TICKET-KEY> <ATTACHMENT-ID> [output-filename]
```

Downloads land in `<repo-root>/_attachments/` (gitignored).

### 5. Stop

After rendering, wait for the user's next instruction. Do **not** auto-start any of:
- Writing code
- Branching
- Drafting a spec sheet (that's `/Fexa-AIden spec` — a future mode)
- Running QA (that's `/Fexa-AIden qa`)

If the user follows up with "now spec this" or "now QA this," route to the appropriate mode.

## Errors

Surface error output verbatim. Specific cases:

| Error                                       | What to tell the user                                                                                                                                                     |
|---|---|
| `ERROR: token file missing`                | The Jira token file at `<repo>/token` is missing. Generate one at https://id.atlassian.com/manage-profile/security/api-tokens and save it (one line, no quotes).          |
| `ERROR: token file ... is empty`           | Same as above — recreate the token file.                                                                                                                                  |
| `jq: command not found`                    | "Run `sudo apt install -y jq` in WSL once. The script needs `jq` for JSON parsing."                                                                                       |
| HTTP 401 in output                          | "Jira token is invalid or expired. Regenerate at https://id.atlassian.com/manage-profile/security/api-tokens and overwrite the `token` file at the repo root."           |
| Jira returned `errorMessages[]`            | Show each message verbatim.                                                                                                                                               |
| Ticket key not found (404)                 | "Ticket `<KEY>` not found. Double-check the key and that you have access."                                                                                                |
| Memory-bank file missing or empty          | Stop. Tell the user which file is missing and that the bank needs to be regenerated before brief mode can run.                                                            |

## Hard rules

- **Never print the Jira token** in any user-facing output.
- **Verbatim AC text matters** — when the ticket has acceptance criteria, preserve exact wording in your rendering. Don't paraphrase.
- **Memory bank silent** — use it to interpret terms, but don't quote files back unless the user asks.
- **No auto-actions after rendering** — wait for the user's next instruction.

## What success looks like

The user types `/Fexa-AIden brief TANGO-9`, sees a clean markdown rendering of the ticket within a few seconds (header → description → comments), and the conversation pauses for their next instruction.
