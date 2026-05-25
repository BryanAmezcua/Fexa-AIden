#!/bin/bash
# Lists attachments on a Jira issue. Outputs TSV: id<TAB>filename<TAB>content_url
# Usage: fetch_attachments.sh <TICKET-KEY>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN_FILE="$SCRIPT_DIR/token"
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
