import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { access } from "node:fs/promises";
import type { Writable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { refreshAgentHealth, registerAgentSettingsRoutes } from "./agent-settings.js";
import { agentErrorBody, AgentRegistry } from "./agent.js";
import { registerAuthentication } from "./auth.js";
import { createCodexPlugin } from "./codex.js";
import { registerCommissionRoutes, type RequirementAnalyzer } from "./commissions.js";
import { recoverCommissionLifecycleOperations } from "./commission-archive.js";
import { registerDocumentRoutes } from "./documents.ts";
import { registerDeliveryRoutes } from "./deliveries.js";
import { registerNotificationRoutes } from "./notifications.ts";
import { redactSensitive } from "./security.ts";
import { registerProjectRoutes } from "./projects.js";
import { createRequirementAnalyzer } from "./requirement-agent.js";
import { createTaskPlanner, type TaskPlanner } from "./planner-agent.js";
import { registerProductionRunRoutes, type RunClientLauncher } from "./runs.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerUsageStatisticsRoutes } from "./usage-statistics.js";
import { ProjectLockManager } from "./scheduler.js";

const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/out/", import.meta.url));

export async function createServer(database: DatabaseSync, webRoot = DEFAULT_WEB_ROOT, attachmentsRoot = fileURLToPath(new URL("../../../attachments/", import.meta.url)), analyzeRequirement?: RequirementAnalyzer, launchRunClient?: RunClientLauncher, planTasks?: TaskPlanner, loggerStream?: Writable) {
  await access(webRoot).catch(() => {
    throw new Error(`Web build not found at ${webRoot}; run the approved build first`);
  });
  await recoverCommissionLifecycleOperations(database, attachmentsRoot);

  const server = Fastify({ logger: loggerStream ? { stream: loggerStream } : true });
  server.setErrorHandler((error, _request, reply) => {
    const value = error instanceof Error ? error : new Error(String(error));
    const status = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof status === "number" && status >= 400 && status < 600 ? status : 500;
    const message = redactSensitive(value.message || "Request failed").value;
    reply.code(statusCode).send(agentErrorBody(error, message));
  });
  const agents = new AgentRegistry([createCodexPlugin()]);
  registerAuthentication(server, database);
  registerAgentSettingsRoutes(server, database, agents);
  registerProjectRoutes(server, database);
  const requirementAnalyzer = analyzeRequirement ?? createRequirementAnalyzer(agents);
  registerCommissionRoutes(server, database, attachmentsRoot, requirementAnalyzer, planTasks ?? createTaskPlanner(agents));
  const closeRequirementAnalyzer = (requirementAnalyzer as RequirementAnalyzer & { close?: () => Promise<void> }).close;
  if (closeRequirementAnalyzer) server.addHook("onClose", closeRequirementAnalyzer);
  registerDocumentRoutes(server, database);
  registerNotificationRoutes(server, database);
  registerUsageStatisticsRoutes(server, database);
  const projectLocks = new ProjectLockManager();
  const mentionAgent = await registerProductionRunRoutes(server, database, launchRunClient ?? ((backend, options) => agents.createSession(backend, options)), attachmentsRoot, projectLocks, launchRunClient ? undefined : (backend) => agents.health(backend), launchRunClient ? undefined : (configSnapshotJson) => refreshAgentHealth(database, agents, configSnapshotJson).then(() => undefined), launchRunClient ? undefined : (backend, error) => agents.safeError(backend, error), launchRunClient ? undefined : (backend) => agents.explicitSecrets(backend));
  const deliveryWorker = registerDeliveryRoutes(server, database, projectLocks);
  registerTaskRoutes(server, database, mentionAgent, attachmentsRoot, deliveryWorker.acceptanceDetails);
  deliveryWorker.start();
  server.get("/api/health", async () => ({ status: "ok" }));
  await server.register(fastifyStatic, { root: webRoot, wildcard: false });
  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
  return server;
}
