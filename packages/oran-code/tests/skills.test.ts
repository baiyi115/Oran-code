import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../src/commands.js";
import {
  assertSkillTools,
  registerSkillCommands,
  renderSkillPrompt,
  SkillLoader,
  type SkillDefinition,
} from "../src/skills.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SkillLoader", () => {
  it("uses ~/.agents/skills as the canonical user Skill directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "liteagent-skills-default-"));
    temporaryDirectories.push(workspace);
    const loader = new SkillLoader(workspace, {
      builtin: join(workspace, "builtin"),
      project: join(workspace, "project"),
      legacyUser: false,
    });

    expect(loader.directories.user).toBe(resolve(homedir(), ".agents", "skills"));
  });

  it("scans the legacy user directory before the canonical user directory", async () => {
    const fixture = await createFixture();
    await writeSkill(join(fixture.legacyUser, "shared.md"), skillDocument("shared", "legacy"));
    await writeSkill(join(fixture.user, "shared.md"), skillDocument("shared", "canonical"));

    expect((await fixture.loader().scan())[0]).toMatchObject({
      name: "shared",
      description: "canonical",
      scope: "user",
    });
  });

  it("loads strict file and directory skills with project-over-user-over-builtin precedence", async () => {
    const fixture = await createFixture();
    await writeSkill(join(fixture.builtin, "shared.md"), skillDocument("shared", "builtin"));
    await writeSkill(join(fixture.user, "shared.md"), skillDocument("shared", "user"));
    await writeSkill(
      join(fixture.project, "shared", "SKILL.md"),
      skillDocument("shared", "project", {
        allowedTools: ["read_file", "shell_command"],
        mode: "derived",
        context: "long",
        model: "openai/example",
      }),
    );
    await writeSkill(join(fixture.project, "invalid.md"), "# Missing frontmatter");
    await writeSkill(join(fixture.project, "nested", "ignored", "SKILL.md"), skillDocument("ignored", "ignored"));

    const loader = fixture.loader();
    const loaded = await loader.scan();

    expect(loaded.map((skill) => skill.name)).toEqual(["shared"]);
    expect(loaded[0]).toMatchObject({
      description: "project",
      scope: "project",
      allowedTools: ["read_file", "shell_command"],
      mode: "derived",
      context: "long",
      model: "openai/example",
    });
    expect(loaded[0]?.rootDirectory).toBe(resolve(fixture.project, "shared"));
  });

  it("hot reloads on any mtime change and preserves the cached definition after a bad edit", async () => {
    const fixture = await createFixture();
    const path = join(fixture.project, "hot.md");
    await writeSkill(path, skillDocument("hot", "before"));
    const loader = fixture.loader();
    await loader.scan();
    const initial = await loader.get("hot");

    await writeFile(path, skillDocument("hot", "after"), "utf8");
    const changedTime = new Date((initial?.mtimeMs ?? Date.now()) + 2_000);
    await utimes(path, changedTime, changedTime);
    expect((await loader.get("hot"))?.description).toBe("after");

    await writeFile(path, "---\nname: [broken\n---\nbad", "utf8");
    const badTime = new Date(changedTime.getTime() + 2_000);
    await utimes(path, badTime, badTime);
    expect((await loader.get("hot"))?.description).toBe("after");
  });

  it("installs a local file into the project package layout and makes it immediately available", async () => {
    const fixture = await createFixture();
    const source = join(fixture.root, "source.md");
    await writeSkill(source, skillDocument("installed", "from local"));
    const loader = fixture.loader();

    const installed = await loader.install(source);

    expect(installed).toMatchObject({ name: "installed", scope: "project" });
    const destination = join(fixture.project, "installed", "SKILL.md");
    expect(installed.filePath).toBe(resolve(destination));
    expect(await readFile(destination, "utf8")).toContain("name: installed");
    expect((await loader.get("installed"))?.description).toBe("from local");
  });

  it("installs an HTTP definition and rejects unsafe names before writing", async () => {
    const fixture = await createFixture();
    const loader = fixture.loader();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(skillDocument("remote", "from HTTP"))),
    );

    expect((await loader.install("https://example.test/SKILL.md")).name).toBe("remote");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("---\nname: ../escape\n---\nBad")),
    );
    await expect(loader.install("https://example.test/bad.md")).rejects.toThrow("invalid skill definition");
  });

  it("uses an explicit install name or the source filename when frontmatter omits a name", async () => {
    const fixture = await createFixture();
    const source = join(fixture.root, "fallback-name.md");
    await writeSkill(source, "---\ndescription: fallback\n---\nRun the fallback procedure");
    const loader = fixture.loader();

    expect((await loader.install(source)).name).toBe("fallback-name");
    expect((await loader.install(source, "renamed-skill")).name).toBe("renamed-skill");
    expect(await readFile(join(fixture.project, "renamed-skill", "SKILL.md"), "utf8")).toContain("name: renamed-skill");
  });
});

describe("skill execution adapters", () => {
  it("renders arguments and fails fast when required tools are absent", () => {
    const withPlaceholder = definition({ body: "Review $ARGUMENTS now" });
    expect(renderSkillPrompt(withPlaceholder, "src/index.ts")).toBe("Review src/index.ts now");
    expect(renderSkillPrompt(definition({ body: "Review carefully" }), "src/index.ts")).toBe(
      "Review carefully\n\n## User request\n\nsrc/index.ts",
    );

    expect(() => assertSkillTools(definition({ allowedTools: ["read_file", "shell_command"] }), ["read_file"])).toThrow(
      "shell_command",
    );
    expect(() => assertSkillTools(definition({ allowedTools: [] }), [])).not.toThrow();
  });

  it("registers inline and derived commands with markers while preserving conflicts", async () => {
    const fixture = await createFixture();
    await writeSkill(join(fixture.project, "new.md"), skillDocument("new-skill", "inline skill"));
    await writeSkill(
      join(fixture.project, "review.md"),
      skillDocument("review-skill", "derived skill", {
        mode: "derived",
        context: "recent",
      }),
    );
    await writeSkill(join(fixture.project, "clear.md"), skillDocument("clear", "must not replace built-in"));
    const registry = new CommandRegistry();

    const registered = await registerSkillCommands(registry, fixture.loader());

    expect(registered.map((command) => command.name)).toEqual(["/new-skill", "/review-skill"]);
    expect(registry.get("/new-skill")).toMatchObject({ kind: "prompt", description: "inline skill [skill]" });
    expect(registry.get("/review-skill")).toMatchObject({
      kind: "isolated-skill",
      description: "derived skill [skill]",
    });
    expect(registry.get("/clear")?.description).not.toContain("[skill]");
    expect(await registry.get("/new-skill")?.handler?.("details")).toContain("details");
  });
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly builtin: string;
  readonly legacyUser: string;
  readonly user: string;
  readonly project: string;
  loader(): SkillLoader;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "liteagent-skills-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const builtin = join(root, "builtin");
  const legacyUser = join(root, "legacy-user");
  const user = join(root, "user");
  const project = join(workspace, ".oran", "skills");
  await Promise.all([workspace, builtin, legacyUser, user, project].map((path) => mkdir(path, { recursive: true })));
  return {
    root,
    workspace,
    builtin,
    legacyUser,
    user,
    project,
    loader: () => new SkillLoader(workspace, { builtin, legacyUser, user, project }),
  };
}

async function writeSkill(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

function skillDocument(
  name: string,
  description: string,
  options: {
    readonly allowedTools?: readonly string[];
    readonly mode?: "inline" | "derived";
    readonly context?: "none" | "recent" | "long";
    readonly model?: string;
  } = {},
): string {
  const tools = options.allowedTools?.map((tool) => `  - ${tool}`).join("\n");
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...(tools ? ["allowedTools:", tools] : []),
    `mode: ${options.mode ?? "inline"}`,
    `context: ${options.context ?? "none"}`,
    ...(options.model ? [`model: ${options.model}`] : []),
    "---",
    "Perform the procedure for $ARGUMENTS",
  ].join("\n");
}

function definition(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "sample",
    description: "sample",
    allowedTools: [],
    mode: "inline",
    context: "none",
    body: "Do $ARGUMENTS",
    filePath: "SKILL.md",
    rootDirectory: ".",
    scope: "project",
    mtimeMs: 0,
    ...overrides,
  };
}
