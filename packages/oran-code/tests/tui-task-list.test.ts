import { describe, expect, it } from "vitest";
import { taskDetailLines, taskListLines } from "../src/tui/task-list.js";
import type { TuiBackgroundTask } from "../src/tui/types.js";

const tasks: TuiBackgroundTask[] = [
  {
    id: "agent-1",
    name: "explore the tui",
    definitionName: "Explore",
    status: "completed",
    startedAt: "2026-10-29T10:00:00.000Z",
    endedAt: "2026-10-29T10:00:12.000Z",
    output: "found 3 files",
  },
  {
    id: "shell-2",
    name: "pnpm test",
    kind: "job",
    status: "running",
    startedAt: "2026-10-29T10:00:00.000Z",
  },
];

const now = Date.parse("2026-10-29T10:00:30.000Z");

describe("task list rendering", () => {
  it("lists every task with its status and duration", () => {
    const lines = taskListLines(tasks, 0, 100, now);
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("Tasks · 2");
    expect(text).toContain("Enter View output");
    expect(text).toContain("explore the tui · Explore");
    expect(text).toContain("completed · 12s");
    expect(text).toContain("pnpm test · job");
    expect(lines.some((line) => line.selected === true)).toBe(true);
  });

  it("says so when there is nothing to list", () => {
    const lines = taskListLines([], 0, 80, now);
    expect(lines.map((line) => line.text).join("\n")).toContain("(no background tasks)");
  });

  it("shows the full result and the error in the details body", () => {
    const lines = taskDetailLines({ ...tasks[0]!, output: "line one\nline two", error: "partial failure" });
    expect(lines.join("\n")).toContain("agent-1 · subagent");
    expect(lines.join("\n")).toContain("error:");
    expect(lines.join("\n")).toContain("line two");
  });
});
