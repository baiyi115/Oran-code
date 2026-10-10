import type { ModelReference, PermissionMode, UserConfig, WorkMode } from "./types.js";
import type { Message } from "./types.js";
import type { StoredSession } from "./session-store.js";
import { isAutomaticSessionName } from "./session-naming.js";

import type { SessionOption, SessionView } from "./tui/types.js";

/** Derives the initial permission mode from the config and approve-all. */
export function configuredPermissionMode(config: UserConfig, approveAll: boolean): PermissionMode {
  if (config.agent?.workMode === "plan") return "plan";
  return config.agent?.permissionMode ?? (approveAll ? "bypass" : "default");
}

export function workModeForPermission(mode: PermissionMode): WorkMode {
  return mode === "plan" ? "plan" : "auto";
}

export const SESSION_GAP_REMINDER_DAYS = 7;

/**
 * Pure mapping logic for the session lifecycle, kept separate from TerminalSession's state
 * orchestration.
 * Stateful switch/persistence flows stay in session (those are core session responsibilities anyway).
 */

/** StoredSession → TUI session view; display name and active model reference are resolved by the
 *  caller and passed in. */
export function toSessionView(
  stored: StoredSession,
  options: {
    displayName: string;
    activeModelReference?: ModelReference;
    activeModelWarning?: string;
  },
): SessionView {
  return {
    id: stored.id,
    name: options.displayName,
    messages: stored.messages,
    history: stored.history,
    ...(stored.workMode !== undefined ? { workMode: stored.workMode } : {}),
    ...(stored.permissionMode !== undefined ? { permissionMode: stored.permissionMode } : {}),
    ...(stored.reasoningEffort !== undefined ? { reasoningEffort: stored.reasoningEffort } : {}),
    ...(options.activeModelReference !== undefined ? { modelReference: { ...options.activeModelReference } } : {}),
    ...(stored.conversation !== undefined ? { conversation: structuredClone(stored.conversation) } : {}),
    ...(options.activeModelWarning ? { modelWarning: options.activeModelWarning } : {}),
  };
}

/** Session list → selector options; the display name is resolved through a callback (title-mode aware). */
export function sessionOptionsFromStore(
  sessions: readonly StoredSession[],
  currentSessionId: string | undefined,
  displayName: (session: StoredSession) => string,
): SessionOption[] {
  return sessions.map((session) => ({
    id: session.id,
    name: displayName(session),
    updatedAt: session.updatedAt,
    messageCount: session.archiveMessageCount ?? session.conversation?.length ?? session.messages.length,
    isCurrent: session.id === currentSessionId,
  }));
}

/** Reusable-on-cold-start "blank session" test: automatically named and confirmed to have no message body. */
export function isReusableBlankSession(session: StoredSession): boolean {
  if (!isAutomaticSessionName(session) || session.messages.length !== 0) return false;
  // Prefer the derived archive counter written while the body was known.
  if (session.archiveMessageCount !== undefined) return session.archiveMessageCount === 0;
  // Conversation already materialised.
  if (session.conversation !== undefined) return session.conversation.length === 0;
  // Metadata-only open without a known body size must not look blank.
  return false;
}

/** The time-sensitive reminder injected when resuming a session inactive for ≥N days. */
export function createSessionGapReminder(updatedAt: string, now = new Date()): Message | undefined {
  const previous = Date.parse(updatedAt);
  if (!Number.isFinite(previous)) return undefined;
  const elapsedDays = Math.floor((now.getTime() - previous) / 86_400_000);
  if (elapsedDays < SESSION_GAP_REMINDER_DAYS) return undefined;
  return {
    role: "system",
    content: [
      "<system-reminder>",
      `This session was last active on ${new Date(previous).toISOString().slice(0, 10)}, about ${elapsedDays} days ago.`,
      "Re-check time-sensitive assumptions and the current workspace state before continuing unfinished work.",
      "Do not respond to this reminder as a user message.",
      "</system-reminder>",
    ].join("\n"),
    metadata: { promptBlock: "session-gap-reminder", contextManaged: true },
  };
}
