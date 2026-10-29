import { expect, it } from "bun:test";
import { folderName, placeLine, shortPathTitle, taskRowLines } from "./paneName.ts";

it("shows a path title as its last folder, and leaves any other title alone", () => {
  expect(shortPathTitle("/tmp/audit-oDjsU2/lms-backend")).toBe("lms-backend");
  expect(shortPathTitle("/home/haemin/dev/api/")).toBe("api");
  expect(shortPathTitle("~/dev/herdr web ui")).toBe("herdr web ui");
  expect(shortPathTitle("~")).toBe("~");
  expect(shortPathTitle("/")).toBe("/");
  expect(shortPathTitle("C:\\Users\\haemi\\work\\site")).toBe("site");
  expect(shortPathTitle("C:\\")).toBe("C:\\");
  expect(shortPathTitle("fix the login bug")).toBe("fix the login bug");
  expect(shortPathTitle("vim /etc/hosts")).toBe("vim /etc/hosts");
  expect(shortPathTitle("~tilde-name")).toBe("~tilde-name");
});

it("says a workspace and its folder once when they are the same", () => {
  expect(placeLine("lms-backend", "lms-backend")).toBe("lms-backend");
  expect(placeLine("api", "server")).toBe("api · server");
  expect(placeLine("api", "")).toBe("api");
});

it("finds the folder of a Windows path as of a POSIX one", () => {
  expect(folderName("C:\\work\\api")).toBe("api");
  expect(folderName("C:\\work\\api\\")).toBe("api");
  expect(folderName("C:/work/api")).toBe("api");
  expect(folderName("\\\\server\\share\\api")).toBe("api");
  expect(folderName("C:\\")).toBe("C:\\");
  expect(folderName("C:/")).toBe("C:/");
  expect(folderName("/home/haemin/dev/api/")).toBe("api");
  expect(folderName("/")).toBe("/");
  expect(folderName("/repo/branch ")).toBe("branch ");
  expect(placeLine("api", folderName("C:\\work\\api"))).toBe("api");
  expect(placeLine("api", folderName("C:\\work\\server"))).toBe("api · server");
});

it("draws a two-line row as the workspace's name over its folder, without repeating a name", () => {
  expect(taskRowLines({ folder: "workstation", workspace: "Envi Marketing" }))
    .toEqual({ title: "Envi Marketing", place: "workstation" });
  // the folder is the workspace's name: it is said once
  expect(taskRowLines({ folder: "03 Social", workspace: "03 Social" }))
    .toEqual({ title: "03 Social", place: "" });
  // a workspace without a name is titled by its folder
  expect(taskRowLines({ folder: "api", workspace: " " }))
    .toEqual({ title: "api", place: "" });
  // a linked worktree is placed by its branch where its name does not say it, then its folder
  expect(taskRowLines({ folder: "fix-session-list", workspace: "Hotfix", alias: "fix/session-list" }))
    .toEqual({ title: "Hotfix", place: "fix/session-list · fix-session-list" });
  expect(taskRowLines({ folder: "fix-payment", workspace: "fix/payment", alias: "fix/payment" }))
    .toEqual({ title: "fix/payment", place: "fix-payment" });
});
