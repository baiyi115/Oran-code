import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import type { ToolDefinition, WebSettings } from "../types.js";
import { loadConfig } from "../config.js";
import type { ToolFactoryContext } from "./registry.js";
import { formatPreservingTail } from "./process.js";

export const DEFAULT_FETCH_MAX_CHARS = 32_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2_000_000;

/** 内网/回环地址判定:web_fetch 默认拒绝,避免把工作区数据打到元数据服务或本机管理端口。 */
const PRIVATE_IPV4_PATTERNS = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * IPv6 字面量展开成 8 段 hextet。
 * 不能按字符串前缀判定 ::ffff: ——URL 解析器会把 `[::ffff:127.0.0.1]` 归一化成
 * `[::ffff:7f00:1]`,前缀匹配在这里拿不到点分形式;而且 6to4 / NAT64 / Teredo
 * 同样能把请求引回内网。展开后统一判定才不留缺口。
 */
function parseIpv6Hextets(address: string): number[] | undefined {
  const zone = address.indexOf("%");
  const text = (zone >= 0 ? address.slice(0, zone) : address).toLowerCase();
  const sections = text.split("::");
  if (sections.length > 2) return undefined;
  const head = parseIpv6Groups(sections[0] ?? "");
  if (!head) return undefined;
  if (sections.length === 1) return head.length === 8 ? head : undefined;
  const tail = parseIpv6Groups(sections[1] ?? "");
  if (!tail) return undefined;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return undefined;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

function parseIpv6Groups(section: string): number[] | undefined {
  if (section === "") return [];
  const groups = section.split(":");
  const values: number[] = [];
  for (const [index, group] of groups.entries()) {
    if (group.includes(".")) {
      // 点分尾巴只允许出现在最后一组(`::ffff:127.0.0.1`)。
      if (index !== groups.length - 1) return undefined;
      const hextets = ipv4ToHextets(group);
      if (!hextets) return undefined;
      values.push(...hextets);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    values.push(Number.parseInt(group, 16));
  }
  return values;
}

function ipv4ToHextets(value: string): number[] | undefined {
  if (!isIPv4(value)) return undefined;
  const [a, b, c, d] = value.split(".").map((part) => Number.parseInt(part, 10));
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return [(a << 8) | b, (c << 8) | d];
}

/** 内嵌在这些 IPv6 编码里的 IPv4,取不出来就说明这个地址没有 IPv4 语义。 */
function embeddedIpv4(hextets: readonly number[]): string | undefined {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = hextets;
  const format = (hi: number, lo: number): string =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  const leadingZeros = (count: number): boolean => hextets.slice(0, count).every((value) => value === 0);
  // ::a.b.c.d(IPv4-compatible)与 ::ffff:a.b.c.d(IPv4-mapped),RFC 4291。
  if (leadingZeros(5) && (f === 0 || f === 0xffff)) return format(g, h);
  // 64:ff9b::/96:NAT64 知名前缀。
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return format(g, h);
  // 2002::/16:6to4,IPv4 在随后的 32 位。
  if (a === 0x2002) return format(b, c);
  // 2001:0000::/32:Teredo,末 32 位是取反后的客户端 IPv4。
  if (a === 0x2001 && b === 0) return format(~g & 0xffff, ~h & 0xffff);
  return undefined;
}

export function isPrivateAddress(address: string): boolean {
  if (isIPv4(address)) return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(address));
  if (!isIPv6(address)) return false;
  const hextets = parseIpv6Hextets(address);
  // 自称 IPv6 却展开不了:宁可拒绝,不做放过。
  if (!hextets) return true;
  const first = hextets[0] ?? 0;
  if (hextets.every((value) => value === 0)) return true; // ::
  if (hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1) return true; // ::1
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  const embedded = embeddedIpv4(hextets);
  return embedded !== undefined && isPrivateAddress(embedded);
}

/**
 * 校验 URL 只指向公网 http(s) 地址。
 * 逐条检查 DNS 解析结果(包括字面量 IP),任何一条落在内网即拒绝。
 */
export async function assertFetchableUrl(rawUrl: string, options: { allowPrivateHosts?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme: ${url.protocol.replace(":", "")}; only http and https are allowed`);
  }
  if (options.allowPrivateHosts) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateAddress(host)) throw new Error(`refusing to fetch a private/loopback address: ${host}`);
  let addresses: string[];
  try {
    addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
  } catch (error) {
    throw new Error(`cannot resolve host ${host}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (addresses.some((address) => isPrivateAddress(address))) {
    throw new Error(`refusing to fetch ${host}: it resolves to a private/loopback address`);
  }
  return url;
}

const BLOCK_TAGS =
  /<\/?(?:p|div|section|article|header|footer|main|aside|nav|br|hr|li|ul|ol|tr|table|thead|tbody|h[1-6]|pre|blockquote|figure|figcaption|form|details|summary)\b[^>]*>/gi;

/**
 * 隐藏块的开/闭标签。两侧都用不含 `<`/`>` 的字符类,单次匹配不会跨标签,
 * 因此整个扫描是线性的(见 stripHiddenBlocks 的注释)。
 */
const HIDDEN_TAG =
  /<(script|style|noscript|template|svg|canvas|head)\b[^<>]*>|<\/(script|style|noscript|template|svg|canvas|head)\s*>/gi;

/** 剥离 HTML 注释;未闭合的注释按规范延伸到串尾。 */
function stripHtmlComments(html: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = html.indexOf("<!--", cursor);
    if (start < 0) return out + html.slice(cursor);
    out += `${html.slice(cursor, start)} `;
    const end = html.indexOf("-->", start + 4);
    if (end < 0) return out;
    cursor = end + 3;
  }
}

/**
 * 剥离 script/style/noscript/template/svg/canvas/head 整块。
 *
 * 旧实现写的是 `<(tag)\b[^>]*>[\s\S]*?</\1>`,惰性量词遇到大量无闭合标签的
 * 页面会把每个起点都扫到串尾:实测 400KB 的 `<script>` 重复要 2.4 秒,而抓取
 * 上限是 2MB(>1 分钟),且清洗同步跑在事件循环上,会连带冻住 TUI。这里改成
 * 单遍线性扫描:一次正则走完,同名的嵌套按深度计数,未闭合的块按 HTML 规范
 * 丢弃到串尾。
 */
function stripHiddenBlocks(html: string): string {
  let out = "";
  let cursor = 0;
  let open: string | undefined;
  let depth = 0;
  HIDDEN_TAG.lastIndex = 0;
  for (let match = HIDDEN_TAG.exec(html); match; match = HIDDEN_TAG.exec(html)) {
    const name = (match[1] ?? match[2] ?? "").toLowerCase();
    if (match[1] === undefined) {
      if (open === undefined || name !== open) continue;
      depth -= 1;
      if (depth === 0) {
        open = undefined;
        cursor = match.index + match[0].length;
      }
      continue;
    }
    if (open === undefined) {
      out += `${html.slice(cursor, match.index)} `;
      cursor = match.index + match[0].length;
      open = name;
      depth = 1;
      continue;
    }
    if (name === open) depth += 1;
  }
  return out + html.slice(cursor);
}

/**
 * 零依赖 HTML → 文本抽取。
 * 目标是让模型读到正文而不是标签:剥离脚本/样式/注释,块级标签转换为换行,
 * 解码实体,压缩空白。刻意不追求 renderer 级还原(readability 一类库会引入依赖)。
 */
export function htmlToText(html: string): string {
  const withoutHidden = stripHiddenBlocks(stripHtmlComments(html));
  const withBreaks = withoutHidden.replace(BLOCK_TAGS, "\n").replace(/<[^>]*>/g, " ");
  const decoded = decodeHtmlEntities(withBreaks);
  return decoded
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]?.length))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  times: "×",
  middot: "·",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity.startsWith("#x") || entity.startsWith("#X")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

interface FetchOutcome {
  finalUrl: string;
  contentType: string;
  status: number;
  body: string;
  truncated: boolean;
}

async function fetchWithRedirects(url: URL, options: { allowPrivateHosts?: boolean }): Promise<FetchOutcome> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        "user-agent": "oran-code/1.0 (+https://github.com/oran-code)",
      },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current);
      current = await assertFetchableUrl(next.toString(), options);
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    const text = await readBoundedBody(response, MAX_HTML_BYTES);
    return {
      finalUrl: current.toString(),
      contentType,
      status: response.status,
      body: text.body,
      truncated: text.truncated,
    };
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const truncated = bytes.byteLength > maxBytes;
  const slice = truncated ? bytes.slice(0, maxBytes) : bytes;
  return { body: new TextDecoder("utf-8", { fatal: false }).decode(slice), truncated };
}

function isHtml(contentType: string): boolean {
  return /text\/html|application\/xhtml|text\/xml/i.test(contentType) || contentType === "";
}

async function loadWebSettings(workspace: string): Promise<WebSettings | undefined> {
  try {
    const config = await loadConfig(workspace);
    return config.web;
  } catch {
    // 配置读取失败不应让联网工具整体失效,按默认设置继续。
    return undefined;
  }
}

/** web_search 的后端协议:tavily(POST + api_key)、searxng(GET + format=json)、brave(header 令牌)、google(Programmable Search)。 */
interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

type SearchProvider = NonNullable<WebSettings["searchProvider"]>;

const SEARCH_PROVIDER_DEFAULTS: Readonly<Record<SearchProvider, string>> = {
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
  google: "https://www.googleapis.com/customsearch/v1",
  searxng: "",
};

/** 未显式指定后端时的推断:配了端点就按 searxng 解释(与既有行为一致),否则用 tavily。 */
export function resolveSearchProvider(settings: WebSettings): SearchProvider {
  if (settings.searchProvider) return settings.searchProvider;
  return settings.searchEndpoint ? "searxng" : "tavily";
}

/** URL 归一化:只用于**判重**,不改变展示给模型的原始链接。 */
export function normalizeResultUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname.replace(/\/+$/, "");
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM_PATTERN.test(key.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right));
    const query = params.length ? `?${params.map(([key, value]) => `${key}=${value}`).join("&")}` : "";
    return `${host}${pathname}${query}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/** 跟踪参数:同一页面在这些参数上不同时应当视为同一条结果。 */
const TRACKING_PARAM_PATTERN =
  /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|source|spm|from|igshid|si|_hsenc|_hsmi)$/;

/**
 * 去重:按归一化 URL 合并重复结果,保留先出现的位置与标题,取更长的摘要。
 * 后端常把同一文档的多个入口(带跟踪参数 / 带尾斜杠 / www 前缀)并列返回,
 * 原样交给模型会重复占用上下文并误导它以为有多个来源。
 */
export function dedupeHits(hits: readonly SearchHit[]): { hits: SearchHit[]; duplicates: number } {
  const byKey = new Map<string, number>();
  const merged: SearchHit[] = [];
  let duplicates = 0;
  for (const hit of hits) {
    const key = normalizeResultUrl(hit.url);
    const existingIndex = key ? byKey.get(key) : undefined;
    if (existingIndex === undefined) {
      if (key) byKey.set(key, merged.length);
      merged.push({ ...hit });
      continue;
    }
    duplicates += 1;
    const existing = merged[existingIndex]!;
    if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
  }
  return { hits: merged, duplicates };
}

async function runSearch(
  query: string,
  limit: number,
  settings: WebSettings,
): Promise<{ hits: SearchHit[]; provider: string; duplicates: number }> {
  const provider = resolveSearchProvider(settings);
  const raw = await fetchSearchHits(provider, query, limit, settings);
  const { hits, duplicates } = dedupeHits(raw);
  return { hits: hits.slice(0, limit), provider, duplicates };
}

async function fetchSearchHits(
  provider: SearchProvider,
  query: string,
  limit: number,
  settings: WebSettings,
): Promise<SearchHit[]> {
  switch (provider) {
    case "tavily":
      return fetchTavily(query, limit, settings);
    case "brave":
      return fetchBrave(query, limit, settings);
    case "google":
      return fetchGoogle(query, limit, settings);
    case "searxng":
      return fetchSearxng(query, limit, settings);
  }
}

async function fetchTavily(query: string, limit: number, settings: WebSettings): Promise<SearchHit[]> {
  if (!settings.searchApiKey) {
    throw new Error("web_search is not configured: set web.searchApiKey (tavily) in the Oran config");
  }
  const endpoint = settings.searchEndpoint ?? SEARCH_PROVIDER_DEFAULTS.tavily;
  const response = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: settings.searchApiKey,
      query,
      max_results: limit,
      search_depth: "basic",
    }),
  });
  if (!response.ok) throw new Error(`search endpoint returned ${response.status} ${response.statusText}`);
  const data = (await response.json()) as Record<string, unknown>;
  return toHits(Array.isArray(data.results) ? data.results : []);
}

/** Brave Search API:GET + `X-Subscription-Token`,结果在 `web.results` 下。 */
async function fetchBrave(query: string, limit: number, settings: WebSettings): Promise<SearchHit[]> {
  if (!settings.searchApiKey) {
    throw new Error("web_search is not configured: set web.searchApiKey (brave) in the Oran config");
  }
  const endpoint = new URL(settings.searchEndpoint ?? SEARCH_PROVIDER_DEFAULTS.brave);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("count", String(Math.min(20, limit)));
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "x-subscription-token": settings.searchApiKey,
    },
  });
  if (!response.ok) throw new Error(`search endpoint returned ${response.status} ${response.statusText}`);
  const data = (await response.json()) as Record<string, unknown>;
  const web = data.web && typeof data.web === "object" ? (data.web as Record<string, unknown>) : {};
  return toHits(Array.isArray(web.results) ? web.results : []);
}

/** Google Programmable Search:GET + key/cx,单次最多 10 条。 */
async function fetchGoogle(query: string, limit: number, settings: WebSettings): Promise<SearchHit[]> {
  if (!settings.searchApiKey || !settings.searchEngineId) {
    throw new Error(
      "web_search is not configured: set web.searchApiKey and web.searchEngineId (cx) for the google provider",
    );
  }
  const endpoint = new URL(settings.searchEndpoint ?? SEARCH_PROVIDER_DEFAULTS.google);
  endpoint.searchParams.set("key", settings.searchApiKey);
  endpoint.searchParams.set("cx", settings.searchEngineId);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("num", String(Math.min(10, limit)));
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`search endpoint returned ${response.status} ${response.statusText}`);
  const data = (await response.json()) as Record<string, unknown>;
  return toHits(Array.isArray(data.items) ? data.items : []);
}

async function fetchSearxng(query: string, limit: number, settings: WebSettings): Promise<SearchHit[]> {
  if (!settings.searchEndpoint) {
    throw new Error("web_search is not configured: set web.searchEndpoint for the searxng provider");
  }
  const endpoint = new URL(settings.searchEndpoint);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("limit", String(limit));
  const headers: Record<string, string> = { accept: "application/json" };
  if (settings.searchApiKey) headers.authorization = `Bearer ${settings.searchApiKey}`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers });
  if (!response.ok) throw new Error(`search endpoint returned ${response.status} ${response.statusText}`);
  const data = (await response.json()) as Record<string, unknown>;
  return toHits(Array.isArray(data.results) ? data.results : []);
}

/** 各后端的结果字段名不同(tavily/searxng: url+content;brave: url+description;google: link+snippet)。 */
function toHits(values: readonly unknown[]): SearchHit[] {
  return values.map(toSearchHit).filter((hit): hit is SearchHit => hit !== undefined);
}

function toSearchHit(value: unknown): SearchHit | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const url = typeof item.url === "string" ? item.url : typeof item.link === "string" ? item.link : "";
  if (!url) return undefined;
  const title = typeof item.title === "string" ? item.title : url;
  const snippet =
    typeof item.content === "string"
      ? item.content
      : typeof item.description === "string"
        ? item.description
        : typeof item.snippet === "string"
          ? item.snippet
          : "";
  return { title, url, snippet };
}

function formatSearchResults(query: string, provider: string, hits: readonly SearchHit[], duplicates = 0): string {
  if (!hits.length) return `No results for "${query}" (${provider}).`;
  return [
    `<web-search query="${query.replaceAll('"', "&quot;")}" provider="${provider}" results="${hits.length}"` +
      (duplicates ? ` deduped="${duplicates}"` : "") +
      ">",
    ...hits.map((hit, index) => {
      const snippet = hit.snippet.length > 600 ? `${hit.snippet.slice(0, 600)}…` : hit.snippet;
      return [`${index + 1}. ${hit.title}`, `   ${hit.url}`, ...(snippet ? [`   ${snippet}`] : [])].join("\n");
    }),
    "</web-search>",
  ].join("\n");
}

export function registerWebTools(registry: { register(tool: ToolDefinition): void }, ctx: ToolFactoryContext): void {
  const { activeRoot } = ctx;

  registry.register({
    name: "web_fetch",
    description:
      "Fetch a public http(s) URL and return readable text (HTML is converted to plain text; JSON/text returned as-is). " +
      "Loopback and private-network addresses are refused. When you only need a few facts from a long page, prefer a documentation page or the search tool first.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch." },
        max_chars: {
          type: "number",
          description: "Maximum characters of text to return. Defaults to 32000.",
        },
      },
      required: ["url"],
    },
    permissionLevel: 2,
    kind: "readonly",
    // 联网内容是活数据:同一 URL 在不同时刻结果不同,不能参与只读结果缓存。
    cacheable: false,
    maxOutputChars: 40_000,
    invoke: async (call, context) => {
      const rawUrl = String(call.arguments.url ?? "").trim();
      if (!rawUrl) return { ok: false, output: "", error: "url is required", summary: "invalid arguments" };
      const settings = await loadWebSettings(activeRoot(context));
      if (settings?.enabled === false) {
        return { ok: false, output: "", error: "web tools are disabled (web.enabled=false)", summary: "disabled" };
      }
      const maxChars = Math.max(
        1_000,
        Math.floor(
          typeof call.arguments.max_chars === "number" && Number.isFinite(call.arguments.max_chars)
            ? call.arguments.max_chars
            : (settings?.fetchMaxChars ?? DEFAULT_FETCH_MAX_CHARS),
        ),
      );
      try {
        const target = await assertFetchableUrl(rawUrl, {
          ...(settings?.allowPrivateHosts !== undefined ? { allowPrivateHosts: settings.allowPrivateHosts } : {}),
        });
        const outcome = await fetchWithRedirects(target, {
          ...(settings?.allowPrivateHosts !== undefined ? { allowPrivateHosts: settings.allowPrivateHosts } : {}),
        });
        if (outcome.status >= 400) {
          return {
            ok: false,
            output: "",
            error: `HTTP ${outcome.status} from ${outcome.finalUrl}`,
            summary: `HTTP ${outcome.status}`,
          };
        }
        const text = isHtml(outcome.contentType) ? htmlToText(outcome.body) : outcome.body;
        const header = [
          `<web-fetch url="${outcome.finalUrl.replaceAll('"', "&quot;")}">`,
          `Status: ${outcome.status}`,
          `Content-Type: ${outcome.contentType || "unknown"}`,
          ...(outcome.truncated ? ["Note: response body was cut off at 2,000,000 bytes."] : []),
          "Content:",
        ].join("\n");
        return {
          ok: true,
          output: `${header}\n${formatPreservingTail(text, maxChars)}\n</web-fetch>`,
          summary: `${outcome.status} ${outcome.contentType || "unknown"}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: "", error: message, summary: "fetch failed" };
      }
    },
  });

  registry.register({
    name: "web_search",
    description:
      "Search the web and return titles, URLs, and snippets. Duplicate results (same page with tracking parameters or a different URL form) are merged. " +
      "Requires web.searchApiKey (tavily / brave), web.searchApiKey + web.searchEngineId (google), or web.searchEndpoint (searxng) in the Oran config.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Maximum results, default 5." },
      },
      required: ["query"],
    },
    permissionLevel: 2,
    kind: "readonly",
    deferred: true,
    cacheable: false,
    maxOutputChars: 16_000,
    invoke: async (call, context) => {
      const query = String(call.arguments.query ?? "").trim();
      if (!query) return { ok: false, output: "", error: "query is required", summary: "invalid arguments" };
      const settings = await loadWebSettings(activeRoot(context));
      if (settings?.enabled === false) {
        return { ok: false, output: "", error: "web tools are disabled (web.enabled=false)", summary: "disabled" };
      }
      const limit = Math.max(
        1,
        Math.min(20, Math.floor(typeof call.arguments.limit === "number" ? call.arguments.limit : 5)),
      );
      try {
        const { hits, provider, duplicates } = await runSearch(query, limit, settings ?? {});
        return {
          ok: true,
          output: formatSearchResults(query, provider, hits, duplicates),
          summary: `${hits.length} results${duplicates ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} merged)` : ""}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: "", error: message, summary: "search failed" };
      }
    },
  });
}
