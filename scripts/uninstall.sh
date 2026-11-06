#!/bin/sh
# Remove the Superagent watchdog LaunchAgent and (optionally) the state
# directory. The bundle itself is removed from the DSH profile by its plugin
# manager; this script prints the command but never edits the profile.
#
#   ./scripts/uninstall.sh                       # remove the LaunchAgent only
#   ./scripts/uninstall.sh --purge-state         # also delete the state dir (asks nothing: explicit)
#
# State is never removed unless --purge-state is passed: it holds the database,
# the ticket history and the worker directories.
set -eu

LABEL="${SUPERAGENT_WATCHDOG_LABEL:-com.sfky.superagent.watchdog}"
STATE_DIR="${SUPERAGENT_STATE_DIR:-$HOME/.dsh/state/superagent}"
PURGE_STATE=0
DRY_RUN=0
PROFILE="${DSH_PROFILE:-superagent}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

usage() {
  cat <<EOF
Usage: $0 [options]

  --label <label>    LaunchAgent label (default: $LABEL)
  --state-dir <path> State directory printed/removed (default: $STATE_DIR)
  --profile <name>   DSH profile named in the removal hint (default: $PROFILE)
  --purge-state      Delete the state directory too (explicit; irreversible)
  --dry-run          Print the actions without executing them
  -h, --help         Show this help
EOF
}

fail() {
  printf 'uninstall: %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --label)
      [ $# -ge 2 ] || fail 'missing value for --label'
      LABEL="$2"
      shift 2
      ;;
    --state-dir)
      [ $# -ge 2 ] || fail 'missing value for --state-dir'
      STATE_DIR="$2"
      shift 2
      ;;
    --profile)
      [ $# -ge 2 ] || fail 'missing value for --profile'
      PROFILE="$2"
      shift 2
      ;;
    --purge-state)
      PURGE_STATE=1
      shift
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

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'uninstall: would run: %s\n' "$*"
  else
    "$@"
  fi
}

if [ -f "$PLIST" ]; then
  run launchctl bootout "gui/$UID/$LABEL" || true
  run rm -f "$PLIST"
  printf 'uninstall: removed LaunchAgent %s\n' "$LABEL"
else
  printf 'uninstall: LaunchAgent %s is not installed\n' "$LABEL"
fi

printf '\nThe bundle itself is still installed in the profile. Remove it with:\n'
printf '  dsh plugin --profile %s remove dsh-superagent-personal\n' "$PROFILE"
printf 'or through the Plugin Manager. Do not edit the profile patch by hand.\n'

if [ "$PURGE_STATE" -eq 1 ]; then
  case "$STATE_DIR" in
    /*) ;;
    *) fail '--purge-state needs an absolute --state-dir' ;;
  esac
  printf '\nuninstall: deleting state directory %s\n' "$STATE_DIR"
  run rm -rf -- "$STATE_DIR"
else
  printf '\nState directory kept at %s (database, tickets, worker directories).\n' "$STATE_DIR"
  printf 'Pass --purge-state to delete it explicitly.\n'
fi
