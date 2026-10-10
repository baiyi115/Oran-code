import type { ToolDefinition, ToolResult } from "../types.js";
import type { ToolFactoryContext } from "./registry.js";
import { errorMessage, numberArg } from "./fs-helpers.js";
import { formatJobOutput, shellJobs, type ShellJobManager, type ShellJobSnapshot } from "./jobs.js";
import { compactShellOutput } from "./output-pipeline.js";
import {
  formatPreservingTail,
  getWindowsCommandDiagnostic,
  resolveCommandCwd,
  startCommand,
  type CommandOutcome,
  type RunningCommand,
} from "./process.js";

export interface CommandToolOptions {
  /** Job-table injection point: tests use an isolated instance, runtime defaults to the process-level singleton. */
  readonly jobs?: ShellJobManager;
}

export function registerCommandTools(
  registry: { register(tool: ToolDefinition): void },
  ctx: ToolFactoryContext,
  options: CommandToolOptions = {},
): void {
  const { activeRoot } = ctx;
  const jobs = options.jobs ?? shellJobs();

  registry.register({
    name: "run_command",
    description:
      "Run a shell command with a timeout. Prefer dedicated file/search/edit tools when they provide the needed operation. " +
      "Returns stdout, stderr, and exit summary. Set run_in_background to start a long-running command (dev server, build, watcher) " +
      "and get a job id back immediately. If a foreground command exceeds its timeout it keeps running in the background as a job " +
      "instead of being killed.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        timeout: { type: "number", description: "Timeout in seconds. Defaults to 60.", default: 60 },
        cwd: {
          type: "string",
          description:
            "Optional working directory, relative or absolute, that must remain inside the workspace root. Defaults to the workspace root.",
        },
        run_in_background: {
          type: "boolean",
          description:
            "Start the command as a background job and return immediately with a job id. Use job_output to read its output and job_kill to stop it. Defaults to false.",
          default: false,
        },
      },
      required: ["command"],
    },
    permissionLevel: 3,
    kind: "command",
    maxOutputChars: 32_000,
    postprocess: compactShellOutput,
    invoke: async (call, context) => {
      const timeoutSeconds = Math.max(1, numberArg(call.arguments.timeout, 60));
      const command = String(call.arguments.command);
      let cwd: string;
      try {
        cwd = await resolveCommandCwd(activeRoot(context), call.arguments.cwd);
      } catch (error) {
        return { ok: false, output: "", error: errorMessage(error), summary: "invalid arguments" };
      }

      if (call.arguments.run_in_background === true) {
        const job = jobs.start({ command, cwd });
        return {
          ok: true,
          output: formatJobStart(job),
          summary: `background job ${job.id} started`,
          metadata: { backgroundJobId: job.id },
        };
      }

      const running = startCommand(command, { cwd, ...(context?.signal ? { signal: context.signal } : {}) });
      const race = await waitForExitOrTimeout(running, timeoutSeconds);
      if (context?.signal?.aborted) {
        running.kill();
        return {
          ok: false,
          output: "",
          error: "command cancelled",
          summary: "cancelled",
          metadata: { cancelled: true },
        };
      }

      if (race.kind === "timeout") {
        // A timeout does not kill the process: it is promoted to a background job, with output and
        // handle preserved as-is, for job_output/job_kill to keep reaping.
        const job = jobs.adopt({ command, cwd, running });
        return {
          ok: false,
          output: formatJobOutput(job, 4_000),
          summary: `timeout after ${timeoutSeconds}s; still running as background job ${job.id}`,
          error:
            `command exceeded its ${timeoutSeconds}s timeout and continues running in the background as ${job.id}. ` +
            `Do not re-run it. Use job_output to read its output and job_kill to stop it.`,
          metadata: { backgroundJobId: job.id, timedOut: true },
        };
      }

      return exitResult(command, timeoutSeconds, race.outcome);
    },
  });

  registry.register({
    name: "job_output",
    description:
      "Read the accumulated output of a background job (started with run_command run_in_background, or promoted after a timeout). " +
      "Use wait_seconds to block until the job finishes or the wait elapses.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id returned by run_command." },
        wait_seconds: {
          type: "number",
          description: "Seconds to wait for the job to finish before returning the current output. Defaults to 0.",
          default: 0,
        },
      },
      required: ["job_id"],
    },
    permissionLevel: 0,
    kind: "readonly",
    // Job output is live data: the same arguments return different results at different times,
    // so it cannot take part in the readonly result cache.
    cacheable: false,
    maxOutputChars: 48_000,
    invoke: async (call) => {
      const id = String(call.arguments.job_id ?? "").trim();
      const waitMs = Math.max(0, Math.min(600, numberArg(call.arguments.wait_seconds, 0))) * 1000;
      const job = await jobs.wait(id, waitMs);
      if (!job) {
        return {
          ok: false,
          output: "",
          error: `unknown background job: ${id || "(missing job_id)"}${describeKnownJobs(jobs)}`,
          summary: "unknown job",
        };
      }
      return { ok: true, output: formatJobOutput(job), summary: `${job.id}: ${job.status}` };
    },
  });

  registry.register({
    name: "job_kill",
    description: "Stop a running background job started by run_command. Returns the final status and captured output.",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string", description: "Job id returned by run_command." } },
      required: ["job_id"],
    },
    permissionLevel: 3,
    kind: "command",
    maxOutputChars: 8_000,
    invoke: async (call) => {
      const id = String(call.arguments.job_id ?? "").trim();
      const job = jobs.kill(id);
      if (!job) {
        return {
          ok: false,
          output: "",
          error: `unknown background job: ${id || "(missing job_id)"}${describeKnownJobs(jobs)}`,
          summary: "unknown job",
        };
      }
      return { ok: true, output: formatJobOutput(job, 4_000), summary: `job ${job.id} ${job.status}` };
    },
  });
}

type ExitRace = { kind: "exited"; outcome: CommandOutcome } | { kind: "timeout" };

function waitForExitOrTimeout(running: RunningCommand, timeoutSeconds: number): Promise<ExitRace> {
  if (timeoutSeconds <= 0) return running.exited.then((outcome) => ({ kind: "exited" as const, outcome }));
  return new Promise<ExitRace>((resolveRace) => {
    // settle is only ever called from a microtask at the earliest, so referencing `timer` after
    // its declaration cannot hit the temporal dead zone.
    const settle = (value: ExitRace): void => {
      clearTimeout(timer);
      resolveRace(value);
    };
    void running.exited.then((outcome) => settle({ kind: "exited", outcome }));
    const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutSeconds * 1000);
    timer.unref?.();
  });
}

function exitResult(command: string, timeoutSeconds: number, outcome: CommandOutcome): ToolResult {
  let output = `${outcome.stdout}${outcome.stderr}`;
  if (outcome.spawnError) {
    return { ok: false, output: formatPreservingTail(output), error: outcome.spawnError, summary: "spawn failed" };
  }
  if (outcome.exitCode === 0) {
    return { ok: true, output: formatPreservingTail(output), summary: "exit 0" };
  }
  const diagnostic = getWindowsCommandDiagnostic(command, output);
  if (diagnostic) output += diagnostic;
  output = formatPreservingTail(output);
  const result: ToolResult = {
    ok: false,
    output,
    summary: outcome.signal ? `terminated by ${outcome.signal}` : `exit ${String(outcome.exitCode ?? "unknown")}`,
  };
  result.error = outcome.signal
    ? `command was terminated by signal ${outcome.signal}`
    : `command exited with code ${String(outcome.exitCode ?? "unknown")} (timeout was ${timeoutSeconds}s)`;
  return result;
}

function formatJobStart(job: ShellJobSnapshot): string {
  return [
    `<job-output id="${job.id}" status="running">`,
    `Command: ${job.command}`,
    "Started in the background. Read output with job_output, stop it with job_kill.",
    "You will receive a notification when it finishes.",
    "</job-output>",
  ].join("\n");
}

function describeKnownJobs(jobs: ShellJobManager): string {
  const known = jobs.list();
  if (!known.length) return "; no background jobs have been started in this process";
  const running = known.filter((job) => job.status === "running");
  const summarized = (running.length ? running : known).slice(0, 5).map((job) => `${job.id} (${job.status})`);
  return `; known jobs: ${summarized.join(", ")}`;
}
