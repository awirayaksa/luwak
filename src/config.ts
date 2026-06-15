import { readFileSync } from "node:fs";

export interface ProviderConfig {
  id: string;
  /** Path prefix this provider answers on, e.g. "/anthropic". */
  prefix: string;
  /** Upstream base URL, e.g. "https://api.anthropic.com". */
  upstream: string;
  /** Adapter id used by the (later) parser layer. Ignored by the M1 proxy. */
  adapter: string;
}

export interface RedactConfig {
  /** Extra header names to mask (added to the built-in secret-header list). */
  headers?: string[];
  /** Extra regex patterns to mask in bodies (added to built-in key patterns). */
  patterns?: string[];
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
}

const DEFAULTS = {
  listen: "127.0.0.1:8080",
  db: "./luwak.db",
  retention_days: 0,
} satisfies Partial<Config>;

export function loadConfig(path = "luwak.yaml"): Config {
  const raw = Bun.YAML.parse(readFileSync(path, "utf8")) as Partial<Config>;

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
  }

  // Longest prefix first so "/openai/v2" wins over "/openai".
  const providers = [...raw.providers].sort((a, b) => b.prefix.length - a.prefix.length);

  return { ...DEFAULTS, ...raw, providers };
}

export function parseListen(listen: string): { hostname: string; port: number } {
  const idx = listen.lastIndexOf(":");
  if (idx === -1) throw new Error(`luwak: invalid listen "${listen}" (want host:port)`);
  const hostname = listen.slice(0, idx);
  const port = Number(listen.slice(idx + 1));
  if (!Number.isInteger(port)) throw new Error(`luwak: invalid port in "${listen}"`);
  return { hostname, port };
}
