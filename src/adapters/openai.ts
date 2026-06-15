import type { NormMessage, Part, Role } from "../model.ts";
import type { Adapter } from "./types.ts";

interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

function mapRole(role: string): Role {
  switch (role) {
    case "system":
    case "developer":
      return "system";
    case "assistant":
      return "assistant";
    case "tool":
    case "function":
      return "tool";
    default:
      return "user";
  }
}

function imageRef(url: string): string {
  return url.startsWith("data:") ? `data:(${url.length}b)` : url;
}

/** Normalize an OpenAI message's `content` (string | parts[]) into text/image parts. */
function contentParts(content: unknown): Part[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) {
    return content.map((b): Part => {
      const blk = b as Record<string, unknown>;
      if (blk.type === "text") return { type: "text", text: (blk.text as string) ?? "" };
      if (blk.type === "image_url") {
        const url = (blk.image_url as { url?: string })?.url ?? "";
        return { type: "image", ref: imageRef(url) };
      }
      return { type: "other", subtype: blk.type as string, raw: blk };
    });
  }
  return [{ type: "other", raw: content }];
}

function parseArgs(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function toolCallParts(toolCalls: ToolCall[] | undefined, legacy?: { name?: string; arguments?: string }): Part[] {
  const parts: Part[] = [];
  for (const tc of toolCalls ?? []) {
    parts.push({ type: "tool_call", id: tc.id, name: tc.function?.name ?? "", args: parseArgs(tc.function?.arguments) });
  }
  if (legacy?.name) parts.push({ type: "tool_call", name: legacy.name, args: parseArgs(legacy.arguments) });
  return parts;
}

function normalizeMessage(m: Record<string, unknown>): NormMessage {
  const role = mapRole(m.role as string);
  if (role === "tool") {
    return {
      role,
      parts: [{ type: "tool_result", id: (m.tool_call_id ?? m.name) as string | undefined, content: m.content }],
    };
  }
  const parts = [
    ...contentParts(m.content),
    ...toolCallParts(m.tool_calls as ToolCall[] | undefined, m.function_call as { name?: string; arguments?: string }),
  ];
  return { role, parts };
}

/** Extract JSON payloads from SSE `data:` lines (ignoring `[DONE]`). */
function sseData(body: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      out.push(JSON.parse(json));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Reassemble a streamed Chat Completion (choice 0) into one assistant message. */
function reassemble(body: string): NormMessage[] {
  let text = "";
  const tools: { id?: string; name?: string; args: string }[] = [];

  for (const ev of sseData(body)) {
    const choice = (ev.choices as Array<Record<string, unknown>>)?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (!delta) continue;
    if (typeof delta.content === "string") text += delta.content;
    for (const tc of (delta.tool_calls as Array<Record<string, unknown>>) ?? []) {
      const i = (tc.index as number) ?? 0;
      const slot = (tools[i] ??= { args: "" });
      if (tc.id) slot.id = tc.id as string;
      const fn = tc.function as { name?: string; arguments?: string } | undefined;
      if (fn?.name) slot.name = fn.name;
      if (fn?.arguments) slot.args += fn.arguments;
    }
  }

  const parts: Part[] = [];
  if (text) parts.push({ type: "text", text });
  for (const t of tools) if (t) parts.push({ type: "tool_call", id: t.id, name: t.name ?? "", args: parseArgs(t.args) });
  return parts.length ? [{ role: "assistant", parts }] : [];
}

export const openaiAdapter: Adapter = {
  id: "openai",

  parseRequest(body) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(body);
    } catch {
      return [];
    }
    return ((obj.messages as Record<string, unknown>[]) ?? []).map(normalizeMessage);
  },

  parseResponse(body, isStreaming) {
    if (isStreaming) return reassemble(body);
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(body);
    } catch {
      return [];
    }
    const msg = (obj.choices as Array<{ message?: Record<string, unknown> }>)?.[0]?.message;
    if (!msg) return [];
    return [normalizeMessage({ ...msg, role: msg.role ?? "assistant" })];
  },
};
