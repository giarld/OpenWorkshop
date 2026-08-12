import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };

if (typeof packageMetadata.version !== "string") throw new Error("OpenWorkshop package version is missing");

export const WORKSHOP_VERSION = packageMetadata.version;

export function isVersionCommand(command: string): boolean {
  return command === "version" || command === "--version" || command === "-v";
}
