#!/bin/bash
# scripts/jira-list.sh — List tickets assigned to the user across all open sprints.
#
# Reads the Jira API token from the Fexa-AIden repo root (one level up from this script).
# Outputs a compact TSV table: KEY  TYPE  STATUS  PRIORITY  SUMMARY
#
# Requires: curl, jq, column (use WSL on Windows; Git Bash typically lacks jq/column).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
TOKEN_FILE="$REPO_ROOT/token"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "ERROR: token file missing at $TOKEN_FILE" >&2
  echo "Paste your Jira API token (one line, no quotes)." >&2
  exit 1
fi

JIRA_API_TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")

if [[ -z "$JIRA_API_TOKEN" ]]; then
  echo "ERROR: token file at $TOKEN_FILE is empty." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not installed. Run: sudo apt install -y jq" >&2
  exit 1
fi

EMAIL="bryan@trakref.com"
HOST="https://facilitiesexchange.atlassian.net"

response=$(curl -sS \
  -u "$EMAIL:$JIRA_API_TOKEN" \
  -G "$HOST/rest/api/3/search/jql" \
  --data-urlencode "jql=assignee = currentUser() AND sprint in openSprints()" \
  --data-urlencode "fields=summary,status,issuetype,priority")

# Surface API errors
if echo "$response" | jq -e '.errorMessages // empty | length > 0' >/dev/null 2>&1; then
  echo "Jira returned an error:" >&2
  echo "$response" | jq -r '.errorMessages[]' >&2
  exit 1
fi

# Empty result?
issue_count=$(echo "$response" | jq -r '(.issues // []) | length')
if [[ "$issue_count" -eq 0 ]]; then
  echo "(no tickets in any open sprint assigned to $EMAIL)"
  exit 0
fi

# Print compact table: KEY  TYPE  STATUS  PRIORITY  SUMMARY
{
  printf "KEY\tTYPE\tSTATUS\tPRIORITY\tSUMMARY\n"
  echo "$response" | jq -r '
    .issues[] | [
      .key,
      .fields.issuetype.name,
      .fields.status.name,
      (.fields.priority.name // "—"),
      .fields.summary
    ] | @tsv
  '
} | column -t -s $'\t'
