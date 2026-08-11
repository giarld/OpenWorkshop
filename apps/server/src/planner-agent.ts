import { CODEX_APP_SERVER_ARGS, CodexAppServer, validateCustomArgs, type CodexRoleConfig, type NormalizedCodexEvent } from "./codex.js";
import type { TaskPlan } from "./tasks.js";

export type TaskPlanner = (input: { title: string; projectRoot: string; agentConfig: Readonly<CodexRoleConfig>; requirement: string; acceptanceCriteria: unknown[] }) => Promise<TaskPlan>;

export const planTasksWithCodex: TaskPlanner = async (input) => {
  let output = "";
  const customArgs = input.agentConfig.customArgs ?? [];
  validateCustomArgs(customArgs);
  const client = CodexAppServer.launch({ cwd: input.projectRoot, ...(customArgs.length ? { args: [...CODEX_APP_SERVER_ARGS, ...customArgs] } : {}), onEvent: (event) => { output += agentText(event); } });
  try {
    await client.initialize();
    const run = await client.startRun({
      cwd: input.projectRoot,
      sandbox: "read-only",
      approvalPolicy: "never",
      ...(input.agentConfig.model ? { model: input.agentConfig.model } : {}),
      ...(input.agentConfig.reasoningEffort ? { effort: input.agentConfig.reasoningEffort } : {}),
      prompt: `You are the project supervisor Agent for OpenWorkshop, responsible for task planning and coordination. Return JSON only using this exact shape: {"mainTask":{"title":"string","description":"string","priority":"none|low|medium|high|urgent","dueDate":null,"acceptanceCriteria":[]},"tasks":[{"clientId":"T1","parentClientId":null,"title":"string","description":"string","priority":"medium","dueDate":null,"labels":[],"ownerType":"ai","readOnly":false,"acceptanceCriteria":[],"dependsOn":[]}]}. Do not include status fields. Plan the smallest complete task tree for: ${JSON.stringify({ title: input.title, projectRoot: input.projectRoot, requirement: input.requirement, acceptanceCriteria: input.acceptanceCriteria })}`
    });
    await run.completed;
    return parseTaskPlan(output);
  } finally {
    await client.close();
  }
};

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

function agentText(event: NormalizedCodexEvent): string {
  if (event.method === "item/agentMessage/delta") return typeof event.payload.delta === "string" ? event.payload.delta : "";
  if (event.method !== "item/completed") return "";
  const item = event.payload.item;
  if (!item || typeof item !== "object" || (item as Record<string, unknown>).type !== "agentMessage") return "";
  const content = (item as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text : "").join("") : "";
}

function badGateway(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { statusCode: 502 });
}
