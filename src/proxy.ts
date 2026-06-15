import type { ProviderConfig } from "./config.ts";
import type { Store } from "./db.ts";

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

/**
 * Forward one matched request to its upstream while capturing the exchange.
 *
 * Streaming is tee'd: each chunk is enqueued to the client the instant it
 * arrives AND appended to a capture buffer with an arrival timestamp. The
 * exchange is persisted when the stream ends (or is cut off -> incomplete).
 */
export async function handleProxy(
  req: Request,
  url: URL,
  provider: ProviderConfig,
  store: Store,
  tap?: ProxyTap,
): Promise<Response> {
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
    });
  } catch (err) {
    return new Response(`luwak: upstream fetch failed: ${String(err)}`, { status: 502 });
  }

  const respHeaders = headersToObject(upstream.headers);
  // Strip encoding/length we may have altered; client reads raw passthrough bytes.
  const clientHeaders = new Headers(upstream.headers);
  clientHeaders.delete("content-encoding");
  clientHeaders.delete("content-length");

  const meta = {
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
      const sid = tap.start({ provider: provider.id, method: req.method, path: rest, status: upstream.status });
      tap.end(sid, id, false);
    }
    return new Response(null, { status: upstream.status, headers: clientHeaders });
  }

  const isStreaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  const streamId = tap?.start({ provider: provider.id, method: req.method, path: rest, status: upstream.status });
  const chunks: Uint8Array[] = [];
  const timings: number[] = [];
  let firstByte: number | null = null;
  let total = 0;

  const reader = upstream.body.getReader();
  const captured = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          persist(false);
          controller.close();
          return;
        }
        if (firstByte === null) firstByte = Date.now();
        chunks.push(value);
        timings.push(Date.now() - tsStart);
        total += value.byteLength;
        controller.enqueue(value);
        if (tap && streamId) tap.chunk(streamId, value);
      } catch (err) {
        persist(true); // upstream cut off mid-stream
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
      persist(true); // client disconnected mid-stream
    },
  });

  let persisted = false;
  function persist(incomplete: boolean) {
    if (persisted) return;
    persisted = true;
    const body = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      body.set(c, off);
      off += c.byteLength;
    }
    const id = store.insert({
      ...meta,
      respBody: body,
      isStreaming,
      incomplete,
      tsFirstByte: firstByte,
      tsEnd: Date.now(),
      chunkTimings: isStreaming ? timings : null,
    });
    if (tap && streamId) tap.end(streamId, id, incomplete);
  }

  return new Response(captured, { status: upstream.status, headers: clientHeaders });
}
