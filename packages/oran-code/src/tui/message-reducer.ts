import { redactSecretText, redactSecrets } from "./interaction.js";
import { appendTranscriptMessage, getToolMessage } from "./state.js";
import type { TuiState } from "./types.js";
import type { RuntimeEvent, ToolCall, ToolResult, VerificationResult } from "../types.js";

export function reduceRuntimeEvent(state: TuiState, event: RuntimeEvent): void {
  if (event.type === "context_compaction") {
    const contextSequenceKey = `${event.taskId}:${event.sequence}`;
    if (state.processedSequences.has(contextSequenceKey)) return;
    state.processedSequences.add(contextSequenceKey);
    reduceContextCompaction(state, event);
    return;
  }
  if (state.retiredTaskIds.has(event.taskId)) return;
  if (event.taskId !== state.activeTaskId) {
    if (state.activeTaskId) {
      finishRunningTools(state, state.activeTaskId, "cancelled", "superseded by a new task");
      state.retiredTaskIds.add(state.activeTaskId);
    }
    finishAssistant(state);
    finishThought(state);
    state.activeTaskId = event.taskId;
    state.lastSequence = 0;
    state.activeTaskUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    state.processedSequences.clear();
  }
  const sequenceKey = `${event.taskId}:${event.sequence}`;
  if (state.processedSequences.has(sequenceKey)) return;
  if (event.sequence < state.lastSequence) return;
  state.processedSequences.add(sequenceKey);
  state.lastSequence = event.sequence;
  switch (event.type) {
    case "state":
      if ((event.state === "planning" || event.state === "executing")
        && ["ready", "completed", "failed", "cancelled", "paused"].includes(state.session.taskState)) {
        state.session.startedAt = Date.now();
        state.session.elapsedMs = undefined;
        state.session.currentTool = undefined;
      }
      state.session.taskState = event.state;
      state.session.status = event.state;
      if (event.state === "planning" || event.state === "executing" || event.state === "verifying") {
        state.session.startedAt ??= Date.now();
      }
      if (event.state === "completed" || event.state === "failed" || event.state === "cancelled" || event.state === "paused") {
       state.session.elapsedMs = state.session.startedAt === undefined ? undefined : Math.max(0, Date.now() - state.session.startedAt);
       state.session.currentTool = undefined;
     }
      break;
    case "assistant_start":
      if (state.streaming && state.assistantMessageId) break;
      if (event.turnId && findAssistantByTurnId(state, event.turnId, event.taskId)) break;
      finishAssistant(state);
      state.streaming = true;
      state.session.currentStep = event.step;
      state.assistantMessageId = appendTranscriptMessage(state, {
        kind: "assistant",
        text: "",
        streaming: true,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        taskId: event.taskId,
      });
      break;
    case "assistant_delta": {
      const assistant = ensureAssistant(state, event.turnId, event.taskId);
      assistant.text = stripPlanCompleteMarkers(assistant.text + redactSecretText(event.text));
      assistant.streaming = true;
      state.streaming = true;
      state.session.currentStep = event.step;
      break;
    }
    case "assistant_end": {
      const assistant = activeAssistant(state, event.turnId, event.taskId);
      if (!assistant && hasCompletedAssistant(state, event.turnId, event.taskId)) break;
      const target = assistant ?? ensureAssistant(state, event.turnId, event.taskId);
      target.text = stripPlanCompleteMarkers(redactSecretText(event.text));
      target.streaming = false;
      state.streaming = false;
      const usage = usageDelta(event.usage);
      state.session.usage = addUsage(state.session.usage, usage);
      state.activeTaskUsage = addUsage(state.activeTaskUsage, usage);
      state.assistantMessageId = undefined;
      if (!target.text.trim() && event.toolCalls.length) removeTranscriptMessage(state, target.id);
      break;
    }
    case "assistant_abort": {
      const assistant = activeAssistant(state, event.turnId, event.taskId);
      if (!assistant && hasCompletedAssistant(state, event.turnId, event.taskId)) break;
      const target = assistant ?? ensureAssistant(state, event.turnId, event.taskId);
      const abortMessage = redactSecretText(event.message);
      target.text = `${target.text}${target.text ? "\n" : ""}[${abortMessage}]`;
      target.abortMessage = abortMessage;
      target.streaming = false;
      state.streaming = false;
      state.assistantMessageId = undefined;
      break;
    }
    case "thought_start":
      finishThought(state);
      state.thoughtMessageId = appendTranscriptMessage(state, {
        kind: "thought",
        text: "",
        streaming: true,
        expanded: true,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        taskId: event.taskId,
      });
      placeThoughtBeforeAssistant(state, state.thoughtMessageId, event.turnId, event.taskId);
      break;
    case "thought_delta": {
      const thought = ensureThought(state, event.taskId, event.turnId);
      thought.text += redactSecretText(event.text);
      thought.streaming = true;
      break;
    }
    case "thought_end": {
      const thought = ensureThought(state, event.taskId, event.turnId);
      const text = redactSecretText(event.text).trim() || thought.text.trim();
      // Providers sometimes open a reasoning channel and send nothing usable.
      if (!text) {
        removeTranscriptMessage(state, thought.id);
        state.thoughtMessageId = undefined;
        break;
      }
      thought.text = text;
      thought.durationMs = event.durationMs;
      thought.streaming = false;
      // Finished thoughts stay compact by default; Ctrl+O expands the full chain.
      thought.expanded = false;
      state.thoughtMessageId = undefined;
      break;
    }
    case "plan":
      if (!event.streamed) appendTranscriptMessage(state, { kind: "plan", text: redactSecretText(event.plan) });
      break;
    case "plan_complete": {
      // Assistant stream already rendered the plan body. Strip protocol markers
      // from the last assistant row and avoid a second plan block.
      const cleaned = redactSecretText(event.plan).trim();
      const lastAssistant = [...state.transcript].reverse().find((message) => message.kind === "assistant" && message.taskId === event.taskId);
      if (lastAssistant && lastAssistant.kind === "assistant") {
        lastAssistant.text = cleaned || stripPlanCompleteMarkers(lastAssistant.text);
        lastAssistant.streaming = false;
      } else if (cleaned) {
        appendTranscriptMessage(state, { kind: "plan", text: cleaned });
      }
      appendTranscriptMessage(state, {
        kind: "system",
        text: event.autoExecute
          ? "Plan complete. Switching to auto mode and executing..."
          : "Plan complete. Waiting for execution.",
      });
      if (event.autoExecute) {
        state.session.workMode = "auto";
        state.session.permissionMode = "default";
        state.session.status = "executing plan";
      } else {
        state.session.status = "plan ready";
      }
      break;
    }
    case "tool_start":
      appendToolStart(state, event.call, event.permissionLevel, event.timestamp, event.taskId);
      state.session.currentTool = event.call.name;
      finishAssistant(state);
      break;
    case "tool_result":
      updateToolResult(state, event.call, event.result, event.taskId);
      state.session.currentTool = undefined;
      break;
    case "verify":
      appendTranscriptMessage(state, { kind: "verification", results: event.results.map(redactVerification) });
      state.session.status = "verifying";
      break;
    case "retry": {
      const detail = redactSecretText(event.message).trim() || "request failed";
      // Show the failure as it happens so the user sees why the agent paused,
      // then note that another attempt is starting.
      appendTranscriptMessage(state, {
        kind: "error",
        text: `Attempt ${event.attempt + 1}/${event.maxRetries + 1} failed: ${detail}`,
      });
      appendTranscriptMessage(state, {
        kind: "system",
        text: `Retrying (${event.nextAttempt}/${event.maxRetries})...`,
      });
      state.session.status = `retrying (${event.nextAttempt}/${event.maxRetries})`;
      break;
    }
    case "error": {
      const detail = redactSecretText(event.message);
      finishRunningTools(state, event.taskId, "failure", `stopped: ${detail}`);
      finishAssistant(state);
      finishThought(state);
      appendTranscriptMessage(state, { kind: "error", text: detail });
      state.session.status = "error";
      state.session.taskState = "failed";
      state.retiredTaskIds.add(event.taskId);
      break;
    }
    case "completed":
      finishRunningTools(state, event.taskId, "failure", "ended without a tool result");
      state.session.taskState = "completed";
      state.session.status = `completed in ${event.steps} step(s), ${event.tokensUsed} token(s)`;
      if (event.tokensUsed > state.activeTaskUsage.totalTokens) {
        state.session.usage.totalTokens += event.tokensUsed - state.activeTaskUsage.totalTokens;
        state.activeTaskUsage.totalTokens = event.tokensUsed;
      }
      state.session.elapsedMs = state.session.startedAt === undefined ? undefined : Math.max(0, Date.now() - state.session.startedAt);
      finishAssistant(state);
      finishThought(state);
      state.retiredTaskIds.add(event.taskId);
      break;
    case "cancelled":
      finishRunningTools(state, event.taskId, "cancelled", "cancelled");
      state.session.taskState = "cancelled";
      state.session.status = `cancelled: ${redactSecretText(event.message)}`;
      state.session.elapsedMs = state.session.startedAt === undefined ? undefined : Math.max(0, Date.now() - state.session.startedAt);
      finishAssistant(state);
      finishThought(state);
      state.retiredTaskIds.add(event.taskId);
      break;
    case "log":
      appendTranscriptMessage(state, { kind: "system", text: redactSecretText(event.message) });
      break;
    case "approval_request":
      state.session.status = "approval required";
      break;
  }
}

function reduceContextCompaction(
  state: TuiState,
  event: Extract<RuntimeEvent, { type: "context_compaction" }>,
): void {
  const replacementSuffix = (event.replacementCount ?? 0) > 0
    ? `; offloaded ${event.replacementCount} tool result(s)`
    : "";
  switch (event.phase) {
    case "started": {
      const message = event.reason === "emergency"
        ? "Context limit reached; compacting before retry..."
        : "Compacting context...";
      appendTranscriptMessage(state, { kind: "system", text: message });
      state.session.status = message.replace(/\.\.\.$/, "");
      break;
    }
    case "completed": {
      const change = event.beforeTokens !== undefined && event.afterTokens !== undefined
        ? `about ${event.beforeTokens} -> ${event.afterTokens} tokens`
        : "token estimate unavailable";
      appendTranscriptMessage(state, {
        kind: "system",
        text: `Context compacted: ${change}${replacementSuffix}.`,
      });
      state.session.status = runningTaskStatus(state) ?? "context compacted";
      break;
    }
    case "offloaded": {
      if ((event.replacementCount ?? 0) > 0) {
        appendTranscriptMessage(state, {
          kind: "system",
          text: `Offloaded ${event.replacementCount} large tool result(s) from active context.`,
        });
      }
      if (event.message) {
        appendTranscriptMessage(state, {
          kind: "error",
          text: `Tool-result offload was incomplete: ${redactSecretText(event.message)}`,
        });
      }
      state.session.status = runningTaskStatus(state) ?? (event.message ? "context offload incomplete" : "context offloaded");
      break;
    }
    case "failed": {
      const detail = redactSecretText(event.message ?? "unknown compaction error");
      const cancelled = /cancelled|canceled|aborted/i.test(detail);
      appendTranscriptMessage(state, {
        kind: cancelled ? "system" : "error",
        text: cancelled ? detail : `Context compaction failed (${event.reason}): ${detail}`,
      });
      state.session.status = event.reason === "manual"
        ? cancelled ? "context compaction cancelled" : "context compaction failed"
        : runningTaskStatus(state) ?? (cancelled ? "context compaction cancelled" : "context compaction failed");
      break;
    }
  }
}

function runningTaskStatus(state: TuiState): string | undefined {
  return state.session.taskState === "planning"
    || state.session.taskState === "executing"
    || state.session.taskState === "verifying"
    || state.session.taskState === "awaiting_approval"
    ? state.session.taskState
    : undefined;
}

export function appendUserMessage(state: TuiState, prompt: string, queued = false): void {
  finishAssistant(state);
  finishThought(state);
  appendTranscriptMessage(state, { kind: "user", text: redactSecretText(prompt), ...(queued ? { queued: true } : {}) });
}

export function appendSystemMessage(state: TuiState, text: string, kind: "system" | "plan" | "error" = "system"): void {
  finishAssistant(state);
  appendTranscriptMessage(state, { kind, text: redactSecretText(text) });
}

function appendToolStart(state: TuiState, call: ToolCall, permissionLevel: number, startedAt: string, taskId?: string): void {
  const callId = toolCallKey(call);
  if (getToolMessage(state, callId, taskId)) return;
  appendTranscriptMessage(state, {
    kind: "tool",
    callId,
    name: call.name,
    arguments: redactSecrets(call.arguments) as Record<string, unknown>,
    permissionLevel,
    status: "running",
    startedAt,
    expanded: false,
    ...(taskId ? { taskId } : {}),
  });
}

function updateToolResult(state: TuiState, call: ToolCall, result: ToolResult, taskId?: string): void {
  const callId = toolCallKey(call);
  const tool = getToolMessage(state, callId, taskId);
  if (!tool) {
    appendToolStart(state, call, 0, new Date().toISOString(), taskId);
  }
  const target = getToolMessage(state, callId, taskId);
  if (!target) return;
  if (target.status !== "running") return;
  target.status = result.ok ? "success" : isCancelled(result) ? "cancelled" : isRejected(result) ? "rejected" : "failure";
  if (result.durationMs === undefined) delete target.durationMs;
  else target.durationMs = result.durationMs;
  target.summary = redactSecretText(result.summary ?? result.error ?? (result.ok ? "ok" : "failed"));
  if (result.output) target.output = redactSecretText(result.output);
  else delete target.output;
  if (result.error) target.error = redactSecretText(result.error);
  else delete target.error;
}

function ensureAssistant(state: TuiState, turnId?: string, taskId?: string): Extract<TuiState["transcript"][number], { kind: "assistant" }> {
  const current = state.assistantMessageId
    ? state.transcript.find((message) => message.id === state.assistantMessageId)
    : undefined;
  if (current?.kind === "assistant"
    && (turnId === undefined || current.turnId === turnId)
    && (taskId === undefined || current.taskId === taskId)) return current;
  if (current?.kind === "assistant") finishAssistant(state);
  const id = appendTranscriptMessage(state, {
    kind: "assistant",
    text: "",
    streaming: true,
    ...(turnId ? { turnId } : {}),
    ...(taskId ? { taskId } : {}),
  });
  state.assistantMessageId = id;
  return state.transcript.find((message) => message.id === id)! as Extract<TuiState["transcript"][number], { kind: "assistant" }>;
}

function activeAssistant(
  state: TuiState,
  turnId?: string,
  taskId?: string,
): Extract<TuiState["transcript"][number], { kind: "assistant" }> | undefined {
  const current = state.assistantMessageId
    ? state.transcript.find((message) => message.id === state.assistantMessageId)
    : undefined;
  if (current?.kind !== "assistant") return undefined;
  if (turnId !== undefined && current.turnId !== turnId) return undefined;
  if (taskId !== undefined && current.taskId !== taskId) return undefined;
  return current;
}

function findAssistantByTurnId(
  state: TuiState,
  turnId: string,
  taskId?: string,
): Extract<TuiState["transcript"][number], { kind: "assistant" }> | undefined {
  const message = [...state.transcript].reverse().find((entry) => entry.kind === "assistant" && entry.turnId === turnId && entry.taskId === taskId);
  return message?.kind === "assistant" ? message : undefined;
}

function hasCompletedAssistant(state: TuiState, turnId?: string, taskId?: string): boolean {
  if (turnId) return Boolean(findAssistantByTurnId(state, turnId, taskId));
  return [...state.transcript].reverse().some((entry) => entry.kind === "assistant" && entry.taskId === taskId && !entry.streaming);
}

function finishAssistant(state: TuiState): void {
  state.streaming = false;
  if (state.assistantMessageId) {
    const message = state.transcript.find((entry) => entry.id === state.assistantMessageId);
    if (message?.kind === "assistant") {
      message.streaming = false;
      if (!message.text.trim()) removeTranscriptMessage(state, message.id);
    }
  }
  state.assistantMessageId = undefined;
}

function ensureThought(
  state: TuiState,
  taskId?: string,
  turnId?: string,
): Extract<TuiState["transcript"][number], { kind: "thought" }> {
  const current = state.thoughtMessageId
    ? state.transcript.find((message) => message.id === state.thoughtMessageId)
    : undefined;
  if (current?.kind === "thought"
    && (turnId === undefined || current.turnId === turnId)
    && (taskId === undefined || current.taskId === taskId)) return current;
  if (current?.kind === "thought") finishThought(state);
  const id = appendTranscriptMessage(state, {
    kind: "thought",
    text: "",
    streaming: true,
    expanded: true,
    ...(turnId ? { turnId } : {}),
    ...(taskId ? { taskId } : {}),
  });
  state.thoughtMessageId = id;
  placeThoughtBeforeAssistant(state, id, turnId, taskId);
  return state.transcript.find((message) => message.id === id)! as Extract<TuiState["transcript"][number], { kind: "thought" }>;
}

function placeThoughtBeforeAssistant(state: TuiState, thoughtId: string, turnId?: string, taskId?: string): void {
  const thoughtIndex = state.transcript.findIndex((message) => message.id === thoughtId);
  if (thoughtIndex < 0) return;

  const assistantId = turnId
    ? findAssistantByTurnId(state, turnId, taskId)?.id
    : state.assistantMessageId;
  if (!assistantId) return;

  const assistantIndex = state.transcript.findIndex((message) => message.id === assistantId);
  if (assistantIndex < 0 || thoughtIndex < assistantIndex) return;

  const [thought] = state.transcript.splice(thoughtIndex, 1);
  if (!thought) return;
  const insertionIndex = state.transcript.findIndex((message) => message.id === assistantId);
  if (insertionIndex >= 0) state.transcript.splice(insertionIndex, 0, thought);
}

function finishThought(state: TuiState): void {
  if (state.thoughtMessageId) {
    const message = state.transcript.find((entry) => entry.id === state.thoughtMessageId);
    if (message?.kind === "thought") {
      message.streaming = false;
      message.expanded = false;
      if (!message.text.trim()) removeTranscriptMessage(state, message.id);
    }
  }
  state.thoughtMessageId = undefined;
}

function finishRunningTools(
  state: TuiState,
  taskId: string,
  status: "failure" | "cancelled",
  summary: string,
): void {
  for (const message of state.transcript) {
    if (message.kind !== "tool" || message.taskId !== taskId || message.status !== "running") continue;
    message.status = status;
    message.summary = summary;
  }
  state.session.currentTool = undefined;
}

function removeTranscriptMessage(state: TuiState, id: string): void {
  const index = state.transcript.findIndex((entry) => entry.id === id);
  if (index >= 0) state.transcript.splice(index, 1);
}

function usageDelta(next: Record<string, number>): TuiState["session"]["usage"] {
  const input = numberFrom(next, "input_tokens", "prompt_tokens", "inputTokens");
  const output = numberFrom(next, "output_tokens", "completion_tokens", "outputTokens");
  const reportedTotal = numberFrom(next, "total_tokens", "totalTokens");
  const cacheRead = numberFrom(next, "cache_read_input_tokens", "cache_read_tokens", "cached_tokens", "cacheReadTokens");
  const cacheWrite = numberFrom(next, "cache_creation_input_tokens", "cache_write_tokens", "cacheWriteTokens");
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  const totalTokens = reportedTotal ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
  };
}

function addUsage(current: TuiState["session"]["usage"], delta: TuiState["session"]["usage"]): TuiState["session"]["usage"] {
  return {
    inputTokens: current.inputTokens + delta.inputTokens,
    outputTokens: current.outputTokens + delta.outputTokens,
    totalTokens: current.totalTokens + delta.totalTokens,
    cacheReadTokens: current.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + delta.cacheWriteTokens,
  };
}

function numberFrom(value: Record<string, number>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const number = value[key];
    if (typeof number === "number" && Number.isFinite(number)) return Math.max(0, number);
  }
  return undefined;
}

function isRejected(result: ToolResult): boolean {
  return result.metadata?.blockedBeforeExecution === true
    || /reject|denied|permission/i.test(`${result.summary ?? ""} ${result.error ?? ""}`);
}

function isCancelled(result: ToolResult): boolean {
  return result.metadata?.cancelled === true || /cancelled|canceled|aborted/i.test(`${result.summary ?? ""} ${result.error ?? ""}`);
}

function redactVerification(result: VerificationResult): VerificationResult {
  return { ...result, command: redactSecretText(result.command), output: redactSecretText(result.output) };
}


const PLAN_COMPLETE_MARKERS = [
  "PLAN_COMPLETE",
  "<<PLAN_COMPLETE>>",
  "<plan_complete>",
  "</plan_complete>",
] as const;

function stripPlanCompleteMarkers(text: string): string {
  let plan = text.replace(/\r/g, "");
  for (const marker of PLAN_COMPLETE_MARKERS) {
    plan = plan.split(marker).join("");
  }
  const lines = plan.split(/\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^plan\s+complete$/i.test(trimmed)) continue;
    kept.push(line);
  }
  // Drop trailing blank lines left by removed markers, but preserve internal blanks.
  while (kept.length && kept[kept.length - 1]?.trim() === "") kept.pop();
  return kept.join("\n");
}

function toolCallKey(call: ToolCall): string {
  return call.id ?? `${call.name}:${call.createdAt}`;
}
