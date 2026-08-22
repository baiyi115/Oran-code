import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse, stringify } from "yaml";
import type { PermissionConfig, PermissionMode, ToolCall, ToolKind } from "./types.js";
import { isWithinPath, resolvePhysicalPath } from "./utils/path-containment.js";

export type PermissionVerdict = "allow" | "deny" | "ask";
export type PermissionDecisionSource =
  | "plan-directory"
  | "safe-command"
  | "dangerous-command"
  | "path-sandbox"
  | "session-rule"
  | "local-rule"
  | "project-rule"
  | "user-rule"
  | "user-decision"
  | "permission-mode";

export interface ApprovalDecision {
  verdict: PermissionVerdict;
  reason: string;
  source: PermissionDecisionSource;
  level: number;
}

interface PermissionRule {
  tool: string;
  pattern: string;
  effect: "allow" | "deny";
  match: "exact" | "glob";
}

const DANGEROUS_COMMANDS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "recursive forced deletion of a root or home directory", pattern: /(?:^|[\s;&|])rm\b(?=[^\r\n]*(?:--recursive\b|-[^\s-]*r[^\s-]*\b))(?=[^\r\n]*(?:--force\b|-[^\s-]*f[^\s-]*\b))[^\r\n]*\s+(?:--\s+)?(?:\/(?:\s|$)|~(?:\/|\s|$)|\$HOME(?:\/|\s|$))/i },
  { label: "recursive forced deletion through PowerShell", pattern: /\b(?:remove-item|ri)\b[^\r\n]*(?:-recurse[^\r\n]*-force|-force[^\r\n]*-recurse)[^\r\n]*(?:[A-Z]:\\(?:\s|$)|\\\\|\$HOME|~)/i },
  { label: "filesystem formatting", pattern: /(?:^|[\s;&|])(?:mkfs(?:\.[\w-]+)?|format(?:\.com)?)\b/i },
  { label: "raw write to a block device", pattern: /(?:^|[\s;&|])dd\b[^\r\n]*\bof=(?:\/dev\/|\\\\\.\\PhysicalDrive)/i },
  { label: "recursive permission change on the filesystem root", pattern: /(?:^|[\s;&|])chmod\s+-R\s+(?:777|a\+rwx)\s+\//i },
  { label: "shell fork bomb", pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { label: "remote script piped to a shell", pattern: /\b(?:curl|wget)\b[^\r\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell)\b/i },
  { label: "forced git push", pattern: /\bgit\s+push\b[^\r\n]*(?:--force(?:-with-lease)?|-f(?:\s|$))/i },
  { label: "hard git reset", pattern: /\bgit\s+reset\b[^\r\n]*--hard\b/i },
  { label: "destructive git clean", pattern: /\bgit\s+clean\b[^\r\n]*(?:--force\b|-[a-z]*f[a-z]*\b)/i },
];

const SHELL_META = /[\r\n><|;&`]|\$\(/;
const SAFE_COMMAND_PREFIXES = [
  "pwd",
  "git status", "git log", "git diff", "git show", "git branch", "git rev-parse", "git ls-files",
] as const;

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  bash: "run_command",
  command: "run_command",
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  glob: "glob_files",
  grep: "search_code",
};

export interface ShellCommandNode {
  raw: string;
  executable: string;
  args: string[];
  hasSubshell: boolean;
  redirects: Array<{ type: ">" | ">>" | "<"; target: string }>;
}

export interface ShellPipelineNode {
  commands: ShellCommandNode[];
}

export interface ShellCompoundNode {
  pipelines: Array<{
    op?: "&&" | "||" | ";" | undefined;
    pipeline: ShellPipelineNode;
  }>;
  hasSubshell: boolean;
  hasParseError?: boolean | undefined;
}

const DANGEROUS_PIPELINE_DESTINATIONS = new Set([
  "sh", "bash", "zsh", "pwsh", "powershell", "eval", "source", "cmd",
]);

export function parseShellCommand(input: string): ShellCompoundNode {
  const text = input.trim();
  if (!text) return { pipelines: [], hasSubshell: false };

  try {
    let index = 0;
    let hasGlobalSubshell = false;

    type Token =
      | { type: "word"; value: string; hasSubshell: boolean }
      | { type: "op"; value: "&&" | "||" | "|" | ";" }
      | { type: "redirect"; op: ">" | ">>" | "<"; target?: string };

    const tokens: Token[] = [];

    while (index < text.length) {
      while (index < text.length && /\s/.test(text[index]!)) {
        if (text[index] === "\n" || text[index] === "\r") {
          if (tokens.length > 0 && tokens[tokens.length - 1]?.type !== "op") {
            tokens.push({ type: "op", value: ";" });
          }
        }
        index++;
      }
      if (index >= text.length) break;

      const char = text[index]!;

      if (char === "&" && text[index + 1] === "&") {
        tokens.push({ type: "op", value: "&&" });
        index += 2;
        continue;
      }
      if (char === "|" && text[index + 1] === "|") {
        tokens.push({ type: "op", value: "||" });
        index += 2;
        continue;
      }
      if (char === "|") {
        tokens.push({ type: "op", value: "|" });
        index += 1;
        continue;
      }
      if (char === ";") {
        tokens.push({ type: "op", value: ";" });
        index += 1;
        continue;
      }
      if (char === ">" && text[index + 1] === ">") {
        tokens.push({ type: "redirect", op: ">>" });
        index += 2;
        continue;
      }
      if (char === ">") {
        tokens.push({ type: "redirect", op: ">" });
        index += 1;
        continue;
      }
      if (char === "<") {
        tokens.push({ type: "redirect", op: "<" });
        index += 1;
        continue;
      }

      let word = "";
      let inSingleQuote = false;
      let inDoubleQuote = false;
      let wordHasSubshell = false;

      while (index < text.length) {
        const c = text[index]!;
        if (!inSingleQuote && !inDoubleQuote) {
          if (/[\s;&|<>]/.test(c)) break;
        }

        if (c === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
          index++;
          continue;
        }

        if (c === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
          index++;
          continue;
        }

        if (c === "\\" && !inSingleQuote && index + 1 < text.length) {
          word += text[index + 1];
          index += 2;
          continue;
        }

        if (!inSingleQuote) {
          if (c === "$" && text[index + 1] === "(") {
            wordHasSubshell = true;
            hasGlobalSubshell = true;
          } else if (c === "`") {
            wordHasSubshell = true;
            hasGlobalSubshell = true;
          }
        }

        word += c;
        index++;
      }

      tokens.push({ type: "word", value: word, hasSubshell: wordHasSubshell });
    }

    const pipelines: ShellCompoundNode["pipelines"] = [];
    let currentPipeline: ShellPipelineNode = { commands: [] };
    let currentCommandWords: Array<{ value: string; hasSubshell: boolean }> = [];
    let currentRedirects: ShellCommandNode["redirects"] = [];
    let currentOp: "&&" | "||" | ";" | undefined = undefined;

    function flushCommand() {
      if (currentCommandWords.length === 0 && currentRedirects.length === 0) return;
      const executable = currentCommandWords[0]?.value ?? "";
      const args = currentCommandWords.slice(1).map((w) => w.value);
      const hasSubshell = currentCommandWords.some((w) => w.hasSubshell);
      currentPipeline.commands.push({
        raw: currentCommandWords.map((w) => w.value).join(" "),
        executable,
        args,
        hasSubshell,
        redirects: [...currentRedirects],
      });
      currentCommandWords = [];
      currentRedirects = [];
    }

    function flushPipeline(nextOp?: "&&" | "||" | ";") {
      flushCommand();
      if (currentPipeline.commands.length > 0) {
        pipelines.push({ op: currentOp, pipeline: currentPipeline });
        currentPipeline = { commands: [] };
      }
      currentOp = nextOp;
    }

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok.type === "word") {
        currentCommandWords.push({ value: tok.value, hasSubshell: tok.hasSubshell });
      } else if (tok.type === "redirect") {
        let target = "";
        const nextTok = tokens[i + 1];
        if (nextTok && nextTok.type === "word") {
          target = nextTok.value;
          i++;
        }
        currentRedirects.push({ type: tok.op, target });
      } else if (tok.type === "op") {
        if (tok.value === "|") {
          flushCommand();
        } else {
          flushPipeline(tok.value);
        }
      }
    }

    flushPipeline();

    return {
      pipelines,
      hasSubshell: hasGlobalSubshell,
    };
  } catch {
    return {
      pipelines: [],
      hasSubshell: true,
      hasParseError: true,
    };
  }
}

export function inspectShellAst(ast: ShellCompoundNode): {
  dangerousReason?: string;
  isStrictlySafe: boolean;
  hasSubshell: boolean;
} {
  if (ast.hasParseError) {
    return { isStrictlySafe: false, hasSubshell: true };
  }

  for (const entry of ast.pipelines) {
    const cmds = entry.pipeline.commands;
    if (cmds.length > 1) {
      for (let i = 1; i < cmds.length; i++) {
        const execName = (cmds[i]?.executable ?? "").toLowerCase().replace(/\.exe$/, "");
        if (DANGEROUS_PIPELINE_DESTINATIONS.has(execName) || (execName === "sudo" && cmds[i]?.args.some((a) => DANGEROUS_PIPELINE_DESTINATIONS.has(a.toLowerCase())))) {
          return {
            dangerousReason: "remote script or dynamic input piped directly into shell interpreter",
            isStrictlySafe: false,
            hasSubshell: ast.hasSubshell,
          };
        }
      }
    }
  }

  if (ast.hasSubshell || ast.pipelines.length === 0) {
    return { isStrictlySafe: false, hasSubshell: ast.hasSubshell };
  }

  let allSafe = true;
  for (const entry of ast.pipelines) {
    for (const cmd of entry.pipeline.commands) {
      if (cmd.redirects.some((r) => r.type === ">" || r.type === ">>")) {
        allSafe = false;
        break;
      }
      if (!isSafeCommandNode(cmd)) {
        allSafe = false;
        break;
      }
    }
    if (!allSafe) break;
  }

  return {
    isStrictlySafe: allSafe,
    hasSubshell: ast.hasSubshell,
  };
}

function isSafeCommandNode(cmd: ShellCommandNode): boolean {
  if (cmd.hasSubshell) return false;
  const exec = cmd.executable.toLowerCase().replace(/\.exe$/, "");
  const full = `${exec} ${cmd.args.join(" ")}`.trim();

  if (exec === "git") {
    const sub = (cmd.args[0] ?? "").toLowerCase();
    const safeGitSubs = ["status", "log", "diff", "show", "branch", "rev-parse", "ls-files"];
    if (!safeGitSubs.includes(sub)) return false;
    if (full.includes("--output") || full.includes("--ext-diff") || full.includes("--textconv")) return false;
    if (sub === "branch") {
      const hasBranchMutation = cmd.args.some((arg) => /^(?:-[dDmMfFcC]|--(?:delete|move|rename|force|copy|edit|set-upstream|unset-upstream))/.test(arg));
      if (hasBranchMutation) return false;
    }
    return true;
  }

  if (exec === "pwd") return true;
  return false;
}

export class PermissionPolicy {
  private readonly taskAllows = new Set<string>();
  private readonly registeredKinds = new Map<string, ToolKind>();

  constructor(private readonly config: PermissionConfig) {}

  registerTools(tools: readonly { name: string; kind?: ToolKind }[]): void {
    this.registeredKinds.clear();
    for (const tool of tools) this.registeredKinds.set(canonicalTool(tool.name), tool.kind ?? inferToolKind(tool.name));
  }

  async decide(call: ToolCall, level: number, kind: ToolKind = inferToolKind(call.name)): Promise<ApprovalDecision> {
    const path = kind === "command" ? undefined : extractPath(call);
    const resolvedPath = path === undefined ? undefined : await resolvePhysicalPath(path, this.config.workspace);

    if (path !== undefined && resolvedPath === undefined) {
      return decision("deny", `path could not be resolved safely: ${path}`, "path-sandbox", level);
    }

    if (this.config.mode === "plan"
      && kind === "write"
      && this.registeredKinds.get(canonicalTool(call.name)) === "write"
      && resolvedPath !== undefined) {
      const planRoot = await resolvePhysicalPath(this.config.planDirectory, this.config.workspace);
      if (planRoot !== undefined && isWithinPath(planRoot, resolvedPath)) {
        return decision("allow", "plan files may be written inside .oran/plans", "plan-directory", level);
      }
    }

    if (kind === "command") {
      const command = extractRuleContent(call, kind);
      const dangerous = DANGEROUS_COMMANDS.find((item) => item.pattern.test(command));
      if (dangerous) {
        return decision("deny", `blocked dangerous command: ${dangerous.label}`, "dangerous-command", level);
      }
      const ast = parseShellCommand(command);
      const astCheck = inspectShellAst(ast);
      if (astCheck.dangerousReason) {
        return decision("deny", `blocked dangerous command: ${astCheck.dangerousReason}`, "dangerous-command", level);
      }
      if (isSafeCommand(command)) {
        return decision("allow", "recognized read-only command without shell metacharacters", "safe-command", level);
      }
    }

    if (kind !== "command" && resolvedPath !== undefined) {
      const roots = await Promise.all(this.config.allowedRoots.map((root) => resolvePhysicalPath(root, this.config.workspace)));
      if (!roots.some((root) => root !== undefined && isWithinPath(root, resolvedPath))) {
        return decision("deny", `path escapes the allowed workspace and temporary roots: ${path ?? "(missing path)"}`, "path-sandbox", level);
      }
    }

    if (this.taskAllows.has(ruleKey(call, kind))) {
      return decision("allow", "allowed for the current task", "session-rule", level);
    }

    const layers: readonly [PermissionDecisionSource, string][] = [
      ["local-rule", this.config.localRulesPath],
      ["project-rule", this.config.projectRulesPath],
      ["user-rule", this.config.userRulesPath],
    ];
    for (const [source, file] of layers) {
      const rule = findMatchingRule(await loadRules(file), call, kind, this.registeredKinds);
      if (rule) return decision(rule.effect, `${rule.effect} rule matched ${formatRule(rule)}`, source, level);
    }

    return modeDecision(this.config.mode, kind, level);
  }

  allowForTask(call: ToolCall): void {
    const kind = this.registeredKinds.get(canonicalTool(call.name)) ?? inferToolKind(call.name);
    this.taskAllows.add(ruleKey(call, kind));
  }

  async allowPermanently(call: ToolCall): Promise<void> {
    const kind = this.registeredKinds.get(canonicalTool(call.name)) ?? inferToolKind(call.name);
    const existing = await loadRuleDocumentForWrite(this.config.localRulesPath);
    const rules = Array.isArray(existing.rules) ? existing.rules.filter(isWritableRule) : [];
    const nextRule = {
      rule: formatRule({
        tool: call.name,
        pattern: exactPattern(call, kind),
        effect: "allow",
        match: "exact",
      }),
      effect: "allow" as const,
      match: "exact" as const,
    };
    if (!rules.some((item) => (
      item.rule === nextRule.rule && item.effect === "allow" && item.match === "exact"
    ))) rules.push(nextRule);
    await mkdir(dirname(this.config.localRulesPath), { recursive: true });
    const temporary = `${this.config.localRulesPath}.tmp-${process.pid}`;
    await writeFile(temporary, stringify({ ...existing, rules }), "utf8");
    await rename(temporary, this.config.localRulesPath);
  }
}

export function structuredPermissionDenial(call: ToolCall, result: ApprovalDecision): string {
  return JSON.stringify({
    error: {
      type: "permission_denied",
      source: result.source,
      tool: call.name,
      reason: result.reason,
    },
    instruction: "This tool call was blocked by Oran code's safety policy. Tell the user what was blocked and why; do not describe how to execute the blocked operation.",
  }, null, 2);
}

function decision(
  verdict: PermissionVerdict,
  reason: string,
  source: PermissionDecisionSource,
  level: number,
): ApprovalDecision {
  return { verdict, reason, source, level };
}

function modeDecision(mode: PermissionMode, kind: ToolKind, level: number): ApprovalDecision {
  const allow = kind === "readonly" || mode === "bypass" || (mode === "accept-edits" && kind === "write");
  return decision(
    allow ? "allow" : "ask",
    allow ? `${mode} mode allows ${kind} tools` : `${mode} mode requires approval for ${kind} tools`,
    "permission-mode",
    level,
  );
}

function isSafeCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized || SHELL_META.test(normalized) || /['"]/.test(normalized)) return false;
  const prefix = SAFE_COMMAND_PREFIXES.find((candidate) => (
    normalized === candidate || normalized.startsWith(`${candidate} `) || normalized.startsWith(`${candidate}\t`)
  ));
  if (!prefix) return false;
  if (/\bgit\b[\s\S]*(?:--output(?:=|\s|$)|--ext-diff\b|--textconv\b)/i.test(normalized)) return false;
  if (prefix === "git branch" && /(?:^|\s)(?:-[^-\s]*[dDmMfF]|--(?:delete|move|rename|force|copy|edit|set-upstream|unset-upstream))(?:=|\s|$)/i.test(normalized)) return false;
  return true;
}

function inferToolKind(name: string): ToolKind {
  if (["write_file", "edit_file", "apply_patch", "write_plan", "apply_diff"].includes(name)) return "write";
  if (["list_files", "read_file", "glob_files", "search_code", "git_status", "get_diff"].includes(name)) return "readonly";
  return "command";
}

function extractPath(call: ToolCall): string | undefined {
  for (const key of ["path", "file_path", "target_path"]) {
    const value = call.arguments[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function extractRuleContent(call: ToolCall, kind: ToolKind): string {
  if (kind === "command") return typeof call.arguments.command === "string" ? call.arguments.command.trim() : "";
  if (["glob_files", "search_code"].includes(canonicalTool(call.name))) {
    const pattern = call.arguments.pattern;
    return typeof pattern === "string" ? pattern.trim() : "";
  }
  const path = extractPath(call);
  if (path !== undefined) return path.replaceAll("\\", "/");
  for (const key of ["pattern", "glob", "query"]) {
    const value = call.arguments[key];
    if (typeof value === "string") return value.trim();
  }
  return "";
}

function exactPattern(call: ToolCall, kind: ToolKind): string {
  return extractRuleContent(call, kind);
}

function ruleKey(call: ToolCall, kind: ToolKind): string {
  return `${canonicalTool(call.name)}\u0000${kind}\u0000${stableArguments(call.arguments)}`;
}

function stableArguments(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableArguments).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
    `${JSON.stringify(key)}:${stableArguments((value as Record<string, unknown>)[key])}`
  )).join(",")}}`;
}

function formatRule(rule: PermissionRule): string {
  return `${rule.tool}(${rule.pattern})`;
}

async function loadRules(path: string): Promise<PermissionRule[]> {
  try {
    return normalizeRules(parse(await readFile(path, "utf8")));
  } catch (error) {
    // ENOENT is expected when no permission file exists; other errors (YAML
    // syntax, invalid structure) are surfaced so users can fix the file.
    if ((error as { code?: string }).code === "ENOENT") return [];
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`warning: failed to parse permission rules from ${path}: ${detail}`);
    return [];
  }
}

async function loadRuleDocumentForWrite(path: string): Promise<Record<string, unknown>> {
  try {
    const document = parse(await readFile(path, "utf8"));
    if (Array.isArray(document)) return { rules: document };
    if (document && typeof document === "object") return document as Record<string, unknown>;
    return {};
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw new Error(`cannot update malformed permission file ${path}`);
  }
}

function normalizeRules(document: unknown): PermissionRule[] {
  const records: unknown[] = [];
  if (Array.isArray(document)) records.push(...document);
  else if (document && typeof document === "object") {
    const root = document as Record<string, unknown>;
    if (Array.isArray(root.rules)) records.push(...root.rules);
    collectEffectRules(records, root.allow, "allow");
    collectEffectRules(records, root.deny, "deny");
    if (root.permissions && typeof root.permissions === "object" && !Array.isArray(root.permissions)) {
      const permissions = root.permissions as Record<string, unknown>;
      collectEffectRules(records, permissions.allow, "allow");
      collectEffectRules(records, permissions.deny, "deny");
    }
  }
  return records.map(parseRule).filter((rule): rule is PermissionRule => rule !== undefined);
}

function collectEffectRules(records: unknown[], value: unknown, effect: "allow" | "deny"): void {
  if (!Array.isArray(value)) return;
  for (const rule of value) records.push(typeof rule === "string" ? { rule, effect } : rule);
}

function parseRule(value: unknown): PermissionRule | undefined {
  if (typeof value === "string") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const effect = item.effect === "allow" || item.effect === "deny" ? item.effect : undefined;
  const match = item.match === undefined || item.match === "glob"
    ? "glob"
    : item.match === "exact" ? "exact" : undefined;
  if (!effect || !match) return undefined;
  if (typeof item.rule === "string") return parseRuleText(item.rule, effect, match);
  if (typeof item.tool === "string" && typeof item.pattern === "string") {
    return { tool: canonicalTool(item.tool), pattern: item.pattern, effect, match };
  }
  return undefined;
}

function parseRuleText(
  value: string,
  effect: "allow" | "deny",
  matchKind: "exact" | "glob",
): PermissionRule | undefined {
  const parsed = /^\s*([^()]+?)\s*\(([\s\S]*)\)\s*$/.exec(value);
  if (!parsed) return undefined;
  return { tool: canonicalTool(parsed[1] ?? ""), pattern: parsed[2] ?? "", effect, match: matchKind };
}

function canonicalTool(value: string): string {
  const normalized = value.trim().toLowerCase();
  return TOOL_ALIASES[normalized] ?? normalized;
}

function findMatchingRule(
  rules: readonly PermissionRule[],
  call: ToolCall,
  kind: ToolKind,
  registeredKinds: ReadonlyMap<string, ToolKind>,
): PermissionRule | undefined {
  const tool = canonicalTool(call.name);
  const content = extractRuleContent(call, kind);
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (!rule || !registeredKinds.has(canonicalTool(rule.tool)) || canonicalTool(rule.tool) !== tool) continue;
    if (rule.match === "exact" ? rule.pattern === content : matchesPattern(rule.pattern, content)) return rule;
  }
  return undefined;
}

export function matchesPattern(pattern: string, value: string): boolean {
  if (!/[?*]/.test(pattern)) return value === pattern;
  let source = "";
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index] ?? "";
    if (character === "*" && pattern[index + 1] === "*") {
      // ** crosses directory boundaries (gitignore); * stays within one segment.
      source += ".*";
      index += 2;
      while (pattern[index] === "*") index += 1;
    } else if (character === "*") {
      source += "[^/\\\\]*";
      index += 1;
    } else if (character === "?") {
      source += "[^/\\\\]";
      index += 1;
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      index += 1;
    }
  }
  try {
    return new RegExp(`^${source}$`, "i").test(value);
  } catch {
    return false;
  }
}

function isWritableRule(value: unknown): value is Record<string, unknown> & { effect: "allow" | "deny" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const hasRuleText = typeof item.rule === "string";
  const hasStructuredRule = typeof item.tool === "string" && typeof item.pattern === "string";
  const hasValidMatch = item.match === undefined || item.match === "exact" || item.match === "glob";
  return (hasRuleText || hasStructuredRule)
    && (item.effect === "allow" || item.effect === "deny")
    && hasValidMatch;
}
