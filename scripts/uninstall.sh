#!/bin/sh
# Remove every file the SuperAgent plugin created on this machine.
#
# The DSH bundle itself is removed by the Plugin Manager (or `plugin_manager`
# remove_bundle). This script cleans what the bundle manager leaves behind:
# the LaunchAgent, the profile patch configuration row, the linked package
# entry, DSH sessions created under the plugin state directory, and (with
# --purge-state) the state directory itself.
#
# Safety: --purge-state is guarded. The state directory must be recognisable as
# a SuperAgent directory — the plugin writes `<stateDir>/.superagent-state`
# (containing the plugin id) on boot; older installs are recognised by their
# `superagent.sqlite` / `secrets/` layout. A fixed blacklist (HOME, DSH_HOME,
# /Users, /tmp, the checkout root, …) is never deleted, even with --force.
# Without a marker, --force is required; use --dry-run first.
#
#   ./scripts/uninstall.sh                    # remove watchdog row/config/link
#   ./scripts/uninstall.sh --purge-state      # also delete state + sessions + secrets
#   ./scripts/uninstall.sh --purge-state --dry-run   # show what would be deleted
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

LABEL="${SUPERAGENT_WATCHDOG_LABEL:-com.sfky.superagent.watchdog}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
STATE_DIR="${SUPERAGENT_STATE_DIR:-$DSH_HOME/state/superagent}"
PROFILE="${DSH_PROFILE:-desktop}"
PURGE_STATE=0
DRY_RUN=0
FORCE=0
CLEAN_PROFILE=1
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MARKER_FILE=".superagent-state"

usage() {
  cat <<USAGE_EOF
Usage: $0 [options]

  --label <label>          LaunchAgent label (default: $LABEL)
  --state-dir <path>       State directory (default: $STATE_DIR)
  --profile <name>         DSH profile (default: $PROFILE)
  --dsh-home <path>        DSH home (default: $DSH_HOME)
  --keep-profile-config    Do not remove the row from the profile patch
  --purge-state            Delete the state directory, downloads, secrets and
                           SuperAgent sessions too (explicit; irreversible)
  --force                  Allow purging a directory without the
                           .superagent-state marker (never bypasses the
                           blacklist)
  --dry-run                Print the actions without executing them
  -h, --help               Show this help

Run the Plugin Manager's "remove bundle" first (or dsh plugin remove), then run
this script. Always try --purge-state --dry-run before the real purge.
USAGE_EOF
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
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$STATE_DIR" in
  /*) ;;
  *) fail '--state-dir must be an absolute path' ;;
esac

# Drop trailing slashes so "/" and "$HOME/" compare cleanly.
STATE_DIR=$(printf '%s' "$STATE_DIR" | sed 's:/*$::')
[ -n "$STATE_DIR" ] || fail '--state-dir resolves to an empty path'

# Resolve a path to its physical form when its parent exists (best effort).
canonical_path() {
  _path="$1"
  case "$_path" in
    /*) ;;
    *) printf '%s\n' "$_path"; return ;;
  esac
  _parent=$(dirname -- "$_path")
  _base=$(basename -- "$_path")
  if [ -d "$_parent" ]; then
    printf '%s/%s\n' "$(CDPATH= cd -- "$_parent" && pwd -P)" "$_base"
  else
    printf '%s\n' "$_path"
  fi
}

RESOLVED_STATE_DIR=$(canonical_path "$STATE_DIR")
RESOLVED_HOME=$(canonical_path "$HOME")
RESOLVED_DSH_HOME=$(canonical_path "$DSH_HOME")
RESOLVED_ROOT=$(canonical_path "$ROOT_DIR")

is_blacklisted() {
  _candidate="$1"
  for _protected in \
    "/" \
    "$RESOLVED_HOME" \
    "$HOME" \
    "$RESOLVED_DSH_HOME" \
    "$DSH_HOME" \
    "$RESOLVED_DSH_HOME/profiles" \
    "$RESOLVED_DSH_HOME/sessions" \
    "$RESOLVED_ROOT" \
    "$ROOT_DIR" \
    "/Users" \
    "/home" \
    "/tmp" \
    "/var" \
    "/private" \
    "/etc" \
    "/Applications" \
    "/Volumes"
  do
    [ -n "$_protected" ] || continue
    [ "$_candidate" = "$_protected" ] && return 0
  done
  case "$_candidate" in
    "$RESOLVED_DSH_HOME"/profiles/*|"$RESOLVED_DSH_HOME"/sessions/*|"$RESOLVED_HOME"/.dsh/profiles/*|"$RESOLVED_HOME"/.dsh/sessions/*) return 0 ;;
  esac
  return 1
}

has_marker() {
  [ -f "$STATE_DIR/$MARKER_FILE" ] || return 1
  grep -q 'dsh-superagent-personal' "$STATE_DIR/$MARKER_FILE" 2>/dev/null
}

looks_like_legacy_state() {
  [ -f "$STATE_DIR/superagent.sqlite" ] && return 0
  [ -d "$STATE_DIR/secrets" ] && return 0
  [ -d "$STATE_DIR/work" ] && return 0
  [ -f "$STATE_DIR/superagent-status.json" ] && return 0
  [ -f "$STATE_DIR/superagent-heartbeat.json" ] && return 0
  return 1
}

assert_purge_allowed() {
  if is_blacklisted "$STATE_DIR" || is_blacklisted "$RESOLVED_STATE_DIR"; then
    fail "refusing to purge a protected directory: $STATE_DIR (blacklist cannot be overridden by --force)"
  fi
  if has_marker; then
    printf 'uninstall: state marker found in %s\n' "$STATE_DIR"
    return 0
  fi
  if [ "$FORCE" -eq 1 ]; then
    printf 'uninstall: WARNING: no %s marker in %s; --force accepted the purge\n' "$MARKER_FILE" "$STATE_DIR" >&2
    return 0
  fi
  if looks_like_legacy_state; then
    fail "refusing to purge $STATE_DIR: no $MARKER_FILE marker (legacy layout detected; re-run with --force if this is really the SuperAgent state dir)"
  fi
  fail "refusing to purge $STATE_DIR: not recognisable as a SuperAgent state directory (no $MARKER_FILE marker); use --force only after checking the path"
}

print_purge_plan() {
  printf 'uninstall: purge plan (dry run)\n'
  printf '  state directory: %s\n' "$STATE_DIR"
  if [ -d "$STATE_DIR" ]; then
    _size=$(du -sh "$STATE_DIR" 2>/dev/null | awk '{print $1}' || true)
    printf '  size:            %s\n' "${_size:-unknown}"
    printf '  top-level entries:\n'
    find "$STATE_DIR" -mindepth 1 -maxdepth 1 -print 2>/dev/null | sed 's/^/    /' || true
  else
    printf '  state directory does not exist\n'
  fi
  if [ -n "${SESSIONS_DIR:-}" ] && [ -d "$SESSIONS_DIR" ]; then
    printf '  sessions to delete:\n'
    find "$SESSIONS_DIR" -maxdepth 1 -type d -name '*state-superagent*' -print 2>/dev/null | sed 's/^/    /' || true
  fi
  printf '  legacy token dir: %s\n' "$HOME/.config/superagent"
  printf 'uninstall: no files were deleted (dry run)\n'
}

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
  assert_purge_allowed
  SESSIONS_DIR="$DSH_HOME/sessions"

  if [ "$DRY_RUN" -eq 1 ]; then
    print_purge_plan
  else
    printf 'uninstall: deleting state directory %s\n' "$STATE_DIR"
    rm -rf -- "$STATE_DIR"
    if [ -d "$SESSIONS_DIR" ]; then
      printf 'uninstall: deleting SuperAgent sessions under %s\n' "$SESSIONS_DIR"
      find "$SESSIONS_DIR" -maxdepth 1 -type d -name '*state-superagent*' -exec rm -rf -- {} +
    fi
  fi
else
  printf '\nState directory kept at %s (database, tickets, downloads, secrets).\n' "$STATE_DIR"
  printf 'Pass --purge-state (try --dry-run first) to delete it and the SuperAgent sessions.\n'
fi

if grep -q '"dsh-superagent-personal"' "$DSH_HOME/profiles/$PROFILE/package.json" 2>/dev/null; then
  printf '\nThe bundle package is still listed in the profile. Remove it with:\n'
  printf '  dsh plugin --profile %s remove dsh-superagent-personal\n' "$PROFILE"
  printf 'or Settings -> Plugins -> remove, then re-run this script if needed.\n'
else
  printf '\nBundle package is not listed in the profile; cleanup is complete.\n'
fi
