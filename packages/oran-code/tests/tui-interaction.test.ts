import { describe, expect, it } from "vitest";
import { approvalResponse, filterCommands, moveSelection, navigateHistory, redactSecrets } from "../src/tui/interaction.js";

describe("TUI interaction helpers", () => {
  it("wraps selection movement", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });

  it("filters slash commands by the typed command", () => {
    expect(filterCommands("/mo").map((command) => command.name)).toEqual(["/model"]);
    expect(filterCommands("/").map((command) => command.name)).toEqual([
      "/new",
      "/model",
      "/session",
      "/clear",
      "/rename",
    ]);
  });

  it("maps approval choices and redacts secrets", () => {
    expect(approvalResponse(0)).toBe(true);
    expect(approvalResponse(1)).toBe("task");
    expect(approvalResponse(2)).toBe(false);
    expect(redactSecrets({ apiKey: "sk-super-secret-value", nested: { token: "abc" } })).toEqual({
      apiKey: "[redacted]",
      nested: { token: "[redacted]" },
    });
  });

  it("browses newest-first history and restores the current draft", () => {
    const older = navigateHistory(["latest", "older"], undefined, "older", "draft", "");
    expect(older).toEqual({ value: "latest", index: 0, draft: "draft" });
    const oldest = navigateHistory(["latest", "older"], older.index, "older", older.value, older.draft);
    expect(oldest).toEqual({ value: "older", index: 1, draft: "draft" });
    const newer = navigateHistory(["latest", "older"], oldest.index, "newer", oldest.value, oldest.draft);
    expect(newer).toEqual({ value: "latest", index: 0, draft: "draft" });
    expect(navigateHistory(["latest", "older"], newer.index, "newer", newer.value, newer.draft)).toEqual({
      value: "draft",
      index: undefined,
      draft: "draft",
    });
  });
});
