/** Canonical, provider-agnostic conversation model. Adapters map raw -> this. */

export type Role = "system" | "user" | "assistant" | "tool";

export type Part =
  | { type: "text"; text: string }
  | { type: "tool_call"; id?: string; name: string; args: unknown }
  | { type: "tool_result"; id?: string; content: unknown; isError?: boolean }
  | { type: "image"; ref: string; mime?: string }
  | { type: "thinking"; text: string }
  | { type: "other"; subtype?: string; raw: unknown };

export interface NormMessage {
  role: Role;
  parts: Part[];
}

/** "request" = the history sent to the model; "response" = the model's reply. */
export type MessageSource = "request" | "response";

export interface StoredMessage extends NormMessage {
  exchangeId: number;
  source: MessageSource;
  seq: number;
}

/** Bump when adapter/normalization logic changes; drives `luwak reparse`. */
export const PARSER_VERSION = 1;

/** Best-effort searchable text for a message (drives FTS). */
export function messageText(m: NormMessage): string {
  const out: string[] = [];
  for (const p of m.parts) {
    switch (p.type) {
      case "text":
      case "thinking":
        out.push(p.text);
        break;
      case "tool_call":
        out.push(p.name, stringify(p.args));
        break;
      case "tool_result":
        out.push(stringify(p.content));
        break;
      case "image":
        out.push(`[image ${p.ref}]`);
        break;
      case "other":
        out.push(stringify(p.raw));
        break;
    }
  }
  return out.filter(Boolean).join("\n");
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
