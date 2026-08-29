#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const CASES_ROOT = path.resolve(ROOT, "evals", "cases");
const WORKSPACES_ROOT = path.resolve(ROOT, "evals", "workspaces");
const RESULTS_ROOT = path.resolve(ROOT, "evals", "results");
const CLI_PATH = path.resolve(ROOT, "packages", "oran-code", "dist", "cli.js");

function printHelp() {
  console.log(`Oran Code resume evaluation runner

Usage:
  pnpm eval:resume -- --model <provider/model> [options]

Required:
  --model <name>       Configured Oran Code model reference.

Options:
  --runs <n>           Runs per case (default: 2).
  --case <id[,id...]>  Select cases; repeatable.
  --smoke              Run one selected/discovered case once.
  --dry-run            Validate case definitions and print the execution plan.
  --help, -h           Show this help.

Case layout:
  evals/cases/<id>/case.json
  evals/cases/<id>/prompt.md
  evals/cases/<id>/fixture/
  evals/cases/<id>/verify.mjs

Success is determined only by protected-path checks and external verification,
not by the Agent's completion message.`);
}

function parseArgs(argv) {
  const options = {
    model: undefined,
    runs: 2,
    runsExplicit: false,
    cases: [],
    smoke: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--smoke") options.smoke = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--model") options.model = requireValue(argv, ++index, arg);
    else if (arg.startsWith("--model=")) options.model = arg.slice("--model=".length);
    else if (arg === "--runs") {
      options.runs = parsePositiveInteger(requireValue(argv, ++index, arg), arg);
      options.runsExplicit = true;
    } else if (arg.startsWith("--runs=")) {
      options.runs = parsePositiveInteger(arg.slice("--runs=".length), "--runs");
      options.runsExplicit = true;
    } else if (arg === "--case") {
      options.cases.push(...splitCases(requireValue(argv, ++index, arg)));
    } else if (arg.startsWith("--case=")) {
      options.cases.push(...splitCases(arg.slice("--case=".length)));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.cases = [...new Set(options.cases)];
  if (options.smoke && !options.runsExplicit) options.runs = 1;
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function splitCases(value) {
  const values = value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error("--case requires at least one case id");
  return values;
}

function timestampForPath(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainder = pad(Math.abs(offsetMinutes) % 60);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${sign}${offsetHours}${offsetRemainder}`;
}

function localIso(date = new Date()) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainder = pad(Math.abs(offsetMinutes) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${offsetHours}:${offsetRemainder}`;
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function safeRemove(target, allowedRoot) {
  if (!isWithin(allowedRoot, target) || path.resolve(target) === path.resolve(allowedRoot)) {
    throw new Error(`Refusing to remove path outside the intended workspace root: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

async function discoverCaseIds() {
  if (!(await exists(CASES_ROOT))) return [];
  const entries = await readdir(CASES_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function assertString(value, field, caseId) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Case ${caseId}: ${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(value, field, caseId) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Case ${caseId}: ${field} must be an array of non-empty strings`);
  }
  return value;
}

async function loadCase(caseId) {
  const caseDir = path.resolve(CASES_ROOT, caseId);
  if (!isWithin(CASES_ROOT, caseDir)) throw new Error(`Invalid case id: ${caseId}`);

  const configPath = path.join(caseDir, "case.json");
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const id = assertString(raw.id, "id", caseId);
  if (id !== caseId) throw new Error(`Case directory ${caseId} does not match case.json id ${id}`);

  const promptFile = assertString(raw.promptFile, "promptFile", caseId);
  const fixtureDir = assertString(raw.fixtureDir, "fixtureDir", caseId);
  const promptPath = path.resolve(caseDir, promptFile);
  const fixturePath = path.resolve(caseDir, fixtureDir);
  if (!isWithin(caseDir, promptPath) || !isWithin(caseDir, fixturePath)) {
    throw new Error(`Case ${caseId}: promptFile and fixtureDir must stay inside the case directory`);
  }

  const timeoutMs = raw.timeoutMs ?? 300_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`Case ${caseId}: timeoutMs must be a positive integer`);
  }

  const hiddenVerifier =
    raw.hiddenVerifier === undefined
      ? undefined
      : path.resolve(caseDir, assertString(raw.hiddenVerifier, "hiddenVerifier", caseId));
  if (hiddenVerifier && !isWithin(caseDir, hiddenVerifier)) {
    throw new Error(`Case ${caseId}: hiddenVerifier must stay inside the case directory and outside fixture/`);
  }
  if (hiddenVerifier && isWithin(fixturePath, hiddenVerifier)) {
    throw new Error(`Case ${caseId}: hiddenVerifier must not be inside fixtureDir`);
  }

  const definition = {
    id,
    title: assertString(raw.title, "title", caseId),
    category: assertString(raw.category, "category", caseId),
    promptFile,
    fixtureDir,
    setupCommands: stringArray(raw.setupCommands, "setupCommands", caseId),
    verifyCommands: stringArray(raw.verifyCommands, "verifyCommands", caseId),
    hiddenVerifier: hiddenVerifier ? path.relative(caseDir, hiddenVerifier) : undefined,
    protectedPaths: stringArray(raw.protectedPaths, "protectedPaths", caseId),
    timeoutMs,
  };

  await access(promptPath);
  const fixtureStats = await stat(fixturePath);
  if (!fixtureStats.isDirectory()) throw new Error(`Case ${caseId}: fixtureDir is not a directory`);
  if (hiddenVerifier) await access(hiddenVerifier);

  return { definition, caseDir, promptPath, fixturePath, hiddenVerifier };
}

async function runProcess(command, args, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 300_000;
  let timedOut = false;
  let timer;

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    windowsHide: true,
    shell: options.shell ?? false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  if (timeoutMs > 0) {
    timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child.pid);
    }, timeoutMs);
  }

  try {
    const { exitCode, signal } = await completion;
    return {
      command: [command, ...args].join(" "),
      exitCode,
      signal,
      timedOut,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", resolve);
      killer.once("close", resolve);
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already exited */
    }
  }
}

async function runShellCommand(command, cwd, timeoutMs, env = {}) {
  if (process.platform === "win32") {
    const executable = process.env.RESUME_EVAL_POWERSHELL || "powershell.exe";
    return runProcess(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { cwd, timeoutMs, env },
    );
  }
  return runProcess("/bin/sh", ["-lc", command], { cwd, timeoutMs, env });
}

async function runCommandList(commands, cwd, timeoutMs, env) {
  const results = [];
  for (const command of commands) {
    const result = await runShellCommand(command, cwd, timeoutMs, env);
    results.push(result);
    if (result.exitCode !== 0 || result.timedOut) break;
  }
  return results;
}

function commandsPassed(results, expectedCount) {
  return results.length === expectedCount && results.every((result) => result.exitCode === 0 && !result.timedOut);
}

async function hashPath(target) {
  const digest = createHash("sha256");
  if (!(await exists(target))) {
    digest.update("missing\0");
    return digest.digest("hex");
  }

  const info = await stat(target);
  if (info.isFile()) {
    digest.update("file\0");
    digest.update(await readFile(target));
    return digest.digest("hex");
  }
  if (!info.isDirectory()) {
    digest.update(`other\0${info.size}\0${info.mtimeMs}`);
    return digest.digest("hex");
  }

  digest.update("directory\0");
  const files = await walkFiles(target);
  for (const file of files) {
    const relative = path.relative(target, file).split(path.sep).join("/");
    digest.update(relative);
    digest.update("\0");
    digest.update(await readFile(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function walkFiles(root) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(root);
  return files;
}

function hasGlobMagic(value) {
  return /[*?]/.test(value);
}

function globToRegExp(pattern) {
  const normalized = pattern.split(path.sep).join("/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`${source}$`, process.platform === "win32" ? "i" : "");
}

async function hashProtectedPattern(workspace, pattern) {
  const normalized = pattern.split("\\").join("/");
  if (!hasGlobMagic(normalized)) {
    const target = path.resolve(workspace, normalized);
    if (!isWithin(workspace, target)) {
      throw new Error(`protectedPaths entry escapes workspace: ${pattern}`);
    }
    return hashPath(target);
  }

  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`protectedPaths entry escapes workspace: ${pattern}`);
  }
  const matcher = globToRegExp(normalized);
  const digest = createHash("sha256");
  const matches = [];
  for (const file of await walkFiles(workspace)) {
    const relative = path.relative(workspace, file).split(path.sep).join("/");
    if (matcher.test(relative)) matches.push({ file, relative });
  }
  if (matches.length === 0) digest.update("no-matches\0");
  for (const match of matches) {
    digest.update(match.relative);
    digest.update("\0");
    digest.update(await readFile(match.file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function hashProtectedPaths(workspace, protectedPaths) {
  const hashes = {};
  for (const protectedPath of protectedPaths) {
    hashes[protectedPath] = await hashProtectedPattern(workspace, protectedPath);
  }
  return hashes;
}

async function snapshotWorkspace(workspace) {
  const snapshot = {};
  const files = await walkFiles(workspace);
  for (const file of files) {
    const relative = path.relative(workspace, file).split(path.sep).join("/");
    if (relative.startsWith(".git/")) continue;
    const info = await stat(file);
    snapshot[relative] = { hash: await hashPath(file), size: info.size };
  }
  return snapshot;
}

function renderSnapshotDiff(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const lines = [];
  for (const name of names) {
    if (!(name in before)) lines.push(`A\t${name}\t${after[name].size} bytes`);
    else if (!(name in after)) lines.push(`D\t${name}\t${before[name].size} bytes`);
    else if (before[name].hash !== after[name].hash) {
      lines.push(`M\t${name}\t${before[name].size} -> ${after[name].size} bytes`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "No file changes detected.\n";
}

async function captureDiff(workspace, beforeSnapshot) {
  const afterSnapshot = await snapshotWorkspace(workspace);
  const manifestDiff = renderSnapshotDiff(beforeSnapshot, afterSnapshot);
  if (await exists(path.join(workspace, ".git"))) {
    const result = await runProcess("git", ["diff", "--binary", "--no-ext-diff"], {
      cwd: workspace,
      timeoutMs: 30_000,
    });
    if (result.exitCode === 0) {
      return `# File manifest\n${manifestDiff}\n# Git diff\n${result.stdout || "No tracked changes detected.\n"}`;
    }
  }
  return manifestDiff;
}

async function gitCommit() {
  const result = await runProcess("git", ["rev-parse", "HEAD"], { cwd: ROOT, timeoutMs: 10_000 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function publicCommandResult(result) {
  return {
    command: result.command,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  };
}

async function writeCommandLogs(runDir, prefix, results) {
  for (let index = 0; index < results.length; index += 1) {
    const label = `${prefix}-${String(index + 1).padStart(2, "0")}`;
    await writeFile(path.join(runDir, `${label}.stdout.log`), results[index].stdout, "utf8");
    await writeFile(path.join(runDir, `${label}.stderr.log`), results[index].stderr, "utf8");
  }
}

async function runHiddenVerifier(caseInfo, workspace, timeoutMs, env) {
  if (!caseInfo.hiddenVerifier) return null;
  return runProcess(process.execPath, [caseInfo.hiddenVerifier, workspace], {
    cwd: caseInfo.caseDir,
    timeoutMs,
    env,
  });
}

function determineFailureReason({ setupPassed, agentResult, protectedChanged, verifyPassed, hiddenPassed }) {
  if (!setupPassed) return "setup_failed";
  if (agentResult.timedOut) return "agent_timeout";
  if (agentResult.exitCode !== 0) return "agent_failed";
  if (protectedChanged.length > 0) return "protected_path_changed";
  if (!verifyPassed) return "verification_failed";
  if (!hiddenPassed) return "hidden_verifier_failed";
  return null;
}

async function executeRun({ caseInfo, runNumber, batch, model, commit, resultsDir }) {
  const runLabel = `run-${String(runNumber).padStart(2, "0")}`;
  const workspace = path.join(WORKSPACES_ROOT, batch, caseInfo.definition.id, runLabel);
  const runDir = path.join(resultsDir, caseInfo.definition.id, runLabel);
  await mkdir(path.dirname(workspace), { recursive: true });
  await safeRemove(workspace, WORKSPACES_ROOT);
  await cp(caseInfo.fixturePath, workspace, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });

  const prompt = await readFile(caseInfo.promptPath, "utf8");
  const env = {
    RESUME_EVAL_CASE_ID: caseInfo.definition.id,
    RESUME_EVAL_RUN: String(runNumber),
    RESUME_EVAL_WORKSPACE: workspace,
  };
  const startedAt = Date.now();

  const setupResults = await runCommandList(
    caseInfo.definition.setupCommands,
    workspace,
    caseInfo.definition.timeoutMs,
    env,
  );
  const setupPassed = commandsPassed(setupResults, caseInfo.definition.setupCommands.length);
  await writeCommandLogs(runDir, "setup", setupResults);
  const beforeSnapshot = await snapshotWorkspace(workspace);
  const protectedBefore = setupPassed ? await hashProtectedPaths(workspace, caseInfo.definition.protectedPaths) : {};

  let agentResult = {
    command: "not run because setup failed",
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdout: "",
    stderr: "",
  };

  if (setupPassed) {
    agentResult = await runProcess(
      process.execPath,
      [CLI_PATH, "run", prompt, "--workspace", workspace, "--model", model, "--approve-all"],
      { cwd: ROOT, timeoutMs: caseInfo.definition.timeoutMs, env },
    );
  }

  await writeFile(path.join(runDir, "stdout.log"), agentResult.stdout, "utf8");
  await writeFile(path.join(runDir, "stderr.log"), agentResult.stderr, "utf8");
  await writeFile(path.join(runDir, "diff.patch"), await captureDiff(workspace, beforeSnapshot), "utf8");

  const protectedAfter = setupPassed ? await hashProtectedPaths(workspace, caseInfo.definition.protectedPaths) : {};
  const protectedChanged = caseInfo.definition.protectedPaths.filter(
    (relativePath) => protectedBefore[relativePath] !== protectedAfter[relativePath],
  );

  const verifyResults = setupPassed
    ? await runCommandList(caseInfo.definition.verifyCommands, workspace, caseInfo.definition.timeoutMs, env)
    : [];
  const verifyPassed = setupPassed && commandsPassed(verifyResults, caseInfo.definition.verifyCommands.length);
  await writeCommandLogs(runDir, "verify", verifyResults);

  const hiddenResult = setupPassed
    ? await runHiddenVerifier(caseInfo, workspace, caseInfo.definition.timeoutMs, env)
    : null;
  const hiddenPassed = hiddenResult === null || (hiddenResult.exitCode === 0 && !hiddenResult.timedOut);
  if (hiddenResult) {
    await writeFile(path.join(runDir, "hidden-verifier.stdout.log"), hiddenResult.stdout, "utf8");
    await writeFile(path.join(runDir, "hidden-verifier.stderr.log"), hiddenResult.stderr, "utf8");
  }

  const failureReason = determineFailureReason({
    setupPassed,
    agentResult,
    protectedChanged,
    verifyPassed,
    hiddenPassed,
  });
  const success = failureReason === null;
  const finishedAt = Date.now();
  const runResult = {
    date: localIso(new Date(startedAt)),
    gitCommit: commit,
    model,
    case: {
      id: caseInfo.definition.id,
      title: caseInfo.definition.title,
      category: caseInfo.definition.category,
    },
    run: runNumber,
    agentExitCode: agentResult.exitCode,
    verification: {
      setup: setupResults.map(publicCommandResult),
      protectedPaths: {
        checked: caseInfo.definition.protectedPaths,
        changed: protectedChanged,
        passed: protectedChanged.length === 0,
      },
      commands: verifyResults.map(publicCommandResult),
      commandsPassed: verifyPassed,
      hiddenVerifier: hiddenResult ? publicCommandResult(hiddenResult) : null,
      hiddenVerifierPassed: hiddenPassed,
    },
    durationMs: finishedAt - startedAt,
    success,
    failureReason,
  };

  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(runResult, null, 2)}\n`, "utf8");
  return runResult;
}

function renderSummary(summary) {
  const lines = [
    "# Oran Code Resume Evaluation",
    "",
    `- Date: ${summary.date}`,
    `- Git commit: ${summary.gitCommit ?? "unknown"}`,
    `- Model: ${summary.model}`,
    `- Cases: ${summary.caseCount}`,
    `- Runs per case: ${summary.runsPerCase}`,
    `- Total runs: ${summary.totalRuns}`,
    `- Passed: ${summary.passedRuns}/${summary.totalRuns}`,
    "",
    "| Case | Category | Run | Result | Duration | Failure reason |",
    "| --- | --- | ---: | --- | ---: | --- |",
  ];

  for (const result of summary.results) {
    lines.push(
      `| ${result.case.id} | ${result.case.category} | ${result.run} | ${result.success ? "PASS" : "FAIL"} | ${result.durationMs} ms | ${result.failureReason ?? "-"} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.model) throw new Error("--model is required");

  const discovered = await discoverCaseIds();
  let selected = options.cases.length > 0 ? options.cases : discovered;
  if (options.smoke) selected = selected.slice(0, 1);
  if (selected.length === 0) {
    if (options.dryRun) {
      console.log(`No cases found under ${CASES_ROOT}`);
      return;
    }
    throw new Error(`No cases selected or found under ${CASES_ROOT}`);
  }

  const cases = [];
  for (const caseId of selected) cases.push(await loadCase(caseId));

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          model: options.model,
          runs: options.runs,
          smoke: options.smoke,
          cases: cases.map((item) => item.definition),
        },
        null,
        2,
      ),
    );
    return;
  }

  await access(CLI_PATH);
  const batch = timestampForPath();
  const resultsDir = path.join(RESULTS_ROOT, batch);
  await mkdir(resultsDir, { recursive: true });
  const commit = await gitCommit();
  const results = [];

  for (const caseInfo of cases) {
    for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
      console.log(`[resume-eval] ${caseInfo.definition.id} ${runNumber}/${options.runs}`);
      const result = await executeRun({
        caseInfo,
        runNumber,
        batch,
        model: options.model,
        commit,
        resultsDir,
      });
      results.push(result);
      console.log(
        `[resume-eval] ${result.success ? "PASS" : "FAIL"} ${caseInfo.definition.id} ${runNumber}/${options.runs}${result.failureReason ? ` (${result.failureReason})` : ""}`,
      );
    }
  }

  const passedRuns = results.filter((result) => result.success).length;
  const summary = {
    date: localIso(),
    gitCommit: commit,
    model: options.model,
    batch,
    caseCount: cases.length,
    runsPerCase: options.runs,
    totalRuns: results.length,
    passedRuns,
    failedRuns: results.length - passedRuns,
    successRate: results.length > 0 ? passedRuns / results.length : 0,
    results,
  };
  await writeFile(path.join(resultsDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(resultsDir, "summary.md"), renderSummary(summary), "utf8");
  console.log(`[resume-eval] completed: ${passedRuns}/${results.length} passed`);
  console.log(`[resume-eval] results: ${resultsDir}`);
  if (passedRuns !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[resume-eval] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
