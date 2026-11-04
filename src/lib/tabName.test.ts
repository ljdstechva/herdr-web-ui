import { describe, expect, it } from "bun:test";

import { customTabLabel, folderTabName, nameSaysFolder, tabFolder, tabLabel } from "./tabName.ts";

const t = (key: string, vars?: Record<string, string | number>): string => key.replace("{n}", String(vars?.["n"]));

describe("tab names", () => {
  it("reads a tab herdr names by its number as Tab n", () => {
    expect(tabLabel({ label: "2", number: 2 }, t)).toBe("Tab 2");
    expect(tabLabel({ label: "", number: 3 }, t)).toBe("Tab 3");
    expect(customTabLabel({ label: " 2 ", number: 2 })).toBeNull();
  });

  it("keeps a given name, trimmed", () => {
    expect(tabLabel({ label: " build ", number: 2 }, t)).toBe("build");
    expect(customTabLabel({ label: "build", number: 2 })).toBe("build");
  });

  it("follows the tab's place once a tab before it closed: herdr relabels it and keeps its number", () => {
    // tab 1 of two closed: herdr reports { number: 2, label: "1" } for the one left
    expect(customTabLabel({ label: "1", number: 2 }, 1)).toBeNull();
    expect(tabLabel({ label: "1", number: 2 }, t, 1)).toBe("Tab 1");
    // a name that only looks like another place is a name
    expect(tabLabel({ label: "7", number: 2 }, t, 1)).toBe("7");
  });

  it("keeps a numeric custom name when its stable number differs from its place", () => {
    expect(customTabLabel({ label: "3", number: 3 }, 2)).toBe("3");
    expect(tabLabel({ label: "3", number: 3 }, t, 2)).toBe("3");
  });

  it("treats an empty label as herdr's automatic name", () => {
    expect(customTabLabel({ label: "", number: 3 }, 2)).toBeNull();
    expect(tabLabel({ label: "", number: 3 }, t, 2)).toBe("Tab 2");
  });

  describe("from the tab's folder", () => {
    it("writes an unnamed tab as the folder and its place", () => {
      expect(tabLabel({ label: "1", number: 1 }, t, 1, "Mouse")).toBe("Mouse 1");
      expect(tabLabel({ label: "", number: 2 }, t, 2, "Mouse")).toBe("Mouse 2");
      // the place, not the number: the tab before it closed
      expect(tabLabel({ label: "1", number: 3 }, t, 1, "Mouse")).toBe("Mouse 1");
    });

    it("writes a named tab as folder - name", () => {
      expect(tabLabel({ label: "Social", number: 1 }, t, 1, "Mouse")).toBe("Mouse - Social");
      expect(tabLabel({ label: " Social ", number: 2 }, t, 2, "03 SMARCOMMS")).toBe("03 SMARCOMMS - Social");
      // a name that only looks like another place is a name
      expect(tabLabel({ label: "7", number: 2 }, t, 1, "Mouse")).toBe("Mouse - 7");
    });

    it("does not say the folder twice", () => {
      expect(tabLabel({ label: "Mouse", number: 1 }, t, 1, "Mouse")).toBe("Mouse");
      expect(tabLabel({ label: "Mouse - Social", number: 1 }, t, 1, "Mouse")).toBe("Mouse - Social");
      expect(tabLabel({ label: "Mouse 3", number: 1 }, t, 1, "Mouse")).toBe("Mouse 3");
      // starting with the same word is not the same thing
      expect(tabLabel({ label: "Mouse trap", number: 1 }, t, 1, "Mouse")).toBe("Mouse - Mouse trap");
      expect(tabLabel({ label: "Mousepad", number: 1 }, t, 1, "Mouse")).toBe("Mouse - Mousepad");
    });

    it("says Tab n only while no folder is known", () => {
      expect(tabLabel({ label: "2", number: 2 }, t, 2, null)).toBe("Tab 2");
      expect(folderTabName(null, "Social", 2, t)).toBe("Social");
    });
  });

  it("takes the folder from the tab's first pane", () => {
    const panes = [
      { tab_id: "w1:t1", cwd: "/opt/work/Mouse" },
      { tab_id: "w1:t1", cwd: "/tmp" },
      { tab_id: "w1:t2", cwd: "/opt/work/Mouse/" },
      { tab_id: "w1:t3", cwd: "C:\\work\\Cat" },
      { tab_id: "w1:t4", cwd: null },
      { tab_id: "w1:t5", cwd: "  " },
    ];
    expect(tabFolder("w1:t1", panes)).toBe("Mouse");
    expect(tabFolder("w1:t2", panes)).toBe("Mouse");
    expect(tabFolder("w1:t3", panes)).toBe("Cat");
    expect(tabFolder("w1:t4", panes)).toBeNull();
    expect(tabFolder("w1:t5", panes)).toBeNull();
    expect(tabFolder("w1:t9", panes)).toBeNull();
  });

  it("knows a name written from a folder", () => {
    expect(nameSaysFolder("Mouse", "Mouse")).toBe(true);
    expect(nameSaysFolder("Mouse 12", "Mouse")).toBe(true);
    expect(nameSaysFolder("Mouse - Social", "Mouse")).toBe(true);
    expect(nameSaysFolder("Mouse trap 2", "Mouse")).toBe(false);
    expect(nameSaysFolder("Mouse2", "Mouse")).toBe(false);
    expect(nameSaysFolder("Cat 1", "Mouse")).toBe(false);
    expect(nameSaysFolder("Mouse", "")).toBe(false);
  });
});
