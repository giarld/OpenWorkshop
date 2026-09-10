import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("commission list polling is owned by the parent, while the child only polls open details", () => {
  const child = readFileSync(new URL("./commission-workspace.tsx", import.meta.url), "utf8");
  const parent = readFileSync(new URL("./task-workspace.tsx", import.meta.url), "utf8");
  const effects = child.slice(0, child.indexOf("  async function loadCommissions("));
  assert.equal(effects.includes("api<Commission[]>"), false);
  assert.ok(parent.includes("projectCommissions={projectCommissions}"));
  assert.ok(effects.includes("setCommissions(projectCommissions)"));
  assert.ok(effects.includes('hidden || dialogMode !== "requirement" || !selected?.id'));
  assert.ok(effects.includes("if (requirementsRefreshInFlight.current) return"));
  assert.ok(effects.includes("if (!cancelled) setSelected(details)"));
});
