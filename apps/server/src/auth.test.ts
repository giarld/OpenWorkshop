import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { hashPin, LoginLimiter, registerAuthentication, verifyPin } from "./auth.ts";
import { openWorkshopDatabase } from "./database.ts";

test("hashes PINs with Argon2id and verifies without storing plaintext", async () => {
  const encoded = await hashPin("123456");
  assert.match(encoded, /^\$argon2id\$/);
  assert.equal(encoded.includes("123456"), false);
  assert.equal(await verifyPin("123456", encoded), true);
  assert.equal(await verifyPin("654321", encoded), false);
});

test("limits five failures per minute and increases early wait time", () => {
  const limiter = new LoginLimiter();
  assert.equal(limiter.begin("client", 0), 0);
  assert.equal(limiter.begin("client", 0), 1);
  assert.equal(limiter.complete("client", false, 0), 0);
  assert.equal(limiter.begin("client", 1), 0);
  assert.equal(limiter.complete("client", false, 1), 0);
  assert.equal(limiter.begin("client", 2), 0);
  assert.equal(limiter.complete("client", false, 2), 1);
  assert.equal(limiter.begin("client", 1_002), 0);
  limiter.complete("client", false, 1_002);
  assert.equal(limiter.begin("client", 3_002), 0);
  assert.equal(limiter.complete("client", false, 3_002), 57);

  const bounded = new LoginLimiter();
  for (let source = 0; source < 1_024; source += 1) assert.equal(bounded.begin(String(source), 0), 0);
  assert.equal(bounded.begin("overflow", 0), 60);
});

test("protects APIs and revokes the existing session when the PIN changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-workshop-auth-"));
  let database;
  try {
    database = await openWorkshopDatabase(home);
    const server = Fastify();
    registerAuthentication(server, database);
    server.get("/api/health", async () => ({ status: "ok" }));
    assert.equal((await server.inject({ method: "GET", url: "/api/health" })).statusCode, 401);

    const initialized = await server.inject({ method: "POST", url: "/api/auth/initialize", payload: { pin: "123456" } });
    assert.equal(initialized.statusCode, 201);
    const cookie = initialized.headers["set-cookie"]!.split(";", 1)[0];
    const shortenedExpiry = new Date(Date.now() + 60_000).toISOString();
    database.prepare("UPDATE sessions SET expires_at = ?").run(shortenedExpiry);
    const active = await server.inject({ method: "GET", url: "/api/health", headers: { cookie } });
    assert.equal(active.statusCode, 200);
    assert.match(active.headers["set-cookie"]!, /Max-Age=86400/);
    assert.ok(Date.parse((database.prepare("SELECT expires_at FROM sessions").get() as { expires_at: string }).expires_at) > Date.parse(shortenedExpiry));
    assert.deepEqual((await server.inject({ method: "GET", url: "/api/settings", headers: { cookie } })).json(), { globalConcurrency: 4, projectConcurrency: 2, logRetentionDays: 90, humanAvatar: "🙂", agentAvatar: "🤖", httpWarning: true });
    assert.equal((await server.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { globalConcurrency: 0, projectConcurrency: 2, logRetentionDays: 90 } })).statusCode, 400);
    assert.equal((await server.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { globalConcurrency: 5, projectConcurrency: 2, logRetentionDays: 90 } })).json().humanAvatar, "🙂");
    assert.equal((await server.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { globalConcurrency: 6, projectConcurrency: 3, logRetentionDays: 120, humanAvatar: "🙂", agentAvatar: "data:image/svg+xml;base64,AA==" } })).statusCode, 400);
    assert.equal((await server.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { globalConcurrency: 6, projectConcurrency: 3, logRetentionDays: 120, humanAvatar: "🙂", agentAvatar: `data:image/png;base64,${Buffer.alloc(256 * 1024 + 1).toString("base64")}` } })).statusCode, 400);
    const settings = await server.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { globalConcurrency: 6, projectConcurrency: 3, logRetentionDays: 120, humanAvatar: "👩", agentAvatar: "data:image/png;base64,AA==" } });
    assert.deepEqual(settings.json(), { globalConcurrency: 6, projectConcurrency: 3, logRetentionDays: 120, humanAvatar: "👩", agentAvatar: "data:image/png;base64,AA==", httpWarning: true });

    const changed = await server.inject({ method: "PUT", url: "/api/auth/pin", headers: { cookie }, payload: { currentPin: "123456", newPin: "654321" } });
    assert.equal(changed.statusCode, 200);
    assert.equal((await server.inject({ method: "GET", url: "/api/health", headers: { cookie } })).statusCode, 401);
    assert.equal((await server.inject({ method: "POST", url: "/api/auth/login", payload: { pin: "654321" } })).statusCode, 200);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => server.inject({ method: "POST", url: "/api/auth/login", payload: { pin: "000000" } })));
    assert.equal(concurrent.filter((response) => response.statusCode === 401).length, 1);
    assert.equal(concurrent.filter((response) => response.statusCode === 429).length, 7);
    await server.close();
  } finally {
    database?.close();
    await rm(home, { recursive: true, force: true });
  }
});
