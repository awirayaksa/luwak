// Validates live SSE tail + redacted export.
const events: any[] = [];
const ac = new AbortController();

const sse = (async () => {
  const r = await fetch("http://127.0.0.1:8088/api/stream", { signal: ac.signal });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("data:")) {
            const j = line.slice(5).trim();
            if (j && j[0] === "{") { try { events.push(JSON.parse(j)); } catch {} }
          }
        }
      }
    }
  } catch {}
})();

await Bun.sleep(300); // let the SSE subscriber connect

await fetch("http://127.0.0.1:8088/test/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer sk-ant-secret12345678",
    "x-api-key": "sk-secret-key-99990000",
  },
  body: JSON.stringify({
    model: "claude-test",
    system: "You are helpful. My key is sk-leak-abcdef12345678.",
    messages: [{ role: "user", content: "hi" }],
  }),
}).then((r) => r.text());

await Bun.sleep(300);
ac.abort();
await sse;

const types = events.map((e) => e.type);
const chunks = events.filter((e) => e.type === "chunk");
console.log("LIVE EVENT TYPES:", types.join(" "));
console.log("  start/chunk/end present:", types.includes("start"), chunks.length > 0, types.includes("end"));
console.log("  end carries exchangeId:", events.find((e) => e.type === "end")?.exchangeId);

const exp = await (await fetch("http://127.0.0.1:8088/api/exchanges/1/export")).json();
console.log("\nREDACTED EXPORT:");
console.log("  authorization:", exp.req_headers.authorization);
console.log("  x-api-key:    ", exp.req_headers["x-api-key"]);
console.log("  body key masked:", !exp.req_body.includes("sk-leak"));
console.log("  body:", exp.req_body);
