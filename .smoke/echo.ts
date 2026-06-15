// Anthropic-shaped streaming upstream; returns a unique "ANSWER-<n>" per request
// so multi-turn chaining can be exercised deterministically.
let n = 0;
Bun.serve({
  port: 9999,
  async fetch(req) {
    await req.text();
    const ans = "ANSWER-" + ++n;
    const events = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${ans}"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        for (const e of events) {
          c.enqueue(enc.encode(e));
          await Bun.sleep(4);
        }
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log("anthropic-echo upstream on :9999");
