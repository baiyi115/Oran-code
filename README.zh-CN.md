# Oran code

[English](README.md) | [简体中文](README.zh-CN.md)

基于 TypeScript 和 React Ink 构建的轻量级终端 Coding Agent。

Oran code 能够自主探索项目代码、制定多步骤修改计划、安全执行代码修改并支持一键回滚、后台并行运行子智能体（Subagent），并支持接入 OpenAI、Anthropic、DeepSeek、Google 以及本地 Ollama 等多种大模型。

## 核心特性

### 终端交互界面 (TUI)
- **流畅的 React/Ink 渲染**：支持分屏滚动、模型思考过程实时折叠与展开、工具调用流式输出合并展示。
- **丰富的交互浮窗**：快捷斜杠命令面板（`/`）、模型选择器（`/model`）、会话管理器（`/session`）、Provider 交互式配置向导（`/connect`）。
- **Subagent 后台任务指示器**：输入框上方实时显示后台子任务名称、状态与运行耗时，底栏展示运行中子智能体数量徽章，状态变化时自动刷新重绘。

### 自主执行与安全防护
- **三种工作模式**：
  - **Auto（默认）**：交互式执行模式，危险工具调用受权限策略保护与确认拦截。
  - **Plan（规划）**：安全只读规划模式，禁止对工作区进行写操作，生成结构化步骤计划（`/plan`）。
  - **Bypass（直通）**：全自动无拦截执行模式，无需人工逐次确认。
- **Git Worktree 隔离沙箱**：可在独立的临时 Git Worktree 中执行探索或高风险修改任务，支持安全回滚与合并。
- **一键修改回滚**：自动对 Agent 执行的每一次文件修改批次进行快照，使用 `/undo` 可立即回滚最近一次修改。

### 子智能体与并行工作流
- **后台异步子任务**：可将代码检索、测试执行或架构探索委派给后台 Subagent，前台主会话不受阻塞，可继续交互。
- **团队协作机制**：支持预定义角色（如 explore, tester, reviewer），可分配独立的系统提示词、工具权限和运行环境。

### 多模型兼容与高度可扩展
- **多模型提供商**：无缝对接 OpenAI、Anthropic Claude、DeepSeek（V3 / R1）、Google Gemini、Ollama 及任意 OpenAI 兼容接口。
- **Skills 技能扩展**：支持从 `~/.oran/skills/` 或 `.oran/skills/` 动态加载自定义技能（`SKILL.md`）。
- **Model Context Protocol (MCP)**：原生支持标准 MCP 协议（stdio / SSE），轻松接入外部数据库、浏览器或自定义工具服务。
- **智能上下文管理**：内置 Token 精确估算、超限时自动上下文压缩（Compaction），以及基于 SQLite 的持久化长期记忆库。
- **项目级规则引导**：自动识别工作区中的 `AGENTS.md`，将项目的规范、约束和偏好注入到 Agent 系统提示词中。

---

## 系统架构

```
oran-code
├── Controller & Agent Loop       # 驱动智能体循环、模型流式通信与工具调用调度
├── TUI (React / Ink)             # 响应式布局、交互浮层、会话虚拟视口与状态指示器
├── Subagent Runtime              # 后台任务管理器、角色加载器与多智能体协作
├── Worktree & Snapshot System    # Git Worktree 沙箱隔离与文件修改快照回滚引擎
├── Provider Gateway              # 统一模型通信网关 (OpenAI, Anthropic, DeepSeek, Google, Ollama)
├── Tool & Permission Registry    # 核心与延迟工具注册表、Bash 终端执行与权限确认队列
├── Context & Memory Engine       # Token 估算、上下文压缩算法与 SQLite 长期记忆库
└── Extension Layer               # MCP 客户端管理、动态 Markdown 命令与 Skills 加载器
```

## 开发指引

### 环境要求
- Node.js >= 22.5
- pnpm >= 10.0

### 安装与构建

克隆仓库并安装依赖：

```bash
git clone https://github.com/your-username/oran-code.git
cd "oran-code"
pnpm install
```

启动开发模式：

```bash
pnpm dev
```

类型检查与编译构建：

```bash
pnpm typecheck
pnpm build
```

运行测试用例：

```bash
pnpm test
```

---

## 快速上手

### 启动 CLI

在任意项目或工作区目录下直接启动：

```bash
oran
```

### 快捷键

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Enter` | 提交输入或确认选中项 |
| `Shift + Enter` / `Ctrl + J` | 在输入框中换行 |
| `Up / Down` | 浏览历史输入或选择浮层列表项 |
| `Tab` | 补全斜杠命令或工作区文件路径（`@file`） |
| `Esc` | 关闭当前浮层或取消输入焦点 |
| `Ctrl + C` | 中断当前生成或退出当前会话 |

---

## 常用命令参考 (Slash Commands)

| 命令 | 功能说明 |
| :--- | :--- |
| `/help [cmd]` | 查看命令列表或指定命令的详细用法 |
| `/model` | 打开交互式模型选择浮层 |
| `/connect` | 启动交互式向导配置自定义大模型提供商 |
| `/plan` | 切换至 Plan 规划模式（只读安全探索） |
| `/undo` | 回滚 Agent 最近一次批次修改的文件 |
| `/session [id]` | 查看历史会话列表或根据 ID 切换/恢复会话 |
| `/new [name]` | 开启新的会话 |
| `/rename <name>` | 重命名当前会话 |
| `/clear` | 清理当前屏幕输出记录 |
| `/compact` | 手动触发上下文智能压缩 |
| `/status` | 显示当前 Token 用量、权限模式、工具与 MCP 连接状态 |
| `/skills` | 查看当前加载的技能列表 |
| `/memory [clear]` | 查看或清空已持久化的项目长期记忆 |
| `/exit` | 退出程序 |

---

## 配置与目录结构

Oran code 区分全局用户配置与项目级工作区配置：

### 全局配置 (`~/.oran/`)
- `~/.oran/config.json`：模型 Provider 配置、API Key、默认模型与全局偏好。
- `~/.oran/skills/`：跨项目通用的全局自定义技能。

示例 `~/.oran/config.json`：

```json
{
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "protocol": "openai-compatible",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "models": [
        {
          "id": "deepseek-chat",
          "name": "DeepSeek V3",
          "contextWindow": 64000
        },
        {
          "id": "deepseek-reasoner",
          "name": "DeepSeek R1",
          "contextWindow": 64000
        }
      ]
    }
  ],
  "defaultModel": "deepseek/deepseek-chat",
  "approvalPolicy": "ask"
}
```

### 项目工作区 (`.oran/` & `AGENTS.md`)
- `AGENTS.md`：项目特定的编码规范与安全约束，自动注入为 Agent 系统提示词。
- `.oran/sessions/`：持久化的会话历史记录。
- `.oran/memory.db`：SQLite 存储的项目知识库与长期记忆。
- `.oran/skills/`：当前项目专属的自定义技能。
- `.oran/snapshots/`：文件修改批次快照，用于 `/undo` 回滚。

---

## 项目状态

Oran code 正处于活跃迭代中。在首个稳定版本发布前，部分接口与配置格式可能会持续演进。

## 开源协议

Apache-2.0
