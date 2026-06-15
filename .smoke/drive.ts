// Drives a multi-turn conversation + a branch, then prints the reconstruction.
const base = "http://127.0.0.1:8088/test/v1/messages";
const U = (t: string) => ({ role: "user", content: t });
const A = (t: string) => ({ role: "assistant", content: t });

async function send(messages: unknown[]) {
  const r = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-test", system: "You are helpful.", messages, max_tokens: 50 }),
  });
  await r.text(); // drain so capture+normalize completes before next send
}

// Linear thread: Q1 -> A1 -> Q2 -> A2 -> Q3
await send([U("Q1")]);
await send([U("Q1"), A("ANSWER-1"), U("Q2")]);
await send([U("Q1"), A("ANSWER-1"), U("Q2"), A("ANSWER-2"), U("Q3")]);
// Branch off turn 1 (shares [system, Q1, A1], diverges with Q2-alt)
await send([U("Q1"), A("ANSWER-1"), U("Q2-alt")]);

const threads = await (await fetch("http://127.0.0.1:8088/api/threads")).json();
console.log("THREADS:", JSON.stringify(threads, null, 1));

const view = await (await fetch("http://127.0.0.1:8088/api/threads/1")).json();
console.log("\nEXCHANGE RELATIONS:", view.exchanges.map((e: any) => `#${e.id}:${e.relation}`).join("  "));
console.log("\nDEDUPED CONVERSATION:");
for (const c of view.conversation) {
  const text = c.parts.map((p: any) => p.text ?? JSON.stringify(p)).join(" ");
  console.log(`  [${c.source}] ${c.role.padEnd(9)} ${text}${c.marker ? "   ⚠ " + c.marker : ""}`);
}
