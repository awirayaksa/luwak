import { readFileSync } from "node:fs";

export interface ProviderConfig {
  id: string;
  /** Path prefix this provider answers on, e.g. "/anthropic". */
  prefix: string;
  /** Upstream base URL, e.g. "https://api.anthropic.com". */
  upstream: string;
  /** Adapter id used by the (later) parser layer. Ignored by the M1 proxy. */
  adapter: string;
  /**
   * Verify the upstream's TLS certificate. Defaults to true. Set to false for
   * upstreams behind a self-signed cert (e.g. an OpenAI-compatible server on
   * the local network). Off by default would be an open invitation to MITM, so
   * this must be opted out of per provider.
   */
  tls_verify?: boolean;
  /**
   * Opt-in translating mode. When set, luwak rewrites incoming Anthropic
   * Messages API requests into OpenAI Chat Completions requests (and the
   * responses back), so an Anthropic client like Claude Code can talk to an
   * OpenAI-only upstream. Without it the provider stays a dumb passthrough.
   */
  translate?: "anthropic->openai";
  /** Upstream chat path appended to `upstream` in translate mode. */
  chat_path?: string;
  /** Model-id mapping used in translate mode. `default` is required. */
  models?: ModelMap;
  /**
   * Clamp the request's `max_tokens` to at most this value (translate mode).
   * Claude Code asks for very large limits (e.g. 64000); some upstream models
   * stall or misbehave with limits beyond their real output cap. Unset = pass
   * the client's value through unchanged.
   */
  max_output_tokens?: number;
}

export interface ModelMap {
  /** Upstream model id used for normal requests. */
  default: string;
  /** Upstream model id for Claude Code's small/fast (haiku-class) tier. */
  small?: string;
}

export interface RedactConfig {
  /** Extra header names to mask (added to the built-in secret-header list). */
  headers?: string[];
  /** Extra regex patterns to mask in bodies (added to built-in key patterns). */
  patterns?: string[];
}

export interface TransparentConfig {
  /** Enable the transparent MITM CONNECT proxy. */
  enabled: boolean;
  /** "host:port" the transparent proxy binds to. Default 127.0.0.1:8081. */
  listen: string;
  /** Path to the CA certificate (auto-generated if missing). */
  ca_cert: string;
  /** Path to the CA private key (auto-generated if missing). */
  ca_key: string;
}

export interface Config {
  /** "host:port" the server binds to. Loopback by default. */
  listen: string;
  /** Path to the SQLite capture database. */
  db: string;
  providers: ProviderConfig[];
  /** Raw retention in days; 0 = forever. */
  retention_days: number;
  /** Redaction applied at the export/share boundary. */
  redact?: RedactConfig;
  /** Transparent MITM proxy config (optional). */
  transparent?: TransparentConfig;
}

const DEFAULTS = {
  listen: "127.0.0.1:8080",
  db: "./luwak.db",
  retention_days: 0,
} satisfies Partial<Config>;

export function loadConfig(path = "luwak.yaml"): Config {
  let raw: Partial<Config>;
  try {
    raw = Bun.YAML.parse(readFileSync(path, "utf8")) as Partial<Config>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `luwak: failed to parse config file ${path}\n` +
      `  ${msg}\n` +
      `  Common causes:\n` +
      `    - Inconsistent indentation (YAML requires 2-space steps, no tabs)\n` +
      `    - Uncommented section with wrong indentation\n` +
      `    - Missing colon after a key`
    );
  }

  if (!raw.providers?.length) {
    throw new Error(`luwak: no providers defined in ${path}`);
  }
  for (const p of raw.providers) {
    if (!p.id || !p.prefix || !p.upstream) {
      throw new Error(`luwak: provider entry missing id/prefix/upstream: ${JSON.stringify(p)}`);
    }
    if (!p.prefix.startsWith("/")) {
      throw new Error(`luwak: provider "${p.id}" prefix must start with "/" (got "${p.prefix}")`);
    }
    if (p.translate !== undefined) {
      if (p.translate !== "anthropic->openai") {
        throw new Error(`luwak: provider "${p.id}" translate must be "anthropic->openai" (got "${p.translate}")`);
      }
      if (!p.models?.default) {
        throw new Error(`luwak: translate provider "${p.id}" requires models.default`);
      }
      // Catch common mistake: copying the example config without replacing
      // the placeholder model IDs.
      for (const [key, val] of Object.entries(p.models)) {
        if (val.includes("<") && val.includes(">")) {
          throw new Error(
            `luwak: provider "${p.id}" has a placeholder model for models.${key}: "${val}".\n` +
            `  Replace it with a real model ID from your upstream provider.\n` +
            `  Example: models: { default: "glm-5.2", small: "glm-5.2" }`
          );
        }
      }
    }
  }

  // Longest prefix first so "/openai/v2" wins over "/openai".
  // Default tls_verify to true: skipping cert checks is opt-in per provider.
  // Default the chat path for translate providers.
  const providers = [...raw.providers]
    .map((p) => ({
      ...p,
      tls_verify: p.tls_verify ?? true,
      ...(p.translate ? { chat_path: p.chat_path ?? "/v1/chat/completions" } : {}),
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  // Transparent proxy: validate if enabled, set defaults.
  let transparent: TransparentConfig | undefined;
  if (raw.transparent) {
    const t = raw.transparent;
    if (t.enabled) {
      transparent = {
        enabled: true,
        listen: t.listen ?? "127.0.0.1:8081",
        ca_cert: t.ca_cert ?? "./luwak-ca.crt",
        ca_key: t.ca_key ?? "./luwak-ca.key",
      };
    }
  }

  return { ...DEFAULTS, ...raw, providers, transparent };
}

export function parseListen(listen: string): { hostname: string; port: number } {
  const idx = listen.lastIndexOf(":");
  if (idx === -1) throw new Error(`luwak: invalid listen "${listen}" (want host:port)`);
  const hostname = listen.slice(0, idx);
  const port = Number(listen.slice(idx + 1));
  if (!Number.isInteger(port)) throw new Error(`luwak: invalid port in "${listen}"`);
  return { hostname, port };
}
