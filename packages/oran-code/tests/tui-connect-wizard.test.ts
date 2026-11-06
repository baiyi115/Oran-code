import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import { createTuiState } from "../src/tui/state.js";
import { ConnectWizard, type ConnectWizardDeps } from "../src/tui/connect-wizard.js";
import type { ConnectInput, ConnectModelOption, ConnectPrefill, TuiState } from "../src/tui/types.js";

function key(partial: Partial<Key> = {}): Key {
  return partial as Key;
}
const enter = key({ return: true });
const tab = key({ tab: true });
const escape = key({ escape: true });
const backspace = key({ backspace: true });
const down = key({ downArrow: true });
const left = key({ leftArrow: true });

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

/** Type character by character (with no key flags). */
function type(h: WizardHarness, text: string) {
  for (const character of text) h.wizard.handleKey(character, key());
}

/** Enter the baseURL and press Return to reach the models step, then wait for the model fetch to finish. */
async function goToModels(h: WizardHarness, baseURL = "https://x.io/v1") {
  h.wizard.open();
  type(h, baseURL);
  h.wizard.handleKey("", enter);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ConnectWizard", () => {
  it("runs the two-screen flow end to end and submits the payload without reasoningEffort", async () => {
    const h = harness();
    h.wizard.open();
    expect(overlay(h)).toMatchObject({ kind: "connect", step: "info", activeField: "baseURL" });

    h.wizard.handleKey("", enter); // empty baseURL blocks advance
    expect(overlay(h).step).toBe("info");
    expect(overlay(h).error).toContain("base URL is required");

    type(h, "https://api.example.com/v1");
    expect(overlay(h)).toMatchObject({ providerName: "api-example-com", protocol: "openai" });

    h.wizard.handleKey("", enter); // -> models (fetch fires)
    expect(overlay(h).step).toBe("models");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay(h).models.map((model) => model.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(h.fetched).toEqual([{ baseURL: "https://api.example.com/v1", apiKey: "", protocol: "openai" }]);

    h.wizard.handleKey("", enter); // toggle first model
    expect(overlay(h).models[0]).toMatchObject({ id: "gpt-4o", selected: true });
    h.wizard.handleKey("s", key({ ctrl: true })); // Ctrl+S confirms
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.submitted).toEqual([
      {
        providerName: "api-example-com",
        baseURL: "https://api.example.com/v1",
        apiKey: "",
        protocol: "openai",
        models: [{ id: "gpt-4o", selected: true }],
      },
    ]);
    expect(h.state.overlay.kind).toBe("none");
    // The confirmation is a record entry, not a footer status that would never be cleared.
    expect(h.state.transcript.at(-1)).toMatchObject({
      kind: "system",
      text: expect.stringContaining("Connected api-example-com (1 model)"),
    });
  });

  it("auto-derives name and protocol until the user edits them", async () => {
    const h = harness();
    h.wizard.open();
    type(h, "https://api.anthropic.com");
    expect(overlay(h)).toMatchObject({ providerName: "api-anthropic-com", protocol: "anthropic" });

    h.wizard.handleKey("", left); // once switched to openai manually, it is no longer auto-overwritten
    expect(overlay(h).protocol).toBe("openai");
    type(h, "x");
    expect(overlay(h).protocol).toBe("openai");

    // Switch to the name field and rename it manually; later baseURL changes no longer overwrite name.
    h.wizard.handleKey("", down); // apiKey
    h.wizard.handleKey("", down); // protocol
    h.wizard.handleKey("", down); // name
    for (let i = overlay(h).providerName.length; i > 0; i--) h.wizard.handleKey("", backspace);
    type(h, "my");
    expect(overlay(h).providerName).toBe("my");
    h.wizard.handleKey("", down); // back to baseURL
    type(h, "/v9");
    expect(overlay(h).baseURL).toBe("https://api.anthropic.comx/v9");
    expect(overlay(h).providerName).toBe("my");
  });

  it("cycles fields with Tab and edits the focused field with backspace", () => {
    const h = harness();
    h.wizard.open();
    type(h, "https://a.io/v1");
    expect(overlay(h).activeField).toBe("baseURL");
    h.wizard.handleKey("", tab); // -> apiKey
    expect(overlay(h).activeField).toBe("apiKey");
    type(h, "sk-test");
    h.wizard.handleKey("", backspace);
    expect(overlay(h).apiKey).toBe("sk-tes");
    h.wizard.handleKey("", tab); // -> protocol
    expect(overlay(h).activeField).toBe("protocol");
  });

  it("opens prefilled in edit mode and preserves existing model selection", async () => {
    const h = harness();
    const prefill: ConnectPrefill = {
      providerName: "existing",
      baseURL: "https://existing.io/v1",
      apiKey: "sk-old",
      protocol: "anthropic",
      models: [
        { id: "gpt-4o-mini", contextWindow: 64_000 },
        { id: "gpt-4o", reasoningEffort: "low" },
        { id: "local-only", maxTokens: 2048 },
      ],
    };
    h.wizard.open(prefill);
    expect(overlay(h)).toMatchObject({
      step: "info",
      providerName: "existing",
      baseURL: "https://existing.io/v1",
      apiKey: "sk-old",
      protocol: "anthropic",
      nameTouched: true,
      protocolTouched: true,
    });
    h.wizard.handleKey("", enter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Existing settings remain editable offline; fetching is opt-in and merges with the saved list.
    expect(h.fetched).toHaveLength(0);
    expect(overlay(h).models.map((model) => model.id)).toEqual(["gpt-4o-mini", "gpt-4o", "local-only"]);
    h.wizard.handleKey("f", key());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay(h).models).toEqual([
      { id: "gpt-4o", selected: true, reasoningEffort: "low" },
      { id: "gpt-4o-mini", selected: true, contextWindow: 64_000 },
      { id: "local-only", selected: true, maxTokens: 2048 },
    ]);
    // Per-model effort is submitted along with the payload
    h.wizard.handleKey("", tab); // tab on models step = confirm
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.submitted[0]?.models).toEqual([
      { id: "gpt-4o", selected: true, reasoningEffort: "low" },
      { id: "gpt-4o-mini", selected: true, contextWindow: 64_000 },
      { id: "local-only", selected: true, maxTokens: 2048 },
    ]);
  });

  it("cycles per-model reasoning effort with E and back to the default", async () => {
    const h = harness();
    await goToModels(h);
    h.wizard.handleKey("", enter); // select gpt-4o
    h.wizard.handleKey("e", key()); // auto(high) -> low
    expect(overlay(h).models[0]?.reasoningEffort).toBe("low");
    h.wizard.handleKey("e", key()); // -> medium
    h.wizard.handleKey("e", key()); // -> high
    h.wizard.handleKey("e", key()); // -> xhigh
    expect(overlay(h).models[0]?.reasoningEffort).toBe("xhigh");
    h.wizard.handleKey("e", key()); // xhigh -> off
    expect(overlay(h).models[0]).toMatchObject({ disableReasoningEffort: true });
    h.wizard.handleKey("e", key()); // off -> default (medium)
    expect(overlay(h).models[0]).not.toHaveProperty("reasoningEffort");
    expect(overlay(h).models[0]?.disableReasoningEffort).toBe(false);
  });

  it("deletes a model row and re-fetches with F", async () => {
    const h = harness();
    await goToModels(h);
    expect(overlay(h).models.length).toBe(2);

    h.wizard.handleKey("d", key());
    expect(overlay(h).models.map((model) => model.id)).toEqual(["gpt-4o-mini"]);

    h.wizard.handleKey("f", key());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay(h).models.map((model) => model.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(h.fetched.length).toBe(2);

    h.wizard.handleKey("c", key());
    h.wizard.handleKey("u", key({ ctrl: true }));
    h.wizard.handleKey("", enter);
    h.wizard.handleKey("f", key());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay(h).models.find((model) => model.id === "gpt-4o-mini")).not.toHaveProperty("contextWindow");
  });

  it("reports fetch failures inline and keeps the wizard open", async () => {
    const h = harness();
    h.failFetch = true;
    await goToModels(h);
    expect(overlay(h)).toMatchObject({ step: "models", loading: false });
    expect(overlay(h).error).toContain("network down");
    expect(h.state.overlay.kind).toBe("connect");
  });

  it("refuses to confirm without a selected model", async () => {
    const h = harness();
    await goToModels(h);
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
