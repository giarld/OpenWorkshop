import { CodexAppServer, codexAppServerArgs, validateCustomArgs, type CodexRoleConfig, type NormalizedCodexEvent } from "./codex.js";
import type { RequirementAnalyzer } from "./commissions.js";
import { completionWasConfirmed, parseRequirementAnalysis, requirementProgress } from "./requirement-analysis.js";
import { requirementTokenUsage, requirementUsageDelta, type RequirementTokenUsage } from "./requirement-token-usage.js";

type RequirementSession = { client: CodexAppServer; configKey: string; threadId?: string; output: string; tokenUsage: RequirementTokenUsage; onProgress?: (message: string) => void; lastProgress?: string; idleTimer?: NodeJS.Timeout };

const sessions = new Map<string, RequirementSession>();
const running = new Set<string>();
const SESSION_IDLE_MS = 60 * 60 * 1_000;

export const analyzeRequirementWithCodex: RequirementAnalyzer = async (input) => {
  const commissionId = input.commission.id;
  if (running.has(commissionId)) throw Object.assign(new Error("Requirement analysis is already running"), { statusCode: 409 });
  running.add(commissionId);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let session = sessions.get(commissionId);
      let progressSession: RequirementSession | undefined;
      try {
        input.onProgress?.("正在连接需求分析 Agent");
        const configKey = JSON.stringify(input.agentConfig);
        if (session && session.configKey !== configKey) {
          await discardSession(commissionId, session);
          session = undefined;
        }
        if (!session) {
          session = createSession(input.agentConfig, configKey);
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
        const run = await session.client.startRun({
          cwd: input.projectRoot,
          ...(session.threadId ? { threadId: session.threadId } : {}),
          sandbox: "read-only",
          approvalPolicy: "never",
          ...(input.agentConfig.model ? { model: input.agentConfig.model } : {}),
          ...(input.agentConfig.reasoningEffort ? { effort: input.agentConfig.reasoningEffort } : {}),
          prompt: requirementPrompt(input)
        });
        session.threadId = run.threadId;
        input.onProgress?.("正在分析需求并检查项目信息");
        await run.completed;
        input.onProgress?.("正在整理澄清结果");
        const parsed = parseRequirementAnalysis(session.output);
        const result = "contentMarkdown" in parsed && !completionWasConfirmed(input.messages) ? { completionQuestion: true } as const : parsed;
        keepSessionAlive(commissionId, session);
        return { ...result, tokenUsage: requirementUsageDelta(usageBefore, session.tokenUsage) };
      } catch (error) {
        if (session) await discardSession(commissionId, session);
        if (attempt) throw error;
      } finally {
        if (input.onProgress && progressSession?.onProgress === input.onProgress) delete progressSession.onProgress;
      }
    }
    throw new Error("Requirement analysis failed");
  } finally {
    running.delete(commissionId);
  }
};

function createSession(config: Readonly<CodexRoleConfig>, configKey: string): RequirementSession {
  const customArgs = config.customArgs ?? [];
  validateCustomArgs(customArgs);
  let session: RequirementSession;
  const client = CodexAppServer.launch({ args: codexAppServerArgs("read-only", false, customArgs), onEvent: (event) => {
    const usage = event.type === "token.usage" ? requirementTokenUsage(event.payload) : undefined;
    if (usage) session.tokenUsage = usage;
    const text = agentText(event);
    if (event.method === "item/agentMessage/delta" || !session.output) session.output += text;
    const progress = requirementProgress(event);
    if (progress && progress !== session.lastProgress) {
      session.lastProgress = progress;
      session.onProgress?.(progress);
    }
  } });
  session = { client, configKey, output: "", tokenUsage: { input: 0, output: 0, cached: 0 } };
  return session;
}

async function discardSession(commissionId: string, session: RequirementSession): Promise<void> {
  if (sessions.get(commissionId) === session) sessions.delete(commissionId);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  await session.client.close().catch(() => undefined);
}

function keepSessionAlive(commissionId: string, session: RequirementSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => void discardSession(commissionId, session), SESSION_IDLE_MS);
  session.idleTimer.unref();
}

function requirementPrompt(input: Parameters<RequirementAnalyzer>[0]): string {
  return `You are the project supervisor Agent for OpenWorkshop, responsible for requirement clarification, task planning, and execution coordination. Continue the same clarification conversation using the updated canonical commission snapshot below. This is a strictly read-only research phase: never create, modify, rename, or delete project files, and never run commands that mutate the workspace. Before the first clarification question, research both the original requirement and the project itself: inspect the project instructions, documentation, configuration, architecture, and relevant code in the provided workspace. Resolve anything discoverable from the workspace yourself and do not ask the user for it. Base every question on concrete findings from that research. Ask exactly one concise clarification question at a time. Choose the clarification mode yourself: use a single-choice question when 2-5 concrete, mutually exclusive answers cover the likely decisions; otherwise use a free-text question. For single-choice questions, put your recommended answer first. Do not add Recommended/推荐 text to the option because the UI adds that label. Never include an Other/custom option in options because the UI always adds it. Before finishing, verify that target users and goals, in-scope and out-of-scope behavior, affected workflows, compatibility and platform constraints, data and security boundaries, failure behavior, acceptance criteria, and material risks are all explicit. If any item is missing, ambiguous, inferred rather than confirmed, or listed under Open questions, return the single most important question. When all information is sufficient, do not finish immediately: return completionQuestion and ask the human to confirm ending clarification. Only produce the requirement document after the latest human response explicitly agrees to that completion question; if the human declines or adds uncertainty, continue asking questions. The final document must contain Background, Goals, Non-goals, Functional requirements, Constraints, Acceptance criteria, Risks, Open questions, and Version history; its Open questions section must explicitly say None. Return JSON only, in exactly one of these forms:\n{"question":"..."}\n{"question":"...","options":["Recommended option","Alternative"]}\n{"completionQuestion":true}\n{"contentMarkdown":"...","acceptanceCriteria":["..."]}\n\nCommission: ${JSON.stringify({ title: input.commission.title, messages: input.messages, attachments: input.attachments, activeRequirement: input.activeRequirement })}`;
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
