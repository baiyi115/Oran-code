import { describe, expect, it } from "vitest";
import { approvalDialogLines } from "../src/tui/approval-dialog.js";
import { commandCandidates, commandPaletteLines } from "../src/tui/command-palette.js";
import { renderOverlayLines } from "../src/tui/render.js";
import { createTuiState } from "../src/tui/state.js";
import type { ToolCall } from "../src/types.js";

const call: ToolCall = {
  name: "run_command",
  arguments: { command: "pnpm test", apiKey: "sk-super-secret-value" },
  createdAt: new Date(0).toISOString(),
};

describe("TUI overlays", () => {
  it("renders slash command candidates with a selection marker", () => {
    expect(commandCandidates("/mo").map((command) => command.name)).toEqual(["/model", "/connect", "/memory", "/plan"]);
    const rows = commandPaletteLines("/", 0);
    const lines = rows.map((row) => row.text).join("\n");
    expect(commandCandidates("/").map((command) => command.name)).toEqual([
      "/clear",
      "/compact",
      "/connect",
      "/exit",
      "/graph",
      "/help",
      "/memory",
      "/model",
      "/new",
      "/plan",
      "/rename",
      "/resume",
      "/rewind",
      "/session",
      "/skills",
      "/status",
      "/tasks",
      "/undo",
      "/worktree",
    ]);
    expect(rows.some((row) => row.selected === true)).toBe(true);
    expect(lines).toContain("clear");
    expect(lines).not.toContain("> ");
    expect(lines).not.toContain("→ ");
    expect(lines).not.toMatch(/\(\d+\/\d+\)/);
  });

  it("renders model selection rows", () => {
    const state = createTuiState("/workspace", "demo/model");
    const lines = renderOverlayLines(
      { ...state, overlay: { kind: "models", selectedIndex: 1, options: ["Demo/chat", "OpenAI/gpt"] } },
      [],
      80,
    );
    const rows = lines.slice(-2);
    expect(rows[0]?.text).toBe("  Demo/chat");
    expect(rows[1]?.selected).toBe(true);
    expect(rows[1]?.text).not.toContain("> OpenAI/gpt");
  });

  it("renders the approval choices without leaking secrets", () => {
    const rows = approvalDialogLines(
      call,
      3,
      "Run the test suite",
      "D:\\Programming\\project\\LiteAgent",
      { kind: "main" },
      0,
    );
    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("Permission required");
    expect(text).toContain("Tool: run_command");
    expect(text).not.toContain("Tool: run_command (L3)");
    expect(text).toContain("Command: pnpm test");
    expect(rows.some((row) => row.selected === true && row.text.includes("Allow for this task"))).toBe(true);
    expect(text).toContain("Allow once");
    expect(text).toContain("Always allow");
    expect(text).toContain("Reject");
    expect(text).not.toContain("sk-super-secret-value");
  });
});
