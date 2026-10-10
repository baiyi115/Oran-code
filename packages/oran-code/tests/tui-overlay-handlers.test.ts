import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import { createTuiState, setComposerValue } from "../src/tui/state.js";
import { OverlayHandlers, type OverlayHandlerContext } from "../src/tui/overlay-handlers.js";
import { commandCandidates } from "../src/tui/command-palette.js";
import type { ApprovalResponse } from "../src/types.js";
import type { SessionOption, SessionView, TuiState } from "../src/tui/types.js";

function key(partial: Partial<Key> = {}): Key {
  return partial as Key;
}
const enter = key({ return: true });
const up = key({ upArrow: true });
const down = key({ downArrow: true });
const escape = key({ escape: true });
const tab = key({ tab: true });

interface Harness {
  state: TuiState;
  handlers: OverlayHandlers;
  submitted: (string | undefined)[];
  dismissed: string[];
  approvals: ApprovalResponse[];
  sessionsDeleted: string[];
  followUpsCancelled: string[];
  sessionsLoaded: SessionOption[];
  modelsSelected: string[];
  restored: SessionView[];
}

function harness(overrides: Partial<TuiState> = {}): Harness {
  const state = { ...createTuiState("/workspace", "openai/gpt-4o"), ...overrides } as TuiState;
  const h: Harness = {
    state,
    handlers: undefined!,
    submitted: [],
    dismissed: [],
    approvals: [],
    sessionsDeleted: [],
    followUpsCancelled: [],
    sessionsLoaded: [
      { id: "s1", name: "one", updatedAt: "", messageCount: 1, isCurrent: false },
      { id: "s2", name: "two", updatedAt: "", messageCount: 2, isCurrent: false },
    ],
    modelsSelected: [],
    restored: [],
  };
  const ctx: OverlayHandlerContext = {
    state,
    loadModels: async () => ["openai/a", "openai/b"],
    loadSessions: async () => h.sessionsLoaded,
    onSessionSelected: async (id) => ({ id, name: `session ${id}`, messages: [], history: [] }),
    onSessionDeleted: async (id) => {
      h.sessionsDeleted.push(id);
      h.sessionsLoaded = h.sessionsLoaded.filter((item) => item.id !== id);
      return h.sessionsLoaded[0]
        ? { id: h.sessionsLoaded[0].id, name: h.sessionsLoaded[0].name, messages: [], history: [] }
        : undefined;
    },
    onModelSelected: async (reference) => {
      h.modelsSelected.push(reference);
      return true;
    },
    loadFollowUps: async () => (h.followUpsCancelled.length ? [] : [{ id: "f1", prompt: "run tests", createdAt: "" }]),
    onFollowUpCancelled: async (id) => {
      h.followUpsCancelled.push(id);
      return true;
    },
    invalidate: () => undefined,
    rejectIfBlocked: () => false,
    refreshContext: () => undefined,
    restoreSessionView: (session) => {
      h.restored.push(session);
    },
    restoreSession: () => undefined,
    submit: async (forcedCommand) => {
      h.submitted.push(forcedCommand);
    },
    handleComposerKey: () => undefined,
    detachInputHistory: () => undefined,
    noteDismissedCommandInput: (value) => {
      h.dismissed.push(value);
    },
    resolveApproval: (response) => {
      h.approvals.push(response);
    },
    resolveQuestion: () => {},
  };
  h.handlers = new OverlayHandlers(ctx);
  return h;
}

describe("OverlayHandlers", () => {
  it("moves the command palette selection with wrap-around", () => {
    const h = harness();
    h.state.overlay = { kind: "commands", query: "/s", selectedIndex: 0 };
    setComposerValue(h.state.composer, "/s");
    h.handlers.handleCommandKey("", up);
    const candidateCount = commandCandidates("/s", h.state.commands).length;
    expect(candidateCount).toBeGreaterThanOrEqual(2);
    expect(h.state.overlay).toMatchObject({ kind: "commands", selectedIndex: candidateCount - 1 });
    h.handlers.handleCommandKey("", down);
    expect(h.state.overlay).toMatchObject({ kind: "commands", selectedIndex: 0 });
  });

  it("tab completes the selected command into the composer", () => {
    const h = harness();
    h.state.overlay = { kind: "commands", query: "/mo", selectedIndex: 0 };
    setComposerValue(h.state.composer, "/mo");
    h.handlers.handleCommandKey("", tab);
    expect(h.state.composer.lines[0]).toBe("/model ");
    expect(h.state.overlay.kind).toBe("none");
  });

  it("submit routes the selected command through ctx.submit", () => {
    const h = harness();
    h.state.overlay = { kind: "commands", query: "/mo", selectedIndex: 0 };
    setComposerValue(h.state.composer, "/mo");
    h.handlers.handleCommandKey("", enter);
    expect(h.submitted).toEqual(["/model"]);
  });

  it("escape closes the palette and records the dismissed input", () => {
    const h = harness();
    h.state.overlay = { kind: "commands", query: "/mo", selectedIndex: 0 };
    setComposerValue(h.state.composer, "/mo");
    h.handlers.handleCommandKey("", escape);
    expect(h.state.overlay.kind).toBe("none");
    expect(h.dismissed).toEqual(["/mo"]);
  });

  it("selects a model on enter and closes the overlay", async () => {
    const h = harness();
    h.state.overlay = {
      kind: "models",
      query: "",
      selectedIndex: 0,
      options: ["openai/a", "openai/b"],
      loading: false,
    };
    h.handlers.handleModelKey("", down);
    expect(h.state.overlay).toMatchObject({ selectedIndex: 1 });
    h.handlers.handleModelKey("", enter);
    await Promise.resolve();
    expect(h.modelsSelected).toEqual(["openai/b"]);
    expect(h.state.overlay.kind).toBe("none");
  });

  it("runs the session delete confirmation flow with index clamping", async () => {
    const h = harness();
    h.state.overlay = { kind: "sessions", query: "", selectedIndex: 1, options: [...h.sessionsLoaded] };
    h.handlers.handleSessionKey("d", key({ ctrl: true }));
    expect(h.state.overlay).toMatchObject({ kind: "session-delete-confirm", sessionId: "s2", returnSelectedIndex: 1 });

    // Cancel restores the sessions overlay at the previous index.
    h.handlers.handleSessionDeleteConfirmKey("", escape);
    expect(h.state.overlay).toMatchObject({ kind: "sessions", selectedIndex: 1 });

    // Confirm deletes and rebuilds the list with a clamped index.
    // The delete confirm defaults to Cancel (changed in this consistency pass); move the
    // highlight to Delete before pressing Enter.
    h.handlers.handleSessionKey("d", key({ ctrl: true }));
    h.handlers.handleSessionDeleteConfirmKey("", up);
    await h.handlers.handleSessionDeleteConfirmKey("", enter);
    expect(h.sessionsDeleted).toEqual(["s2"]);
    expect(h.state.overlay).toMatchObject({ kind: "sessions", selectedIndex: 0 });
    expect((h.state.overlay as { options: SessionOption[] }).options.map((item) => item.id)).toEqual(["s1"]);
  });

  it("cancels a follow-up on enter and refreshes the list", async () => {
    const h = harness();
    await h.handlers.openFollowUps();
    expect(h.state.overlay).toMatchObject({ kind: "follow-ups" });
    await h.handlers.handleFollowUpKey("", enter);
    expect(h.followUpsCancelled).toEqual(["f1"]);
    expect(h.state.overlay).toMatchObject({ kind: "follow-ups", options: [] });
  });

  it("resolves the approval overlay with the highlighted response", () => {
    const h = harness();
    h.state.overlay = {
      kind: "approval",
      selectedIndex: 2,
      approval: {
        call: { name: "run_command", arguments: { command: "ls" }, createdAt: new Date(0).toISOString() },
        level: 3,
        description: "run a command",
        workspace: "/workspace",
        origin: { kind: "main" },
      },
    };
    h.handlers.handleApprovalKey("", enter);
    expect(h.approvals).toEqual(["always"]);
    h.handlers.handleApprovalKey("", escape);
    expect(h.approvals).toEqual(["always", false]);
  });
});

describe("approval quick answers", () => {
  function approvalHarness(): Harness {
    const h = harness();
    h.state.overlay = {
      kind: "approval",
      approval: {
        call: { name: "run_command", arguments: { command: "npm test" }, createdAt: "2026-09-24T00:00:00Z" },
        level: 3,
        description: "run the test suite",
        workspace: "/workspace",
        origin: { kind: "main" },
      },
      selectedIndex: 0,
    };
    return h;
  }

  it("answers approvals with y / n, and only those", () => {
    const yes = approvalHarness();
    yes.handlers.handleApprovalKey("y", key({}));
    expect(yes.approvals).toEqual([true]);

    const no = approvalHarness();
    no.handlers.handleApprovalKey("n", key({}));
    expect(no.approvals).toEqual([false]);

    // "always allow" has no single-key answer: the dialog often appears while the
    // user is still typing, and one keystroke must not hand over a session-wide
    // permission. It stays reachable with ↑↓ + Enter.
    const always = approvalHarness();
    always.handlers.handleApprovalKey("a", key({}));
    expect(always.approvals).toEqual([]);
    always.handlers.handleApprovalKey("", key({ downArrow: true }));
    always.handlers.handleApprovalKey("", key({ downArrow: true }));
    always.handlers.handleApprovalKey("\r", key({ return: true }));
    expect(always.approvals).toEqual(["always"]);
  });

  it("ignores letters when a modifier is held", () => {
    const h = approvalHarness();
    h.handlers.handleApprovalKey("y", key({ ctrl: true }));
    expect(h.approvals).toEqual([]);
  });
});

describe("session delete confirmation", () => {
  function sessionsHarness(): Harness {
    const h = harness();
    h.state.overlay = {
      kind: "sessions",
      query: "",
      selectedIndex: 0,
      options: h.sessionsLoaded,
    };
    return h;
  }

  it("defaults to Cancel when asking to delete a session", () => {
    const h = sessionsHarness();
    // Backspace/Del trigger a delete request (goes through the confirm layer, no longer a direct delete)
    h.handlers.handleSessionKey("", key({ delete: true }));
    expect(h.state.overlay).toMatchObject({ kind: "session-delete-confirm", selectedIndex: 1 });
  });

  it("Enter on Cancel backs out with nothing deleted", async () => {
    const h = sessionsHarness();
    h.handlers.handleSessionKey("", key({ delete: true }));
    await h.handlers.handleSessionDeleteConfirmKey("", enter);
    expect(h.sessionsDeleted).toEqual([]);
    expect(h.state.overlay.kind).toBe("sessions");
  });

  it("Backspace while Cancel is focused no longer deletes; only Enter on Delete deletes", async () => {
    const h = sessionsHarness();
    h.handlers.handleSessionKey("", key({ delete: true }));
    await h.handlers.handleSessionDeleteConfirmKey("", key({ backspace: true }));
    expect(h.sessionsDeleted).toEqual([]);

    await h.handlers.handleSessionDeleteConfirmKey("", up);
    await h.handlers.handleSessionDeleteConfirmKey("", enter);
    expect(h.sessionsDeleted).toEqual(["s1"]);
    expect(h.state.session.status).toBe("session deleted");
  });
});
