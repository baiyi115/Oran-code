# Oran code

A lightweight terminal coding agent built with TypeScript.

Oran code can inspect a workspace, modify code, run development tools, manage context, and assist with everyday software engineering tasks.

## Features

- Interactive terminal interface
- Workspace file search and editing
- Shell command execution
- Permission-controlled tool calls
- Auto and Plan modes
- Conversation sessions and context compaction
- Slash commands
- Project instructions through `AGENTS.md`
- Skills and MCP extensions
- Configurable AI models

## Development

Requirements:

- Node.js 22.5+
- pnpm 10+

Install dependencies:

```bash
pnpm install
```

Start the development CLI:

```bash
pnpm dev
```

Check TypeScript:

```bash
pnpm typecheck
```

Build the project:

```bash
pnpm build
```

## Usage

Start Oran code inside a project directory:

```bash
oran
```

Use `/help` to view available commands.

Oran code stores user configuration in `~/.oran` and project state in `.oran`.

## Status

Oran code is under active development. Interfaces and configuration may change before the first stable release.

## License

Apache-2.0
