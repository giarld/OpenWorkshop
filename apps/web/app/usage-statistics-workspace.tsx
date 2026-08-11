"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenCount, formatTokenPrice } from "./task-run";
import { formatUsageDuration, usageActivityCells, usageActivityLevel, usageMonthLabels, usageSeriesLabel, type UsageRange } from "./usage-statistics";

type UsageSeries = {
  start: string;
  tokenInput: number;
  tokenOutput: number;
  tokenCached: number;
  totalTokens: number;
  runCount: number;
  taskCount: number;
  runtimeMs: number;
};

type UsageData = {
  range: UsageRange;
  generatedAt: string;
  summary: {
    totalTokens: number;
    tokenInput: number;
    tokenOutput: number;
    tokenCached: number;
    estimatedCostUsd: number | null;
    runtimeMs: number;
    taskCount: number;
    runCount: number;
  };
  series: UsageSeries[];
  activity: { startDate: string; endDate: string; days: Array<{ date: string; count: number }> };
};

const RANGE_LABELS: Record<UsageRange, string> = { "1d": "1d", "7d": "7d", "30d": "30d" };

export function UsageStatisticsWorkspace() {
  const [range, setRange] = useState<UsageRange>("7d");
  const [chart, setChart] = useState<"line" | "bar">("line");
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setData(null);
    void fetch(`/api/usage?range=${range}`, { signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `请求失败：${response.status}`);
      setData(body as UsageData);
    }).catch((reason: Error) => { if (reason.name !== "AbortError") setError(reason.message); });
    return () => controller.abort();
  }, [range]);

  const rangeSwitch = <div className="usage-range-switch" aria-label="统计时间区间">{(Object.keys(RANGE_LABELS) as UsageRange[]).map((value) => <button key={value} className={range === value ? "active" : ""} aria-pressed={range === value} onClick={() => setRange(value)}>{RANGE_LABELS[value]}</button>)}</div>;

  return <section className="usage-page">
    <header className="usage-page-header"><div><p className="eyebrow">Usage Analytics</p><h2>使用统计</h2><p>查看 Workshop 的工作活跃度、Token 消耗与任务执行规模。</p></div>{rangeSwitch}</header>
    {error && <p className="workspace-message" role="alert">{error}</p>}
    {!data ? <section className="usage-loading">正在加载使用统计…</section> : <>
      <ContributionHeatmap data={data} />
      <section className="usage-summary" aria-label={`${range} 总体用量`}>
        <UsageCard label="总 Token 消耗量" value={formatTokenCount(data.summary.totalTokens)} detail={`输入 ${formatTokenCount(data.summary.tokenInput)} · 输出 ${formatTokenCount(data.summary.tokenOutput)} · 缓存 ${formatTokenCount(data.summary.tokenCached)}`} />
        <UsageCard label="总消费" value={data.summary.estimatedCostUsd === null ? "无法完整估算" : formatTokenPrice(data.summary.estimatedCostUsd)} detail="依据 Run 固化模型与当前定价估算" />
        <UsageCard label="总任务运行时长" value={formatUsageDuration(data.summary.runtimeMs)} detail={`${formatTokenCount(data.summary.runCount)} 次 Run 累计`} />
        <UsageCard label="总任务数" value={formatTokenCount(data.summary.taskCount)} detail="区间内有 Run 的去重任务" />
      </section>
      <section className="usage-chart-panel">
        <header><div><p className="eyebrow">Token Trend</p><h3>Token 统计</h3><p>按时间桶汇总输入与输出 Token。</p></div><div className="usage-chart-switch" aria-label="图表类型"><button className={chart === "line" ? "active" : ""} aria-pressed={chart === "line"} onClick={() => setChart("line")}>折线图</button><button className={chart === "bar" ? "active" : ""} aria-pressed={chart === "bar"} onClick={() => setChart("bar")}>柱状图</button></div></header>
        <TokenChart data={data.series} range={range} kind={chart} />
        <div className="usage-chart-legend"><span><i className="total" />总 Token（输入 + 输出）</span><span>峰值 {formatTokenCount(Math.max(0, ...data.series.map((item) => item.totalTokens)))}</span></div>
      </section>
    </>}
  </section>;
}

function UsageCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="usage-card"><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function ContributionHeatmap({ data }: { data: UsageData }) {
  const cells = useMemo(() => usageActivityCells(data.activity.startDate, data.activity.days), [data.activity]);
  const maximum = Math.max(0, ...cells.map((cell) => cell.count));
  const months = usageMonthLabels(cells);
  return <section className="usage-heatmap-panel">
    <header><div><p className="eyebrow">Workshop Activity</p><h3>工作量统计</h3></div><p>最近 53 周共启动 {formatTokenCount(cells.reduce((total, cell) => total + cell.count, 0))} 次 Run</p></header>
    <div className="usage-heatmap-scroll">
      <div className="usage-heatmap-body">
        <div className="usage-weekdays"><span>周一</span><span>周三</span><span>周五</span></div>
        <div className="usage-heatmap-main">
          <div className="usage-months">{months.map((month) => <span key={`${month.week}-${month.label}`} style={{ gridColumn: month.week + 1 }}>{month.label}</span>)}</div>
          <div className="usage-heatmap-grid">{cells.map((cell) => <span key={cell.date} className={`level-${usageActivityLevel(cell.count, maximum)}`} title={`${cell.date}：${cell.count} 次 Run`} aria-label={`${cell.date}：${cell.count} 次 Run`} />)}</div>
        </div>
      </div>
    </div>
    <footer><span>{data.activity.startDate} — {data.activity.endDate}</span><span className="usage-heatmap-legend">少 <i className="level-0" /><i className="level-1" /><i className="level-2" /><i className="level-3" /><i className="level-4" /> 多</span></footer>
  </section>;
}

function TokenChart({ data, range, kind }: { data: UsageSeries[]; range: UsageRange; kind: "line" | "bar" }) {
  const width = 1_000;
  const height = 260;
  const left = 58;
  const right = 18;
  const top = 18;
  const bottom = 38;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const maximum = Math.max(1, ...data.map((item) => item.totalTokens));
  const x = (index: number) => left + (data.length === 1 ? innerWidth / 2 : index * innerWidth / Math.max(1, data.length - 1));
  const y = (value: number) => top + innerHeight - value / maximum * innerHeight;
  const path = data.map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(item.totalTokens).toFixed(2)}`).join(" ");
  const tickIndexes = [...new Set(Array.from({ length: Math.min(6, data.length) }, (_, index) => Math.round(index * (data.length - 1) / Math.max(1, Math.min(5, data.length - 1)))))];
  const barWidth = Math.max(4, Math.min(28, innerWidth / Math.max(1, data.length) * .62));
  return <div className="usage-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${range} Token ${kind === "line" ? "折线图" : "柱状图"}`}>
    {[0, .25, .5, .75, 1].map((ratio) => <g key={ratio}><line x1={left} x2={width - right} y1={y(maximum * ratio)} y2={y(maximum * ratio)} /><text x={left - 9} y={y(maximum * ratio) + 4} textAnchor="end">{compactTokens(maximum * ratio)}</text></g>)}
    {kind === "bar" ? data.map((item, index) => <rect key={item.start} x={x(index) - barWidth / 2} y={y(item.totalTokens)} width={barWidth} height={Math.max(1, top + innerHeight - y(item.totalTokens))} rx="3"><title>{usageSeriesLabel(item.start, range)}：{formatTokenCount(item.totalTokens)} Token</title></rect>) : <><path d={path} />{data.map((item, index) => <circle key={item.start} cx={x(index)} cy={y(item.totalTokens)} r="3.5"><title>{usageSeriesLabel(item.start, range)}：{formatTokenCount(item.totalTokens)} Token</title></circle>)}</>}
    {tickIndexes.map((index) => <text className="x-label" key={index} x={x(index)} y={height - 10} textAnchor="middle">{usageSeriesLabel(data[index]!.start, range)}</text>)}
  </svg></div>;
}

function compactTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Math.round(value));
}
