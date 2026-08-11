import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installWorkshopSkill } from "./skill-installer.ts";

test("installs the Workshop skill without overwriting local changes by default", async () => {
  const home = await mkdtemp(join(tmpdir(), "workshop-skill-"));
  const installed = await installWorkshopSkill({ agent: "codex", home });
  assert.equal(installed.agent, "codex");
  assert.equal(installed.status, "installed");
  const manifest = await readFile(join(installed.path, "SKILL.md"), "utf8");
  assert.match(manifest, /name: workshop/);

  await writeFile(join(installed.path, "SKILL.md"), `${manifest}\nLocal change\n`);
  assert.equal((await installWorkshopSkill({ home })).status, "already-installed");
  assert.match(await readFile(join(installed.path, "SKILL.md"), "utf8"), /Local change/);

  assert.equal((await installWorkshopSkill({ home, force: true })).status, "updated");
  assert.match(await readFile(join(installed.path, "SKILL.md"), "utf8"), /name: workshop/);

  const foreignHome = await mkdtemp(join(tmpdir(), "workshop-skill-"));
  const foreign = join(foreignHome, ".agents", "skills", "workshop");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "SKILL.md"), "---\nname: another-skill\n---\n");
  await assert.rejects(installWorkshopSkill({ home: foreignHome, force: true }), /not a Workshop skill/);
  await assert.rejects(installWorkshopSkill({ agent: "unknown", home }), /Supported Agents: codex/);
});
