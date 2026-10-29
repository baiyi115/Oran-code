import type { TranscriptMessage } from "../types.js";

/**
 * A row whose content can still change while a task runs. These are exactly the rows that draw a
 * spinner, the ones Ink Static must not commit yet, and the ones that keep the session "busy";
 * those three questions used to be answered by three separate copies of this predicate.
 */
export function isLiveMessage(message: TranscriptMessage): boolean {
  if (message.kind === "tool") return message.status === "running";
  return (message.kind === "assistant" || message.kind === "thought") && message.streaming === true;
}
