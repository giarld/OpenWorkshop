type JsonObject = Record<string, unknown>;

const HIDDEN = "[REDACTED]";
const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|pin|password|secret|token|(?:[a-z0-9]+[_-])*(?:api[_-]?key|token|secret|password|pin))$/i;
const SENSITIVE_TEXT = [
  /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
  /\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|token|secret|password|pin)\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,;}]+)/gi,
  /\b((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi,
  /(\b)(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16})\b/g
];

export function redactSensitive<T>(value: T, explicitSecrets: readonly string[] = []): { value: T; redacted: boolean } {
  let redacted = false;

  const visit = (item: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) {
      redacted = true;
      return HIDDEN;
    }
    if (typeof item === "string") {
      let output = item;
      for (const pattern of SENSITIVE_TEXT) output = output.replace(pattern, `$1${HIDDEN}`);
      for (const secret of explicitSecrets) if (secret) output = output.replaceAll(secret, HIDDEN);
      if (output !== item) redacted = true;
      return output;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
    return item;
  };

  return { value: visit(value) as T, redacted };
}

export function configuredSecrets(settings: JsonObject, env = process.env): string[] {
  const names = settings.sensitiveEnvironmentVariables;
  return Array.isArray(names) ? names.flatMap((name) => typeof name === "string" && env[name] ? [env[name]] : []) : [];
}

export type NormalizedCommand = { executable: string; arguments: string[]; command: string };

export function normalizeCommands(payload: JsonObject): NormalizedCommand[] {
  const rawCommands: unknown[] = [payload.command ?? payload.cmd];
  if (Array.isArray(payload.commandActions)) {
    for (const action of payload.commandActions) {
      if (typeof action === "string" || Array.isArray(action)) rawCommands.push(action);
      else if (action && typeof action === "object") rawCommands.push((action as JsonObject).command ?? (action as JsonObject).cmd);
    }
  }
  return rawCommands.flatMap(normalizeCommand).filter((command) => command.executable);
}

export function isHighRiskCommand(payload: JsonObject): boolean {
  return normalizeCommands(payload).some(({ executable, arguments: args, command }) => {
    const name = executable.split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase();
    const text = command.toLowerCase();
    const flags = args.filter((part) => part.startsWith("-")).join("").toLowerCase();
    return name === "rm" && (flags.includes("r") || text.includes("--recursive")) && (flags.includes("f") || text.includes("--force"))
      || /\bremove-item\b[^\r\n]*(?:^|\s)-recurse\b/i.test(text)
      || /\b(?:del|erase|rmdir|rd)\b[^\r\n]*\/(?:s|q)\b/i.test(text)
      || /\b(?:format|shutdown|reboot)\b/i.test(text)
      || /\btaskkill\b[^\r\n]*\/f\b/i.test(text)
      || /\bgit\s+(?:reset\s+--hard|clean\s+-(?=[a-z]*f)[a-z]*d)/i.test(text)
      || /\b(?:drop\s+(?:database|table)|truncate\s+table)\b/i.test(text);
  });
}

function normalizeCommand(raw: unknown): NormalizedCommand[] {
  const parts = (Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? tokenize(raw) : []).filter(Boolean);
  if (!parts.length) return [];
  const shell = parts[0]!.split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase();
  const marker = shell === "cmd" ? parts.findIndex((part) => part.toLowerCase() === "/c")
    : ["powershell", "pwsh"].includes(shell) ? parts.findIndex((part) => ["-command", "-c"].includes(part.toLowerCase()))
    : ["bash", "sh", "zsh"].includes(shell) ? parts.findIndex((part) => /^-[a-z]*c[a-z]*$/i.test(part))
    : -1;
  if (marker >= 0 && parts[marker + 1]) return normalizeCommand(parts.slice(marker + 1).join(" "));
  return [{ executable: parts[0]!, arguments: parts.slice(1), command: parts.join(" ") }];
}

function tokenize(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}
