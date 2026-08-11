import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED_SKILL = fileURLToPath(new URL("../skills/workshop/", import.meta.url));
const AGENT_TARGETS = {
  codex: (home: string) => join(home, ".agents", "skills", "workshop")
} as const;

export type SkillAgent = keyof typeof AGENT_TARGETS;
export type SkillInstallResult = { agent: SkillAgent; path: string; status: "installed" | "already-installed" | "updated" };

export async function installWorkshopSkill(options: { agent?: string; home?: string; source?: string; force?: boolean } = {}): Promise<SkillInstallResult> {
  const source = options.source ?? BUNDLED_SKILL;
  const agent = options.agent ?? "codex";
  const targetFor = AGENT_TARGETS[agent as SkillAgent];
  if (!targetFor) throw new Error(`Unsupported Agent: ${agent}. Supported Agents: ${Object.keys(AGENT_TARGETS).join(", ")}`);
  const target = targetFor(options.home ?? homedir());
  await stat(join(source, "SKILL.md"));
  let existed = false;
  let targetStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    targetStat = await stat(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (targetStat) {
    if (!targetStat.isDirectory()) throw new Error(`Skill destination is not a directory: ${target}`);
    const manifest = await readFile(join(target, "SKILL.md"), "utf8");
    if (!/^name:\s*workshop\s*$/m.test(manifest)) throw new Error(`Skill destination is not a Workshop skill: ${target}`);
    existed = true;
    if (!options.force) return { agent: agent as SkillAgent, path: target, status: "already-installed" };
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  return { agent: agent as SkillAgent, path: target, status: existed ? "updated" : "installed" };
}
