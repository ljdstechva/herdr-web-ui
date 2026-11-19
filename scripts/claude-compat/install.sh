#!/usr/bin/env bash
# Installs claude-compat.timer for this user: watch.sh every two hours (it acts only when Claude
# Code's version changed). Run from the live checkout:
#
#   ~/apps/herdr-web-ui/scripts/claude-compat/install.sh            install and start the timer
#   ~/apps/herdr-web-ui/scripts/claude-compat/install.sh --remove   stop and remove it
set -euo pipefail
units=$HOME/.config/systemd/user
watch=$HOME/apps/herdr-web-ui/scripts/claude-compat/watch.sh

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now claude-compat.timer 2>/dev/null || true
  rm -f "$units/claude-compat.timer" "$units/claude-compat.service"
  systemctl --user daemon-reload
  echo "removed claude-compat.timer"
  exit 0
fi

mkdir -p "$units"
cat > "$units/claude-compat.service" <<EOF
[Unit]
Description=herdr web UI: check the app against a newly installed Claude Code (scripts/claude-compat/watch.sh)

[Service]
Type=oneshot
ExecStart=$watch
Nice=10
TimeoutStartSec=20min
EOF
cat > "$units/claude-compat.timer" <<EOF
[Unit]
Description=herdr web UI: look for a new Claude Code version every two hours (claude-compat.service)

[Timer]
OnBootSec=15min
OnUnitInactiveSec=2h
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now claude-compat.timer
systemctl --user list-timers claude-compat.timer --no-pager | head -3
