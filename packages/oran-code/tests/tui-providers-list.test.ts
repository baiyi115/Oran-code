import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import { createTuiState } from "../src/tui/state.js";
import { OverlayHandlers, type OverlayHandlerContext } from "../src/tui/overlay-handlers.js";
import { providerDeleteConfirmLines, providersListLines } from "../src/tui/providers-list.js";
import type { ProviderOption, TuiState } from "../src/tui/types.js";

function key(partial: Partial<Key> = {}): Key {
  return partial as Key;
}
const enter = key({ return: true });
const escape = key({ escape: true });
const down = key({ downArrow: true });

const options: ProviderOption[] = [
  { name: "alpha", baseURL: "https://a.io/v1", protocol: "openai", modelCount: 2, isCurrent: true },
  { name: "beta", baseURL: "https://b.io", protocol: "anthropic", modelCount: 1, isCurrent: false },
];

interface Harness {
  state: TuiState;
  handlers: OverlayHandlers;
  selected: string[];
  deleted: string[];
  addOpened: number;
  deletedOk: boolean;
}

function harness(list: ProviderOption[] = options, deletedOk = true): Harness {
  const state = createTuiState("/workspace", "alpha/model-a");
  const h: Harness = { state, handlers: undefined!, selected: [], deleted: [], addOpened: 0, deletedOk };
  const ctx: OverlayHandlerContext = {
    state,
    loadModels: async () => [],
    onModelSelected: async () => {},
    // 模拟真实行为:列表反映已删除的供应商
    loadProviders: async () => list.filter((option) => !h.deleted.includes(option.name)),
    onProviderSelected: async (name) => {
      h.selected.push(name);
    },
    onProviderDeleted: async (name) => {
      h.deleted.push(name);
      return deletedOk;
    },
    openConnect: () => {
      h.addOpened += 1;
    },
    invalidate: () => {},
    rejectIfBlocked: () => false,
    refreshContext: () => {},
    restoreSessionView: () => {},
    restoreSession: () => {},
    submit: async () => {},
    handleComposerKey: () => {},
    detachInputHistory: () => {},
    noteDismissedCommandInput: () => {},
    resolveApproval: () => {},
  };
  h.handlers = new OverlayHandlers(ctx);
  return h;
}

function overlay(h: Harness) {
  if (h.state.overlay.kind === "none") throw new Error("overlay closed");
  return h.state.overlay;
}

/** 收窄到 providers 列表 overlay,供访问 options 的用例使用。 */
function providersOverlay(h: Harness) {
  const view = overlay(h);
  if (view.kind !== "providers") throw new Error(`overlay is ${view.kind}`);
  return view;
}

describe("providers list overlay", () => {
  it("loads providers and edits via Enter", async () => {
    const h = harness();
    await h.handlers.openProviders();
    expect(overlay(h)).toMatchObject({ kind: "providers", selectedIndex: 0, options: options });

    h.handlers.handleProvidersKey("", enter);
    expect(h.selected).toEqual(["alpha"]);
  });

  it("opens the blank wizard from the add row (Enter or A)", async () => {
    const h = harness();
    await h.handlers.openProviders();
    h.handlers.handleProvidersKey("a", key());
    expect(h.addOpened).toBe(1);

    h.handlers.handleProvidersKey("", down);
    h.handlers.handleProvidersKey("", down); // -> add row (index === options.length)
    h.handlers.handleProvidersKey("", enter);
    expect(h.addOpened).toBe(2);
    expect(h.selected).toEqual([]);
  });

  it("deletes a provider through the confirm dialog and reloads the list", async () => {
    const h = harness();
    await h.handlers.openProviders();
    h.handlers.handleProvidersKey("d", key()); // D/Del/Backspace 均可发起删除
    expect(overlay(h).kind).toBe("provider-delete-confirm");

    // 默认光标在 Cancel,按 Enter 取消回列表
    h.handlers.handleProviderDeleteConfirmKey("", enter);
    expect(h.deleted).toEqual([]);
    expect(overlay(h)).toMatchObject({ kind: "providers", selectedIndex: 0 });

    // 再次请求删除,切到 Delete 确认
    h.handlers.handleProvidersKey("d", key());
    h.handlers.handleProviderDeleteConfirmKey("", key({ leftArrow: true }));
    await h.handlers.handleProviderDeleteConfirmKey("", enter); // 删除确认是异步的,必须等待
    expect(h.deleted).toEqual(["alpha"]);
    // 删除成功后回到重载后的列表,只剩 beta
    expect(providersOverlay(h).options.map((option) => option.name)).toEqual(["beta"]);
  });

  it("stays on the confirm dialog when deletion fails", async () => {
    const h = harness(options, false);
    await h.handlers.openProviders();
    h.handlers.handleProvidersKey("d", key());
    h.handlers.handleProviderDeleteConfirmKey("", key({ leftArrow: true }));
    h.handlers.handleProviderDeleteConfirmKey("", enter);
    expect(h.deleted).toEqual(["alpha"]);
    expect(overlay(h).kind).toBe("provider-delete-confirm");
  });

  it("escape closes the list", async () => {
    const h = harness();
    await h.handlers.openProviders();
    h.handlers.handleProvidersKey("", escape);
    expect(h.state.overlay.kind).toBe("none");
  });
});

describe("providers list rendering", () => {
  it("marks the current provider and shows the add row", () => {
    const lines = providersListLines(options, 0, 80);
    expect(lines.some((line) => line.includes("alpha"))).toBe(true);
    expect(lines.some((line) => line.includes("Current: alpha"))).toBe(true);
    expect(lines.some((line) => line.includes("●"))).toBe(true);
    expect(lines.some((line) => line.includes("+ Add provider"))).toBe(true);
    expect(lines.some((line) => line.includes("1 model"))).toBe(true);
  });

  it("renders the delete confirmation", () => {
    const lines = providerDeleteConfirmLines("alpha", 0, 80);
    expect(lines[0]).toBe("Delete provider?");
    expect(lines.some((line) => line.includes("alpha"))).toBe(true);
  });
});
