import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONTEXT_FILES = ["execution-policy.md", "requirement.md", "task.md", "task-tree.md", "dependencies.md", "plan-revision.md", "review-scope.md", "previous-runs.md", "project-profile.md", "messages.md"] as const;
type ContextFile = typeof CONTEXT_FILES[number];

export async function createRunContext(projectRoot: string, runId: string, files: Partial<Record<ContextFile, string>>) {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new TypeError("runId contains unsupported characters");
  const runsRoot = join(projectRoot, ".openworkshop", "runs");
  const directory = join(runsRoot, runId);
  await mkdir(runsRoot, { recursive: true });
  await mkdir(directory);
  try {
    const names = CONTEXT_FILES.filter((name) => files[name] !== undefined);
    await Promise.all(names.map((name) => writeFile(join(directory, name), files[name]!, { flag: "wx" })));
    await writeFile(join(directory, "context-manifest.json"), `${JSON.stringify({ runId, files: names })}\n`, { flag: "wx" });
    return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverRunContexts(projectRoot: string): Promise<number> {
  const runsRoot = join(projectRoot, ".openworkshop", "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const stale = entries.filter((entry) => entry.isDirectory());
  await Promise.all(stale.map((entry) => rm(join(runsRoot, entry.name), { recursive: true, force: true })));
  return stale.length;
}
