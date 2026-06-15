/**
 * Minimal SSE broadcaster for the viewer's live tail. Transport-level only:
 * it relays raw byte chunks the proxy tees, with no provider knowledge.
 */
export class LiveBus {
  private subs = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private enc = new TextEncoder();
  private counter = 0;

  /** An SSE Response a browser EventSource can consume. */
  subscribe(): Response {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const subs = this.subs;
    const enc = this.enc;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        subs.add(c);
        c.enqueue(enc.encode(": connected\n\n"));
      },
      cancel() {
        subs.delete(ctrl);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  publish(event: unknown): void {
    const bytes = this.enc.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const c of this.subs) {
      try {
        c.enqueue(bytes);
      } catch {
        this.subs.delete(c);
      }
    }
  }

  nextStreamId(): string {
    return "s" + ++this.counter;
  }
}
