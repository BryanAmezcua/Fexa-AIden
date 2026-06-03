#!/usr/bin/env bash
#
# Revert Fexy-Zamo from "fast mode" back to development mode.
# Only undoes file mutations — the production build directory is left in
# place (harmless, can be removed with `sencha app clean`).

set -euo pipefail

FEXA_PATH="${FEXY_ZAMO_PATH:-../Fexy-Zamo}"

if [ ! -d "$FEXA_PATH" ]; then
  echo "[tango] ❌ FEXY_ZAMO_PATH not found: $FEXA_PATH" >&2
  exit 1
fi

cd "$FEXA_PATH"
FEXA_ABS="$(pwd)"
ROUTES="$FEXA_ABS/config/routes.rb"
APP_JSON="$FEXA_ABS/app/assets/javascripts/app/app.json"

# --- Revert routes.rb -------------------------------------------------------

if grep -q "TANGO_FAST_MODE" "$ROUTES"; then
  echo "[tango] Reverting routes.rb to development mode..."
  sed -i.tango-bak \
    's|^\([[:space:]]*\)if false # TANGO_FAST_MODE was: if Rails\.env\.development?[[:space:]]*$|\1if Rails.env.development?|' \
    "$ROUTES"
  if grep -q "TANGO_FAST_MODE" "$ROUTES"; then
    echo "[tango] ❌ Revert failed — marker still present." >&2
    exit 1
  fi
  echo "[tango] routes.rb restored."
else
  echo "[tango] routes.rb already in dev mode."
fi

# --- Revert app.json if es-locale was skipped -------------------------------

if [ -f "$FEXA_ABS/.tango-skip-es" ] && [ -f "$APP_JSON.tango-bak" ]; then
  echo "[tango] Restoring app.json from backup..."
  mv "$APP_JSON.tango-bak" "$APP_JSON"
  rm -f "$FEXA_ABS/.tango-skip-es"
fi

# Clean up sed backup file if it's identical to current (no-op revert)
[ -f "$ROUTES.tango-bak" ] && rm -f "$ROUTES.tango-bak"

cat <<EOF

[tango] ✅ Dev mode restored.

  ⚠️  Restart your Rails server to pick up the routes change.

  Note: the production build at public/assets/build/production/Fexy/
  is left in place (harmless). Remove via 'sencha app clean' if desired.
EOF
