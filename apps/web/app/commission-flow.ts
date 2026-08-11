export type ClarificationStep = "analyze" | "reply" | "complete";
export type CommissionStage = "requirements" | "board";

export function clarificationStep(status: string, messages: Array<{ role: string }>): ClarificationStep {
  if (!['draft', 'clarifying'].includes(status)) return "complete";
  return messages.at(-1)?.role === "agent" ? "reply" : "analyze";
}

export function stageAfterAnalysis(kind: string): CommissionStage | undefined {
  return kind === "requirement" ? "requirements" : undefined;
}

export function clarificationOptions(value: unknown): string[] {
  try {
    const options = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(options) && options.length >= 2 && options.every((option) => typeof option === "string" && option.trim()) ? options : [];
  } catch { return []; }
}

export function clarificationOptionLabel(option: string, recommended: boolean): string {
  if (!recommended) return option;
  return /[\u3400-\u9fff]/u.test(option) ? `${option}（推荐）` : `${option} (Recommended)`;
}
