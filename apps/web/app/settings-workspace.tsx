"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { defaultModelLabel, defaultReasoningLabel, manualModelChoice, pickerBlurCloses, reasoningValues, visibleModels } from "./agent-picker-state";
import { AVATAR_SETTINGS_EVENT, DEFAULT_AVATARS, avatarSettings, isImageAvatar, type AvatarSettings } from "./avatar-settings";
import { applyColorTheme, COLOR_THEME_CHANGED_EVENT, COLOR_THEME_STORAGE_KEY, DEFAULT_COLOR_THEME, storedColorTheme, type ColorTheme } from "./theme-settings";

type Settings = {
  globalConcurrency: number;
  projectConcurrency: number;
  logRetentionDays: number;
  humanAvatar: string;
  agentAvatar: string;
  httpWarning: boolean;
};

type CodexModel = { id: string; displayName?: string; defaultReasoningEffort?: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>; isDefault?: boolean };
type AgentRole = "supervisor" | "developer" | "reviewer";
type AgentRolePresetConfig = { model: string | null; reasoningEffort: string | null; backendOptions: { customArgs?: string[]; [key: string]: unknown } };
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "untrusted" | "on-request" | "never";
type AgentBackend = { id: string; displayName: string };
type AgentPreset = { id: string; name: string; agentBackend: string; model: string | null; reasoningEffort: string | null; backendOptions: AgentRolePresetConfig["backendOptions"]; roleConfigs: Record<AgentRole, AgentRolePresetConfig>; sandboxMode: SandboxMode; approvalPolicy: ApprovalPolicy; networkAccess: boolean; isDefault: boolean };
type AgentHealth = { id: string; ok: boolean; runtimeVersion?: string; capabilities: { ok: boolean; models: CodexModel[]; reasoningEfforts: string[]; error?: string }; error?: string };
type AgentSettings = { health: AgentHealth; healthByBackend: Record<string, AgentHealth>; activePresetId: string; presets: AgentPreset[]; backends: AgentBackend[] };
const ROLE_LABELS: Record<AgentRole, string> = { supervisor: "项目主管 Agent", developer: "执行 Agent", reviewer: "审查 Agent" };
const ROLE_DESCRIPTIONS: Record<AgentRole, string> = { supervisor: "负责需求澄清、任务规划与执行调度协调。", developer: "负责实现任务与处理返工。", reviewer: "负责独立验证任务结果。" };
const COLOR_THEME_OPTIONS: Array<{ value: ColorTheme; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
  { value: "dark", label: "深色" }
];

export function SettingsWorkspace({ onLogout, onPinChanged }: { onLogout(): void | Promise<void>; onPinChanged(): void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pinMessage, setPinMessage] = useState("");
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [agentMessage, setAgentMessage] = useState("");
  const [avatars, setAvatars] = useState<AvatarSettings>(DEFAULT_AVATARS);
  const [colorTheme, setColorTheme] = useState<ColorTheme>(DEFAULT_COLOR_THEME);

  useEffect(() => {
    const sync = () => setColorTheme(storedColorTheme(window.localStorage.getItem(COLOR_THEME_STORAGE_KEY)));
    sync();
    document.documentElement.addEventListener(COLOR_THEME_CHANGED_EVENT, sync);
    return () => document.documentElement.removeEventListener(COLOR_THEME_CHANGED_EVENT, sync);
  }, []);

  function changeColorTheme(theme: ColorTheme) {
    setColorTheme(theme);
    window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, theme);
    applyColorTheme(theme);
  }

  function moveColorTheme(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as string[]).includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? COLOR_THEME_OPTIONS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + COLOR_THEME_OPTIONS.length) % COLOR_THEME_OPTIONS.length;
    const option = COLOR_THEME_OPTIONS[nextIndex];
    if (!option) return;
    changeColorTheme(option.value);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[nextIndex]?.focus();
  }

  useEffect(() => {
    void fetch("/api/settings").then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as Settings;
      setSettings(result);
      setAvatars(avatarSettings(result));
    }).catch((error: Error) => setMessage(`加载设置失败：${error.message}`));
  }, []);

  useEffect(() => {
    const refresh = () => void Promise.all([fetch("/api/agents/presets"), fetch("/api/agents/backends"), fetch("/api/agents/health")]).then(async ([response, backendsResponse, healthResponse]) => {
      if (!response.ok || !backendsResponse.ok || !healthResponse.ok) throw new Error(`HTTP ${response.status}`);
      const presetSettings = await response.json() as Omit<AgentSettings, "backends" | "healthByBackend">;
      const health = await healthResponse.json() as AgentHealth[];
      setAgentSettings({ ...presetSettings, backends: await backendsResponse.json() as AgentBackend[], healthByBackend: Object.fromEntries(health.map((item) => [item.id, item])) });
    }).catch((error: Error) => setAgentMessage(`加载 Agent 设置失败：${error.message}`));
    refresh();
    window.addEventListener("agent-preset-changed", refresh);
    return () => window.removeEventListener("agent-preset-changed", refresh);
  }, []);


  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalConcurrency: Number(data.get("globalConcurrency")),
          projectConcurrency: Number(data.get("projectConcurrency")),
          logRetentionDays: Number(data.get("logRetentionDays")),
          ...avatars
        })
      });
      const result = await response.json() as Settings & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSettings(result);
      const savedAvatars = avatarSettings(result);
      setAvatars(savedAvatars);
      window.dispatchEvent(new CustomEvent(AVATAR_SETTINGS_EVENT, { detail: savedAvatars }));
      setMessage("运行与头像设置已保存。");
    } catch (error) { setMessage(`保存失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function changePin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPinMessage("");
    if (data.get("newPin") !== data.get("confirmation")) return setPinMessage("两次输入的新 PIN 不一致。");
    setBusy(true);
    try {
      const response = await fetch("/api/auth/pin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPin: data.get("currentPin"), newPin: data.get("newPin") })
      });
      if (!response.ok) return setPinMessage("当前 PIN 不正确或新 PIN 格式无效。");
      form.reset();
      onPinChanged();
    } catch (error) { setPinMessage(`修改失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  return <section className="settings-page" aria-labelledby="settings-title">
    <header className="settings-page-header">
      <div><p className="eyebrow">Workspace Settings</p><h2 id="settings-title">设置</h2></div>
      <div className="settings-page-header-actions"><p>按影响范围管理工作台、项目执行与访问安全。</p><button type="button" className="secondary" onClick={() => void onLogout()}>退出登录</button></div>
    </header>

    {!settings ? <section className="settings-loading">{message || "正在加载设置…"}</section> : <>
      <form className="settings-form" onSubmit={saveSettings}>
        <section className="settings-group" aria-labelledby="appearance-settings-title">
          <header><p className="settings-level">界面级</p><h3 id="appearance-settings-title">外观</h3><p>选择当前浏览器使用的工作台配色。</p></header>
          <div className="theme-switch" role="radiogroup" aria-label="颜色主题">
            {COLOR_THEME_OPTIONS.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={colorTheme === option.value} className={colorTheme === option.value ? "active" : ""} tabIndex={colorTheme === option.value ? 0 : -1} onClick={() => changeColorTheme(option.value)} onKeyDown={(event) => moveColorTheme(event, index)}>{option.label}</button>)}
          </div>
        </section>
        <section className="settings-group" aria-labelledby="system-settings-title">
          <header><p className="settings-level">系统级</p><h3 id="system-settings-title">运行与数据</h3><p>影响整个 OpenWorkshop 实例。</p></header>
          <div className="settings-fields">
            <label>全局并发 Run 上限<input name="globalConcurrency" type="number" min={1} max={16} defaultValue={settings.globalConcurrency} required /><small>所有项目合计可同时执行的 Run 数量。</small></label>
            <label>日志保留天数<input name="logRetentionDays" type="number" min={1} max={3650} defaultValue={settings.logRetentionDays} required /><small>重启服务后，按此期限清理日志与原始命令输出。</small></label>
          </div>
        </section>
        <section className="settings-group" aria-labelledby="project-settings-title">
          <header><p className="settings-level">项目级</p><h3 id="project-settings-title">执行容量</h3><p>限制单个项目占用的执行资源。</p></header>
          <div className="settings-fields">
            <label>单项目并发 Run 上限<input name="projectConcurrency" type="number" min={1} max={8} defaultValue={settings.projectConcurrency} required /><small>每个项目可同时执行的 Run 数量。</small></label>
          </div>
        </section>
        <section className="settings-group" aria-labelledby="avatar-settings-title">
          <header><p className="settings-level">界面级</p><h3 id="avatar-settings-title">评论头像</h3><p>设置人工负责人和所有 Agent 在任务评论中的头像。</p></header>
          <div className="avatar-settings-fields">
            <AvatarSetting label="人工头像" value={avatars.humanAvatar} fallback={DEFAULT_AVATARS.humanAvatar} busy={busy} onChange={(humanAvatar) => setAvatars((current) => ({ ...current, humanAvatar }))} onError={setMessage} />
            <AvatarSetting label="Agent 头像" value={avatars.agentAvatar} fallback={DEFAULT_AVATARS.agentAvatar} busy={busy} onChange={(agentAvatar) => setAvatars((current) => ({ ...current, agentAvatar }))} onError={setMessage} />
          </div>
        </section>
        <div className="settings-actions"><p className="workspace-message" role="status">{message}</p><button disabled={busy}>保存运行与头像设置</button></div>
      </form>

      <section className="settings-group" aria-labelledby="agent-settings-title">
        <header><p className="settings-level">Agent 级</p><h3 id="agent-settings-title">Agent 预设</h3><p>创建多个独立的 Agent 执行配置，并选择当前用于新 Run 的预设。</p>{agentSettings?.health.runtimeVersion && <p>当前版本：{agentSettings.health.runtimeVersion}</p>}{agentSettings && !agentSettings.health.ok && <aside>{agentSettings.backends.find((backend) => backend.id === agentSettings.presets.find((preset) => preset.id === agentSettings.activePresetId)?.agentBackend)?.displayName ?? "Agent"} 当前不可用：{agentSettings.health.error}</aside>}</header>
        <div className="agent-settings-editor">
          {!agentSettings ? <section className="agent-preset-manager" aria-label="Agent 预设"><p>{agentMessage || "正在读取本机 Agent 设置…"}</p></section> : <AgentPresetManager key={agentSettings.activePresetId} settings={agentSettings} busy={busy} onRefresh={async () => { const [response, backendsResponse, healthResponse] = await Promise.all([fetch("/api/agents/presets"), fetch("/api/agents/backends"), fetch("/api/agents/health")]); if (!response.ok || !backendsResponse.ok || !healthResponse.ok) throw new Error("加载预设失败"); const presetSettings = await response.json() as Omit<AgentSettings, "backends" | "healthByBackend">; const health = await healthResponse.json() as AgentHealth[]; setAgentSettings({ ...presetSettings, backends: await backendsResponse.json() as AgentBackend[], healthByBackend: Object.fromEntries(health.map((item) => [item.id, item])) }); }} />}
          {agentMessage && <p className="workspace-message" role="status">{agentMessage}</p>}
        </div>
      </section>

      <section className="settings-group" aria-labelledby="security-settings-title">
        <header><p className="settings-level">安全级</p><h3 id="security-settings-title">访问凭据</h3><p>修改后会撤销所有已登录会话。</p>{settings.httpWarning && <aside>当前连接未使用 HTTPS，请只在可信本地网络中输入 PIN。</aside>}</header>
        <form className="settings-fields pin-form" onSubmit={changePin}>
          <label>当前 PIN<input name="currentPin" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="current-password" required /></label>
          <label>新 PIN<input name="newPin" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="new-password" required /></label>
          <label>确认新 PIN<input name="confirmation" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="new-password" required /></label>
          <div className="settings-actions"><p className="workspace-message" role="alert">{pinMessage}</p><button disabled={busy}>修改 PIN</button></div>
        </form>
      </section>
    </>}
  </section>;
}

function AvatarSetting({ label, value, fallback, busy, onChange, onError }: { label: string; value: string; fallback: string; busy: boolean; onChange(value: string): void; onError(message: string): void }) {
  const image = isImageAvatar(value);
  const selectFile = (file: File | undefined) => {
    if (!file) return;
    if (!(["image/png", "image/jpeg", "image/gif", "image/webp"] as string[]).includes(file.type)) return onError("头像图片仅支持 PNG、JPEG、GIF 或 WebP。");
    if (file.size > 256 * 1024) return onError("头像图片不能超过 256 KiB。");
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") { onChange(reader.result); onError(""); } };
    reader.onerror = () => onError("读取头像图片失败。");
    reader.readAsDataURL(file);
  };
  return <section className="avatar-setting">
    <div className="settings-avatar-preview" aria-label={`${label}预览`}>{image ? <img src={value} alt="" /> : <span>{value}</span>}</div>
    <div className="avatar-setting-controls">
      <label>{label}文字<input value={image ? "" : value} maxLength={32} placeholder={fallback} disabled={busy} onChange={(event) => onChange(event.target.value || fallback)} /><small>可填写 emoji 或不超过 32 个字符的短文本。</small></label>
      <label className="avatar-file">上传小图片<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} onChange={(event) => { selectFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /><small>支持 PNG、JPEG、GIF、WebP，最大 256 KiB。</small></label>
      <button type="button" className="secondary compact" disabled={busy || value === fallback} onClick={() => onChange(fallback)}>恢复默认</button>
    </div>
  </section>;
}

function ModelPicker({ value, models, capabilitiesOk, onChange, onRetry }: { value: string; models: CodexModel[]; capabilitiesOk: boolean; onChange(value: string): void; onRetry(): Promise<void> }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const optionsPointerDown = useRef(false);
  const selected = models.find((item) => item.id === value);
  const filtered = visibleModels(models, value, query);
  const manualChoice = manualModelChoice(query, filtered.length);
  const label = selected?.displayName ?? (value || defaultModelLabel(models));
  const choose = (model: string) => { onChange(model); setOpen(false); };
  const preserveOptions = () => { optionsPointerDown.current = true; setTimeout(() => { optionsPointerDown.current = false; }); };

  return <div className="agent-model-picker" onBlur={(event) => { if (pickerBlurCloses(event.currentTarget.contains(event.relatedTarget), optionsPointerDown.current)) setOpen(false); }}>
    <input role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" value={open ? query : label} placeholder="搜索或输入模型 ID" onFocus={() => { setQuery(""); setOpen(true); }} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); else if (event.key === "Enter" && query.trim()) { event.preventDefault(); choose(query.trim()); } }} />
    {open && <div id={listId} role="listbox" className="agent-model-options" onPointerDownCapture={preserveOptions}>
      {loading ? <small>正在加载…</small> : !capabilitiesOk ? <button type="button" className="secondary compact" onClick={() => { setLoading(true); void onRetry().finally(() => setLoading(false)); }}>重试</button> : <>{manualChoice && <button type="button" role="option" aria-selected={false} className="secondary compact agent-model-option" onClick={() => choose(manualChoice)}><span>使用 {manualChoice}</span></button>}{!value && <button type="button" role="option" aria-selected className="secondary compact agent-model-option" onClick={() => choose("")}><span>{defaultModelLabel(models)}</span><span aria-label="当前模型">✓</span></button>}{filtered.length ? filtered.map((item) => <button type="button" role="option" aria-selected={item.id === value} className="secondary compact agent-model-option" key={item.id} onClick={() => choose(item.id)}><span>{item.displayName ?? item.id}<small>{item.displayName ? item.id : ""}</small></span>{item.id === value ? <span aria-label="当前模型">✓</span> : null}</button>) : manualChoice ? null : <small>暂无可用模型，可输入模型 ID</small>}</>}
    </div>}
  </div>;
}

function ReasoningEffortPicker({ value, defaultValue, values, capabilitiesOk, onChange, onRetry }: { value: string; defaultValue: string | undefined; values: string[]; capabilitiesOk: boolean; onChange(value: string): void; onRetry(): Promise<void> }) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const optionsPointerDown = useRef(false);
  const choose = (effort: string) => { onChange(effort); setOpen(false); };
  const preserveOptions = () => { optionsPointerDown.current = true; setTimeout(() => { optionsPointerDown.current = false; }); };
  return <div className="agent-model-picker" onBlur={(event) => { if (pickerBlurCloses(event.currentTarget.contains(event.relatedTarget), optionsPointerDown.current)) setOpen(false); }}>
    <button type="button" className="agent-picker-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((current) => !current)}>{value || defaultReasoningLabel(defaultValue)}</button>
    {open && <div id={menuId} role="menu" className="agent-model-options" onPointerDownCapture={preserveOptions}>
      {loading ? <small>正在加载…</small> : !capabilitiesOk ? <button type="button" className="secondary compact" onClick={() => { setLoading(true); void onRetry().finally(() => setLoading(false)); }}>重试</button> : <><button type="button" role="menuitemradio" aria-checked={!value} className="secondary compact agent-model-option" onClick={() => choose("")}><span>{defaultReasoningLabel(defaultValue)}</span>{!value ? <span aria-label="当前思考强度">✓</span> : null}</button>{values.map((item) => <button type="button" role="menuitemradio" aria-checked={item === value} className="secondary compact agent-model-option" key={item} onClick={() => choose(item)}><span>{item}</span>{item === value ? <span aria-label="当前思考强度">✓</span> : null}</button>)}</>}
    </div>}
  </div>;
}

function AgentPresetManager({ settings, busy, onRefresh }: { settings: AgentSettings; busy: boolean; onRefresh(): Promise<void> }) {
  const active = settings.presets.find((item) => item.id === settings.activePresetId) ?? settings.presets[0]!;
  const [selectedId, setSelectedId] = useState(active.id);
  const [agentBackend, setAgentBackend] = useState(active.agentBackend);
  const backendHealth = settings.healthByBackend[agentBackend] ?? settings.health;
  const isClaudeCode = agentBackend === "claude-code";
  const [role, setRole] = useState<AgentRole>("supervisor");
  const [roleDrafts, setRoleDrafts] = useState<Record<AgentRole, AgentRolePresetConfig>>(() => active.roleConfigs);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState(active.name);
  const [model, setModel] = useState(active.roleConfigs.supervisor.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(active.roleConfigs.supervisor.reasoningEffort ?? "");
  const [customArgs, setCustomArgs] = useState((active.roleConfigs.supervisor.backendOptions.customArgs ?? []).join("\n"));
  const [sandboxMode, setSandboxMode] = useState(active.sandboxMode);
  const [approvalPolicy, setApprovalPolicy] = useState(active.approvalPolicy);
  const [networkAccess, setNetworkAccess] = useState(active.networkAccess);
  const models = backendHealth.capabilities.models;
  const selectedModel = model ? models.find((item) => item.id === model) : models.find((item) => item.isDefault);
  const efforts = selectedModel ? reasoningValues(selectedModel) : backendHealth.capabilities.reasoningEfforts;
  const unavailableModel = Boolean(model && !models.some((item) => item.id === model));
  const unavailableEffort = Boolean(reasoningEffort && !efforts.includes(reasoningEffort));

  function currentRoleDraft(): AgentRolePresetConfig {
    return { model: model || null, reasoningEffort: reasoningEffort || null, backendOptions: { customArgs: customArgs.split("\n").map((item) => item.trim()).filter(Boolean) } };
  }

  function loadRoleFields(config: AgentRolePresetConfig) {
    setModel(config.model ?? ""); setReasoningEffort(config.reasoningEffort ?? ""); setCustomArgs((config.backendOptions.customArgs ?? []).join("\n"));
  }

  function load(id: string) {
    const preset = settings.presets.find((item) => item.id === id) ?? active;
    const config = preset.roleConfigs[role];
    setSelectedId(preset.id); setAgentBackend(preset.agentBackend); setRoleDrafts(preset.roleConfigs); setName(preset.name); loadRoleFields(config); setSandboxMode(preset.sandboxMode); setApprovalPolicy(preset.approvalPolicy); setNetworkAccess(preset.networkAccess);
  }

  function loadRole(nextRole: AgentRole) {
    const preset = settings.presets.find((item) => item.id === selectedId) ?? active;
    const nextDrafts = { ...roleDrafts, [role]: currentRoleDraft() };
    const config = nextDrafts[nextRole] ?? preset.roleConfigs[nextRole];
    setRoleDrafts(nextDrafts); setRole(nextRole); loadRoleFields(config);
  }

  async function request(path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) { const result = await response.json() as { error?: string }; throw new Error(result.error ?? "请求失败"); }
    const result = await response.json();
    await onRefresh();
    window.dispatchEvent(new CustomEvent("agent-preset-changed"));
    return result;
  }

  async function run(action: () => Promise<unknown>, success = "") {
    setError(""); setMessage("");
    try { await action(); if (success) setMessage(success); } catch (error) { setError((error as Error).message); }
  }

  async function save() {
    const preset = settings.presets.find((item) => item.id === selectedId) ?? active;
    const roleConfig = currentRoleDraft();
    const roleConfigs = { ...roleDrafts, [role]: roleConfig };
    const primary = roleConfigs.supervisor;
    setRoleDrafts(roleConfigs);
    await request("/api/agents/presets/" + selectedId, "PUT", { name, agentBackend, model: primary.model, reasoningEffort: primary.reasoningEffort, backendOptions: primary.backendOptions, roleConfigs, sandboxMode, approvalPolicy, networkAccess });
  }

  async function create() {
    const roleConfig = currentRoleDraft();
    const roleConfigs = { ...roleDrafts, [role]: roleConfig };
    const primary = roleConfigs.supervisor;
    const created = await request("/api/agents/presets", "POST", { name: "新预设", agentBackend, model: primary.model, reasoningEffort: primary.reasoningEffort, backendOptions: primary.backendOptions, roleConfigs, sandboxMode, approvalPolicy, networkAccess }) as AgentPreset;
    const createdRoleConfig = created.roleConfigs[role];
    setSelectedId(created.id); setAgentBackend(created.agentBackend); setRoleDrafts(created.roleConfigs); setName(created.name); loadRoleFields(createdRoleConfig); setSandboxMode(created.sandboxMode); setApprovalPolicy(created.approvalPolicy); setNetworkAccess(created.networkAccess);
  }

  async function remove() {
    const index = settings.presets.findIndex((item) => item.id === selectedId);
    const next = settings.presets[index + 1] ?? settings.presets[index - 1];
    await request("/api/agents/presets/" + selectedId, "DELETE");
    if (next) load(next.id);
  }

  async function activate(id: string) { await request("/api/agents/active", "PUT", { presetId: id }); load(id); }

  return <section className="agent-preset-manager" aria-label="Agent 预设">
    <div className="preset-toolbar"><select value={selectedId} onChange={(event) => load(event.target.value)} aria-label="选择 Agent 预设">{settings.presets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.id === settings.activePresetId ? "（当前）" : ""}</option>)}</select><button type="button" className="secondary" disabled={busy} onClick={() => void run(create, "预设已创建。")}>新建预设</button><button type="button" className="danger" disabled={busy || settings.presets.length === 1 || settings.presets.find((item) => item.id === selectedId)?.isDefault} onClick={() => void run(remove, "预设已删除。")}>删除预设</button></div>
    <form className="settings-fields agent-settings-fields" onSubmit={(event) => { event.preventDefault(); void run(save, "预设已保存。"); }}>
      <label>预设名称<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required /></label>
      <label>Agent 后端<select value={agentBackend} onChange={(event) => { const next = event.target.value; const roleDefaults = { model: next === "claude-code" ? "sonnet" : null, reasoningEffort: null, backendOptions: { customArgs: [] } }; setAgentBackend(next); setRoleDrafts({ supervisor: roleDefaults, developer: roleDefaults, reviewer: roleDefaults }); setModel(roleDefaults.model ?? ""); setReasoningEffort(""); setCustomArgs(""); if (next === "claude-code") setNetworkAccess(true); }}>{settings.backends.map((backend) => <option key={backend.id} value={backend.id}>{backend.displayName}</option>)}</select><small>选择用于新 Run 的内置 Agent 后端。</small></label>
      <label>Agent 角色<select value={role} onChange={(event) => loadRole(event.target.value as AgentRole)}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>{ROLE_DESCRIPTIONS[role]}</small></label>
      <label className="agent-model-field">模型<ModelPicker value={model} models={models} capabilitiesOk={backendHealth.capabilities.ok} onChange={(value) => { setModel(value); setReasoningEffort(""); }} onRetry={onRefresh} />{unavailableModel && backendHealth.capabilities.ok && <small>自定义或当前不可发现</small>}</label>
      <label>思考强度<ReasoningEffortPicker value={reasoningEffort} defaultValue={selectedModel?.defaultReasoningEffort} values={efforts} capabilitiesOk={backendHealth.capabilities.ok} onChange={setReasoningEffort} onRetry={onRefresh} />{unavailableEffort && backendHealth.capabilities.ok && <small>当前不可发现</small>}</label>
      <label className="agent-custom-args">{settings.backends.find((backend) => backend.id === agentBackend)?.displayName ?? "Agent"} 额外参数<textarea value={customArgs} onChange={(event) => setCustomArgs(event.target.value)} rows={4} placeholder={"--enable\nfeature_name"} /><small>每行一个参数；安全边界使用上方专用字段。</small></label>
      <label>{isClaudeCode ? "权限模式" : "沙箱"}<select value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value as SandboxMode)}>{isClaudeCode ? <><option value="read-only">plan</option><option value="workspace-write">acceptEdits</option><option value="danger-full-access">bypassPermissions</option></> : <><option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="danger-full-access">danger-full-access</option></>}</select></label>
      {!isClaudeCode && <><label>审批策略<select value={approvalPolicy} onChange={(event) => setApprovalPolicy(event.target.value as ApprovalPolicy)}><option value="untrusted">untrusted</option><option value="on-request">on-request</option><option value="never">never</option></select></label><label className="agent-network-setting"><span><input type="checkbox" checked={networkAccess} disabled={sandboxMode !== "workspace-write"} onChange={(event) => setNetworkAccess(event.target.checked)} />允许工作区网络访问</span></label></>}
      <div className="settings-actions"><p className="workspace-message" role="status">{message}</p><p className="workspace-message" role="alert">{error}</p><button disabled={busy}>保存预设</button>{selectedId !== settings.activePresetId && <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => activate(selectedId), "已切换当前预设。")}>设为当前预设</button>}</div>
    </form>
  </section>;
}
