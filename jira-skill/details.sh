#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN_FILE="$SCRIPT_DIR/token"

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
