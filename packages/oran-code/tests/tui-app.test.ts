import { EventEmitter } from "node:events";
import blessed, { type Widgets } from "blessed";
import { describe, expect, it, vi } from "vitest";
import { TuiApp, type TuiAppOptions } from "../src/tui/app.js";
import { createTuiLayout, type TuiLayout } from "../src/tui/layout.js";
import type { TuiState } from "../src/tui/types.js";
import type { ToolCall } from "../src/types.js";

class FakeScreen extends EventEmitter {
  cols = 100;
  rows = 30;
}

interface Harness {
  app: TuiApp;
  key(name: string, ch?: string): void;
  state(): TuiState;
  layoutDestroyed(): number;
}

function createHarness(overrides: Partial<TuiAppOptions> = {}): Harness {
  const screen = new FakeScreen();
  let snapshot: TuiState | undefined;
  let destroyCount = 0;
  const layout = {
    nodes: {},
    redraw(state: TuiState) {
      snapshot = structuredClone(state);
    },
    destroy() {
      destroyCount += 1;
    },
  } as unknown as TuiLayout;
  const options: TuiAppOptions = {
    input: process.stdin,
    output: process.stdout,
    getWorkspace: () => "D:\\workspace",
    getModelLabel: () => "(not selected)",
    onInput: async () => undefined,
    onCancel: () => false,
    loadModels: async () => [],
    onModelSelected: async () => undefined,
    ...overrides,
  };
  const createScreen = (() => screen as unknown as Widgets.Screen) as typeof blessed.screen;
  const createLayout = (() => layout) as typeof createTuiLayout;
  const app = new TuiApp(options, { createScreen, createLayout });
  return {
    app,
    key(name, ch = "") {
      screen.emit("keypress", ch, {
        name,
        full: name,
        ctrl: name === "C-c",
        meta: false,
        shift: false,
        sequence: ch,
      } as Widgets.Events.IKeyEventArg);
    },
    state() {
      if (!snapshot) throw new Error("TUI was not redrawn");
      return snapshot;
    },
    layoutDestroyed: () => destroyCount,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function type(harness: Harness, value: string): void {
  for (const character of value) harness.key(character, character);
}

const call: ToolCall = {
  id: "call-1",
  name: "run_command",
  arguments: { command: "pnpm test" },
  createdAt: new Date(0).toISOString(),
};

describe("TuiApp", () => {
  it("starts with a compact ready status", () => {
    const harness = createHarness();

    expect(harness.state().session.status).toBe("ready");

    harness.app.destroy();
  });

  it("disables redraw features that flicker in Windows Terminal", () => {
    let screenOptions: Widgets.IScreenOptions | undefined;
    const screen = new FakeScreen();
    const layout = { nodes: {}, redraw() {}, destroy() {} } as unknown as TuiLayout;
    const createScreen = ((options: Widgets.IScreenOptions) => {
      screenOptions = options;
      return screen as unknown as Widgets.Screen;
    }) as typeof blessed.screen;
    const createLayout = (() => layout) as typeof createTuiLayout;
    const app = new TuiApp({
      input: process.stdin,
      output: process.stdout,
      getWorkspace: () => "D:\\workspace",
      getModelLabel: () => "(not selected)",
      onInput: async () => undefined,
      onCancel: () => false,
      loadModels: async () => [],
      onModelSelected: async () => undefined,
    }, { createScreen, createLayout });

    expect(screenOptions?.smartCSR).toBeUndefined();
    expect(screenOptions?.useBCE).toBe(true);
    expect(screenOptions?.cursor).toMatchObject({ artificial: false });
    expect(screenOptions?.cursor).not.toHaveProperty("shape");
    app.destroy();
  });

  it("opens slash commands and reloads models on every model selector open", async () => {
    const loadModels = vi.fn()
      .mockResolvedValueOnce(["demo/first", "demo/second"])
      .mockResolvedValueOnce(["fresh/model"]);
    const onModelSelected = vi.fn(async () => undefined);
    const harness = createHarness({ loadModels, onModelSelected });

    type(harness, "/mo");
    const commandOverlay = harness.state().overlay;
    expect(commandOverlay.kind).toBe("commands");
    if (commandOverlay.kind !== "commands") throw new Error("expected command overlay");
    expect(commandOverlay.query).toBe("/mo");
    harness.key("enter");
    await settle();
    expect(loadModels).toHaveBeenCalledTimes(1);
    const modelOverlay = harness.state().overlay;
    expect(modelOverlay.kind).toBe("models");
    if (modelOverlay.kind !== "models") throw new Error("expected model overlay");
    expect(modelOverlay.options).toEqual(["demo/first", "demo/second"]);

    harness.key("down");
    harness.key("enter");
    await settle();
    expect(onModelSelected).toHaveBeenCalledWith("demo/second");
    expect(harness.state().overlay.kind).toBe("none");

    type(harness, "/model");
    harness.key("enter");
    await settle();
    expect(loadModels).toHaveBeenCalledTimes(2);
    const freshModelOverlay = harness.state().overlay;
    expect(freshModelOverlay.kind).toBe("models");
    if (freshModelOverlay.kind !== "models") throw new Error("expected model overlay");
    expect(freshModelOverlay.options).toEqual(["fresh/model"]);
    harness.app.destroy();
  });

  it("keeps approval input exclusive from the composer", async () => {
    const harness = createHarness();
    const approval = harness.app.renderer.approval(call, 2, "Run tests");

    type(harness, "should not edit approval");
    expect(harness.state().composer.lines.join("\n")).toBe("");
    harness.key("enter");
    await expect(approval).resolves.toBe(true);
    harness.app.destroy();
  });

  it("maps approval selection, Escape, replacement, and destroy to one decision", async () => {
    const harness = createHarness();
    const taskApproval = harness.app.renderer.approval(call, 2, "Run tests");
    expect(harness.state().overlay.kind).toBe("approval");
    harness.key("down");
    harness.key("enter");
    await expect(taskApproval).resolves.toBe("task");

    const escaped = harness.app.renderer.approval(call, 2, "Run tests");
    harness.key("escape");
    await expect(escaped).resolves.toBe(false);

    const replaced = harness.app.renderer.approval(call, 2, "Old request");
    const active = harness.app.renderer.approval(call, 2, "New request");
    await expect(replaced).resolves.toBe(false);
    harness.app.destroy();
    await expect(active).resolves.toBe(false);
    harness.app.destroy();
    expect(harness.layoutDestroyed()).toBe(1);
  });

  it("records submitted input and browses history while preserving the draft", async () => {
    const onInput = vi.fn(async () => undefined);
    const harness = createHarness({ history: ["previous"], onInput });
    type(harness, "new prompt");
    harness.key("enter");
    await settle();
    expect(onInput).toHaveBeenCalledWith("new prompt");

    type(harness, "draft");
    harness.key("up");
    expect(harness.state().composer.lines.join("\n")).toBe("new prompt");
    harness.key("up");
    expect(harness.state().composer.lines.join("\n")).toBe("previous");
    harness.key("down");
    harness.key("down");
    expect(harness.state().composer.lines.join("\n")).toBe("draft");
    expect(harness.app.history()).toEqual(["new prompt", "previous"]);
    harness.app.destroy();
  });

  it("cancels work on Ctrl+C and exits only when the callback reports idle", async () => {
    let running = true;
    const onCancel = vi.fn(() => running);
    const harness = createHarness({ onCancel });
    let finished = false;
    const run = harness.app.run().then(() => { finished = true; });

    harness.key("C-c");
    await settle();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);

    running = false;
    harness.key("C-c");
    await settle();
    expect(finished).toBe(false);
    harness.key("C-c");
    await run;
    expect(finished).toBe(true);
    harness.app.destroy();
  });
});
