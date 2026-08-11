import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageDuration, usageActivityCells, usageActivityLevel, usageMonthLabels } from "./usage-statistics.ts";

test("fills contribution cells and maps activity to four intensity levels", () => {
  const cells = usageActivityCells("2026-08-09", [{ date: "2026-08-10", count: 3 }], 7);
  assert.deepEqual(cells.map((cell) => cell.count), [0, 3, 0, 0, 0, 0, 0]);
  assert.equal(usageActivityLevel(0, 8), 0);
  assert.equal(usageActivityLevel(1, 8), 1);
  assert.equal(usageActivityLevel(8, 8), 4);
});

test("formats long runtime and emits month labels by heatmap week", () => {
  assert.equal(formatUsageDuration(90_000), "1分钟");
  assert.equal(formatUsageDuration(27 * 3_600_000), "1天 3小时");
  const cells = usageActivityCells("2026-07-26", [], 21);
  assert.deepEqual(usageMonthLabels(cells), [{ label: "7月", week: 0 }, { label: "8月", week: 1 }]);
});
