#!/bin/bash
# Adopt a spare Mac as the fleet's always-on collector host.
#
#   ./adopt-fleet-host.sh user@spare-mac.local [alias]
#
# Assumes key auth already works (run `ssh-copy-id -i ~/.ssh/id_ed25519.pub
# user@host` once from your own terminal first — it needs a password, which
# only you can type). This script never prompts: it verifies, gathers the
# facts that decide whether the machine can host the collector, and adds an
# ~/.ssh/config entry matching the existing convention.
set -uo pipefail

TARGET="${1:-}"
ALIAS="${2:-fleet-host}"
[ -z "$TARGET" ] && { echo "usage: $0 user@host [alias]"; exit 2; }
HOST="${TARGET#*@}"
USER_NAME="${TARGET%@*}"

echo "== verifying key auth to $TARGET"
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$TARGET" true 2>/dev/null; then
  echo "FAILED: key auth not working."
  echo "Run this once in your own terminal (it will ask for the Mac's password):"
  echo "  ssh-copy-id -i ~/.ssh/id_ed25519.pub $TARGET"
  exit 1
fi
echo "   ok"

echo
echo "== machine facts (deciding fitness as a 24/7 collector host)"
ssh -o BatchMode=yes "$TARGET" 'bash -s' <<'REMOTE'
model=$(sysctl -n hw.model 2>/dev/null)
cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
cores=$(sysctl -n hw.ncpu 2>/dev/null)
ram=$(( $(sysctl -n hw.memsize) / 1073741824 ))
os=$(sw_vers -productVersion)
build=$(sw_vers -buildVersion)
arch=$(uname -m)
disk=$(df -h / | awk 'NR==2 {print $4" free of "$2}')
echo "model:      $model ($arch)"
echo "cpu:        $cpu (${cores} logical cores)"
echo "ram:        ${ram} GB"
echo "macos:      $os ($build)"
echo "disk:       $disk"
# Battery: the thing that decides whether this can live plugged in, lid shut.
batt=$(system_profiler SPPowerDataType 2>/dev/null)
echo "battery:    $(echo "$batt" | awk -F': ' '/Condition/ {print $2; exit}')  cycles=$(echo "$batt" | awk -F': ' '/Cycle Count/ {print $2; exit}')  maxcap=$(echo "$batt" | awk -F': ' '/Maximum Capacity|Full Charge Capacity/ {print $2; exit}')"
echo "power:      $(pmset -g | awk '/sleep/ {printf "%s=%s ", $1, $2}')"
echo "node:       $(command -v node >/dev/null && node --version || echo 'NOT INSTALLED')"
echo "brew:       $(command -v brew >/dev/null && brew --version | head -1 || echo 'NOT INSTALLED')"
echo "xcode-clt:  $(xcode-select -p 2>/dev/null || echo 'NOT INSTALLED')"
echo "tailscale:  $([ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo installed || echo 'NOT INSTALLED')"
echo "lan-ip:     $(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo unknown)"
echo "hostname:   $(scutil --get LocalHostName 2>/dev/null)"
REMOTE

echo
if grep -q "^Host .*\b${ALIAS}\b" ~/.ssh/config 2>/dev/null; then
  echo "== ~/.ssh/config already has a '$ALIAS' entry; leaving it alone"
else
  echo "== adding '$ALIAS' to ~/.ssh/config"
  cp ~/.ssh/config ~/.ssh/config.bak-$(date +%Y%m%d-%H%M%S) 2>/dev/null
  cat >> ~/.ssh/config <<CONF

# The fleet's always-on collector host. Lives on the same subnet as the
# phones, so the devices can reach the collector directly and mDNS resolves
# without help.
Host ${ALIAS} ${HOST%.local}
    HostName ${HOST}
    User ${USER_NAME}
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
    ServerAliveCountMax 4
CONF
  echo "   done (backup written)"
fi
echo
echo "== ready: ssh ${ALIAS}"
