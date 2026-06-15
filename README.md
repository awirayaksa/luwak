# luwak

A fast, light LLM proxy that captures raw request/response traffic from LLM
clients (coding agents, chatbots), with a viewer for analyzing the captured
conversations.

📖 **[User guide → docs/GUIDE.md](./docs/GUIDE.md)** — start, configure, and
analyze logs step by step. · 🏗 **[Architecture → DESIGN.md](./DESIGN.md)**.

> **Status: M5 — MVP complete.** Anthropic + OpenAI adapters (OpenAI-compatible
> providers are config-only), reverse proxy + tee streaming + full raw capture
> (zstd) into SQLite, normalized canonical conversation model, FTS5 search,
> `reparse`, conversation threading with a deduped conversation view + composable
> lenses, **live token streaming** to the viewer, and **redacted export**.

## Normalization & search

Each captured exchange is parsed by a provider adapter into a canonical
content-parts model (`role` + ordered `text|tool_call|tool_result|image|thinking`
parts) and materialized into derived tables (`messages`, `parts`, `messages_fts`)
stamped with a `parser_version`. The proxy stays provider-agnostic; normalization
runs off an insert hook.

```sh
bun reparse        # rebuild the derived layer from sacred raw after a parser change
```

API: `GET /api/exchanges/:id/messages` (canonical model) · `GET /api/search?q=…` (FTS).

## Threading & the delta view

LLM APIs are stateless — every request resends the whole history. luwak chains
exchanges into a **thread** by matching each request's leading messages (hashed,
volatile ids stripped) against earlier requests: full prefix → `extend`, shared
head then divergence → `branch` (marked `compaction/edit?`), no match → new
thread root. The conversation is then reconstructed by walking the chain and
emitting each message only once, so repeated history and echoed assistant turns
collapse into a single flowing thread. The raw feed remains ground truth.

API: `GET /api/threads` (summaries) · `GET /api/threads/:id` (deduped conversation + relations).

## Live tail & export

The proxy tees each streamed chunk to a viewer SSE channel (`GET /api/stream`),
so exchanges appear and stream **token-by-token** live (watch the agent think).
The tap is transport-level only — the proxy never interprets the bytes.

Captured data is stored verbatim; secrets are masked only at the **export
boundary** (built-in secret headers + key patterns, extendable via `redact:` in
config):

```sh
bun export > capture.jsonl        # redacted JSONL of every exchange
```

API: `GET /api/exchanges/:id/export` (redacted exchange) · `GET /api/stream` (live SSE).

## Run

```sh
bun run src/index.ts        # or: bun start
bun dev                     # watch mode
```

luwak reads `luwak.yaml` (override with `LUWAK_CONFIG=path`). By default it binds
`127.0.0.1:8080` and proxies Anthropic.

## Point a client at it

```sh
# Claude Code (and any Anthropic SDK client)
export ANTHROPIC_BASE_URL=http://localhost:8080/anthropic
# OpenAI SDK clients
export OPENAI_BASE_URL=http://localhost:8080/openai/v1
```

Traffic flows through luwak to the upstream, captured verbatim on the way.
OpenAI-compatible providers (groq, together, openrouter, ollama, …) just need a
config entry with `adapter: openai`.

## Inspect

Open the viewer at <http://localhost:8080/app>. Click any exchange to see its
raw request/response, headers, timing (TTFB, chunk count), and a pretty/raw
toggle.

## Build a single binary

```sh
bun run build               # -> ./luwak (self-contained, viewer embedded)
```

## Notes

- The proxy forwards **live API keys** upstream — keep it bound to loopback.
- Captured bodies are stored verbatim, zstd-compressed (`exchanges_raw` is the
  sacred layer). Secrets are redacted only at the export boundary.
- Add an OpenAI-compatible provider (Groq, Together, OpenRouter, Ollama, …) by
  appending a config entry with `adapter: openai` — no code needed.

See the [user guide](./docs/GUIDE.md) for full configuration, the viewer's
analysis features (threads, lenses, search, live tail), and troubleshooting.
