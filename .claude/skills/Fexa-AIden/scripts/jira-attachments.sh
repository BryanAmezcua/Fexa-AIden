#!/bin/bash
# scripts/jira-attachments.sh — List attachments on a Jira issue.
#
# Reads the Jira API token from the Fexa-AIden repo root (one level up from this script).
# Outputs TSV: id<TAB>filename<TAB>content_url
#
# Usage: jira-attachments.sh <TICKET-KEY>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
TOKEN_FILE="$REPO_ROOT/token"
EMAIL='bryan@trakref.com'
HOST='https://facilitiesexchange.atlassian.net'

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <TICKET-KEY>" >&2
  exit 1
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "ERROR: token file missing at $TOKEN_FILE" >&2
  exit 1
fi

TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")
KEY="$1"

curl -sS -u "$EMAIL:$TOKEN" -G "$HOST/rest/api/3/issue/$KEY" \
  --data-urlencode 'fields=attachment' \
  | jq -r '.fields.attachment[] | [.id, .filename, .content] | @tsv'
