/**
 * Anthropic Messages API <-> OpenAI Chat Completions translation.
 *
 * Claude Code speaks the Anthropic Messages wire format; many providers only
 * speak OpenAI Chat Completions. These functions bridge the two directions:
 *
 *   request:  Anthropic /v1/messages body  ->  OpenAI /v1/chat/completions body
 *   response: OpenAI response (JSON or SSE) ->  Anthropic response (JSON or SSE)
 *
 * Translation is a direct wire->wire mapping (not via luwak's canonical
 * NormMessage model, which is lossy: it drops image bytes, usage, and ids).
 * All functions here are pure; I/O and capture live in proxy.ts.
 */

import { SseLineBuffer } from "../sse.ts";

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export interface ModelMap {
  /** Upstream model id used for normal requests. */
  default: string;
  /** Upstream model id for Claude Code's small/fast tier (haiku-class). */
  small?: string;
}

export type ResolveModel = (anthropicModelId: string) => string;

/**
 * Claude Code drives two model tiers: a main model and a small/fast model for
 * background tasks. The small one is always a haiku-class id, so route by name.
 */
export function makeModelResolver(models: ModelMap): ResolveModel {
  return (id) => (models.small && /haiku/i.test(id ?? "") ? models.small : models.default);
}

// ---------------------------------------------------------------------------
// Request: Anthropic -> OpenAI
// ---------------------------------------------------------------------------

interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; url?: string; data?: string };
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicBlock[];
}

export interface AnthropicRequest {
  model?: string;
  system?: unknown;
  messages?: AnthropicMessage[];
  tools?: Array<{ name?: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type?: string; name?: string };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

function systemToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "string" ? b : (b as AnthropicBlock)?.type === "text" ? ((b as AnthropicBlock).text ?? "") : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function imageUrl(source: AnthropicBlock["source"]): string {
  if (!source) return "";
  if (source.type === "url") return source.url ?? "";
  // Reconstruct the data URL OpenAI expects from Anthropic's base64 source.
  return `data:${source.media_type ?? "image/png"};base64,${source.data ?? ""}`;
}

/** Flatten an Anthropic tool_result's content (string | block[]) into text. */
function toolResultText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as AnthropicBlock)?.type === "text" ? ((b as AnthropicBlock).text ?? "") : JSON.stringify(b)))
      .join("\n");
  }
  return JSON.stringify(content);
}

function assistantParts(content: string | AnthropicBlock[]): {
  text: string;
  toolCalls: Array<{ id?: string; type: "function"; function: { name: string; arguments: string } }>;
} {
  if (typeof content === "string") return { text: content, toolCalls: [] };
  let text = "";
  const toolCalls: Array<{ id?: string; type: "function"; function: { name: string; arguments: string } }> = [];
  for (const b of content ?? []) {
    if (b.type === "text") text += b.text ?? "";
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
      });
    }
    // thinking / redacted_thinking are dropped: OpenAI has no equivalent slot.
  }
  return { text, toolCalls };
}

function appendMessage(out: Record<string, unknown>[], m: AnthropicMessage): void {
  if (m.role === "assistant") {
    const { text, toolCalls } = assistantParts(m.content);
    const msg: Record<string, unknown> = { role: "assistant", content: text || null };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    out.push(msg);
    return;
  }

  // Everything else is treated as a user turn.
  if (typeof m.content === "string") {
    out.push({ role: "user", content: m.content });
    return;
  }

  const parts: Array<Record<string, unknown>> = [];
  const toolResults: AnthropicBlock[] = [];
  for (const b of m.content ?? []) {
    if (b.type === "tool_result") toolResults.push(b);
    else if (b.type === "text") parts.push({ type: "text", text: b.text ?? "" });
    else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: imageUrl(b.source) } });
    // unknown block types are ignored
  }

  // Tool results become their own `tool` messages answering the prior
  // assistant tool_calls; emit them before any fresh user content.
  for (const tr of toolResults) {
    out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: toolResultText(tr.content) });
  }
  if (parts.length === 1 && parts[0]!.type === "text") {
    out.push({ role: "user", content: parts[0]!.text });
  } else if (parts.length) {
    out.push({ role: "user", content: parts });
  }
}

function mapToolChoice(tc: AnthropicRequest["tool_choice"]): unknown {
  switch (tc?.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return tc.name ? { type: "function", function: { name: tc.name } } : "required";
    default:
      return undefined;
  }
}

/** Translate an Anthropic Messages request into an OpenAI Chat Completions request. */
export function translateRequest(
  body: AnthropicRequest,
  resolveModel: ResolveModel,
  opts?: { maxTokensCap?: number },
): { body: Record<string, unknown>; stream: boolean } {
  const messages: Record<string, unknown>[] = [];

  const sys = systemToText(body.system);
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of body.messages ?? []) appendMessage(messages, m);

  const out: Record<string, unknown> = {
    model: resolveModel(body.model ?? ""),
    messages,
  };
  if (body.max_tokens != null) {
    out.max_tokens = opts?.maxTokensCap ? Math.min(body.max_tokens, opts.maxTokensCap) : body.max_tokens;
  }
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  const tc = mapToolChoice(body.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;

  const stream = body.stream === true;
  if (stream) {
    out.stream = true;
    // Ask the provider to include token usage in the final stream chunk so we
    // can populate the Anthropic message_delta usage.
    out.stream_options = { include_usage: true };
  }
  return { body: out, stream };
}

// ---------------------------------------------------------------------------
// Response: OpenAI -> Anthropic
// ---------------------------------------------------------------------------

let idCounter = 0;
function genId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e9;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function safeParseArgs(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn"; // includes "stop" and unknown/null
  }
}

export interface TranslateCtx {
  /** Model id to echo back to the client (the one Claude Code requested). */
  model: string;
  /** Estimated input tokens for message_start usage (real prompt count isn't known until the end). */
  inputTokens?: number;
}

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Translate a non-streaming OpenAI Chat Completion into an Anthropic message. */
export function translateResponseJson(openai: Record<string, unknown>, ctx: TranslateCtx): Record<string, unknown> {
  const choice = (openai?.choices as Array<Record<string, unknown>>)?.[0];
  const msg = (choice?.message as Record<string, unknown>) ?? {};
  const content: Record<string, unknown>[] = [];

  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (typeof reasoning === "string" && reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of (msg.tool_calls as OpenAIToolCall[]) ?? []) {
    content.push({
      type: "tool_use",
      id: tc.id ?? genId("toolu"),
      name: tc.function?.name ?? "",
      input: safeParseArgs(tc.function?.arguments),
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });

  const usage = (openai?.usage as Record<string, number>) ?? {};
  return {
    id: (openai?.id as string) ?? genId("msg"),
    type: "message",
    role: "assistant",
    model: ctx.model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason as string | undefined),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? ctx.inputTokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming response: OpenAI SSE -> Anthropic SSE
// ---------------------------------------------------------------------------

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Serialize a complete Anthropic message (e.g. from `translateResponseJson`)
 * into the Anthropic SSE event sequence. Used when the client asked for a
 * stream but the upstream answered with a single buffered (non-SSE) body.
 */
export function messageToSse(msg: Record<string, unknown>): string {
  const content = (msg.content as Array<Record<string, unknown>>) ?? [];
  const usage = (msg.usage as Record<string, number>) ?? {};

  let out = sse("message_start", {
    type: "message_start",
    message: { ...msg, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 } },
  });
  content.forEach((block, index) => {
    if (block.type === "tool_use") {
      out += sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      });
    } else if (block.type === "thinking") {
      out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: (block.thinking as string) ?? "" },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: (block.signature as string) ?? "" },
      });
    } else {
      out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: (block.text as string) ?? "" },
      });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index });
  });
  out += sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: usage.output_tokens ?? 0 },
  });
  out += sse("message_stop", { type: "message_stop" });
  return out;
}

/**
 * Stateful translator from an OpenAI Chat Completions SSE stream to the
 * Anthropic Messages SSE event sequence.
 *
 *   message_start
 *   (content_block_start / content_block_delta* / content_block_stop)+
 *   message_delta (stop_reason + output usage)
 *   message_stop
 *
 * Feed raw response text via `push()`; call `flush()` at end-of-stream. Both
 * return the Anthropic SSE text to forward to the client.
 */
export function createStreamTranslator(ctx: TranslateCtx) {
  const lines = new SseLineBuffer();
  const messageId = genId("msg");

  let started = false;
  let nextIndex = 0;
  // Current open Anthropic content block.
  let current: { index: number; kind: "text" | "tool_use" | "thinking" } | null = null;
  // OpenAI tool_calls[].index -> Anthropic block index.
  const toolSlots = new Map<number, number>();
  let finishReason: string | null = null;
  let outputTokens = 0;
  let anyBlock = false;

  function start(): string {
    if (started) return "";
    started = true;
    return sse("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: ctx.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: ctx.inputTokens ?? 0, output_tokens: 0 },
      },
    });
  }

  function closeCurrent(): string {
    if (!current) return "";
    let out = "";
    // Anthropic terminates a thinking block with a signature_delta before stop.
    if (current.kind === "thinking") {
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: current.index,
        delta: { type: "signature_delta", signature: "" },
      });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index: current.index });
    current = null;
    return out;
  }

  function openText(): string {
    if (current?.kind === "text") return "";
    let out = closeCurrent();
    const index = nextIndex++;
    current = { index, kind: "text" };
    anyBlock = true;
    out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    return out;
  }

  function openThinking(): string {
    if (current?.kind === "thinking") return "";
    let out = closeCurrent();
    const index = nextIndex++;
    current = { index, kind: "thinking" };
    anyBlock = true;
    out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
    return out;
  }

  function openTool(openaiIndex: number, id: string | undefined, name: string | undefined): string {
    let out = closeCurrent();
    const index = nextIndex++;
    toolSlots.set(openaiIndex, index);
    current = { index, kind: "tool_use" };
    anyBlock = true;
    out += sse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: id ?? genId("toolu"), name: name ?? "", input: {} },
    });
    return out;
  }

  function handleEvent(ev: Record<string, unknown>): string {
    let out = "";
    if (ev.usage) {
      const u = ev.usage as Record<string, number>;
      if (typeof u.completion_tokens === "number") outputTokens = u.completion_tokens;
    }
    const choice = (ev.choices as Array<Record<string, unknown>>)?.[0];
    if (!choice) return out;
    const delta = choice.delta as Record<string, unknown> | undefined;

    if (delta) {
      // Reasoning models (GLM, DeepSeek, …) stream their chain-of-thought as
      // reasoning_content/reasoning before the answer. Map it to an Anthropic
      // thinking block so the stream stays alive and the thinking is visible.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning.length) {
        out += openThinking();
        out += sse("content_block_delta", {
          type: "content_block_delta",
          index: current!.index,
          delta: { type: "thinking_delta", thinking: reasoning },
        });
      }
      if (typeof delta.content === "string" && delta.content.length) {
        out += openText();
        out += sse("content_block_delta", {
          type: "content_block_delta",
          index: current!.index,
          delta: { type: "text_delta", text: delta.content },
        });
      }
      for (const tc of (delta.tool_calls as Array<Record<string, unknown>>) ?? []) {
        const oi = (tc.index as number) ?? 0;
        const fn = tc.function as { name?: string; arguments?: string } | undefined;
        if (!toolSlots.has(oi)) {
          out += openTool(oi, tc.id as string | undefined, fn?.name);
        }
        const index = toolSlots.get(oi)!;
        if (fn?.arguments) {
          out += sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: fn.arguments },
          });
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason as string;
    return out;
  }

  return {
    push(text: string): string {
      let out = start();
      for (const line of lines.push(text)) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json || json === "[DONE]") continue;
        try {
          out += handleEvent(JSON.parse(json) as Record<string, unknown>);
        } catch {
          /* ignore non-JSON keepalives */
        }
      }
      return out;
    },

    flush(): string {
      let out = start();
      // Process any trailing buffered line.
      const last = lines.flush();
      if (last && last.startsWith("data:")) {
        const json = last.slice(5).trim();
        if (json && json !== "[DONE]") {
          try {
            out += handleEvent(JSON.parse(json) as Record<string, unknown>);
          } catch {
            /* ignore */
          }
        }
      }
      // Guarantee well-formed content even for an empty completion.
      if (!anyBlock) out += openText();
      out += closeCurrent();
      out += sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      out += sse("message_stop", { type: "message_stop" });
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Token counting (rough estimate for /v1/messages/count_tokens)
// ---------------------------------------------------------------------------

/** Rough token estimate (~chars/4) over system + messages for count_tokens. */
export function countTokensEstimate(body: AnthropicRequest): number {
  let chars = 0;
  const add = (v: unknown) => {
    chars += typeof v === "string" ? v.length : JSON.stringify(v ?? "").length;
  };
  if (body?.system) add(body.system);
  for (const m of body?.messages ?? []) add(m.content);
  return Math.max(1, Math.ceil(chars / 4));
}
