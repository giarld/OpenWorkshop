export type AgentModelOption = { id: string; displayName?: string; defaultReasoningEffort?: string; isDefault?: boolean };

export function defaultModelLabel(models: readonly AgentModelOption[]): string {
  const id = models.find((item) => item.isDefault)?.id;
  return `Codex默认${id ? `(${id})` : ""}`;
}

export function defaultReasoningLabel(effort?: string): string {
  return `系统默认${effort ? `(${effort})` : ""}`;
}

export function visibleModels(models: readonly AgentModelOption[], value: string, query: string): AgentModelOption[] {
  const selected = models.find((item) => item.id === value);
  const current = value && !selected ? { id: value } : selected;
  const normalized = query.trim().toLocaleLowerCase();
  return [...(current ? [current] : []), ...models.filter((item) => item.id !== current?.id)]
    .filter((item) => !normalized || item.id.toLocaleLowerCase().includes(normalized) || item.displayName?.toLocaleLowerCase().includes(normalized));
}

export function reasoningValues(model?: { supportedReasoningEfforts?: Array<{ reasoningEffort: string }> }): string[] {
  return model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [];
}

export function pickerBlurCloses(relatedTargetInside: boolean, optionsPointerDown: boolean): boolean {
  return !relatedTargetInside && !optionsPointerDown;
}

export function manualModelChoice(query: string, matchCount: number): string | undefined {
  const value = query.trim();
  return value && matchCount === 0 ? value : undefined;
}
