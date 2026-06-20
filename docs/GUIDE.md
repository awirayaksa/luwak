# luwak — user guide

How to start the proxy, configure it for your providers, and use the viewer to
analyze captured conversations. For the architecture and design rationale see
[../DESIGN.md](../DESIGN.md).

- [1. Install](#1-install)
- [2. Quick start (3 steps)](#2-quick-start-3-steps)
- [3. Configuration](#3-configuration-luwakyaml)
- [4. Pointing clients at luwak](#4-pointing-clients-at-luwak)
- [5. Analyzing logs in the viewer](#5-analyzing-logs-in-the-viewer)
- [6. CLI commands](#6-cli-commands)
- [7. Exporting & sharing](#7-exporting--sharing)
- [8. Troubleshooting](#8-troubleshooting)

---

## 1. Install

luwak runs on [Bun](https://bun.sh) (≥ 1.3).

```sh
# install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash      # macOS/Linux
# Windows (PowerShell): irm bun.sh/install.ps1 | iex

cd luwak
```

No `bun install` is needed for runtime — luwak uses only Bun built-ins
(`bun:sqlite`, `Bun.zstd*`, `Bun.YAML`). You can optionally build a single
self-contained binary (see [§6](#6-cli-commands)).

---

## 2. Quick start (3 steps)

**1) Start the proxy:**

```sh
bun start            # reads ./luwak.yaml, listens on 127.0.0.1:8080
```

You should see:

```
luwak listening on http://127.0.0.1:8080
  viewer:  http://127.0.0.1:8080/app
  anthropic  /anthropic  ->  https://api.anthropic.com
  openai     /openai  ->  https://api.openai.com
  groq       /groq  ->  https://api.groq.com/openai
```

**2) Point your LLM client at luwak** (in the shell that runs the client):

```sh
# Claude Code / any Anthropic SDK client
export ANTHROPIC_BASE_URL=http://localhost:8080/anthropic

# OpenAI SDK clients
export OPENAI_BASE_URL=http://localhost:8080/openai/v1
```

Then use the client normally. luwak forwards every request to the real upstream
and captures it on the way through — your client behaves exactly as before
(including live token streaming).

**3) Open the viewer** at **<http://localhost:8080/app>** and watch conversations
appear in real time.

> Your API keys are passed straight through to the upstream. luwak keeps to
> `127.0.0.1` by default so it is never an open relay — don't expose it on a
> public interface without adding auth.

---

## 3. Configuration (`luwak.yaml`)

luwak reads `luwak.yaml` from the working directory. Point it elsewhere with the
`LUWAK_CONFIG` environment variable:

```sh
LUWAK_CONFIG=/path/to/my.yaml bun start
```

Full example with every option:

```yaml
# Address to bind. Loopback only by default — the proxy forwards live API keys,
# so do not bind a public interface without putting auth in front.
listen: 127.0.0.1:8080

# SQLite capture database (created if missing).
db: ./luwak.db

# Each provider is a route. The client sends to {listen}{prefix}, luwak strips
# the prefix and forwards the rest to {upstream}. `adapter` picks the parser.
providers:
  - id: anthropic              # any unique label
    prefix: /anthropic         # must start with "/"
    upstream: https://api.anthropic.com
    adapter: anthropic         # built-in adapters: anthropic | openai

  - id: openai
    prefix: /openai
    upstream: https://api.openai.com
    adapter: openai

  # OpenAI-compatible providers are CONFIG-ONLY: reuse the openai adapter.
  - id: groq
    prefix: /groq
    upstream: https://api.groq.com/openai
    adapter: openai

# Raw retention in days (0 = keep forever). NOTE: automated pruning is not yet
# implemented; this field is reserved for it.
retention_days: 30

# Redaction is applied only at the export/share boundary (never at rest).
# These ADD to the built-in secret-header list and key patterns.
redact:
  headers:                     # extra header names to mask (case-insensitive)
    - x-my-custom-token
  patterns:                    # extra regexes to mask in bodies
    - "ghp_[A-Za-z0-9]{20,}"   # e.g. GitHub tokens
```

### Field reference

| Field | Meaning |
|-------|---------|
| `listen` | `host:port` to bind. Default `127.0.0.1:8080`. |
| `db` | Path to the SQLite file. Default `./luwak.db`. |
| `providers[].id` | Unique label shown in logs/UI. |
| `providers[].prefix` | URL path prefix that selects this provider (longest match wins). |
| `providers[].upstream` | Real API base URL traffic is forwarded to. |
| `providers[].adapter` | Parser: `anthropic` or `openai`. |
| `providers[].tls_verify` | Verify the upstream TLS cert. Default `true`; set `false` only for a self-signed upstream on a trusted network. |
| `providers[].translate` | `anthropic->openai` to make this provider a translating bridge (see below). |
| `providers[].chat_path` | (translate only) upstream chat path. Default `/v1/chat/completions`. |
| `providers[].models` | (translate only) `{ default, small? }` upstream model ids. |
| `retention_days` | Reserved for raw pruning (not yet enforced). |
| `redact.headers` | Extra header names masked on export. |
| `redact.patterns` | Extra regex patterns masked in exported bodies. |

### Adding a new provider

- **OpenAI-compatible API** (Together, OpenRouter, Ollama, vLLM, local
  llama.cpp, …): just add a config entry with `adapter: openai` and the right
  `upstream`. No code.
- **A genuinely different wire format** (e.g. Gemini, Bedrock): needs a small
  adapter module under `src/adapters/`. See [DESIGN.md](../DESIGN.md).

After editing `luwak.yaml`, restart luwak (use `bun dev` for auto-restart on
file changes).

### Translating bridge: Claude Code → an OpenAI-only provider

Claude Code speaks the **Anthropic Messages API** (`POST /v1/messages`,
streaming SSE). Many providers only speak the **OpenAI Chat Completions API**
(`POST /v1/chat/completions`), so Claude Code can't talk to them directly. A
provider with `translate: anthropic->openai` makes luwak bridge the two: it
rewrites each incoming Anthropic request into an OpenAI request, forwards it,
and translates the OpenAI response — including the streaming events — back into
Anthropic format so Claude Code understands the reply.

```yaml
providers:
  - id: zen
    prefix: /zen
    upstream: https://opencode.ai/zen/go   # base URL (no /v1/chat/completions)
    adapter: openai                        # how the captured wire bytes parse
    translate: anthropic->openai
    chat_path: /v1/chat/completions        # optional; this is the default
    models:
      default: <upstream main model id>    # required
      small: <upstream small/fast model id># used for haiku-class requests
```

Then point Claude Code at it and run normally:

```sh
export ANTHROPIC_BASE_URL=http://localhost:8080/zen
# keep using your provider key as usual:
export ANTHROPIC_API_KEY=<your provider key>
```

Notes:
- **Model mapping.** Claude Code drives two tiers — a main model and a small
  fast model (always a haiku-class id) for background tasks. luwak routes any
  requested id containing `haiku` to `models.small` (if set), everything else to
  `models.default`.
- **Auth.** The key Claude Code sends as `x-api-key` is forwarded to the
  upstream as `Authorization: Bearer <key>`.
- **What's captured.** The viewer shows the **real upstream (OpenAI) exchange**
  (translated request + OpenAI response), parsed by the `openai` adapter — this
  is the wire truth. The Anthropic shape the client saw is reconstructed by the
  translation, not stored separately.
- **count_tokens.** Claude Code's `POST /v1/messages/count_tokens` has no OpenAI
  equivalent; luwak answers it locally with a rough estimate.
- This is an opt-in exception to luwak's "dumb proxy" rule (see
  [DESIGN.md](../DESIGN.md)); plain (non-`translate`) providers still forward
  bytes untouched.

---

## 4. Pointing clients at luwak

The rule: set the client's base URL to `http://localhost:8080` + the provider
`prefix`, keeping whatever path suffix the SDK expects.

| Client | Variable | Value |
|--------|----------|-------|
| Claude Code | `ANTHROPIC_BASE_URL` | `http://localhost:8080/anthropic` |
| Anthropic SDK | `ANTHROPIC_BASE_URL` | `http://localhost:8080/anthropic` |
| OpenAI SDK | `OPENAI_BASE_URL` | `http://localhost:8080/openai/v1` |
| Groq (OpenAI-compat) | `OPENAI_BASE_URL` | `http://localhost:8080/groq/v1` |
| Claude Code → OpenAI-only provider | `ANTHROPIC_BASE_URL` | `http://localhost:8080/zen` (a `translate` provider — see [§3](#3-configuration-luwakyaml)) |

API keys are unchanged — keep using your normal key env vars; luwak forwards
them upstream untouched.

To confirm capture is working, make one request, then open the viewer (or
`curl http://localhost:8080/api/exchanges`).

---

## 5. Analyzing logs in the viewer

Open **<http://localhost:8080/app>**. The viewer has three ways in, switched from
the header: **Threads**, **Feed**, and **search**.

### Threads (default) — the conversation view

The left pane lists reconstructed conversation **threads** (newest first), each
showing the first user message, model, turn count, and time. Click one to see
its **deduped conversation** on the right: luwak collapses the repeated history
that every stateless request re-sends, so you read a clean back-and-forth —
system prompt once, each user/assistant/tool turn once.

Branch points (retries, edits, context compaction) are tagged inline with a
`⚠ branch` / `⚠ compaction/edit?` marker. The Feed is always ground truth if a
reconstruction looks off.

**Lenses** (the toolbar above the conversation) stack on top of each other:

| Lens | What it does |
|------|--------------|
| `both` / `req` / `resp` | Show messages from requests, responses, or both. |
| `system` `user` `assistant` `tool` | Toggle each role on/off (e.g. assistant-only). |
| `pretty` / `raw` | Render parts nicely, or as raw JSON. |
| `highlight…` | Highlight all matches of the typed text. |
| `filter-out…` | Hide any message containing the typed text. |

Examples:
- *Read only what the model said:* set scope `resp`.
- *See just the system prompt:* turn off `user`/`assistant`/`tool`, keep `system`.
- *Audit tool usage:* keep only `assistant` + `tool`.
- *Find where a string appears:* type it in `highlight…`.
- *Hide noisy boilerplate:* type a phrase in `filter-out…`.

### Feed — raw exchange inspection

The left pane lists individual HTTP exchanges (method, status, provider, size,
streaming/partial tags, TTFB). Click one to inspect it with three tabs:

- **Parsed** — the canonical messages for that single exchange.
- **Request** / **Response** — raw headers + body, with a `pretty`/`raw` toggle.

Each exchange also has an **export ⤓** button (redacted — see [§7](#7-exporting--sharing)).

### Search — full-text across everything

Type in the header search box and press Enter (or click **search**). luwak runs
an FTS5 query over all normalized message text and returns ranked hits with
highlighted snippets, labeled by role/source/exchange. Click a hit to jump to
that exchange in the Feed.

### Live tail

While a request is in flight, a **live panel** appears bottom-right and streams
the model's output token-by-token (works for both Anthropic and OpenAI). When
the response completes, the thread/feed refreshes so the finished, parsed
exchange shows up. (The persisted/parsed view is always exact; the live panel is
best-effort.)

---

## 6. CLI commands

```sh
bun start            # run the proxy + viewer (reads luwak.yaml)
bun dev              # same, auto-restart on file changes
bun reparse          # rebuild the normalized/threaded layer from sacred raw
bun export           # print every exchange as redacted JSONL to stdout
bun run build        # compile a single self-contained binary -> ./luwak
```

- **`reparse`** is safe to run any time — raw bytes are never modified, only the
  derived `messages`/`parts`/`fts`/`thread_links` tables are rebuilt. Run it
  after upgrading luwak (parser improvements) to re-interpret old captures.
- The compiled binary embeds the viewer, so `./luwak` is fully self-contained.

Override the config for any command with `LUWAK_CONFIG=path`.

---

## 7. Exporting & sharing

Raw data is stored **verbatim** (API keys included) on your machine. Redaction
is applied only when you export, so secrets don't leak into shared files:

```sh
# whole capture as redacted JSONL
bun export > capture.jsonl
```

Or per-exchange from the viewer (Feed → **export ⤓**) / API:

```sh
curl http://localhost:8080/api/exchanges/42/export
```

What gets masked: built-in secret headers (`authorization`, `x-api-key`,
`cookie`, …) and common key shapes in bodies (`sk-…`, `sk-ant-…`, `Bearer …`),
plus anything you add under `redact:` in the config.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Client errors with connection refused | luwak isn't running, or the base URL port/prefix is wrong. Check the startup banner. |
| `no route for /…` (404) | The request path doesn't match any provider `prefix`. Verify the client base URL includes the prefix (e.g. `…/anthropic`). |
| Requests work but nothing in the viewer | You set the base URL in a different shell than the client. Set it in the client's environment. |
| Auth/401 from upstream | Your API key wasn't sent. luwak forwards keys as-is; confirm the client still has its key env var set. For a `translate` provider, the `x-api-key` is sent upstream as `Authorization: Bearer` — make sure it's your *provider's* key. |
| `translate` provider: 400/model errors | The upstream rejected the mapped model. Check `models.default`/`models.small` are valid ids for that provider. |
| Streaming feels delayed | It shouldn't — luwak tees chunks through instantly. If it lags, you may be behind another buffering proxy. |
| Conversation threading looks wrong | Context compaction/edits can break prefix chaining; check the `⚠` markers and fall back to the **Feed** (ground truth). Try `bun reparse`. |
| DB getting large | Bodies are zstd-compressed already. Delete `luwak.db*` to reset, or archive it. (Automated retention pruning is planned.) |
| Want to inspect the DB directly | It's plain SQLite: `sqlite3 luwak.db` — `exchanges_raw` is the sacred layer. |
