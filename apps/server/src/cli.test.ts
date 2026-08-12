import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isVersionCommand, WORKSHOP_VERSION } from "./version.ts";

const packageMetadata = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };

test("CLI version comes from the published package metadata", () => {
  assert.equal(WORKSHOP_VERSION, packageMetadata.version);
});

test("CLI recognizes all version command aliases", () => {
  for (const command of ["version", "--version", "-v"]) assert.equal(isVersionCommand(command), true);
  assert.equal(isVersionCommand("versions"), false);
});
