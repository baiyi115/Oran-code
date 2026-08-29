import type { TaskPlanStep, ToolDefinition } from "../types.js";

export function registerPlanTools(registry: { register(tool: ToolDefinition): void }): void {
  registry.register({
    name: "update_plan",
    description:
      "Update the structured task plan state machine. Use this tool to organize goals into discrete steps, track status ('pending' | 'in_progress' | 'completed' | 'skipped'), and ensure uninterrupted progress across session resumes and compaction.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The overarching goal of the task." },
        steps: {
          type: "array",
          description: "Ordered list of steps to accomplish the goal.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique step ID, e.g. 'step-1'." },
              title: { type: "string", description: "Concise title of the step." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "skipped"],
                description: "Execution status of the step.",
              },
              description: { type: "string", description: "Optional detailed explanation of this step." },
            },
            required: ["id", "title", "status"],
          },
        },
        currentStepIndex: {
          type: "number",
          description: "0-based index of the currently active or next pending step.",
        },
      },
      required: ["goal", "steps"],
    },
    permissionLevel: 0,
    system: true,
    kind: "readonly",
    maxOutputChars: 16_000,
    invoke: async (call) => {
      const goal = typeof call.arguments.goal === "string" ? call.arguments.goal.trim() : "";
      const rawSteps = Array.isArray(call.arguments.steps) ? call.arguments.steps : [];
      const steps: TaskPlanStep[] = rawSteps.map((s, idx) => {
        const item = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
        const rawStatus = typeof item.status === "string" ? item.status : "pending";
        const status =
          rawStatus === "in_progress" || rawStatus === "completed" || rawStatus === "skipped" ? rawStatus : "pending";
        return {
          id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `step-${idx + 1}`,
          title: typeof item.title === "string" ? item.title.trim() : `Step ${idx + 1}`,
          status,
          ...(typeof item.description === "string" && item.description.trim()
            ? { description: item.description.trim() }
            : {}),
        };
      });
      const currentStepIndex =
        typeof call.arguments.currentStepIndex === "number" && Number.isFinite(call.arguments.currentStepIndex)
          ? Math.max(0, Math.min(call.arguments.currentStepIndex, Math.max(0, steps.length - 1)))
          : Math.max(
              0,
              steps.findIndex((s) => s.status === "in_progress" || s.status === "pending"),
            );

      const completedCount = steps.filter((s) => s.status === "completed").length;
      return {
        ok: true,
        output: JSON.stringify({ goal, steps, currentStepIndex }, null, 2),
        summary: `Task plan updated: ${completedCount}/${steps.length} steps completed`,
      };
    },
  });
}
