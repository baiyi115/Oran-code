import type { Message } from "./types.js";

/** Synthetic result content for tool calls that were interrupted before a result was recorded. */
export const INTERRUPTED_TOOL_RESULT_CONTENT = "Tool execution was interrupted before a result was recorded.";

/** 消息浅拷贝 + toolCalls/metadata 深拷贝,避免共享可变嵌套结构。 */
export function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCalls ? {
      toolCalls: message.toolCalls.map((call) => ({
        ...call,
        arguments: structuredClone(call.arguments),
      })),
    } : {}),
    ...(message.metadata ? { metadata: structuredClone(message.metadata) } : {}),
  }));
}

export const PLAN_COMPLETE_MARKERS = [
  "PLAN_COMPLETE",
  "<<PLAN_COMPLETE>>",
  "<plan_complete>",
  "</plan_complete>",
] as const;

/** 剥离 plan 完成协议标记(任意位置)与整行的 "plan complete" 提示,并去掉尾部空行。 */
export function stripPlanCompleteMarkers(text: string): string {
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

function validCallId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0;
}

/**
 * Repair a conversation so every assistant tool call has a matching tool result and
 * no tool result is left without a pending call. This is the shared pre-flight
 * normalizer used before provider requests, on session restore and after compaction.
 */
export function repairToolMessagePairs(messages: readonly Message[]): Message[] {
  const seenIds = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) if (validCallId(call.id)) seenIds.add(call.id);
    if (validCallId(message.toolCallId)) seenIds.add(message.toolCallId);
  }

  let fabricated = 0;
  const nextId = (): string => {
    let candidate = `call_interrupted_${fabricated}`;
    fabricated += 1;
    while (seenIds.has(candidate)) {
      candidate = `call_interrupted_${fabricated}`;
      fabricated += 1;
    }
    seenIds.add(candidate);
    return candidate;
  };

  const syntheticResult = (id: string, name: string | undefined): Message => ({
    role: "tool",
    content: INTERRUPTED_TOOL_RESULT_CONTENT,
    toolCallId: id,
    ...(name ? { name } : {}),
    metadata: { repaired: true },
  });

  const output: Message[] = [];
  let pending = new Map<string, string | undefined>();
  const flushPending = (): void => {
    if (!pending.size) return;
    for (const [id, name] of pending) output.push(syntheticResult(id, name));
    pending = new Map();
  };

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      flushPending();
      const toolCalls = message.toolCalls.map((call) => {
        if (validCallId(call.id)) return call;
        return { ...call, id: nextId() };
      });
      pending = new Map(toolCalls.map((call) => [call.id as string, call.name]));
      output.push({ ...structuredClone(message), toolCalls });
      continue;
    }
    if (message.role === "tool") {
      if (validCallId(message.toolCallId) && pending.has(message.toolCallId)) {
        pending.delete(message.toolCallId);
        output.push(structuredClone(message));
        continue;
      }
      continue;
    }
    flushPending();
    output.push(structuredClone(message));
  }
  flushPending();
  return output;
}
