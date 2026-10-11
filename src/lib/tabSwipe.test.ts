import { describe, expect, test } from "bun:test";
import { TAB_FLICK_PX, TAB_FLICK_SPEED, TAB_SWIPE_PX, scrollsFor, tabStroke, tabSwipeOffset, tabSwipeStep } from "./tabSwipe.ts";

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
