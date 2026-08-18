"use client";

import { FormEvent, useEffect, useState } from "react";
import { SettingsWorkspace } from "./settings-workspace";
import { TaskWorkspace } from "./task-workspace";
import { watchSystemColorTheme } from "./theme-settings";

type Screen = "loading" | "initialize" | "login" | "settings";
type AgentHealth = { ok: boolean; version?: string; error?: string };
type RunStatus = { queued: number; active: number; waiting: number; tasks: Array<{ taskId: string; status: string; numberPath: string; title: string; description: string; projectName: string }> };
type AgentPresetSummary = { id: string; name: string };
type AgentPresetResponse = { activePresetId: string; presets: AgentPresetSummary[] };

export default function Home() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const stopWatchingTheme = watchSystemColorTheme();
    void fetch("/api/system/status").then(async (response) => {
      const status = await response.json() as { initialized: boolean; authenticated: boolean };
      setScreen(status.authenticated ? "settings" : status.initialized ? "login" : "initialize");
    }).catch(() => setMessage("无法连接本地服务。"));
    return stopWatchingTheme;
  }, []);

  async function submitPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch(screen === "initialize" ? "/api/auth/initialize" : "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: data.get("pin") })
    });
    const result = await response.json() as { error?: string; retryAfter?: number };
    if (!response.ok) return setMessage(result.retryAfter ? `请等待 ${result.retryAfter} 秒后重试。` : "PIN 不正确或格式无效。");
    form.reset();
    setScreen("settings");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setMessage("");
    setScreen("login");
  }

  if (screen === "settings") return <main className="workspace-main">
    <a className="skip-link" href="#workspace-content">跳到主要内容</a>
    <TaskWorkspace
      header={<header className="app-header">
        <div className="app-title"><div><p className="eyebrow">项目概览</p><h1>项目工作台</h1><p>管理需求、任务执行与最终交付。</p></div><AgentIndicators /></div>
        <AgentPresetSwitcher />
      </header>}
      settings={<SettingsWorkspace onLogout={logout} onPinChanged={() => { setMessage("PIN 已修改，所有旧会话均已撤销，请重新登录。"); setScreen("login"); }} />}
    />
  </main>;

  return (
    <main className="auth-main">
      <section className="panel">
        <div className="auth-brand"><img className="auth-logo" src="/brand/openworkshop-logo-256.png" width="76" height="76" alt="" aria-hidden="true" /></div>
        {screen === "loading" && <h1>正在连接…</h1>}
        {(screen === "initialize" || screen === "login") && <>
          <h1>{screen === "initialize" ? "设置访问 PIN" : "登录"}</h1>
          <p>{screen === "initialize" ? "首次使用需要设置 6 位数字 PIN。" : "输入 6 位数字 PIN 以继续。"}</p>
          <form onSubmit={submitPin}>
            <label>PIN<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete={screen === "login" ? "current-password" : "new-password"} required autoFocus /></label>
            <button type="submit">{screen === "initialize" ? "初始化" : "登录"}</button>
          </form>
        </>}
        {message && <p className="message" role="status">{message}</p>}
      </section>
    </main>
  );
}

function AgentIndicators() {
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [runs, setRuns] = useState<RunStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    const refreshHealth = () => void fetch("/api/runtime/codex-health").then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as AgentHealth;
      if (mounted) setHealth(result);
    }).catch((error: Error) => mounted && setHealth({ ok: false, error: error.message }));
    const refreshRuns = () => void fetch("/api/runtime/run-status").then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as RunStatus;
      if (mounted) setRuns(result);
    }).catch(() => mounted && setRuns(null));
    refreshHealth();
    refreshRuns();
    const healthTimer = window.setInterval(refreshHealth, 60_000);
    const runTimer = window.setInterval(refreshRuns, 3_000);
    return () => { mounted = false; window.clearInterval(healthTimer); window.clearInterval(runTimer); };
  }, []);

  const run = !runs ? { state: "unknown", label: "运行：未知" }
    : runs.waiting ? { state: "warning", label: `运行：需处理 ${runs.waiting}` }
    : runs.active ? { state: "busy", label: `运行：执行中 ${runs.active}` }
    : runs.queued ? { state: "queued", label: `运行：排队 ${runs.queued}` }
    : { state: "idle", label: "运行：空闲" };
  const healthState = health === null ? "checking" : health.ok ? "healthy" : "unhealthy";
  const healthLabel = health === null ? "健康：检查中" : health.ok ? "健康：正常" : "健康：异常";
  return <div className="agent-indicators" role="status" aria-live="polite" aria-label={`Agent ${healthLabel}，${run.label}`}>
    <span className={`agent-indicator ${healthState}`} title={health?.version ?? health?.error}><i />{healthLabel}</span>
    <div className="agent-run-indicator" tabIndex={0} aria-describedby="agent-run-summary"><span className={`agent-indicator ${run.state}`}><i />{run.label}</span><div className="agent-run-popover" id="agent-run-summary" role="tooltip"><strong>Agent 任务</strong>{runs?.tasks.length ? <ul>{runs.tasks.map((task) => <li key={task.taskId}><span><b>{task.projectName} · {task.numberPath} {task.title}</b><small>{task.status === "queued" ? "排队" : task.status === "preparing" ? "准备中" : task.status === "running" ? "运行中" : task.status === "waiting_approval" ? "等待审批" : "等待输入"}</small></span><p>{task.description || "暂无任务简介"}</p></li>)}</ul> : <p>当前没有运行、排队或等待处理的任务。</p>}</div></div>
  </div>;
}

function AgentPresetSwitcher() {
  const [settings, setSettings] = useState<AgentPresetResponse | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    void fetch("/api/settings/agents").then(async (response) => {
      if (!response.ok) throw new Error("加载预设失败");
      const result = await response.json() as AgentPresetResponse;
      if (mounted) setSettings(result);
    }).catch((error: Error) => mounted && setMessage(error.message));
    return () => { mounted = false; };
  }, []);

  async function selectPreset(presetId: string) {
    if (!settings || busy || presetId === settings.activePresetId) return;
    setMessage("");
    setBusy(true);
    try {
      const response = await fetch("/api/settings/agents/active", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ presetId }) });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        setMessage(result.error ?? "切换预设失败");
        return;
      }
      setSettings((current) => current ? { ...current, activePresetId: presetId } : current);
      window.dispatchEvent(new CustomEvent("agent-preset-changed"));
    } catch {
      setMessage("切换预设失败");
    } finally {
      setBusy(false);
    }
  }

  return <label className="agent-preset-switcher" title={message || "只影响之后创建的 Run"}>Agent 预设<select aria-label="切换 Agent 预设" disabled={!settings || busy} value={settings?.activePresetId ?? ""} onChange={(event) => void selectPreset(event.target.value)}><option value="" disabled>{message || "加载中…"}</option>{settings?.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>;
}
