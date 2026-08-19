"use client";

import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { AVATAR_SETTINGS_EVENT, DEFAULT_AVATARS, avatarSettings, isImageAvatar, type AvatarSettings } from "./avatar-settings";
import { applyColorTheme, COLOR_THEME_STORAGE_KEY, DEFAULT_COLOR_THEME, storedColorTheme, type ColorTheme } from "./theme-settings";

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
type AgentRolePresetConfig = { model: string | null; reasoningEffort: string | null; customArgs: string[] };
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "untrusted" | "on-request" | "never";
type AgentPreset = { id: string; name: string; agentBackend: "codex"; model: string | null; reasoningEffort: string | null; customArgs: string[]; roleConfigs: Record<AgentRole, AgentRolePresetConfig>; sandboxMode: SandboxMode; approvalPolicy: ApprovalPolicy; networkAccess: boolean; isDefault: boolean };
type AgentSettings = { health: { ok: boolean; version?: string; models?: CodexModel[]; error?: string }; activePresetId: string; presets: AgentPreset[] };
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
    setColorTheme(storedColorTheme(window.localStorage.getItem(COLOR_THEME_STORAGE_KEY)));
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
    const refresh = () => void fetch("/api/settings/agents").then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAgentSettings(await response.json() as AgentSettings);
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
        <header><p className="settings-level">Agent 级</p><h3 id="agent-settings-title">Agent 预设</h3><p>创建多个独立的 Agent 执行配置，并选择当前用于新 Run 的预设。</p>{agentSettings?.health.version && <p>当前版本：{agentSettings.health.version}</p>}{agentSettings && !agentSettings.health.ok && <aside>Codex 当前不可用：{agentSettings.health.error}</aside>}</header>
        <div className="agent-settings-editor">
          {!agentSettings ? <p>{agentMessage || "正在读取本机 Codex 模型…"}</p> : <AgentPresetManager key={agentSettings.activePresetId} settings={agentSettings} busy={busy} onRefresh={async () => { const response = await fetch("/api/settings/agents"); if (!response.ok) throw new Error("加载预设失败"); setAgentSettings(await response.json() as AgentSettings); }} />}
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


function AgentPresetManager({ settings, busy, onRefresh }: { settings: AgentSettings; busy: boolean; onRefresh(): Promise<void> }) {
  const active = settings.presets.find((item) => item.id === settings.activePresetId) ?? settings.presets[0]!;
  const [selectedId, setSelectedId] = useState(active.id);
  const [role, setRole] = useState<AgentRole>("supervisor");
  const [roleDrafts, setRoleDrafts] = useState<Record<AgentRole, AgentRolePresetConfig>>(() => active.roleConfigs);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState(active.name);
  const [model, setModel] = useState(active.roleConfigs.supervisor.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(active.roleConfigs.supervisor.reasoningEffort ?? "");
  const [customArgs, setCustomArgs] = useState(active.roleConfigs.supervisor.customArgs.join("\n"));
  const [sandboxMode, setSandboxMode] = useState(active.sandboxMode);
  const [approvalPolicy, setApprovalPolicy] = useState(active.approvalPolicy);
  const [networkAccess, setNetworkAccess] = useState(active.networkAccess);
  const models = settings.health.models ?? [];
  const selectedModel = models.find((item) => item.id === model) ?? models.find((item) => item.isDefault);
  const unavailableModel = Boolean(model && !models.some((item) => item.id === model));
  const unavailableEffort = Boolean(reasoningEffort && !selectedModel?.supportedReasoningEfforts?.some((item) => item.reasoningEffort === reasoningEffort));

  function currentRoleDraft(): AgentRolePresetConfig {
    return { model: model || null, reasoningEffort: reasoningEffort || null, customArgs: customArgs.split("\n").map((item) => item.trim()).filter(Boolean) };
  }

  function loadRoleFields(config: AgentRolePresetConfig) {
    setModel(config.model ?? ""); setReasoningEffort(config.reasoningEffort ?? ""); setCustomArgs(config.customArgs.join("\n"));
  }

  function load(id: string) {
    const preset = settings.presets.find((item) => item.id === id) ?? active;
    const config = preset.roleConfigs[role];
    setSelectedId(preset.id); setRoleDrafts(preset.roleConfigs); setName(preset.name); loadRoleFields(config); setSandboxMode(preset.sandboxMode); setApprovalPolicy(preset.approvalPolicy); setNetworkAccess(preset.networkAccess);
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
    setRoleDrafts(roleConfigs);
    await request("/api/settings/agents/presets/" + selectedId, "PUT", { name, agentBackend: "codex", model: roleConfig.model, reasoningEffort: roleConfig.reasoningEffort, customArgs: roleConfig.customArgs, roleConfigs, sandboxMode, approvalPolicy, networkAccess });
  }

  async function create() {
    const roleConfig = currentRoleDraft();
    const roleConfigs = { ...roleDrafts, [role]: roleConfig };
    const created = await request("/api/settings/agents/presets", "POST", { name: "新预设", agentBackend: "codex", model: roleConfig.model, reasoningEffort: roleConfig.reasoningEffort, customArgs: roleConfig.customArgs, roleConfigs, sandboxMode, approvalPolicy, networkAccess }) as AgentPreset;
    const createdRoleConfig = created.roleConfigs[role];
    setSelectedId(created.id); setRoleDrafts(created.roleConfigs); setName(created.name); loadRoleFields(createdRoleConfig); setSandboxMode(created.sandboxMode); setApprovalPolicy(created.approvalPolicy); setNetworkAccess(created.networkAccess);
  }

  async function remove() {
    const index = settings.presets.findIndex((item) => item.id === selectedId);
    const next = settings.presets[index + 1] ?? settings.presets[index - 1];
    await request("/api/settings/agents/presets/" + selectedId, "DELETE");
    if (next) load(next.id);
  }

  async function activate(id: string) { await request("/api/settings/agents/active", "PUT", { presetId: id }); load(id); }

  return <section className="agent-preset-manager" aria-label="Agent 预设">
    <div className="preset-toolbar"><select value={selectedId} onChange={(event) => load(event.target.value)} aria-label="选择 Agent 预设">{settings.presets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.id === settings.activePresetId ? "（当前）" : ""}</option>)}</select><button type="button" className="secondary" disabled={busy} onClick={() => void run(create, "预设已创建。")}>新建预设</button><button type="button" className="danger" disabled={busy || settings.presets.length === 1 || settings.presets.find((item) => item.id === selectedId)?.isDefault} onClick={() => void run(remove, "预设已删除。")}>删除预设</button></div>
    <form className="settings-fields agent-settings-fields" onSubmit={(event) => { event.preventDefault(); void run(save, "预设已保存。"); }}>
      <label>预设名称<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required /></label>
      <label>Agent 后端<select value="codex" disabled><option value="codex">Codex</option></select><small>当前仅支持 Codex。</small></label>
      <label>Agent 角色<select value={role} onChange={(event) => loadRole(event.target.value as AgentRole)}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>{ROLE_DESCRIPTIONS[role]}</small></label>
      <label>模型<select value={model} onChange={(event) => { setModel(event.target.value); setReasoningEffort(""); }}><option value="">跟随 Codex 默认</option>{unavailableModel && <option value={model}>当前配置不可用 · {model}</option>}{models.map((item) => <option key={item.id} value={item.id}>{item.displayName ? item.displayName + " · " + item.id : item.id}</option>)}</select></label>
      <label>思考强度<select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}><option value="">模型默认{selectedModel?.defaultReasoningEffort ? "（" + selectedModel.defaultReasoningEffort + "）" : ""}</option>{unavailableEffort && <option value={reasoningEffort}>当前配置不可用 · {reasoningEffort}</option>}{(selectedModel?.supportedReasoningEfforts ?? []).map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</option>)}</select></label>
      <label className="agent-custom-args">Codex 额外参数<textarea value={customArgs} onChange={(event) => setCustomArgs(event.target.value)} rows={4} placeholder={"--enable\nfeature_name"} /><small>每行一个参数；安全边界使用上方专用字段。</small></label>
      <label>沙箱<select value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value as SandboxMode)}><option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="danger-full-access">danger-full-access</option></select></label>
      <label>审批策略<select value={approvalPolicy} onChange={(event) => setApprovalPolicy(event.target.value as ApprovalPolicy)}><option value="untrusted">untrusted</option><option value="on-request">on-request</option><option value="never">never</option></select></label>
      <label className="agent-network-setting"><span><input type="checkbox" checked={networkAccess} disabled={sandboxMode !== "workspace-write"} onChange={(event) => setNetworkAccess(event.target.checked)} />允许工作区网络访问</span></label>
      <div className="settings-actions"><p className="workspace-message" role="status">{message}</p><p className="workspace-message" role="alert">{error}</p><button disabled={busy}>保存预设</button>{selectedId !== settings.activePresetId && <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => activate(selectedId), "已切换当前预设。")}>设为当前预设</button>}</div>
    </form>
  </section>;
}
