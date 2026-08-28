import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFile } from "../src/config.js";
import { createRuntimeConfig, DEFAULT_NO_PROGRESS_LIMIT } from "../src/runtime.js";
import type { ModelConfig, UserConfig } from "../src/types.js";

const model: ModelConfig = {
  provider: "test",
  model: "test-model",
  temperature: 0.2,
  maxTokens: 1000,
};

const temporaryDirectories: string[] = [];

function runtimeConfig(agent: UserConfig["agent"] = {}) {
  return createRuntimeConfig("C:/workspace/oran-code", model, { providers: {}, agent });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createRuntimeConfig noProgressLimit", () => {
  it("defaults to 8", () => {
    expect(DEFAULT_NO_PROGRESS_LIMIT).toBe(8);
    expect(runtimeConfig().loop.noProgressLimit).toBe(8);
  });

  it("allows zero to disable no-progress detection", () => {
    expect(runtimeConfig({ noProgressLimit: 0 }).loop.noProgressLimit).toBe(0);
  });

  it("floors fractional limits", () => {
    expect(runtimeConfig({ noProgressLimit: 5.9 }).loop.noProgressLimit).toBe(5);
  });

  it.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("rejects %s limits", (_label, value) => {
    expect(() => runtimeConfig({ noProgressLimit: value })).toThrow(
      "agent.noProgressLimit must be a finite non-negative number",
    );
  });

  it("normalizes agent.no_progress_limit loaded from a config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oran-runtime-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ providers: {}, agent: { no_progress_limit: 6.8 } }), "utf8");

    const config = await loadConfigFile(path);

    expect(config.agent?.noProgressLimit).toBe(6.8);
    expect(createRuntimeConfig(directory, model, config).loop.noProgressLimit).toBe(6);
  });
});
