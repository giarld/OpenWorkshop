import { argon2, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SettingsStore } from "./database.ts";

const AUTH_ID = "primary";
const COOKIE_NAME = "workshop_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PIN_PATTERN = /^\d{6}$/;
const ARGON_PARAMETERS = { memory: 65_536, passes: 3, parallelism: 1, tagLength: 32 } as const;

export async function hashPin(pin: string): Promise<string> {
  assertPin(pin);
  const salt = randomBytes(16);
  const tag = await derivePin(pin, salt, ARGON_PARAMETERS);
  return `$argon2id$v=19$m=${ARGON_PARAMETERS.memory},t=${ARGON_PARAMETERS.passes},p=${ARGON_PARAMETERS.parallelism}$${salt.toString("base64url")}$${tag.toString("base64url")}`;
}

export async function verifyPin(pin: string, encoded: string): Promise<boolean> {
  if (!PIN_PATTERN.test(pin)) return false;
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) return false;
  const salt = Buffer.from(match[4]!, "base64url");
  const expected = Buffer.from(match[5]!, "base64url");
  const parameters = { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]), tagLength: expected.length };
  if (salt.length !== 16 || expected.length !== ARGON_PARAMETERS.tagLength || parameters.memory !== ARGON_PARAMETERS.memory || parameters.passes !== ARGON_PARAMETERS.passes || parameters.parallelism !== ARGON_PARAMETERS.parallelism) return false;
  const actual = await derivePin(pin, salt, {
    memory: parameters.memory,
    passes: parameters.passes,
    parallelism: parameters.parallelism,
    tagLength: expected.length
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function setPin(database: DatabaseSync, pin: string): Promise<void> {
  const pinHash = await hashPin(pin);
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO auth_state (id, pin_hash, initialized_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pin_hash = excluded.pin_hash, updated_at = excluded.updated_at
    `).run(AUTH_ID, pinHash, now, now);
    database.prepare("DELETE FROM sessions").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export class LoginLimiter {
  private readonly failures = new Map<string, { attempts: number[]; blockedUntil: number; inFlight: boolean }>();

  begin(source: string, now = Date.now()): number {
    this.prune(now);
    if (!this.failures.has(source) && this.failures.size >= 1_024) return 60;
    const state = this.failures.get(source) ?? { attempts: [], blockedUntil: 0, inFlight: false };
    state.attempts = state.attempts.filter((attempt) => attempt > now - 60_000);
    const retryAfter = this.retryAfter(state, now);
    if (retryAfter || state.inFlight) return retryAfter || 1;
    state.inFlight = true;
    this.failures.set(source, state);
    return 0;
  }

  complete(source: string, success?: boolean, now = Date.now()): number {
    const state = this.failures.get(source);
    if (!state) return 0;
    state.inFlight = false;
    if (success) {
      this.failures.delete(source);
      return 0;
    }
    if (success === false) {
      state.attempts = state.attempts.filter((attempt) => attempt > now - 60_000);
      state.attempts.push(now);
      const delay = state.attempts.length >= 3 ? 2 ** (state.attempts.length - 3) * 1_000 : 0;
      state.blockedUntil = Math.max(state.blockedUntil, now + delay);
    }
    if (!state.attempts.length) this.failures.delete(source);
    return this.retryAfter(state, now);
  }

  private retryAfter(state: { attempts: number[]; blockedUntil: number }, now: number): number {
    const rollingWindowEnd = state.attempts.length >= 5 ? state.attempts[0]! + 60_000 : 0;
    return Math.max(0, Math.ceil((Math.max(state.blockedUntil, rollingWindowEnd) - now) / 1000));
  }

  private prune(now: number): void {
    if (this.failures.size < 1_024) return;
    for (const [source, state] of this.failures) {
      if (!state.inFlight && state.attempts.every((attempt) => attempt <= now - 60_000)) this.failures.delete(source);
    }
  }
}

export function registerAuthentication(server: FastifyInstance, database: DatabaseSync): void {
  const limiter = new LoginLimiter();

  server.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || publicRoute(request)) return;
    if (!authenticate(database, request, reply, true)) return reply.code(401).send({ error: "Authentication required" });
  });

  server.get("/api/system/status", async (request) => ({
    initialized: Boolean(currentPinHash(database)),
    authenticated: authenticate(database, request),
    httpWarning: request.protocol !== "https"
  }));

  server.post("/api/auth/initialize", async (request, reply) => {
    if (currentPinHash(database)) return reply.code(409).send({ error: "PIN is already initialized" });
    const pin = bodyPin(request.body, "pin");
    await initializePin(database, pin!);
    createSession(database, request, reply);
    return reply.code(201).send({ ok: true });
  });

  server.post("/api/auth/login", async (request, reply) => {
    const retryAfter = limiter.begin(request.ip);
    if (retryAfter) return rateLimited(reply, retryAfter);
    const pinHash = currentPinHash(database);
    const pin = bodyPin(request.body, "pin", false);
    let valid: boolean;
    try {
      valid = Boolean(pinHash && pin && await verifyPin(pin, pinHash));
    } catch (error) {
      limiter.complete(request.ip);
      throw error;
    }
    const wait = limiter.complete(request.ip, valid);
    if (!valid) {
      if (wait) reply.header("Retry-After", String(wait));
      return reply.code(401).send({ error: "Invalid PIN", retryAfter: wait });
    }
    createSession(database, request, reply);
    return { ok: true };
  });

  server.post("/api/auth/logout", async (request, reply) => {
    const token = sessionToken(request);
    if (token) database.prepare("DELETE FROM sessions WHERE id_hash = ?").run(tokenHash(token));
    clearSessionCookie(reply, request.protocol === "https");
    return { ok: true };
  });

  server.put("/api/auth/pin", async (request, reply) => {
    const current = bodyPin(request.body, "currentPin", false);
    const next = bodyPin(request.body, "newPin");
    const pinHash = currentPinHash(database);
    if (!pinHash || !current || !await verifyPin(current, pinHash)) return reply.code(401).send({ error: "Invalid PIN" });
    await setPin(database, next!);
    clearSessionCookie(reply, request.protocol === "https");
    return { ok: true };
  });

  server.get("/api/settings", async (request) => settingsResponse(database, request.protocol !== "https"));

  server.put<{ Body: Record<string, unknown> }>("/api/settings", async (request, reply) => {
    const limits = { globalConcurrency: [1, 16], projectConcurrency: [1, 8], logRetentionDays: [1, 3650] } as const;
    for (const [key, [minimum, maximum]] of Object.entries(limits)) {
      const value = request.body?.[key];
      if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) return reply.code(400).send({ error: `${key} must be an integer from ${minimum} to ${maximum}` });
    }
    const settings = new SettingsStore(database);
    let humanAvatar: string;
    let agentAvatar: string;
    try {
      humanAvatar = request.body?.humanAvatar === undefined ? settings.get<string>("humanAvatar", "🙂") ?? "🙂" : avatarSetting(request.body.humanAvatar, "humanAvatar");
      agentAvatar = request.body?.agentAvatar === undefined ? settings.get<string>("agentAvatar", "🤖") ?? "🤖" : avatarSetting(request.body.agentAvatar, "agentAvatar");
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    for (const key of Object.keys(limits) as Array<keyof typeof limits>) settings.set(key, request.body[key]);
    settings.set("humanAvatar", humanAvatar);
    settings.set("agentAvatar", agentAvatar);
    return settingsResponse(database, request.protocol !== "https");
  });
}

function settingsResponse(database: DatabaseSync, httpWarning: boolean) {
  const settings = new SettingsStore(database);
  return {
    globalConcurrency: settings.get("globalConcurrency", 4),
    projectConcurrency: settings.get("projectConcurrency", 2),
    logRetentionDays: settings.get("logRetentionDays", 90),
    humanAvatar: settings.get("humanAvatar", "🙂"),
    agentAvatar: settings.get("agentAvatar", "🤖"),
    httpWarning
  };
}

function avatarSetting(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${key} must be a non-empty string`);
  const avatar = value.trim();
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(avatar)) {
    const encoded = avatar.slice(avatar.indexOf(",") + 1);
    if (Buffer.from(encoded, "base64").byteLength > 256 * 1024) throw new TypeError(`${key} image must not exceed 256 KiB`);
    return avatar;
  }
  if (avatar.length > 32 || avatar.startsWith("data:")) throw new TypeError(`${key} must be short text or a supported image`);
  return avatar;
}

function derivePin(pin: string, salt: Buffer, parameters: { memory: number; passes: number; parallelism: number; tagLength: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => argon2("argon2id", { message: pin, nonce: salt, ...parameters }, (error, tag) => error ? reject(error) : resolve(tag)));
}

async function initializePin(database: DatabaseSync, pin: string): Promise<void> {
  const pinHash = await hashPin(pin);
  const now = new Date().toISOString();
  try {
    database.prepare("INSERT INTO auth_state (id, pin_hash, initialized_at, updated_at) VALUES (?, ?, ?, ?)").run(AUTH_ID, pinHash, now, now);
  } catch (error) {
    if (currentPinHash(database)) throw Object.assign(new Error("PIN is already initialized"), { statusCode: 409 });
    throw error;
  }
}

function assertPin(pin: string): void {
  if (!PIN_PATTERN.test(pin)) throw new TypeError("PIN must contain exactly 6 digits");
}

function bodyPin(body: unknown, key: string, required = true): string | undefined {
  const pin = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof pin === "string" && PIN_PATTERN.test(pin)) return pin;
  if (!required) return undefined;
  throw Object.assign(new TypeError(`${key} must contain exactly 6 digits`), { statusCode: 400 });
}

function publicRoute(request: FastifyRequest): boolean {
  return request.url === "/api/system/status" || request.url === "/api/auth/initialize" || request.url === "/api/auth/login";
}

function currentPinHash(database: DatabaseSync): string | undefined {
  return (database.prepare("SELECT pin_hash FROM auth_state WHERE id = ?").get(AUTH_ID) as { pin_hash: string } | undefined)?.pin_hash;
}

function createSession(database: DatabaseSync, request: FastifyRequest, reply: FastifyReply): void {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  database.prepare("INSERT INTO sessions (id_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash(token), now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString(), now.toISOString());
  reply.header("Set-Cookie", cookie(token, SESSION_TTL_MS / 1000, request.protocol === "https"));
}

function authenticate(database: DatabaseSync, request: FastifyRequest, reply?: FastifyReply, renew = false): boolean {
  const token = sessionToken(request);
  if (!token) return false;
  const idHash = tokenHash(token);
  const row = database.prepare("SELECT expires_at FROM sessions WHERE id_hash = ?").get(idHash) as { expires_at: string } | undefined;
  if (!row) return false;
  const now = new Date();
  if (Date.parse(row.expires_at) <= now.getTime()) {
    database.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
    return false;
  }
  if (renew) {
    database.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id_hash = ?")
      .run(new Date(now.getTime() + SESSION_TTL_MS).toISOString(), now.toISOString(), idHash);
    reply?.header("Set-Cookie", cookie(token, SESSION_TTL_MS / 1000, request.protocol === "https"));
  }
  return true;
}

function sessionToken(request: FastifyRequest): string | undefined {
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return undefined;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.header("Set-Cookie", cookie("", 0, secure));
}

function rateLimited(reply: FastifyReply, retryAfter: number) {
  return reply.header("Retry-After", String(retryAfter)).code(429).send({ error: "Too many login attempts", retryAfter });
}
