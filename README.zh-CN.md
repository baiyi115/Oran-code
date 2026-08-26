# Oran code

[English](README.md) | [简体中文](README.zh-CN.md)

基于 TypeScript 构建的轻量级终端 AI 编程助手，专为快速编码、安全修改和后台多任务协作而设计。

Oran code 结合了基于 React Ink 的终端交互界面与灵活的 Agent 调度引擎：能够自主探索项目代码、生成多步骤修改计划、通过快照提供一键安全回滚、在后台并发执行子任务（Subagent），并支持接入 DeepSeek、Claude、GPT、Gemini 及本地 Ollama 等多种大模型。

---

## 核心特性

- **终端交互界面 (TUI)**：基于 React Ink 构建，支持模型思考流式展示、工具调用折叠，以及 `/` 命令面板、`/model` 模型切换器与 `/session` 会话管理等浮层。
- **安全执行与一键回滚**：Agent 执行文件修改前自动记录快照，输入 `/undo` 即可立即恢复；支持在独立的临时 Git Worktree 沙箱中运行探索性修改。
- **后台子智能体 (Subagent)**：可将耗时较长的代码检索、测试执行或架构探索交给后台并行处理，不阻塞前台终端主交互。
- **通用模型接入**：原生支持 OpenAI、Anthropic Claude、DeepSeek（V3 / R1）、Google Gemini、Ollama 及任意 OpenAI 兼容接口。
- **高可扩展性与上下文管理**：支持标准 MCP（Model Context Protocol）协议、自定义技能（`SKILL.md`）、项目级规范注入（`AGENTS.md`）、自动上下文压缩与 SQLite 长期记忆库。

---

## 快速上手

### 环境要求
- Node.js >= 22.5
- pnpm >= 10.0

### 安装与运行

```bash
# 克隆仓库并安装依赖
git clone https://github.com/your-username/oran-code.git
cd "oran-code"
pnpm install

# 以开发模式启动
pnpm dev

# 或者编译后运行
pnpm build
pnpm start
```

首次启动后，输入 `/connect` 可通过交互式向导配置模型 Provider 与 API Key。

---

## CLI 命令与使用

```bash
# 启动交互式 TUI 会话（默认）
oran

# 单次执行任务（非交互模式）
oran run "修复 src/index.ts 中的类型错误"

# 指定模型或工作区目录
oran --model deepseek/deepseek-chat --workspace ./my-project

# 查看当前工作区支持的工具与权限
oran inspect

# 查看历史任务执行记录
oran tasks
```

### 终端快捷键

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Enter` | 提交输入或确认选中项 |
| `Shift + Enter` / `Ctrl + J` | 输入框换行（多行输入） |
| `Up` / `Down` | 浏览历史输入或选择浮层列表项 |
| `Tab` | 自动补全斜杠命令与 `@file` 文件路径 |
| `Esc` | 关闭当前浮层 / 取消焦点 |
| `Ctrl + C` | 中断当前生成或退出当前会话 |

### 常用命令 (Slash Commands)

| 命令 | 功能说明 |
| :--- | :--- |
| `/connect` | 启动交互式向导配置模型提供商与 API Key |
| `/model` | 打开模型选择器快速切换模型 |
| `/plan` | 切换至 Plan 规划模式（只读安全探索） |
| `/undo` | 一键回滚 Agent 最近一次修改的文件批次 |
| `/session [id]` | 查看或恢复历史会话 |
| `/new` | 开启一个全新的对话会话 |
| `/status` | 显示当前 Token 用量、权限模式与 MCP 状态 |
| `/compact` | 手动触发上下文智能压缩以节省 Token |
| `/clear` | 清理终端屏幕记录 |
| `/exit` | 退出程序 |

---

## 配置与目录结构

Oran code 将全局用户配置存储于 `~/.oran/`，将项目工作区状态存储于 `.oran/`：

### 全局配置 (`~/.oran/config.json`)

用于配置模型 Provider、API Key 及默认模型：

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
        { "id": "deepseek-chat", "name": "DeepSeek V3", "contextWindow": 64000 },
        { "id": "deepseek-reasoner", "name": "DeepSeek R1", "contextWindow": 64000 }
      ]
    }
  ],
  "defaultModel": "deepseek/deepseek-chat"
}
```

### 项目工作区结构 (`.oran/` & `AGENTS.md`)
- `AGENTS.md`：项目专属的开发规范与安全约束，自动注入到 Agent 系统提示词中。
- `.oran/snapshots/`：本地文件修改快照，支持 `/undo` 安全回滚。
- `.oran/sessions/`：会话历史记录与执行日志。
- `.oran/memory.db`：SQLite 存储的项目知识库与长期记忆。
- `.oran/skills/`：项目专属自定义技能（`SKILL.md`）。

---

## 开发与验证

```bash
# 类型检查
pnpm typecheck

# 运行单元测试
pnpm test

# 生产构建
pnpm build
```

## 开源协议

Apache-2.0
