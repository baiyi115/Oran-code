# Oran code

[English](README.md) | [简体中文](README.zh-CN.md)

A lightweight, terminal-native coding agent built with TypeScript and React Ink.

Oran code inspects your codebase, plans multi-step modifications, executes edits with rollback safety, runs background subagents, and connects to any OpenAI-compatible, Anthropic, DeepSeek, Google, or local Ollama model.

## Features

### Terminal User Interface (TUI)
- **Streamlined React/Ink Interface**: Smooth transcript scrolling, live thinking process visualization, and collapsible tool groups.
- **Interactive Overlays**: Fast command palette (`/`), model picker (`/model`), session switcher (`/session`), and provider connection wizard (`/connect`).
- **Subagent Live Status Indicators**: Real-time spinner, elapsed duration, and status tracking for background tasks above the composer and in the footer chrome.

### Autonomous Execution & Safety
- **Operating Modes**:
  - **Auto**: Interactive agent loop with tool confirmation prompts.
  - **Plan**: Safe, read-only workspace inspection with structured plan generation (`/plan`).
  - **Bypass**: Direct autonomous execution without interactive confirmation prompts.
- **Git Worktree Isolation**: Run experimental subagent tasks in isolated temporary git worktrees (`enter_worktree`, `exit_worktree`).
- **One-Step Rollback**: Automatically snapshots agent file modifications; revert recent batch changes instantly with `/undo`.

### Subagents & Parallel Workflows
- **Background Subagent Execution**: Delegate long-running investigations, testing, or code exploration to background subagents while continuing interactive conversation.
- **Team Coordination**: Role definitions with custom system prompts, tool permissions, and concurrency controls.

### Model Agnostic & Extensible
- **Universal Provider Support**: Connect with OpenAI, Anthropic, DeepSeek, Google Gemini, Ollama, or custom OpenAI-compatible endpoints.
- **Skills Architecture**: Modular custom skills loaded from `~/.oran/skills/` or `.oran/skills/` via `SKILL.md`.
- **Model Context Protocol (MCP)**: Seamlessly connects to stdio/SSE MCP servers for external tool integration.
- **Context Management**: Token estimation, intelligent conversation compaction, and SQLite-backed long-term memory.
- **Project Instructions**: Automatically reads and enforces project-specific constraints defined in `AGENTS.md`.

---

## Architecture Overview

```
oran-code
├── Controller & Agent Loop       # Orchestrates turns, model streaming, and tool execution
├── TUI (React / Ink)             # Responsive layout, overlays, transcript virtualizer, status indicators
├── Subagent Runtime              # Background task manager, role loader, team coordinator
├── Worktree & Snapshot System    # Safe git worktree isolation and file rollback engine
├── Provider Gateway              # Model communication (OpenAI, Anthropic, DeepSeek, Google, Ollama)
├── Tool & Permission Registry    # Core & deferred file tools, bash execution, approval queue
├── Context & Memory Engine       # Token tracking, conversation compaction, SQLite memory store
└── Extension Layer               # MCP client manager, dynamic Markdown commands, Skills loader
```

## Development

### Prerequisites
- Node.js >= 22.5
- pnpm >= 10.0

### Setup & Build

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-username/oran-code.git
cd "oran-code"
pnpm install
```

Run in development mode:

```bash
pnpm dev
```

Typecheck and compile:

```bash
pnpm typecheck
pnpm build
```

Run tests:

```bash
pnpm test
```

---

## Usage

### Quick Start

Launch Oran code inside any workspace or project folder:

```bash
oran
```

### Interactive Keyboard Shortcuts

| Shortcut | Description |
| :--- | :--- |
| `Enter` | Submit prompt or execute command |
| `Shift + Enter` / `Ctrl + J` | Insert newline in composer |
| `Up / Down` | Navigate command/session history or overlay options |
| `Tab` | Autocomplete slash commands and file paths (`@file`) |
| `Esc` | Close active overlay or unfocus |
| `Ctrl + C` | Cancel active generation or exit session |

---

## Slash Commands Reference

| Command | Description |
| :--- | :--- |
| `/help [cmd]` | Show available commands or detailed help for a specific command |
| `/model` | Open interactive model selection overlay |
| `/connect` | Launch interactive wizard to configure custom model providers |
| `/plan` | Switch to read-only Plan mode for safe task planning |
| `/undo` | Roll back the most recent batch of file changes made by the agent |
| `/session [id]` | List previous conversation sessions or resume by ID |
| `/new [name]` | Start a fresh conversation session |
| `/rename <name>` | Rename the current session |
| `/clear` | Clear the current transcript screen |
| `/compact` | Manually trigger conversation context compaction |
| `/status` | Display token usage, active permissions, tools, and MCP status |
| `/skills` | List loaded workspace and global skills |
| `/memory [clear]` | View or reset loaded long-term memory entries |
| `/exit` | Exit the CLI session |

---

## Configuration & Directory Structure

Oran code maintains user-level global configuration and project-level workspace state:

### Global Configuration (`~/.oran/`)
- `~/.oran/config.json`: Model providers, API keys, default models, and global preferences.
- `~/.oran/skills/`: Global custom skills available across all projects.

Example `~/.oran/config.json`:

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

### Project Workspace (`.oran/` & `AGENTS.md`)
- `AGENTS.md`: Project-specific engineering guidelines, constraints, and instructions automatically injected into the agent system prompt.
- `.oran/sessions/`: Persisted conversation history for session resumption.
- `.oran/memory.db`: SQLite database storing project memory and entity knowledge.
- `.oran/skills/`: Workspace-specific custom skills.
- `.oran/snapshots/`: Local workspace file modification snapshots for rollback support.

---

## Status

Oran code is under active development. Interfaces and configuration may change before the first stable release.

## Contributing

Issues and pull requests are welcome. Please ensure that all changes pass typechecking (`pnpm typecheck`) and unit tests (`pnpm test`) before submitting.

## License

Apache-2.0
