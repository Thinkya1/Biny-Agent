import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { analyzePermissionRequest } from "../src/permission/policy.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { writeCookieJar } from "../src/tools/web/cookieJar.js";
import { createWebSearchTool, parseDuckDuckGoResults, parseGoogleResults, parseTavilyResults } from "../src/tools/web/search.js";

async function main(): Promise<void> {
  testDuckDuckGoParser();
  testGoogleParser();
  testTavilyParser();
  await testDuckDuckGoSearch();
  await testSearchResponseBodyIsBounded();
  await testGoogleSearchWithCookies();
  await testBraveSearch();
  await testTavilySearch();
  await testAnySearch();
  testWebSearchPermission();
  testWebSearchRegistration();
}

function testDuckDuckGoParser(): void {
  const results = parseDuckDuckGoResults(`
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&amp;rut=test">Example &amp; result</a>
    </h2>
    <a class="result__snippet" href="/">A <b>useful</b> summary.</a>
  `, 5);

  assert.deepEqual(results, [{
    title: "Example & result",
    url: "https://example.com/",
    snippet: "A useful summary."
  }]);
}

function testGoogleParser(): void {
  const results = parseGoogleResults(`
    <a href="/url?q=https%3A%2F%2Fexample.com%2Fguide&amp;sa=U"><h3>Example &amp; guide</h3></a>
    <div>Useful <b>first</b> result.</div>
    <a href="https://example.org/reference"><h3>Reference</h3></a>
    <div>Second result.</div>
  `, 5);

  assert.deepEqual(results, [
    { title: "Example & guide", url: "https://example.com/guide", snippet: "Useful first result." },
    { title: "Reference", url: "https://example.org/reference", snippet: "Second result." }
  ]);
}

function testTavilyParser(): void {
  const results = parseTavilyResults({
    results: [
      { title: "Secure", url: "https://example.com/a", content: "ok", favicon: "https://example.com/favicon.ico" },
      { title: "Plain HTTP favicon", url: "https://example.com/b", content: "ok", favicon: "http://tracker.example.com/pixel.ico" }
    ]
  }, 5);
  assert.equal(results[0]?.favicon, "https://example.com/favicon.ico");
  // 明文 http favicon 会被渲染端当 <img src> 加载，解析阶段直接丢弃。
  assert.equal(results[1]?.favicon, undefined);
}

async function testDuckDuckGoSearch(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestedUrl: URL | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    requestedUrl = new URL(String(input));
    return new Response(`
      <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweather.gov%2Fchicago&amp;rut=one">Chicago Weather</a></h2>
      <a class="result__snippet" href="/">Official <b>forecast</b> source.</a>
      <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fweather&amp;rut=two">Example Forecast</a></h2>
      <a class="result__snippet" href="/">A second result.</a>
    `, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  try {
    const config = configSchema.parse({
      ...defaultConfig,
      web: {
        search: {
          ...defaultConfig.web.search,
          provider: "duckduckgo",
          maxResults: 3,
          timeoutMs: 1_000
        }
      }
    });
    const tool = createWebSearchTool(config.web.search);
    const execution = await tool.resolveExecution({ query: "Chicago weather", maxResults: 2, domains: ["weather.gov"], recency: "day" });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({ toolCallId: "search-1", signal: undefined });

    assert.equal(result.query, "Chicago weather");
    assert.equal(result.provider, "duckduckgo");
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0]?.url, "https://weather.gov/chicago");
    assert.equal(requestedUrl?.searchParams.get("df"), "d");
    assert.match(requestedUrl?.searchParams.get("q") ?? "", /site:weather\.gov/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 响应体必须按字节收口：超出上限之后的内容不应进入解析。 */
async function testSearchResponseBodyIsBounded(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const padding = "x".repeat(3 * 1024 * 1024);
  globalThis.fetch = (async (): Promise<Response> => new Response(`
    <h2 class="result__title"><a class="result__a" href="https://example.com/early">Early result</a></h2>
    ${padding}
    <h2 class="result__title"><a class="result__a" href="https://example.com/beyond-limit">Late result</a></h2>
  `, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;

  try {
    const tool = createWebSearchTool({
      enabled: true,
      provider: "duckduckgo",
      apiKey: undefined,
      apiKeyEnv: undefined,
      timeoutMs: 5_000,
      maxResults: 5
    });
    const execution = await tool.resolveExecution({ query: "bounded" });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({ toolCallId: "search-bounded", signal: undefined });
    assert.deepEqual(result.results.map((entry) => entry.url), ["https://example.com/early"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testGoogleSearchWithCookies(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-google-search-"));
  const jarPath = path.join(directory, "cookies.json");
  const originalFetch = globalThis.fetch;
  let requestedUrl: URL | undefined;
  let requestedHeaders: Headers | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestedUrl = new URL(String(input));
    requestedHeaders = new Headers(init?.headers);
    return new Response(`
      <a href="/url?q=https%3A%2F%2Fexample.com%2Farticle"><h3>Google result</h3></a>
      <div>A result returned by Google.</div>
    `, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  try {
    await writeCookieJar(jarPath, [{
      name: "SID",
      value: "google-test-cookie",
      domain: ".google.com",
      path: "/",
      secure: true,
      httpOnly: true
    }]);
    const tool = createWebSearchTool({
      enabled: true,
      provider: "google",
      apiKey: undefined,
      apiKeyEnv: undefined,
      timeoutMs: 1_000,
      maxResults: 5
    }, { enabled: true, path: jarPath });
    const execution = await tool.resolveExecution({ query: "Biny", maxResults: 2, domains: ["example.com"], recency: "week" });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({ toolCallId: "search-google", signal: undefined });
    assert.equal(result.provider, "google");
    assert.deepEqual(result.results, [{ title: "Google result", url: "https://example.com/article", snippet: "A result returned by Google." }]);
    assert.equal(requestedUrl?.origin, "https://www.google.com");
    assert.equal(requestedUrl?.searchParams.get("tbs"), "qdr:w");
    assert.match(requestedUrl?.searchParams.get("q") ?? "", /site:example\.com/);
    assert.equal(requestedHeaders?.get("cookie"), "SID=google-test-cookie");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}

async function testBraveSearch(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BINY_TEST_BRAVE_KEY;
  process.env.BINY_TEST_BRAVE_KEY = "test-key";
  let requestedHeaders: Headers | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ web: { results: [{ title: "Brave result", url: "https://example.com", description: "A result from Brave." }] } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const tool = createWebSearchTool({
      enabled: true,
      provider: "brave",
      apiKeyEnv: "BINY_TEST_BRAVE_KEY",
      timeoutMs: 1_000,
      maxResults: 5
    });
    const execution = await tool.resolveExecution({ query: "Biny" });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({ toolCallId: "search-2", signal: undefined });
    assert.equal(result.results[0]?.title, "Brave result");
    assert.equal(requestedHeaders?.get("x-subscription-token"), "test-key");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BINY_TEST_BRAVE_KEY;
    else process.env.BINY_TEST_BRAVE_KEY = originalKey;
  }
}

async function testTavilySearch(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestedUrl: URL | undefined;
  let requestedHeaders: Headers | undefined;
  let requestedBody: { query?: string; max_results?: number; time_range?: string; include_favicon?: boolean; include_domains?: string[] } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestedUrl = new URL(String(input));
    requestedHeaders = new Headers(init?.headers);
    requestedBody = JSON.parse(String(init?.body)) as typeof requestedBody;
    return new Response(JSON.stringify({
      query: "Biny",
      results: [{
        title: "Tavily result",
        url: "https://example.com/tavily",
        content: "A result from Tavily.",
        score: 0.98,
        favicon: "https://example.com/favicon.ico"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const tool = createWebSearchTool({
      enabled: true,
      provider: "tavily",
      apiKey: "tvly-test-key",
      apiKeyEnv: undefined,
      timeoutMs: 1_000,
      maxResults: 5
    });
    const execution = await tool.resolveExecution({ query: "Biny", maxResults: 3, domains: ["example.com"], recency: "week" });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({ toolCallId: "search-tavily", signal: undefined });
    assert.equal(result.provider, "tavily");
    assert.deepEqual(result.results, [{
      title: "Tavily result",
      url: "https://example.com/tavily",
      snippet: "A result from Tavily.",
      favicon: "https://example.com/favicon.ico"
    }]);
    assert.equal(requestedUrl?.toString(), "https://api.tavily.com/search");
    assert.equal(requestedHeaders?.get("authorization"), "Bearer tvly-test-key");
    assert.equal(requestedBody?.query, "Biny");
    assert.equal(requestedBody?.max_results, 3);
    assert.equal(requestedBody?.time_range, "week");
    assert.equal(requestedBody?.include_favicon, true);
    assert.deepEqual(requestedBody?.include_domains, ["example.com"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAnySearch(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BINY_TEST_ANYSEARCH_KEY;
  process.env.BINY_TEST_ANYSEARCH_KEY = "test-key";
  let requestedUrl: URL | undefined;
  let requestedMethod: string | undefined;
  let requestedHeaders: Headers | undefined;
  let requestedBody: { query?: string; max_results?: number } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestedUrl = new URL(String(input));
    requestedMethod = init?.method;
    requestedHeaders = new Headers(init?.headers);
    requestedBody = JSON.parse(String(init?.body)) as { query?: string; max_results?: number };
    return new Response(JSON.stringify({
      code: 0,
      message: "success",
      data: {
        results: [{
          title: "AnySearch result",
          url: "https://example.com/anysearch",
          snippet: "A result from AnySearch.",
          content: "The full content is intentionally ignored by web_search."
        }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const tool = createWebSearchTool({
      enabled: true,
      provider: "anysearch",
      apiKeyEnv: "BINY_TEST_ANYSEARCH_KEY",
      timeoutMs: 1_000,
      maxResults: 5
    });
    const execution = await tool.resolveExecution({ query: "Biny", maxResults: 2, domains: ["example.com"] });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({ toolCallId: "search-3", signal: undefined });
    assert.equal(result.provider, "anysearch");
    assert.equal(result.results[0]?.title, "AnySearch result");
    assert.equal(result.results[0]?.snippet, "A result from AnySearch.");
    assert.equal(requestedUrl?.toString(), "https://api.anysearch.com/v1/search");
    assert.equal(requestedMethod, "POST");
    assert.equal(requestedHeaders?.get("authorization"), "Bearer test-key");
    assert.equal(requestedBody?.max_results, 2);
    assert.match(requestedBody?.query ?? "", /site:example\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BINY_TEST_ANYSEARCH_KEY;
    else process.env.BINY_TEST_ANYSEARCH_KEY = originalKey;
  }
}

function testWebSearchPermission(): void {
  const request = analyzePermissionRequest({
    toolName: "web_search",
    args: { query: "Chicago weather" },
    sessionId: "test",
    projectRoot: "/tmp"
  });
  assert.equal(request.actionType, "read");
  assert.equal(request.riskLevel, "low");
}

function testWebSearchRegistration(): void {
  const registry = createToolRegistry(
    { workspaceRoot: "/tmp", ignore: [] },
    { ...defaultConfig.web.search, enabled: true }
  );
  assert.equal(registry.get("web_search").name, "web_search");

  const disabledRegistry = createToolRegistry({ workspaceRoot: "/tmp", ignore: [] }, {
    ...defaultConfig.web.search,
    enabled: false
  });
  assert.throws(() => disabledRegistry.get("web_search"), /Unknown tool: web_search/);
}

await main();
