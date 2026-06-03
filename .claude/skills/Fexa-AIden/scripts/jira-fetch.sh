#!/bin/bash
# scripts/jira-fetch.sh — Fetch a single Jira ticket's full details.
#
# Reads the Jira API token from the Fexa-AIden repo root (one level up from this script).
# Prints raw JSON from /rest/api/3/issue/{key} so callers can parse with jq.
#
# Usage: jira-fetch.sh <TICKET-KEY>  (e.g., TANGO-123)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
TOKEN_FILE="$REPO_ROOT/token"

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <TICKET-KEY>  (e.g., TANGO-123)" >&2
  exit 1
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "ERROR: token file missing at $TOKEN_FILE" >&2
  exit 1
fi

JIRA_API_TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")

if [[ -z "$JIRA_API_TOKEN" ]]; then
  echo "ERROR: token file at $TOKEN_FILE is empty." >&2
  exit 1
fi

KEY="$1"
EMAIL="bryan@trakref.com"
HOST="https://facilitiesexchange.atlassian.net"

curl -sS \
  -u "$EMAIL:$JIRA_API_TOKEN" \
  -G "$HOST/rest/api/3/issue/$KEY" \
  --data-urlencode "fields=summary,status,issuetype,priority,labels,description,parent,subtasks,comment,assignee,reporter,created,updated"
