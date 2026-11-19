# Keeping the web UI in step with Claude Code

Claude Code updates itself about once a day, and the web UI reads what it draws (prompts, pickers,
plan and question dialogs, its message box) and what it records (session transcripts). A new
version can change any of that. These scripts notice.

| File | What it does |
|---|---|
| `probe.ts` | Opens a throwaway herdr workspace, starts the installed Claude Code on Haiku and checks through the web UI's own API what a phone gets: chat transcript, `/model`, `/effort` and switch-model cards, a question card, the plan card (typed feedback must keep Claude planning), Claude voice. Closes the workspace. |
| `watch.sh` | Run by `claude-compat.timer` every 2 hours. When `claude --version` changed, runs the probe against the live app, writes a report to `/opt/workstation/00 Agents/herdr-web-ui/claude-compat/`, and if a check failed opens a herdr workspace "Claude <version> app check" with Claude Code briefed to adapt the app on a branch. That session asks the owner before deploying or pushing. |
| `install.sh` | Installs or removes the user timer. |

Settings: `~/apps/deploy/claude-compat/env` (`AUTO_FIX=0` keeps the reports and opens no session).
State, probe logs and JSON: `~/apps/deploy/claude-compat/`.

## Running the probe

```sh
cd ~/apps/herdr-web-ui && bun scripts/claude-compat/probe.ts                 # the live app
~/apps/herdr-web-ui/scripts/claude-compat/watch.sh --force                   # a full check with report now
```

Against a work tree's own server (port 7398, Claude voice on, its recorder and socket folder):

```sh
# serve.ts: createServer({ port: 7398, hostname: "127.0.0.1", token: "", stateDir: <dir>, claudeVoiceDir: <vdir> })
HERDR_WEB_UI_VOICE_RECORDER=<worktree>/scripts/claude-voice/arecord bun serve.ts &
bun scripts/claude-compat/probe.ts --url http://127.0.0.1:7398 \
  --pane-env "PATH=<worktree>/scripts/claude-voice:\$PATH HERDR_WEB_UI_VOICE_DIR=<vdir>"
```

`--keep` leaves the workspace open to look at; close it with `herdr workspace close <id>`.
A run costs a few short Haiku turns.
