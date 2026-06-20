import { describe, expect, test } from "bun:test";
import {
  countTokensEstimate,
  createStreamTranslator,
  makeModelResolver,
  messageToSse,
  translateRequest,
  translateResponseJson,
} from "../src/translate/anthropic-openai.ts";

const resolve = makeModelResolver({ default: "big-model", small: "small-model" });

describe("translateRequest", () => {
  test("maps system, tools, tool_choice, and sampling params", () => {
    const { body, stream } = translateRequest(
      {
        model: "claude-opus-4",
        system: "be terse",
        max_tokens: 100,
        temperature: 0.5,
        top_p: 0.9,
        stop_sequences: ["STOP"],
        stream: false,
        tool_choice: { type: "any" },
        tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
        messages: [{ role: "user", content: "hi" }],
      },
      resolve,
    );

    expect(stream).toBe(false);
    expect(body.model).toBe("big-model");
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(["STOP"]);
    expect(body.tool_choice).toBe("required");
    expect(body.tools).toEqual([
      { type: "function", function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
    ]);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: "system", content: "be terse" });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  test("clamps max_tokens to maxTokensCap when set", () => {
    const big = translateRequest({ model: "claude-opus-4", max_tokens: 64000, messages: [{ role: "user", content: "x" }] }, resolve, { maxTokensCap: 8192 });
    expect(big.body.max_tokens).toBe(8192);
    const small = translateRequest({ model: "claude-opus-4", max_tokens: 1000, messages: [{ role: "user", content: "x" }] }, resolve, { maxTokensCap: 8192 });
    expect(small.body.max_tokens).toBe(1000);
    const none = translateRequest({ model: "claude-opus-4", max_tokens: 64000, messages: [{ role: "user", content: "x" }] }, resolve);
    expect(none.body.max_tokens).toBe(64000);
  });

  test("routes haiku-class models to the small tier and sets stream_options", () => {
    const { body, stream } = translateRequest(
      { model: "claude-3-5-haiku-20241022", stream: true, messages: [{ role: "user", content: "x" }] },
      resolve,
    );
    expect(stream).toBe(true);
    expect(body.model).toBe("small-model");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("assistant tool_use -> tool_calls; tool_result -> separate tool message; image -> data URL", () => {
    const { body } = translateRequest(
      {
        model: "claude-opus-4",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling tool" },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }],
          },
        ],
      },
      resolve,
    );
    const msgs = body.messages as Array<Record<string, unknown>>;

    // user with text + image -> structured content parts
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);

    // assistant with text + tool_use
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: "calling tool",
      tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) } }],
    });

    // tool_result -> tool message
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "sunny" });
  });
});

describe("translateResponseJson", () => {
  test("builds an Anthropic message with text + tool_use blocks", () => {
    const out = translateResponseJson(
      {
        id: "chatcmpl-1",
        choices: [
          {
            message: {
              role: "assistant",
              content: "here you go",
              tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      },
      { model: "claude-opus-4" },
    );

    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.model).toBe("claude-opus-4");
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content).toEqual([
      { type: "text", text: "here you go" },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(out.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  test("maps finish_reason length -> max_tokens and guarantees content", () => {
    const out = translateResponseJson(
      { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] },
      { model: "m" },
    );
    expect(out.stop_reason).toBe("max_tokens");
    expect(out.content).toEqual([{ type: "text", text: "" }]);
  });
});

describe("createStreamTranslator", () => {
  // Build a single OpenAI SSE body, then feed it to the translator in awkward
  // chunk boundaries to exercise the partial-line buffer.
  function openaiSse(events: unknown[]): string {
    return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  }

  function feed(body: string, chunkSize: number): string {
    const t = createStreamTranslator({ model: "claude-opus-4", inputTokens: 5 });
    let out = "";
    for (let i = 0; i < body.length; i += chunkSize) out += t.push(body.slice(i, i + chunkSize));
    out += t.flush();
    return out;
  }

  // Parse the Anthropic SSE output back into {event, data} records.
  function parse(sse: string): Array<{ event: string; data: any }> {
    const out: Array<{ event: string; data: any }> = [];
    for (const block of sse.split("\n\n")) {
      const ev = block.match(/^event: (.+)$/m)?.[1];
      const da = block.match(/^data: (.+)$/m)?.[1];
      if (ev && da) out.push({ event: ev, data: JSON.parse(da) });
    }
    return out;
  }

  const body = openaiSse([
    { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null },
      ],
    },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 9 } },
  ]);

  test("emits a well-formed Anthropic event sequence (text + tool_use)", () => {
    const events = parse(feed(body, 7)); // odd chunk size splits lines
    const types = events.map((e) => e.event);

    expect(types[0]).toBe("message_start");
    expect(types.at(-1)).toBe("message_stop");
    expect(types.at(-2)).toBe("message_delta");

    // text block 0
    const start0 = events.find((e) => e.event === "content_block_start" && e.data.index === 0)!;
    expect(start0.data.content_block.type).toBe("text");
    const text = events
      .filter((e) => e.event === "content_block_delta" && e.data.index === 0)
      .map((e) => e.data.delta.text)
      .join("");
    expect(text).toBe("Hello world");

    // tool_use block 1
    const start1 = events.find((e) => e.event === "content_block_start" && e.data.index === 1)!;
    expect(start1.data.content_block).toMatchObject({ type: "tool_use", id: "call_1", name: "get_weather" });
    const args = events
      .filter((e) => e.event === "content_block_delta" && e.data.index === 1)
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(JSON.parse(args)).toEqual({ city: "Paris" });

    // both blocks closed
    expect(events.filter((e) => e.event === "content_block_stop").map((e) => e.data.index).sort()).toEqual([0, 1]);

    // message_delta carries the mapped stop_reason and usage
    const delta = events.find((e) => e.event === "message_delta")!;
    expect(delta.data.delta.stop_reason).toBe("tool_use");
    expect(delta.data.usage.output_tokens).toBe(9);
  });

  test("produces identical output regardless of chunk boundaries", () => {
    // Normalize generated ids (unique per translator instance) before comparing.
    const norm = (s: string) => s.replace(/"(msg|toolu)_[a-z0-9]+"/g, '"$1_X"');
    expect(norm(feed(body, 1))).toBe(norm(feed(body, 1000)));
  });

  test("maps reasoning_content to a thinking block before the answer (GLM/Fireworks shape)", () => {
    const reasoningSse = openaiSse([
      { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "The user " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "said hi." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Hello!" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 8 } },
    ]);
    const events = parse(feed(reasoningSse, 13));

    // block 0 is a thinking block carrying the reasoning, closed with a signature
    const start0 = events.find((e) => e.event === "content_block_start" && e.data.index === 0)!;
    expect(start0.data.content_block.type).toBe("thinking");
    const thought = events
      .filter((e) => e.event === "content_block_delta" && e.data.index === 0 && e.data.delta.type === "thinking_delta")
      .map((e) => e.data.delta.thinking)
      .join("");
    expect(thought).toBe("The user said hi.");
    expect(events.some((e) => e.event === "content_block_delta" && e.data.index === 0 && e.data.delta.type === "signature_delta")).toBe(true);

    // block 1 is the actual text answer
    const start1 = events.find((e) => e.event === "content_block_start" && e.data.index === 1)!;
    expect(start1.data.content_block.type).toBe("text");
    const text = events
      .filter((e) => e.event === "content_block_delta" && e.data.index === 1 && e.data.delta.type === "text_delta")
      .map((e) => e.data.delta.text)
      .join("");
    expect(text).toBe("Hello!");
  });

  test("empty completion still yields a valid sequence", () => {
    const out = parse(feed(openaiSse([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]), 9));
    expect(out.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(out.find((e) => e.event === "message_delta")!.data.delta.stop_reason).toBe("end_turn");
  });
});

describe("messageToSse", () => {
  function parse(sse: string): Array<{ event: string; data: any }> {
    const out: Array<{ event: string; data: any }> = [];
    for (const block of sse.split("\n\n")) {
      const ev = block.match(/^event: (.+)$/m)?.[1];
      const da = block.match(/^data: (.+)$/m)?.[1];
      if (ev && da) out.push({ event: ev, data: JSON.parse(da) });
    }
    return out;
  }

  test("replays a buffered Anthropic message as a valid SSE sequence", () => {
    const msg = translateResponseJson(
      {
        id: "chatcmpl-2",
        choices: [
          {
            message: { role: "assistant", content: "hi", tool_calls: [{ id: "call_1", function: { name: "f", arguments: '{"a":1}' } }] },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      },
      { model: "claude-opus-4" },
    );
    const events = parse(messageToSse(msg));

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[2]!.data.delta).toEqual({ type: "text_delta", text: "hi" });
    expect(JSON.parse(events[5]!.data.delta.partial_json)).toEqual({ a: 1 });
    expect(events.at(-2)!.data.delta.stop_reason).toBe("tool_use");
    expect(events.at(-2)!.data.usage.output_tokens).toBe(3);
  });
});

describe("countTokensEstimate", () => {
  test("returns a positive estimate from system + messages", () => {
    const n = countTokensEstimate({ system: "abcd", messages: [{ role: "user", content: "efgh" }] });
    expect(n).toBeGreaterThan(0);
  });
});
