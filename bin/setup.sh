#!/usr/bin/env bash
#
# One-shot setup for the Aiden agent repo. Run from anywhere, inside WSL:
#   bin/setup.sh
#
# Installs the QA engine's Node deps + Playwright chromium and scaffolds qa/.env.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "[setup] repo: $ROOT"

case "$ROOT" in
  /mnt/*) echo "[setup] WARNING: $ROOT is on the Windows mount. Clone into WSL home (~/work) — node_modules/Playwright/Sencha are slow across /mnt/c." ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "[setup] ERROR: node not on PATH. Install Node 18+ in WSL." >&2; exit 1
fi

cd "$ROOT/qa"
echo "[setup] installing qa/ deps (npm install)..."
npm install
echo "[setup] installing Playwright chromium..."
npx playwright install chromium

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[setup] created qa/.env from .env.example"
fi
cd "$ROOT"

cat <<'EOF'

[setup] Done. Remaining manual steps:
  1) export FEXY_ZAMO_PATH=~/work/Fexy-Zamo        # add to ~/.bashrc
  2) edit qa/.env                                  # TEST_BASE_URL + admin/vendor/facility-manager creds
  3) add Jira token (one line):                    # .claude/skills/Fexa-AIden/token
  4) cd qa && npm run fexa:fast-mode               # then restart Rails (overmind web)
  5) run a ticket:
       cd qa && npm run seed:<descriptor>
       cd qa && npx playwright test tests/<area>/<descriptor>.spec.ts
     -> report at qa/reports/latest/<TICKET>.html
EOF
