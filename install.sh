#!/usr/bin/env bash
# =============================================================================
# Databricks Apps Admin — Full workspace bootstrap
# =============================================================================
# Interactive installer: deploys the scale-to-zero monitoring job and the
# Databricks Apps Admin panel into a target Databricks workspace.
#
# Run:  ./install.sh
# =============================================================================

set -euo pipefail

BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITORING_DIR="$REPO_ROOT/monitoring"
ADMIN_DIR="$REPO_ROOT/admin-panel"

# ── Check prerequisites ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Databricks Apps Admin — Installer${NC}"
echo "════════════════════════════════════════════"
echo ""
echo -e "${CYAN}Checking prerequisites...${NC}"

# 1. Databricks CLI
if ! command -v databricks &>/dev/null; then
  echo -e "${RED}✗ Databricks CLI not found.${NC}"
  echo ""
  echo "  Install it first:"
  echo "  → macOS:   brew tap databricks/tap && brew install databricks"
  echo "  → pip:     pip install databricks-cli"
  echo "  → Docs:    https://docs.databricks.com/en/dev-tools/cli/install.html"
  echo ""
  echo "  After installing, configure a profile:"
  echo "  → databricks configure --profile <name>"
  echo "  → Docs:    https://docs.databricks.com/en/dev-tools/cli/authentication.html"
  exit 1
fi
echo -e "  ${GREEN}✓ Databricks CLI ${NC}$(databricks --version 2>/dev/null | head -1)"

# 2. Node.js / npm (for admin panel)
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
  echo -e "${YELLOW}⚠ Node.js / npm not found. Admin panel deployment will be skipped.${NC}"
  echo "  Install: https://nodejs.org (v18+)"
  SKIP_ADMIN_PREREQ=true
else
  NODE_VER=$(node --version | sed 's/v//')
  MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [[ "$MAJOR" -lt 18 ]]; then
    echo -e "${YELLOW}⚠ Node.js $NODE_VER < v18. Admin panel deployment will be skipped.${NC}"
    SKIP_ADMIN_PREREQ=true
  else
    echo -e "  ${GREEN}✓ Node.js $NODE_VER${NC}"
    SKIP_ADMIN_PREREQ=false
  fi
fi

echo ""

# ── Interactive configuration ─────────────────────────────────────────────────
prompt() {
  local var="$1" label="$2" default="$3"
  read -rp "$(echo -e "  ${CYAN}${label}${NC} [${default}]: ")" input
  echo "${input:-$default}"
}

prompt_yn() {
  local label="$1" default="$2"
  read -rp "$(echo -e "  ${CYAN}${label}${NC} [${default}]: ")" input
  echo "${input:-$default}"
}

echo -e "${BOLD}Configuration${NC}"
echo "────────────────────────────────────────────"
echo ""

# List available profiles to help the user choose
echo -e "  Available Databricks CLI profiles:"
grep '^\[' ~/.databrickscfg 2>/dev/null | tr -d '[]' | while read -r p; do
  echo "    · $p"
done || echo "    (none found — run: databricks configure --profile <name>)"
echo ""

PROFILE=$(prompt PROFILE    "Databricks CLI profile" "DEFAULT")
CATALOG=$(prompt CATALOG    "Unity Catalog name     " "main")
SCHEMA=$(prompt  SCHEMA     "Telemetry schema name  " "app_telemetry")
FORCE_STOP_HOUR=$(prompt FORCE_STOP_HOUR "Force-stop hour (0-23 UTC)" "22")
IDLE_MINUTES=$(prompt IDLE_MINUTES       "Idle threshold (minutes)  " "30")
DBU_RATE=$(prompt DBU_RATE              "DBU cost rate (\$/DBU)     " "0.75")

SKIP_JOB_INPUT=$(prompt_yn "Deploy monitoring job? (y/n)" "y")
[[ "$SKIP_JOB_INPUT" =~ ^[Nn] ]] && SKIP_JOB=true || SKIP_JOB=false

if [[ "$SKIP_ADMIN_PREREQ" == "false" ]]; then
  SKIP_ADMIN_INPUT=$(prompt_yn "Deploy admin panel? (y/n)" "y")
  [[ "$SKIP_ADMIN_INPUT" =~ ^[Nn] ]] && SKIP_ADMIN=true || SKIP_ADMIN=false
else
  SKIP_ADMIN=true
fi

DRY_RUN_INPUT=$(prompt_yn "Dry run only (validate, no deploy)? (y/n)" "n")
[[ "$DRY_RUN_INPUT" =~ ^[Yy] ]] && DRY_RUN=true || DRY_RUN=false

echo ""

CLI="databricks --profile $PROFILE"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Scale-to-Zero Installer                                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Profile          : $PROFILE"
echo "  Telemetry catalog: $CATALOG"
echo "  Telemetry schema : $SCHEMA"
echo "  Force stop hour  : ${FORCE_STOP_HOUR}:00 UTC"
echo "  Idle threshold   : ${IDLE_MINUTES} minutes"
echo "  DBU rate         : \$${DBU_RATE}/DBU"
echo "  Deploy job       : $( [[ "$SKIP_JOB"   == true ]] && echo "no (skip)" || echo "yes" )
  Deploy admin app : $( [[ "$SKIP_ADMIN" == true ]] && echo "no (skip)" || echo "yes" )"
echo "  Dry run          : $DRY_RUN"
echo ""

# ── Validate CLI auth ─────────────────────────────────────────────────────────
echo "▶ Checking Databricks CLI auth..."
WORKSPACE_HOST=$($CLI current-user me --output json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('emails',[{}])[0].get('value','?'))" 2>/dev/null || echo "unknown")
echo "  Authenticated as: $WORKSPACE_HOST"

# ── Derive workspace ID ───────────────────────────────────────────────────────
WORKSPACE_ID=$($CLI warehouses list --output json 2>/dev/null \
  | python3 -c "import sys,json; wh=json.load(sys.stdin); print(wh.get('warehouses',[{}])[0].get('warehouse_id','')) if isinstance(wh,dict) else print('')" 2>/dev/null || echo "")

# ── Find or use a SQL warehouse ───────────────────────────────────────────────
echo "▶ Finding SQL warehouse..."
WAREHOUSE_ID=$($CLI warehouses list --output json 2>/dev/null \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
whs = data.get('warehouses', []) if isinstance(data, dict) else data
# prefer RUNNING, then any
for w in sorted(whs, key=lambda x: x.get('state','') != 'RUNNING'):
    print(w.get('id',''))
    break
" 2>/dev/null || echo "")

if [[ -z "$WAREHOUSE_ID" ]]; then
  echo "  ERROR: No SQL warehouse found. Create one first."
  exit 1
fi
echo "  Using warehouse: $WAREHOUSE_ID"

if [[ "$DRY_RUN" == true ]]; then
  echo ""
  echo "DRY RUN — validation complete. Re-run without --dry-run to deploy."
  exit 0
fi

# ── Step 1: Create telemetry schema ──────────────────────────────────────────
echo ""
echo "▶ Step 1/4 — Creating telemetry schema ${CATALOG}.${SCHEMA}..."
$CLI api post /api/2.0/sql/statements \
  --json "{\"warehouse_id\":\"${WAREHOUSE_ID}\",\"statement\":\"CREATE SCHEMA IF NOT EXISTS \`${CATALOG}\`.\`${SCHEMA}\`\",\"wait_timeout\":\"30s\"}" \
  > /dev/null 2>&1 && echo "  Schema ready." || echo "  Warning: schema creation returned an error (may already exist)."

# ── Step 2: Deploy monitoring job ─────────────────────────────────────────────
echo ""
if [[ "$SKIP_JOB" == true ]]; then
  echo "▶ Step 2/4 — Monitoring job skipped."
else
echo "▶ Step 2/4 — Deploying scale-to-zero monitoring job..."
cd "$MONITORING_DIR"

# Patch databricks.yml variables with install-time values
cat databricks.yml \
  | sed "s|default: \"serverless_stable_3rlc3e_catalog\"|default: \"${CATALOG}\"|g" \
  | sed "s|default: \"app_telemetry\"|default: \"${SCHEMA}\"|g" \
  | sed "s|default: \"30\"|default: \"${IDLE_MINUTES}\"|g" \
  | sed "s|default: \"22\"|default: \"${FORCE_STOP_HOUR}\"|g" \
  > /tmp/databricks_install.yml

cp databricks.yml databricks.yml.bak
cp /tmp/databricks_install.yml databricks.yml

$CLI bundle deploy --target default --profile "$PROFILE" 2>&1 || {
  echo "  Note: bundle deploy failed — check profile/target configuration."
  cp databricks.yml.bak databricks.yml
  exit 1
}
cp databricks.yml.bak databricks.yml
rm -f /tmp/databricks_install.yml databricks.yml.bak

echo "  Monitoring job deployed."
fi  # SKIP_JOB

# ── Step 3: Deploy admin panel ────────────────────────────────────────────────
if [[ "$SKIP_ADMIN" == false ]]; then
  echo ""
  echo "▶ Step 3/4 — Deploying scale-to-zero admin panel..."

  if [[ ! -d "$ADMIN_DIR" ]]; then
    echo "  WARNING: Admin panel directory not found at $ADMIN_DIR — skipping."
  else
    cd "$ADMIN_DIR"

    # Patch costs.json with install-time DBU rate
    python3 -c "
import json
with open('config/costs.json') as f: cfg = json.load(f)
cfg['dbuRate'] = float('${DBU_RATE}')
with open('config/costs.json','w') as f: json.dump(cfg, f, indent=2)
print('  DBU rate set to \$${DBU_RATE}/DBU')
"

    # Patch DATABRICKS_WAREHOUSE_ID env var in app.yaml
    sed -i.bak '/DATABRICKS_WAREHOUSE_ID/{n;s/value: .*/value: '"${WAREHOUSE_ID}"'/;}' app.yaml \
      && rm -f app.yaml.bak

    # Patch SQL query files with install-time catalog/schema
    for f in config/queries/*.sql; do
      sed -e "s|{{telemetry_catalog}}|${CATALOG}|g" \
          -e "s|{{telemetry_schema}}|${SCHEMA}|g" \
          "$f" > "${f}.patched"
      mv "${f}.patched" "$f"
    done

    # Install dependencies and generate query types
    echo "  Installing npm dependencies..."
    npm install --silent 2>&1 | tail -2

    echo "  Generating query types..."
    npm run typegen 2>&1 | tail -3 || echo "  Warning: typegen failed — using committed types, continuing."

    echo "  Building app..."
    npm run build 2>&1 | tail -3

    # bundle deploy: uploads source files, creates/updates the app resource,
    # sets user_api_scopes: sql, and registers the warehouse resource grant.
    echo "  Deploying app bundle (resources + source upload)..."
    _deploy_out=$($CLI bundle deploy --profile "$PROFILE" --var sql_warehouse_id="${WAREHOUSE_ID}" 2>&1)
    _deploy_rc=$?
    echo "$_deploy_out"
    if [[ $_deploy_rc -ne 0 ]]; then
      if echo "$_deploy_out" | grep -q "already exists"; then
        echo "  App already exists outside bundle state — deleting and redeploying..."
        $CLI apps delete scale-to-zero-admin --profile "$PROFILE" --force-stop 2>&1 || true
        $CLI bundle deploy --profile "$PROFILE" --var sql_warehouse_id="${WAREHOUSE_ID}" 2>&1
      else
        echo "  Bundle deploy failed — see output above."
        exit 1
      fi
    fi

    # Restore SQL files (patched copies were uploaded; restore originals for git cleanliness)
    git checkout -- config/queries/ 2>/dev/null || true

    # Derive the bundle upload path and trigger the app deployment
    WS_USER=$($CLI current-user me --output json 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('userName',''))" 2>/dev/null || echo "")
    BUNDLE_PATH="/Workspace/Users/${WS_USER}/.bundle/scale-to-zero-admin/default/files"

    echo "  Starting app deployment from $BUNDLE_PATH..."
    $CLI apps deploy scale-to-zero-admin \
      --source-code-path "$BUNDLE_PATH" 2>&1 | tail -5

    cd "$REPO_ROOT"
  fi
else
  echo ""
  echo "▶ Step 3/4 — Admin panel skipped (--skip-admin)."
fi

# ── Step 4: Summary ───────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Installation complete                                      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Monitoring job  : apps-scale-to-zero (runs every 15 min)"
echo "  Telemetry tables: ${CATALOG}.${SCHEMA}.otel_logs / otel_metrics / otel_traces"
echo "  Config tables   : ${CATALOG}.${SCHEMA}.app_schedule / app_idle_events"
echo ""
echo "  The job will:"
echo "    • Auto-register all apps in app_schedule (IDLE_ONLY default)"
echo "    • Auto-configure telemetry on apps that don't have it"
echo "    • Stop idle apps after ${IDLE_MINUTES} min, force-stop at ${FORCE_STOP_HOUR}:00 UTC"
echo ""
if [[ "$SKIP_ADMIN" == false ]]; then
  ADMIN_URL=$($CLI apps get scale-to-zero-admin --output json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))" 2>/dev/null || echo "")
  [[ -n "$ADMIN_URL" ]] && echo "  Admin panel: $ADMIN_URL" || echo "  Admin panel: check Databricks Apps for the URL"
fi
echo ""
