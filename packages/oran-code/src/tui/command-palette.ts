import { DEFAULT_COMMAND_REGISTRY, type SlashCommand } from "../commands.js";
import { highlightSelection, visibleSelection } from "./overlay/select-list.js";
import { truncateVisible, visibleWidth } from "./text-width.js";
import { ANSI } from "./theme.js";

export function commandCandidates(
  input: string,
  commands: readonly SlashCommand[] = DEFAULT_COMMAND_REGISTRY.list(),
): SlashCommand[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const query = input.slice(1).toLowerCase();
  if (!query) return [...commands];
  return (
    commands
      .map((command, index) => ({ command, index, score: commandMatchScore(command, query) }))
      .filter((entry) => entry.score > 0)
      // Built-in commands (local/ui) always outrank skill commands (prompt/isolated-skill),
      // then by match score, then by registration order.
      .sort(
        (left, right) =>
          commandKindRank(right.command) - commandKindRank(left.command) ||
          right.score - left.score ||
          left.index - right.index,
      )
      .map((entry) => entry.command)
  );
}

function commandKindRank(command: SlashCommand): number {
  return command.kind === "local" || command.kind === "ui" ? 1 : 0;
}

export function commandPaletteLines(
  input: string,
  selectedIndex: number,
  commands: readonly SlashCommand[] = DEFAULT_COMMAND_REGISTRY.list(),
  width = 120,
  maxVisible = 7,
): string[] {
  const candidates = commandCandidates(input, commands);
  const selected = Math.max(0, Math.min(Math.max(0, candidates.length - 1), selectedIndex));
  const window = visibleSelection(selected, candidates.length, maxVisible);
  const visibleCandidates = candidates.slice(window.start, window.end);
  const names = candidates.map((command) => commandDisplayName(input, command));
  const nameWidth = Math.max(1, ...names.map((name) => visibleWidth(name)));
  const descriptionWidth = Math.max(1, width - nameWidth - 5);
  const position = candidates.length > maxVisible ? ` · ${selected + 1}/${candidates.length}` : "";
  const title = truncateVisible(`Slash commands${position}`, width);
  const help = truncateVisible("Up/Down Select · Tab Complete · Enter Run · Esc Close", width);
  const lines = [`${ANSI.orangeBold}${title}${ANSI.reset}`, `${ANSI.gray}${help}${ANSI.reset}`];
  if (!visibleCandidates.length) return [...lines, "  No matching commands"];

  return [
    ...lines,
    ...visibleCandidates.map((command, localIndex) => {
      const index = window.start + localIndex;
      const displayName = names[index] ?? command.name;
      const content = `${displayName.padEnd(nameWidth, " ")}  ${truncateVisible(command.description, descriptionWidth)}`;
      if (index !== selected) return `  ${content}`;
      return `${ANSI.orangeBold}›${ANSI.reset} ${highlightSelection(content, true)}`;
    }),
  ];
}

function commandMatchScore(command: SlashCommand, query: string): number {
  const name = command.name.slice(1).toLowerCase();
  const aliases = (command.aliases ?? []).map((alias) => alias.slice(1).toLowerCase());
  if (name === query) return 500;
  if (aliases.includes(query)) return 450;
  if (name.startsWith(query)) return 400 - Math.min(100, name.length - query.length);
  if (aliases.some((alias) => alias.startsWith(query))) return 350;
  // Descriptions rank below name/alias matches so they fill in when the
  // user searches by topic (e.g. "resume" finds a command whose description mentions resumes).
  if (command.description.toLowerCase().includes(query)) return 300;
  return 0;
}

function commandDisplayName(input: string, command: SlashCommand): string {
  if (input === "/") return command.name;
  const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
  return `${command.name}${hint}`;
}
