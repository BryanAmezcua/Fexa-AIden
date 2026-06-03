#!/usr/bin/env bash
#
# Put Fexy-Zamo into "fast mode" for TANGO test runs:
#   1. Build the Sencha app in production mode (~2 minutes, idempotent)
#   2. Patch config/routes.rb so Rails serves the built bundle instead of
#      the dev-mode unpacked Ext sources (which take 60–120s to boot)
#
# After this script completes you must restart your Rails server manually
# before tests will see the fast bundle. The script prints a clear reminder.
#
# Revert with: bin/fexa-dev-mode.sh
#
# Env vars:
#   FEXY_ZAMO_PATH   path to Fexy-Zamo checkout (default: ../Fexy-Zamo)
#   FORCE_REBUILD    set to 1 to rebuild even if a build already exists
#   SKIP_ES_LOCALE   set to 1 to drop the Spanish locale from the build for
#                    faster build times (mutates app.json; reverted by dev-mode)

set -euo pipefail

FEXA_PATH="${FEXY_ZAMO_PATH:-../Fexy-Zamo}"

if [ ! -d "$FEXA_PATH" ]; then
  echo "[tango] ❌ FEXY_ZAMO_PATH not found: $FEXA_PATH" >&2
  exit 1
fi

if ! command -v sencha >/dev/null 2>&1; then
  echo "[tango] ❌ sencha CLI not on PATH. Install Sencha Cmd 6.5.3+ and try again." >&2
  exit 1
fi

cd "$FEXA_PATH"
FEXA_ABS="$(pwd)"
ROUTES="$FEXA_ABS/config/routes.rb"
APP_JSON="$FEXA_ABS/app/assets/javascripts/app.json"
BUILD_DIR="$FEXA_ABS/app/assets/javascripts/build/production/Fexy"

echo "[tango] Fexy-Zamo at: $FEXA_ABS"

# --- Patch routes.rb ----------------------------------------------------------

if grep -q "TANGO_FAST_MODE" "$ROUTES"; then
  echo "[tango] routes.rb already in fast mode (TANGO_FAST_MODE marker present)"
else
  echo "[tango] Patching routes.rb: 'if Rails.env.development?' -> 'if false'"
  # macOS/BSD sed compatible. Backup at routes.rb.tango-bak.
  sed -i.tango-bak \
    's|^\([[:space:]]*\)if Rails\.env\.development?[[:space:]]*$|\1if false # TANGO_FAST_MODE was: if Rails.env.development?|' \
    "$ROUTES"
  if ! grep -q "TANGO_FAST_MODE" "$ROUTES"; then
    echo "[tango] ❌ Failed to patch routes.rb — pattern didn't match." >&2
    mv "$ROUTES.tango-bak" "$ROUTES"
    exit 1
  fi
fi

# --- Optionally drop es locale for faster build ------------------------------

if [ "${SKIP_ES_LOCALE:-0}" = "1" ] && [ -f "$APP_JSON" ]; then
  if grep -q "TANGO_SKIP_ES" "$APP_JSON"; then
    echo "[tango] app.json already has es locale removed"
  else
    echo "[tango] Removing 'es' locale from app.json (TANGO_SKIP_ES marker)"
    cp "$APP_JSON" "$APP_JSON.tango-bak"
    # Remove 'es' from the locales array. Conservative: only matches the
    # exact ', "es"' or '"es", ' pattern to avoid breaking JSON elsewhere.
    sed -i.tmp -e 's|, *"es"||g' -e 's|"es" *, *||g' "$APP_JSON"
    # Tag with a comment-line at the top is not valid JSON; use a JSON-safe
    # marker instead by appending nothing — just rely on the .tango-bak file
    # to detect "we modified this" in dev-mode.
    rm -f "$APP_JSON.tmp"
    touch "$APP_JSON.tango-bak"  # marker for revert (idempotent)
    # Also write a sentinel so we can detect on re-runs:
    cat > "$FEXA_ABS/.tango-skip-es" <<'EOF'
# Created by TANGO fast-mode. Indicates app.json had 'es' locale removed.
# Removed by bin/fexa-dev-mode.sh
EOF
  fi
fi

# --- Build the Sencha app ----------------------------------------------------

if [ -d "$BUILD_DIR" ] && [ "${FORCE_REBUILD:-0}" != "1" ]; then
  echo "[tango] Existing Sencha build found at $BUILD_DIR"
  echo "[tango] Skipping rebuild. Set FORCE_REBUILD=1 to force."
else
  echo "[tango] Building Sencha app (production, --clean). This takes ~2 minutes..."
  # Sencha app root is where app.json + .sencha live: app/assets/javascripts/
  # (this checkout keeps the app root here, not in a nested app/ subdir).
  cd "$FEXA_ABS/app/assets/javascripts"
  _JAVA_OPTIONS="-Xms256m -Xmx2560m" sencha app build --production --clean
  cd "$FEXA_ABS"
  if [ ! -d "$BUILD_DIR" ]; then
    echo "[tango] ❌ Build succeeded but $BUILD_DIR is missing — check sencha output." >&2
    exit 1
  fi
fi

# --- Done -------------------------------------------------------------------

cat <<EOF

[tango] ✅ Fast mode enabled.

  ⚠️  Restart your Rails server now:
      In the terminal running rails: Ctrl-C, then re-run \`rails server\`

  After restart, visit http://localhost:3000/main/index to confirm fast load.

  Revert with: npm run fexa:dev-mode
EOF
