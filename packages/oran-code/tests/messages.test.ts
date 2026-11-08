import { describe, expect, it } from "vitest";
import {
  AgentMessageBus,
  formatAgentMessage,
  type AgentMessage,
  type AgentMessageStore,
} from "../src/subagent/messages.js";

class MemoryStore implements AgentMessageStore {
  private messages: readonly AgentMessage[] = [];
  async loadMessages(): Promise<readonly AgentMessage[]> {
    return this.messages.map((message) => ({ ...message }));
  }
  async saveMessages(messages: readonly AgentMessage[]): Promise<void> {
    this.messages = messages.map((message) => ({ ...message }));
  }
}

describe("AgentMessageBus", () => {
  it("routes guidance to the child and reports to the owning parent session", async () => {
    const bus = new AgentMessageBus();
    bus.registerTask("task-1", "session-1");

    expect((await bus.sendToChild("task-1", "use main", "session-1")).ok).toBe(true);
    expect((await bus.sendToParent("task-1", "question", "which branch?")).ok).toBe(true);

    const guidance = await bus.takeForChild("task-1");
    expect(guidance).toMatchObject([{ kind: "guidance", text: "use main", status: "delivered" }]);
    expect(await bus.takeForChild("task-1")).toEqual([]);

    expect(await bus.takeForParent("session-2")).toEqual([]);
    const reports = await bus.takeForParent("session-1");
    expect(reports).toMatchObject([{ kind: "question", text: "which branch?", status: "delivered" }]);
    expect(await bus.takeForParent("session-1")).toEqual([]);
  });

  it("rejects guidance from another session and for inactive tasks", async () => {
    const bus = new AgentMessageBus();
    bus.registerTask("task-1", "session-1");

    const foreign = await bus.sendToChild("task-1", "ignore your task", "session-2");
    expect(foreign.ok).toBe(false);
    expect(foreign.output).toContain("different parent session");

    const missing = await bus.sendToChild("task-2", "hello", "session-1");
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("not active");
  });

  it("marks undelivered guidance and notifies the parent when a task ends", async () => {
    const bus = new AgentMessageBus();
    bus.registerTask("task-1", "session-1");
    await bus.sendToChild("task-1", "stop and report", "session-1");

    await bus.finishTask("task-1");

    const history = await bus.history("task-1", "session-1");
    expect(history).toMatchObject([{ kind: "guidance", status: "undeliverable" }, { kind: "delivery_failed" }]);
    const reports = await bus.takeForParent("session-1");
    expect(reports.map((message) => message.kind)).toEqual(["delivery_failed"]);
  });

  it("returns guidance that arrives while a child waits", async () => {
    const bus = new AgentMessageBus();
    bus.registerTask("task-1", "session-1");

    const waiting = bus.waitForChild("task-1", 1_000);
    setTimeout(() => void bus.sendToChild("task-1", "answer", "session-1"), 10);

    expect(await waiting).toMatchObject([{ text: "answer", status: "delivered" }]);
    expect(await bus.takeForChild("task-1")).toEqual([]);
  });

  it("stops waiting at the timeout and on cancellation", async () => {
    const bus = new AgentMessageBus();
    bus.registerTask("task-1", "session-1");

    const started = Date.now();
    expect(await bus.waitForChild("task-1", 40)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);

    const controller = new AbortController();
    const waiting = bus.waitForChild("task-1", 5_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const cancelStarted = Date.now();
    expect(await waiting).toEqual([]);
    expect(Date.now() - cancelStarted).toBeLessThan(1_000);
  });

  it("enforces message length and per-task queue limits", async () => {
    const bus = new AgentMessageBus();
    bus.registerTask("task-1", "session-1");

    expect((await bus.sendToChild("task-1", "x".repeat(4_001), "session-1")).ok).toBe(false);
    for (let index = 0; index < 16; index += 1) {
      expect((await bus.sendToChild("task-1", `message ${index}`, "session-1")).ok).toBe(true);
    }
    const overflow = await bus.sendToChild("task-1", "one too many", "session-1");
    expect(overflow.ok).toBe(false);
    expect(overflow.output).toContain("queue");
  });

  it("restores queued messages from the store", async () => {
    const store = new MemoryStore();
    const first = new AgentMessageBus(store);
    first.registerTask("task-1", "session-1");
    await first.sendToParent("task-1", "progress", "half done");

    const second = new AgentMessageBus(store);
    const reports = await second.takeForParent("session-1");
    expect(reports).toMatchObject([{ kind: "progress", text: "half done", status: "delivered" }]);
  });

  it("marks injected reports as not user authorization", () => {
    const text = formatAgentMessage({
      id: "m-1",
      taskId: "task-1",
      direction: "to_parent",
      kind: "question",
      text: "which branch?",
      createdAt: new Date().toISOString(),
      status: "queued",
    });
    expect(text).toContain("Subagent report");
    expect(text).toContain("not user authorization");
  });
});
