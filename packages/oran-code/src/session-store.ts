import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { TranscriptMessage } from "./tui/types.js";
import type { Message, ModelReference, SessionTitleMode } from "./types.js";
import { isPermissionMode, isReasoningEffort, type PermissionMode, type ReasoningEffort, type WorkMode } from "./types.js";
import { ensureProjectStateRoot, projectStateRoot } from "./paths.js";

export type SessionTitleSource = "local" | "model" | "manual";
export interface StoredSession {
  id: string; name: string; autoNamed?: boolean; titleSource?: SessionTitleSource;
  titleGenerationAttempted?: boolean; workspace: string; createdAt: string; updatedAt: string;
  messages: TranscriptMessage[]; history: string[]; workMode?: WorkMode; permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffort; modelReference?: ModelReference; conversation?: Message[];
  /** Derived archive metadata used for metadata-first session listing. */
  archiveMessageCount?: number; archiveTitle?: string; archiveSize?: number;
}
type StoredSessionState = Omit<StoredSession, "conversation">;
export interface SessionStateRecord { type: "state"; timestamp: string; session: StoredSessionState }
export interface SessionMessageRecord extends Message { type: "message"; timestamp: string }
export interface LegacySessionMessageRecord extends Message { timestamp?: string; type?: undefined }
export interface SessionCompactionBoundaryContent { summary?: string; retainedTail?: Message[]; reset?: Message[] }
export interface SessionCompactionBoundaryRecord {
  type: "compaction-boundary"; role: "system"; timestamp: string; content: SessionCompactionBoundaryContent;
}
export interface SessionResetRecord { type: "session-reset"; role: "system"; timestamp: string; content: { messages: Message[] } }
export type SessionJsonlRecord = SessionStateRecord | SessionMessageRecord | LegacySessionMessageRecord | SessionCompactionBoundaryRecord | SessionResetRecord;

const DEFAULT_SESSION_NAMES = new Set(["Current session", "New session"]);
export type StoredSessionPatch = Partial<Pick<StoredSession, "name" | "autoNamed" | "titleSource" | "titleGenerationAttempted" | "messages" | "history" | "workMode" | "permissionMode" | "reasoningEffort" | "conversation">> & { modelReference?: ModelReference | null };

export class SessionStore {
  readonly path: string;
  readonly directory: string;
  private sessions: StoredSession[] = [];
  private readonly mtimes = new Map<string, number>();
  /** Sessions whose conversation body has been materialised from the jsonl archive. */
  private readonly loadedConversations = new Set<string>();
  private readonly conversationLoads = new Map<string, Promise<void>>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly workspace: string) {
    const stateRoot = projectStateRoot(workspace);
    this.path = resolve(stateRoot, "sessions.json");
    this.directory = resolve(stateRoot, "sessions");
  }

  async open(): Promise<void> {
    await ensureProjectStateRoot(this.workspace);
    await this.migrateLegacyStore();
    let names: string[];
    try { names = await readdir(this.directory); } catch {
      this.sessions = [];
      this.mtimes.clear();
      this.loadedConversations.clear();
      return;
    }
    const entries = await Promise.all(names.filter((name) => extname(name).toLowerCase() === ".jsonl")
      .map((name) => this.readMetadata(resolve(this.directory, name), name.slice(0, -6))));
    const valid = entries.filter((item): item is { session: StoredSession; mtimeMs: number; conversationLoaded: boolean } => item !== undefined);
    this.sessions = valid.map((item) => item.session);
    this.mtimes.clear();
    this.loadedConversations.clear();
    for (const item of valid) {
      this.mtimes.set(item.session.id, item.mtimeMs);
      if (item.conversationLoaded) this.loadedConversations.add(item.session.id);
    }
  }

  /** Returns metadata-only sessions, sorted by most recently modified. */
  list(): StoredSession[] {
    return this.sessions.filter((session) => normalizeWorkspace(session.workspace) === normalizeWorkspace(this.workspace))
      .sort((a, b) => (this.mtimes.get(b.id) ?? 0) - (this.mtimes.get(a.id) ?? 0) || b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneSession);
  }
  /** Returns the most recently modified session without loading its conversation. */
  current(): StoredSession | undefined { return this.list()[0]; }
  /** Returns metadata for one session; call `ensureConversation` when the body is needed. */
  find(id: string): StoredSession | undefined {
    const found = this.sessions.find((item) => item.id === id && normalizeWorkspace(item.workspace) === normalizeWorkspace(this.workspace));
    return found ? cloneSession(found) : undefined;
  }

  /**
   * Materialises the conversation body from the jsonl archive and returns the
   * full session. Prefer this before mutating or reading `conversation`.
   */
  async ensureConversation(id: string): Promise<StoredSession | undefined> {
    const existing = this.sessions.find((item) => item.id === id && normalizeWorkspace(item.workspace) === normalizeWorkspace(this.workspace));
    if (!existing) return undefined;
    if (this.loadedConversations.has(id)) return cloneSession(existing);
    let pending = this.conversationLoads.get(id);
    if (!pending) {
      pending = this.loadConversation(id).finally(() => this.conversationLoads.delete(id));
      this.conversationLoads.set(id, pending);
    }
    await pending;
    return this.find(id);
  }

  async create(name = "New session", defaults: Pick<StoredSession, "workMode" | "permissionMode" | "reasoningEffort" | "modelReference" | "conversation"> = {}): Promise<StoredSession> {
    const now = new Date().toISOString();
    let id = generateSessionId();
    while (this.sessions.some((item) => item.id === id) || existsSync(this.archivePath(id))) id = generateSessionId();
    const normalizedName = name.trim() || "New session";
    const session: StoredSession = {
      id, name: normalizedName, autoNamed: DEFAULT_SESSION_NAMES.has(normalizedName),
      titleSource: DEFAULT_SESSION_NAMES.has(normalizedName) ? "local" : "manual",
      workspace: this.workspace, createdAt: now, updatedAt: now, messages: [], history: [],
      ...(defaults.workMode !== undefined ? { workMode: defaults.workMode } : {}),
      ...(defaults.permissionMode !== undefined ? { permissionMode: defaults.permissionMode } : {}),
      ...(defaults.reasoningEffort !== undefined ? { reasoningEffort: defaults.reasoningEffort } : {}),
      ...(defaults.modelReference !== undefined ? { modelReference: { ...defaults.modelReference } } : {}),
      ...(defaults.conversation !== undefined ? { conversation: cloneMessages(defaults.conversation) } : {}),
    };
    // Derived counter must be set before persist so the sidecar snapshot carries it.
    session.archiveMessageCount = countArchiveMessages(session.conversation ?? []);
    session.archiveSize = await this.persistRecordsAndState(
      id,
      [stateRecord(session, now), ...messageRecords(session.conversation ?? [], now)],
      session,
      now,
    );
    this.sessions.push(session);
    this.loadedConversations.add(id);
    await this.refreshMtime(id);
    return cloneSession(session);
  }

  async ensureCurrent(name = "Current session", defaults: Pick<StoredSession, "workMode" | "permissionMode" | "reasoningEffort" | "modelReference" | "conversation"> = {}): Promise<StoredSession> {
    return this.current() ?? this.create(name, defaults);
  }

  async update(id: string, patch: StoredSessionPatch): Promise<StoredSession | undefined> {
    if (patch.conversation !== undefined) await this.ensureConversation(id);
    const existing = this.sessions.find((item) => item.id === id && normalizeWorkspace(item.workspace) === normalizeWorkspace(this.workspace));
    if (!existing) return undefined;
    const next = cloneSession(existing);
    if (patch.name !== undefined) next.name = patch.name.trim() || next.name;
    if (patch.autoNamed !== undefined) next.autoNamed = patch.autoNamed;
    if (patch.titleSource !== undefined) next.titleSource = patch.titleSource;
    if (patch.titleGenerationAttempted !== undefined) next.titleGenerationAttempted = patch.titleGenerationAttempted;
    if (patch.messages !== undefined) next.messages = structuredClone(patch.messages);
    if (patch.history !== undefined) next.history = [...patch.history];
    if (patch.workMode !== undefined) next.workMode = patch.workMode;
    if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;
    if (patch.reasoningEffort !== undefined) next.reasoningEffort = patch.reasoningEffort;
    if (patch.modelReference !== undefined) {
      if (patch.modelReference === null) delete next.modelReference;
      else next.modelReference = structuredClone(patch.modelReference);
    }
    if (patch.conversation !== undefined) next.conversation = cloneMessages(patch.conversation);
    const now = new Date().toISOString();
    next.updatedAt = now;
    const before = existing.conversation ?? [];
    const after = next.conversation ?? [];
    const changes: SessionJsonlRecord[] = patch.conversation === undefined ? []
      : isMessagePrefix(before, after) ? messageRecords(after.slice(before.length), now)
        : [compactionBoundaryRecord(after, now) ?? { type: "session-reset", role: "system", timestamp: now, content: { messages: cloneMessages(after) } }];
    // Derived counters must be set before persist so the sidecar snapshot carries them.
    // When neither the archive counter nor the conversation body is known (metadata-first
    // legacy session), leave the counter untouched instead of resetting it to 0.
    if (existing.archiveMessageCount !== undefined || existing.conversation !== undefined) {
      next.archiveMessageCount = (existing.archiveMessageCount ?? countArchiveMessages(before))
        + changes.filter((record) => record.type === "message").length;
    }
    if (!next.archiveTitle) {
      const prompt = firstConversationPrompt(after);
      if (prompt) next.archiveTitle = truncateSessionName(prompt, 48);
    }
    next.archiveSize = await this.persistRecordsAndState(id, [...changes, stateRecord(next, now)], next, now);
    this.sessions[this.sessions.indexOf(existing)] = next;
    if (patch.conversation !== undefined) this.loadedConversations.add(id);
    await this.refreshMtime(id);
    return cloneSession(next);
  }

  /** Durably append one semantic message before the Agent loop continues. */
  async appendMessage(id: string, message: Message, timestamp = new Date().toISOString()): Promise<StoredSession | undefined> {
    await this.ensureConversation(id);
    const existing = this.sessions.find((item) => item.id === id && normalizeWorkspace(item.workspace) === normalizeWorkspace(this.workspace));
    if (!existing || !isPersistedMessage(message)) return undefined;
    const next = cloneSession(existing);
    next.conversation = [...(next.conversation ?? []), structuredClone(message)];
    next.updatedAt = timestamp;
    next.archiveMessageCount = (next.archiveMessageCount ?? countArchiveMessages(existing.conversation ?? [])) + 1;
    if (!next.archiveTitle && message.role === "user" && typeof message.content === "string") {
      const title = archivePrompt(message.content);
      if (title) next.archiveTitle = title;
    }
    next.archiveSize = await this.persistRecordsAndState(id, messageRecords([message], timestamp), next, timestamp);
    this.sessions[this.sessions.indexOf(existing)] = next;
    this.loadedConversations.add(id);
    await this.refreshMtime(id);
    return cloneSession(next);
  }

  async remove(id: string): Promise<boolean> {
    const index = this.sessions.findIndex((item) => item.id === id && normalizeWorkspace(item.workspace) === normalizeWorkspace(this.workspace));
    if (index < 0) return false;
    await unlink(this.archivePath(id));
    try { await unlink(this.statePath(id)); } catch { /* legacy sessions may not have a sidecar */ }
    this.sessions.splice(index, 1);
    this.mtimes.delete(id);
    this.loadedConversations.delete(id);
    this.conversationLoads.delete(id);
    return true;
  }

  async cleanExpired(days = 30): Promise<number> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return 0; }
    const cutoff = Date.now() - Math.max(0, days) * 86_400_000;
    let removed = 0;
    for (const name of names) {
      if (extname(name).toLowerCase() !== ".jsonl") continue;
      const path = resolve(this.directory, name);
      try {
        if ((await stat(path)).mtimeMs >= cutoff) continue;
        await unlink(path);
        const id = name.slice(0, -6);
        try { await unlink(this.statePath(id)); } catch { /* legacy sessions may not have a sidecar */ }
        this.sessions = this.sessions.filter((item) => item.id !== id);
        this.mtimes.delete(id);
        removed += 1;
      } catch { /* best effort per file */ }
    }
    return removed;
  }

  private archivePath(id: string): string {
    if (!isSafeSessionId(id)) throw new Error(`invalid session id: ${id}`);
    return resolve(this.directory, `${id}.jsonl`);
  }

  private statePath(id: string): string {
    if (!isSafeSessionId(id)) throw new Error(`invalid session id: ${id}`);
    return resolve(this.directory, `${id}.state.json`);
  }

  private async persistRecordsAndState(
    id: string,
    records: readonly SessionJsonlRecord[],
    session: StoredSession,
    timestamp: string,
  ): Promise<number> {
    const archivePath = this.archivePath(id);
    const statePath = this.statePath(id);
    const archiveText = records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
    const operation = this.writeTail.then(async () => {
      await mkdir(dirname(archivePath), { recursive: true });
      if (archiveText) await appendFile(archivePath, archiveText, "utf8");
      return this.writeSidecar(archivePath, statePath, session, timestamp);
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persistLoadedState(
    id: string,
    session: StoredSession,
    timestamp: string,
    records: readonly SessionJsonlRecord[],
    compactArchive: boolean,
  ): Promise<void> {
    const archivePath = this.archivePath(id);
    const statePath = this.statePath(id);
    const compactedRecords = compactArchive
      ? [stateRecord(session, timestamp), ...records.filter((record) => record.type !== "state")]
      : [];
    const archiveText = compactArchive
      ? `${compactedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`
      : undefined;
    const operation = this.writeTail.then(async () => {
      await mkdir(dirname(archivePath), { recursive: true });
      if (archiveText !== undefined) await replaceTextFile(archivePath, archiveText);
      await this.writeSidecar(archivePath, statePath, session, timestamp);
    });
    this.writeTail = operation.catch(() => undefined);
    await operation;
  }

  private async writeSidecar(
    archivePath: string,
    statePath: string,
    session: StoredSession,
    timestamp: string,
  ): Promise<number> {
    const archiveSize = (await stat(archivePath)).size;
    const snapshotSession = { ...session, archiveSize };
    // Sidecar failure is recoverable and must not fail an authoritative archive write.
    await replaceTextFile(statePath, `${JSON.stringify(stateSnapshotRecord(snapshotSession, timestamp))}\n`)
      .catch(() => undefined);
    return archiveSize;
  }

  private async refreshMtime(id: string): Promise<void> {
    try { this.mtimes.set(id, (await stat(this.archivePath(id))).mtimeMs); }
    catch { this.mtimes.set(id, Date.now()); }
  }

  private async readStateSnapshot(id: string): Promise<SessionStateRecord | undefined> {
    try {
      const parsed = JSON.parse((await readFile(this.statePath(id), "utf8")).trim()) as unknown;
      return isSessionJsonlRecord(parsed) && parsed.type === "state" && parsed.session.id === id
        ? parsed
        : undefined;
    } catch { return undefined; }
  }

  /**
   * Cold-start path: prefer the sidecar snapshot + archive stat so listing sessions
   * does not parse every jsonl body. Falls back to full archive reads for legacy data.
   */
  private async readMetadata(path: string, fileId: string): Promise<{ session: StoredSession; mtimeMs: number; conversationLoaded: boolean } | undefined> {
    try {
      const [details, snapshot] = await Promise.all([stat(path), this.readStateSnapshot(fileId)]);
      if (snapshot?.session && isStoredSessionState(snapshot.session) && snapshot.session.id === fileId
        && snapshot.session.archiveSize === details.size) {
        const session: StoredSession = structuredClone(snapshot.session);
        return { session, mtimeMs: details.mtimeMs, conversationLoaded: false };
      }
      const full = await this.readArchive(path, fileId);
      return full ? { ...full, conversationLoaded: true } : undefined;
    } catch {
      return undefined;
    }
  }

  private async loadConversation(id: string): Promise<void> {
    const index = this.sessions.findIndex((item) => item.id === id && normalizeWorkspace(item.workspace) === normalizeWorkspace(this.workspace));
    if (index < 0 || this.loadedConversations.has(id)) return;
    const full = await this.readArchive(this.archivePath(id), id);
    if (!full) {
      this.loadedConversations.add(id);
      return;
    }
    const previous = this.sessions[index];
    if (!previous) return;
    // Keep any newer in-memory TUI fields (name/messages) while attaching the archive body.
    const merged: StoredSession = {
      ...full.session,
      name: previous.name,
      messages: previous.messages,
      history: previous.history,
      updatedAt: previous.updatedAt,
      createdAt: previous.createdAt,
      workspace: previous.workspace,
    };
    if (previous.autoNamed !== undefined) merged.autoNamed = previous.autoNamed;
    if (previous.titleSource !== undefined) merged.titleSource = previous.titleSource;
    if (previous.titleGenerationAttempted !== undefined) merged.titleGenerationAttempted = previous.titleGenerationAttempted;
    if (previous.workMode !== undefined) merged.workMode = previous.workMode;
    else if (full.session.workMode !== undefined) merged.workMode = full.session.workMode;
    if (previous.permissionMode !== undefined) merged.permissionMode = previous.permissionMode;
    else if (full.session.permissionMode !== undefined) merged.permissionMode = full.session.permissionMode;
    if (previous.reasoningEffort !== undefined) merged.reasoningEffort = previous.reasoningEffort;
    else if (full.session.reasoningEffort !== undefined) merged.reasoningEffort = full.session.reasoningEffort;
    if (previous.modelReference !== undefined) merged.modelReference = previous.modelReference;
    else if (full.session.modelReference !== undefined) merged.modelReference = full.session.modelReference;
    this.sessions[index] = merged;
    this.mtimes.set(id, full.mtimeMs);
    this.loadedConversations.add(id);
  }

  private async readArchive(path: string, fileId: string): Promise<{ session: StoredSession; mtimeMs: number } | undefined> {
    try {
      const [contents, initialDetails, snapshot] = await Promise.all([
        readFile(path, "utf8"),
        stat(path),
        this.readStateSnapshot(fileId),
      ]);
      const records = parseSessionJsonl(contents);
      const conversation = rebuildConversation(records);
      const stateRecords = records.filter((record): record is SessionStateRecord => record.type === "state");
      const archiveState = stateRecords.at(-1);
      // Trust the sidecar only for the exact archive size it describes.
      const matchingSnapshot = snapshot?.session.archiveSize === initialDetails.size ? snapshot : undefined;
      const latestRecord = matchingSnapshot && (!archiveState || matchingSnapshot.timestamp >= archiveState.timestamp)
        ? matchingSnapshot
        : archiveState;
      const latest = latestRecord?.session;
      const base: StoredSession | undefined = latest && isStoredSessionState(latest) && latest.id === fileId
        ? { ...structuredClone(latest), conversation }
        : conversation.length
          ? {
              id: fileId,
              name: "Current session",
              autoNamed: true,
              titleSource: "local",
              workspace: this.workspace,
              createdAt: initialDetails.birthtime.toISOString(),
              updatedAt: initialDetails.mtime.toISOString(),
              messages: [],
              history: [],
              conversation,
            }
          : undefined;
      if (!base) return undefined;

      const compactArchive = stateRecords.length > 1 || stateRecords.some(hasInlineTuiState);
      const refreshSnapshot = !snapshot || latestRecord !== snapshot;
      let details = initialDetails;
      if (compactArchive || refreshSnapshot) {
        try {
          await this.persistLoadedState(
            fileId,
            base,
            latestRecord?.timestamp ?? base.updatedAt,
            records,
            compactArchive,
          );
          if (compactArchive) {
            // Vacuuming is maintenance, not user activity; preserve session ordering.
            await utimes(path, initialDetails.atime, initialDetails.mtime);
            details = await stat(path);
          }
        } catch { /* loading remains valid even if best-effort migration fails */ }
      }

      const archiveTitle = firstArchiveTitle(records);
      return {
        session: {
          ...base,
          archiveMessageCount: countArchiveRecords(records),
          ...(archiveTitle ? { archiveTitle } : {}),
          archiveSize: details.size,
        },
        mtimeMs: details.mtimeMs,
      };
    } catch { return undefined; }
  }

  private async migrateLegacyStore(): Promise<void> {
    if (!existsSync(this.path)) return;
    let legacy: StoredSession[];
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      legacy = Array.isArray(parsed) ? parsed.filter(isStoredSession) : [];
    } catch { return; }
    try {
      await mkdir(this.directory, { recursive: true });
      for (const session of legacy) {
        if (!isSafeSessionId(session.id)) continue;
        const destination = this.archivePath(session.id);
        if (existsSync(destination)) continue;
        const timestamp = session.updatedAt || new Date().toISOString();
        const prompt = firstConversationPrompt(session.conversation ?? []);
        const migrated = { ...session,
          archiveMessageCount: countArchiveMessages(session.conversation ?? []),
          ...(prompt ? { archiveTitle: truncateSessionName(prompt, 48) } : {}),
        };
        const records: SessionJsonlRecord[] = [stateRecord(migrated, timestamp), ...messageRecords(migrated.conversation ?? [], timestamp)];
        await this.persistRecordsAndState(session.id, records, migrated, timestamp);
      }
      await rename(this.path, `${this.path}.migrated`);
    } catch { /* retain the legacy file so migration can be retried */ }
  }
}

export function generateSessionId(now = Date.now()): string { return `${now.toString(36)}-${randomBytes(3).toString("hex")}`; }

export function parseSessionJsonl(contents: string): SessionJsonlRecord[] {
  const records: SessionJsonlRecord[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const value = JSON.parse(line) as unknown; if (isSessionJsonlRecord(value)) records.push(value); }
    catch { /* skip a damaged line without losing the archive */ }
  }
  return records;
}

export function rebuildConversation(records: readonly SessionJsonlRecord[]): Message[] {
  let boundaryIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const type = records[index]?.type;
    if (type === "compaction-boundary" || type === "session-reset") { boundaryIndex = index; break; }
  }
  const rebuilt: Message[] = [];
  if (boundaryIndex >= 0) {
    const boundary = records[boundaryIndex]!;
    if (boundary.type === "session-reset") rebuilt.push(...cloneMessages(boundary.content.messages));
    else if (boundary.type === "compaction-boundary") {
      if (boundary.content.reset) rebuilt.push(...cloneMessages(boundary.content.reset));
      else {
      const summary = boundary.content.summary?.trim();
      if (summary) rebuilt.push({ role: "user", content: `本次会话延续自之前的对话，因上下文空间不足进行了压缩。以下是早期对话的摘要：\n\n${summary}${boundary.content.retainedTail?.length ? "\n\n近期消息已原样保留。" : ""}` });
      if (boundary.content.retainedTail) rebuilt.push(...cloneMessages(boundary.content.retainedTail));
      }
    }
  }
  for (let index = Math.max(0, boundaryIndex + 1); index < records.length; index += 1) {
    const message = recordMessage(records[index]);
    if (message) rebuilt.push(message);
  }
  return truncateIncompleteToolChains(rebuilt);
}

function truncateIncompleteToolChains(messages: readonly Message[]): Message[] {
  const result: Message[] = cloneMessages(messages);
  let changed = true;
  while (changed) {
    changed = false;
    const output: Message[] = [];
    let pending = new Set<string>();
    let assistantInsertIndex = -1;
    for (const message of result) {
      if (message.role === "assistant" && message.toolCalls?.length) {
        pending = new Set(message.toolCalls
          .map((call) => call.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0));
        assistantInsertIndex = output.length;
        output.push(structuredClone(message));
        continue;
      }
      if (message.role === "tool" && message.toolCallId && pending.has(message.toolCallId)) {
        pending.delete(message.toolCallId);
        if (pending.size === 0) pending = new Set<string>();
        output.push(structuredClone(message));
        continue;
      }
      if (pending.size > 0) {
        output.splice(assistantInsertIndex);
        pending = new Set<string>();
        changed = true;
      }
      output.push(structuredClone(message));
    }
    if (pending.size > 0) {
      output.splice(assistantInsertIndex);
      changed = true;
    }
    result.length = 0;
    result.push(...cloneMessages(output));
  }
  return result;
}

function recordMessage(record: SessionJsonlRecord | undefined): Message | undefined {
  if (!record || record.type === "state" || record.type === "compaction-boundary" || record.type === "session-reset" || !isMessageRole(record.role)) return undefined;
  const hasCalls = Array.isArray(record.toolCalls) && record.toolCalls.length > 0;
  if (!(typeof record.content === "string" && record.content.trim()) && !hasCalls && record.role !== "tool") return undefined;
  const { type: _type, timestamp: _timestamp, role, ...rest } = record;
  return { role, ...structuredClone(rest) };
}

function stateRecord(session: StoredSession, timestamp: string): SessionStateRecord {
  const state = storedSessionState(session);
  return {
    type: "state",
    timestamp,
    // The append-only archive only needs a lightweight metadata checkpoint.
    // The latest full TUI transcript is overwritten in the sidecar instead.
    session: stripDerivedArchiveFields({ ...state, messages: [], history: [] }),
  };
}
function stateSnapshotRecord(session: StoredSession, timestamp: string): SessionStateRecord {
  // Sidecar keeps derived archive counters so open() can stay metadata-first.
  return { type: "state", timestamp, session: storedSessionState(session) };
}
function storedSessionState(session: StoredSession): StoredSessionState {
  const { conversation: _conversation, ...state } = cloneSession(session);
  return state;
}
function stripDerivedArchiveFields(session: StoredSessionState): StoredSessionState {
  const {
    archiveMessageCount: _archiveMessageCount,
    archiveTitle: _archiveTitle,
    archiveSize: _archiveSize,
    ...state
  } = session;
  return state;
}
function hasInlineTuiState(record: SessionStateRecord): boolean {
  return record.session.messages.length > 0 || record.session.history.length > 0;
}
async function replaceTextFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, contents, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}
function messageRecords(messages: readonly Message[], timestamp: string): SessionMessageRecord[] {
  return messages.map((message) => ({ type: "message", timestamp, ...structuredClone(message), content: message.content ?? "" }));
}
function isMessagePrefix(prefix: readonly Message[], complete: readonly Message[]): boolean {
  return prefix.length <= complete.length && prefix.every((message, index) => JSON.stringify(message) === JSON.stringify(complete[index]));
}
function compactionBoundaryRecord(messages: readonly Message[], timestamp: string): SessionCompactionBoundaryRecord | undefined {
  let summaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.metadata?.promptBlock === "context-summary") { summaryIndex = index; break; }
  }
  if (summaryIndex < 0) return undefined;
  const summaryMessage = messages[summaryIndex];
  const summary = typeof summaryMessage?.content === "string"
    ? /<context-summary>\s*([\s\S]*?)\s*<\/context-summary>/u.exec(summaryMessage.content)?.[1]?.trim()
    : undefined;
  if (!summary) return undefined;
  const retainedTail = messages.slice(summaryIndex + 1)
    .filter((message): message is Message & { role: "user" | "assistant"; content: string } => (
      (message.role === "user" || message.role === "assistant")
      && typeof message.content === "string"
      && Boolean(message.content.trim())
    ))
    .map((message): Message => ({ role: message.role, content: message.content }));
  return {
    type: "compaction-boundary",
    role: "system",
    timestamp,
    content: { summary, retainedTail },
  };
}
function isSessionJsonlRecord(value: unknown): value is SessionJsonlRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.type === "state") return typeof item.timestamp === "string" && isStoredSessionState(item.session);
  if (item.type === "compaction-boundary") return item.role === "system" && typeof item.timestamp === "string" && isBoundaryContent(item.content);
  if (item.type === "session-reset") return item.role === "system" && typeof item.timestamp === "string" && isResetContent(item.content);
  return (item.type === undefined || item.type === "message") && isMessageRole(item.role)
    && (item.timestamp === undefined || typeof item.timestamp === "string") && isPersistedMessage(item);
}
function isBoundaryContent(value: unknown): value is SessionCompactionBoundaryContent {
  if (!value || typeof value !== "object") return false;
  const item = value as SessionCompactionBoundaryContent;
  const validReset = Array.isArray(item.reset) && item.reset.every(isPersistedMessage);
  const validSummary = typeof item.summary === "string" && Boolean(item.summary.trim())
    && (item.retainedTail === undefined || (Array.isArray(item.retainedTail) && item.retainedTail.every(isRetainedMessage)));
  return validReset || validSummary;
}
function isResetContent(value: unknown): value is SessionResetRecord["content"] {
  if (!value || typeof value !== "object") return false;
  const messages = (value as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.every(isPersistedMessage);
}
function isSafeSessionId(id: string): boolean { return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== ".."; }
function normalizeWorkspace(workspace: string): string { return resolve(workspace).replace(/[\\/]+$/, "").toLowerCase(); }
function isStoredSession(value: unknown): value is StoredSession {
  return isStoredSessionState(value) && ((value as Partial<StoredSession>).conversation === undefined || Array.isArray((value as Partial<StoredSession>).conversation));
}
function isStoredSessionState(value: unknown): value is StoredSessionState {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredSession>;
  return typeof item.id === "string" && isSafeSessionId(item.id) && typeof item.name === "string" && typeof item.workspace === "string"
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string"
    && Array.isArray(item.messages) && item.messages.every(isTranscriptMessage)
    && Array.isArray(item.history) && item.history.every((entry) => typeof entry === "string")
    && (item.workMode === undefined || item.workMode === "plan" || item.workMode === "auto")
    && (item.permissionMode === undefined || isPermissionMode(item.permissionMode))
    && (item.reasoningEffort === undefined || isReasoningEffort(item.reasoningEffort))
    && (item.autoNamed === undefined || typeof item.autoNamed === "boolean")
    && (item.titleSource === undefined || item.titleSource === "local" || item.titleSource === "model" || item.titleSource === "manual")
    && (item.titleGenerationAttempted === undefined || typeof item.titleGenerationAttempted === "boolean")
    && (item.modelReference === undefined || isModelReference(item.modelReference))
    && (item.archiveMessageCount === undefined || (typeof item.archiveMessageCount === "number" && Number.isFinite(item.archiveMessageCount)))
    && (item.archiveTitle === undefined || typeof item.archiveTitle === "string")
    && (item.archiveSize === undefined || (typeof item.archiveSize === "number" && Number.isFinite(item.archiveSize)));
}
function isMessageRole(value: unknown): value is Message["role"] { return value === "system" || value === "user" || value === "assistant" || value === "tool"; }
function cloneSession(session: StoredSession): StoredSession { return structuredClone(session); }
function isModelReference(value: unknown): value is ModelReference {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ModelReference>;
  return typeof item.provider === "string" && item.provider.length > 0 && typeof item.model === "string" && item.model.length > 0;
}
function cloneMessages(messages: readonly Message[]): Message[] { return [...structuredClone(messages)]; }

function isPersistedMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Message>;
  if (!isMessageRole(item.role)) return false;
  if (item.content !== undefined && typeof item.content !== "string") return false;
  if (item.name !== undefined && typeof item.name !== "string") return false;
  if (item.toolCallId !== undefined && typeof item.toolCallId !== "string") return false;
  if (item.metadata !== undefined && (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata))) return false;
  if (item.toolCalls !== undefined && (!Array.isArray(item.toolCalls) || !item.toolCalls.every((call) => (
    Boolean(call) && typeof call === "object"
    && (call.id === undefined || typeof call.id === "string")
    && typeof call.name === "string"
    && Boolean(call.arguments) && typeof call.arguments === "object" && !Array.isArray(call.arguments)
    && typeof call.createdAt === "string"
  )))) return false;
  return true;
}
function isRetainedMessage(value: unknown): value is Message {
  return isPersistedMessage(value)
    && (value.role === "user" || value.role === "assistant")
    && typeof value.content === "string"
    && Boolean(value.content.trim());
}
function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as { id?: unknown; kind?: unknown; text?: unknown; abortMessage?: unknown; [key: string]: unknown };
  if (typeof item.id !== "string" || typeof item.kind !== "string") return false;
  if (item.kind === "user") return typeof item.text === "string" && (item.queued === undefined || typeof item.queued === "boolean");
  if (item.kind === "assistant") return typeof item.text === "string"
    && (item.streaming === undefined || typeof item.streaming === "boolean")
    && (item.abortMessage === undefined || typeof item.abortMessage === "string");
  if (item.kind === "thought") return typeof item.text === "string" && typeof item.expanded === "boolean"
    && (item.streaming === undefined || typeof item.streaming === "boolean");
  if (["system", "plan", "error"].includes(item.kind)) return typeof item.text === "string";
  if (item.kind === "verification") return Array.isArray(item.results);
  if (item.kind === "tool") {
    return typeof item.callId === "string" && typeof item.name === "string"
      && Boolean(item.arguments) && typeof item.arguments === "object" && !Array.isArray(item.arguments)
      && typeof item.permissionLevel === "number" && typeof item.expanded === "boolean"
      && ["running", "success", "failure", "rejected", "cancelled"].includes(String(item.status));
  }
  return false;
}
function countArchiveRecords(records: readonly SessionJsonlRecord[]): number {
  return records.reduce((count, record) => count + (recordMessage(record) ? 1 : 0), 0);
}
function countArchiveMessages(messages: readonly Message[]): number {
  return messages.reduce((count, message) => count + (isPersistedMessage(message) ? 1 : 0), 0);
}
function firstArchiveTitle(records: readonly SessionJsonlRecord[]): string | undefined {
  for (const record of records) {
    const message = recordMessage(record);
    if (message?.role === "user" && typeof message.content === "string") {
      const title = archivePrompt(message.content);
      if (title) return title;
    }
  }
  return undefined;
}
function archivePrompt(value: string): string | undefined {
  const normalized = normalizeSessionPrompt(extractConversationPrompt(value));
  return normalized ? truncateSessionName(normalized, 48) : undefined;
}

/** Keep persisted semantic/manual names, otherwise derive a stable local title. */
export function displaySessionName(session: Pick<StoredSession, "name" | "autoNamed" | "titleSource" | "messages" | "archiveTitle">, mode: SessionTitleMode = "local"): string {
  if (!isAutomaticSessionName(session)) return session.name;
  if (session.titleSource === "model") return session.name;
  if (session.archiveTitle) return session.archiveTitle;
  const prompts = session.messages.filter((message) => message.kind === "user").map((message) => normalizeSessionPrompt(message.text)).filter(Boolean);
  const prompt = mode === "first-message" ? prompts[0] : prompts.find((value) => !isGreeting(value)) ?? prompts[0];
  return prompt ? truncateSessionName(prompt, 48) : session.name;
}
export function isAutomaticSessionName(session: Pick<StoredSession, "name" | "autoNamed">): boolean { return session.autoNamed ?? DEFAULT_SESSION_NAMES.has(session.name); }
export function firstConversationPrompt(messages: readonly Message[]): string | undefined {
  const prompts = messages.filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => normalizeSessionPrompt(extractConversationPrompt(message.content ?? ""))).filter(Boolean);
  return prompts.find((value) => !isGreeting(value)) ?? prompts[0];
}
function extractConversationPrompt(value: string): string {
  const marker = "\n\nUser message:\n"; const index = value.lastIndexOf(marker); return index >= 0 ? value.slice(index + marker.length) : value;
}
function normalizeSessionPrompt(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function isGreeting(value: string): boolean { return /^(?:hi|hello|hey|你好|您好|嗨|在吗)[!！,.，。?？\s]*$/i.test(value); }
export function truncateSessionName(value: string, maximumCharacters: number): string {
  const characters = Array.from(value); return characters.length <= maximumCharacters ? value : `${characters.slice(0, Math.max(1, maximumCharacters - 1)).join("")}…`;
}
