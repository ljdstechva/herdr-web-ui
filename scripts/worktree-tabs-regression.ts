/**
 * Owned, real-browser regression of a worktree as a tab, on a real herdr and a real git
 * repository at a phone's size: what the demo's fixtures cannot show. New tab makes the checkout
 * under the server's worktree directory and opens it as a tab of the repository's workspace; the
 * tab is known as a worktree from where its pane is (herdr's own listing, real paths); its menu
 * merges the branch, an uncommitted file included, into the main checkout and takes the worktree
 * away; and closing a worktree tab deletes its checkout only when asked. Run after `bun run build`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { HerdrError, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-worktree-tabs-regression-")));
const repo = join(root, "project");
const trees = join(root, "trees");
// Only the workspace this invocation made is ever closed.
const ownedWorkspaces: string[] = [];
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createServer> | undefined;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
const tabNames = (page: Page) => page.locator(".tab-strip .tab-strip-label").allTextContents();
const tabCount = (page: Page, count: number) => page.waitForFunction((want) => document.querySelectorAll(".tab-strip .tab-strip-label").length === want, count);
const facts = (page: Page) => page.locator(".worktree-facts > div").evaluateAll((rows) => rows.map((row) => `${row.querySelector("dt")?.textContent}=${row.querySelector("dd")?.textContent}`));

/** New tab as a worktree, from the strip's +; answers the branch the dialog suggested. */
async function newWorktreeTab(page: Page): Promise<string> {
  await page.locator(".tab-strip-add").click();
  const dialog = page.locator(".new-session-modal");
  await dialog.waitFor();
  const toggle = dialog.getByRole("switch", { name: "New worktree" });
  if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
  const branch = await dialog.getByLabel("Branch").inputValue();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  // the tab is a worktree once herdr's listing has the checkout its pane is in
  await page.locator(".tab-strip-item.is-active .tab-strip-branch").waitFor();
  return branch;
}

async function openTabMenu(page: Page, item: string): Promise<void> {
  await page.locator(".tab-strip-item.is-active .tab-strip-menu").click();
  await page.locator(".row-sheet").waitFor();
  await page.locator(".row-sheet").getByRole("button", { name: item }).click();
}

try {
  // test-herdr has live/unit escape hatches and a no-binary fallback. Never let
  // any of those silently target the user's current socket.
  assert.notEqual(process.env.HERDR_TEST_LIVE, "1", "Live-session mode is forbidden");
  assert.notEqual(process.env.HERDR_TEST_MODE, "unit", "This regression requires isolated herdr");
  process.env.HERDR_TEST_SESSION ||= "herdr-web-ui-test";
  const { testSocketPath } = await import("./test-herdr.ts");
  assert.equal(process.env.HERDR_SOCKET, testSocketPath(), "test-herdr must select its isolated socket");

  // a repository with one commit, whose commits and merges are made as the repository says
  mkdirSync(repo, { recursive: true });
  assert.equal(Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]).exitCode, 0);
  git(repo, "config", "user.name", "herdr-web-ui test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "worktree tabs fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const created = await workspaceCreate({ cwd: repo, label: "worktree-tabs-project" });
  ownedWorkspaces.push(created.workspace.workspace_id);

  server = createServer({
    port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null,
    stateDir: join(root, "state"), codexHome: join(root, "codex"),
    usage: new UsageService(undefined, []),
    // the checkouts the app makes land in this run's folder, never in the user's worktree directory
    worktreeDirectory: trees,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/opt/google/chrome/chrome"),
    headless: true, args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  await context.addInitScript(() => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertsOn: false }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  const evidence = process.env.UI_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const screenshot = async (name: string): Promise<void> => {
    if (evidence) await page.screenshot({ path: join(evidence, `worktree-tabs-${name}.png`), animations: "disabled" });
  };

  await page.goto(`${origin}/?pane=${encodeURIComponent(created.root_pane.pane_id)}`);
  await page.locator(".tab-strip-add").waitFor();
  const before = await tabNames(page);
  assert.equal(before.length, 1, "the workspace starts with its one tab");
  assert.equal(await page.locator(".tab-strip-branch").count(), 0, "a tab in the main checkout is a plain tab");

  // New tab, as a worktree: a real checkout on its own branch, opened as a tab of this workspace
  await page.locator(".tab-strip-add").click();
  const dialog = page.locator(".new-session-modal");
  await dialog.waitFor();
  const toggle = dialog.getByRole("switch", { name: "New worktree" });
  assert.equal(await toggle.getAttribute("aria-checked"), "false", "a tab is plain unless asked otherwise");
  await toggle.click();
  const branch = await dialog.getByLabel("Branch").inputValue();
  assert.match(branch, /^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  await screenshot("new-tab");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const active = page.locator(".tab-strip-item.is-active");
  await active.locator(".tab-strip-branch").waitFor();
  const tabName = branch.slice("worktree/".length);
  assert.deepEqual(await tabNames(page), [...before, tabName], "the worktree is a tab of the repository's workspace, named after its branch");
  assert.equal(await page.locator(".tab-strip-branch").count(), 1, "only the worktree tab wears the branch glyph");
  // herdr's own layout: <worktree directory>/<repository>/<branch as a folder>
  const checkout = join(trees, basename(repo), branch.replaceAll("/", "-"));
  assert.equal(existsSync(join(checkout, "README.md")), true, `the checkout is at ${checkout}`);
  assert.equal(git(checkout, "symbolic-ref", "--short", "HEAD"), branch);
  await screenshot("worktree-tab");
  console.log("PASS New tab makes a real checkout on its own branch and opens it as a tab known to be a worktree");

  // an agent's work: a commit, and a file it left uncommitted
  writeFileSync(join(checkout, "feature.txt"), "feature\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "feature");
  writeFileSync(join(checkout, "draft.txt"), "draft\n");

  await openTabMenu(page, "Merge worktree…");
  const modal = page.locator(".worktree-modal");
  await modal.locator(".worktree-facts").waitFor();
  assert.equal(await modal.locator(".modal-title").textContent(), `Merge ${branch}`);
  assert.deepEqual(await facts(page), ["Commits to merge=1", "Uncommitted files=1"]);
  assert.deepEqual(await modal.locator(".worktree-files li").allTextContents(), ["draft.txt"]);
  assert.equal(await modal.getByRole("checkbox", { name: "Commit the uncommitted files first" }).isChecked(), true);
  await screenshot("merge");
  await modal.getByRole("button", { name: "Merge into main" }).click();
  await modal.locator(".worktree-merged").waitFor();
  assert.match((await modal.locator(".worktree-merged").textContent()) ?? "", /^Merged worktree\/\S+ into main\. Commits added: 2\. The uncommitted files were committed first\.$/);
  assert.equal(readFileSync(join(repo, "feature.txt"), "utf8"), "feature\n", "the main checkout has the commit");
  assert.equal(readFileSync(join(repo, "draft.txt"), "utf8"), "draft\n", "and the file that was uncommitted");
  assert.equal(git(repo, "status", "--porcelain"), "", "the main checkout is clean after the merge");
  assert.equal(git(repo, "log", "-1", "--format=%s"), `Work from ${branch}`);
  await screenshot("merged");
  await modal.getByRole("button", { name: "Close tab and delete worktree" }).click();
  await modal.waitFor({ state: "detached" });
  await tabCount(page, before.length);
  assert.equal(existsSync(checkout), false, "the checkout is deleted");
  assert.equal(git(repo, "branch", "--list", branch), "", "and the merged branch with it");
  assert.equal(await page.locator(".tab-strip-branch").count(), 0);
  console.log("PASS the tab's menu merges the branch into the main checkout and takes the worktree away");

  // closing a worktree tab: its checkout stays unless asked, and what a delete loses is said first
  const second = await newWorktreeTab(page);
  const secondCheckout = join(trees, basename(repo), second.replaceAll("/", "-"));
  writeFileSync(join(secondCheckout, "more.txt"), "more\n");
  git(secondCheckout, "add", "-A");
  git(secondCheckout, "commit", "-q", "-m", "more");
  writeFileSync(join(secondCheckout, "unsaved.txt"), "unsaved\n");
  await openTabMenu(page, "Close tab");
  await modal.locator(".worktree-facts").waitFor();
  assert.deepEqual((await facts(page)).slice(0, 2), ["Uncommitted files=1", "Commits not in main=1"]);
  const remove = modal.getByRole("checkbox", { name: "Delete the worktree checkout" });
  assert.equal(await remove.isChecked(), false, "a checkout with work in it is kept unless asked");
  assert.equal(await modal.locator(".worktree-where").textContent(), secondCheckout);
  await screenshot("close");
  await modal.getByRole("button", { name: "Close tab", exact: true }).click();
  await modal.waitFor({ state: "detached" });
  await tabCount(page, before.length);
  assert.equal(existsSync(join(secondCheckout, "unsaved.txt")), true, "the tab closed and its checkout, unsaved file included, is still on disk");

  // the same close with the delete ticked: git's refusal of unsaved files does not come up, since the dialog named them
  const third = await newWorktreeTab(page);
  const thirdCheckout = join(trees, basename(repo), third.replaceAll("/", "-"));
  writeFileSync(join(thirdCheckout, "scratch.txt"), "scratch\n");
  await openTabMenu(page, "Close tab");
  await modal.locator(".worktree-facts").waitFor();
  assert.deepEqual((await facts(page)).slice(0, 2), ["Uncommitted files=1", "Commits not in main=0"]);
  await modal.getByRole("checkbox", { name: "Delete the worktree checkout" }).check();
  assert.equal(await modal.getByText("Its uncommitted files are lost with it.").count(), 1);
  // no commits of its own: the generated branch goes with the checkout
  assert.equal(await modal.getByRole("checkbox", { name: `Delete the branch ${third} too` }).isChecked(), true);
  await screenshot("close-delete");
  await modal.getByRole("button", { name: "Close and delete" }).click();
  await modal.waitFor({ state: "detached" });
  await tabCount(page, before.length);
  assert.equal(existsSync(thirdCheckout), false, "the checkout went with its tab");
  assert.equal(git(repo, "branch", "--list", third), "");
  // the kept worktree's branch and commit are untouched
  assert.equal(git(repo, "branch", "--list", second).includes(second), true);
  console.log("PASS closing a worktree tab keeps its checkout unless asked, and deletes it with what the dialog named");

  // the checkout a closed tab left on disk is one press away: New tab names it, and opens in it again
  await page.locator(".tab-strip-add").click();
  await dialog.waitFor();
  const kept = dialog.locator(".new-session-checkout");
  await kept.first().waitFor();
  assert.deepEqual(await kept.allTextContents(), [second.slice("worktree/".length)], "the worktree still on disk is offered");
  await kept.first().click();
  assert.equal(await dialog.getByLabel("Branch").inputValue(), second);
  assert.equal(await dialog.getByText("This branch has a worktree on disk already: the tab opens in it.").count(), 1);
  await screenshot("reopen");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator(".tab-strip-item.is-active .tab-strip-branch").waitFor();
  assert.equal(readFileSync(join(secondCheckout, "unsaved.txt"), "utf8"), "unsaved\n", "the checkout is the one that was left, unsaved file included");
  await openTabMenu(page, "Close tab");
  await modal.locator(".worktree-facts").waitFor();
  assert.deepEqual((await facts(page)).slice(0, 2), ["Uncommitted files=1", "Commits not in main=1"]);
  await modal.getByRole("checkbox", { name: "Delete the worktree checkout" }).check();
  assert.equal(await modal.getByRole("checkbox", { name: /Delete the branch/ }).count(), 0, "a branch with commits the main checkout lacks is never offered for deletion");
  assert.equal(await modal.getByText(`Its commits stay on the branch ${second}.`).count(), 1);
  await modal.getByRole("button", { name: "Close and delete" }).click();
  await modal.waitFor({ state: "detached" });
  await tabCount(page, before.length);
  assert.equal(existsSync(secondCheckout), false, "the kept checkout is deleted now");
  assert.equal(git(repo, "branch", "--list", second).includes(second), true, "and its unmerged commit is still on its branch");
  console.log("PASS a worktree left on disk opens as a tab again, and can then be deleted");

  assert.deepEqual(errors, [], "no browser page errors");
} finally {
  // Attempt every cleanup even if an earlier teardown fails; never close a workspace this run did not make.
  const cleanupErrors: unknown[] = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  try { server?.stop(); } catch (error) { cleanupErrors.push(error); }
  for (const id of ownedWorkspaces) {
    try { await workspaceClose(id); } catch (error) {
      if (!(error instanceof HerdrError && error.code === "workspace_not_found")) cleanupErrors.push(error);
    }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    console.error(new AggregateError(cleanupErrors, "Worktree tabs regression cleanup failed"));
    process.exitCode = 1;
  }
}
