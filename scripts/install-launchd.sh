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
  --node <path>       Node executable (default: node on PATH, then the DSH-bundled Node)
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

if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE_BIN" ]; then
  BUNDLED_NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
  if [ -x "$BUNDLED_NODE" ]; then
    NODE_BIN="$BUNDLED_NODE"
  fi
fi
[ -n "$NODE_BIN" ] || fail 'node not found; install Node 22.19+/24+ or pass --node <path>'
NODE_DIR=$(CDPATH= cd -- "$(dirname -- "$NODE_BIN")" && pwd)
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
  printf 'install-launchd: dry run, plist would be written to %s\n\n' "$PLIST" >&2
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

cat <<EOF
install-launchd: installed $LABEL
  plist:      $PLIST
  watchdog:   $SCRIPT_DIR/watchdog.mjs
  node:       $NODE_BIN
  state dir:  $STATE_DIR
  log:        $STATE_DIR/watchdog.log

Verify:
  launchctl print gui/$UID/$LABEL | head -20
  tail -n 20 "$STATE_DIR/watchdog.log"
  node "$SCRIPT_DIR/watchdog.mjs" --state-dir "$STATE_DIR" --dry-run

The agent runs at login and every 60 seconds. Uninstall with scripts/uninstall.sh.
EOF
