#!/usr/bin/env bash
# scripts/env-precheck.sh — Verify Fexy-Zamo is reachable and (locally) in fast-mode.
#
# Usage:
#   scripts/env-precheck.sh                  # local: localhost:3000, require fast-mode redirect
#   scripts/env-precheck.sh --url <URL>      # remote: just check reachability, skip fast-mode
#
# Exit codes:
#   0 — environment OK
#   1 — Rails not reachable
#   2 — Rails in dev-mode (only checked for local target)
#  64 — bad usage

set -euo pipefail

TARGET_URL="http://localhost:3000"
EXPECT_FAST_MODE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --url requires a value" >&2
        exit 64
      fi
      TARGET_URL="$2"
      EXPECT_FAST_MODE=0
      shift 2
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

echo "Checking ${TARGET_URL} ..."

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${TARGET_URL}/" || echo "000")
if [[ "${HTTP_CODE}" == "000" ]]; then
  echo "ERROR: ${TARGET_URL} is not reachable. Is Rails running?" >&2
  exit 1
fi

if [[ "${EXPECT_FAST_MODE}" == "1" ]]; then
  REDIRECT=$(curl -s -o /dev/null -w "%{redirect_url}" --max-time 10 "${TARGET_URL}/" || echo "")
  if [[ "${REDIRECT}" == *"/main/development"* ]]; then
    echo "ERROR: Fexy-Zamo is in dev-mode (redirect: ${REDIRECT})." >&2
    echo "  Run 'npm run fexa:fast-mode' in the Fexy-Zamo repo, then restart 'rails server'." >&2
    exit 2
  fi
  if [[ -n "${REDIRECT}" && "${REDIRECT}" != *"/main/index"* ]]; then
    echo "WARNING: expected redirect to /main/index, got: ${REDIRECT}" >&2
    echo "  Proceeding, but Sencha may not be in fast-mode." >&2
  fi
fi

echo "OK: ${TARGET_URL} reachable (HTTP ${HTTP_CODE})"
