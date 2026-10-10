import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPrivateAddress,
  assertFetchableUrl,
  decodeHtmlEntities,
  dedupeHits,
  htmlToText,
  normalizeResultUrl,
  resolveSearchProvider,
} from "../src/tools/web-tools.js";
import { registerBuiltinTools, ToolRegistry } from "../src/tools.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** Spin up a local HTTP server and configure the workspace to allow loopback access (test-only). */
async function startFixtureServer(
  handler: (
    url: URL,
    request: IncomingMessage,
  ) => { status?: number; contentType: string; body: string; headers?: Record<string, string> },
  web: Record<string, unknown> = {},
): Promise<{ workspace: string; baseUrl: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const result = handler(url, request);
    response.writeHead(result.status ?? 200, { "content-type": result.contentType, ...(result.headers ?? {}) });
    response.end(result.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a port");

  const workspace = await mkdtemp(join(tmpdir(), "oran-web-"));
  await mkdir(join(workspace, ".oran"), { recursive: true });
  await writeFile(
    join(workspace, ".oran", "config.json"),
    JSON.stringify({ providers: {}, web: { enabled: true, allowPrivateHosts: true, ...web } }),
    "utf8",
  );
  return { workspace, baseUrl: `http://127.0.0.1:${address.port}` };
}

function registryFor(workspace: string): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, workspace);
  registry.activateAll();
  return registry;
}

describe("htmlToText", () => {
  it("keeps readable text and drops scripts, styles, and markup", () => {
    const html = `
      <html><head><title>ignored</title><style>.a{color:red}</style>
      <script>console.log("noise")</script></head>
      <body><h1>Title</h1><p>First &amp; second</p>
      <ul><li>one</li><li>two</li></ul>
      <!-- comment --><div>Trailing&nbsp;text</div></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Title");
    expect(text).toContain("First & second");
    expect(text).toContain("one");
    expect(text).toContain("Trailing text");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("<");
  });

  it("decodes named and numeric entities", () => {
    expect(decodeHtmlEntities("a &lt;b&gt; &#65; &#x42; &unknown;")).toBe("a <b> A B &unknown;");
  });
});

describe("web_fetch SSRF guard", () => {
  it("classifies loopback, private, and link-local addresses", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("example.com")).toBe(false);
  });

  it("expands IPv6 forms that carry an IPv4 address before judging them", () => {
    // The URL parser normalizes http://[::ffff:127.0.0.1]/ to ::ffff:7f00:1
    // before the hostname is ever read, so the hextet form has to be recognized
    // too — checking only the dotted prefix left this reachable without approval.
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::7f00:1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isPrivateAddress("2002:7f00:1::")).toBe(true);
    // Teredo stores the client address inverted, so this is 192.168.1.1.
    expect(isPrivateAddress("2001:0:4136:e378:8000:63bf:3f57:fefe")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses non-http schemes and private hosts by default", async () => {
    await expect(assertFetchableUrl("file:///etc/passwd")).rejects.toThrow("unsupported URL scheme");
    await expect(assertFetchableUrl("http://127.0.0.1:8080/admin")).rejects.toThrow("private/loopback");
    await expect(assertFetchableUrl("http://localhost:3000/")).rejects.toThrow("private/loopback");
  });
});

describe("web tools", () => {
  it("fetches a page and returns extracted text with a header", async () => {
    const { workspace, baseUrl } = await startFixtureServer(() => ({
      contentType: "text/html; charset=utf-8",
      body: "<html><body><h1>Docs</h1><p>Install with &lt;pnpm add x&gt;</p></body></html>",
    }));
    try {
      const result = await registryFor(workspace).invoke({
        name: "web_fetch",
        arguments: { url: `${baseUrl}/docs` },
        createdAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("<web-fetch url=");
      expect(result.output).toContain("Docs");
      expect(result.output).toContain("Install with <pnpm add x>");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("follows a redirect and reports the final URL", async () => {
    const { workspace, baseUrl } = await startFixtureServer((url) =>
      url.pathname === "/start"
        ? { status: 302, contentType: "text/plain", body: "", headers: { location: "/final" } }
        : { contentType: "text/plain", body: "final body" },
    );
    try {
      const result = await registryFor(workspace).invoke({
        name: "web_fetch",
        arguments: { url: `${baseUrl}/start` },
        createdAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(true);
      expect(result.output).toContain(`url="${baseUrl}/final"`);
      expect(result.output).toContain("final body");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports HTTP errors instead of returning partial content", async () => {
    const { workspace, baseUrl } = await startFixtureServer(() => ({
      status: 404,
      contentType: "text/html",
      body: "<html><body>nope</body></html>",
    }));
    try {
      const result = await registryFor(workspace).invoke({
        name: "web_fetch",
        arguments: { url: `${baseUrl}/missing` },
        createdAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(false);
      expect(result.summary).toBe("HTTP 404");
      expect(result.error).toContain("HTTP 404");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("returns an actionable error when web_search is not configured", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-web-"));
    try {
      const result = await registryFor(workspace).invoke({
        name: "web_search",
        arguments: { query: "oran code" },
        createdAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not configured");
      expect(result.error).toContain("web.searchApiKey");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  describe("search backends and de-duplication", () => {
    it("queries the brave backend with its subscription header and parses web.results", async () => {
      const seen: { url: URL; headers: IncomingMessage["headers"] }[] = [];
      const { workspace, baseUrl } = await startFixtureServer((url, request) => {
        seen.push({ url, headers: request.headers });
        return {
          contentType: "application/json",
          body: JSON.stringify({
            web: {
              results: [
                { title: "Oran docs", url: "https://example.test/docs", description: "Brave description" },
                { title: "No url field", description: "dropped" },
              ],
            },
          }),
        };
      });
      // The endpoint needs the fixture's port, so it can only be written to config after the server is up.
      await writeFile(
        join(workspace, ".oran", "config.json"),
        JSON.stringify({
          providers: {},
          web: {
            enabled: true,
            searchProvider: "brave",
            searchApiKey: "brave-key",
            searchEndpoint: `${baseUrl}/search`,
          },
        }),
        "utf8",
      );
      try {
        const result = await registryFor(workspace).invoke({
          name: "web_search",
          arguments: { query: "oran code" },
          createdAt: new Date().toISOString(),
        });
        expect(result.ok).toBe(true);
        expect(result.output).toContain('provider="brave"');
        expect(result.output).toContain("Oran docs");
        expect(result.output).toContain("Brave description");
        expect(seen[0]?.headers["x-subscription-token"]).toBe("brave-key");
        expect(seen[0]?.url.searchParams.get("q")).toBe("oran code");
        expect(seen[0]?.url.searchParams.get("count")).toBe("5");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }, 30_000);

    it("queries the google backend with key and cx and parses items", async () => {
      const seen: { url: URL; headers: IncomingMessage["headers"] }[] = [];
      const { workspace, baseUrl } = await startFixtureServer((url, request) => {
        seen.push({ url, headers: request.headers });
        return {
          contentType: "application/json",
          body: JSON.stringify({
            items: [{ title: "Result", link: "https://example.test/a", snippet: "Google snippet" }],
          }),
        };
      });
      await writeFile(
        join(workspace, ".oran", "config.json"),
        JSON.stringify({
          providers: {},
          web: {
            enabled: true,
            searchProvider: "google",
            searchApiKey: "google-key",
            searchEngineId: "cx-123",
            searchEndpoint: `${baseUrl}/customsearch`,
          },
        }),
        "utf8",
      );
      try {
        const result = await registryFor(workspace).invoke({
          name: "web_search",
          arguments: { query: "agent harness", limit: 3 },
          createdAt: new Date().toISOString(),
        });
        expect(result.ok).toBe(true);
        expect(result.output).toContain('provider="google"');
        expect(result.output).toContain("Google snippet");
        expect(seen[0]?.url.searchParams.get("key")).toBe("google-key");
        expect(seen[0]?.url.searchParams.get("cx")).toBe("cx-123");
        expect(seen[0]?.url.searchParams.get("num")).toBe("3");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }, 30_000);

    it("merges duplicate results that differ only in tracking parameters or URL form", async () => {
      const { workspace, baseUrl } = await startFixtureServer(() => ({
        contentType: "application/json",
        body: JSON.stringify({
          results: [
            { title: "Docs", url: "https://example.test/docs?utm_source=x", content: "short" },
            { title: "Docs (again)", url: "https://www.example.test/docs/", content: "a much longer snippet" },
            { title: "Other", url: "https://example.test/other", content: "unrelated" },
          ],
        }),
      }));
      await writeFile(
        join(workspace, ".oran", "config.json"),
        JSON.stringify({ providers: {}, web: { enabled: true, searchEndpoint: `${baseUrl}/search` } }),
        "utf8",
      );
      try {
        const result = await registryFor(workspace).invoke({
          name: "web_search",
          arguments: { query: "docs" },
          createdAt: new Date().toISOString(),
        });
        expect(result.ok).toBe(true);
        expect(result.output).toContain('results="2"');
        expect(result.output).toContain('deduped="1"');
        // After merging, the longer snippet is kept and only the first-seen position is retained.
        expect(result.output).toContain("a much longer snippet");
        expect(result.output).not.toContain("short\n");
        expect(result.summary).toContain("1 duplicate merged");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }, 30_000);

    it("reports missing credentials per backend", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "oran-web-"));
      try {
        await mkdir(join(workspace, ".oran"), { recursive: true });
        await writeFile(
          join(workspace, ".oran", "config.json"),
          JSON.stringify({ providers: {}, web: { searchProvider: "brave" } }),
          "utf8",
        );
        const brave = await registryFor(workspace).invoke({
          name: "web_search",
          arguments: { query: "x" },
          createdAt: new Date().toISOString(),
        });
        expect(brave.ok).toBe(false);
        expect(brave.error).toContain("web.searchApiKey (brave)");

        await writeFile(
          join(workspace, ".oran", "config.json"),
          JSON.stringify({ providers: {}, web: { searchProvider: "google", searchApiKey: "k" } }),
          "utf8",
        );
        const google = await registryFor(workspace).invoke({
          name: "web_search",
          arguments: { query: "x" },
          createdAt: new Date().toISOString(),
        });
        expect(google.ok).toBe(false);
        expect(google.error).toContain("web.searchEngineId (cx)");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe("result URL normalisation", () => {
    it("strips tracking parameters, www prefix, trailing slashes, and the fragment", () => {
      expect(normalizeResultUrl("https://www.Example.test/docs/?utm_source=x&page=2#top")).toBe(
        "example.test/docs?page=2",
      );
      expect(normalizeResultUrl("https://example.test/docs?utm_source=x&utm_medium=y")).toBe("example.test/docs");
      expect(normalizeResultUrl("not a url")).toBe("not a url");
    });

    it("keeps first-seen order and title while merging snippets", () => {
      const { hits, duplicates } = dedupeHits([
        { title: "first", url: "https://a.test/x", snippet: "short" },
        { title: "second", url: "https://a.test/x?gclid=1", snippet: "longer snippet wins" },
        { title: "third", url: "https://b.test/y", snippet: "other" },
      ]);
      expect(duplicates).toBe(1);
      expect(hits.map((hit) => hit.title)).toEqual(["first", "third"]);
      expect(hits[0]?.snippet).toBe("longer snippet wins");
    });

    it("infers the provider from the configured endpoint", () => {
      expect(resolveSearchProvider({})).toBe("tavily");
      expect(resolveSearchProvider({ searchEndpoint: "http://localhost:8080/search" })).toBe("searxng");
      expect(resolveSearchProvider({ searchProvider: "brave" })).toBe("brave");
      expect(resolveSearchProvider({ searchProvider: "google" })).toBe("google");
    });
  });

  it("hides web_search behind search_tools activation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oran-web-"));
    try {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, workspace);
      expect(registry.isExposed("web_fetch")).toBe(true);
      expect(registry.isExposed("web_search")).toBe(false);
      const search = await registry.invoke({
        name: "search_tools",
        arguments: { query: "select:web_search" },
        createdAt: new Date().toISOString(),
      });
      expect(search.ok).toBe(true);
      expect(registry.isExposed("web_search")).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
