import { describe, expect, it } from "vitest";
import {
  commandHelp,
  completeInput,
  formatModelReference,
  modelCandidates,
  parseSlashCommand,
} from "../src/commands.js";

const providers = {
  deepseek: { models: { "deepseek-chat": {}, "deepseek-reasoner": {} } },
  openai: { models: { "gpt-4.1-mini": {} } },
};

describe("terminal commands", () => {
  it("parses slash commands and arguments", () => {
    expect(parseSlashCommand("  /MODEL deepseek/deepseek-chat ")).toEqual({
      name: "/model",
      argument: "deepseek/deepseek-chat",
    });
    expect(parseSlashCommand("hello")).toBeUndefined();
  });

  it("completes commands and model references", () => {
    const models = modelCandidates(providers);
    expect(completeInput("/mo", models)[0]).toEqual(["/model"]);
    expect(completeInput("/model deepseek/", models)[0]).toEqual([
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
    ]);
    expect(completeInput("hello", models)).toEqual([[], "hello"]);
  });

  it("keeps provider/model formatting and the command list deterministic", () => {
    expect(formatModelReference({ provider: "openai", model: "gpt-4.1-mini" })).toBe("openai/gpt-4.1-mini");
    const help = commandHelp();
    for (const command of ["/new", "/model", "/session", "/clear", "/rename", "/help", "/exit", "/skills"]) {
      expect(help).toContain(command);
    }
    for (const command of ["/reload", "/workspace", "/settings", "/cancel", "/thinking"]) {
      expect(help.split("\n").some((line) => line.trimStart().startsWith(`${command} `))).toBe(false);
      expect(completeInput(command, [])[0]).toEqual([]);
    }
    expect(completeInput("/quit", [])[0]).toEqual(["/exit"]);
    expect(help).not.toContain("/review");
    expect(help.split("\n").some((line) => line.trimStart().startsWith("/mode "))).toBe(false);
    expect(completeInput("/model", [])[0]).toEqual(["/model"]);
  });
});
