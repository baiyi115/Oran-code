import { describe, expect, it } from "vitest";
import { createTuiState, setComposerValue } from "../src/tui/state.js";
import {
  composerPrefix,
  fileQuery,
  fitOverlayLines,
  ghostCommandSuggestion,
  oranWelcomeLines,
  renderOverlayLines,
} from "../src/tui/render.js";
import type { SessionOption, TuiState } from "../src/tui/types.js";

function state(): TuiState {
  return createTuiState("/workspace", "openai/gpt-4o");
}

describe("TUI render helpers", () => {
  it("renders a welcome card with model and directory rows", () => {
    const card = oranWelcomeLines(state(), 72);
    expect(card[0]).toContain("╭");
    expect(card.at(-1)).toContain("╯");
    expect(card.join("\n")).toContain("gpt-4o medium");
    expect(card.join("\n")).toContain("/workspace");
  });

  it("renders each overlay kind with a header and hint line", () => {
    const base = state();
    const commands = { ...base, overlay: { kind: "commands" as const, query: "/mo", selectedIndex: 0 } };
    expect(renderOverlayLines(commands, ["/model"], 60)).toEqual(["/model"]);

    const models = { ...base, overlay: { kind: "models" as const, query: "", selectedIndex: 0, options: ["openai/a", "openai/b"], loading: false } };
    expect(renderOverlayLines(models, [], 60)[0]).toBe("Select model");

    const sessions = {
      ...base,
      overlay: {
        kind: "sessions" as const,
        query: "",
        selectedIndex: 0,
        options: [{ id: "s1", name: "one", updatedAt: "", messageCount: 3, isCurrent: true } satisfies SessionOption],
      },
    };
    const sessionLines = renderOverlayLines(sessions, [], 60);
    expect(sessionLines.join("\n")).toContain("Enter Resume");
    expect(sessionLines.join("\n")).toContain("{inverse}");

    const followUps = {
      ...base,
      overlay: { kind: "follow-ups" as const, selectedIndex: 0, options: [{ id: "f1", prompt: "continue tests", createdAt: "" }] },
    };
    expect(renderOverlayLines(followUps, [], 60).join("\n")).toContain("Follow-ups");

    const files = { ...base, overlay: { kind: "files" as const, query: "re", selectedIndex: 0, options: ["readme.md"], loading: false, tokenStart: 0 } };
    expect(renderOverlayLines(files, [], 60)[0]).toBe("@re");

    expect(renderOverlayLines({ ...base, overlay: { kind: "none" } }, [], 60)).toEqual([]);
  });

  it("windows overlay lines around the inverse selection", () => {
    const lines = ["header", "hint", "", "a", "{inverse}b{/inverse}", "c", "d"];
    expect(fitOverlayLines(lines, 10)).toEqual(lines);
    expect(fitOverlayLines(lines, 1)).toEqual(["{inverse}b{/inverse}"]);
    expect(fitOverlayLines(lines, 2)).toEqual(["header", "{inverse}b{/inverse}"]);
    expect(fitOverlayLines(lines, 4)).toEqual(["header", "hint", "a", "{inverse}b{/inverse}"]);
  });

  it("extracts the @file token before the cursor", () => {
    expect(fileQuery("read @sr", 9)).toEqual({ query: "sr", start: 5 });
    expect(fileQuery("read @sr", 6)).toEqual({ query: "", start: 5 });
    expect(fileQuery("no token", 8)).toBeUndefined();
    expect(fileQuery("@ab", 3)).toEqual({ query: "ab", start: 0 });
    expect(fileQuery("write @a@b", 11)).toBeUndefined();
  });

  it("keeps the plain prompt for composer-owned overlays", () => {
    expect(composerPrefix("none")).toBe("> ");
    expect(composerPrefix("commands")).toBe("> ");
    expect(composerPrefix("files")).toBe("> ");
    expect(composerPrefix("connect")).toBe("connect> ");
    expect(composerPrefix("approval")).toBe("! ");
  });

  it("suggests the ghost completion for a command prefix", () => {
    const base = state();
    const withOverlay = { ...base, overlay: { kind: "commands" as const, query: "/mo", selectedIndex: 0 } };
    expect(ghostCommandSuggestion(withOverlay, "/mo")).toBe("del");
    expect(ghostCommandSuggestion(withOverlay, "/model")).toBe("");
    expect(ghostCommandSuggestion({ ...base, overlay: { kind: "none" } }, "/mo")).toBe("");
  });
});
