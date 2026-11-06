#!/bin/sh
# Remove every file the SuperAgent plugin created on this machine.
#
# The DSH bundle itself is removed by the Plugin Manager (or `plugin_manager`
# remove_bundle). This script cleans what the bundle manager leaves behind:
# the LaunchAgent, the profile patch configuration row, the linked package
# entry, DSH sessions created under the plugin state directory, and (with
# --purge-state) the state directory itself.
#
#   ./scripts/uninstall.sh                    # remove watchdog row/config/link
#   ./scripts/uninstall.sh --purge-state      # also delete state + sessions + secrets
#   ./scripts/uninstall.sh --dry-run
set -eu

LABEL="${SUPERAGENT_WATCHDOG_LABEL:-com.sfky.superagent.watchdog}"
STATE_DIR="${SUPERAGENT_STATE_DIR:-$HOME/.dsh/state/superagent}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PURGE_STATE=0
DRY_RUN=0
CLEAN_PROFILE=1
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

usage() {
  cat <<EOF
Usage: $0 [options]

  --label <label>          LaunchAgent label (default: $LABEL)
  --state-dir <path>       State directory (default: $STATE_DIR)
  --profile <name>         DSH profile (default: $PROFILE)
  --dsh-home <path>        DSH home (default: $DSH_HOME)
  --keep-profile-config    Do not remove the row from the profile patch
  --purge-state            Delete the state directory, downloads, secrets and
                           SuperAgent sessions too (explicit; irreversible)
  --dry-run                Print the actions without executing them
  -h, --help               Show this help

Run the Plugin Manager's "remove bundle" first (or dsh plugin remove), then run
this script. With --purge-state no file created by the plugin remains.
EOF
}

fail() {
  printf 'uninstall: %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --label) [ $# -ge 2 ] || fail 'missing value for --label'; LABEL="$2"; shift 2 ;;
    --state-dir) [ $# -ge 2 ] || fail 'missing value for --state-dir'; STATE_DIR="$2"; shift 2 ;;
    --profile) [ $# -ge 2 ] || fail 'missing value for --profile'; PROFILE="$2"; shift 2 ;;
    --dsh-home) [ $# -ge 2 ] || fail 'missing value for --dsh-home'; DSH_HOME="$2"; shift 2 ;;
    --keep-profile-config) CLEAN_PROFILE=0; shift ;;
    --purge-state) PURGE_STATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$STATE_DIR" in
  /*) ;;
  *) fail '--state-dir must be an absolute path' ;;
esac

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'uninstall: would run: %s\n' "$*"
  else
    "$@"
  fi
}

# 1. LaunchAgent (watchdog)
if [ -f "$PLIST" ]; then
  run launchctl bootout "gui/$UID/$LABEL" || true
  run rm -f "$PLIST"
  printf 'uninstall: removed LaunchAgent %s\n' "$LABEL"
else
  printf 'uninstall: LaunchAgent %s is not installed\n' "$LABEL"
fi

# 2. Profile configuration row and linked package entry
if [ "$CLEAN_PROFILE" -eq 1 ] && [ -f "$DSH_HOME/profiles/$PROFILE/cordis.patch.yml" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    run node "$SCRIPT_DIR/cleanup-profile.mjs" --dsh-home "$DSH_HOME" --profile "$PROFILE" --dry-run
  else
    run node "$SCRIPT_DIR/cleanup-profile.mjs" --dsh-home "$DSH_HOME" --profile "$PROFILE"
  fi
fi
LINK="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-superagent-personal"
if [ -L "$LINK" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'uninstall: would remove linked package entry %s\n' "$LINK"
  else
    rm -f "$LINK"
    printf 'uninstall: removed linked package entry %s\n' "$LINK"
  fi
fi

# 3. Legacy token location (pre-stateDir installs)
if [ -d "$HOME/.config/superagent" ]; then
  run rm -rf "$HOME/.config/superagent"
  printf 'uninstall: removed legacy %s\n' "$HOME/.config/superagent"
fi

# 4. Optionally purge state, downloads, secrets and plugin sessions
if [ "$PURGE_STATE" -eq 1 ]; then
  printf 'uninstall: deleting state directory %s\n' "$STATE_DIR"
  run rm -rf -- "$STATE_DIR"

  SESSIONS="$HOME/.dsh/sessions"
  if [ -d "$SESSIONS" ]; then
    printf 'uninstall: deleting SuperAgent sessions under %s\n' "$SESSIONS"
    if [ "$DRY_RUN" -eq 1 ]; then
      find "$SESSIONS" -maxdepth 1 -type d -name '*state-superagent*' -print | while IFS= read -r dir; do
        printf 'uninstall: would run: rm -rf -- %s\n' "$dir"
      done
    else
      find "$SESSIONS" -maxdepth 1 -type d -name '*state-superagent*' -exec rm -rf -- {} +
    fi
  fi
else
  printf '\nState directory kept at %s (database, tickets, downloads, secrets).\n' "$STATE_DIR"
  printf 'Pass --purge-state to delete it and the SuperAgent sessions too.\n'
fi

if grep -q '"dsh-superagent-personal"' "$DSH_HOME/profiles/$PROFILE/package.json" 2>/dev/null; then
  printf '\nThe bundle package is still listed in the profile. Remove it with:\n'
  printf '  dsh plugin --profile %s remove dsh-superagent-personal\n' "$PROFILE"
  printf 'or Settings -> Plugins -> remove, then re-run this script if needed.\n'
else
  printf '\nBundle package is not listed in the profile; cleanup is complete.\n'
fi
