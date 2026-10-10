import { describe, expect, it } from "vitest";
import { createTuiState } from "../src/tui/state.js";
import {
  composerPrefix,
  fileQuery,
  fitOverlayLines,
  ghostCommandSuggestion,
  oranWelcomeLines,
  renderOverlayLines,
} from "../src/tui/render.js";
import { footerLines } from "../src/tui/footer.js";
import { questionDialogLines } from "../src/tui/question-dialog.js";
import { renderToolMessage } from "../src/tui/transcript/tool-message.js";
import { renderDiff } from "../src/tui/transcript/diff-renderer.js";
import type { SessionOption, ToolMessage, TuiState } from "../src/tui/types.js";

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

    const models = {
      ...base,
      overlay: {
        kind: "models" as const,
        query: "",
        selectedIndex: 0,
        options: ["openai/a", "openai/b"],
        loading: false,
      },
    };
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
      overlay: {
        kind: "follow-ups" as const,
        selectedIndex: 0,
        options: [{ id: "f1", prompt: "continue tests", createdAt: "" }],
      },
    };
    expect(renderOverlayLines(followUps, [], 60).join("\n")).toContain("Follow-ups");

    const files = {
      ...base,
      overlay: {
        kind: "files" as const,
        query: "re",
        selectedIndex: 0,
        options: ["readme.md"],
        loading: false,
        tokenStart: 0,
        quoted: false,
      },
    };
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
    expect(fileQuery("read @sr", 9)).toEqual({ query: "sr", start: 5, quoted: false });
    expect(fileQuery("read @sr", 6)).toEqual({ query: "", start: 5, quoted: false });
    expect(fileQuery("no token", 8)).toBeUndefined();
    expect(fileQuery("@ab", 3)).toEqual({ query: "ab", start: 0, quoted: false });
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

describe("details overlay window", () => {
  const content = Array.from({ length: 40 }, (_, index) => `content line ${index + 1}`);
  function overlayState(scrollOffset?: number): TuiState {
    return {
      ...state(),
      overlay: {
        kind: "details",
        title: "Latest activity",
        lines: content,
        ...(scrollOffset === undefined ? {} : { scrollOffset }),
      },
    };
  }

  it("shows the head window by default with the hint pinned and a count", () => {
    const lines = renderOverlayLines(overlayState(0), [], 60, 10);
    expect(lines[0]).toBe("Latest activity");
    expect(lines).toContain("content line 1");
    expect(lines).not.toContain("content line 10");
    expect(lines.some((line) => line.includes("7/40") && line.includes("Ctrl+T/Esc Close"))).toBe(true);
  });

  it("scrolls through the content without dropping the title or hint", () => {
    const lines = renderOverlayLines(overlayState(20), [], 60, 10);
    expect(lines[0]).toBe("Latest activity");
    expect(lines).toContain("content line 21");
    expect(lines).not.toContain("content line 1");
    expect(lines.some((line) => line.includes("27/40"))).toBe(true);
  });

  it("clamps the scroll offset to the end of the content", () => {
    const lines = renderOverlayLines(overlayState(999), [], 60, 10);
    expect(lines.some((line) => line.includes("content line 40"))).toBe(true);
    expect(lines.some((line) => line.includes("40/40"))).toBe(true);
  });

  it("shows everything when the content fits", () => {
    const shortContent = ["one", "two"];
    const lines = renderOverlayLines(
      { ...state(), overlay: { kind: "details", title: "T", lines: shortContent } },
      [],
      60,
      10,
    );
    expect(lines).toEqual(["T", expect.any(String), "one", "two", "PageUp/PageDown/↑↓ scroll · Ctrl+T/Esc Close"]);
  });
});

describe("tool output head/tail preview", () => {
  function tailMessage(output: string): ToolMessage {
    return {
      id: "tool-1",
      kind: "tool",
      callId: "call-1",
      name: "run_command",
      arguments: { command: "npm test" },
      permissionLevel: 3,
      status: "failure",
      output,
      expanded: true,
    };
  }

  it("keeps head and tail lines for long outputs instead of only the head", () => {
    const output = Array.from({ length: 30 }, (_, index) => `log ${index + 1}`).join("\n");
    const lines = renderToolMessage(tailMessage(output), 80);
    const text = lines.join("\n");
    expect(text).toContain("log 1");
    expect(text).toContain("log 8");
    expect(text).not.toContain("log 12");
    expect(text).toContain("log 27");
    expect(text).toContain("log 30");
    expect(text).toContain("18 lines hidden");
  });

  it("shows everything for short outputs", () => {
    const output = ["first", "second", "third"].join("\n");
    const lines = renderToolMessage(tailMessage(output), 80);
    expect(lines.join("\n")).toContain("first");
    expect(lines.join("\n")).toContain("third");
    expect(lines.join("\n")).not.toContain("lines hidden");
  });
});

describe("diff head/tail preview", () => {
  const diff = Array.from({ length: 40 }, (_, index) => `${index % 2 === 0 ? "+" : "-"}change ${index + 1}`).join("\n");

  it("keeps both ends of a long diff when expanded", () => {
    const lines = renderDiff(diff, 80, true);
    const text = lines.join("\n");
    expect(text).toContain("change 1");
    expect(text).toContain("change 33");
    expect(text).toContain("change 40");
    expect(text).toContain("12 lines hidden");
  });

  it("keeps the folded preview compact for non-expanded diffs", () => {
    const lines = renderDiff(diff, 80, false);
    // The folded form keeps 6 header lines plus an explicit hidden-line count
    // (folding should not pretend the content is complete).
    expect(lines.length).toBeLessThan(10);
    expect(lines.join("\n")).toContain("34 lines hidden");
    expect(lines.join("\n")).toContain("change 6");
    expect(lines.join("\n")).not.toContain("change 33");
  });
});

describe("running tool elapsed time and badges", () => {
  function runningMessage(): ToolMessage {
    return {
      id: "tool-2",
      kind: "tool",
      callId: "call-2",
      name: "run_command",
      arguments: { command: "npm test" },
      permissionLevel: 3,
      status: "running",
      startedAt: new Date(0).toISOString(),
      expanded: false,
    };
  }

  it("shows how long a running tool has been working", () => {
    const startedSecondsAgo = new Date(Date.now() - 4_200).toISOString();
    const rows = renderToolMessage(
      { ...runningMessage(), startedAt: startedSecondsAgo },
      80,
      0,
      Date.parse(startedSecondsAgo) + 5_000,
    );
    expect(rows.join("\n")).toContain("5.0s");
  });

  it("renders metadata badges next to the tool name", () => {
    const rows = renderToolMessage(
      { ...runningMessage(), durationMs: 120, badges: ["cached", "hook"], status: "failure" },
      80,
    );
    expect(rows.join("\n")).toContain("[cached, hook]");
  });

  it("labels parallel agent calls with role and task description", () => {
    const rows = renderToolMessage(
      {
        ...runningMessage(),
        name: "agent",
        arguments: {
          description: "审计仓库的错误分类逻辑",
          prompt: "阅读 controller 与 provider 层…",
          subagent_type: "explore",
        },
      },
      120,
    );
    expect(rows.join("\n")).toContain("explore · 审计仓库的错误分类逻辑");
  });

  it("shows a progress note while the call runs, and the summary once it lands", () => {
    const note = "analyzing 512/2300 files";
    const rows = renderToolMessage({ ...runningMessage(), progress: note }, 80);
    expect(rows.join("\n")).toContain(note);

    const finished = renderToolMessage(
      { ...runningMessage(), status: "failure", durationMs: 90, summary: "12 files", progress: note },
      80,
    );
    expect(finished.join("\n")).toContain("12 files");
    expect(finished.join("\n")).not.toContain(note);
  });
});

describe("footer permission and context chips", () => {
  it("shows the permission mode and context gauge in the footer", () => {
    const withChips = {
      ...state(),
      session: { ...state().session, permissionMode: "bypass" as const, contextWindow: 1000, contextEstimate: 420 },
    };
    expect(footerLines(withChips, 120).join("\n")).toContain("perm:bypass");
    expect(footerLines(withChips, 120).join("\n")).toContain("ctx 42%");
  });

  it("warns when the context window is close to full", () => {
    const nearlyFull = {
      ...state(),
      session: { ...state().session, permissionMode: "default" as const, contextWindow: 2000, contextEstimate: 1700 },
    };
    expect(footerLines(nearlyFull, 120).join("\n")).toContain("ctx 85%!");
  });
});

describe("question dialog preview head/tail and honest hints", () => {
  it("keeps head and tail lines of a long preview and names the Esc behavior", () => {
    const questions = [
      {
        header: "Choice",
        question: "Which plan do you like?",
        options: [
          {
            label: "A",
            description: "plan A",
            preview: Array.from({ length: 12 }, (_, index) => `preview line ${index + 1}`).join("\n"),
          },
          { label: "B", description: "plan B" },
        ],
      },
    ];
    const text = questionDialogLines(questions, 0, 0, [0], 80).join("\n");
    expect(text).toContain("preview line 1");
    expect(text).toContain("preview line 5");
    expect(text).not.toContain("preview line 8");
    expect(text).toContain("preview line 12");
    expect(text).toContain("4 more lines in the middle");
    expect(text).toContain("Esc Skip remaining");
    expect(text).not.toContain("Esc Reject");
  });
});
