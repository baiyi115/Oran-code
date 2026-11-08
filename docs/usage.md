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

`run_end.tokens` combines the main task and delegated subagents (`total` = input + output).
`run_end.mainTokens` and `run_end.subagentTokens` break the same counters down, so cost can be
attributed without replaying `runtime_event` lines. `steps`, `toolCalls` and `tools` describe the
main task only.

## Permission modes

Choose a mode with `/permission MODE`, `--permission-mode MODE`, or the user-level `agent.permissionMode` setting. In the input area, **Shift+Tab** cycles **Auto → Accept edit → Plan → Bypass permission → Auto**, including when command or file completion is open. **Tab** only accepts a completion and does nothing when no completion is open. The footer shows the active permission mode first.

During a running task, Shift+Tab cycles the execution modes and skips Plan, with an on-screen explanation. A running Plan task must finish or be cancelled before leaving Plan. Approval and other modal dialogs keep their own key handling. Switching to Bypass shows that ordinary approvals are skipped; explicit rules still apply.

The four modes are:

| Mode                         | Behavior                                                                                                                                                                                             |
| :--------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` — Auto (default)      | Read-only operations pass local checks. Other operations receive an independent review by the task's current model, using a separate prompt with no tools. The reviewer may allow, deny, or ask you. |
| `accept-edits` — Accept edit | Automatically accepts local file edits. Other operations require human approval, except recognized read-only commands.                                                                               |
| `plan` — Plan                | Exposes read-only tools and `write_plan`. Only the designated writer can create plan files inside `.oran/plans`; source edits and shell commands are blocked.                                        |
| `bypass` — Bypass permission | Skips ordinary approval prompts. Explicit deny/ask rules, dangerous-command checks, tool visibility and filesystem access checks still apply.                                                        |

`--accept-edits` / `-a` and `--approve-all` / `-y` remain aliases. Only one permission flag may be supplied. Explicit command-line mode selection overrides the configured mode. Legacy `default` values load as `auto`; legacy `readonly` values load as `plan`.

Auto reviews include the current user request, steering guidance, workspace and complete tool arguments. They do not append reviewer messages to the execution conversation. Context over 48,000 characters, a 45-second timeout, truncated output, or an invalid response falls back to human approval. Review usage is included in task token totals and emitted as `permission_review` events. Reviews grant only the current call and never save rules. Non-interactive runs reject calls that still require human approval.

Approval choices show the rule being granted: **Allow once** (the default), **Allow rule for this task**, **Save rule for this project**, or **Reject**. Task rules expire with the task; saved rules go to `.oran/permissions.local.yaml`. Press `v` to inspect full redacted details. Plain terminal input also accepts `y` (once), `t` (task), `a` (save), and `n` (reject).

Rules in `~/.oran/permissions.yaml`, `.oran/permissions.yaml` and `.oran/permissions.local.yaml` support `allow`, `ask`, and `deny`. Deny wins across all files and task grants; ask then requires human confirmation even in Auto or Bypass. Plan restrictions and tool access boundaries cannot be expanded by an allow rule. Unreadable or malformed rule files block execution until corrected.

```yaml
allow:
  - read_file(src/**)
ask:
  - run_command(git push*)
deny:
  - read_file(.env)
```

Allow glob rules do not cover compound commands; use an exact allow rule for a command containing shell operators. Deny and ask glob rules still apply to the full compound command. Subagents inherit the parent approval ceiling and tool visibility; a role cannot switch itself to Bypass under Auto or Accept edit. These are application checks, not an operating-system sandbox for arbitrary shell code.

The design draws on [Claude Code's permission modes](https://code.claude.com/docs/en/permission-modes), [Codex's separate approval and sandbox policies](https://github.com/openai/codex/blob/main/codex-rs/core/src/safety.rs), [OpenCode's allow/ask/deny rules](https://opencode.ai/docs/permissions), and pi's local permission-gate extension. pi extensions run with the process's OS permissions; its example gate is not an equivalent four-mode permission system.

## Keyboard shortcuts

| Key                     | Action                                                                           |
| :---------------------- | :------------------------------------------------------------------------------- |
| `Enter`                 | Submit prompt or confirm selection                                               |
| `Ctrl + Z` / `Ctrl + Y` | Undo / redo composer edits (restores text, cursor, and pasted content)           |
| `Up` / `Down`           | Browse input history or navigate overlay options                                 |
| `Tab`                   | Complete slash commands or `@file` paths; never changes mode                     |
| `Shift + Tab`           | Cycle Auto → Accept edit → Plan → Bypass permission (Plan skipped while busy)    |
| `Ctrl + R`              | Cycle the reasoning effort while idle                                            |
| `Ctrl + O`              | Open expanded transcript details, including earlier tools and diffs (scrollable) |
| `Ctrl + T`              | Open the latest segment's thought / tool details overlay (scrollable)            |
| `Ctrl + W`              | Delete the word before the cursor                                                |
| `Ctrl + Q`              | Manage queued follow-ups                                                         |
| `Esc`                   | Close active overlay / cancel focus (press twice while busy to cancel the task)  |
| `Ctrl + C`              | Cancel current generation or exit                                                |

User messages have a shaded background, and assistant replies and tools share a left marker.
Successful read/search activity is grouped into a muted summary naming the operations.
Commands and file changes remain individual: output has a short preview, and edits show
change counts plus up to eight diff rows with hunk line numbers and colored backgrounds.
`Ctrl + O` opens expanded transcript details without rewriting terminal scrollback;
`Ctrl + T` opens only the latest activity. These views are snapshots taken when opened.
Tool output details retain up to 400 source lines (head and final line for failures),
and diff details retain up to 400 diff source lines; tool-side truncation still applies.

Multi-line prompts are composed by pasting: the paste folds into a placeholder in the
composer and is expanded back into the whole message on submit. There is no newline key —
`Shift + Enter` is indistinguishable from `Enter` unless the terminal implements a
modified-keys protocol, and a bare `Ctrl + J` cannot be told apart from the LF that some
terminals send for `Enter`.

## Slash commands

| Command                 | Description                                                                |
| :---------------------- | :------------------------------------------------------------------------- |
| `/connect [PROVIDER]`   | Add a provider or edit its models, context, output, and reasoning settings |
| `/model`                | Open model picker overlay to switch active model                           |
| `/permission MODE`      | Choose auto, accept-edits, plan, or bypass                                 |
| `/plan`                 | Switch to read-only Plan mode for safe workspace exploration               |
| `/undo`                 | Immediately revert the most recent batch of file changes                   |
| `/rewind [N] [--files]` | Roll the conversation back to before an earlier user message               |
| `/resume`               | Continue the task a progress gate paused (gate off for it)                 |
| `/graph`                | Build the code dependency graph and print its summary                      |
| `/session [id]`         | Switch between active sessions or resume past sessions                     |
| `/new`                  | Start a clean conversation session                                         |
| `/status`               | View token usage, active permissions, and MCP connections                  |
| `/tasks`                | List background subagent tasks (alias `/subagents`)                        |
| `/compact`              | Trigger manual context compaction to save tokens                           |
| `/clear`                | Clear terminal transcript output                                           |
| `/exit`                 | Exit session                                                               |

## Configuration

Oran stores global settings in `~/.oran/` and workspace-specific state in `.oran/`.

Use `/connect` inside the interactive CLI to list, add, edit, or remove providers; use
`/connect PROVIDER` to open an existing provider directly. Enter the base URL and protocol,
then select models. The model screen offers `F` to fetch IDs and reported context limits from
the endpoint, or `A` to add an ID manually when listing is unavailable. Fetching again keeps
all locally configured models and their explicit settings. Use `Enter` to select a model,
`C` to set its context window, `M` to set its maximum output tokens, and `E` to cycle its
reasoning effort through default (medium), low, medium, high, xhigh, and off. `B` returns
to connection details, and `Ctrl+S` or `Tab` saves. Leave a token-limit editor empty to
return to the provider/runtime default. The wizard keeps your edits if fetching or saving
fails. `Ctrl+R` changes effort only in the current session; use `/connect` to save a
per-model setting for later sessions.

A new provider is saved in the user config. Editing an existing provider writes to the
configuration layer displayed in the wizard (which can be a workspace `.oran/config.json`);
check that path before entering an API key, since project files may be version-controlled.
An edit refreshes the active model's configuration without switching away from it; if that
model was removed, the first selected model becomes active.

### Global config (`~/.oran/config.json`)

`/connect` creates these entries; you can also edit the JSON directly:

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
          "options": { "reasoningEffort": "high", "context_window": 128000, "maxTokens": 8192 }
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
  `true` (the values it does not drop, such as `web.searchProvider`, still apply), and the agent says which keys it ignored. It is off by default because the
  agent is normally started inside the repository it is asked about; enable it only for
  workspaces you control.

### 提示缓存

Oran 的请求前缀保持只增不改，便于服务端复用缓存。每个任务的工作区状态保存在
该任务的用户消息中：保留历史状态会占用少量上下文 token，但删除早期状态会破坏其后
对话的缓存前缀。

- OpenAI 兼容端点默认依赖服务端自动前缀缓存。可选的 `options.prompt_cache_key`
  会作为 `prompt_cache_key` 随请求发送，供支持该参数的服务端（如 OpenAI 的提示缓存
  与部分兼容网关）稳定命中；默认不发送，避免严格端点拒绝未知参数。DeepSeek 返回的
  `prompt_cache_hit_tokens` 也会计入缓存读取统计。
- Anthropic 端点会在工具列表尾部、最后一个可缓存的 system 块和最近对话上设置
  `cache_control` 断点，合计不超过 4 个。可选的 `options.anthropicCacheTtl: "1h"`
  将长期前缀断点（工具和 system）的缓存有效期从默认 5 分钟延长到 1 小时，适合间隔
  较长的多轮任务；逐轮对话断点仍使用默认有效期。

### Task token usage

Oran records cumulative task and session usage for statistics; **cumulative token
usage does not stop a task**. These totals include replayed context, cache hits and
Auto permission reviews. A task total can therefore exceed the model's context window
without filling the current request. The footer's `ctx` percentage tracks that current
context separately; automatic context compaction remains active.

The former cumulative task token budget setting has been removed. Existing values
in configuration files are ignored. Tasks paused by older versions remain resumable
with `/resume`. `/compact` reduces future request context but does not reset usage
already counted; `/clear` only clears the terminal transcript.

Main tasks and subagents have no fixed model-iteration limit. Former iteration-limit
settings in configuration and agent definitions are ignored. Repeated-call, repeated-error
and no-progress detection remain enabled, and tasks can be cancelled manually. Provider
context and output limits still apply.

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
(provider/model override), `permissionMode`, `forceBackground`, and `isolation`
(`shared-workspace` or `worktree` for a disposable Git worktree).

### Subagent collaboration

The main agent delegates with `agent` and can attach an explicit `task_contract`
(`objective`, `boundaries`, `done_when`). Synchronous calls return their result directly.
Background calls and team members stay reachable while they run:

- `task_send` sends guidance to a running or queued task. Guidance is delivered before the
  child's next model turn and is never treated as user authorization.
- `task_messages` shows each message's `queued`, `delivered`, or `undeliverable` status.
- `report_to_parent` lets a background subagent or teammate report `progress`, `blocked`,
  `question`, or `result`. A `question` waits for guidance by default (60 seconds,
  configurable with `wait_seconds` up to 300) and returns the guidance in the same call.

Messages are capped at 4,000 characters, with at most 16 pending per task and direction.
Guidance that never reaches a task before it ends is marked `undeliverable` and reported
to the parent; reports are injected into the parent's next model request.
