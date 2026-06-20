import type { NormMessage, Part, Role } from "../model.ts";
import { sseData } from "../sse.ts";
import type { Adapter } from "./types.ts";

/** A raw Anthropic content block (request or non-streaming response). */
interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; url?: string; data?: string };
  [k: string]: unknown;
}

function normalizeBlock(b: Block): Part {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text ?? "" };
    case "thinking":
      return { type: "thinking", text: b.thinking ?? "" };
    case "redacted_thinking":
      return { type: "thinking", text: "[redacted]" };
    case "tool_use":
      return { type: "tool_call", id: b.id, name: b.name ?? "", args: b.input ?? {} };
    case "tool_result":
      return {
        type: "tool_result",
        id: b.tool_use_id,
        content: b.content,
        ...(b.is_error ? { isError: true } : {}),
      };
    case "image": {
      const s = b.source ?? {};
      const ref =
        s.type === "url"
          ? (s.url ?? "url")
          : `base64:${s.media_type ?? "?"}:${(s.data ?? "").length}b`;
      return { type: "image", ref, ...(s.media_type ? { mime: s.media_type } : {}) };
    }
    default:
      return { type: "other", subtype: b.type, raw: b };
  }
}

/** Anthropic packs tool results into user messages; promote pure-tool to "tool" role. */
function resolveRole(role: Role, parts: Part[]): Role {
  if (role === "user" && parts.length > 0 && parts.every((p) => p.type === "tool_result")) {
    return "tool";
  }
  return role;
}

function normalizeContent(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.map((b) => normalizeBlock(b as Block));
  if (content == null) return [];
  return [{ type: "other", raw: content }];
}

function normalizeMessage(role: Role, content: unknown): NormMessage {
  const parts = normalizeContent(content);
  return { role: resolveRole(role, parts), parts };
}

/** Reassemble Anthropic streamed content blocks into Block[]. */
function reassemble(body: string): Block[] {
  const blocks: Block[] = [];
  const jsonAccum: Record<number, string> = {};

  for (const ev of sseData(body) as Array<Record<string, unknown>>) {
    const type = ev.type as string;
    const index = ev.index as number;
    if (type === "content_block_start") {
      blocks[index] = { ...(ev.content_block as Block) };
      if (blocks[index].type === "tool_use") jsonAccum[index] = "";
      if (blocks[index].type === "text") blocks[index].text ??= "";
      if (blocks[index].type === "thinking") blocks[index].thinking ??= "";
    } else if (type === "content_block_delta") {
      const d = ev.delta as Record<string, unknown>;
      const blk = blocks[index];
      if (!blk) continue;
      if (d.type === "text_delta") blk.text = (blk.text ?? "") + (d.text as string);
      else if (d.type === "thinking_delta") blk.thinking = (blk.thinking ?? "") + (d.thinking as string);
      else if (d.type === "input_json_delta") jsonAccum[index] += (d.partial_json as string) ?? "";
    } else if (type === "content_block_stop") {
      const blk = blocks[index];
      if (blk?.type === "tool_use") {
        try {
          blk.input = jsonAccum[index] ? JSON.parse(jsonAccum[index]!) : {};
        } catch {
          blk.input = jsonAccum[index];
        }
      }
    }
  }
  return blocks.filter(Boolean);
}

export const anthropicAdapter: Adapter = {
  id: "anthropic",

  parseRequest(body) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(body);
    } catch {
      return [];
    }
    const out: NormMessage[] = [];

    if (obj.system != null) {
      const parts =
        typeof obj.system === "string"
          ? [{ type: "text", text: obj.system } satisfies Part]
          : normalizeContent(obj.system);
      out.push({ role: "system", parts });
    }
    for (const m of (obj.messages as Array<{ role: Role; content: unknown }>) ?? []) {
      out.push(normalizeMessage(m.role, m.content));
    }
    return out;
  },

  parseResponse(body, isStreaming) {
    if (isStreaming) {
      const blocks = reassemble(body);
      if (!blocks.length) return [];
      return [{ role: "assistant", parts: blocks.map(normalizeBlock) }];
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(body);
    } catch {
      return [];
    }
    const role = (obj.role as Role) ?? "assistant";
    return [normalizeMessage(role, obj.content)];
  },
};
