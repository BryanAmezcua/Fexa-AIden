# List mode — show my open-sprint tickets

You run this mode when the user types `/Fexa-AIden list` (or invokes it conversationally: "what do I have on my plate", "list my tickets", "what's in my sprint").

Your job: print a compact table of every ticket currently assigned to the user across all open sprints. That's it — don't fetch details, don't draft specs, don't suggest next steps unless asked.

## When invoked

The user supplies no arguments. The JQL filter is hard-coded inside the script: `assignee = currentUser() AND sprint in openSprints()`. If the user wants different filtering (different assignee, closed sprints, specific board), tell them this mode doesn't take filters and point them at the Jira UI.

## Pipeline

### 1. Run the list script

The script needs `jq` and `column`, which Git Bash typically lacks. Invoke via WSL:

```bash
wsl -- bash <REPO-ROOT-AS-WSL-PATH>/scripts/jira-list.sh
```

Where `<REPO-ROOT-AS-WSL-PATH>` is the Fexa-AIden repo root in WSL form (e.g., `/mnt/c/Users/bryan/.claude/skills/Fexa-AIden` if the repo has been moved to its final location, otherwise the current path). Use `wslpath` to translate from a Windows path if needed.

### 2. Print the result verbatim

The script outputs a column-aligned table:

```
KEY        TYPE   STATUS       PRIORITY  SUMMARY
TANGO-9    Story  In Progress  High      Build V2 Import for Pricings
TANGO-44   Story  In Progress  Medium    Add Vendor NTE to Assignments mass manage
…
```

Print this verbatim to the user — don't reformat, don't add commentary. The table is the answer.

If the script prints `(no tickets in any open sprint assigned to <email>)`, surface that exactly.

### 3. Stop

This mode does not load the Fexy-Zamo memory bank, does not fetch ticket details, and does not suggest follow-ups. If the user wants to dig into a ticket, tell them to use `/Fexa-AIden brief <KEY>`.

## Errors

Surface error output verbatim. Specific cases:

| Error                                       | What to tell the user                                                                                                                                                     |
|---|---|
| `ERROR: token file missing`                | The Jira token file at `<repo>/token` is missing. Generate one at https://id.atlassian.com/manage-profile/security/api-tokens and save it (one line, no quotes).          |
| `ERROR: token file ... is empty`           | Same as above — recreate the token file.                                                                                                                                  |
| `jq: command not found`                    | "Run `sudo apt install -y jq` in WSL once. The script needs `jq` for JSON parsing."                                                                                       |
| HTTP 401 visible in output                 | "Jira token is invalid or expired. Regenerate at https://id.atlassian.com/manage-profile/security/api-tokens and overwrite the `token` file at the repo root."           |
| Jira returned `errorMessages[]`            | Show each message verbatim.                                                                                                                                               |

## Hard rules

- **Never print the Jira token** in any user-facing output, even if you see it in script paths or error messages.
- **No filter changes.** This mode is JQL-locked. If the user wants different filtering, point them at the Jira UI or a future enhancement.
- **No follow-up actions.** Print the table, stop. Don't auto-fetch any ticket details.

## What success looks like

The user types `/Fexa-AIden list`, sees a column-aligned table of their open-sprint tickets within a few seconds, and the conversation ends until they choose what to do next.
