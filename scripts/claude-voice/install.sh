#!/usr/bin/env bash
# Links the claude voice recorder as ~/.local/bin/arecord, so Claude Code's voice mode hears the
# phone (scripts/claude-voice/arecord, server/claude-voice.ts). Run from the live checkout:
#
#   ~/apps/herdr-web-ui/scripts/claude-voice/install.sh            link it (refuses to replace a real arecord)
#   ~/apps/herdr-web-ui/scripts/claude-voice/install.sh --check    say whether it is in place
#   ~/apps/herdr-web-ui/scripts/claude-voice/install.sh --remove   take the link away again
#
# Claude Code's voice mode itself is turned on in a Claude session with `/voice tap`.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_file=$here/arecord
link=$HOME/.local/bin/arecord
marker="herdr-web-ui claude voice recorder"

ours() { [ -e "$1" ] && grep -q "$marker" "$1" 2>/dev/null; }

case "${1:-}" in
  --check)
    if ours "$link"; then echo "installed: $link -> $(readlink -f "$link")"; else echo "not installed"; exit 1; fi
    found=$(PATH=$HOME/.local/bin:$PATH command -v arecord || true)
    [ "$found" = "$link" ] || echo "note: another arecord comes first on PATH: $found"
    ;;
  --remove)
    if ours "$link"; then rm -f "$link"; echo "removed $link"; else echo "nothing of ours at $link"; fi
    ;;
  "")
    if [ -e "$link" ] && ! ours "$link"; then echo "refused: $link exists and is not the claude voice recorder"; exit 1; fi
    mkdir -p "$(dirname "$link")"
    ln -sfn "$source_file" "$link"
    chmod +x "$source_file"
    echo "linked $link -> $source_file"
    other=$(command -v -a arecord 2>/dev/null | grep -v "^$link$" | head -1 || true)
    [ -z "$other" ] || echo "note: $other is also on PATH; Claude Code uses whichever comes first"
    ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
