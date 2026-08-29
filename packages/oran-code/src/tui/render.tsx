import React from "react";
import { Text } from "ink";
import { commandCandidates } from "./command-palette.js";
import { modelSelectorLines } from "./model-selector.js";
import { approvalDialogLines } from "./approval-dialog.js";
import { currentSessionLine, sessionOptionLabel } from "./session-list.js";
import { ANSI, dimHorizontalRule } from "./theme.js";
import { highlightSelection } from "./overlay/select-list.js";
import { abbreviatePath, graphemes, truncateVisible, visibleWidth } from "./text-width.js";
import { visualLines } from "./composer.js";
import { renderConnectLines } from "./connect-wizard.js";
import type { TuiState } from "./types.js";

/** 纯渲染函数集:输入 (state, width),输出 ANSI 字符串行或 React 片段。 */

export function oranWelcomeLines(state: TuiState, availableWidth: number): string[] {
  const model = welcomeModelLabel(state);
  const labelWidth = 11;
  const modelLine = `${"model:".padEnd(labelWidth)}${model}`;
  const directoryLine = `${"directory:".padEnd(labelWidth)}${state.session.workspace}`;
  const preferredWidth = Math.max(
    48,
    visibleWidth(">_ Oran code") + 4,
    visibleWidth(modelLine) + 4,
    visibleWidth(directoryLine) + 4,
  );
  const cardWidth = Math.max(20, Math.min(72, availableWidth, preferredWidth));
  const contentWidth = Math.max(1, cardWidth - 4);
  const valueWidth = Math.max(1, contentWidth - labelWidth);
  const content = [
    `${ANSI.orangeBold}>_ Oran code${ANSI.reset}`,
    "",
    `${ANSI.bold}${"model:".padEnd(labelWidth)}${ANSI.reset}${truncateVisible(model, valueWidth)}`,
    `${ANSI.bold}${"directory:".padEnd(labelWidth)}${ANSI.reset}${abbreviatePath(state.session.workspace, valueWidth)}`,
    "",
  ];
  const top = `${ANSI.gray}╭${"─".repeat(cardWidth - 2)}╮${ANSI.reset}`;
  const bottom = `${ANSI.gray}╰${"─".repeat(cardWidth - 2)}╯${ANSI.reset}`;
  const rows = content.map((line) => {
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
    return `${ANSI.gray}│${ANSI.reset} ${line}${padding} ${ANSI.gray}│${ANSI.reset}`;
  });
  return [top, ...rows, bottom];
}

function welcomeModelLabel(state: TuiState): string {
  const fullLabel = state.session.modelLabel || "(not selected)";
  if (fullLabel.startsWith("(")) return fullLabel;
  const separator = fullLabel.indexOf("/");
  const model = separator >= 0 ? fullLabel.slice(separator + 1) : fullLabel;
  return `${model} ${state.session.reasoningEffort}`;
}

export function ghostCommandSuggestion(state: TuiState, input: string): string {
  if (state.overlay.kind !== "commands" || !input.startsWith("/") || /\s/.test(input)) return "";
  const candidate = commandCandidates(input, state.commands)[0];
  if (!candidate || !candidate.name.startsWith(input) || candidate.name === input) return "";
  return candidate.name.slice(input.length);
}

export function renderOverlayLines(state: TuiState, commandLines: string[], width: number): string[] {
  switch (state.overlay.kind) {
    case "models":
      return [
        "Select model",
        dimHorizontalRule(width),
        ...modelSelectorLines(state.overlay.options, state.overlay.selectedIndex),
      ];
    case "approval":
      return approvalDialogLines(
        state.overlay.approval.call,
        state.overlay.approval.level,
        state.overlay.approval.description,
        state.overlay.approval.workspace,
        state.overlay.approval.origin,
        state.overlay.selectedIndex,
        width,
      );
    case "details":
      return [state.overlay.title, dimHorizontalRule(width), ...state.overlay.lines, "", "Ctrl+T/Esc Close"];
    case "sessions": {
      const overlay = state.overlay;
      return [
        currentSessionLine(overlay.options, width),
        dimHorizontalRule(width),
        "Enter Resume   Del Remove   Esc Close",
        "",
        ...overlay.options.map((item, index) =>
          highlightSelection(`  ${sessionOptionLabel(item, Math.max(1, width - 2))}`, index === overlay.selectedIndex),
        ),
      ];
    }
    case "session-delete-confirm": {
      const overlay = state.overlay;
      return [
        "Delete session?",
        `  ${truncateVisible(overlay.sessionName, Math.max(1, width - 2))}`,
        dimHorizontalRule(width),
        "Enter/Del Confirm   Esc Cancel",
        "",
        highlightSelection("  Delete", overlay.selectedIndex === 0),
        highlightSelection("  Cancel", overlay.selectedIndex === 1),
      ];
    }
    case "follow-ups": {
      const overlay = state.overlay;
      return [
        "Follow-ups",
        dimHorizontalRule(width),
        "Enter Cancel selected   Esc Close",
        "",
        ...(overlay.options.length
          ? overlay.options.map((item, index) =>
              highlightSelection(
                `  ${item.id}  ${truncateVisible(item.prompt.replace(/\s+/g, " ").trim(), Math.max(1, width - 2))}`,
                index === overlay.selectedIndex,
              ),
            )
          : ["  (no queued follow-ups)"]),
      ];
    }
    case "files": {
      const overlay = state.overlay;
      return [
        `@${overlay.query}`,
        dimHorizontalRule(width),
        "Enter Insert   Esc Close",
        "",
        ...(overlay.loading && !overlay.options.length
          ? ["  loading..."]
          : overlay.options.length
            ? overlay.options.map((item, index) =>
                highlightSelection(
                  `  ${truncateVisible(item, Math.max(1, width - 2))}`,
                  index === overlay.selectedIndex,
                ),
              )
            : ["  (no matching files)"]),
      ];
    }
    case "commands":
      return commandLines;
    case "connect":
      return renderConnectLines(state.overlay, width);
    default:
      return [];
  }
}

export function fitOverlayLines(lines: readonly string[], capacity: number): string[] {
  const height = Math.max(1, Math.floor(capacity));
  if (lines.length <= height) return [...lines];
  const activeLine = lines.findIndex((line) => line.includes("{inverse}"));
  if (activeLine >= 0 && height === 1) return [lines[activeLine]!];
  if (activeLine >= 0 && height === 2) return [lines[0]!, lines[activeLine]!];
  if (height === 1) return [lines[lines.length - 1]!];
  if (height === 2) return [lines[0]!, lines[lines.length - 1]!];

  // Preserve the overlay identity/help while keeping the active option visible.
  const headerHeight = Math.min(2, height - 1);
  const header = lines.slice(0, headerHeight);
  const body = lines.slice(headerHeight);
  const selectedLine = Math.max(
    0,
    body.findIndex((line) => line.includes("{inverse}")),
  );
  const bodyHeight = height - header.length;
  const start = Math.max(0, Math.min(selectedLine - bodyHeight + 1, body.length - bodyHeight));
  return [...header, ...body.slice(start, start + bodyHeight)];
}

export function fileQuery(value: string, cursor: number): { query: string; start: number } | undefined {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match || match.index === undefined) return undefined;
  return { query: match[1] ?? "", start: before.lastIndexOf("@") };
}

/** 把 {inverse} 文本标记解析成 ink 的反白 <Text>,让选择态穿过字符串渲染管线。 */
export function HighlightedLine({ value }: { value: string }): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  const pattern = /\{inverse\}([\s\S]*?)\{\/inverse\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={`t-${key++}`}>{value.slice(lastIndex, match.index)}</Text>);
    }
    parts.push(
      <Text key={`s-${key++}`} inverse>
        {match[1]}
      </Text>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) parts.push(<Text key={`t-${key}`}>{value.slice(lastIndex)}</Text>);
  if (!parts.length) return <Text> </Text>;
  return <Text>{parts}</Text>;
}

export function composerPrefix(kind: TuiState["overlay"]["kind"]): string {
  // Keep the exclusive-overlay bang only for modal overlays that own the input.
  // Commands/files still edit the free-form composer and should keep the prompt.
  return kind === "none" || kind === "commands" || kind === "files" ? "> " : kind === "connect" ? "connect> " : "! ";
}

export function renderComposerLines(
  editorLines: ReturnType<typeof visualLines>,
  cursorRow: number,
  cursorColumn: number,
  busy: boolean,
): React.JSX.Element {
  // Real terminal cursor is also parked for IME; draw an inverse cell so the caret
  // stays visibly glued to the input box even if the host cursor briefly drifts.
  // While a task is running the caret is hidden so the input line stays still.
  const lines = editorLines.length ? editorLines : [{ text: "", logicalLine: 0, startColumn: 0 }];
  const safeRow = Math.max(0, Math.min(lines.length - 1, cursorRow));
  return (
    <Text>
      {lines.map((line, index) => {
        const prefix = index === 0 ? "" : "\n  ";
        if (index !== safeRow || busy) {
          return (
            <Text key={`composer-line-${index}`}>
              {prefix}
              {line.text || " "}
            </Text>
          );
        }
        return (
          <Text key={`composer-line-${index}`}>
            {prefix}
            {renderComposerLineWithCaret(line.text, cursorColumn)}
          </Text>
        );
      })}
    </Text>
  );
}

export function renderComposerLineWithCaret(text: string, cursorColumn: number): React.JSX.Element {
  const symbols = graphemes(text);
  // cursorColumn is display-width based; walk cells to the caret boundary.
  let display = 0;
  let splitAt = 0;
  while (splitAt < symbols.length) {
    const symbol = symbols[splitAt] ?? "";
    const width = Math.max(1, visibleWidth(symbol));
    if (display + width > cursorColumn) break;
    display += width;
    splitAt += 1;
  }
  const before = symbols.slice(0, splitAt).join("");
  const active = symbols[splitAt];
  const after = symbols.slice(splitAt + (active === undefined ? 0 : 1)).join("");
  // Wide glyphs (CJK/emoji) keep a single inverse cell so the caret does not
  // jump ahead of the logical insertion point.
  return (
    <Text>
      {before}
      <Text inverse>{active ?? " "}</Text>
      {after}
    </Text>
  );
}
