import type { Message } from "./types.js";

/** Synthetic result content for tool calls that were interrupted before a result was recorded. */
export const INTERRUPTED_TOOL_RESULT_CONTENT = "Tool execution was interrupted before a result was recorded.";

/** The fixed wrapper prefix for user input in session history (the controller and the
 * persistence side share this convention). */
export const USER_MESSAGE_PREFIX = "User message:\n";

/** A user interjection injected while a task is running (steering); it is not a standalone
 * turn that can be rewound. */
export const STEERING_MESSAGE_PREFIX = "[User steering guidance";

export function isSteeringMessage(message: Message): boolean {
  return message.role === "user" && (message.content ?? "").startsWith(STEERING_MESSAGE_PREFIX);
}

/** A turn the user started (including the variant carrying the "previous task completed"
 * prefix), used for turn grouping and conversation-level rewind. */
export function isUserTurnMessage(message: Message): boolean {
  if (message.role !== "user" || isSteeringMessage(message)) return false;
  return (message.content ?? "").includes(USER_MESSAGE_PREFIX);
}

/** Lists the start indices of user turns in order of appearance, for /rewind to pick a
 * rollback point. */
export function userTurnIndices(messages: readonly Message[]): number[] {
  const indices: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (isUserTurnMessage(message)) indices.push(index);
  }
  return indices;
}

/** Shallow-copies messages plus a deep copy of toolCalls/metadata, so mutable nested
 * structures are not shared. */
export function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            arguments: structuredClone(call.arguments),
          })),
        }
      : {}),
    ...(message.metadata ? { metadata: structuredClone(message.metadata) } : {}),
  }));
}

export const PLAN_COMPLETE_MARKERS = [
  "PLAN_COMPLETE",
  "<<PLAN_COMPLETE>>",
  "<plan_complete>",
  "</plan_complete>",
] as const;

/** Strips the plan-completion protocol markers (anywhere in the text) and whole-line
 * "plan complete" notices, then drops the trailing blank lines. */
export function stripPlanCompleteMarkers(text: string): string {
  let plan = text.replace(/\r/g, "");
  // Longest first: the bare "PLAN_COMPLETE" is a prefix of the bracketed forms, and
  // removing it first left their punctuation behind — the text showed "<<>>".
  for (const marker of [...PLAN_COMPLETE_MARKERS].sort((left, right) => right.length - left.length)) {
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
