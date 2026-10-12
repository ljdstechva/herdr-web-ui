import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

// A worktree as a tab, end to end on the unmodified app over the demo's fixture transport, at a
// phone's size with touch: New tab offers a worktree where the workspace is a repository, the tab
// wears the branch glyph and is named after its branch, its menu merges the branch into the main
// checkout (committing what is uncommitted first) and takes the worktree away afterwards, and
// closing a worktree tab asks what becomes of the checkout while a plain tab closes at once.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-worktree-tabs-demo-"));

interface Listing { worktrees: Array<{ path: string; branch: string | null; is_linked_worktree: boolean }> }
const selectedWorkspace = (page: Page) => page.evaluate(async () => {
  const session = (await (await fetch("/api/session")).json()).snapshot as { tabs: { tab_id: string; workspace_id: string }[] };
  const open = document.querySelector<HTMLElement>('.tab-strip-item.is-active [role="tab"]')?.dataset.tabId;
  return session.tabs.find((tab) => tab.tab_id === open)?.workspace_id ?? "";
});
const linkedBranches = (page: Page, workspaceId: string) => page.evaluate(async (id) => {
  const listing = (await (await fetch(`/api/worktree/list?workspace_id=${encodeURIComponent(id)}`)).json()) as Listing;
  return listing.worktrees.filter((entry) => entry.is_linked_worktree).map((entry) => entry.branch);
}, workspaceId);
const tabNames = (page: Page) => page.locator(".tab-strip .tab-strip-label").allTextContents();
const facts = (page: Page) => page.locator(".worktree-facts > div").evaluateAll((rows) => rows.map((row) => `${row.querySelector("dt")?.textContent}=${row.querySelector("dd")?.textContent}`));

/** New tab with the worktree switch as given; answers the branch the dialog suggested, or null for a plain tab. */
async function newTab(page: Page, worktree: boolean): Promise<string | null> {
  await page.locator(".tab-strip-add").click();
  const dialog = page.locator(".new-session-modal");
  await dialog.waitFor();
  const toggle = dialog.getByRole("switch", { name: "New worktree" });
  if ((await toggle.getAttribute("aria-checked")) !== String(worktree)) await toggle.click();
  assert.equal(await toggle.getAttribute("aria-checked"), String(worktree));
  const branch = worktree ? await dialog.getByLabel("Branch").inputValue() : null;
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  return branch;
}

/** the open tab's touch menu, as a phone has it */
async function openTabMenu(page: Page): Promise<void> {
  await page.locator(".tab-strip-item.is-active .tab-strip-menu").click();
  await page.locator(".row-sheet").waitFor();
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });

  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      await context.addInitScript(() => { if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })); });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".tab-strip-add").waitFor();
      const workspaceId = await selectedWorkspace(page);
      assert.notEqual(workspaceId, "", "a workspace is open");
      const tabsAtStart = await tabNames(page);
      assert.equal(await page.locator(".tab-strip-branch").count(), 0, "no tab is a worktree yet");

      // New tab: the switch is off until asked for, and a plain tab keeps the workspace's folder
      await page.locator(".tab-strip-add").click();
      const dialog = page.locator(".new-session-modal");
      await dialog.waitFor();
      const toggle = dialog.getByRole("switch", { name: "New worktree" });
      assert.equal(await toggle.getAttribute("aria-checked"), "false", "a tab is plain unless asked otherwise");
      assert.equal(await dialog.getByLabel("Branch").count(), 0, "a plain tab asks for no branch");
      assert.equal(await dialog.getByText("Uses the workspace's folder").count(), 1);
      await toggle.click();
      const suggested = await dialog.getByLabel("Branch").inputValue();
      assert.match(suggested, /^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/, "a branch is already filled in, as herdr's own form fills it");
      const tabName = suggested.slice("worktree/".length);
      assert.equal(await dialog.getByLabel("Name").getAttribute("placeholder"), tabName, "the tab is named after its branch");
      assert.equal(await dialog.getByText("Uses the workspace's folder").count(), 0, "a worktree does not use the workspace's folder");
      assert.equal(await dialog.locator(".new-session-checkout").count(), 0, "no worktree is on disk yet");
      // an empty branch cannot be started
      await dialog.getByLabel("Branch").fill("  ");
      assert.equal(await dialog.getByRole("button", { name: "Start", exact: true }).isDisabled(), true);
      await dialog.getByLabel("Branch").fill(suggested);
      await dialog.getByRole("button", { name: "Start", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      const worktreeTab = page.locator(".tab-strip-item.is-active");
      await worktreeTab.locator(".tab-strip-branch").waitFor();
      assert.equal(await worktreeTab.locator(".tab-strip-label").textContent(), tabName, "the new tab is open and carries its branch's name");
      assert.equal(await worktreeTab.locator(".tab-strip-branch").getAttribute("aria-label"), `Worktree on ${suggested}`);
      assert.equal(await page.locator(".tab-strip-branch").count(), 1, "only the worktree tab wears the branch glyph");
      assert.deepEqual(await tabNames(page), [...tabsAtStart, tabName], "the worktree is a tab of the same workspace");
      assert.deepEqual(await linkedBranches(page, workspaceId), [suggested], "the repository has the new checkout");
      console.log("PASS New tab makes a worktree on its own branch, as a tab of the repository's workspace");

      // the tab's menu merges; a plain tab's does not offer it
      await openTabMenu(page);
      const items = await page.locator(".row-sheet .row-sheet-item").allTextContents();
      assert.ok(items.includes("Merge worktree…"), `a worktree tab's menu merges: ${JSON.stringify(items)}`);
      await page.locator(".row-sheet").getByRole("button", { name: "Merge worktree…" }).click();
      const merge = page.locator(".worktree-modal");
      await merge.waitFor();
      await merge.locator(".worktree-facts").waitFor();
      assert.equal(await merge.locator(".modal-title").textContent(), `Merge ${suggested}`);
      assert.deepEqual(await facts(page), ["Commits to merge=2", "Uncommitted files=1"]);
      const commitFirst = merge.getByRole("checkbox", { name: "Commit the uncommitted files first" });
      assert.equal(await commitFirst.isChecked(), true, "uncommitted work is carried by the merge unless left out");
      assert.equal(await merge.getByLabel("Commit message").inputValue(), `Work from ${suggested}`);
      assert.deepEqual(await merge.locator(".worktree-files li").allTextContents(), ["notes/plan.md"]);
      // without a message there is nothing to commit with
      await merge.getByLabel("Commit message").fill("");
      assert.equal(await merge.getByRole("button", { name: "Merge into main" }).isDisabled(), true);
      await merge.getByLabel("Commit message").fill("Plan notes");
      await merge.getByRole("button", { name: "Merge into main" }).click();
      await merge.locator(".worktree-merged").waitFor();
      assert.match((await merge.locator(".worktree-merged").textContent()) ?? "", new RegExp(`^Merged ${suggested.replace("/", "\\/")} into main\\. Commits added: 3\\. The uncommitted files were committed first\\.$`));
      // merged: the worktree can stay for more work (Done), or go with its tab
      assert.deepEqual(await merge.locator(".modal-footer button").allTextContents(), ["Done", "Close tab and delete worktree"]);
      await merge.getByRole("button", { name: "Close tab and delete worktree" }).click();
      await merge.waitFor({ state: "detached" });
      await page.waitForFunction((count) => document.querySelectorAll(".tab-strip .tab-strip-label").length === count, tabsAtStart.length, { timeout: 5_000 });
      assert.deepEqual(await tabNames(page), tabsAtStart, "the tab went with its worktree");
      assert.deepEqual(await linkedBranches(page, workspaceId), [], "the checkout is deleted");
      assert.equal(await page.locator(".tab-strip-branch").count(), 0);
      console.log("PASS a worktree tab merges into the main checkout, uncommitted work included, and is cleaned up after");

      // the switch starts where it was left; closing a worktree tab asks about its checkout
      await page.locator(".tab-strip-add").click();
      await dialog.waitFor();
      assert.equal(await toggle.getAttribute("aria-checked"), "true", "the last choice is remembered");
      const second = await dialog.getByLabel("Branch").inputValue();
      assert.notEqual(second, suggested, "each worktree gets a branch of its own");
      await dialog.getByRole("button", { name: "Start", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await page.locator(".tab-strip-item.is-active .tab-strip-branch").waitFor();

      await openTabMenu(page);
      await page.locator(".row-sheet").getByRole("button", { name: "Close tab" }).click();
      const close = page.locator(".worktree-modal");
      await close.waitFor();
      await close.locator(".worktree-facts").waitFor();
      assert.equal(await page.getByRole("alertdialog").count(), 1, "the close asks first");
      assert.deepEqual(await facts(page), ["Uncommitted files=1", "Commits not in main=2", "Size on disk=48 MB"]);
      const remove = close.getByRole("checkbox", { name: "Delete the worktree checkout" });
      assert.equal(await remove.isChecked(), false, "a checkout with work in it is kept unless asked");
      assert.deepEqual(await close.locator(".modal-footer button").allTextContents(), ["Cancel", "Close tab"]);
      assert.equal(await close.getByRole("checkbox", { name: /Delete the branch/ }).count(), 0);
      await remove.check();
      assert.equal(await close.getByText("Its uncommitted files are lost with it.").count(), 1, "what a delete loses is said before it");
      assert.equal(await close.getByText(`Its commits stay on the branch ${second}.`).count(), 1);
      assert.equal(await close.getByRole("checkbox", { name: /Delete the branch/ }).count(), 0, "a branch with unmerged commits is never offered for deletion");
      assert.deepEqual(await close.locator(".modal-footer button").allTextContents(), ["Cancel", "Close and delete"]);
      // Cancel changes nothing
      await close.getByRole("button", { name: "Cancel" }).click();
      await close.waitFor({ state: "detached" });
      assert.deepEqual(await linkedBranches(page, workspaceId), [second]);
      assert.equal((await tabNames(page)).length, tabsAtStart.length + 1);

      await openTabMenu(page);
      await page.locator(".row-sheet").getByRole("button", { name: "Close tab" }).click();
      await close.locator(".worktree-facts").waitFor();
      await close.getByRole("checkbox", { name: "Delete the worktree checkout" }).check();
      await close.getByRole("button", { name: "Close and delete" }).click();
      await close.waitFor({ state: "detached" });
      await page.waitForFunction((count) => document.querySelectorAll(".tab-strip .tab-strip-label").length === count, tabsAtStart.length, { timeout: 5_000 });
      assert.deepEqual(await linkedBranches(page, workspaceId), [], "the checkout went with the tab");
      console.log("PASS closing a worktree tab asks what becomes of its checkout, and deletes it only when asked");

      // a spent worktree (merged, nothing uncommitted) is offered for deletion already, with its generated branch
      const third = await newTab(page, true);
      assert.ok(third);
      await page.locator(".tab-strip-item.is-active .tab-strip-branch").waitFor();
      const checkoutPath = await page.evaluate(async ({ id, branch }) => {
        const listing = (await (await fetch(`/api/worktree/list?workspace_id=${encodeURIComponent(id)}`)).json()) as Listing;
        const path = listing.worktrees.find((entry) => entry.branch === branch)!.path;
        const merged = await fetch("/api/worktree/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: id, path, commit_message: "all of it" }) });
        return merged.ok ? path : "";
      }, { id: workspaceId, branch: third });
      assert.notEqual(checkoutPath, "", "the demo merged the third worktree");
      await openTabMenu(page);
      await page.locator(".row-sheet").getByRole("button", { name: "Close tab" }).click();
      await close.locator(".worktree-facts").waitFor();
      assert.deepEqual(await facts(page), ["Uncommitted files=0", "Commits not in main=0", "Size on disk=48 MB"]);
      assert.equal(await close.getByRole("checkbox", { name: "Delete the worktree checkout" }).isChecked(), true, "nothing would be lost, so the delete is ticked already");
      assert.equal(await close.getByRole("checkbox", { name: `Delete the branch ${third} too` }).isChecked(), true, "a generated branch that is merged goes with its checkout");
      assert.equal(await close.locator(".worktree-where").textContent(), checkoutPath, "the folder that goes is named");
      await close.getByRole("button", { name: "Close and delete" }).click();
      await close.waitFor({ state: "detached" });
      await page.waitForFunction((count) => document.querySelectorAll(".tab-strip .tab-strip-label").length === count, tabsAtStart.length, { timeout: 5_000 });
      assert.deepEqual(await linkedBranches(page, workspaceId), []);
      console.log("PASS a merged worktree is offered for deletion with its branch when its tab closes");

      // a plain tab is as it was: no branch, no merge, and it closes at once
      assert.equal(await newTab(page, false), null);
      await page.waitForFunction((count) => document.querySelectorAll(".tab-strip .tab-strip-label").length === count, tabsAtStart.length + 1, { timeout: 5_000 });
      assert.equal(await page.locator(".tab-strip-item.is-active .tab-strip-branch").count(), 0, "a plain tab wears no branch");
      await openTabMenu(page);
      assert.equal((await page.locator(".row-sheet .row-sheet-item").allTextContents()).includes("Merge worktree…"), false, "a plain tab has nothing to merge");
      await page.locator(".row-sheet").getByRole("button", { name: "Close tab" }).click();
      await page.waitForFunction((count) => document.querySelectorAll(".tab-strip .tab-strip-label").length === count, tabsAtStart.length, { timeout: 5_000 });
      assert.equal(await page.locator(".worktree-modal, .confirm-dialog").count(), 0, "an idle plain tab closes without a question");
      console.log("PASS a plain tab keeps its menu and closes at once");

      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
