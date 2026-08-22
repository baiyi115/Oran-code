import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import { createTuiState } from "../src/tui/state.js";
import { ConnectWizard, type ConnectWizardDeps } from "../src/tui/connect-wizard.js";
import type { ConnectInput, ConnectModelOption, TuiState } from "../src/tui/types.js";

function key(partial: Partial<Key> = {}): Key {
  return partial as Key;
}
const enter = key({ return: true });
const tab = key({ tab: true });
const escape = key({ escape: true });
const backspace = key({ backspace: true });
const up = key({ upArrow: true });
const down = key({ downArrow: true });

interface WizardHarness {
  state: TuiState;
  wizard: ConnectWizard;
  fetched: { baseURL: string; apiKey: string; protocol: string }[];
  submitted: ConnectInput[];
  invalidated: number;
  blocked: string[];
  failFetch: boolean;
}

function harness(): WizardHarness {
  const state = createTuiState("/workspace", "openai/gpt-4o");
  const h: WizardHarness = {
    state,
    wizard: undefined!,
    fetched: [],
    submitted: [],
    invalidated: 0,
    blocked: [],
    failFetch: false,
  };
  const deps: ConnectWizardDeps = {
    state,
    loadRemoteModels: async (baseURL, apiKey, protocol) => {
      h.fetched.push({ baseURL, apiKey, protocol });
      if (h.failFetch) throw new Error("network down");
      return [
        { id: "gpt-4o", selected: false },
        { id: "gpt-4o-mini", selected: false, contextWindow: 128_000 },
      ] satisfies ConnectModelOption[];
    },
    onConnect: async (input) => {
      h.submitted.push(input);
      return true;
    },
    invalidate: () => {
      h.invalidated += 1;
    },
    rejectIfBlocked: (message) => {
      h.blocked.push(message);
      return false;
    },
  };
  h.wizard = new ConnectWizard(deps);
  return h;
}

function overlay(h: WizardHarness) {
  const overlay = h.state.overlay;
  if (overlay.kind !== "connect") throw new Error(`overlay is ${overlay.kind}`);
  return overlay;
}

/** 空文本 + 回车:推进当前步骤。 */
function advance(h: WizardHarness) {
  h.wizard.handleKey("", enter);
}

/** 逐字符输入(不带任何键标志)。 */
function type(h: WizardHarness, text: string) {
  for (const character of text) h.wizard.handleKey(character, key());
}

describe("ConnectWizard", () => {
  it("runs the six steps end to end and submits the payload", async () => {
    const h = harness();
    h.wizard.open();
    expect(overlay(h)).toMatchObject({ kind: "connect", step: "providerName" });

    type(h, "p");
    advance(h);      // -> baseURL
    expect(overlay(h).step).toBe("baseURL");
    advance(h);      // empty baseURL blocks advance
    expect(overlay(h).step).toBe("baseURL");

    type(h, "https://api.example.com/v1");
    advance(h);      // -> apiKey (protocol preselected from URL)
    expect(overlay(h)).toMatchObject({ step: "apiKey", protocol: "openai" });

    advance(h);      // -> protocol list
    expect(overlay(h).step).toBe("protocol");
    advance(h);      // confirm openai -> reasoningEffort
    expect(overlay(h).step).toBe("reasoningEffort");
    advance(h);      // confirm medium -> models (fetch fires)
    expect(overlay(h).step).toBe("models");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay(h).models.map((model) => model.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(h.fetched).toEqual([{ baseURL: "https://api.example.com/v1", apiKey: "", protocol: "openai" }]);

    h.wizard.handleKey("", enter); // toggle first model
    expect(overlay(h).models[0]).toMatchObject({ id: "gpt-4o", selected: true });
    h.wizard.handleKey("s", key({ ctrl: true })); // Ctrl+S confirms
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.submitted).toEqual([{
      providerName: "p",
      baseURL: "https://api.example.com/v1",
      apiKey: "",
      protocol: "openai",
      reasoningEffort: "medium",
      models: [{ id: "gpt-4o", selected: true }],
    }]);
    expect(h.state.overlay.kind).toBe("none");
    expect(h.state.session.status).toContain("Connected p (1 model)");
  });

  it("keeps the settled generic label when the name step was blank", () => {
    const h = harness();
    h.wizard.open();
    advance(h); // blank name settles on the generic "provider" label (baseURL is still empty here)
    expect(overlay(h).providerName).toBe("provider");
    expect(overlay(h).step).toBe("baseURL");
    type(h, "https://my.host.io/v1");
    advance(h);
    advance(h); // apiKey -> protocol
    advance(h); // protocol -> reasoningEffort
    // The name was already settled at the name step, so the host fallback at
    // confirm time never rewrites it; the label documents this actual behavior.
    expect(overlay(h).providerName).toBe("provider");
  });

  it("supports backspace editing and tab advance on free-text steps", () => {
    const h = harness();
    h.wizard.open();
    type(h, "ab");
    h.wizard.handleKey("", backspace);
    expect(overlay(h).providerName).toBe("a");
    h.wizard.handleKey("", tab);
    expect(overlay(h).step).toBe("baseURL");
  });

  it("selects protocol via arrows and anthropic URL hint", () => {
    const h = harness();
    h.wizard.open();
    advance(h); // skip providerName
    type(h, "https://api.anthropic.com");
    advance(h); // -> apiKey
    advance(h); // -> protocol (hint selects anthropic index 1)
    expect(overlay(h)).toMatchObject({ step: "protocol", selectedIndex: 1, protocol: "anthropic" });
    h.wizard.handleKey("", up);
    advance(h);
    expect(overlay(h)).toMatchObject({ step: "reasoningEffort", protocol: "openai" });
  });

  it("documents that a blank provider name settles on the generic label", () => {
    const h = harness();
    h.wizard.open();
    advance(h);
    expect(overlay(h).providerName).toBe("provider");
  });

  it("deletes a model row and re-fetches with F", async () => {
    const h = harness();
    h.wizard.open();
    type(h, "p");
    advance(h);
    type(h, "https://x.io/v1");
    advance(h);
    advance(h);
    advance(h);
    advance(h);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay(h).models.length).toBe(2);

    h.wizard.handleKey("d", key());
    expect(overlay(h).models.map((model) => model.id)).toEqual(["gpt-4o-mini"]);

    h.wizard.handleKey("f", key());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay(h).models.map((model) => model.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(h.fetched.length).toBe(2);
  });

  it("reports fetch failures inline and keeps the wizard open", async () => {
    const h = harness();
    h.failFetch = true;
    h.wizard.open();
    type(h, "p");
    advance(h);
    type(h, "https://x.io/v1");
    advance(h);
    advance(h);
    advance(h);
    advance(h);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay(h)).toMatchObject({ step: "models", loading: false });
    expect(overlay(h).error).toContain("network down");
    expect(h.state.overlay.kind).toBe("connect");
  });

  it("refuses to confirm without a selected model", async () => {
    const h = harness();
    h.wizard.open();
    type(h, "p");
    advance(h);
    type(h, "https://x.io/v1");
    advance(h);
    advance(h);
    advance(h);
    advance(h);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.wizard.handleKey("", tab); // tab on models step = confirm
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay(h).error).toContain("select at least one model");
    expect(h.submitted).toEqual([]);
  });

  it("escape closes the wizard at any step", () => {
    const h = harness();
    h.wizard.open();
    h.wizard.handleKey("", escape);
    expect(h.state.overlay.kind).toBe("none");
  });
});
