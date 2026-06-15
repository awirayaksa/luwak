// OpenAI Chat Completions streaming upstream: text + a tool_call split across deltas.
const EVENTS = [
  `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"Let me check."}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"NYC\\"}"}}]}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
  `data: [DONE]\n\n`,
];
Bun.serve({
  port: 9998,
  async fetch(req) {
    await req.text();
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        for (const e of EVENTS) { c.enqueue(enc.encode(e)); await Bun.sleep(4); }
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log("openai-echo upstream on :9998");
