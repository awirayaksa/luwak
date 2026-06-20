/** Shared Server-Sent Events helpers. */

/**
 * Extract the parsed JSON payloads from the `data:` lines of a complete SSE
 * body. `[DONE]` sentinels and non-JSON keepalives are skipped. Used by the
 * viewer adapters (which parse fully-captured bodies) — for incremental
 * stream translation, see `splitSseLines`.
 */
export function sseData(body: string): unknown[] {
  const out: unknown[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      out.push(JSON.parse(json));
    } catch {
      /* ignore non-JSON keepalives */
    }
  }
  return out;
}

/**
 * Incremental SSE line buffer. Feed it arbitrary chunks of an SSE byte stream;
 * it returns the complete lines available so far and retains any trailing
 * partial line until the rest arrives. Call `flush()` at end-of-stream to get
 * whatever remains.
 */
export class SseLineBuffer {
  private buf = "";

  push(text: string): string[] {
    this.buf += text;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      // Strip a trailing \r so callers see clean lines regardless of CRLF/LF.
      let line = this.buf.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
      this.buf = this.buf.slice(nl + 1);
    }
    return lines;
  }

  flush(): string | null {
    if (!this.buf) return null;
    const line = this.buf.endsWith("\r") ? this.buf.slice(0, -1) : this.buf;
    this.buf = "";
    return line || null;
  }
}
