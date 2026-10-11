import { expect, it } from "bun:test";

import type { VpsIssue } from "../../shared/vps.ts";
import { formatBytes, formatUptime, markSeen, meterLevel, newsIssues } from "./vps.ts";

const issue = (id: string, severity: VpsIssue["severity"]): VpsIssue => ({ id, kind: "disk", severity, title: id, detail: "", since: 0 });

it("tells an issue the device has not shown, or shows at a lower level", () => {
  expect(newsIssues([issue("disk:/", "warning")], {}).map((entry) => entry.id)).toEqual(["disk:/"]);
  expect(newsIssues([issue("disk:/", "warning")], { "disk:/": "warning" })).toEqual([]);
  expect(newsIssues([issue("disk:/", "critical")], { "disk:/": "warning" }).map((entry) => entry.id)).toEqual(["disk:/"]);
  expect(newsIssues([issue("disk:/", "warning")], { "disk:/": "critical" })).toEqual([]);
});

it("keeps only the open issues as seen, at the higher level shown", () => {
  expect(markSeen([issue("disk:/", "warning")], { "disk:/": "critical", memory: "warning" })).toEqual({ "disk:/": "critical" });
  expect(markSeen([issue("memory", "critical")], {})).toEqual({ memory: "critical" });
});

it("formats bytes, uptime and the level of a meter", () => {
  expect(formatBytes(null)).toBe("—");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
  expect(formatUptime(90_061)).toBe("1d 1h");
  expect(formatUptime(3_660)).toBe("1h 1m");
  expect(meterLevel(92, 85, 93)).toBe("warning");
  expect(meterLevel(93, 85, 93)).toBe("critical");
  expect(meterLevel(10, 85, 93)).toBe("ok");
});
