import type { ProviderConfig } from "./config.ts";
import type { Store } from "./db.ts";
import {
  countTokensEstimate,
  createStreamTranslator,
  makeModelResolver,
  messageToSse,
  translateRequest,
  translateResponseJson,
  type TranslateCtx,
} from "./translate/anthropic-openai.ts";

/**
 * Optional transport-level observer for live streaming. The proxy emits raw
 * byte events without interpreting them, so it stays provider-agnostic.
 */
export interface ProxyTap {
  start(meta: { provider: string; method: string; path: string; status: number }): string;
  chunk(streamId: string, bytes: Uint8Array): void;
  end(streamId: string, exchangeId: number, incomplete: boolean): void;
}

/** Headers we must not forward verbatim to the upstream. */
const HOP_BY_HOP = new Set(["host", "connection", "content-length", "accept-encoding"]);

function headersToObject(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => (o[k] = v));
  return o;
}

/** Metadata captured for every exchange, independent of how the body is read. */
interface BaseMeta {
  providerId: string;
  method: string;
  reqPath: string;
  upstreamUrl: string;
  reqHeaders: Record<string, string>;
  reqBody: Uint8Array;
  status: number;
  respHeaders: Record<string, string>;
  tsStart: number;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }
  return body;
}

/**
 * Tee a streaming upstream response: every chunk is captured (raw, with arrival
 * timing) AND forwarded to the client the instant it arrives. When `transform`
 * is given, the client copy is the transformed text while the capture keeps the
 * raw upstream bytes — this is how the translate path stores the real OpenAI
 * exchange but hands Claude Code an Anthropic stream. The exchange is persisted
 * when the stream ends (or is cut off -> incomplete).
 */
function streamingCapture(
  upstream: Response,
  meta: BaseMeta,
  store: Store,
  tap: ProxyTap | undefined,
  tapMeta: { provider: string; method: string; path: string; status: number },
  clientHeaders: Headers,
  isStreaming: boolean,
  transform?: { push(text: string): string; flush(): string },
  log?: string,
): Response {
  const streamId = tap?.start(tapMeta);
  const chunks: Uint8Array[] = [];
  const timings: number[] = [];
  let firstByte: number | null = null;
  let total = 0;
  let nChunks = 0;

  const reader = upstream.body!.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let persisted = false;
  function persist(incomplete: boolean, why?: string) {
    if (persisted) return;
    persisted = true;
    const id = store.insert({
      ...meta,
      respBody: concat(chunks, total),
      isStreaming,
      incomplete,
      tsFirstByte: firstByte,
      tsEnd: Date.now(),
      chunkTimings: isStreaming ? timings : null,
    });
    if (tap && streamId) tap.end(streamId, id, incomplete);
    if (log) {
      const secs = ((Date.now() - meta.tsStart) / 1000).toFixed(1);
      console.log(`${log} stream end (${why}): ${nChunks} chunks, ${total} bytes, ${secs}s${incomplete ? " [INCOMPLETE]" : ""}`);
    }
  }

  // Pump the upstream continuously in start() rather than one read per pull():
  // some upstreams (e.g. OpenAI-compatible servers behind Fireworks) stall the
  // connection if the socket isn't drained back-to-back, and the pull cadence
  // (a consumer round-trip between reads) is enough to trigger that stall.
  let cancelled = false;
  const captured = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush any trailing translated bytes before closing.
            if (transform) {
              const tail = transform.flush();
              if (tail) controller.enqueue(enc.encode(tail));
            }
            persist(false, "done");
            controller.close();
            return;
          }
          if (firstByte === null) {
            firstByte = Date.now();
            if (log) console.log(`${log} first upstream byte after ${firstByte - meta.tsStart}ms`);
          }
          nChunks++;
          chunks.push(value);
          timings.push(Date.now() - meta.tsStart);
          total += value.byteLength;
          if (transform) {
            const out = transform.push(dec.decode(value, { stream: true }));
            if (out) controller.enqueue(enc.encode(out));
          } else {
            controller.enqueue(value);
          }
          if (tap && streamId) tap.chunk(streamId, value);
        }
      } catch (err) {
        if (cancelled) {
          persist(true, "client cancelled");
          return;
        }
        if (log) console.error(`${log} upstream read error: ${String(err)}`);
        persist(true, "upstream error"); // upstream cut off mid-stream
        try {
          controller.error(err);
        } catch {
          /* controller already closed */
        }
      }
    },
    cancel(reason) {
      cancelled = true;
      reader.cancel().catch(() => {}); // unblocks the start() read loop
      persist(true, `client cancelled: ${String(reason ?? "")}`); // client disconnected mid-stream
    },
  });

  return new Response(captured, { status: upstream.status, headers: clientHeaders });
}

/**
 * Forward one matched request to its upstream while capturing the exchange.
 * Translate providers (anthropic->openai) take the dedicated path below.
 */
export async function handleProxy(
  req: Request,
  url: URL,
  provider: ProviderConfig,
  store: Store,
  tap?: ProxyTap,
): Promise<Response> {
  if (provider.translate) return handleProxyTranslate(req, url, provider, store, tap);

  const rest = url.pathname.slice(provider.prefix.length) || "/";
  const upstreamUrl = provider.upstream.replace(/\/$/, "") + rest + url.search;

  // Buffer the request body so we can both forward and store it. Coding-agent
  // requests are bounded JSON, so this is fine.
  const reqBody = new Uint8Array(await req.arrayBuffer());

  const fwdHeaders = new Headers();
  req.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) fwdHeaders.set(k, v);
  });
  // Ask for identity so captured bytes == decoded bytes (no gzip mismatch).
  fwdHeaders.set("accept-encoding", "identity");

  const tsStart = Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: reqBody.byteLength ? reqBody : undefined,
      redirect: "manual",
      // Skip cert validation only when the provider explicitly opts out, e.g.
      // a self-signed OpenAI-compatible server on the local network.
      tls: { rejectUnauthorized: provider.tls_verify !== false },
      // Never route upstream fetches through a proxy. When the transparent MITM
      // proxy is enabled, HTTPS_PROXY points at luwak itself — without this,
      // fetch would loop back through the transparent proxy infinitely.
      proxy: "",
    });
  } catch (err) {
    return new Response(`luwak: upstream fetch failed: ${String(err)}`, { status: 502 });
  }

  const respHeaders = headersToObject(upstream.headers);
  // Strip encoding/length we may have altered; client reads raw passthrough bytes.
  const clientHeaders = new Headers(upstream.headers);
  clientHeaders.delete("content-encoding");
  clientHeaders.delete("content-length");

  const meta: BaseMeta = {
    providerId: provider.id,
    method: req.method,
    reqPath: rest + url.search,
    upstreamUrl,
    reqHeaders: headersToObject(req.headers),
    reqBody,
    status: upstream.status,
    respHeaders,
    tsStart,
  };

  const tapMeta = { provider: provider.id, method: req.method, path: rest, status: upstream.status };

  if (!upstream.body) {
    const id = store.insert({
      ...meta,
      respBody: new Uint8Array(0),
      isStreaming: false,
      incomplete: false,
      tsFirstByte: null,
      tsEnd: Date.now(),
      chunkTimings: null,
    });
    if (tap) {
      const sid = tap.start(tapMeta);
      tap.end(sid, id, false);
    }
    return new Response(null, { status: upstream.status, headers: clientHeaders });
  }

  const isStreaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  return streamingCapture(upstream, meta, store, tap, tapMeta, clientHeaders, isStreaming);
}

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * Translate path: an Anthropic Messages request in, an OpenAI Chat Completions
 * request to the upstream, and an Anthropic response back to the client. The
 * captured exchange is the real upstream (OpenAI) traffic, parsed by the
 * provider's `openai` adapter for the viewer.
 */
async function handleProxyTranslate(
  req: Request,
  url: URL,
  provider: ProviderConfig,
  store: Store,
  tap?: ProxyTap,
): Promise<Response> {
  const rest = url.pathname.slice(provider.prefix.length) || "/";
  const reqBytes = new Uint8Array(await req.arrayBuffer());

  let anthropicBody: Record<string, unknown>;
  try {
    anthropicBody = JSON.parse(new TextDecoder().decode(reqBytes));
  } catch {
    return jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "luwak: request body is not JSON" } }, 400);
  }

  // count_tokens has no OpenAI equivalent; answer with a local estimate.
  if (rest.replace(/\?.*$/, "").endsWith("/count_tokens")) {
    return jsonResponse({ input_tokens: countTokensEstimate(anthropicBody) });
  }

  const resolve = makeModelResolver(provider.models!);
  const { body: openaiBody, stream } = translateRequest(anthropicBody, resolve, { maxTokensCap: provider.max_output_tokens });
  const openaiBytes = new TextEncoder().encode(JSON.stringify(openaiBody));

  const upstreamUrl = provider.upstream.replace(/\/$/, "") + (provider.chat_path ?? "/v1/chat/completions");

  // Forward headers: drop hop-by-hop and Anthropic-specific auth, translate the
  // client's x-api-key into an OpenAI Bearer token.
  const fwd = new Headers();
  req.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (lk === "x-api-key" || lk === "authorization" || lk.startsWith("anthropic-")) return;
    fwd.set(k, v);
  });
  const apiKey = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (apiKey) fwd.set("authorization", `Bearer ${apiKey}`);
  fwd.set("content-type", "application/json");
  fwd.set("accept-encoding", "identity");

  if (!apiKey) {
    console.warn(`[translate] ${provider.id}: no x-api-key/Authorization on the request — upstream will likely 401`);
  }

  const tsStart = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: fwd,
      body: openaiBytes,
      redirect: "manual",
      tls: { rejectUnauthorized: provider.tls_verify !== false },
      proxy: "",
    });
  } catch (err) {
    // Surface connection/TLS/DNS failures: these never reach store.insert, so
    // without this they are invisible in both luwak and the client.
    console.error(`[translate] ${provider.id}: upstream fetch failed: ${upstreamUrl}\n  ${String(err)}`);
    return jsonResponse(
      { type: "error", error: { type: "api_error", message: `luwak: upstream fetch failed: ${String(err)}` } },
      502,
    );
  }
  console.log(`[translate] ${provider.id}: POST ${rest} -> ${upstreamUrl} ${upstream.status}${stream ? " (stream)" : ""}`);

  const meta: BaseMeta = {
    providerId: provider.id,
    method: "POST",
    reqPath: rest + url.search,
    upstreamUrl,
    reqHeaders: headersToObject(req.headers),
    reqBody: openaiBytes, // store the translated OpenAI request (wire truth)
    status: upstream.status,
    respHeaders: headersToObject(upstream.headers),
    tsStart,
  };
  const tapMeta = { provider: provider.id, method: "POST", path: rest, status: upstream.status };
  const ctx: TranslateCtx = {
    model: typeof anthropicBody.model === "string" ? anthropicBody.model : "unknown",
    inputTokens: countTokensEstimate(anthropicBody),
  };

  const upstreamCt = upstream.headers.get("content-type") ?? "";
  const upstreamIsStream = upstreamCt.includes("text/event-stream");
  const ok = upstream.status >= 200 && upstream.status < 300;
  console.log(`[translate] ${provider.id}: upstream content-type "${upstreamCt}" -> ${stream && upstreamIsStream && ok ? "stream-translate" : "buffer"} branch`);

  // Streaming success: tee raw OpenAI SSE into capture, translate to Anthropic SSE.
  if (stream && upstreamIsStream && ok && upstream.body) {
    const clientHeaders = new Headers({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    return streamingCapture(upstream, meta, store, tap, tapMeta, clientHeaders, true, createStreamTranslator(ctx), `[translate] ${provider.id}:`);
  }

  // Otherwise buffer the full body, capture it, and translate (or pass through errors).
  const respBytes = new Uint8Array(await upstream.arrayBuffer());
  const id = store.insert({
    ...meta,
    respBody: respBytes,
    isStreaming: false,
    incomplete: false,
    tsFirstByte: respBytes.byteLength ? Date.now() : null,
    tsEnd: Date.now(),
    chunkTimings: null,
  });
  if (tap) {
    const sid = tap.start(tapMeta);
    if (respBytes.byteLength) tap.chunk(sid, respBytes);
    tap.end(sid, id, false);
  }

  if (!ok) {
    // Surface the upstream error body unchanged; Anthropic clients display it.
    console.error(`[translate] ${provider.id}: upstream ${upstream.status} error: ${new TextDecoder().decode(respBytes).slice(0, 500)}`);
    return new Response(respBytes, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  let openaiResp: Record<string, unknown>;
  try {
    openaiResp = JSON.parse(new TextDecoder().decode(respBytes));
  } catch {
    console.error(`[translate] ${provider.id}: upstream 200 but body is not JSON (content-type "${upstreamCt}"): ${new TextDecoder().decode(respBytes).slice(0, 500)}`);
    return jsonResponse({ type: "error", error: { type: "api_error", message: "luwak: upstream returned a non-JSON, non-SSE response" } }, 502);
  }
  const anthropic = translateResponseJson(openaiResp, ctx);
  // The client asked for a stream but the upstream answered with one buffered
  // body; replay it as Anthropic SSE so the client doesn't hang waiting.
  if (stream) {
    return new Response(messageToSse(anthropic), {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  return jsonResponse(anthropic);
}
