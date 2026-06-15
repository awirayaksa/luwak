// Exercises the OpenAI adapter: request with tool_calls + tool role, streamed reply.
const body = {
  model: "gpt-4o",
  stream: true,
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Weather in NYC?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "Sunny, 75F" },
    { role: "user", content: "Thanks" },
  ],
};

const r = await fetch("http://127.0.0.1:8088/oai/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
await r.text();

const msgs = await (await fetch("http://127.0.0.1:8088/api/exchanges/1/messages")).json();
console.log("NORMALIZED (OpenAI -> canonical):");
for (const m of msgs) {
  const parts = m.parts.map((p: any) => p.type + (p.text ? `:${p.text}` : p.name ? `:${p.name}(${JSON.stringify(p.args)})` : p.content !== undefined ? `:${JSON.stringify(p.content)}` : ""));
  console.log(`  [${m.source}] ${m.role.padEnd(9)} ${parts.join("  ")}`);
}
