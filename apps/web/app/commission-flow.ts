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

export async function uploadClarificationAttachments(files: File[], upload: (file: File) => Promise<void>): Promise<void> {
  if (files.length > 10) throw new Error("每批最多上传 10 个附件，请重新选择。");
  let completed = 0;
  for (const file of files) {
    try { await upload(file); completed += 1; }
    catch (error) {
      throw new Error(`已上传 ${completed}/${files.length} 个附件；${file.name} 上传失败：${(error as Error).message}。请重新选择未上传的文件。`);
    }
  }
}

export function taskPlanningStatus(commission: { status: string; main_task_id: string | null; task_planning_running?: boolean }, submitting = false): string | null {
  if (submitting || commission.task_planning_running) return "正在规划任务，Agent 正在分析需求并拆分任务，可能需要几分钟，请稍候…";
  if (commission.main_task_id) return "任务已生成，可前往任务看板查看。";
  if (commission.status === "planned") return "需求已批准，但任务尚未生成，当前没有正在运行的规划。";
  return null;
}
