import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { checkPort, doctorFailed, doctorLabel } from "./doctor.ts";
import { updateOpenWorkshop } from "./update-command.ts";
import { isVersionCommand, WORKSHOP_VERSION } from "./version.ts";

const packageMetadata = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };

test("CLI version comes from the published package metadata", () => {
  assert.equal(WORKSHOP_VERSION, packageMetadata.version);
});

test("CLI recognizes all version command aliases", () => {
  for (const command of ["version", "--version", "-v"]) assert.equal(isVersionCommand(command), true);
  assert.equal(isVersionCommand("versions"), false);
});

test("CLI update runs npm update --global openworkshop", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "workshop-update-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const capturePath = join(fixture, "args.txt");
  const npmPath = join(fixture, process.platform === "win32" ? "npm.cmd" : "npm");
  await writeFile(npmPath, process.platform === "win32"
    ? "@echo off\r\n> \"%WORKSHOP_UPDATE_CAPTURE%\" echo %*\r\n"
    : "#!/bin/sh\nprintf '%s' \"$*\" > \"$WORKSHOP_UPDATE_CAPTURE\"\n", { mode: 0o755 });

  await updateOpenWorkshop({ ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH ?? ""}`, WORKSHOP_UPDATE_CAPTURE: capturePath });

  assert.equal((await readFile(capturePath, "utf8")).trim(), "update --global openworkshop");
});

test("doctor accepts a port occupied by OpenWorkshop and rejects another service", async () => {
  const workshop = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ initialized: true, authenticated: false, httpWarning: true }));
  });
  await new Promise<void>((resolve) => workshop.listen(0, "127.0.0.1", resolve));
  const workshopAddress = workshop.address();
  assert.ok(workshopAddress && typeof workshopAddress !== "string");
  await checkPort("127.0.0.1", workshopAddress.port, { port: workshopAddress.port });
  await new Promise<void>((resolve, reject) => workshop.close((error) => error ? reject(error) : resolve()));

  const other = createServer((_request, response) => response.end("other"));
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const otherAddress = other.address();
  assert.ok(otherAddress && typeof otherAddress !== "string");
  await assert.rejects(checkPort("127.0.0.1", otherAddress.port, { port: otherAddress.port }));
  await new Promise<void>((resolve, reject) => other.close((error) => error ? reject(error) : resolve()));
});

test("doctor reports missing Git as a warning without failing", () => {
  const git = { name: "git", ok: false, warning: true, detail: "not found" };
  assert.equal(doctorLabel(git), "WARN");
  assert.equal(doctorFailed([git]), false);
  assert.equal(doctorFailed([{ name: "database", ok: false }]), true);
});
