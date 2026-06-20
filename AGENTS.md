# AGENTS.md

## Project Overview

Luwak is a fast, lightweight LLM proxy built with Bun + TypeScript. It captures raw request/response traffic and provides a web-based viewer. The project also includes a Tauri v2 desktop application that wraps the proxy in a native window with system tray support.

## Commands

### Proxy / Server
- `bun run start` — start the proxy server
- `bun run dev` — start in watch mode (auto-reload)
- `bun run reparse` — rebuild derived tables from raw captures
- `bun run export` — dump redacted JSONL to stdout
- `bun run build` — compile standalone proxy binary (`luwak`)

### Desktop App (Tauri)
- `bun run build:sidecar` — build the sidecar binary for current platform (auto-detects target triple)
- `cargo tauri dev` — launch desktop app in dev mode (requires `bun run dev` running separately)
- `cargo tauri build` — build desktop app installers (MSI + NSIS on Windows, DMG on macOS, .deb + AppImage on Linux)
- `bun run build:portable` — build installers + portable zip (no-install, extract and run)

### Testing
- `bun test` — run the test suite (bun:test, 15 tests)

### Type Checking
- `bun x tsc --noEmit` — TypeScript type check (requires `bun-types` installed: `bun install bun-types --dev`)

## Architecture

### Proxy Layer (`src/`)
- `src/index.ts` — main entry: Bun.serve, routing, CLI commands
- `src/config.ts` — YAML config loading and validation
- `src/db.ts` — SQLite store with zstd-compressed raw capture
- `src/proxy.ts` — HTTP proxy core: forwarding, streaming, capture
- `src/adapters/` — provider-specific parser adapters (anthropic, openai)
- `src/translate/` — Anthropic-to-OpenAI wire format translator
- `src/threading.ts` — conversation thread reconstruction
- `src/normalize.ts` — raw-to-derived normalization orchestration
- `src/live.ts` — SSE broadcast bus for live tail
- `src/redact.ts` — secret redaction for export
- `src/sse.ts` — SSE line parser and buffer

### Viewer (`public/`)
- `public/index.html` — single-file SPA viewer (480 lines, no framework)
- `public/desktop-loading.html` — loading screen shown while proxy starts

### Desktop App (`src-tauri/`)
- `src-tauri/src/main.rs` — Rust entry point
- `src-tauri/src/lib.rs` — Tauri builder, plugins, window event handling, IPC commands
- `src-tauri/src/sidecar.rs` — sidecar lifecycle: spawn, health check, navigate, restart, kill
- `src-tauri/src/tray.rs` — system tray: Show, Restart, Autostart toggle, Open Config/Data, Quit
- `src-tauri/Cargo.toml` — Rust dependencies
- `src-tauri/tauri.conf.json` — Tauri app configuration
- `src-tauri/capabilities/default.json` — Tauri v2 permission capabilities
- `src-tauri/icons/` — app icons generated from luwak-icon.svg

### CI/CD (`.github/workflows/`)
- `desktop-ci.yml` — PR checks: sidecar build + `cargo check --release`
- `build-desktop.yml` — release builds on tag push: Windows, macOS (arm64 + x64), Linux

## Config
- `luwak.yaml` — active config (gitignored)
- `luwak.yaml.example` — documented example config
- Override config path: `LUWAK_CONFIG=/path/to/config.yaml`

## Key Conventions
- Zero npm dependencies — uses only Bun built-ins (`bun:sqlite`, `Bun.zstd*`, `Bun.YAML`, `Bun.serve`)
- TypeScript strict mode, ESNext target, bundler module resolution
- `.ts` import extensions (Bun convention)
- Raw capture is sacred; derived layer is rebuildable via `reparse`
- Loopback-only bind by default (proxy forwards live API keys)
