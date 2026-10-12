# Deploying on this VPS

This fork runs on the owner's VPS and is opened from a phone. `~/apps/herdr-web-ui` is the copy
being served: herdr's plugin is linked to it, the server runs from its source and reads `dist/`
from disk on every request.

## The rule

**Never edit `~/apps/herdr-web-ui`, never copy files into its `dist/`, never restart its server
by hand.** The only way a change reaches the phone is:

```sh
~/apps/redeploy-vps.sh <branch>
```

On 2026-10-12 three agents each deployed by copying files into the live checkout. Two of them were
preparing a switch at the same time, one built from a tree four commits behind what was live, and
none could check what the phone would see. The command exists so that cannot happen again.

## Steps

```sh
# 1. a worktree of the live repository, on your own branch, from what is live
git -C ~/apps/herdr-web-ui worktree add ~/apps/wt-<task> -b <task> vps-doctor
cd ~/apps/wt-<task> && bun install --frozen-lockfile

# 2. make the change there, run its tests, commit it on <task>

# 3. deploy the branch (about four minutes; add --no-tests only if you just ran the unit suite)
~/apps/redeploy-vps.sh <task>

# 4. when it says "done": remove the worktree
git -C ~/apps/herdr-web-ui worktree remove ~/apps/wt-<task>
```

`/opt/workstation/15 herdr-web-ui` is **not** a place to build a deploy from: it is an older copy
(behind the live commit, CRLF line endings, owned by root). Changes made there have to be applied
to a worktree as in step 1 before they can go live.

## What the command does

1. Takes a lock: one deploy at a time. A second one is told who holds it and exits.
2. Refuses unless the branch contains the commit that is live (so it cannot undo another agent's
   work) and the live checkout is exactly as committed (so nothing made by hand is lost).
3. In a staging copy, at low priority: `bun install`, `bun run typecheck`, `bun run test:unit`,
   `bun run build`. The live app is not touched.
4. Starts the staged build on port 7319 and opens it in a headless phone-sized browser
   (`~/apps/deploy/phone-smoke.ts`): the page must draw, its bundle must run without an error,
   the API must answer it, and it must open again from its kept shell with the server stopped.
   The terminal socket is refused throughout, so no pane is attached or resized.
5. Only then: stops the live server, moves the checkout to the commit, swaps `dist/`, starts the
   server (a few seconds in all), and runs the same phone check on the live address.
6. If anything in step 5 fails, puts the previous commit and its `dist/` back and starts it.

Every run is logged in `~/apps/deploy/logs/`, and `~/apps/deploy/history.log` has one line per
deploy.

## When it refuses

- **"does not contain what is live"**: someone deployed since you branched. In your worktree:
  `git rebase vps-doctor`, run the tests again, deploy again.
- **"the live checkout was changed by hand"**: someone broke the rule. Look at the listed files.
  If the change is meant to stay, commit it in `~/apps/herdr-web-ui` and rebase onto it; never
  discard another task's work to make your deploy pass.
- **"another deploy is running"**: wait for it, then rebase onto what it made live.
- **A failed check**: the live app was not touched. Fix the branch and deploy again.

## Looking and undoing

```sh
~/apps/redeploy-vps.sh --status     # what is live; says so if anything was changed by hand
~/apps/redeploy-vps.sh --rollback   # the build before the last deploy, in a few seconds
```

## What it cannot check

The phone reaches the app at `https://srv1084037-codex-foundation.tail8629f3.ts.net` through
Tailscale. That address does not work from the VPS itself (no MagicDNS here, and port 443 on this
host is Traefik's), so no check run here can load it. The command checks the server behind it and
that `tailscale serve` still forwards to it. If the phone cannot open the app while `--status` is
clean, the cause is on the phone's side of the tunnel; the service worker opens the app from its
kept shell after three seconds without an answer, so the app itself should still appear and say
"Connecting".
