import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleProxy, type ProxyTap } from "../src/proxy.ts";
import type { ProviderConfig } from "../src/config.ts";
import type { Store } from "../src/db.ts";
import type { ExchangeInput } from "../src/db.ts";

const provider: ProviderConfig = {
  id: "zen",
  prefix: "/zen",
  upstream: "https://example.test/base",
  adapter: "openai",
  translate: "anthropic->openai",
  chat_path: "/v1/chat/completions",
  models: { default: "big-model", small: "small-model" },
  tls_verify: true,
};

const realFetch = globalThis.fetch;
let lastFetch: { url: string; init: RequestInit } | null = null;

beforeEach(() => {
  lastFetch = null;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(response: Response) {
  globalThis.fetch = (async (input: any, init: any) => {
    lastFetch = { url: String(input), init };
    return response;
  }) as typeof fetch;
}

function sseResponse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stubStore(): { store: Store; captured: ExchangeInput[] } {
  const captured: ExchangeInput[] = [];
  const store = { insert: (e: ExchangeInput) => (captured.push(e), captured.length) } as unknown as Store;
  return { store, captured };
}

function anthropicReq(body: unknown): { req: Request; url: URL } {
  const req = new Request("http://localhost:8080/zen/v1/messages?beta=true", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  return { req, url: new URL(req.url) };
}

test("streaming translate: OpenAI upstream SSE -> Anthropic SSE, OpenAI exchange captured", async () => {
  const openaiSse =
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
    "data: [DONE]\n\n";
  mockFetch(sseResponse(openaiSse));
  const { store, captured } = stubStore();

  const { req, url } = anthropicReq({ model: "claude-opus-4", stream: true, max_tokens: 50, messages: [{ role: "user", content: "hello" }] });
  const res = await handleProxy(req, url, provider, store);
  const out = await res.text();

  // Client got translated Anthropic SSE.
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(out).toContain("event: message_start");
  expect(out).toContain("event: message_stop");
  const text = [...out.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join("");
  expect(text).toBe("Hi there");

  // Upstream got an OpenAI Chat Completions request at the right URL with Bearer auth.
  expect(lastFetch!.url).toBe("https://example.test/base/v1/chat/completions");
  expect((lastFetch!.init.headers as Headers).get("authorization")).toBe("Bearer sk-test");
  const sentBody = JSON.parse(new TextDecoder().decode(lastFetch!.init.body as Uint8Array));
  expect(sentBody.model).toBe("big-model");
  expect(sentBody.stream).toBe(true);
  expect(sentBody.messages).toEqual([{ role: "user", content: "hello" }]);

  // Captured exchange is the real OpenAI traffic (req = translated, resp = raw SSE).
  expect(captured).toHaveLength(1);
  const ex = captured[0]!;
  expect(ex.providerId).toBe("zen");
  expect(JSON.parse(new TextDecoder().decode(ex.reqBody)).model).toBe("big-model");
  expect(new TextDecoder().decode(ex.respBody)).toBe(openaiSse);
  expect(ex.isStreaming).toBe(true);
});

test("non-streaming translate returns an Anthropic message JSON", async () => {
  const openaiJson = {
    id: "chatcmpl-9",
    choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 1 },
  };
  globalThis.fetch = (async (input: any, init: any) => {
    lastFetch = { url: String(input), init };
    return new Response(JSON.stringify(openaiJson), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const { store, captured } = stubStore();

  const { req, url } = anthropicReq({ model: "claude-opus-4", stream: false, max_tokens: 10, messages: [{ role: "user", content: "ping" }] });
  const res = await handleProxy(req, url, provider, store);
  const body = await res.json();

  expect(res.headers.get("content-type")).toContain("application/json");
  expect(body.type).toBe("message");
  expect(body.content).toEqual([{ type: "text", text: "pong" }]);
  expect(body.stop_reason).toBe("end_turn");
  expect(body.usage).toEqual({ input_tokens: 4, output_tokens: 1 });
  expect(captured).toHaveLength(1);
});

test("count_tokens is answered locally without calling upstream", async () => {
  mockFetch(sseResponse("")); // should NOT be called
  const { store, captured } = stubStore();

  const req = new Request("http://localhost:8080/zen/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test" },
    body: JSON.stringify({ model: "claude-opus-4", messages: [{ role: "user", content: "some text here" }] }),
  });
  const res = await handleProxy(req, new URL(req.url), provider, store);
  const body = await res.json();

  expect(typeof body.input_tokens).toBe("number");
  expect(body.input_tokens).toBeGreaterThan(0);
  expect(lastFetch).toBeNull();
  expect(captured).toHaveLength(0);
});
