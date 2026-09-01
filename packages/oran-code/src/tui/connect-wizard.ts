import type { Key } from "ink";
import type { ReasoningEffort } from "../types.js";
import { formatErrorMessage } from "../error-format.js";
import { setOverlay } from "./state.js";
import type { ConnectInfoField, ConnectInput, ConnectModelOption, ConnectPrefill, TuiState } from "./types.js";
import { dimHorizontalRule } from "./theme.js";
import { highlightSelection } from "./overlay/select-list.js";
import { truncateVisible } from "./text-width.js";
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

/**
 * 「添加/编辑模型提供商」两屏向导:info 表单(baseURL/apiKey/protocol/name 同屏,
 * protocol 与 name 从 baseURL 自动推导) → models 多选。思考等级不在此询问,
 * 统一按 high 写入,端点拒绝时由 provider 层剥参回退。状态完全存放在
 * state.overlay 的 connect 变体。
 */
export class ConnectWizard {
  constructor(private readonly deps: ConnectWizardDeps) {}

  open(prefill?: ConnectPrefill): void {
    if (this.deps.rejectIfBlocked("finish or cancel the current task before connecting a provider")) return;
    if (!this.deps.onConnect || !this.deps.loadRemoteModels) return;
    setOverlay(this.deps.state, {
      kind: "connect",
      step: "info",
      activeField: "baseURL",
      providerName: prefill?.providerName ?? "",
      baseURL: prefill?.baseURL ?? "",
      apiKey: prefill?.apiKey ?? "",
      protocol: prefill?.protocol ?? "",
      nameTouched: Boolean(prefill),
      protocolTouched: Boolean(prefill),
      models: prefill
        ? prefill.models.map((model) => ({
            id: model.id,
            selected: true,
            ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          }))
        : [],
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

    this.handleInfoKey(input, key);
    this.deps.invalidate();
  }

  private handleInfoKey(input: string, key: Key): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;

    // 左右键在 info 屏任意字段下都切换协议(文本字段不支持光标移动,无冲突)。
    if (key.leftArrow || key.rightArrow) {
      overlay.protocol = overlay.protocol === "anthropic" ? "openai" : "anthropic";
      overlay.protocolTouched = true;
      return;
    }

    // Tab / 上下键在四个字段间移动光标。
    if (key.tab || key.upArrow || key.downArrow) {
      const offset = key.upArrow ? -1 : 1;
      const index = INFO_FIELDS.indexOf(overlay.activeField);
      overlay.activeField = INFO_FIELDS[(index + offset + INFO_FIELDS.length) % INFO_FIELDS.length] ?? "baseURL";
      return;
    }

    if (key.backspace || key.delete) {
      this.deleteActiveChar(overlay.activeField);
      if (overlay.activeField === "name") overlay.nameTouched = true;
      return;
    }

    if (isSubmitKey(input, key)) {
      this.advanceToModels();
      return;
    }
    if (input && !key.ctrl && !key.meta && input !== "\t") {
      this.appendActiveChar(overlay.activeField, input);
    }
  }

  private deleteActiveChar(field: ConnectInfoField): void {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    const trim = (value: string) => (value.length ? value.slice(0, -1) : value);
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

  /** baseURL 变化时自动推导 protocol 与 name,用户手动改过(预填编辑)则跳过。 */
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
    if (!overlay.providerName.trim()) overlay.providerName = safeHostName(overlay.baseURL);
    overlay.step = "models";
    overlay.error = undefined;
    overlay.selectedIndex = 0;
    void this.fetchModels();
  }

  private async fetchModels(): Promise<void> {
    if (this.deps.state.overlay.kind !== "connect") return;
    const overlay = this.deps.state.overlay;
    const protocol = (overlay.protocol || "openai") as "openai" | "anthropic";
    overlay.loading = true;
    overlay.error = undefined;
    this.deps.invalidate();
    try {
      const remote =
        (await this.deps.loadRemoteModels?.(overlay.baseURL.trim(), overlay.apiKey.trim(), protocol)) ?? [];
      if (this.deps.state.overlay.kind !== "connect") return;
      const existing = new Map(this.deps.state.overlay.models.map((model) => [model.id, model]));
      this.deps.state.overlay.models = remote.map((model): ConnectModelOption => {
        const prior = existing.get(model.id);
        const next: ConnectModelOption = { id: model.id, selected: prior?.selected ?? false };
        if (model.contextWindow !== undefined) next.contextWindow = model.contextWindow;
        if (prior?.reasoningEffort) next.reasoningEffort = prior.reasoningEffort;
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
    if (input === "e" || input === "E") {
      const selected = options[overlay.selectedIndex];
      if (selected) {
        // 未指定(默认 high) → low → medium → high → xhigh → 回到未指定。
        const sequence: (ReasoningEffort | undefined)[] = [undefined, "low", "medium", "high", "xhigh"];
        const at = sequence.indexOf(selected.reasoningEffort);
        const next = sequence[(at + 1) % sequence.length];
        if (next) selected.reasoningEffort = next;
        else delete selected.reasoningEffort;
      }
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
      models: selected,
    };
    try {
      const ok = await this.deps.onConnect?.(payload);
      this.deps.state.overlay = { kind: "none" };
      const activeModel = selected[0]?.id ? `${payload.providerName}/${selected[0].id}` : undefined;
      this.deps.state.session.status =
        ok === false
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

export function renderConnectLines(
  overlay: Extract<TuiState["overlay"], { kind: "connect" }>,
  width: number,
): string[] {
  function protocolLabel(protocol: "openai" | "anthropic"): string {
    return protocol === "anthropic" ? "Anthropic Messages" : "OpenAI Chat Completions";
  }
  const lines: string[] = [];
  if (overlay.step === "info") {
    const cursor = (field: ConnectInfoField) => (overlay.activeField === field ? "▸" : " ");
    const auto = (touched: boolean) => (touched ? "" : "  (auto)");
    lines.push("Add provider", dimHorizontalRule(width));
    lines.push(`${cursor("baseURL")} Base URL   ${overlay.baseURL || "(e.g. https://api.openai.com/v1)"}`);
    lines.push(
      `${cursor("apiKey")} API key    ${overlay.apiKey ? "*".repeat(Math.min(40, overlay.apiKey.length)) : "(optional)"}`,
    );
    lines.push(
      `${cursor("protocol")} Protocol   ${overlay.protocol ? protocolLabel(overlay.protocol) : "(auto)"}${auto(overlay.protocolTouched)}`,
    );
    lines.push(`${cursor("name")} Name       ${overlay.providerName || "(auto)"}${auto(overlay.nameTouched)}`);
    lines.push("", "Tab/↑↓ switch field   ←→ switch protocol   Enter next   Esc close");
    if (overlay.error) lines.push("", `error: ${truncateVisible(overlay.error, Math.max(1, width - 2))}`);
    return lines;
  }
  lines.push(
    `Provider: ${overlay.providerName} (${protocolLabel(overlay.protocol || "openai")})`,
    dimHorizontalRule(width),
  );
  lines.push("选择模型");
  lines.push("F Fetch all   E Effort   D Delete   Enter Toggle select   Ctrl+S/Tab Save   Esc Close");
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
      const effort = `  [effort ${model.reasoningEffort ?? "high"}]`;
      const ctx = model.contextWindow ? `  [ctx ${model.contextWindow}]` : "";
      lines.push(
        highlightSelection(
          `${mark} ${truncateVisible(model.id, Math.max(1, width - 4))}${effort}${ctx}`,
          index === overlay.selectedIndex,
        ),
      );
    });
  }
  const selectedCount = overlay.models.filter((model) => model.selected).length;
  if (selectedCount > 0) lines.push("", `${selectedCount} selected — Ctrl+S/Tab to save`);
  return lines;
}
