import type { ToolDefinition } from "../types.js";
import type { ToolFactoryContext } from "./registry.js";
import { failedResult } from "./fs-helpers.js";

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string | undefined;
}

export interface QuestionItem {
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean | undefined;
}

export function registerInteractionTools(
  registry: { register(tool: ToolDefinition): void },
  _ctx: ToolFactoryContext,
): void {
  registry.register({
    name: "ask_user_question",
    description:
      "Ask the user 1-4 structured multiple-choice questions when you are blocked on a decision that requires user input (architecture choices, library selections, destructive actions, or unclear requirements). Do NOT use this to ask if your plan is okay.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "1-4 questions to present to the user.",
          items: {
            type: "object",
            properties: {
              header: {
                type: "string",
                description: "Very short category label displayed as a tag (e.g., 'Approach', 'Library').",
              },
              question: { type: "string", description: "The complete question ending with a question mark." },
              multiSelect: {
                type: "boolean",
                description: "Set to true to allow multiple selections.",
                default: false,
              },
              options: {
                type: "array",
                description: "2-4 available choices. Place the recommended option first with '(Recommended)'.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Concise display text (1-5 words)." },
                    description: { type: "string", description: "Explanation of trade-offs or implications." },
                    preview: { type: "string", description: "Optional code snippet or mockup preview." },
                  },
                  required: ["label", "description"],
                },
              },
            },
            required: ["header", "question", "options"],
          },
        },
      },
      required: ["questions"],
    },
    permissionLevel: 0,
    kind: "command",
    maxOutputChars: 16_000,
    invoke: async (call, context) => {
      try {
        const rawQuestions = call.arguments.questions;
        if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
          return { ok: false, output: "", error: "questions must be a non-empty array", summary: "invalid arguments" };
        }

        const questions: QuestionItem[] = rawQuestions.map((q: Record<string, unknown>) => ({
          header: String(q.header ?? "Choice"),
          question: String(q.question ?? ""),
          multiSelect: q.multiSelect === true,
          options: Array.isArray(q.options)
            ? (q.options as Array<Record<string, unknown>>).map((opt) => ({
                label: String(opt.label ?? ""),
                description: String(opt.description ?? ""),
                preview: typeof opt.preview === "string" ? opt.preview : undefined,
              }))
            : [],
        }));

        if (context?.askUser) {
          const answers = await context.askUser(questions);
          return {
            ok: true,
            output: JSON.stringify(answers, null, 2),
            summary: `answered ${Object.keys(answers).length} questions`,
          };
        }

        // Non-interactive fallback: auto-select the first (recommended) option for each question
        const fallbackAnswers: Record<string, string> = {};
        for (const q of questions) {
          const defaultChoice = q.options[0]?.label ?? "Yes";
          fallbackAnswers[q.question] = `${defaultChoice} (auto-selected default)`;
        }

        return {
          ok: true,
          output: JSON.stringify(fallbackAnswers, null, 2),
          summary: "auto-selected defaults (non-interactive)",
        };
      } catch (error) {
        return failedResult(error, "ask_user_question failed");
      }
    },
  });
}
