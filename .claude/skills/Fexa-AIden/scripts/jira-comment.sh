#!/bin/bash
# scripts/jira-comment.sh — Post a comment to a Jira issue.
#
# Reads the Jira API token from the Fexa-AIden repo root (one level up from this
# script) — same token-read as jira-fetch.sh, so it's portable across clones.
#
# The request body is Atlassian Document Format (ADF), supplied as a JSON file or
# on stdin. The file must be the full comment payload, i.e. an object that wraps
# the ADF document under "body":
#
#   { "body": { "type": "doc", "version": 1, "content": [ ... ] } }
#
# On success prints the new comment id + a focused browse URL.
#
# Usage:
#   scripts/jira-comment.sh <TICKET-KEY> <adf-body.json>
#   scripts/jira-comment.sh <TICKET-KEY> -      # read the ADF body from stdin

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
TOKEN_FILE="$REPO_ROOT/token"
EMAIL='bryan@trakref.com'
HOST='https://facilitiesexchange.atlassian.net'

if [[ -z "${1:-}" || -z "${2:-}" ]]; then
  echo "Usage: $0 <TICKET-KEY> <adf-body.json|->   (- = read body from stdin)" >&2
  exit 1
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "ERROR: token file missing at $TOKEN_FILE" >&2
  exit 1
fi

TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: token file at $TOKEN_FILE is empty." >&2
  exit 1
fi

KEY="$1"
BODY_SRC="$2"

if [[ "$BODY_SRC" == "-" ]]; then
  BODY_DATA="$(cat)"
elif [[ -f "$BODY_SRC" ]]; then
  BODY_DATA="$(cat "$BODY_SRC")"
else
  echo "ERROR: ADF body file not found: $BODY_SRC" >&2
  exit 1
fi

RESP_FILE="$(mktemp)"
trap 'rm -f "$RESP_FILE"' EXIT

HTTP=$(curl -sS -u "$EMAIL:$TOKEN" -X POST \
  -H 'Content-Type: application/json' \
  --data-binary "$BODY_DATA" \
  "$HOST/rest/api/3/issue/$KEY/comment" \
  -o "$RESP_FILE" -w '%{http_code}')

if [[ "$HTTP" == "201" ]]; then
  CID=$(jq -r '.id' < "$RESP_FILE" 2>/dev/null || echo '?')
  echo "Posted comment $CID to $KEY (HTTP $HTTP)"
  echo "  $HOST/browse/$KEY?focusedCommentId=$CID"
else
  echo "ERROR: comment POST to $KEY failed (HTTP $HTTP)" >&2
  cat "$RESP_FILE" >&2
  exit 1
fi
