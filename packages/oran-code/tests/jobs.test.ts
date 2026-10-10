import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerBuiltinTools, ToolRegistry } from "../src/tools.js";
import { ShellJobManager, shellJobNotification } from "../src/tools/jobs.js";
import type { ToolResult } from "../src/types.js";

function createHarness(workspace: string): { registry: ToolRegistry; jobs: ShellJobManager } {
  const registry = new ToolRegistry();
  const jobs = new ShellJobManager();
  registerBuiltinTools(registry, workspace, { jobs });
  registry.activateAll();
  return { registry, jobs };
}

function invoke(registry: ToolRegistry, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return registry.invoke({ name, arguments: args, createdAt: new Date().toISOString() });
}

describe("background shell jobs", () => {
  it("returns a job id and lets the model collect the output later", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-jobs-"));
    try {
      const { registry, jobs } = createHarness(workspace);
      const started = await invoke(registry, "run_command", {
        command: "node -e \"console.log('job-ok')\"",
        run_in_background: true,
      });

      expect(started.ok).toBe(true);
      expect(started.summary).toContain("background job");
      const jobId = started.metadata?.backgroundJobId as string;
      expect(jobId).toBeTruthy();

      const collected = await invoke(registry, "job_output", { job_id: jobId, wait_seconds: 20 });
      expect(collected.ok).toBe(true);
      expect(collected.output).toContain("job-ok");
      expect(collected.output).toContain('status="exited"');

      // 终态作业恰好通知一次,通知文本可注入下一轮请求。
      const notifications = jobs.drainNotifications();
      expect(notifications).toHaveLength(1);
      expect(shellJobNotification(notifications[0]!)).toContain("<job-notification>");
      expect(jobs.drainNotifications()).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }, 30_000);

  it("promotes a foreground command that exceeds its timeout instead of killing it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-jobs-"));
    try {
      const { registry, jobs } = createHarness(workspace);
      const result = await invoke(registry, "run_command", {
        command: "node -e \"setTimeout(() => console.log('late-done'), 2500)\"",
        timeout: 1,
      });

      // 超时不杀进程:结果里给出作业 id,并明确要求不要重跑。
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("still running as background job");
      expect(result.error).toContain("Do not re-run it");
      const jobId = result.metadata?.backgroundJobId as string;
      expect(jobs.get(jobId)?.status).toBe("running");

      const collected = await invoke(registry, "job_output", { job_id: jobId, wait_seconds: 30 });
      expect(collected.ok).toBe(true);
      expect(collected.output).toContain("late-done");
      expect(collected.output).toContain('status="exited"');
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }, 40_000);

  it("kills a running job and reports the final status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-jobs-"));
    try {
      const { registry, jobs } = createHarness(workspace);
      const started = await invoke(registry, "run_command", {
        command: "node -e \"setTimeout(() => console.log('never'), 30000)\"",
        run_in_background: true,
      });
      const jobId = started.metadata?.backgroundJobId as string;

      const killed = await invoke(registry, "job_kill", { job_id: jobId });
      expect(killed.ok).toBe(true);
      expect(killed.summary).toContain("killed");
      expect(jobs.get(jobId)?.status).toBe("killed");
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }, 30_000);

  it("rejects unknown job ids with the list of known jobs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-jobs-"));
    try {
      const { registry } = createHarness(workspace);
      const result = await invoke(registry, "job_output", { job_id: "job-does-not-exist" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("unknown background job");
      expect(result.error).toContain("no background jobs");
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  });

  it("keeps the foreground path and its output formatting unchanged", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-jobs-"));
    try {
      const { registry } = createHarness(workspace);
      const ok = await invoke(registry, "run_command", { command: "node -e \"console.log('fg-ok')\"" });
      expect(ok.ok).toBe(true);
      expect(ok.output).toContain("fg-ok");
      expect(ok.summary).toBe("exit 0");

      const failed = await invoke(registry, "run_command", { command: 'node -e "process.exit(3)"' });
      expect(failed.ok).toBe(false);
      expect(failed.summary).toBe("exit 3");
      expect(failed.error).toContain("exited with code 3");
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }, 30_000);
});
