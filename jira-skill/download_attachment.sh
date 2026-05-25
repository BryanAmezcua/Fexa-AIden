#!/bin/bash
# Downloads a single Jira attachment by ID into _attachments/.
# Usage: download_attachment.sh <TICKET-KEY> <ATTACHMENT-ID> [output-filename]
# Output filename defaults to "<KEY>_attachment_<ID>.bin" if not given.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN_FILE="$SCRIPT_DIR/token"
ATTACH_DIR="$SCRIPT_DIR/_attachments"
EMAIL='bryan@trakref.com'
HOST='https://facilitiesexchange.atlassian.net'

if [[ -z "${1:-}" || -z "${2:-}" ]]; then
  echo "Usage: $0 <TICKET-KEY> <ATTACHMENT-ID> [output-filename]" >&2
  exit 1
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "ERROR: token file missing at $TOKEN_FILE" >&2
  exit 1
fi

TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")
KEY="$1"
ATTACH_ID="$2"
OUT_NAME="${3:-${KEY}_attachment_${ATTACH_ID}.bin}"

mkdir -p "$ATTACH_DIR"
OUT_PATH="$ATTACH_DIR/$OUT_NAME"

curl -sS -L -u "$EMAIL:$TOKEN" -o "$OUT_PATH" \
  "$HOST/rest/api/3/attachment/content/$ATTACH_ID"

echo "saved: $OUT_PATH"
ls -la "$OUT_PATH"
file "$OUT_PATH"
