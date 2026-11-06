#!/bin/sh
# Install (or reinstall) the Superagent watchdog as a per-user macOS LaunchAgent.
#
#   ./scripts/install-launchd.sh --state-dir "$HOME/.dsh/state/superagent"
#   ./scripts/install-launchd.sh --state-dir ... --dry-run
#
# The agent runs the watchdog at login and every 60 seconds. It never touches
# the DSH profile, the bundle, or secrets: the watchdog only reads the state
# directory and, when needed, opens DeepSeek Harness.
set -eu

LABEL="${SUPERAGENT_WATCHDOG_LABEL:-com.sfky.superagent.watchdog}"
STATE_DIR="${SUPERAGENT_STATE_DIR:-$HOME/.dsh/state/superagent}"
NODE_BIN="${SUPERAGENT_NODE:-}"
DRY_RUN=0

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEMPLATE="$SCRIPT_DIR/com.sfky.superagent.watchdog.plist"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

usage() {
  cat <<EOF
Usage: $0 [options]

  --state-dir <path>  Superagent state directory (default: \$SUPERAGENT_STATE_DIR or
                      \$HOME/.dsh/state/superagent). Must be absolute.
  --label <label>     LaunchAgent label (default: $LABEL)
  --node <path>       Absolute Node executable (default: the running Node's
                      process.execPath, then the DSH-bundled Node)
  --dry-run           Render the plist to stdout; do not write or load it
  -h, --help          Show this help

The watchdog itself takes --dry-run; this script only installs it.
EOF
}

fail() {
  printf 'install-launchd: %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir)
      [ $# -ge 2 ] || fail 'missing value for --state-dir'
      STATE_DIR="$2"
      shift 2
      ;;
    --label)
      [ $# -ge 2 ] || fail 'missing value for --label'
      LABEL="$2"
      shift 2
      ;;
    --node)
      [ $# -ge 2 ] || fail 'missing value for --node'
      NODE_BIN="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

case "$STATE_DIR" in
  /*) ;;
  *) fail "--state-dir must be an absolute path" ;;
esac

[ -f "$TEMPLATE" ] || fail "missing plist template: $TEMPLATE"
[ -f "$SCRIPT_DIR/watchdog.mjs" ] || fail "missing watchdog: $SCRIPT_DIR/watchdog.mjs"

# Resolve Node to an absolute path captured at install time: launchd does not
# read the user's shell profile, so a `command -v node` nvm/volta shim would
# stop working after the next Node upgrade or logout.
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(node -p 'process.execPath' 2>/dev/null || true)
fi
if [ -z "$NODE_BIN" ]; then
  BUNDLED_NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
  if [ -x "$BUNDLED_NODE" ]; then
    NODE_BIN="$BUNDLED_NODE"
  fi
fi
[ -n "$NODE_BIN" ] || fail 'node not found; pass --node <absolute path to node 22.19+/24+>'
case "$NODE_BIN" in
  /*) ;;
  *) fail "--node must be an absolute path: $NODE_BIN" ;;
esac
[ -x "$NODE_BIN" ] || fail "node is not executable: $NODE_BIN"
NODE_BIN=$(CDPATH= cd -- "$(dirname -- "$NODE_BIN")" && pwd -P)/$(basename -- "$NODE_BIN")
NODE_VERSION=$("$NODE_BIN" -v 2>/dev/null || true)
case "$NODE_VERSION" in
  v22.*|v23.*|v24.*|v25.*|v26.*|v27.*) ;;
  *) printf 'install-launchd: warning: %s is %s; Node 22.19+/24+ is required by the plugin\n' "$NODE_BIN" "${NODE_VERSION:-unknown}" >&2 ;;
esac
if printf '%s' "$NODE_BIN" | grep -q '/\.nvm/'; then
  printf 'install-launchd: warning: %s points into nvm; upgrades/removal will break the LaunchAgent. Pass --node with a stable path (e.g. the DSH bundled node).\n' "$NODE_BIN" >&2
fi
NODE_DIR=$(CDPATH= cd -- "$(dirname -- "$NODE_BIN")" && pwd -P)
PATH_VALUE="$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

render() {
  sed \
    -e "s|__LABEL__|$LABEL|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__WATCHDOG__|$SCRIPT_DIR/watchdog.mjs|g" \
    -e "s|__STATE_DIR__|$STATE_DIR|g" \
    -e "s|__PATH__|$PATH_VALUE|g" \
    "$TEMPLATE"
}

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'install-launchd: dry run, plist would be written to %s\n' "$PLIST" >&2
  printf 'install-launchd: node=%s; self-check would run: %s/watchdog.mjs --state-dir %s --dry-run\n\n' "$NODE_BIN" "$SCRIPT_DIR" "$STATE_DIR" >&2
  render
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
render > "$PLIST"
chmod 644 "$PLIST"

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$PLIST" >/dev/null || fail "rendered plist is invalid: $PLIST"
fi

# Remove an older copy first; failures mean it was not loaded yet.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL" 2>/dev/null || true
# Run one check immediately so a broken setup is visible now.
launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true

# Post-install self-check: the same dry run a person would run by hand. It
# proves the chosen node path and the watchdog script are usable before the
# first real LaunchAgent interval. A failure rolls the install back.
SELF_CHECK_CODE=0
SELF_CHECK_OUTPUT=$("$NODE_BIN" "$SCRIPT_DIR/watchdog.mjs" --state-dir "$STATE_DIR" --dry-run --json 2>&1) || SELF_CHECK_CODE=$?
if [ "$SELF_CHECK_CODE" -ne 0 ]; then
  printf 'install-launchd: self-check failed (node=%s, exit=%s):\n%s\n' "$NODE_BIN" "$SELF_CHECK_CODE" "$SELF_CHECK_OUTPUT" >&2
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  fail 'watchdog self-check failed; LaunchAgent was removed'
fi
STATUS_FILE="$STATE_DIR/watchdog-status.json"
"$NODE_BIN" -e 'const fs=require("fs");const p=process.argv[1];let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};s.installed=true;s.loaded=true;s.label=process.argv[2];s.plistPath=process.argv[3];s.installedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n");' "$STATUS_FILE" "$LABEL" "$PLIST" 2>/dev/null || true

cat <<EOF
install-launchd: installed $LABEL
  plist:      $PLIST
  watchdog:   $SCRIPT_DIR/watchdog.mjs
  node:       $NODE_BIN (${NODE_VERSION:-unknown})
  state dir:  $STATE_DIR
  log:        $STATE_DIR/watchdog.log (rotates at 2 MiB, keeps .1)
  status:     $STATUS_FILE
  self-check: passed

Verify:
  launchctl print gui/$UID/$LABEL | head -20
  tail -n 20 "$STATE_DIR/watchdog.log"
  node "$SCRIPT_DIR/watchdog.mjs" --state-dir "$STATE_DIR" --dry-run

The agent runs at login and every 60 seconds. Uninstall with scripts/uninstall.sh.
EOF
