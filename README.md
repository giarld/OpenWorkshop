# OpenWorkshop

> 面向本地软件项目的自主工程工作台：把一句委托推进为经过澄清、规划、执行、评审和人工验收的完整交付。

OpenWorkshop 将现有本地代码库、固定角色 Codex Agent 和人工决策组织成一条可追踪的工程工作流。你负责提出目标、批准需求和验收结果；系统负责整理上下文、拆分任务、调度 Agent、记录执行过程并归档交付文档。

它同时提供 Web 工作台和结构化 CLI。人可以在浏览器中查看项目与介入执行，Codex 等 Agent App 也可以通过 CLI 控制同一套工作流。

## 为什么使用 OpenWorkshop

- **本地优先**：代码、SQLite 数据库、附件和运行记录保存在自己的主机，不依赖外部项目管理服务。
- **需求先行**：Agent 先澄清范围与验收标准；只有人工批准需求后，系统才会规划和执行开发任务。
- **角色分工**：需求分析、任务规划、开发、测试/评审、项目协调和文档归档由固定角色分别承担。
- **过程可见**：实时查看 Agent 消息、工具调用、命令、文件变化、审批请求和验收证据。
- **人在回路**：高风险操作、需求版本和最终交付均保留明确的人工决策点。
- **Agent 可调用**：CLI 提供稳定的 JSON 输入输出，可从 Codex 等 Agent App 编排完整工作流。

## 工作方式

```text
关联本地项目
    ↓
提交文本与附件委托
    ↓
需求 Agent 澄清并生成需求草案
    ↓
人工批准需求
    ↓
规划 Agent 生成任务树与依赖
    ↓
开发 Agent 执行，测试/评审 Agent 独立验证
    ↓
人工验收主任务
    ↓
归档需求、计划、评审与交付文档
```

系统会识别 Git、SVN 或无版本控制项目。Git 写任务可以使用独立 Worktree 隔离；SVN 和无版本控制项目采用串行写入，避免并发修改同一工作目录。

## 产品能力

### 项目与委托

- 配置允许访问的本地根目录，阻止路径和符号链接越界。
- 关联已有项目并只读分析技术栈、版本控制、`AGENTS.md` 和常用检查命令。
- 通过文本、图片、Markdown、TXT、PDF 或 DOCX 提交独立委托。
- 在同一项目中保留多个委托及各自的需求、任务和交付记录。

### 需求与计划

- 由需求 Agent 逐轮询问目标、范围、约束和缺失信息。
- 生成版本化需求文档和验收标准，禁止静默覆盖已批准需求。
- 需求获批后自动生成主任务、任意层级子任务和依赖图。
- 支持优先级、负责人、标签、截止日期、只读任务和人工豁免。

### Agent 执行

- 通过本机 `codex app-server` 启动独立 Run，不保存 OpenAI API Key。
- Scheduler 根据依赖、审批、并发额度和项目锁决定可运行任务。
- 支持运行中介入、暂停、恢复、取消以及回答 Agent 提问。
- 对命令、文件修改、权限和高风险操作建立审批记录。
- 开发完成后由独立测试/评审 Agent 验证，失败时进入返工或阻塞。

### 验收与归档

- 汇总任务状态、Run、评审结果和证据，形成最终验收视图。
- 人工批准后关闭主任务和委托；拒绝后重新进入返工流程。
- 自动生成需求、计划、评审报告和交付文档，并保留历史版本。
- Windows 后台服务直接投递系统通知，浏览器通知作为其他平台和投递失败时的补偿；同时提供数据库备份恢复和运行日志保留机制。

## 快速开始

### 环境要求

- macOS 或 Windows
- Node.js 24+
- 已安装并登录的 Codex CLI
- 可选：Git 或 SVN，用于识别和隔离对应项目

### 安装与启动

推荐直接从 npm 全局安装：

```bash
npm install -g openworkshop
workshop skill install --agent codex
workshop start
workshop gui
```

也可以从源码安装并链接 CLI：

```bash
npm install
npm run build
npm link --workspace @workshop/server
workshop skill install --agent codex
workshop start
workshop gui
```

`npm install -g openworkshop` 会全局安装 `workshop` 命令；从源码安装时，`npm link --workspace @workshop/server` 会将当前 Workspace 中的 CLI 链接为同名全局命令。`workshop skill install --agent codex` 将配套 Skill 安装到 Codex 的个人 Skill 目录 `$HOME/.agents/skills/workshop`；省略 `--agent` 时默认使用 `codex`，已有同名目录时不会覆盖，可增加 `--force` 更新。安装后可在 Codex 中显式调用 `$workshop`，匹配 Workshop 工作流的任务也可以自动触发它。`start` 默认在后台启动服务并监听 `http://127.0.0.1:8787`；`gui` 使用系统默认浏览器打开工作台。首次访问时按照页面提示设置 6 位 PIN，然后配置允许访问的项目根目录。

前台运行或允许局域网访问：

```bash
workshop start --foreground
workshop restart --host 0.0.0.0 --port 8787
```

PIN 是面向可信局域网的基础访问控制，不等同于互联网级身份认证。请勿直接将服务暴露到公网。

## 使用 CLI 驱动工作流

以下示例使用快速开始中安装到 `PATH` 的 `workshop` 命令；未链接时，可将 `workshop` 替换为 `node apps/server/dist/cli.js`。

先登录并确认运行环境：

```bash
workshop login
workshop status --output json
workshop runtime codex-health --output json
```

创建委托并推进需求：

```bash
workshop project list --output json

workshop commission create <project-id> \
  --data '{"title":"实现导出功能","message":"支持将项目报告导出为 Markdown。"}' \
  --output json

workshop commission analyze <commission-id> --output json
workshop commission message <commission-id> \
  --data '{"content":"只导出当前委托，保留任务和评审结果。"}' \
  --output json
workshop requirement approve <requirement-id> --output json
```

触发执行并处理审批：

```bash
workshop task list <project-id> \
  --query '{"commissionId":"<commission-id>","view":"tree"}' \
  --output json

workshop task trigger <task-id> --output json
workshop task runs <task-id> --output json
workshop run events <run-id> --query '{"after":"0"}' --output json

workshop approval list \
  --query '{"status":"pending","runId":"<run-id>"}' \
  --output json
workshop approval decide <approval-id> \
  --data '{"decision":"accepted"}' \
  --output json
```

最终验收并读取交付文档：

```bash
workshop task acceptance <main-task-id> --output json
workshop task accept <main-task-id> --output json

workshop document list <project-id> \
  --query '{"commissionId":"<commission-id>","type":"delivery"}' \
  --output json
```

Codex 等 Agent 也可以跳过 Workshop 的需求澄清和规划 Agent，直接导入已经由用户确认的需求与任务计划：

```bash
workshop requirement create-approved <commission-id> \
  --data-file requirement.json \
  --output json

workshop task create <commission-id> \
  --data-file plan.json \
  --output json
```

该旁路要求 `requirement.json` 包含 `contentMarkdown` 和 `acceptanceCriteria`，`plan.json` 包含 `mainTask` 和 `tasks`。`create-approved` 会直接将需求记为已批准，仅应在用户明确要求跳过澄清并确认需求内容时使用；任务创建后不会自动触发执行。

CLI 按资源分为 `root`、`project`、`commission`、`requirement`、`task`、`run`、`approval`、`document`、`notification` 和 `runtime`。查看可用动作：

```bash
workshop --help
workshop task help
workshop run help
```

所有写操作通过 `--data` 或 `--data-file` 接收 JSON；Agent 应使用 `--output json`。尚未提供专用动作的 API 可通过通用入口调用：

```bash
workshop api GET /api/health --output json
```

远程服务可使用 `--server-url` 或 `WORKSHOP_SERVER_URL` 指定，CLI 会将本地会话与服务 Origin 绑定。

## 服务管理

| 命令 | 用途 |
| --- | --- |
| `workshop start` | 后台启动服务 |
| `workshop start --foreground` | 前台启动服务 |
| `workshop status` | 查看进程和监听地址 |
| `workshop gui` | 在默认浏览器打开工作台 |
| `workshop log [-n 100]` | 输出最新服务日志的最后若干行 |
| `workshop restart` | 优雅重启服务 |
| `workshop stop` | 优雅停止服务 |
| `workshop doctor` | 检查数据库、项目根目录、Git、Codex 和端口 |
| `workshop backup [path]` | 备份 SQLite 数据库 |
| `workshop restore <path>` | 恢复数据库，并先保存当前数据库 |
| `workshop pin set` | 修改 PIN 并撤销已有会话 |

通过 `WORKSHOP_HOME` 可覆盖应用数据目录。默认数据包括 SQLite 数据库、附件、日志、备份和运行状态；项目目录内的 `.openworkshop` 只保存 Run 的临时上下文。

## 当前范围

OpenWorkshop 目前处于 MVP 阶段，面向单个个人用户和可信本地网络：

- 仅支持 Codex CLI，不提供可配置的第三方 Agent Runtime。
- 关联已有本地目录，不负责克隆远程仓库。
- 不自动执行 Git Commit、Push、创建 Pull Request 或 SVN Commit。
- Web 界面面向桌面浏览器，当前提供简体中文。
- 服务、Runner、SQLite 和项目目录运行在同一台主机。

这些边界用于保持执行过程可控、可审计，并优先验证完整的软件交付闭环。

## 技术架构

```text
Web 工作台 / Workshop CLI
             │
        Fastify Server
        ├── REST + SSE
        ├── SQLite Store
        ├── Scheduler
        ├── Project Scanner
        ├── Document Service
        └── Codex Runner
                 │
          codex app-server
                 │
          本地项目 / Git Worktree
```

主要技术：Node.js、TypeScript、Fastify、Next.js、SQLite、Codex App Server。Server、Scheduler 和 Runner 保持为单体进程，避免为本地 MVP 引入消息队列、Redis、外部数据库或微服务运维。

## 开发验证

```bash
npm test
```

`task create/update/reorder/dependency/archive/unarchive` 等结构管理命令继续保留，但属于项目主管 Agent 级能力。CLI 命令直接执行，不额外启动 supervisor 调度；服务端会拒绝活动 Run 或待确认计划修订期间的结构修改，并递增任务树协调版本，使已经排队的 Coordinator 刷新上下文。Web 人工界面不直接提供任务结构编辑或删除；人工应在主任务评论中提出调整要求，由项目主管生成修订、经过 supervisor 审查并通过“计划修订待确认卡”确认后执行。修订中逻辑删除的任务可从任务看板筛选栏右侧的“历史任务”弹出页只读查看，不再参与调度、依赖、统计或验收。
