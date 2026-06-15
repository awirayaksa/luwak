import type { RedactConfig } from "./config.ts";

/** Header names whose values are always masked at the export boundary. */
const DEFAULT_SECRET_HEADERS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "openai-api-key",
  "anthropic-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
];

/** Body patterns masked everywhere (common API-key shapes). */
const DEFAULT_PATTERNS = ["sk-ant-[A-Za-z0-9_-]{8,}", "sk-[A-Za-z0-9_-]{8,}", "Bearer\\s+[A-Za-z0-9._-]{8,}"];

const MASK = "〈redacted〉";

export interface Redactor {
  headers(h: Record<string, string>): Record<string, string>;
  text(s: string): string;
  exchange(e: Record<string, unknown>): Record<string, unknown>;
}

export function makeRedactor(cfg?: RedactConfig): Redactor {
  const secret = new Set([...DEFAULT_SECRET_HEADERS, ...(cfg?.headers ?? [])].map((h) => h.toLowerCase()));
  const patterns = [...DEFAULT_PATTERNS, ...(cfg?.patterns ?? [])].map((p) => new RegExp(p, "g"));

  const text = (s: string): string => {
    if (typeof s !== "string") return s;
    let out = s;
    for (const re of patterns) out = out.replace(re, MASK);
    return out;
  };

  const headers = (h: Record<string, string>): Record<string, string> => {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) o[k] = secret.has(k.toLowerCase()) ? MASK : text(v);
    return o;
  };

  const exchange = (e: Record<string, unknown>): Record<string, unknown> => ({
    ...e,
    req_headers: headers((e.req_headers as Record<string, string>) ?? {}),
    resp_headers: headers((e.resp_headers as Record<string, string>) ?? {}),
    req_body: text(e.req_body as string),
    resp_body: text(e.resp_body as string),
  });

  return { headers, text, exchange };
}
