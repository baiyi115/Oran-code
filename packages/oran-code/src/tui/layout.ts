import blessed from "blessed";
import type { Widgets } from "blessed";
import { horizontalRule, lineStyle, textStyle } from "./theme.js";
import { TranscriptView, type TranscriptRenderLine } from "./transcript/transcript-view.js";
import { syncTranscriptScroll, transcriptViewportLines } from "./scroll-controller.js";
import { currentSessionLine, sessionOptionLabel } from "./session-list.js";
export { transcriptViewportLines } from "./scroll-controller.js";
import type { FollowUpOption, SessionOption, TuiState } from "./types.js";
import { composerValue } from "./state.js";
import { approvalDialogLines } from "./approval-dialog.js";
import { commandPaletteLines } from "./command-palette.js";
import { modelSelectorLines } from "./model-selector.js";
import { cursorVisualPosition, visualLines } from "./composer.js";
import { footerLines } from "./footer.js";
import { renderTerminalFrame, TerminalWriter, type TerminalCursorPosition } from "./terminal-writer.js";
import { highlightSelection } from "./overlay/select-list.js";
import { truncateVisible, visibleWidth } from "./text-width.js";

export interface TuiLayoutNodes {
  readonly viewport: Widgets.BoxElement;
  readonly inputTopRule: Widgets.TextElement;
  readonly inputBox: Widgets.TextElement;
  readonly inputBottomRule: Widgets.TextElement;
  readonly status: Widgets.TextElement;
  readonly overlay: Widgets.TextElement;
}

export interface TuiLayout {
  readonly nodes: TuiLayoutNodes;
  redraw(state: TuiState): void;
  scrollTranscript(state: TuiState, delta: number): void;
  captureTranscriptAnchor(state: TuiState): void;
  destroy(): void;
}

export interface TuiLayoutRows {
  viewportTop: number;
  viewportHeight: number;
  inputTop: number;
  inputRow: number;
  inputBottom: number;
  statusTop: number;
  statusHeight: number;
}

export function createTuiLayout(screen: Widgets.Screen): TuiLayout {
  const terminal = new TerminalWriter(screen);
  const transcript = new TranscriptView();
  let destroyed = false;
  let lastTranscriptLines: TranscriptRenderLine[] = [];
  let lastTranscriptViewportLines = 1;
  const viewport = blessed.box({
    parent: screen,
    top: 0,
    left: 1,
    width: "100%-2",
    height: "100%-4",
    style: textStyle(),
  });
  const inputTopRule = blessed.text({
    parent: screen,
    top: "100%-4",
    left: 0,
    width: "100%",
    height: 1,
    style: lineStyle(),
  });
  const inputBox = blessed.text({
    parent: screen,
    top: "100%-3",
    left: 1,
    width: "100%-2",
    height: 1,
    style: textStyle(),
  });
  const inputBottomRule = blessed.text({
    parent: screen,
    top: "100%-2",
    left: 0,
    width: "100%",
    height: 1,
    style: lineStyle(),
  });
  const status = blessed.text({
    parent: screen,
    top: "100%-2",
    left: 1,
    width: "100%-2",
    height: 2,
    tags: true,
    style: textStyle(),
  });
  const overlay = blessed.text({
    parent: screen,
    top: 0,
    left: 1,
    width: "100%-2",
    height: 1,
    hidden: true,
    tags: true,
    style: textStyle(),
  });

  const nodes: TuiLayoutNodes = { viewport, inputTopRule, inputBox, inputBottomRule, status, overlay };
  return {
    nodes,
    redraw(state) {
      if (destroyed) return;
      const terminalWidth = Math.max(1, screen.cols);
      const contentWidth = Math.max(1, terminalWidth - 2);
      const editorWidth = Math.max(1, contentWidth - 2);
      const editorLines = visualLines(state.composer, editorWidth);
      const composerHeight = Math.max(1, Math.min(6, editorLines.length, Math.max(1, screen.rows - 4)));
      const rows = calculateLayoutRows(screen.rows, composerHeight);
      const overlayLines = renderOverlay(state, terminalWidth);
      const availableOverlayHeight = Math.max(0, rows.inputTop - rows.viewportTop);
      const selectedLine = selectedOverlayLine(state, overlayLines);
      const visibleLines = overlayLines.length && availableOverlayHeight > 0
        ? visibleOverlayLines(overlayLines, Math.max(1, availableOverlayHeight), selectedLine)
        : [];
      const overlayTop = visibleLines.length ? Math.max(rows.viewportTop, rows.inputTop - visibleLines.length) : rows.inputTop;

      viewport.top = rows.viewportTop;
      viewport.height = Math.max(0, overlayTop - rows.viewportTop);
      const transcriptLines = transcript.linesWithAnchors(state, contentWidth);
      const viewportLines = Math.max(1, Number(viewport.height) || 1);
      const maximumOffset = Math.max(0, transcriptLines.length - viewportLines);
      const anchor = state.transcriptScroll.anchor;
      if (anchor && !state.transcriptScroll.followBottom) {
        const anchoredLine = transcriptLines.findIndex((line) => line.messageId === anchor.messageId && line.lineOffset === anchor.lineOffset);
        if (anchoredLine >= 0) state.transcriptScroll.offsetFromBottom = Math.max(0, maximumOffset - anchoredLine);
      }
      syncTranscriptScroll(state.transcriptScroll, transcriptLines.length, viewportLines, state.lastTranscriptLines);
      state.lastTranscriptLines = transcriptLines.length;
      state.lastTranscriptViewportLines = viewportLines;
      lastTranscriptLines = transcriptLines;
      lastTranscriptViewportLines = viewportLines;
      const visibleTranscript = transcriptViewportLines(
        transcriptLines.map((line) => line.text),
        viewportLines,
        state.transcriptScroll.offsetFromBottom,
      );
      // Keep scrolling in TUI state. Blessed's scrollable box maintains a
      // second childBase/childOffset state that can desynchronize after the
      // transcript grows or its height changes, leaving blank rows behind.
      // setContent preserves SGR styles such as the bold assistant marker.
      viewport.setContent(visibleTranscript.join("\n"));

      inputTopRule.top = rows.inputTop;
      inputBox.top = rows.inputRow;
      inputBox.height = Math.max(1, rows.inputBottom - rows.inputRow);
      inputBottomRule.top = rows.inputBottom;
      status.top = rows.statusTop;
      status.height = rows.statusHeight;
      inputTopRule.setText(horizontalRule(terminalWidth));
      inputBottomRule.setText(horizontalRule(terminalWidth));
      if (rows.inputTop < rows.inputRow) inputTopRule.show();
      else inputTopRule.hide();
      if (rows.inputBottom > rows.inputRow && rows.inputBottom < terminalRows(screen)) inputBottomRule.show();
      else inputBottomRule.hide();
      if (rows.statusHeight > 0) status.show();
      else status.hide();
      const cursor = cursorVisualPosition(state.composer, editorWidth);
      const editorStart = Math.max(0, Math.min(
        Math.max(0, editorLines.length - composerHeight),
        cursor.row - composerHeight + 1,
      ));
      const visibleEditorLines = editorLines.slice(editorStart, editorStart + composerHeight);
      inputBox.setText(visibleEditorLines.map((line, index) => `${index === 0 ? ">" : " "} ${line.text}`).join("\n"));
      status.setContent(formatStatusLine(state, contentWidth, rows.statusHeight));

      if (visibleLines.length) {
        overlay.top = overlayTop;
        overlay.height = visibleLines.length;
        overlay.setContent(visibleLines.join("\n"));
        overlay.show();
      } else {
        overlay.hide();
      }

      const cursorPosition: TerminalCursorPosition = {
        row: Math.max(0, Math.min(screen.rows - 1, rows.inputRow + Math.max(0, cursor.row - editorStart))),
        column: Math.max(0, Math.min(terminalWidth - 1, 3 + cursor.column)),
      };
      terminal.requestRender(state.overlay.kind === "none" ? cursorPosition : undefined);
    },
    scrollTranscript(state, delta) {
      state.transcriptScroll.offsetFromBottom = Math.max(0, state.transcriptScroll.offsetFromBottom + Math.trunc(delta));
      state.transcriptScroll.followBottom = state.transcriptScroll.offsetFromBottom === 0;
      state.transcriptScroll.anchor = undefined;
      this.captureTranscriptAnchor(state);
      this.redraw(state);
    },
    captureTranscriptAnchor(state) {
      if (state.transcriptScroll.followBottom || !lastTranscriptLines.length) {
        state.transcriptScroll.anchor = undefined;
        return;
      }
      const top = Math.max(0, lastTranscriptLines.length - lastTranscriptViewportLines - state.transcriptScroll.offsetFromBottom);
      const line = lastTranscriptLines[Math.min(top, lastTranscriptLines.length - 1)];
      state.transcriptScroll.anchor = line ? { messageId: line.messageId, lineOffset: line.lineOffset } : undefined;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      terminal.destroy();
    },
  };
}

export function calculateLayoutRows(rows: number, composerHeight = 1): TuiLayoutRows {
  const terminalRows = Math.max(1, Math.floor(rows));
  const requestedComposerHeight = Math.max(1, Math.min(6, Math.floor(composerHeight)));
  // Short terminals give up composer rows and footer detail before allowing
  // the transcript and input regions to overlap.
  const safeComposerHeight = Math.max(1, Math.min(requestedComposerHeight, Math.max(1, terminalRows - 4)));
  const statusHeight = terminalRows >= safeComposerHeight + 4 ? 2 : terminalRows >= safeComposerHeight + 3 ? 1 : 0;
  const statusTop = Math.max(0, terminalRows - statusHeight);
  const inputBottom = statusHeight > 0 ? Math.max(0, statusTop - 1) : terminalRows - 1;
  const inputRow = Math.max(0, inputBottom - safeComposerHeight);
  const inputTop = Math.max(0, inputRow - 1);
  return {
    viewportTop: 0,
    viewportHeight: Math.max(0, inputTop),
    inputTop,
    inputRow,
    inputBottom,
    statusTop,
    statusHeight,
  };
}

function terminalRows(screen: Widgets.Screen): number {
  return Math.max(1, Math.floor(screen.rows));
}

export function formatStatusLine(state: TuiState, width: number, height = 2): string {
  return footerLines(state, width).slice(0, Math.max(0, Math.floor(height))).join("\n");
}


export function visibleOverlayLines(lines: readonly string[], height: number, selectedLine: number): string[] {
  const visibleHeight = Math.max(1, height);
  if (lines.length <= visibleHeight) return [...lines];
  const maximumStart = lines.length - visibleHeight;
  const start = Math.max(0, Math.min(selectedLine - visibleHeight + 1, maximumStart));
  return lines.slice(start, start + visibleHeight);
}

function renderOverlay(state: TuiState, width: number): string[] {
  if (state.overlay.kind === "commands") return commandPaletteLines(
    composerValue(state.composer),
    state.overlay.selectedIndex,
    state.commands,
    width,
  );
  if (state.overlay.kind === "models") return [
    horizontalRule(width),
    "Select model",
    horizontalRule(width),
    ...(state.overlay.loading ? ["  loading..."] : []),
    ...(state.overlay.error ? wrapOverlayMessage(state.overlay.error, width) : []),
    ...(state.overlay.options.length
      ? modelSelectorLines(state.overlay.options, state.overlay.selectedIndex)
      : state.overlay.loading || state.overlay.error ? [] : ["  (no models configured)"]),
  ];
  if (state.overlay.kind === "sessions") return sessionOverlayLines(state.overlay.options, state.overlay.selectedIndex, width);
  if (state.overlay.kind === "session-delete-confirm") return sessionDeleteConfirmLines(state.overlay.sessionName, state.overlay.selectedIndex, width);
  if (state.overlay.kind === "follow-ups") return followUpOverlayLines(state.overlay.options, state.overlay.selectedIndex, width);
  if (state.overlay.kind === "files") return fileOverlayLines(state.overlay.query, state.overlay.options, state.overlay.selectedIndex, state.overlay.loading, width);
  if (state.overlay.kind === "approval") {
    return [horizontalRule(width), ...approvalDialogLines(
      state.overlay.approval.call,
      state.overlay.approval.level,
      state.overlay.approval.description,
      state.overlay.approval.workspace,
      state.overlay.selectedIndex,
      width,
    ), horizontalRule(width)];
  }
  return [];
}

function selectedOverlayLine(state: TuiState, lines: readonly string[]): number {
  if (!lines.length) return 0;
  const highlighted = lines.findIndex((line) => line.includes("{inverse}"));
  if (highlighted >= 0) return highlighted;
  if (state.overlay.kind === "models") return Math.min(lines.length - 1, state.overlay.selectedIndex + 3);
  return 0;
}

function wrapOverlayMessage(value: string, width: number): string[] {
  return wrapVisible(value, Math.max(1, width - 2)).map((line) => `  ${line}`);
}

function wrapVisible(value: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = value;
  while (visibleWidth(remaining) > width) {
    const chunk = truncateVisible(remaining, width);
    const piece = chunk.endsWith("…") ? chunk.slice(0, -1) : chunk;
    lines.push(piece);
    remaining = remaining.slice(piece.length).trimStart();
  }
  lines.push(remaining);
  return lines;
}

function sessionOverlayLines(options: readonly SessionOption[], selectedIndex: number, width: number): string[] {
  const lines = [
    horizontalRule(width),
    currentSessionLine(options, width),
    "Enter Resume   Del Remove   Esc Close",
    "",
  ];
  if (!options.length) lines.push("  (no sessions)");
  else for (const [index, option] of options.entries()) {
    lines.push(highlightSelection(
      `  ${sessionOptionLabel(option, Math.max(1, width - 2))}`,
      index === selectedIndex,
    ));
  }
  return lines;
}

function sessionDeleteConfirmLines(sessionName: string, selectedIndex: number, width: number): string[] {
  return [
    horizontalRule(width),
    "Delete session?",
    `  ${truncateVisible(sessionName, Math.max(1, width - 2))}`,
    "Enter/Del Confirm   Esc Cancel",
    "",
    highlightSelection("  Delete", selectedIndex === 0),
    highlightSelection("  Cancel", selectedIndex === 1),
  ];
}

function followUpOverlayLines(options: readonly FollowUpOption[], selectedIndex: number, width: number): string[] {
  const lines = [horizontalRule(width), "Follow-ups", "Enter Cancel selected   Esc Close", ""];
  if (!options.length) lines.push("  (no queued follow-ups)");
  else for (const [index, option] of options.entries()) {
    const prompt = option.prompt.replace(/\s+/g, " ").trim();
    const value = `${option.id}  ${prompt}`;
    lines.push(highlightSelection(`  ${truncateVisible(value, Math.max(1, width - 2))}`, index === selectedIndex));
  }
  return lines;
}

function fileOverlayLines(query: string, options: readonly string[], selectedIndex: number, loading: boolean, width: number): string[] {
  const lines = [horizontalRule(width), `@${query}`, "Enter Insert   Esc Close", ""];
  if (loading && !options.length) lines.push("  loading...");
  else if (!options.length) lines.push("  (no matching files)");
  else for (const [index, path] of options.entries()) {
    lines.push(highlightSelection(`  ${truncateVisible(path, Math.max(1, width - 2))}`, index === selectedIndex));
  }
  return lines;
}

export function renderWithStableCursor(screen: Widgets.Screen, cursor?: TerminalCursorPosition): void {
  renderTerminalFrame(screen, cursor);
}
