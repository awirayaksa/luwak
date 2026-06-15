import { loadConfig, parseListen } from "./config.ts";
import { Store } from "./db.ts";
import { handleProxy } from "./proxy.ts";
import { normalizeExchange, reparseAll, type AdapterMap } from "./normalize.ts";
import { buildThreadView } from "./threading.ts";
import { LiveBus } from "./live.ts";
import { makeRedactor } from "./redact.ts";
import type { ProxyTap } from "./proxy.ts";
// Embedded so the compiled binary is self-contained.
import viewerHtml from "../public/index.html" with { type: "text" };
// Brand assets, embedded as files so they ship inside the compiled binary.
import faviconIco from "../public/assets/favicon.ico" with { type: "file" };
import iconSvg from "../public/assets/luwak-icon.svg" with { type: "file" };
import markSvg from "../public/assets/luwak-mark.svg" with { type: "file" };
import logoSvg from "../public/assets/luwak-logo.svg" with { type: "file" };
import logoPng from "../public/assets/luwak-logo.png" with { type: "file" };
import monoSvg from "../public/assets/luwak-mono.svg" with { type: "file" };
const assets: Record<string, string> = {
  "favicon.ico": faviconIco,
  "luwak-icon.svg": iconSvg,
  "luwak-mark.svg": markSvg,
  "luwak-logo.svg": logoSvg,
  "luwak-logo.png": logoPng,
  "luwak-mono.svg": monoSvg,
};

const config = loadConfig(process.env.LUWAK_CONFIG ?? "luwak.yaml");
const store = new Store(config.db);
const redactor = makeRedactor(config.redact);

// providerId -> adapterId, so the normalizer can pick a parser per exchange.
const adapters: AdapterMap = new Map(config.providers.map((p) => [p.id, p.adapter]));

// Dumb proxy stays dumb: normalization is wired here, off the insert hook.
store.onInsert = (id) => normalizeExchange(store, adapters, id);

// `luwak reparse` rebuilds the derived layer from sacred raw, then exits.
if (process.argv.includes("reparse")) {
  const { total, ok } = reparseAll(store, adapters);
  console.log(`luwak reparse: ${ok}/${total} exchanges normalized`);
  process.exit(0);
}

// `luwak export` dumps every exchange as redacted JSONL to stdout, then exits.
if (process.argv.includes("export")) {
  for (const id of store.allExchangeIds()) {
    const e = store.get(id);
    if (e) console.log(JSON.stringify(redactor.exchange(e)));
  }
  process.exit(0);
}

// Live tail: the proxy tees raw byte events here; provider-agnostic.
const bus = new LiveBus();
const dec = new TextDecoder();
const tap: ProxyTap = {
  start(meta) {
    const id = bus.nextStreamId();
    bus.publish({ type: "start", streamId: id, ts: Date.now(), ...meta });
    return id;
  },
  chunk(id, bytes) {
    bus.publish({ type: "chunk", streamId: id, text: dec.decode(bytes) });
  },
  end(id, exchangeId, incomplete) {
    bus.publish({ type: "end", streamId: id, exchangeId, incomplete });
  },
};

const { hostname, port } = parseListen(config.listen);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const server = Bun.serve({
  hostname,
  port,
  // Long-running streamed responses must not be killed by an idle timeout.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- Viewer + query API (these win over proxy prefixes) ---
    if (path === "/" || path === "/app") {
      return new Response(viewerHtml, { headers: { "content-type": "text/html" } });
    }
    const asset = path.match(/^\/assets\/(.+)$/);
    if (asset && assets[asset[1]]) {
      // Bun.file infers content-type from the extension.
      return new Response(Bun.file(assets[asset[1]]));
    }
    if (path === "/api/exchanges") {
      return json(store.list());
    }
    const m = path.match(/^\/api\/exchanges\/(\d+)$/);
    if (m) {
      const row = store.get(Number(m[1]));
      return row ? json(row) : json({ error: "not found" }, 404);
    }
    const mm = path.match(/^\/api\/exchanges\/(\d+)\/messages$/);
    if (mm) {
      return json(store.getMessages(Number(mm[1])));
    }
    const ex = path.match(/^\/api\/exchanges\/(\d+)\/export$/);
    if (ex) {
      const row = store.get(Number(ex[1]));
      return row ? json(redactor.exchange(row)) : json({ error: "not found" }, 404);
    }
    if (path === "/api/stream") {
      return bus.subscribe();
    }
    if (path === "/api/search") {
      const q = url.searchParams.get("q")?.trim();
      return q ? json(store.search(q)) : json([]);
    }
    if (path === "/api/threads") {
      return json(store.listThreads());
    }
    const t = path.match(/^\/api\/threads\/(\d+)$/);
    if (t) {
      return json(buildThreadView(store, Number(t[1])));
    }

    // --- Proxy: first matching provider prefix (longest first) ---
    for (const p of config.providers) {
      if (path === p.prefix || path.startsWith(p.prefix + "/")) {
        return handleProxy(req, url, p, store, tap);
      }
    }

    return json({ error: `no route for ${path}` }, 404);
  },
});

console.log(`luwak listening on http://${server.hostname}:${server.port}`);
console.log(`  viewer:  http://${server.hostname}:${server.port}/app`);
for (const p of config.providers) {
  console.log(`  ${p.id.padEnd(10)} ${p.prefix}  ->  ${p.upstream}`);
}
