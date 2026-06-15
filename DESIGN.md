# luwak — design

A fast, light LLM proxy that captures raw request/response traffic from LLM
clients (coding agents, chatbots), plus a realtime + offline viewer for
analyzing the captured conversations.

Two layers:

- **Lower (proxy):** capture raw, provider-agnostic, multi-provider by config.
- **Higher (viewer):** reconstruct and analyze conversations from the raw logs.

---

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Interception | **Reverse proxy** via base-URL override (no MITM). |
| 2 | Runtime | **Bun + TypeScript**, single `bun build --compile` binary. |
| 3 | Routing | **Path-prefix on one port**; providers declared in config. |
| 4 | Parsing locus | **Dumb proxy, smart viewer.** Proxy stores raw bytes + transport metadata only. |
| 5 | Sessioning | **Greedy prefix-chaining** into threads (parser/viewer layer). |
| 6 | Viewer + live | **Embedded web SPA + SSE** live tail; offline = same UI on stored DB. |
| 7 | Normalized model | **Canonical content-parts** model with `rawRef` back to bytes. |
| 8 | Secrets | **Full raw at rest; redact at export/share boundary.** |
| 9 | Parse storage | **Materialized + rebuildable** derived tables + FTS5; `luwak reparse`. |
| 10 | Streaming | **Tee pass-through + per-chunk timing**; persist on end; flag partials. |
| 11 | Raw size | **zstd body blobs + configurable retention.** |
| 12 | Provider contract | **Config + optional adapter.** OpenAI-compatibles = config-only. |
| 13 | Viewer model | **Thread-centric + composable stacking lenses** + raw feed. |
| 14 | Threading robustness | **Greedy chaining + branch/compaction markers; raw feed = truth.** |
| 15 | Live UX | **Live exchange list + token streaming** (fan-out from the tee). |
| 16 | Frontend | **React + Vite + Tailwind.** |
| 17 | Build order | **Walking skeleton first**, then layer up (M1→M5). |

### Assumed defaults (flag to change)
- Bind `127.0.0.1` only by default (proxy forwards live API keys — never an open relay). No viewer auth in local mode.
- Config = **YAML**, hot-reloaded on change.
- `thinking`/reasoning content captured and rendered as a distinct collapsible part.

---

## Architecture

```
[client] --base_url override--> [luwak :8080] --TLS--> [provider]
  ANTHROPIC_BASE_URL=…/anthropic          |  tee
  OPENAI_BASE_URL=…/openai/v1             ├─> client (instant)
                                          ├─> capture buffer → SQLite
                                          └─> viewer SSE (live tokens)

one binary serves: proxy · viewer SPA (embedded) · query API · SSE channel
```

### Layers
- **Proxy core** — Bun.serve, path-prefix match, tee streaming, raw capture.
- **Storage** — SQLite (`bun:sqlite`). `exchanges_raw` is sacred (zstd blobs).
- **Parser adapters** — `adapters/anthropic.ts`, `adapters/openai.ts`; map raw → canonical model.
- **Threading** — prefix-chaining over normalized messages.
- **Viewer** — React SPA, thread-centric + lenses + raw feed.

### Canonical conversation model
```ts
type Role = "system" | "user" | "assistant" | "tool";
type Part =
  | { type: "text"; text: string }
  | { type: "tool_call"; id?: string; name: string; args: unknown }
  | { type: "tool_result"; id?: string; content: unknown }
  | { type: "image"; ref: string }
  | { type: "thinking"; text: string }
  | { type: "other"; raw: unknown };
interface Message { role: Role; parts: Part[]; rawRef: { exchangeId: number; span?: [number, number] }; }
```

### Storage (target)
- `exchanges_raw` — sacred: provider, method, url, headers, **zstd** req/resp bodies, status, streaming flag, incomplete flag, ts_start/first_byte/end, chunk_timings. Configurable retention.
- `messages` / `parts` / `fts5` — normalized, stamped `parser_version`, rebuildable via `luwak reparse`.

### Provider config
```yaml
listen: 127.0.0.1:8080
providers:
  - id: anthropic
    prefix: /anthropic
    upstream: https://api.anthropic.com
    adapter: anthropic
  - id: openai
    prefix: /openai
    upstream: https://api.openai.com
    adapter: openai
  - id: groq          # config-only (OpenAI-compatible)
    prefix: /groq
    upstream: https://api.groq.com
    adapter: openai
retention_days: 30
```

---

## Build milestones — all complete (MVP)

- **M1 — capture path ✅:** Anthropic reverse proxy + tee + full raw capture → SQLite + raw feed viewer.
- **M2 — normalize ✅:** canonical content-parts model + FTS5 + `reparse`.
- **M3 — threads ✅:** prefix-chaining (content-hash keyed) + deduped delta/conversation view + branch/compaction markers.
- **M4 — lenses + OpenAI ✅:** composable viewer lenses + OpenAI adapter (covers OpenAI-compatibles, config-only).
- **M5 — live + export ✅:** SSE token streaming to viewer (transport-level tap) + redacted export (boundary).

## Open risks (revisit by M3)
- OpenAI's two tool-call encodings (`function_call` vs `tool_calls[]`) — adapter must normalize.
- Prefix-matching key: lean **normalized-content hashing per message** (tool-call id churn defeats exact-byte matching).
- Context compaction breaks naive chaining → branch markers + raw-feed fallback.

## Deferred (post-MVP)
MITM transparent mode · content-addressed message dedup · declarative mapping DSL · more adapters (Gemini/Bedrock) · auth/multi-user/hosted · full thread DAG reconciliation · latency dashboards · annotation persistence/sharing.
