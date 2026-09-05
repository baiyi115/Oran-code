import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

// 危险命令判定基于分词后的 AST(引号已被剥除、按命令逐条检查),
// 避免 `git "reset" --hard` 这类引号绕过和 `+refspec` 强推漏网。
const FORK_BOMB_PATTERN = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
const WINDOWS_VARIABLE_EXPANSION = /%[^%\s]*%/;

const RECURSIVE_FLAG = /^(?:--recursive|-[\w]*r[\w]*)$/i;
const FORCE_FLAG = /^(?:--force|-[\w]*f[\w]*)$/i;
const ROOT_TARGET = /^(?:\/|~|\$HOME)\/?$/i;

function astDangerousReason(ast: ShellCompoundNode): string | undefined {
  for (const entry of ast.pipelines) {
    for (const cmd of entry.pipeline.commands) {
      const reason = commandDanger(cmd);
      if (reason) return reason;
    }
  }
  return undefined;
}

function commandDanger(cmd: ShellCommandNode): string | undefined {
  const exec = cmd.executable.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
  const args = cmd.args;
  if (exec === "sudo" || exec === "doas") {
    const inner = args.findIndex((arg) => !arg.startsWith("-"));
    if (inner < 0) return undefined;
    return commandDanger({ ...cmd, executable: args[inner]!, args: args.slice(inner + 1) });
  }
  if (exec === "rm") {
    if (
      args.some((arg) => RECURSIVE_FLAG.test(arg)) &&
      args.some((arg) => FORCE_FLAG.test(arg)) &&
      args.some((arg) => ROOT_TARGET.test(arg))
    ) {
      return "recursive forced deletion of a root or home directory";
    }
    return undefined;
  }
  if (exec === "remove-item" || exec === "ri") {
    if (
      args.some((arg) => /^-recurse$/i.test(arg)) &&
      args.some((arg) => /^-force$/i.test(arg)) &&
      args.some((arg) => /^[a-z]:\\?$|^\\\\$|^(?:\$HOME|~)\/?$/i.test(arg))
    ) {
      return "recursive forced deletion through PowerShell";
    }
    return undefined;
  }
  if (/^(?:mkfs(?:\.[\w-]+)?|format(?:\.com)?)$/.test(exec)) return "filesystem formatting";
  if (exec === "dd" && args.some((arg) => /^of=\/dev\/|^of=\\\\\.\\PhysicalDrive/i.test(arg))) {
    return "raw write to a block device";
  }
  if (
    exec === "chmod" &&
    args.some((arg) => RECURSIVE_FLAG.test(arg)) &&
    args.some((arg) => /^(?:777|a\+rwx)$/i.test(arg)) &&
    args.some((arg) => ROOT_TARGET.test(arg))
  ) {
    return "recursive permission change on the filesystem root";
  }
  if (exec === "git") {
    const sub = (args[0] ?? "").toLowerCase();
    const rest = args.slice(1);
    if (sub === "push" && rest.some((arg) => arg === "-f" || arg.startsWith("--force") || arg.startsWith("+"))) {
      return "forced git push";
    }
    if (sub === "reset" && rest.includes("--hard")) return "hard git reset";
    if (sub === "clean" && rest.some((arg) => FORCE_FLAG.test(arg))) return "destructive git clean";
  }
  return undefined;
}

const SHELL_META = /[\r\n><|;&`]|\$\(/;
const SAFE_COMMAND_PREFIXES = [
  "pwd",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
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
  redirects: Array<{ type: ">" | ">>" | "<"; target: string; fdDup?: boolean }>;
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

const DANGEROUS_PIPELINE_DESTINATIONS = new Set(["sh", "bash", "zsh", "pwsh", "powershell", "eval", "source", "cmd"]);

export function parseShellCommand(input: string): ShellCompoundNode {
  const text = input.trim();
  if (!text) return { pipelines: [], hasSubshell: false };

  try {
    let index = 0;
    let hasGlobalSubshell = false;

    type Token =
      | { type: "word"; value: string; hasSubshell: boolean }
      | { type: "op"; value: "&&" | "||" | "|" | ";" }
      | { type: "redirect"; op: ">" | ">>" | "<"; fdDup?: boolean; target?: string };

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
      // 单个 & 是后台分隔符,与分号同义;否则 "git log & git status" 会被并进
      // 同一条命令的参数里,结构判断随之失真。
      if (char === "&") {
        tokens.push({ type: "op", value: ";" });
        index += 1;
        continue;
      }
      // "2>&1" 是 fd 复制而非文件写入:记为 fdDup,后续只读判定据此放行。
      if (char === ">" && text[index + 1] === "&") {
        tokens.push({ type: "redirect", op: ">", fdDup: true });
        index += 2;
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
          currentRedirects.push({ type: tok.op, target, ...(tok.fdDup ? { fdDup: true } : {}) });
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
        if (
          DANGEROUS_PIPELINE_DESTINATIONS.has(execName) ||
          (execName === "sudo" && cmds[i]?.args.some((a) => DANGEROUS_PIPELINE_DESTINATIONS.has(a.toLowerCase())))
        ) {
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
      const hasBranchMutation = cmd.args.some((arg) =>
        /^(?:-[dDmMfFcC]|--(?:delete|move|rename|force|copy|edit|set-upstream|unset-upstream))/.test(arg),
      );
      if (hasBranchMutation) return false;
    }
    return true;
  }

  if (exec === "pwd") return true;
  return false;
}

/** 无条件只读的可执行文件:只产出 stdout,不写文件系统、不进入交互模式。 */
const READ_ONLY_EXECUTABLES: ReadonlySet<string> = new Set([
  "pwd",
  "ls",
  "dir",
  "cd",
  "echo",
  "cat",
  "type",
  "head",
  "tail",
  "wc",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "which",
  "where",
  "whoami",
  "hostname",
  "date",
  "grep",
  "rg",
  "findstr",
]);

const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "shortlog",
  "describe",
  "blame",
  "cat-file",
  "diff-tree",
  "ls-tree",
  "count-objects",
  "fsck",
  "verify-pack",
]);

const NULL_DEVICE_TARGETS: ReadonlySet<string> = new Set(["/dev/null", "nul"]);

/** 这些 git 子命令会输出补丁并应用仓库配置的 textconv/ext-diff 驱动。 */
const PATCH_CAPABLE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["diff", "log", "show"]);

/** `-c diff.<name>.command=...` 会在命令行上现场注册外部 diff 驱动。 */
const INLINE_DIFF_DRIVER_ARG = /^diff\.[\w.-]+\.(?:command|textconv)(?:=|$)/i;

function gitInlineDiffDriverConfig(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (INLINE_DIFF_DRIVER_ARG.test(arg)) return true;
    if ((arg === "-c" || arg === "--config") && /^diff\./i.test(args[index + 1] ?? "")) return true;
  }
  return false;
}

/**
 * AST 级只读判定:整条命令的每个管道段都必须命中只读白名单,fd 复制
 * (2>&1)与丢弃到空设备(>/dev/null)放行,其余重定向一律视为写操作。
 * 判定失败只会回落到正常审批,不会放大权限。
 */
export function isReadOnlyShellCommand(ast: ShellCompoundNode): boolean {
  if (ast.hasParseError || ast.hasSubshell || ast.pipelines.length === 0) return false;
  return ast.pipelines.every((entry) => entry.pipeline.commands.every(isReadOnlyCommandNode));
}

function isReadOnlyCommandNode(cmd: ShellCommandNode): boolean {
  if (cmd.hasSubshell) return false;
  if (!cmd.redirects.every(isReadOnlyRedirect)) return false;
  const exec = cmd.executable.toLowerCase().replace(/\.exe$/, "");
  if (exec === "git") return isReadOnlyGitCommand(cmd);
  if (exec === "rg") return isReadOnlyRipgrepCommand(cmd);
  if (exec === "find") {
    return !cmd.args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint)/.test(arg));
  }
  return READ_ONLY_EXECUTABLES.has(exec);
}

function isReadOnlyRipgrepCommand(cmd: ShellCommandNode): boolean {
  // `rg --pre <cmd>` 会对每个被搜文件执行任意程序,与 find 的 -exec 同类,
  // 连同 `--pre=x` 与 `--pre-glob` 取值形式一起拒绝。
  return !cmd.args.some((arg) => /^--pre(?:-glob)?(?:=|$)/.test(arg));
}

function isReadOnlyRedirect(redirect: ShellCommandNode["redirects"][number]): boolean {
  if (redirect.type !== ">") return false;
  if (redirect.fdDup) return /^\d+$/.test(redirect.target);
  return NULL_DEVICE_TARGETS.has(redirect.target.trim().toLowerCase());
}

function isReadOnlyGitCommand(cmd: ShellCommandNode): boolean {
  const sub = (cmd.args[0] ?? "").toLowerCase();
  const rest = cmd.args.slice(1);
  const full = `git ${cmd.args.join(" ")}`;
  if (full.includes("--output") || full.includes("--ext-diff") || full.includes("--textconv")) return false;
  if (GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return true;

  // 条件放行的子命令:仅在确证只读的调用形态下放行,其余回落审批。
  if (sub === "branch") {
    const hasMutation = cmd.args.some((arg) =>
      /^(?:-[dDmMfFcC]|--(?:delete|move|rename|force|copy|edit|set-upstream|unset-upstream))/.test(arg),
    );
    if (hasMutation) return false;
    // `git branch <name>` 会创建分支:仅放行无参或带显式列表旗标的形态。
    if (rest.length === 0) return true;
    return rest.some((arg) => /^(?:-l|--list|-a|-r|-v|-vv|--all|--remotes)$/.test(arg));
  }
  if (sub === "remote") return rest.length === 0 || rest.every((arg) => arg === "-v" || arg === "--verbose");
  if (sub === "config") {
    return rest.length > 0 && (rest[0] === "--list" || rest[0] === "-l" || (rest[0] ?? "").startsWith("--get"));
  }
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
  if (sub === "worktree") return rest.length === 0 || rest[0] === "list";
  if (sub === "reflog") return rest.length === 0 || rest[0] === "show" || rest[0] === "list";
  if (sub === "tag") return rest.every((arg) => arg.startsWith("-"));
  return false;
}

export class PermissionPolicy {
  private readonly taskAllows = new Set<string>();
  private readonly registeredKinds = new Map<string, ToolKind>();
  private resolvedRoots: { key: string; roots: (string | undefined)[] } | undefined;

  constructor(private readonly config: PermissionConfig) {}

  registerTools(tools: readonly { name: string; kind?: ToolKind }[]): void {
    this.registeredKinds.clear();
    for (const tool of tools) this.registeredKinds.set(canonicalTool(tool.name), tool.kind ?? inferToolKind(tool.name));
  }

  private diffDriverCache: { workspace: string; checkedAt: number; hasDrivers: boolean } | undefined;

  /**
   * 只读白名单的最后一道守卫:Windows 上 %VAR% 会在解析前展开(可能注入
   * 元字符),git 的补丁类子命令会应用仓库配置的 textconv/ext-diff 外部
   * 驱动。命中任一情形就不自动放行,回落正常审批。
   */
  private async canAutoAllowShellCommand(command: string, ast: ShellCompoundNode): Promise<boolean> {
    if (process.platform === "win32" && WINDOWS_VARIABLE_EXPANSION.test(command)) return false;
    let needsDriverCheck = false;
    for (const entry of ast.pipelines) {
      for (const cmd of entry.pipeline.commands) {
        if (cmd.executable.toLowerCase().replace(/\.exe$/, "") !== "git") continue;
        if (gitInlineDiffDriverConfig(cmd.args)) return false;
        const rest = cmd.args.slice(1);
        const optedOut = rest.includes("--no-textconv") && rest.includes("--no-ext-diff");
        if (!optedOut && PATCH_CAPABLE_GIT_SUBCOMMANDS.has((cmd.args[0] ?? "").toLowerCase())) {
          needsDriverCheck = true;
        }
      }
    }
    if (needsDriverCheck && (await this.repoDefinesDiffDrivers())) return false;
    return true;
  }

  private async repoDefinesDiffDrivers(): Promise<boolean> {
    const cached = this.diffDriverCache;
    const now = Date.now();
    if (cached && cached.workspace === this.config.workspace && now - cached.checkedAt < 60_000) {
      return cached.hasDrivers;
    }
    let hasDrivers: boolean;
    try {
      // 只查仓库本地配置:系统/全局作用域的驱动(如 Git for Windows 自带的
      // astextplain)不受攻击者控制,纳入检查会让所有 git diff 退回审批。
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          ["config", "--local", "--get-regexp", "^diff\\..*\\.(command|textconv)$"],
          { cwd: this.config.workspace, timeout: 2000 },
          (error, stdout) => {
            // 退出码 1 表示无匹配,属于正常情况。
            if (error && (error as { code?: number }).code !== 1) reject(error);
            else resolve(stdout);
          },
        );
      });
      hasDrivers = stdout.trim().length > 0;
    } catch {
      hasDrivers = false;
    }
    this.diffDriverCache = { workspace: this.config.workspace, checkedAt: now, hasDrivers };
    return hasDrivers;
  }

  async decide(call: ToolCall, level: number, kind: ToolKind = inferToolKind(call.name)): Promise<ApprovalDecision> {
    const path = kind === "command" ? undefined : extractPath(call);
    const resolvedPath = path === undefined ? undefined : await resolvePhysicalPath(path, this.config.workspace);

    if (path !== undefined && resolvedPath === undefined) {
      return decision("deny", `path could not be resolved safely: ${path}`, "path-sandbox", level);
    }

    if (
      this.config.mode === "plan" &&
      kind === "write" &&
      this.registeredKinds.get(canonicalTool(call.name)) === "write" &&
      resolvedPath !== undefined
    ) {
      const planRoot = await resolvePhysicalPath(this.config.planDirectory, this.config.workspace);
      if (planRoot !== undefined && isWithinPath(planRoot, resolvedPath)) {
        return decision("allow", "plan files may be written inside .oran/plans", "plan-directory", level);
      }
    }

    if (kind === "command") {
      const command = extractRuleContent(call, kind);
      if (FORK_BOMB_PATTERN.test(command)) {
        return decision("deny", "blocked dangerous command: shell fork bomb", "dangerous-command", level);
      }
      const ast = parseShellCommand(command);
      const astCheck = inspectShellAst(ast);
      const dangerousReason = astCheck.dangerousReason ?? astDangerousReason(ast);
      if (dangerousReason) {
        return decision("deny", `blocked dangerous command: ${dangerousReason}`, "dangerous-command", level);
      }
      if (isSafeCommand(command) || isReadOnlyShellCommand(ast)) {
        const allowed = await this.canAutoAllowShellCommand(command, ast);
        if (allowed) {
          return decision("allow", "recognized read-only command", "safe-command", level);
        }
      }
    }

    if (kind !== "command" && resolvedPath !== undefined) {
      // allowedRoots 在会话内基本不变,按内容键记忆化物理解析,免去每次调用的 lstat 链。
      const rootsKey = this.config.allowedRoots.join("\u0000");
      if (this.resolvedRoots?.key !== rootsKey) {
        this.resolvedRoots = {
          key: rootsKey,
          roots: await Promise.all(
            this.config.allowedRoots.map((root) => resolvePhysicalPath(root, this.config.workspace)),
          ),
        };
      }
      const roots = this.resolvedRoots.roots;
      if (!roots.some((root) => root !== undefined && isWithinPath(root, resolvedPath))) {
        return decision(
          "deny",
          `path escapes the allowed workspace and temporary roots: ${path ?? "(missing path)"}`,
          "path-sandbox",
          level,
        );
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
    if (!rules.some((item) => item.rule === nextRule.rule && item.effect === "allow" && item.match === "exact"))
      rules.push(nextRule);
    await mkdir(dirname(this.config.localRulesPath), { recursive: true });
    const temporary = `${this.config.localRulesPath}.tmp-${process.pid}`;
    await writeFile(temporary, stringify({ ...existing, rules }), "utf8");
    await rename(temporary, this.config.localRulesPath);
  }
}

export function structuredPermissionDenial(call: ToolCall, result: ApprovalDecision): string {
  return JSON.stringify(
    {
      error: {
        type: "permission_denied",
        source: result.source,
        tool: call.name,
        reason: result.reason,
      },
      instruction:
        "This tool call was blocked by Oran code's safety policy. Tell the user what was blocked and why; do not describe how to execute the blocked operation.",
    },
    null,
    2,
  );
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
  const deny = mode === "readonly" && kind !== "readonly";
  return decision(
    deny ? "deny" : allow ? "allow" : "ask",
    deny
      ? `readonly mode blocks ${kind} tools`
      : allow
        ? `${mode} mode allows ${kind} tools`
        : `${mode} mode requires approval for ${kind} tools`,
    "permission-mode",
    level,
  );
}

function isSafeCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized || SHELL_META.test(normalized) || /['"]/.test(normalized)) return false;
  const prefix = SAFE_COMMAND_PREFIXES.find(
    (candidate) =>
      normalized === candidate || normalized.startsWith(`${candidate} `) || normalized.startsWith(`${candidate}\t`),
  );
  if (!prefix) return false;
  if (/\bgit\b[\s\S]*(?:--output(?:=|\s|$)|--ext-diff\b|--textconv\b)/i.test(normalized)) return false;
  if (prefix === "git branch") {
    // `git branch <name>` 会创建分支:除变异旗标外,还必须是无参或带显式列表旗标。
    const rest = normalized.slice(prefix.length).trim();
    const hasMutationFlag =
      /(?:^|\s)(?:-[^-\s]*[dDmMfF]|--(?:delete|move|rename|force|copy|edit|set-upstream|unset-upstream))(?:=|\s|$)/i.test(
        normalized,
      );
    const hasListFlag = /(?:^|\s)(?:-vv|-v|-l|--list|-a|--all|-r|--remotes)(?:=|\s|$)/.test(rest);
    if (hasMutationFlag || (rest && !hasListFlag)) return false;
  }
  return true;
}

function inferToolKind(name: string): ToolKind {
  if (["write_file", "edit_file", "apply_patch", "write_plan"].includes(name)) return "write";
  if (["list_files", "read_file", "glob_files", "search_code", "git_status", "get_diff"].includes(name))
    return "readonly";
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
  if (kind === "command") {
    // run_command 用命令文本本身;其余 command 类工具(MCP、batch_tools 等)
    // 没有天然的规则内容,退回空串会让"永久允许"写下匹配一切调用的空规则。
    if (canonicalTool(call.name) !== "run_command") return globSafeArguments(call.arguments);
    return typeof call.arguments.command === "string" ? call.arguments.command.trim() : "";
  }
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

function globSafeArguments(value: unknown): string {
  // JSON 里的 / 与 \ 会截断 glob 的单段匹配,先转义,保证 `tool(*)` 这类
  // 用户规则在转义后的内容上仍然成立。
  return stableArguments(value).replace(/\\/g, "\\\\").replace(/\//g, "\\/");
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
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableArguments((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function formatRule(rule: PermissionRule): string {
  return `${rule.tool}(${rule.pattern})`;
}

const rulesCache = new Map<string, { mtimeMs: number; size: number; rules: PermissionRule[] }>();

async function loadRules(path: string): Promise<PermissionRule[]> {
  try {
    const text = await readFile(path, "utf8");
    const stats = await stat(path).catch(() => undefined);
    const cached = stats ? rulesCache.get(path) : undefined;
    if (cached && stats && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.rules;
    const rules = normalizeRules(parse(text));
    if (stats) rulesCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, rules });
    else rulesCache.delete(path);
    return rules;
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
    throw new Error(`cannot update malformed permission file ${path}`, { cause: error });
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
  const match =
    item.match === undefined || item.match === "glob" ? "glob" : item.match === "exact" ? "exact" : undefined;
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
  return (hasRuleText || hasStructuredRule) && (item.effect === "allow" || item.effect === "deny") && hasValidMatch;
}
