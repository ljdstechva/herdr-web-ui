#!/usr/bin/env bash
# Keeps the web UI in step with Claude Code: run by claude-compat.timer (install.sh), every two hours.
#
#   watch.sh            check once a new Claude Code version is installed (does nothing otherwise)
#   watch.sh --force    check now, whatever the version
#
# When `claude --version` differs from the last version checked, it runs probe.ts against the live
# web UI, keeps the probe's JSON and log in ~/apps/deploy/claude-compat/ and writes a report to
# "/opt/workstation/00 Agents/herdr-web-ui/claude-compat/" (what failed, and the new versions'
# changelog lines that may touch the app). When a check failed, it opens a herdr workspace
# "Claude <version> app check" with Claude Code started on a brief to adapt the app on a branch,
# with tests; that session deploys and pushes only after the owner says so. AUTO_FIX=0 in
# ~/apps/deploy/claude-compat/env turns that off (report only).
set -u
export PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
LIVE=$HOME/apps/herdr-web-ui
DEPLOY=$HOME/apps/deploy
STATE=$DEPLOY/claude-compat
REPORTS="/opt/workstation/00 Agents/herdr-web-ui/claude-compat"
CHANGELOG_URL=https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
AUTO_FIX=1
mkdir -p "$STATE"
# shellcheck disable=SC1091
[ -f "$STATE/env" ] && . "$STATE/env"

version=$(claude --version 2>/dev/null | awk '{print $1}')
[ -n "$version" ] || { echo "claude --version gave nothing"; exit 0; }
last=$(cat "$STATE/last-version" 2>/dev/null || true)
if [ "$version" = "$last" ] && [ "${1:-}" != "--force" ]; then exit 0; fi

# one check at a time, never while a deploy restarts the app, never when memory is short
exec 8>"$STATE/lock"
flock -n 8 || { echo "another check is running"; exit 0; }
if ! flock -n "$DEPLOY/lock" true 2>/dev/null; then echo "a deploy is running: next time"; exit 0; fi
avail_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
if [ "$avail_mb" -lt 1200 ]; then echo "only ${avail_mb} MB free: next time"; exit 0; fi
health=$(curl -fsS -m 5 http://127.0.0.1:7317/api/health 2>/dev/null) || { echo "the web UI does not answer: next time"; exit 0; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
json=$STATE/$stamp-$version.json
log=$STATE/$stamp-$version.log
echo "checking Claude Code $version (last checked: ${last:-none})"
(cd "$LIVE" && timeout 900 nice -n 5 bun scripts/claude-compat/probe.ts --json "$json") > "$log" 2>&1
code=$?
echo "$version" > "$STATE/last-version"
revision=$(printf '%s' "$health" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("web_ui") or {}).get("revision") or "?")' 2>/dev/null)

# the new versions' changelog entries that may touch what the app reads (prompts, transcripts, voice…)
notes=$STATE/$stamp-$version-changelog.txt
if curl -fsSL -m 30 "$CHANGELOG_URL" -o "$STATE/CHANGELOG.md.new" 2>/dev/null; then
  mv "$STATE/CHANGELOG.md.new" "$STATE/CHANGELOG.md"
  python3 - "$STATE/CHANGELOG.md" "${last:-}" "$version" > "$notes" <<'PY'
import re, sys
text, last, new = open(sys.argv[1], encoding="utf-8").read(), sys.argv[2], sys.argv[3]
sections = re.split(r"^## ", text, flags=re.M)[1:]
words = re.compile(r"prompt|dialog|hint|picker|menu|/model|/effort|permission|approv|plan mode|question|transcript|jsonl|session|subagent|background|task|queue|paste|status|spinner|hook|voice|dictat|input box|message box|footer|keybind", re.I)
for section in sections:
    head, _, body = section.partition("\n")
    name = head.strip()
    if last and name == last:
        break
    hits = [line for line in body.splitlines() if line.startswith("- ") and words.search(line) and not line.startswith("- [VSCode]")]
    if hits:
        print(f"## {name}")
        print("\n".join(hits))
        print()
    if not last:
        break  # the first check reads the newest version's entries only
PY
fi

mkdir -p "$REPORTS"
report="$REPORTS/$stamp Claude $version.md"
{
  echo "# Claude Code $version: web UI check"
  echo
  echo "- When: $stamp (UTC)"
  echo "- Previous version checked: ${last:-none}"
  echo "- Web UI build checked: $revision"
  echo "- Result: $([ $code -eq 0 ] && echo 'all checks passed' || echo "FAILED (exit $code)")"
  echo
  echo '```'
  grep -E '^(PASS|FAIL|SKIP)|checks? (passed|failed)|^Claude Code' "$log" || tail -20 "$log"
  echo '```'
  echo
  echo "Full log: \`$log\`"
  if [ -s "$notes" ]; then echo; echo "## Changelog entries that may touch the app"; echo; cat "$notes"; fi
} > "$report"
echo "report: $report"

if [ $code -ne 0 ] && [ "$AUTO_FIX" = 1 ]; then
  brief=$STATE/$stamp-brief.md
  cat > "$brief" <<EOF
Claude Code updated itself to $version (last checked: ${last:-none}) and the herdr web UI's compatibility check failed.

Report: $report
Probe log: $log
Changelog entries that may matter: $notes

Your job: adapt the web UI (~/apps/herdr-web-ui, the owner's fork, branch vps-doctor) to Claude Code $version.
1. Read ~/apps/deploy/DEPLOY.md and server/AGENTS.md. Never edit ~/apps/herdr-web-ui itself: make a worktree from vps-doctor.
2. Reproduce each FAIL with scripts/claude-compat/probe.ts (README beside it: how to point it at a worktree test server with --pane-env). Capture the real screens in a throwaway workspace and use them as test fixtures.
3. Fix the readers (mostly server/prompt.ts, server/conversation.ts, server/claude-voice.ts), add tests, run the affected test files and bun run typecheck, then the probe against your worktree server until every check passes.
4. Commit on your branch. Then STOP and ask the owner in this chat before running ~/apps/redeploy-vps.sh <branch> and before pushing to the fork (git push fork <branch>:vps-doctor). Do not deploy or push without that yes.
Keep it to what the update broke. Report what changed, how it was checked, and what is left.
EOF
  created=$(herdr workspace create --cwd "$HOME/apps" --label "Claude $version app check" --no-focus 2>/dev/null) || { echo "could not open a workspace"; exit 1; }
  pane=$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
  herdr pane run "$pane" "claude \"\$(cat '$brief')\"" >/dev/null
  echo "opened a fix session in pane $pane (brief: $brief)"
  echo "- A Claude Code session was opened to adapt the app: herdr workspace \"Claude $version app check\" (brief: \`$brief\`)." >> "$report"
fi
exit 0
