import React from "react";
import { Text } from "ink";
import { commandCandidates } from "./command-palette.js";
import { modelSelectorLines } from "./model-selector.js";
import { approvalDialogLines } from "./approval-dialog.js";
import { questionDialogLines } from "./question-dialog.js";
import { currentSessionLine, filterSessionOptions, sessionOptionLabel, sessionSearchLine } from "./session-list.js";
import { providersListLines } from "./providers-list.js";
import { deleteConfirmLines } from "./delete-confirm-dialog.js";
import { ANSI, dimHorizontalRule } from "./theme.js";
import { highlightSelection, overlayLine, type OverlayLine } from "./overlay/select-list.js";
import { abbreviatePath, graphemeWidth, graphemes, truncateVisible, visibleWidth } from "./text-width.js";
import { visualLines } from "./composer.js";
import { renderConnectLines } from "./connect-wizard.js";
import type { TuiState } from "./types.js";

/** Pure render helpers: take (state, width), return ANSI string lines or React fragments. */

export function oranWelcomeLines(state: TuiState, availableWidth: number): string[] {
  // The full provider/model label, as the footer shows it; the effort is its own labelled row
  // instead of being glued to the model name.
  const model = state.session.modelLabel || "(not selected)";
  const effort = state.session.reasoningEffort;
  const labelWidth = 11;
  const modelLine = `${"model:".padEnd(labelWidth)}${model}`;
  const effortLine = `${"effort:".padEnd(labelWidth)}${effort}`;
  const directoryLine = `${"directory:".padEnd(labelWidth)}${state.session.workspace}`;
  const preferredWidth = Math.max(
    48,
    visibleWidth(">_ Oran code") + 4,
    visibleWidth(modelLine) + 4,
    visibleWidth(effortLine) + 4,
    visibleWidth(directoryLine) + 4,
  );
  const cardWidth = Math.max(20, Math.min(72, availableWidth, preferredWidth));
  const contentWidth = Math.max(1, cardWidth - 4);
  const valueWidth = Math.max(1, contentWidth - labelWidth);
  const content = [
    `${ANSI.orangeBold}>_ Oran code${ANSI.reset}`,
    "",
    `${ANSI.bold}${"model:".padEnd(labelWidth)}${ANSI.reset}${truncateVisible(model, valueWidth)}`,
    `${ANSI.bold}${"effort:".padEnd(labelWidth)}${ANSI.reset}${truncateVisible(effort, valueWidth)}`,
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

export function ghostCommandSuggestion(state: TuiState, input: string): string {
  if (state.overlay.kind !== "commands" || !input.startsWith("/") || /\s/.test(input)) return "";
  const candidate = commandCandidates(input, state.commands)[0];
  if (!candidate || !candidate.name.startsWith(input) || candidate.name === input) return "";
  return candidate.name.slice(input.length);
}

export function renderOverlayLines(
  state: TuiState,
  commandLines: readonly OverlayLine[],
  width: number,
  capacity?: number,
): OverlayLine[] {
  switch (state.overlay.kind) {
    case "models": {
      const overlay = state.overlay;
      // The panel only lists; a failed load is reported on the status line like the other lists
      // (see openListOverlay), so there is no separate loading/error state to draw here.
      const lines = textLines(["Select model", dimHorizontalRule(width), "↑↓ Select   Enter Confirm   Esc Close", ""]);
      if (!overlay.options.length) lines.push(overlayLine("  (no models available)"));
      else lines.push(...modelSelectorLines(overlay.options, overlay.selectedIndex, width));
      return lines;
    }
    case "approval":
      return approvalDialogLines(
        state.overlay.approval.call,
        state.overlay.approval.level,
        state.overlay.approval.description,
        state.overlay.approval.workspace,
        state.overlay.approval.origin,
        state.overlay.selectedIndex,
        width,
        // Fitted here rather than by fitOverlayLines: its "first two lines are the header" rule does
        // not hold for this dialog and used to cut the options and the hint away.
        capacity,
      );
    case "question":
      return questionDialogLines(
        state.overlay.questions,
        state.overlay.currentQuestionIndex,
        state.overlay.selectedIndex,
        state.overlay.selectedIndices,
        width,
      );
    case "details": {
      const overlay = state.overlay;
      const lines = overlay.lines;
      // This used to show only the first capacity lines, so even the close hint was cut off; now
      // scrollOffset drives windowing, the hint stays on the first line, content starts at the
      // head by default, and it can be paged.
      const bodyHeight = Math.max(1, (capacity ?? lines.length + 3) - 3);
      const maxOffset = Math.max(0, lines.length - bodyHeight);
      // Keyboard handling clamps to the same limit (see TuiState.detailsScrollMax).
      state.detailsScrollMax = maxOffset;
      const offset = Math.max(0, Math.min(overlay.scrollOffset ?? 0, maxOffset));
      const visible = lines.slice(offset, offset + bodyHeight);
      const hint = "PageUp/PageDown/↑↓ scroll · Ctrl+T/Esc Close";
      return [
        overlayLine(overlay.title),
        overlayLine(dimHorizontalRule(width)),
        ...textLines(visible),
        overlayLine(
          lines.length > bodyHeight
            ? `${ANSI.gray}${offset + visible.length}/${lines.length} · ${hint}${ANSI.reset}`
            : hint,
        ),
      ];
    }
    case "sessions": {
      const overlay = state.overlay;
      // Same filter the key handler navigates: the stored index counts rows on screen, so both
      // sides must agree on which rows those are.
      const visible = filterSessionOptions(overlay.options, overlay.query);
      const selected = Math.min(overlay.selectedIndex, Math.max(0, visible.length - 1));
      return [
        overlayLine(currentSessionLine(overlay.options, width)),
        overlayLine(dimHorizontalRule(width)),
        overlayLine(
          listHint("Type to search   ↑↓ Select   Enter Resume   Del Remove   Esc Close", selected, visible.length),
        ),
        overlayLine(
          overlay.query
            ? sessionSearchLine(overlay.query, width)
            : `${ANSI.gray}${sessionSearchLine("", width)}${ANSI.reset}`,
        ),
        ...(visible.length
          ? visible.map((item, index) =>
              highlightSelection(`  ${sessionOptionLabel(item, Math.max(1, width - 2))}`, index === selected),
            )
          : [overlayLine("  (no matching sessions)")]),
      ];
    }
    case "delete-confirm": {
      const { target, selectedIndex } = state.overlay;
      const session = target.kind === "session";
      return deleteConfirmLines(
        session ? "Delete session?" : "Delete provider?",
        session ? target.name : target.providerName,
        selectedIndex,
        width,
      );
    }
    case "providers":
      return providersListLines(state.overlay.options, state.overlay.selectedIndex, width);
    case "follow-ups": {
      const overlay = state.overlay;
      return [
        overlayLine("Follow-ups"),
        overlayLine(dimHorizontalRule(width)),
        overlayLine(
          listHint("↑↓ Select   Enter Cancel selected   Esc Close", overlay.selectedIndex, overlay.options.length),
        ),
        overlayLine(""),
        ...(overlay.options.length
          ? overlay.options.map((item, index) =>
              highlightSelection(
                `  ${item.id}  ${truncateVisible(item.prompt.replace(/\s+/g, " ").trim(), Math.max(1, width - 2))}`,
                index === overlay.selectedIndex,
              ),
            )
          : [overlayLine("  (no queued follow-ups)")]),
      ];
    }
    case "files": {
      const overlay = state.overlay;
      return [
        overlayLine(`@${overlay.query}`),
        overlayLine(dimHorizontalRule(width)),
        overlayLine(listHint("↑↓ Select   Enter Insert   Esc Close", overlay.selectedIndex, overlay.options.length)),
        overlayLine(""),
        ...(overlay.loading && !overlay.options.length
          ? [overlayLine("  loading...")]
          : overlay.options.length
            ? overlay.options.map((item, index) =>
                highlightSelection(
                  `  ${truncateVisible(item, Math.max(1, width - 2))}`,
                  index === overlay.selectedIndex,
                ),
              )
            : [overlayLine("  (no matching files)")]),
      ];
    }
    case "commands":
      return [...commandLines];
    case "connect":
      return renderConnectLines(state.overlay, width);
    default:
      return [];
  }
}

/** Plain rows from already-rendered text (header/hint/detail lines, which are never selectable). */
function textLines(values: readonly string[]): OverlayLine[] {
  return values.map(overlayLine);
}

/** At or above this many rows a list is windowed by the frame, so it also reports the cursor position. */
const LIST_POSITION_MIN = 8;

/** Overlay hint line; long lists append "N/M" the way the command palette's title does. */
function listHint(base: string, selectedIndex: number, count: number): string {
  if (count < LIST_POSITION_MIN) return base;
  return `${base} · ${Math.min(selectedIndex + 1, count)}/${count}`;
}

export function fitOverlayLines(lines: readonly OverlayLine[], capacity: number): OverlayLine[] {
  const height = Math.max(1, Math.floor(capacity));
  if (lines.length <= height) return [...lines];
  const isSelected = (line: OverlayLine): boolean => line.selected === true;
  const activeLine = lines.findIndex(isSelected);
  if (activeLine >= 0 && height === 1) return [lines[activeLine]!];
  if (activeLine >= 0 && height === 2) return [lines[0]!, lines[activeLine]!];
  if (height === 1) return [lines[lines.length - 1]!];
  if (height === 2) return [lines[0]!, lines[lines.length - 1]!];

  // Preserve the overlay identity/help while keeping the active option visible.
  const headerHeight = Math.min(2, height - 1);
  const header = lines.slice(0, headerHeight);
  const body = lines.slice(headerHeight);
  const selectedLine = Math.max(0, body.findIndex(isSelected));
  const bodyHeight = height - header.length;
  const start = Math.max(0, Math.min(selectedLine - bodyHeight + 1, body.length - bodyHeight));
  return [...header, ...body.slice(start, start + bodyHeight)];
}

export function fileQuery(value: string, cursor: number): { query: string; start: number } | undefined {
  const before = value.slice(0, cursor);
  // Two trigger forms: @fragment and @"a spaced path (the closing quote is optional).
  const match = before.match(/(?:^|\s)@("([^"]*)"?|([^\s@]*))$/);
  if (!match || match.index === undefined) return undefined;
  return {
    query: match[2] ?? match[3] ?? "",
    start: before.lastIndexOf("@"),
  };
}

/** One overlay row: the selection is a flag on the row, not a marker parsed out of its text. */
export function OverlayRow({ line }: { line: OverlayLine }): React.JSX.Element {
  return <Text inverse={line.selected === true}>{line.text || " "}</Text>;
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

function renderComposerLineWithCaret(text: string, cursorColumn: number): React.JSX.Element {
  const symbols = graphemes(text);
  // cursorColumn is display-width based; walk cells to the caret boundary.
  let display = 0;
  let splitAt = 0;
  while (splitAt < symbols.length) {
    const symbol = symbols[splitAt] ?? "";
    // The symbol is already one grapheme: measure it directly instead of re-segmenting it.
    const width = Math.max(1, graphemeWidth(symbol));
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
