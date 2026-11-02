# Usage

This page is the manual: install, CLI flags, headless runs, keyboard shortcuts, slash
commands, configuration, workspace layout, and custom subagents. For what Oran is and why it
is built this way, see the [README](../README.md).

## Requirements

- Node.js >= 22.5
- pnpm >= 10.0

## Install

```bash
git clone https://github.com/baiyi115/Oran-code.git
cd "Oran-code"
pnpm install
```

Run it in development mode:

```bash
pnpm dev
```

Or build and run the compiled CLI:

```bash
pnpm build
pnpm start
```

To get a standalone `oran` command:

```bash
pnpm build
cd packages/oran-code
npm link
```

## CLI

```bash
# Interactive TUI session (default)
oran

# Run one task non-interactively
oran run "Fix the type error in src/index.ts"

# Scripted run: read the prompt from a file and write a structured JSONL event log
oran run --task prompt.md --output run.jsonl --timeout 300

# Choose a model or workspace
oran --model deepseek/deepseek-v4-flash --workspace ./my-project

# Inspect active workspace tools and permissions
oran inspect

# Review past task execution traces
oran tasks
```

### Headless runs

`oran run` is fully non-interactive and can be driven from scripts or CI:

| Flag                        | Description                                                                                              |
| :-------------------------- | :------------------------------------------------------------------------------------------------------- |
| `--task FILE`               | Reads the prompt from a file (avoids the Windows command-line length limit)                              |
| `--output FILE.jsonl`, `-o` | Writes an `oran-event/1` event log, one JSON object per line (`run_start` / `runtime_event` / `run_end`) |
| `--timeout SECONDS`         | Cancels the task after this many seconds                                                                 |

These flags are only accepted by `run`; other subcommands reject them as a usage error.

Exit codes: `0` completed, `1` failed or runtime error, `2` invalid usage, `3` timed out,
`4` cancelled otherwise. If an outer harness kills the process, the JSONL `run_end` record is
authoritative.

## Keyboard shortcuts

| Key                     | Action                                                                          |
| :---------------------- | :------------------------------------------------------------------------------ |
| `Enter`                 | Submit prompt or confirm selection                                              |
| `Ctrl + Z` / `Ctrl + Y` | Undo / redo composer edits (restores text, cursor, and pasted content)          |
| `Up` / `Down`           | Browse input history or navigate overlay options                                |
| `Tab`                   | Complete slash / `@file` overlays; toggle plan / auto work mode when idle       |
| `Shift + Tab`           | Cycle the reasoning effort (low / medium / high / xhigh)                        |
| `Ctrl + T`              | Open the latest segment's thought / tool details overlay (scrollable)           |
| `Ctrl + W`              | Delete the word before the cursor                                               |
| `Ctrl + Q`              | Manage queued follow-ups                                                        |
| `Esc`                   | Close active overlay / cancel focus (press twice while busy to cancel the task) |
| `Ctrl + C`              | Cancel current generation or exit                                               |

Multi-line prompts are composed by pasting: the paste folds into a placeholder in the
composer and is expanded back into the whole message on submit. There is no newline key —
`Shift + Enter` is indistinguishable from `Enter` unless the terminal implements a
modified-keys protocol, and a bare `Ctrl + J` cannot be told apart from the LF that some
terminals send for `Enter`.

## Slash commands

| Command                 | Description                                                  |
| :---------------------- | :----------------------------------------------------------- |
| `/connect`              | Manage model providers: list, add, edit, or remove them      |
| `/model`                | Open model picker overlay to switch active model             |
| `/plan`                 | Switch to read-only Plan mode for safe workspace exploration |
| `/undo`                 | Immediately revert the most recent batch of file changes     |
| `/rewind [N] [--files]` | Roll the conversation back to before an earlier user message |
| `/resume`               | Continue the task a progress gate paused (gate off for it)   |
| `/graph`                | Build the code dependency graph and print its summary        |
| `/session [id]`         | Switch between active sessions or resume past sessions       |
| `/new`                  | Start a clean conversation session                           |
| `/status`               | View token usage, active permissions, and MCP connections    |
| `/tasks`                | List background subagent tasks (alias `/subagents`)          |
| `/compact`              | Trigger manual context compaction to save tokens             |
| `/clear`                | Clear terminal transcript output                             |
| `/exit`                 | Exit session                                                 |

## Configuration

Oran stores global settings in `~/.oran/` and workspace-specific state in `.oran/`.

### Global config (`~/.oran/config.json`)

The easiest way to write this file is the `/connect` command — it generates the entries below
for you. Providers are keyed by name; each has connection `options` and a map of models:

```json
{
  "providers": {
    "deepseek": {
      "options": {
        "baseURL": "https://api.deepseek.com/v1",
        "protocol": "openai",
        "apiKey": "sk-..."
      },
      "models": {
        "deepseek-v4-flash": {
          "options": { "reasoningEffort": "high", "context_window": 128000 }
        }
      }
    }
  },
  "agent": { "lastModel": "deepseek/deepseek-v4-flash" }
}
```

- `protocol` is `"openai"` (OpenAI-compatible Chat Completions) or `"anthropic"` (Anthropic
  Messages). Endpoints that reject the `reasoning_effort` parameter are handled
  automatically: Oran retries without it once and remembers per model via
  `disableReasoningEffort`.
- `agent.lastModel` remembers the model picked via `/model` or `/connect`; pass
  `--model provider/model` to override it for one run.
- `trustWorkspace` (default `false`) lets the **workspace's** `.oran/config.json` and
  `.oran/hooks.local.yaml` set things that raise permissions or run commands:
  `agent.approveAll`, `agent.permissionMode`, `agent.noProgressLimit`, `mcpServers`, `hooks`,
  and `web.allowPrivateHosts`. These keys are ignored from a workspace file unless this is
  `true` (the values it does not drop, such as `agent.maxSteps` or `web.searchProvider`,
  still apply), and the agent says which keys it ignored. It is off by default because the
  agent is normally started inside the repository it is asked about; enable it only for
  workspaces you control.

### Workspace layout (`.oran/` and `AGENTS.md`)

- `AGENTS.md`: project-specific engineering standards, rules, and constraints automatically
  injected into the agent's system prompt.
- `.oran/snapshots/`: local workspace snapshots for `/undo` rollback support.
- `.oran/sessions/`: persisted session history and logs.
- `~/.oran/memory/<workspace-hash>/`: Markdown notes curated by the agent for long-term
  project knowledge (stored next to sessions and traces, outside the workspace).
- `.oran/skills/`: project-local custom skills (`SKILL.md`).

### Custom subagents (`agents/*.md`)

Subagents are Markdown files with YAML frontmatter; the body below the frontmatter is the
subagent's prompt. Three built-in roles ship by default: `general` (bounded implementation
tasks), `plan` (read-only planning), and `explore` (read-only exploration). Add your own at:

- `~/.oran/agents/*.md`: available in every workspace.
- `.oran/agents/*.md`: project-specific, overrides a user-level definition of the same name.

```markdown
---
name: reviewer
description: Review recent changes for correctness and style.
allowedTools: [list_files, read_file, glob_files, search_code]
permissionMode: plan
---

You are a code review subagent. Inspect recent changes and report concrete findings.
```

Supported frontmatter keys: `name`, `description`, `allowedTools`, `deniedTools`, `model`
(provider/model override), `maxSteps`, `permissionMode`, `forceBackground`, and `isolation`
(`shared-workspace` or `worktree` for a disposable Git worktree).
