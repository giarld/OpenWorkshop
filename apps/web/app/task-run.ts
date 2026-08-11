export type RunEvent = { id: number; event_type: string; summary: string; payload: Record<string, unknown>; created_at: string };
export type RunQuestion = { id: string; header: string; question: string; options: Array<{ label: string; description: string }> };
export type ThreadedComment = { id: string; parent_id: string | null };
export type TaskMentionPart = string | { numberPath: string; label: string };
export type CommentMentionPart = string | { kind: "task"; numberPath: string; label: string } | { kind: "role"; label: string };
export type MentionTrigger = { start: number; query: string };
export type CodeChange = { id: string; path: string; kind: string; movePath: string | null; diff: string; event: RunEvent };
export type DiffLine = { text: string; kind: "add" | "remove" | "hunk" | "context" };
export type TokenUsageSource = { token_input: number | null; token_output: number | null; token_cached: number | null; configSnapshot?: { model?: string } };

const TOKEN_PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.6-sol": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 }
};
export type ReviewFinding = { severity: "blocking" | "warning"; file: string | null; line: number | null; message: string };

export function runEventDetail(event: RunEvent): string {
  const payload = event.payload;
  if (event.event_type === "agent.message.delta") return textValue(payload.delta);
  if (event.event_type === "human.message") return detail([["消息", payload.message]]);
  if (event.event_type === "input.requested") return runQuestions(event).map((question) => [question.header || question.question, question.header && question.question !== question.header ? question.question : "", question.options.length ? `选项：${question.options.map((option) => option.label).join(" / ")}` : ""].filter(Boolean).join("\n")).join("\n\n");
  if (event.event_type === "input.resolved") return inputAnswers(payload.answers);
  if (event.event_type === "approval.resolved") return detail([["决定", payload.decision], ["说明", payload.details]]);
  if (event.event_type === "approval.requested") return detail([["命令", payload.command], ["目录", payload.cwd], ["原因", payload.reason], ["权限", payload.permissions]]);
  if (event.event_type === "command.output") return textValue(payload.delta ?? payload.output);

  const item = objectValue(payload.item);
  if (event.event_type.includes("command")) return detail([["命令", item?.command ?? payload.command], ["目录", item?.cwd ?? payload.cwd], ["退出码", item?.exitCode ?? item?.exit_code ?? payload.exitCode], ["耗时", item?.durationMs ?? item?.duration_ms], ["输出", item?.aggregatedOutput ?? item?.output ?? payload.output], ["错误", item?.error ?? payload.error]]);
  if (event.event_type.includes("tool")) return detail([["工具", item?.tool ?? item?.name ?? payload.tool], ["服务", item?.server ?? payload.server], ["参数", item?.arguments ?? item?.args ?? payload.arguments], ["结果", item?.result ?? payload.result], ["错误", item?.error ?? payload.error]]);
  if (event.event_type === "error" || event.event_type.includes(".error") || event.event_type.includes("failed") || (event.event_type === "run.status" && payload.status === "failed")) return detail([["错误", objectValue(payload.error)?.message ?? payload.error ?? payload.summary ?? event.summary]]);
  return "";
}

export function isLongRunEventDetail(detail: string): boolean {
  return detail.length > 180 || detail.split("\n").length > 3;
}

export function formatRunDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

export function tokenUsageTotals(runs: TokenUsageSource[]): { total: number; input: number; output: number; cached: number } | null {
  if (!runs.some((run) => [run.token_input, run.token_output, run.token_cached].some((value) => typeof value === "number"))) return null;
  const input = runs.reduce((sum, run) => sum + (run.token_input ?? 0), 0);
  const output = runs.reduce((sum, run) => sum + (run.token_output ?? 0), 0);
  const cached = runs.reduce((sum, run) => sum + (run.token_cached ?? 0), 0);
  return { total: input + output, input, output, cached };
}

export function tokenPrice(runs: TokenUsageSource[]): number | null {
  const used = runs.filter((run) => [run.token_input, run.token_output, run.token_cached].some((value) => typeof value === "number"));
  if (!used.length) return null;
  let dollars = 0;
  for (const run of used) {
    const price = run.configSnapshot?.model ? TOKEN_PRICES[run.configSnapshot.model] : undefined;
    if (!price) return null;
    const input = run.token_input ?? 0;
    const cached = Math.min(input, run.token_cached ?? 0);
    dollars += ((input - cached) * price.input + cached * price.cached + (run.token_output ?? 0) * price.output) / 1_000_000;
  }
  return dollars;
}

export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatTokenPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

export function parseReviewComment(content: string): { markdown: string; findings: ReviewFinding[] } | null {
  const findings: ReviewFinding[] = [];
  const lines = content.split(/\r?\n/).filter((line) => {
    const candidate = line.trim().replace(/^-\s+/, "");
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) return true;
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>;
      if (!['blocking', 'warning'].includes(String(value.severity)) || typeof value.message !== "string") return true;
      findings.push({ severity: value.severity as ReviewFinding["severity"], file: typeof value.file === "string" ? value.file : null, line: typeof value.line === "number" ? value.line : null, message: value.message });
      return false;
    } catch { return true; }
  });
  if (!findings.length) return null;
  return { markdown: lines.filter((line) => !/^#{0,6}\s*发现\s*$/.test(line.trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim(), findings };
}

export function runTimelineEvents(events: RunEvent[]): RunEvent[] {
  const timeline: RunEvent[] = [];
  for (const event of events) {
    if (event.event_type === "token.usage") continue;
    const previous = timeline.at(-1);
    if (["agent.message.delta", "command.output"].includes(event.event_type) && previous?.event_type === event.event_type && sameStreamItem(previous, event)) {
      const key = event.event_type === "agent.message.delta" ? "delta" : typeof previous.payload.delta === "string" || typeof event.payload.delta === "string" ? "delta" : "output";
      timeline[timeline.length - 1] = { ...previous, payload: { ...previous.payload, [key]: runEventDetail(previous) + runEventDetail(event) } };
    } else timeline.push(event);
  }
  return timeline;
}

export function runCodeChanges(events: RunEvent[]): CodeChange[] {
  const changes = new Map<string, CodeChange>();
  for (const event of events) {
    if (!event.event_type.includes("file_change")) continue;
    const item = objectValue(event.payload.item);
    const entries = Array.isArray(item?.changes) ? item.changes : [];
    for (const entry of entries) {
      const change = objectValue(entry);
      const path = typeof change?.path === "string" ? change.path : "";
      if (!path || hiddenWorkshopPath(path)) continue;
      const kind = objectValue(change?.kind);
      changes.delete(path);
      changes.set(path, {
        id: `${String(item?.id ?? event.id)}:${path}`,
        path,
        kind: typeof kind?.type === "string" ? kind.type : typeof change?.kind === "string" ? change.kind : "update",
        movePath: typeof kind?.move_path === "string" ? kind.move_path : null,
        diff: typeof change?.diff === "string" ? change.diff : "",
        event
      });
    }
  }
  return [...changes.values()].reverse();
}

function hiddenWorkshopPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const match = /(^|\/)\.openworkshop(?:\/|$)/.exec(normalized);
  return Boolean(match) && !normalized.slice((match?.index ?? 0) + (match?.[1]?.length ?? 0)).startsWith(".openworkshop/worktrees/");
}

export function diffLines(diff: string): DiffLine[] {
  return diff.split(/\r?\n/).map((text) => ({
    text,
    kind: text.startsWith("@@") ? "hunk" : text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "remove" : "context"
  }));
}

export function commentThreadRows<T extends ThreadedComment>(comments: T[]): Array<{ comment: T; depth: number }> {
  const ids = new Set(comments.map((comment) => comment.id));
  const children = new Map<string | null, T[]>();
  for (const comment of comments) {
    const parent = comment.parent_id && ids.has(comment.parent_id) ? comment.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), comment]);
  }
  const rows: Array<{ comment: T; depth: number }> = [];
  const visit = (parent: string | null, depth: number) => {
    for (const comment of children.get(parent) ?? []) {
      rows.push({ comment, depth });
      visit(comment.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

export function taskMentionParts(content: string): TaskMentionPart[] {
  const parts: TaskMentionPart[] = [];
  let cursor = 0;
  for (const match of content.matchAll(/@任务(\d+(?:\.\d+)*)/g)) {
    if (match.index! > cursor) parts.push(content.slice(cursor, match.index));
    parts.push({ numberPath: match[1]!, label: match[0] });
    cursor = match.index! + match[0].length;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return parts.length ? parts : [content];
}

export function commentMentionParts(content: string): CommentMentionPart[] {
  const parts: CommentMentionPart[] = [];
  let cursor = 0;
  for (const match of content.matchAll(/@任务(\d+(?:\.\d+)*)|@Agent\b|@负责人/gi)) {
    if (match.index! > cursor) parts.push(content.slice(cursor, match.index));
    parts.push(match[1] ? { kind: "task", numberPath: match[1], label: match[0] } : { kind: "role", label: match[0] });
    cursor = match.index! + match[0].length;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return parts.length ? parts : [content];
}

export function commentLinkUrl(href: string | undefined): string | undefined {
  return href && /^https?:\/\//i.test(href) ? href : undefined;
}

export function mentionTriggerAtCursor(content: string, cursor: number): MentionTrigger | null {
  const match = content.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
  return match ? { start: cursor - match[1]!.length - 1, query: match[1]! } : null;
}

export function insertMention(content: string, trigger: MentionTrigger, cursor: number, mention: string): { content: string; cursor: number } {
  const prefix = content.slice(0, trigger.start);
  const suffix = content.slice(cursor).replace(/^ /, "");
  const next = `${prefix}${mention} ${suffix}`;
  return { content: next, cursor: prefix.length + mention.length + 1 };
}

function sameStreamItem(left: RunEvent, right: RunEvent): boolean {
  const leftId = left.payload.itemId ?? left.payload.item_id;
  const rightId = right.payload.itemId ?? right.payload.item_id;
  return leftId === undefined || rightId === undefined || leftId === rightId;
}

function inputAnswers(value: unknown): string {
  const answers = objectValue(value);
  return answers ? Object.entries(answers).map(([id, answer]) => `${id}：${Array.isArray(objectValue(answer)?.answers) ? (objectValue(answer)!.answers as unknown[]).map(textValue).filter(Boolean).join("、") : textValue(answer)}`).join("\n") : "";
}

function detail(entries: Array<[string, unknown]>): string {
  return clipDetail(entries.flatMap(([label, value]) => {
    const text = textValue(value);
    return text ? [`${label}：${text}`] : [];
  }).join("\n"));
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function clipDetail(value: string): string {
  return value.length > 4_000 ? `${value.slice(0, 4_000)}\n…内容已截断` : value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function runQuestions(event?: RunEvent): RunQuestion[] {
  const questions = Array.isArray(event?.payload.questions) ? event.payload.questions : [];
  return questions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const question = value as Record<string, unknown>;
    const id = typeof question.id === "string" ? question.id : "";
    if (!id) return [];
    const options = Array.isArray(question.options) ? question.options.flatMap((option) => option && typeof option === "object" && typeof (option as Record<string, unknown>).label === "string" ? [{ label: String((option as Record<string, unknown>).label), description: String((option as Record<string, unknown>).description ?? "") }] : []) : [];
    return [{ id, header: String(question.header ?? ""), question: String(question.question ?? "请输入所需信息"), options }];
  });
}
