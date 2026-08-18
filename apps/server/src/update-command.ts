import { exec } from "node:child_process";
import { promisify } from "node:util";

const runCommand = promisify(exec);

export function updateOpenWorkshop(env = process.env): Promise<{ stdout: string; stderr: string }> {
  return runCommand("npm update --global openworkshop", { env, windowsHide: true });
}
