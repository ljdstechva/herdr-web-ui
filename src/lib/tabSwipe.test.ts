import { describe, expect, test } from "bun:test";
import { TAB_FLICK_PX, TAB_FLICK_SPEED, TAB_SWIPE_PX, scrollsFor, swipeTarget, tabStroke, tabSwipeOffset, tabSwipeStep } from "./tabSwipe.ts";

describe("tabStroke", () => {
  test("a tiny movement is not a direction yet", () => {
    expect(tabStroke(4, 3)).toBe("pending");
    expect(tabStroke(-9, 9)).toBe("pending");
  });

  test("a stroke clearly more across than along is the tabs'", () => {
    expect(tabStroke(-30, 6)).toBe("sideways");
    expect(tabStroke(40, -20)).toBe("sideways");
  });

  test("a vertical or diagonal stroke scrolls what is under it", () => {
    expect(tabStroke(6, 40)).toBe("other");
    expect(tabStroke(30, 30)).toBe("other");
    expect(tabStroke(-30, 24)).toBe("other");
  });
});

describe("tabSwipeStep", () => {
  test("a finger that went left far enough opens the tab after, right the tab before", () => {
    expect(tabSwipeStep(-TAB_SWIPE_PX, 400)).toBe(1);
    expect(tabSwipeStep(TAB_SWIPE_PX, 400)).toBe(-1);
  });

  test("a slow stroke short of the distance opens nothing", () => {
    expect(tabSwipeStep(-(TAB_SWIPE_PX - 1), 600)).toBe(0);
    expect(tabSwipeStep(20, 30)).toBe(0);
  });

  test("a quick short stroke is a flick", () => {
    const ms = TAB_FLICK_PX / TAB_FLICK_SPEED;
    expect(tabSwipeStep(-TAB_FLICK_PX, ms)).toBe(1);
    expect(tabSwipeStep(TAB_FLICK_PX, ms)).toBe(-1);
    expect(tabSwipeStep(TAB_FLICK_PX, ms * 2)).toBe(0);
    // no time passed between the events: no speed to speak of
    expect(tabSwipeStep(TAB_FLICK_PX, 0)).toBe(0);
  });
});

describe("tabSwipeOffset", () => {
  test("the pane follows part of the way toward a tab, and less where none lies that way", () => {
    const toward = tabSwipeOffset(-100, true);
    const resisted = tabSwipeOffset(-100, false);
    expect(toward).toBeLessThan(0);
    expect(toward).toBeGreaterThan(-100);
    expect(resisted).toBeLessThan(0);
    expect(resisted).toBeGreaterThan(toward);
    expect(tabSwipeOffset(100, true)).toBe(-toward);
  });
});

describe("scrollsFor", () => {
  test("a block at its start scrolls for a finger going left, and has nothing for one going right", () => {
    expect(scrollsFor(-30, 0, 300, 900)).toBe(true);
    expect(scrollsFor(30, 0, 300, 900)).toBe(false);
  });

  test("in its middle it scrolls both ways", () => {
    expect(scrollsFor(-30, 200, 300, 900)).toBe(true);
    expect(scrollsFor(30, 200, 300, 900)).toBe(true);
  });

  test("at its end the stroke that brought it there is the tabs' again", () => {
    expect(scrollsFor(-30, 600, 300, 900)).toBe(false);
    // a fraction of a pixel short of the end is the end
    expect(scrollsFor(-30, 599.4, 300, 900)).toBe(false);
    expect(scrollsFor(30, 600, 300, 900)).toBe(true);
  });
});

describe("swipeTarget", () => {
  const workspaces = ["a", "b", "c", "d"].map((workspace_id) => ({ workspace_id }));
  const tab = (workspace_id: string, n: number) => ({ tab_id: `${workspace_id}:t${n}`, workspace_id });
  // b has three tabs, c none, the others one each
  const tabs = [tab("a", 1), tab("b", 1), tab("b", 2), tab("b", 3), tab("d", 1)];
  const to = (from: string, step: -1 | 1, opens?: (candidate: { tab_id: string }) => boolean) => {
    const target = swipeTarget(workspaces, tabs, from, step, opens);
    return target === null ? null : `${target.tab.tab_id}${target.workspace ? ` in ${target.workspace.workspace_id}` : ""}`;
  };

  test("inside the row it is the tab beside, in the same workspace", () => {
    expect(to("b:t2", 1)).toBe("b:t3");
    expect(to("b:t2", -1)).toBe("b:t1");
  });

  test("past the first tab it is the workspace before, entered at its last tab", () => {
    expect(to("b:t1", -1)).toBe("a:t1 in a");
    expect(to("d:t1", -1)).toBe("b:t3 in b");
  });

  test("past the last tab it is the workspace after, entered at its first tab", () => {
    expect(to("a:t1", 1)).toBe("b:t1 in b");
  });

  test("a workspace with nothing to open is passed over", () => {
    expect(to("b:t3", 1)).toBe("d:t1 in d");
    expect(to("d:t1", -1, (candidate) => candidate.tab_id !== "b:t3")).toBe("b:t2 in b");
  });

  test("the first tab of the first workspace and the last of the last lead nowhere", () => {
    expect(to("a:t1", -1)).toBe(null);
    expect(to("d:t1", 1)).toBe(null);
  });

  test("a tab beside that cannot open is not skipped inside its own row", () => {
    expect(to("b:t1", 1, (candidate) => candidate.tab_id !== "b:t2")).toBe(null);
  });

  test("an open tab that left the snapshot leads nowhere", () => {
    expect(to("z:t9", 1)).toBe(null);
  });
});
