import type { Key } from "ink";
import type { ReasoningEffort } from "../types.js";
import { formatErrorMessage } from "../error-format.js";
import { setOverlay } from "./state.js";
import { appendSystemMessage } from "./message-reducer.js";
import type { ConnectInfoField, ConnectInput, ConnectModelOption, ConnectPrefill, TuiState } from "./types.js";
import { dimHorizontalRule } from "./theme.js";
import { highlightSelection, overlayLine, type OverlayLine } from "./overlay/select-list.js";
import { truncateVisible, visibleWidth } from "./text-width.js";
import { isSubmitKey } from "./keys.js";

export interface ConnectWizardDeps {
  readonly state: TuiState;
  loadRemoteModels?: (
    baseURL: string,
    apiKey: string,
    protocol: "openai" | "anthropic",
  ) => Promise<ConnectModelOption[]>;
  onConnect?: (input: ConnectInput) => Promise<boolean | void>;
  invalidate(): void;
  rejectIfBlocked(message: string): boolean;
}

const INFO_FIELDS: readonly ConnectInfoField[] = ["baseURL", "apiKey", "protocol", "name"];
type ConnectOverlay = Extract<TuiState["overlay"], { kind: "connect" }>;

/** Provider connection form followed by a model list with repeatable per-model settings. */
export class ConnectWizard {
  private fetchGeneration = 0;

  constructor(private readonly deps: ConnectWizardDeps) {}

  open(prefill?: ConnectPrefill): void {
    if (this.deps.rejectIfBlocked("finish or cancel the current task before connecting a provider")) return;
    if (!this.deps.onConnect) return;
    this.fetchGeneration += 1;
    setOverlay(this.deps.state, {
      kind: "connect",
      step: "info",
      activeField: "baseURL",
      providerName: prefill?.providerName ?? "",
      baseURL: prefill?.baseURL ?? "",
      apiKey: prefill?.apiKey ?? "",
      protocol: prefill?.protocol ?? "",
      ...(prefill?.configPath ? { configPath: prefill.configPath } : {}),
      nameTouched: Boolean(prefill),
      protocolTouched: Boolean(prefill),
      models: prefill?.models.map((model) => ({ ...model, selected: true })) ?? [],
      selectedIndex: 0,
      loading: false,
    });
    this.deps.invalidate();
  }

  handleKey(input: string, key: Key): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    if (overlay.saving) return;
    if (overlay.editing) {
      this.handleEditKey(overlay, input, key);
    } else if (key.escape) {
      this.fetchGeneration += 1;
      this.deps.state.overlay = { kind: "none" };
    } else if (overlay.step === "models") {
      if ((key.ctrl && input === "s") || key.tab) void this.confirm();
      else this.handleModelsKey(overlay, input, key);
    } else {
      this.handleInfoKey(input, key);
    }
    this.deps.invalidate();
  }

  private handleInfoKey(input: string, key: Key): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    if (key.leftArrow || key.rightArrow) {
      overlay.protocol = overlay.protocol === "anthropic" ? "openai" : "anthropic";
      overlay.protocolTouched = true;
      return;
    }
    if (key.tab || key.upArrow || key.downArrow) {
      const offset = key.upArrow || (key.tab && key.shift) ? -1 : 1;
      const index = INFO_FIELDS.indexOf(overlay.activeField);
      overlay.activeField = INFO_FIELDS[(index + offset + INFO_FIELDS.length) % INFO_FIELDS.length] ?? "baseURL";
      return;
    }
    if (key.backspace || key.delete) {
      if (overlay.configPath && overlay.activeField === "name") return;
      this.deleteActiveChar(overlay.activeField);
      if (overlay.activeField === "name") overlay.nameTouched = true;
      return;
    }
    if (isSubmitKey(input, key)) {
      this.advanceToModels();
      return;
    }
    if (input && !key.ctrl && !key.meta && input !== "\t") {
      if (overlay.configPath && overlay.activeField === "name") return;
      this.appendActiveChar(overlay.activeField, input);
    }
  }

  private deleteActiveChar(field: ConnectInfoField): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    const trim = (value: string) => Array.from(value).slice(0, -1).join("");
    if (field === "baseURL") overlay.baseURL = trim(overlay.baseURL);
    else if (field === "apiKey") overlay.apiKey = trim(overlay.apiKey);
    else if (field === "name") overlay.providerName = trim(overlay.providerName);
  }

  private appendActiveChar(field: ConnectInfoField, input: string): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    if (input === "\r" || input === "\n") return;
    if (field === "baseURL") {
      overlay.baseURL += input;
      this.autoDeriveFromBaseURL();
    } else if (field === "apiKey") overlay.apiKey += input;
    else if (field === "name") {
      overlay.providerName += input;
      overlay.nameTouched = true;
    }
  }

  private autoDeriveFromBaseURL(): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    const hint = overlay.baseURL.toLowerCase();
    if (!overlay.nameTouched) overlay.providerName = safeHostName(overlay.baseURL);
    if (!overlay.protocolTouched) {
      overlay.protocol = hint.includes("anthropic") || hint.includes("claude") ? "anthropic" : "openai";
    }
  }

  private advanceToModels(): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    if (!overlay.baseURL.trim()) {
      overlay.error = "base URL is required";
      return;
    }
    if (overlay.providerName.includes("/")) {
      overlay.error = "provider name cannot contain /";
      return;
    }
    if (!overlay.providerName.trim()) overlay.providerName = safeHostName(overlay.baseURL);
    if (["__proto__", "constructor", "prototype"].includes(overlay.providerName.trim())) {
      overlay.error = "choose a different provider name";
      return;
    }
    overlay.step = "models";
    overlay.error = undefined;
    overlay.selectedIndex = 0;
    // Reopening saved settings must work offline and must not require a catalog request.
    if (!overlay.models.length && this.deps.loadRemoteModels) void this.fetchModels();
  }

  private async fetchModels(): Promise<void> {
    if (this.deps.state.overlay.kind !== "connect" || !this.deps.loadRemoteModels) return;
    const overlay = this.deps.state.overlay;
    const generation = ++this.fetchGeneration;
    overlay.loading = true;
    overlay.error = undefined;
    this.deps.invalidate();
    try {
      const remote = await this.deps.loadRemoteModels(
        overlay.baseURL.trim(),
        overlay.apiKey.trim(),
        overlay.protocol || "openai",
      );
      if (this.deps.state.overlay !== overlay || generation !== this.fetchGeneration) return;
      const focused = overlay.models[overlay.selectedIndex]?.id;
      const existing = new Map(overlay.models.map((model) => [model.id, model]));
      const merged = new Map<string, ConnectModelOption>();
      for (const model of remote) {
        const prior = existing.get(model.id);
        // A saved or manually edited context wins; otherwise use catalog metadata.
        const next: ConnectModelOption = prior ? { ...model, ...prior } : { ...model, selected: false };
        if (prior?.contextWindowEdited && prior.contextWindow === undefined) delete next.contextWindow;
        merged.set(model.id, next);
      }
      for (const model of overlay.models) {
        if (!merged.has(model.id)) merged.set(model.id, model);
      }
      overlay.models = [...merged.values()];
      overlay.selectedIndex = Math.max(
        0,
        overlay.models.findIndex((model) => model.id === focused),
      );
    } catch (error) {
      if (this.deps.state.overlay !== overlay || generation !== this.fetchGeneration) return;
      overlay.error = formatErrorMessage(error);
    } finally {
      if (this.deps.state.overlay === overlay && generation === this.fetchGeneration) {
        overlay.loading = false;
        this.deps.invalidate();
      }
    }
  }

  private handleModelsKey(overlay: ConnectOverlay, input: string, key: Key): void {
    if (input.toLowerCase() === "b" && !key.ctrl && !key.meta) {
      this.fetchGeneration += 1;
      overlay.loading = false;
      overlay.step = "info";
      overlay.error = undefined;
      return;
    }
    if (overlay.loading) {
      if (input.toLowerCase() === "a" && !key.ctrl && !key.meta) {
        // Manual entry stays available when an endpoint never answers its catalog request.
        this.fetchGeneration += 1;
        overlay.loading = false;
        overlay.editing = { field: "id", value: "" };
      }
      return;
    }
    if (key.upArrow) {
      overlay.selectedIndex = Math.max(0, overlay.selectedIndex - 1);
      return;
    }
    if (key.downArrow) {
      overlay.selectedIndex = Math.min(Math.max(0, overlay.models.length - 1), overlay.selectedIndex + 1);
      return;
    }
    if (key.ctrl || key.meta) return;
    const action = input.toLowerCase();
    if (action === "f") {
      void this.fetchModels();
      return;
    }
    overlay.error = undefined;
    if (action === "a") {
      overlay.editing = { field: "id", value: "" };
      return;
    }
    const selected = overlay.models[overlay.selectedIndex];
    if (!selected) return;
    if (action === "c" || action === "m") {
      const field = action === "c" ? "contextWindow" : "maxTokens";
      overlay.editing = { field, value: selected[field]?.toString() ?? "" };
    } else if (action === "e") {
      const sequence: (ReasoningEffort | "off" | undefined)[] = [undefined, "low", "medium", "high", "xhigh", "off"];
      const current = selected.disableReasoningEffort ? "off" : selected.reasoningEffort;
      const next = sequence[(sequence.indexOf(current) + 1) % sequence.length];
      delete selected.reasoningEffort;
      if (next === "off") selected.disableReasoningEffort = true;
      else {
        // False explicitly overrides a provider-level disabled setting after a manual change.
        selected.disableReasoningEffort = false;
        if (next) selected.reasoningEffort = next;
      }
    } else if (action === "d") {
      overlay.models.splice(overlay.selectedIndex, 1);
      overlay.selectedIndex = Math.min(overlay.selectedIndex, Math.max(0, overlay.models.length - 1));
    } else if (isSubmitKey(input, key) || input === " ") {
      selected.selected = !selected.selected;
    }
  }

  private handleEditKey(overlay: ConnectOverlay, input: string, key: Key): void {
    const editing = overlay.editing!;
    if (key.escape) {
      overlay.editing = undefined;
      overlay.error = undefined;
    } else if (key.ctrl && input === "u") {
      editing.value = "";
    } else if (key.backspace || key.delete) {
      editing.value = Array.from(editing.value).slice(0, -1).join("");
    } else if (isSubmitKey(input, key)) {
      const value = editing.value.trim();
      if (editing.field === "id") {
        if (!value || /[\x00-\x1f\x7f\s]/u.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) {
          overlay.error = "model ID is required; whitespace and reserved names are not allowed";
          return;
        }
        const existing = overlay.models.findIndex((model) => model.id === value);
        if (existing >= 0) {
          overlay.selectedIndex = existing;
          overlay.models[existing]!.selected = true;
        } else {
          overlay.models.push({ id: value, selected: true });
          overlay.selectedIndex = overlay.models.length - 1;
        }
      } else {
        const parsed = value ? Number(value) : undefined;
        if (value && (!/^\d+$/.test(value) || parsed === undefined || !Number.isSafeInteger(parsed) || parsed <= 0)) {
          overlay.error = "enter a positive integer in tokens, or leave blank for the default";
          return;
        }
        const selected = overlay.models[overlay.selectedIndex];
        if (selected) {
          if (parsed === undefined) delete selected[editing.field];
          else selected[editing.field] = parsed;
          if (editing.field === "contextWindow") selected.contextWindowEdited = true;
        }
      }
      overlay.editing = undefined;
      overlay.error = undefined;
    } else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) {
      editing.value += input.replace(/[\r\n\x00-\x1f\x7f]/g, "");
    }
  }

  private async confirm(): Promise<void> {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    if (overlay.loading || overlay.saving || overlay.editing) return;
    const selected = overlay.models
      .filter((model) => model.selected)
      .map(({ contextWindowEdited: _edited, ...model }) => ({ ...model }));
    if (!selected.length) {
      overlay.error = "select at least one model with Enter first";
      return;
    }
    const payload: ConnectInput = {
      providerName: overlay.providerName.trim() || safeHostName(overlay.baseURL, "provider"),
      baseURL: overlay.baseURL.trim(),
      apiKey: overlay.apiKey.trim(),
      protocol: overlay.protocol || "openai",
      ...(overlay.configPath ? { configPath: overlay.configPath } : {}),
      models: selected,
    };
    overlay.saving = true;
    overlay.error = undefined;
    try {
      const ok = await this.deps.onConnect?.(payload);
      if (this.deps.state.overlay !== overlay) return;
      if (ok === false) {
        overlay.error = "provider settings could not be saved or applied; your edits are retained";
        return;
      }
      this.fetchGeneration += 1;
      this.deps.state.overlay = { kind: "none" };
      appendSystemMessage(
        this.deps.state,
        `Connected ${payload.providerName} (${selected.length} model${selected.length === 1 ? "" : "s"}). Settings saved.`,
      );
    } catch (error) {
      if (this.deps.state.overlay === overlay) overlay.error = formatErrorMessage(error);
    } finally {
      overlay.saving = false;
      this.deps.invalidate();
    }
  }
}

function safeHostName(input: string, fallback = "provider"): string {
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const host = url.hostname.replace(/\./g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
    return host || fallback;
  } catch {
    return fallback;
  }
}

export function renderConnectLines(overlay: ConnectOverlay, width: number): OverlayLine[] {
  const protocolLabel = (protocol: "openai" | "anthropic") =>
    protocol === "anthropic" ? "Anthropic Messages" : "OpenAI Chat Completions";
  const lines: OverlayLine[] = [];
  if (overlay.step === "info") {
    const cursor = (field: ConnectInfoField) => (overlay.activeField === field ? "▸" : " ");
    const auto = (touched: boolean) => (touched ? "" : "  (auto)");
    lines.push(
      overlayLine(overlay.configPath ? "Edit provider" : "Add / edit provider"),
      overlayLine(dimHorizontalRule(width)),
    );
    lines.push(overlayLine(`${cursor("baseURL")} Base URL   ${overlay.baseURL || "(e.g. https://api.openai.com/v1)"}`));
    lines.push(
      overlayLine(
        `${cursor("apiKey")} API key    ${overlay.apiKey ? "*".repeat(Math.min(40, overlay.apiKey.length)) : "(optional)"}`,
      ),
    );
    lines.push(
      overlayLine(
        `${cursor("protocol")} Protocol   ${overlay.protocol ? protocolLabel(overlay.protocol) : "(auto)"}${auto(overlay.protocolTouched)}`,
      ),
    );
    lines.push(
      overlayLine(
        `${cursor("name")} Name       ${overlay.providerName || "(auto)"}${overlay.configPath ? "  (fixed)" : auto(overlay.nameTouched)}`,
      ),
    );
    lines.push(overlayLine(""), overlayLine("Tab/↑↓ switch field   ←→ switch protocol   Enter next   Esc close"));
  } else {
    lines.push(
      overlayLine(`Provider: ${overlay.providerName} (${protocolLabel(overlay.protocol || "openai")})`),
      overlayLine(dimHorizontalRule(width)),
      overlayLine("Select models and edit settings"),
      overlayLine("↑↓ Move · Enter Toggle · F Fetch · A Add · D Delete"),
      overlayLine("C Context · M Max output · E Effort · B Back · Ctrl+S/Tab Save · Esc Close"),
      overlayLine(""),
    );
    if (overlay.loading) lines.push(overlayLine("  fetching models..."));
    if (!overlay.models.length)
      lines.push(overlayLine("  No models yet. Press F to fetch or A to add an ID manually."));
    overlay.models.forEach((model, index) => {
      const mark = model.selected ? "✓" : " ";
      const effort = model.disableReasoningEffort ? "off" : (model.reasoningEffort ?? "default (medium)");
      const badges = ` [effort ${effort}] [ctx ${model.contextWindow ?? "default"}] [out ${model.maxTokens ?? "default"}]`;
      const idBudget = width - 2 - visibleWidth(badges);
      const focused = index === overlay.selectedIndex && !overlay.editing && !overlay.error;
      if (idBudget >= 12) {
        lines.push(highlightSelection(`${mark} ${truncateVisible(model.id, idBudget)}${badges}`, focused));
      } else {
        lines.push(highlightSelection(`${mark} ${truncateVisible(model.id, Math.max(1, width - 2))}`, focused));
        if (focused) lines.push(overlayLine(`  ${badges.trim()}`));
      }
    });
    const selectedCount = overlay.models.filter((model) => model.selected).length;
    lines.push(overlayLine(""), overlayLine(`${selectedCount} selected — Ctrl+S/Tab to save`));
    if (overlay.editing) {
      const label =
        overlay.editing.field === "id"
          ? "Model ID"
          : overlay.editing.field === "contextWindow"
            ? "Context window (tokens)"
            : "Max output (tokens)";
      lines.push(
        overlayLine(""),
        highlightSelection(`${label}: ${overlay.editing.value}▏`, !overlay.error),
        overlayLine(
          `Enter Apply · Ctrl+U Clear · Esc Cancel${overlay.editing.field === "id" ? "" : " · blank = default"}`,
        ),
      );
    }
    if (overlay.saving) lines.push(overlayLine("Saving settings..."));
  }
  if (overlay.configPath) lines.push(overlayLine(`Config: ${overlay.configPath}`));
  if (overlay.error)
    lines.push(
      overlayLine(""),
      highlightSelection(`error: ${truncateVisible(overlay.error, Math.max(1, width - 7))}`, true),
    );
  return lines;
}
