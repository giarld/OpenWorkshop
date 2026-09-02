import { safeAgentError, type AgentRegistry, type AgentRoleConfig, type AgentSession } from "./agent.ts";
import type { RequirementAnalyzer } from "./commissions.js";
import { completionWasConfirmed, parseRequirementAnalysis, requirementProgress } from "./requirement-analysis.ts";
import { requirementUsageDelta, type RequirementTokenUsage } from "./requirement-token-usage.ts";

type RequirementSession = { client: AgentSession; configKey: string; continued: boolean; output: string; tokenUsage: RequirementTokenUsage; onProgress?: (message: string) => void; lastProgress?: string; idleTimer?: NodeJS.Timeout; closed?: boolean };
export type ManagedRequirementAnalyzer = RequirementAnalyzer & { close(): Promise<void> };
const SESSION_IDLE_MS = 60 * 60 * 1_000;

export function createRequirementAnalyzer(registry: AgentRegistry): ManagedRequirementAnalyzer {
  const sessions = new Map<string, RequirementSession>();
  const running = new Set<string>();
  const closeSession = async (session: RequirementSession) => {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer) { clearTimeout(session.idleTimer); delete session.idleTimer; }
    await session.client.close();
  };
  const discardSession = async (commissionId: string, session: RequirementSession) => {
    if (sessions.get(commissionId) === session) sessions.delete(commissionId);
    await closeSession(session).catch(() => undefined);
  };
  const keepSessionAlive = (commissionId: string, session: RequirementSession) => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => void discardSession(commissionId, session), SESSION_IDLE_MS);
    session.idleTimer.unref();
  };
  const analyze: RequirementAnalyzer = async (input) => {
  const commissionId = input.commission.id;
  const backend = input.agentConfig.agentBackend ?? "codex";
  if (running.has(commissionId)) throw Object.assign(new Error("Requirement analysis is already running"), { statusCode: 409 });
  running.add(commissionId);
  try {
    input.onProgress?.("正在连接需求分析 Agent");
    const configKey = JSON.stringify(input.agentConfig);
    let session = sessions.get(commissionId);
    if (session?.idleTimer) { clearTimeout(session.idleTimer); delete session.idleTimer; }
    if (session && session.configKey !== configKey) {
      await discardSession(commissionId, session);
      session = undefined;
    }
    if (!session) {
      const health = await registry.health(backend);
      if (!health.ok) throw safeAgentError(registry, backend, Object.assign(new Error(health.error ?? "Agent backend is unavailable"), { statusCode: 503 }));
    }
    let progressSession: RequirementSession | undefined;
    try {
      if (!session) {
        session = createSession(registry, input.agentConfig, configKey);
        await session.client.initialize();
        sessions.set(commissionId, session);
      }
      input.onProgress?.("正在读取项目与委托上下文");
      session.output = "";
      if (input.onProgress) session.onProgress = input.onProgress;
      else delete session.onProgress;
      progressSession = session;
      delete session.lastProgress;
      const usageBefore = { ...session.tokenUsage };
      const run = await session.client[session.continued ? "continue" : "start"]({
        cwd: input.projectRoot,
        sandbox: "read-only",
        approvalPolicy: "never",
        ...(input.agentConfig.model ? { model: input.agentConfig.model } : {}),
        ...(input.agentConfig.reasoningEffort ? { reasoningEffort: input.agentConfig.reasoningEffort } : {}),
        prompt: requirementPrompt(input)
      });
      session.continued = true;
      input.onProgress?.("正在分析需求并检查项目信息");
      const completion = await run.completed;
      if (completion.status !== "succeeded") throw new Error(`Requirement Agent ${completion.status}`);
      if (completion.event.text !== undefined) session.output = completion.event.text;
      input.onProgress?.("正在整理澄清结果");
      const parsed = parseRequirementAnalysis(session.output);
      const result = "contentMarkdown" in parsed && !completionWasConfirmed(input.messages) ? { completionQuestion: true } as const : parsed;
      if (registry.plugin(backend).capabilities.continuation) keepSessionAlive(commissionId, session);
      else await discardSession(commissionId, session);
      return { ...result, tokenUsage: requirementUsageDelta(usageBefore, session.tokenUsage) };
    } catch (error) {
      if (session) await discardSession(commissionId, session);
      throw safeAgentError(registry, backend, error);
    } finally {
      if (input.onProgress && progressSession?.onProgress === input.onProgress) delete progressSession.onProgress;
    }
  } finally {
    running.delete(commissionId);
  }
  };
  return Object.assign(analyze, { close: async () => {
    const owned = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(owned.map(closeSession));
  } });
}

function createSession(registry: AgentRegistry, config: Readonly<AgentRoleConfig>, configKey: string): RequirementSession {
  let session: RequirementSession;
  const client = registry.createSession(config.agentBackend ?? "codex", { ...(config.backendOptions ? { backendOptions: config.backendOptions } : {}), sandboxMode: "read-only", networkAccess: false, onEvent: (event) => {
    if (event.tokenUsage) session.tokenUsage = event.tokenUsage;
    if ((event.type === "agent_message.completed" || event.type === "agent.message") && event.text !== undefined) session.output = event.text;
    else if (event.type === "agent.message.delta") session.output += event.text ?? "";
    const progress = requirementProgress(event);
    if (progress && progress !== session.lastProgress) {
      session.lastProgress = progress;
      session.onProgress?.(progress);
    }
  } });
  session = { client, configKey, continued: false, output: "", tokenUsage: { input: 0, output: 0, cached: 0 } };
  return session;
}
function requirementPrompt(input: Parameters<RequirementAnalyzer>[0]): string {
  return `You are the project supervisor Agent for OpenWorkshop, responsible for requirement clarification, task planning, and execution coordination. Continue the same clarification conversation using the updated canonical commission snapshot below. This is a strictly read-only research phase: never create, modify, rename, or delete project files, and never run commands that mutate the workspace. Before the first clarification question, research both the original requirement and the project itself: inspect the project instructions, documentation, configuration, architecture, and relevant code in the provided workspace. Resolve anything discoverable from the workspace yourself and do not ask the user for it. Use tools without narrating your research, progress, or next actions. Base every question on concrete findings from that research. Ask exactly one concise clarification question at a time, ending it with ? or ？. Choose the clarification mode yourself: use a single-choice question when 2-5 concrete, mutually exclusive answers cover the likely decisions; otherwise use a free-text question. Do not ask a yes/no gateway question when the underlying decision can be asked directly with concrete choices, and do not ask again for a decision the human already made unless the answer is genuinely ambiguous or contradictory. For single-choice questions, put your recommended answer first. Do not add Recommended/推荐 text to the option because the UI adds that label. Never include an Other/custom option in options because the UI always adds it. Before finishing, verify that target users and goals, in-scope and out-of-scope behavior, affected workflows, compatibility and platform constraints, data and security boundaries, failure behavior, acceptance criteria, and material risks are all explicit. If any item is missing, ambiguous, inferred rather than confirmed, or listed under Open questions, return the single most important question. When all information is sufficient, do not finish immediately: return completionQuestion and ask the human to confirm ending clarification. Only produce the requirement document after the latest human response explicitly agrees to that completion question; if the human declines or adds uncertainty, continue asking questions. The final document must contain Background, Goals, Non-goals, Functional requirements, Constraints, Acceptance criteria, Risks, Open questions, and Version history; its Open questions section must explicitly say None. Return JSON only, in exactly one of these forms:\n{"question":"..."}\n{"question":"...","options":["Recommended option","Alternative"]}\n{"completionQuestion":true}\n{"contentMarkdown":"...","acceptanceCriteria":["..."]}\n\nCommission: ${JSON.stringify({ title: input.commission.title, messages: input.messages, attachments: input.attachments, activeRequirement: input.activeRequirement })}`;
}
