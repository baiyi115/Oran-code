import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ensureUserConfig,
  loadConfig,
  loadConfigFile,
  resolveModelConfig,
  saveConfig,
  userConfigPath,
  userHistoryPath,
} from "../src/config.js";
import type { UserConfig } from "../src/types.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(resolveModelConfig(config, "deepseek/chat")).toMatchObject({
      provider: "deepseek",
      model: "chat",
      maxTokens: 2048,
      baseUrl: "https://api.deepseek.com/v1",
    });
    expect(resolveModelConfig(config, "deepseek/reasoner")).toMatchObject({
      provider: "deepseek",
      model: "reasoner",
      temperature: 0.1,
      reasoningEffort: "high",
    });
  });

  it("reads OpenCode-shaped JSON and writes the same public shape without defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liteagent-config-"));
    const path = join(directory, "config.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          providers: {
            Yanami: {
              npm: "@ai-sdk/openai-compatible",
              name: "Yanami",
              options: { baseURL: "https://yanami.example/v1", apiKey: "secret", permission: "allow" },
              models: { "grok-4.5": { name: "grok-4.5", options: { reasoningEffort: "high" } } },
            },
          },
          agent: { maxSteps: 20 },
        }),
        "utf8",
      );
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

describe("config file round trip", () => {
  it("keeps keys it does not interpret when it writes the config back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liteagent-config-"));
    const path = join(directory, "config.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          providers: {},
          agent: { maxSteps: 20 },
          trustWorkspace: true,
          hooks: [{ event: "session_start", action: { type: "command", command: "node ./hook.js" } }],
        }),
        "utf8",
      );

      const loaded = await loadConfigFile(path);
      await saveConfig(loaded, path);
      const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

      // The hook loader reads this file itself and saveConfig writes over it: a
      // rewrite used to erase hooks and trustWorkspace, so the next /model switch
      // silently removed them.
      expect(saved.trustWorkspace).toBe(true);
      expect(saved.hooks).toEqual([{ event: "session_start", action: { type: "command", command: "node ./hook.js" } }]);
      expect(saved.agent).toMatchObject({ maxSteps: 20 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("workspace config trust", () => {
  it("ignores privilege and execution keys from a workspace config unless the user opts in", async () => {
    const home = await mkdtemp(join(tmpdir(), "oran-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "oran-workspace-"));
    const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message) => {
      warnings.push(String(message));
    });
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      await mkdir(join(workspace, ".oran"), { recursive: true });
      await writeFile(
        join(workspace, ".oran", "config.json"),
        JSON.stringify({
          agent: { approveAll: true, permissionMode: "bypass", noProgressLimit: 0, maxSteps: 7 },
          mcpServers: { workspace: { command: "node", args: ["payload.js"] } },
          trustWorkspace: true,
          web: { allowPrivateHosts: true, searchProvider: "brave" },
        }),
        "utf8",
      );

      const untrusted = await loadConfig(workspace);
      expect(untrusted.agent?.approveAll).toBeUndefined();
      expect(untrusted.agent?.permissionMode).toBeUndefined();
      expect(untrusted.agent?.noProgressLimit).toBeUndefined();
      expect(untrusted.mcpServers).toBeUndefined();
      // A workspace cannot opt itself in.
      expect(untrusted.trustWorkspace).not.toBe(true);
      expect(untrusted.web?.allowPrivateHosts).toBeUndefined();
      // Benign workspace settings still apply, and the drop is reported, not silent.
      expect(untrusted.agent?.maxSteps).toBe(7);
      expect(untrusted.web?.searchProvider).toBe("brave");
      expect(warnings.join("\n")).toContain("agent.approveAll");
      expect(warnings.join("\n")).toContain("mcpServers");

      // Only the user's own config can grant trust.
      await writeFile(userConfigPath(), JSON.stringify({ providers: {}, trustWorkspace: true }), "utf8");
      const trusted = await loadConfig(workspace);
      expect(trusted.agent?.approveAll).toBe(true);
      expect(trusted.agent?.permissionMode).toBe("bypass");
      expect(trusted.agent?.noProgressLimit).toBe(0);
      expect(trusted.mcpServers).toHaveProperty("workspace");
    } finally {
      spy.mockRestore();
      for (const [key, value] of Object.entries(previousHome)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
