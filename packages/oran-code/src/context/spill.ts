import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CONTEXT_LIMITS } from "./limits.js";

export interface RecentFile {
  path: string;
  content: string;
  readAt: string;
}

/** 落盘位置:`<workspace>/<stateDirectory>/sessions/<processSessionId>/tool-results/`。 */
export interface SpillTarget {
  workspace: string;
  stateDirectory: string;
  processSessionId: string;
}

export function isSafeToolCallId(id: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) || id === "." || id === "..") return false;
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id);
}

export function buildToolReplacement(content: string, bytes: number, relativePath: string): string {
  const lines = content.split("\n").slice(0, CONTEXT_LIMITS.previewLines).join("\n");
  let preview = "";
  let previewBytes = 0;
  for (const character of lines) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (previewBytes + characterBytes > CONTEXT_LIMITS.previewBytes) break;
    preview += character;
    previewBytes += characterBytes;
  }
  return [
    "<offloaded-tool-result>",
    `Original UTF-8 bytes: ${bytes}`,
    "Preview:",
    preview || "(empty)",
    `Full result: ${relativePath}`,
    `Use read_file on ${relativePath} when the complete result is needed; use search_code to grep it when it is large.`,
    "</offloaded-tool-result>",
  ].join("\n");
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

export function formatRecentFile(file: RecentFile): string {
  const byteLimit = Math.floor(CONTEXT_LIMITS.recentFileTokens * CONTEXT_LIMITS.charactersPerToken);
  const truncated = Buffer.byteLength(file.content, "utf8") > byteLimit;
  const content = truncated ? `${truncateUtf8(file.content, byteLimit)}\n(content truncated)` : file.content;
  return ["<recent-file>", `Path: ${file.path}`, `Read at: ${file.readAt}`, "Content:", content, "</recent-file>"].join(
    "\n",
  );
}

/**
 * 工具结果全文落盘,返回相对路径。
 * EEXIST 时按内容比对判定可否复用;其余失败返回 undefined,由调用方决定是否保留原文。
 */
export async function spillToolResult(target: SpillTarget, id: string, content: string): Promise<string | undefined> {
  if (!isSafeToolCallId(id)) return undefined;
  const relativePath = `${target.stateDirectory}/sessions/${target.processSessionId}/tool-results/${id}`;
  const absolutePath = resolve(target.workspace, ...relativePath.split("/"));
  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      try {
        const existing = await readFile(absolutePath);
        if (existing.equals(Buffer.from(content, "utf8"))) return relativePath;
      } catch {
        // The existing file is not reusable.
      }
    }
    return undefined;
  }
  return relativePath;
}

/**
 * 清空占位符(microcompact 用):只留字节数、路径与读回提示,没有正文预览。
 * 用于早期工具结果——正文不值得占用活跃上下文,但仍可随时读回。
 */
export function buildClearedReplacement(bytes: number, relativePath: string): string {
  return [
    "<cleared-tool-result>",
    `Original UTF-8 bytes: ${bytes}`,
    `Full result: ${relativePath}`,
    `Content cleared to save context. Read ${relativePath} with read_file, or grep it with search_code, when it is needed again.`,
    "</cleared-tool-result>",
  ].join("\n");
}
