import { safeAgentError, type AgentRegistry, type AgentRoleConfig, type AgentSession } from "./agent.ts";
import type { TaskPlan } from "./tasks.js";

export type TaskPlanner = (input: { title: string; projectRoot: string; agentConfig: Readonly<AgentRoleConfig>; requirement: string; acceptanceCriteria: unknown[] }) => Promise<TaskPlan>;

export function createTaskPlanner(registry: AgentRegistry): TaskPlanner { return async (input) => {
  let output = "";
  const backend = input.agentConfig.agentBackend ?? "codex";
  let client: AgentSession | undefined;
  try {
    const health = await registry.health(backend);
    if (!health.ok) throw Object.assign(new Error(health.error ?? "Agent backend is unavailable"), { statusCode: 503 });
    client = registry.createSession(backend, { cwd: input.projectRoot, ...(input.agentConfig.backendOptions ? { backendOptions: input.agentConfig.backendOptions } : {}), sandboxMode: "read-only", networkAccess: false, onEvent: (event) => { if (event.type === "agent.message.delta" || !output) output += event.text ?? ""; } });
    await client.initialize();
    const run = await client.start({
      cwd: input.projectRoot,
      sandbox: "read-only",
      approvalPolicy: "never",
      ...(input.agentConfig.model ? { model: input.agentConfig.model } : {}),
      ...(input.agentConfig.reasoningEffort ? { reasoningEffort: input.agentConfig.reasoningEffort } : {}),
      prompt: `You are the project supervisor Agent for OpenWorkshop, responsible for task planning and coordination. Return JSON only using this exact shape: {"mainTask":{"title":"string","description":"string","priority":"none|low|medium|high|urgent","dueDate":null,"acceptanceCriteria":[]},"tasks":[{"clientId":"T1","parentClientId":null,"title":"string","description":"string","priority":"medium","dueDate":null,"labels":[],"ownerType":"ai","readOnly":false,"acceptanceCriteria":[],"dependsOn":[]}]}. Do not include status fields. Plan the smallest complete task tree. Split only when a child is an independently implementable, verifiable, and retryable delivery unit. Keep tightly coupled work in one task. Do not create separate tasks merely for individual files, functions, classes, small edits, setup steps, or mechanical implementation steps. Avoid nested subtasks unless the parent genuinely coordinates multiple independently deliverable units. Requirement: ${JSON.stringify({ title: input.title, projectRoot: input.projectRoot, requirement: input.requirement, acceptanceCriteria: input.acceptanceCriteria })}`
    });
    const completion = await run.completed;
    if (completion.status !== "succeeded") throw new Error(`Planning Agent ${completion.status}`);
    if (completion.event.text !== undefined) output = completion.event.text;
    return parseTaskPlan(output);
  } catch (error) {
    throw safeAgentError(registry, backend, error);
  } finally {
    await client?.close().catch(() => undefined);
  }
}; }

export function parseTaskPlan(output: string): TaskPlan {
  const json = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1] ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  let value: unknown;
  try { value = JSON.parse(json); }
  catch (error) { throw badGateway("Planning Agent returned invalid JSON", error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badGateway("Planning Agent returned invalid output");
  const plan = value as Record<string, unknown>;
  if (!plan.mainTask || typeof plan.mainTask !== "object" || Array.isArray(plan.mainTask) || !Array.isArray(plan.tasks)) throw badGateway("Planning Agent returned an unsupported result");
  return plan as TaskPlan;
}


function badGateway(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { statusCode: 502 });
}
