/** 会话命名与提示词标题派生:从 session-store 拆出的纯函数层。 */
import type { Message } from "./types.js";
import type { StoredSession } from "./session-store.js";
import type { SessionTitleMode } from "./types.js";

export const DEFAULT_SESSION_NAMES = new Set(["Current session", "New session"]);

export function archivePrompt(value: string): string | undefined {
  const normalized = normalizeSessionPrompt(extractConversationPrompt(value));
  return normalized ? truncateSessionName(normalized, 48) : undefined;
}

/** Keep persisted semantic/manual names, otherwise derive a stable local title. */
export function displaySessionName(
  session: Pick<StoredSession, "name" | "autoNamed" | "titleSource" | "messages" | "archiveTitle">,
  mode: SessionTitleMode = "local",
): string {
  if (!isAutomaticSessionName(session)) return session.name;
  if (session.titleSource === "model") return session.name;
  if (session.archiveTitle) return session.archiveTitle;
  const prompts = session.messages
    .filter((message) => message.kind === "user")
    .map((message) => normalizeSessionPrompt(message.text))
    .filter(Boolean);
  const prompt = mode === "first-message" ? prompts[0] : (prompts.find((value) => !isGreeting(value)) ?? prompts[0]);
  return prompt ? truncateSessionName(prompt, 48) : session.name;
}

export function isAutomaticSessionName(session: Pick<StoredSession, "name" | "autoNamed">): boolean {
  return session.autoNamed ?? DEFAULT_SESSION_NAMES.has(session.name);
}

export function firstConversationPrompt(messages: readonly Message[]): string | undefined {
  const prompts = messages
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => normalizeSessionPrompt(extractConversationPrompt(message.content ?? "")))
    .filter(Boolean);
  return prompts.find((value) => !isGreeting(value)) ?? prompts[0];
}

function extractConversationPrompt(value: string): string {
  const marker = "\n\nUser message:\n";
  const index = value.lastIndexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

function normalizeSessionPrompt(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isGreeting(value: string): boolean {
  return /^(?:hi|hello|hey|你好|您好|嗨|在吗)[!！,.，。?？\s]*$/i.test(value);
}

export function truncateSessionName(value: string, maximumCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maximumCharacters
    ? value
    : `${characters.slice(0, Math.max(1, maximumCharacters - 1)).join("")}…`;
}
