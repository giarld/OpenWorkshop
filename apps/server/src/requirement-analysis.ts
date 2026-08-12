export const CLARIFICATION_COMPLETION_QUESTION = "需求信息已经足够。是否确认结束需求澄清并生成需求文档？";

export type ParsedRequirementAnalysis = { question: string; options?: string[] } | { completionQuestion: true } | { contentMarkdown: string; acceptanceCriteria: unknown[] };

export function parseRequirementAnalysis(output: string): ParsedRequirementAnalysis {
  const json = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1] ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  let value: unknown;
  try { value = JSON.parse(json); }
  catch (error) { throw badGateway("Requirement Agent returned invalid JSON", error); }
  if (!value || typeof value !== "object") throw badGateway("Requirement Agent returned invalid output");
  const result = value as Record<string, unknown>;
  if (typeof result.question === "string" && result.question.trim()) {
    const options = parseOptions(result.options);
    return options ? { question: result.question.trim(), options } : { question: result.question.trim() };
  }
  if (result.completionQuestion === true) return { completionQuestion: true };
  if (typeof result.contentMarkdown === "string" && result.contentMarkdown.trim() && Array.isArray(result.acceptanceCriteria)) {
    const contentMarkdown = result.contentMarkdown.trim();
    const openQuestion = firstOpenQuestion(contentMarkdown);
    return openQuestion ? { question: openQuestion } : { contentMarkdown, acceptanceCriteria: result.acceptanceCriteria };
  }
  throw badGateway("Requirement Agent returned an unsupported result");
}

function parseOptions(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) throw badGateway("Requirement Agent returned invalid question options");
  const options = value.map((option) => typeof option === "string" ? option.trim() : "");
  if (options.some((option) => !option) || new Set(options).size !== options.length) throw badGateway("Requirement Agent returned invalid question options");
  return options;
}

export function completionWasConfirmed(messages: Array<{ role: string; content: string }>): boolean {
  const proposal = messages.findLastIndex((message) => message.role === "agent" && message.content === CLARIFICATION_COMPLETION_QUESTION);
  return proposal >= 0 && messages.slice(proposal + 1).some((message) => message.role === "human");
}

export function requirementProgress(event: { type: string }): string | undefined {
  if (event.type === "command_execution.started") return "正在执行只读项目检查";
  if (event.type === "command_execution.completed") return "已完成一项项目检查";
  if (event.type === "agent.message.delta") return "正在组织澄清问题";
  if (event.type === "token.usage") return "正在更新 Token 使用量";
  return undefined;
}

function firstOpenQuestion(markdown: string): string | undefined {
  const section = /^##\s+(?:Open questions|未决问题)\s*$([\s\S]*?)(?=^##\s+)/im.exec(`${markdown}\n## __end__`)?.[1]?.trim();
  if (!section) return undefined;
  const question = /^\s*[-*]\s+(.+)$/m.exec(section)?.[1]?.trim() ?? section.split("\n", 1)[0]?.trim();
  return question && !/^(?:none|n\/a|无|暂无|无未决问题)[。.]*$/i.test(question) ? question : undefined;
}

function badGateway(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { statusCode: 502 });
}
