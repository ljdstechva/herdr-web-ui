import assert from "node:assert/strict";
import { it } from "bun:test";

/** The demo answers the worktree tab routes as the server does: a tab of the same workspace, a status, a merge, a guarded delete. */
it("the demo opens a worktree as a tab, merges it and deletes its checkout only when that loses nothing or is forced", async () => {
  const saved = new Map(["window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    const transport = "../site/demo/transport.ts?worktree-tabs";
    await import(transport);
    const demo = (globalThis as any).window;
    const send = (url: string, body: unknown) => demo.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as Promise<Response>;
    const post = async (url: string, body: unknown) => (await send(url, body)).json() as Promise<any>;
    const get = async (url: string) => (await demo.fetch(url)).json() as Promise<any>;
    const session = async () => (await get("/api/session")).snapshot;

    const workspace = (await post("/api/workspace/create", { cwd: "/home/demo/worktree-tabs", label: "worktree-tabs" })).workspace_id as string;
    const list = () => get(`/api/worktree/list?workspace_id=${workspace}`);
    const status = (path: string) => demo.fetch(`/api/worktree/status?workspace_id=${workspace}&path=${encodeURIComponent(path)}`) as Promise<Response>;

    assert.equal((await send("/api/worktree/tab", { workspace_id: workspace })).status, 400, "a branch is required");
    const made = await post("/api/worktree/tab", { workspace_id: workspace, branch: "worktree/brave-river-0001" });
    assert.equal(made.workspace_id, workspace, "the worktree is a tab of the workspace it was asked from");
    assert.equal(made.existing, false);
    const snapshot = await session();
    assert.equal(snapshot.tabs.find((tab: any) => tab.tab_id === made.tab_id)?.label, "brave-river-0001");
    assert.equal(snapshot.panes.find((pane: any) => pane.pane_id === made.pane_id)?.cwd, made.path, "its pane is in the checkout");
    assert.equal(snapshot.workspaces.filter((candidate: any) => candidate.worktree?.repo_root === "/home/demo/worktree-tabs").length, 1, "no workspace was made for it");
    assert.deepEqual((await list()).worktrees.filter((entry: any) => entry.is_linked_worktree).map((entry: any) => [entry.branch, entry.open_workspace_id]), [["worktree/brave-river-0001", null]]);

    // only a linked checkout of the repository is read
    assert.equal((await status("/home/demo/elsewhere")).status, 404);
    assert.equal((await status("/home/demo/worktree-tabs")).status, 404, "the main checkout is not a worktree to merge");
    const before = await (await status(made.path)).json();
    assert.deepEqual([before.branch, before.target.branch, before.ahead, before.changed, before.conflicts], ["worktree/brave-river-0001", "main", 2, 1, []]);

    // a branch that has its checkout opens in it again
    const again = await post("/api/worktree/tab", { workspace_id: workspace, branch: "worktree/brave-river-0001" });
    assert.deepEqual([again.existing, again.path], [true, made.path]);
    assert.notEqual(again.tab_id, made.tab_id);
    await post("/api/tab/close", { tab_id: again.tab_id });

    // unsaved files stand in a delete's way until it is forced; a merge without a message leaves them
    const refused = await send("/api/worktree/remove", { workspace_id: workspace, path: made.path });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error.code, "dirty_worktree_requires_force");
    const merged = await post("/api/worktree/merge", { workspace_id: workspace, path: made.path });
    assert.deepEqual([merged.commits, merged.committed, merged.target_branch], [2, false, "main"]);
    assert.deepEqual([(await (await status(made.path)).json()).ahead, (await (await status(made.path)).json()).changed], [0, 1]);
    const nothing = await send("/api/worktree/merge", { workspace_id: workspace, path: made.path });
    assert.equal((await nothing.json()).error.code, "nothing_to_merge");
    const withFiles = await post("/api/worktree/merge", { workspace_id: workspace, path: made.path, commit_message: "the rest" });
    assert.deepEqual([withFiles.commits, withFiles.committed], [1, true]);

    // spent: it goes without force, its merged branch with it; the tab is the client's to close
    const removed = await post("/api/worktree/remove", { workspace_id: workspace, path: made.path, delete_branch: true });
    assert.deepEqual([removed.ok, removed.forced, removed.branch_deleted], [true, false, true]);
    assert.deepEqual((await list()).worktrees.filter((entry: any) => entry.is_linked_worktree), []);
    assert.equal((await session()).tabs.some((tab: any) => tab.tab_id === made.tab_id), true);
    assert.equal((await send("/api/worktree/remove", { workspace_id: workspace, path: made.path })).status, 404);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
