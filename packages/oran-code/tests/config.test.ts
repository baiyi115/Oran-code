import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ensureUserConfig, loadConfigFile, resolveModelConfig, saveConfig, userConfigPath, userHistoryPath } from "../src/config.js";
import type { UserConfig } from "../src/types.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("user config paths", () => {
  it("uses a hidden directory in the user's home directory", () => {
    expect(userConfigPath()).toBe(resolve(homedir(), ".oran", "config.json"));
    expect(userHistoryPath()).toBe(resolve(homedir(), ".oran", "history"));
  });

  it("exposes an async initializer for first-run migration", () => {
    expect(ensureUserConfig).toBeTypeOf("function");
  });
});

describe("resolveModelConfig", () => {
  it("resolves multiple models under one provider", () => {
    const config: UserConfig = {
      providers: {
        deepseek: {
          options: { baseUrl: "https://api.deepseek.com/v1", apiKey: "test-key", permission: "allow" },
          models: {
            chat: { name: "chat", options: { maxTokens: 2048 } },
            reasoner: { name: "reasoner", options: { temperature: 0.1, reasoningEffort: "high" } },
          },
        },
      },
    };
    expect(() => resolveModelConfig(config, undefined)).toThrow("no model selected");
    expect(resolveModelConfig(config, "deepseek/chat")).toMatchObject({ provider: "deepseek", model: "chat", maxTokens: 2048, baseUrl: "https://api.deepseek.com/v1" });
    expect(resolveModelConfig(config, "deepseek/reasoner")).toMatchObject({ provider: "deepseek", model: "reasoner", temperature: 0.1, reasoningEffort: "high" });
  });

  it("reads OpenCode-shaped JSON and writes the same public shape without defaults", async () => {
    const directory = await mkdtemp(`${tmpdir()}\\liteagent-config-`);
    const path = `${directory}\\config.json`;
    try {
      await writeFile(path, JSON.stringify({
        providers: {
          Yanami: {
            npm: "@ai-sdk/openai-compatible",
            name: "Yanami",
            options: { baseURL: "https://yanami.example/v1", apiKey: "secret", permission: "allow" },
            models: { "grok-4.5": { name: "grok-4.5", options: { reasoningEffort: "high" } } },
          },
        },
        agent: { maxSteps: 20 },
      }), "utf8");
      const config = await loadConfigFile(path);
      expect(resolveModelConfig(config, "Yanami/grok-4.5")).toMatchObject({
        baseUrl: "https://yanami.example/v1",
        apiKey: "secret",
        reasoningEffort: "high",
      });
      await saveConfig(config, path);
      const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      expect(saved).not.toHaveProperty("defaultModel");
      expect(saved).not.toHaveProperty("default_model");
      expect(saved).toMatchObject({ providers: { Yanami: { options: { baseURL: "https://yanami.example/v1" } } } });
      const savedProvider = (saved.providers as Record<string, any>).Yanami;
      expect(savedProvider.models["grok-4.5"].options).toEqual({ reasoningEffort: "high" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
