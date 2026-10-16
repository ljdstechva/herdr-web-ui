import { expect, it } from "bun:test";
import { pickerChoices, pickerCommand, pickerReady } from "./modelPicker.ts";

it("asks Claude Code users which picker, and opens Codex's one list at once", () => {
  expect(pickerChoices("claude")).toEqual(["model", "effort"]);
  expect(pickerChoices("codex")).toEqual(["model"]);
  expect(pickerChoices("pi")).toEqual([]);
});

it("opens Claude Code's model list and effort slider, and Codex's model lists for both", () => {
  expect(pickerCommand("claude", "model")).toBe("/model");
  expect(pickerCommand("claude", "effort")).toBe("/effort");
  expect(pickerCommand("codex", "model")).toBe("/model");
  expect(pickerCommand("codex", "effort")).toBe("/model");
});

it("offers nothing for an agent whose picker the chat cannot answer", () => {
  expect(pickerCommand("pi", "model")).toBeNull();
  expect(pickerCommand(null, "effort")).toBeNull();
  expect(pickerCommand(undefined, "model")).toBeNull();
});

it("is ready only while the agent is at rest", () => {
  expect(pickerReady("idle")).toBe(true);
  expect(pickerReady("done")).toBe(true);
  expect(pickerReady("unknown")).toBe(true);
  expect(pickerReady("working")).toBe(false);
  expect(pickerReady("blocked")).toBe(false);
});
