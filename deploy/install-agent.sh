#!/bin/bash
# Fill in a LaunchAgent template from this machine and load it.
#
#   deploy/install-agent.sh com.addisdev.fleet-collector.plist
#   deploy/install-agent.sh com.addisdev.fleet-executor-ios.plist --print
#
# The plists in this directory are templates carrying __PLACEHOLDER__ paths.
# That is not tidiness: launchd does not expand `~`, does not read your login
# PATH, and does not complain about a path that does not exist — an agent with
# someone else's home directory in it fails by quietly doing nothing at all.
# So every path is absolute, and every absolute path is filled in here, on the
# machine that will actually run the thing.
#
# Every value can be overridden from the environment:
#   NODE=/usr/local/bin/node deploy/install-agent.sh com.addisdev.fleet-collector.plist
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE=""
PRINT_ONLY=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *)  TEMPLATE="$arg" ;;
  esac
done

if [ -z "$TEMPLATE" ]; then
  echo "usage: $0 <plist> [--print] [--force]" >&2
  echo >&2
  echo "available templates:" >&2
  (cd "$DEPLOY_DIR" && ls *.plist | sed 's/^/  /') >&2
  exit 2
fi

SRC="$DEPLOY_DIR/${TEMPLATE##*/}"
[ -f "$SRC" ] || { echo "no such template: $SRC" >&2; exit 1; }

# --- the facts about this machine -------------------------------------------
# Resolved absolutely, because a LaunchAgent gets no shell to resolve names.
: "${FLEET_HOME:=$(cd "$DEPLOY_DIR/.." && pwd)}"
: "${NODE:=$(command -v node || true)}"
[ -n "$NODE" ] || { echo "node not found on PATH; set NODE=/abs/path/to/node" >&2; exit 1; }
NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")"
: "${NODE_BIN_DIR:=$(dirname "$NODE")}"

: "${MAESTRO_BIN:=$HOME/.maestro/bin/maestro}"
: "${ANDROID_PLATFORM_TOOLS:=$HOME/Library/Android/sdk/platform-tools}"
: "${ADB_BIN:=$ANDROID_PLATFORM_TOOLS/adb}"
: "${JAVA_HOME:=$(/usr/libexec/java_home 2>/dev/null || echo "$HOME/.local/jdk/Contents/Home")}"
: "${IOS_PROJECT:=$(cd "$FLEET_HOME/.." 2>/dev/null && pwd)/fleet-runner-ios/FleetRunner.xcodeproj}"

# tsx is how the agent runs TypeScript without a build step. If it is missing,
# the agent would respawn every ten seconds forever, so say so now.
if [ ! -f "$FLEET_HOME/node_modules/tsx/dist/cli.mjs" ]; then
  echo "warning: $FLEET_HOME/node_modules/tsx not found — run 'npm install' first" >&2
fi

FILLED="$(sed \
  -e "s|__FLEET_HOME__|$FLEET_HOME|g" \
  -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
  -e "s|__NODE__|$NODE|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__MAESTRO_BIN__|$MAESTRO_BIN|g" \
  -e "s|__ANDROID_PLATFORM_TOOLS__|$ANDROID_PLATFORM_TOOLS|g" \
  -e "s|__ADB_BIN__|$ADB_BIN|g" \
  -e "s|__JAVA_HOME__|$JAVA_HOME|g" \
  -e "s|__IOS_PROJECT__|$IOS_PROJECT|g" \
  "$SRC")"

# A placeholder that survived means a path this script does not know about.
# Installing it would produce an agent that fails silently, which is the exact
# failure mode the templates exist to prevent.
if LEFT="$(printf '%s' "$FILLED" | grep -o '__[A-Z_]\{2,\}__' | sort -u)" && [ -n "$LEFT" ]; then
  echo "unsubstituted placeholders remain:" >&2
  printf '  %s\n' $LEFT >&2
  echo "set them in the environment and re-run" >&2
  exit 1
fi

if [ "$PRINT_ONLY" = 1 ]; then
  printf '%s\n' "$FILLED"
  exit 0
fi

LABEL="$(printf '%s' "$FILLED" | awk '/<key>Label<\/key>/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}')"
[ -n "$LABEL" ] || { echo "could not read Label from $SRC" >&2; exit 1; }

DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && [ "$FORCE" != 1 ]; then
  echo "$LABEL is already loaded. Re-run with --force to replace it, or stop it first:" >&2
  echo "  launchctl bootout gui/\$(id -u)/$LABEL" >&2
  exit 1
fi

printf '%s\n' "$FILLED" > "$DEST"
plutil -lint "$DEST" >/dev/null || { echo "generated plist is malformed: $DEST" >&2; exit 1; }

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$DEST" || { echo "bootstrap failed for $LABEL" >&2; exit 1; }

echo "installed and loaded: $LABEL"
echo "  plist   $DEST"
echo "  node    $NODE"
echo "  cwd     $FLEET_HOME"
echo
echo "stop it with:  launchctl bootout gui/\$(id -u)/$LABEL"
