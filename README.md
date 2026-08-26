# Oran code

[English](README.md) | [简体中文](README.zh-CN.md)

A lightweight, terminal-native AI coding agent in TypeScript, built for fast iteration, safe autonomous editing, and background multi-tasking.

Oran code pairs an interactive React/Ink terminal UI with a flexible agent engine: inspect codebases, generate multi-step execution plans, edit files with instant rollback snapshots, delegate subtasks in the background, and connect to DeepSeek, Claude, GPT, Gemini, or local Ollama instances.

---

## Key Highlights

- **Terminal-Native TUI**: Real-time streaming thoughts, collapsible tool outputs, and fast keyboard overlays for commands (`/`), models (`/model`), and sessions (`/session`).
- **Safety & Instant Rollback**: Automatically snapshots file changes before execution. Revert recent edits at any time with `/undo`, or run exploratory tasks in temporary Git worktrees.
- **Background Subagents**: Offload slow searches, benchmarks, and multi-file explorations to concurrent background subagents without locking your interactive prompt.
- **Universal Model Support**: Connect directly to OpenAI, Anthropic Claude, DeepSeek (V3/R1), Google Gemini, Ollama, or any custom OpenAI-compatible endpoint.
- **Extensible & Context-Aware**: Native Model Context Protocol (MCP) support, custom skills (`SKILL.md`), project guidelines (`AGENTS.md`), automated context compaction, and SQLite-backed project memory.

---

## Quickstart

### Prerequisites
- Node.js >= 22.5
- pnpm >= 10.0

### Setup

```bash
git clone https://github.com/your-username/oran-code.git
cd "oran-code"
pnpm install
```

### Running Oran

```bash
# Start in development mode
pnpm dev

# Or build and run
pnpm build
pnpm start
```

On first launch, type `/connect` to set up your model provider and API key interactively.

---

## Usage & CLI Commands

```bash
# Interactive TUI session (default)
oran

# Run a single task non-interactively
oran run "Fix the type error in src/index.ts"

# Choose a specific model or workspace
oran --model deepseek/deepseek-chat --workspace ./my-project

# Inspect active workspace tools and permissions
oran inspect

# Review past task execution traces
oran tasks
```

### Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `Enter` | Submit prompt or confirm selection |
| `Shift + Enter` / `Ctrl + J` | Multi-line input (newline) |
| `Up` / `Down` | Browse input history or navigate overlay options |
| `Tab` | Autocomplete slash commands and `@file` paths |
| `Esc` | Close active overlay / cancel focus |
| `Ctrl + C` | Cancel current generation or exit |

### Essential Slash Commands

| Command | Description |
| :--- | :--- |
| `/connect` | Interactive wizard to configure model providers & API keys |
| `/model` | Open model picker overlay to switch active model |
| `/plan` | Switch to read-only Plan mode for safe workspace exploration |
| `/undo` | Immediately revert the most recent batch of file changes |
| `/session [id]` | Switch between active sessions or resume past sessions |
| `/new` | Start a clean conversation session |
| `/status` | View token usage, active permissions, and MCP connections |
| `/compact` | Trigger manual context compaction to save tokens |
| `/clear` | Clear terminal transcript output |
| `/exit` | Exit session |

---

## Configuration

Oran code stores global settings in `~/.oran/` and workspace-specific state in `.oran/`:

### Global Config (`~/.oran/config.json`)

Configure your providers and default model:

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

### Workspace Structure (`.oran/` & `AGENTS.md`)
- `AGENTS.md`: Project-specific engineering standards, rules, and constraints automatically injected into the agent's system prompt.
- `.oran/snapshots/`: Local workspace snapshots for `/undo` rollback support.
- `.oran/sessions/`: Persisted session history and logs.
- `.oran/memory.db`: SQLite database for long-term project knowledge.
- `.oran/skills/`: Project-local custom skills (`SKILL.md`).

---

## Development & Verification

```bash
# Typecheck
pnpm typecheck

# Run unit tests
pnpm test

# Build production bundle
pnpm build
```

## License

Apache-2.0
