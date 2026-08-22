import type { Key } from "ink";
import { REASONING_EFFORTS } from "../types.js";
import { formatErrorMessage } from "../error-format.js";
import { setOverlay } from "./state.js";
import type { ConnectInput, ConnectModelOption, ConnectStep, TuiState } from "./types.js";
import { dimHorizontalRule } from "./theme.js";
import { highlightSelection } from "./overlay/select-list.js";
import { truncateVisible } from "./text-width.js";
import { isSubmitKey } from "./keys.js";

export interface ConnectWizardDeps {
  readonly state: TuiState;
  loadRemoteModels?: (baseURL: string, apiKey: string, protocol: "openai" | "anthropic") => Promise<ConnectModelOption[]>;
  onConnect?: (input: ConnectInput) => Promise<boolean | void>;
  invalidate(): void;
  rejectIfBlocked(message: string): boolean;
}

/**
 * 「添加模型提供商」六步向导:providerName → baseURL → apiKey → protocol →
 * reasoningEffort → models。状态完全存放在 state.overlay 的 connect 变体,
 * 从 InkTuiApp 提取,行为保持不变。
 */
export class ConnectWizard {
  constructor(private readonly deps: ConnectWizardDeps) {}

  open(): void {
    if (this.deps.rejectIfBlocked("finish or cancel the current task before connecting a provider")) return;
    if (!this.deps.onConnect || !this.deps.loadRemoteModels) return;
    setOverlay(this.deps.state, {
      kind: "connect",
      step: "providerName",
      providerName: "",
      baseURL: "",
      apiKey: "",
      protocol: "",
      reasoningEffort: "medium",
      models: [],
      selectedIndex: 0,
      loading: false,
    });
    this.deps.invalidate();
  }

  handleKey(input: string, key: Key): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;

    if (key.escape) {
      this.deps.state.overlay = { kind: "none" };
      this.deps.invalidate();
      return;
    }

    if (overlay.step !== "models" && key.tab) {
      this.advanceStep(input);
      this.deps.invalidate();
      return;
    }

    if (overlay.step === "models") {
      // Ctrl+S or Tab finishes the wizard from the models step.
      if ((key.ctrl && input === "s") || key.tab) {
        void this.confirm();
        this.deps.invalidate();
        return;
      }
      this.handleModelsKey(input, key);
      this.deps.invalidate();
      return;
    }

    // List-selection steps (protocol / reasoningEffort): arrow keys move,
    // Enter/Tab confirms and advances. They must not fall through to the
    // free-text editor below, otherwise arrow keys get swallowed.
    if (overlay.step === "protocol" || overlay.step === "reasoningEffort") {
      this.handleListStepKey(input, key);
      this.deps.invalidate();
      return;
    }

    // Free-text steps (providerName / baseURL / apiKey): edit in place, Enter advances.
    if (key.backspace || key.delete) {
      this.deleteFieldChar(overlay.step, key.delete);
      this.deps.invalidate();
      return;
    }
    if (isSubmitKey(input, key)) {
      this.advanceStep(input);
      this.deps.invalidate();
      return;
    }
    if (input && !key.ctrl && !key.meta && input !== "\t") {
      this.appendFieldChar(overlay.step, input);
      this.deps.invalidate();
    }
  }

  private deleteFieldChar(step: ConnectStep, _isDelete: boolean): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    const trim = (value: string) => (value.length ? value.slice(0, -1) : value);
    if (step === "providerName") overlay.providerName = trim(overlay.providerName);
    else if (step === "baseURL") overlay.baseURL = trim(overlay.baseURL);
    else if (step === "apiKey") overlay.apiKey = trim(overlay.apiKey);
  }

  private appendFieldChar(step: ConnectStep, input: string): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    if (input === "\r" || input === "\n") return;
    if (step === "providerName") overlay.providerName += input;
    else if (step === "baseURL") overlay.baseURL += input;
    else if (step === "apiKey") overlay.apiKey += input;
  }

  private advanceStep(_input: string): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    switch (overlay.step) {
      case "providerName": {
        const name = overlay.providerName.trim() || safeHostName(overlay.baseURL, "provider");
        overlay.providerName = name;
        overlay.step = "baseURL";
        break;
      }
      case "baseURL": {
        if (!overlay.baseURL.trim()) return;
        // Pre-select protocol from URL hint when empty.
        if (!overlay.protocol) {
          const hint = overlay.baseURL.toLowerCase();
          if (hint.includes("anthropic") || hint.includes("claude")) overlay.protocol = "anthropic";
          else overlay.protocol = "openai";
        }
        overlay.step = "apiKey";
        break;
      }
      case "apiKey": {
        overlay.step = "protocol";
        overlay.selectedIndex = overlay.protocol === "anthropic" ? 1 : 0;
        break;
      }
      case "protocol": {
        const choices: ("openai" | "anthropic")[] = ["openai", "anthropic"];
        overlay.protocol = choices[overlay.selectedIndex] ?? "openai";
        overlay.step = "reasoningEffort";
        overlay.selectedIndex = REASONING_EFFORTS.indexOf(overlay.reasoningEffort);
        if (overlay.selectedIndex < 0) overlay.selectedIndex = 1;
        break;
      }
      case "reasoningEffort": {
        overlay.reasoningEffort = REASONING_EFFORTS[overlay.selectedIndex] ?? "medium";
        overlay.step = "models";
        overlay.selectedIndex = 0;
        void this.fetchModels();
        break;
      }
      case "models": {
        void this.confirm();
        break;
      }
    }
  }

  private async fetchModels(): Promise<void> {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    const protocol = (overlay.protocol || "openai") as "openai" | "anthropic";
    overlay.loading = true;
    overlay.error = undefined;
    this.deps.invalidate();
    try {
      const remote = await this.deps.loadRemoteModels?.(overlay.baseURL.trim(), overlay.apiKey.trim(), protocol) ?? [];
      if (this.deps.state.overlay.kind !== "connect") return;
      const existing = new Map(this.deps.state.overlay.models.map((model) => [model.id, model]));
      this.deps.state.overlay.models = remote.map((model): ConnectModelOption => {
        const next: ConnectModelOption = { id: model.id, selected: existing.get(model.id)?.selected ?? false };
        if (model.contextWindow !== undefined) next.contextWindow = model.contextWindow;
        return next;
      });
      this.deps.state.overlay.selectedIndex = 0;
      this.deps.state.overlay.loading = false;
    } catch (error) {
      if (this.deps.state.overlay.kind !== "connect") return;
      this.deps.state.overlay.loading = false;
      this.deps.state.overlay.error = formatErrorMessage(error);
    }
    this.deps.invalidate();
  }

  private handleModelsKey(input: string, key: Key): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    const options = overlay.models;
    if (key.upArrow) {
      overlay.selectedIndex = Math.max(0, overlay.selectedIndex - 1);
      return;
    }
    if (key.downArrow) {
      overlay.selectedIndex = Math.min(Math.max(0, options.length - 1), overlay.selectedIndex + 1);
      return;
    }
    if (input === "f" || input === "F") {
      void this.fetchModels();
      return;
    }
    if (input === "d" || input === "D") {
      const selected = options[overlay.selectedIndex];
      if (selected) {
        overlay.models = options.filter((_, index) => index !== overlay.selectedIndex);
        overlay.selectedIndex = Math.min(overlay.selectedIndex, Math.max(0, overlay.models.length - 1));
      }
      return;
    }
    if (isSubmitKey(input, key)) {
      const selected = options[overlay.selectedIndex];
      if (selected) {
        selected.selected = !selected.selected;
      }
    }
  }

  private handleListStepKey(input: string, key: Key): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    const choices: readonly string[] = overlay.step === "protocol"
      ? ["openai", "anthropic"]
      : REASONING_EFFORTS;
    if (key.upArrow) {
      overlay.selectedIndex = Math.max(0, overlay.selectedIndex - 1);
      return;
    }
    if (key.downArrow) {
      overlay.selectedIndex = Math.min(Math.max(0, choices.length - 1), overlay.selectedIndex + 1);
      return;
    }
    if (isSubmitKey(input, key)) {
      this.advanceStep(input);
    }
  }

  private async confirm(): Promise<void> {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    const protocol = (overlay.protocol || "openai") as "openai" | "anthropic";
    const selected = overlay.models.filter((model) => model.selected);
    if (!selected.length) {
      overlay.error = "select at least one model with Enter first";
      this.deps.invalidate();
      return;
    }
    const payload: ConnectInput = {
      providerName: overlay.providerName.trim() || safeHostName(overlay.baseURL, "provider"),
      baseURL: overlay.baseURL.trim(),
      apiKey: overlay.apiKey.trim(),
      protocol,
      reasoningEffort: overlay.reasoningEffort,
      models: selected,
    };
    try {
      const ok = await this.deps.onConnect?.(payload);
      this.deps.state.overlay = { kind: "none" };
      const activeModel = selected[0]?.id ? `${payload.providerName}/${selected[0].id}` : undefined;
      this.deps.state.session.status = ok === false
        ? "provider connection failed"
        : `Connected ${payload.providerName} (${selected.length} model${selected.length === 1 ? "" : "s"})${activeModel ? `. Active model: ${activeModel}` : ""}`;
    } catch (error) {
      if (this.deps.state.overlay.kind === "connect") {
        this.deps.state.overlay.error = formatErrorMessage(error);
      }
    }
    this.deps.invalidate();
  }
}

export function safeHostName(input: string, fallback = "provider"): string {
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const host = url.hostname.replace(/\./g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
    return host || fallback;
  } catch {
    return fallback;
  }
}

export function renderConnectLines(overlay: Extract<TuiState["overlay"], { kind: "connect" }>, width: number): string[] {
  function protocolLabel(protocol: "openai" | "anthropic"): string {
    return protocol === "anthropic" ? "Anthropic Messages" : "OpenAI Chat Completions";
  }
  const lines: string[] = [];
  switch (overlay.step) {
    case "providerName":
      lines.push("Add provider — name", dimHorizontalRule(width), `  ${overlay.providerName || "(e.g. openai)"}`, "Enter/Tab Next   Esc Close");
      break;
    case "baseURL":
      lines.push(`Provider: ${overlay.providerName}`, dimHorizontalRule(width), "Base URL", `  ${overlay.baseURL || "(e.g. https://api.openai.com/v1 or https://api.anthropic.com)}"}`, "Enter/Tab Next   Esc Close");
      break;
    case "apiKey":
      lines.push(`Provider: ${overlay.providerName} — ${overlay.baseURL}`, dimHorizontalRule(width), "API key (optional)", `  ${overlay.apiKey ? "*".repeat(Math.min(40, overlay.apiKey.length)) : "(leave blank to skip)"}`, "Enter/Tab Next   Esc Close");
      break;
    case "protocol": {
      const choices: ("openai" | "anthropic")[] = ["openai", "anthropic"];
      lines.push(`Provider: ${overlay.providerName}`, dimHorizontalRule(width), "Protocol", "Enter/Tab Confirm   Esc Close", "");
      choices.forEach((choice, index) => {
        lines.push(highlightSelection(`  ${protocolLabel(choice)}`, index === overlay.selectedIndex));
      });
      break;
    }
    case "reasoningEffort": {
      lines.push(`Provider: ${overlay.providerName} (${protocolLabel(overlay.protocol || "openai")})`, dimHorizontalRule(width), "Reasoning effort", "Enter/Tab Confirm   Esc Close", "");
      REASONING_EFFORTS.forEach((effort, index) => {
        lines.push(highlightSelection(`  ${effort}`, index === overlay.selectedIndex));
      });
      break;
    }
    case "models": {
      lines.push(`Provider: ${overlay.providerName} (${protocolLabel(overlay.protocol || "openai")}) — effort ${overlay.reasoningEffort}`, dimHorizontalRule(width));
      lines.push("F Fetch all   D Delete   Enter Toggle select   Ctrl+S/Tab Save   Esc Close");
      lines.push("");
      if (overlay.loading) {
        lines.push("  fetching models...");
      } else if (overlay.error) {
        lines.push(`  error: ${truncateVisible(overlay.error, Math.max(1, width - 2))}`);
        lines.push("  press F to retry");
      } else if (overlay.models.length === 0) {
        lines.push("  (no models yet — press F to fetch)");
      } else {
        overlay.models.forEach((model, index) => {
          const mark = model.selected ? "✓" : " ";
          const ctx = model.contextWindow ? `  [ctx ${model.contextWindow}]` : "";
          lines.push(highlightSelection(`${mark} ${truncateVisible(model.id, Math.max(1, width - 4))}${ctx}`, index === overlay.selectedIndex));
        });
      }
      const selectedCount = overlay.models.filter((model) => model.selected).length;
      if (selectedCount > 0) lines.push("", `${selectedCount} selected — Ctrl+S/Tab to save`);
      break;
    }
  }
  return lines;
}
