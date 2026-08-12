import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { access } from "node:fs/promises";
import type { Writable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { registerAgentSettingsRoutes } from "./agent-settings.js";
import { registerAuthentication } from "./auth.js";
import { CodexAppServer, registerCodexRoutes } from "./codex.js";
import { registerCommissionRoutes, type RequirementAnalyzer } from "./commissions.js";
import { recoverCommissionLifecycleOperations } from "./commission-archive.js";
import { registerDocumentRoutes } from "./documents.ts";
import { registerNotificationRoutes } from "./notifications.ts";
import { registerProjectRoutes } from "./projects.js";
import { analyzeRequirementWithCodex } from "./requirement-agent.js";
import { planTasksWithCodex, type TaskPlanner } from "./planner-agent.js";
import { registerProductionRunRoutes, type RunClientLauncher } from "./runs.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerUsageStatisticsRoutes } from "./usage-statistics.js";

const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/out/", import.meta.url));

export async function createServer(database: DatabaseSync, webRoot = DEFAULT_WEB_ROOT, attachmentsRoot = fileURLToPath(new URL("../../../attachments/", import.meta.url)), analyzeRequirement?: RequirementAnalyzer, launchRunClient?: RunClientLauncher, planTasks?: TaskPlanner, loggerStream?: Writable) {
  await access(webRoot).catch(() => {
    throw new Error(`Web build not found at ${webRoot}; run the approved build first`);
  });
  await recoverCommissionLifecycleOperations(database, attachmentsRoot);

  const server = Fastify({ logger: loggerStream ? { stream: loggerStream } : true });
  registerAuthentication(server, database);
  registerAgentSettingsRoutes(server, database);
  registerCodexRoutes(server);
  registerProjectRoutes(server, database);
  registerCommissionRoutes(server, database, attachmentsRoot, analyzeRequirement ?? analyzeRequirementWithCodex, planTasks ?? planTasksWithCodex);
  registerDocumentRoutes(server, database);
  registerNotificationRoutes(server, database);
  registerUsageStatisticsRoutes(server, database);
  const mentionAgent = await registerProductionRunRoutes(server, database, launchRunClient ?? ((options) => CodexAppServer.launch(options)), attachmentsRoot);
  registerTaskRoutes(server, database, mentionAgent, attachmentsRoot);
  server.get("/api/health", async () => ({ status: "ok" }));
  await server.register(fastifyStatic, { root: webRoot, wildcard: false });
  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
  return server;
}
