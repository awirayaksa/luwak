import { Database } from "bun:sqlite";
import {
  PARSER_VERSION,
  messageText,
  type MessageSource,
  type Part,
  type Role,
  type StoredMessage,
} from "./model.ts";

/**
 * A captured HTTP exchange. `exchanges_raw` is the sacred layer: bodies are the
 * exact bytes we forwarded, zstd-compressed at rest (decompress -> original).
 * Later milestones add derived/normalized tables alongside this one.
 */
export interface ExchangeInput {
  providerId: string;
  method: string;
  /** Full request line forwarded upstream (path + query, prefix stripped). */
  reqPath: string;
  upstreamUrl: string;
  reqHeaders: Record<string, string>;
  reqBody: Uint8Array;
  status: number;
  respHeaders: Record<string, string>;
  respBody: Uint8Array;
  isStreaming: boolean;
  /** True if the stream was cut off (client/upstream disconnect). */
  incomplete: boolean;
  tsStart: number;
  tsFirstByte: number | null;
  tsEnd: number;
  /** ms offsets from tsStart for each streamed chunk, or null for non-streaming. */
  chunkTimings: number[] | null;
}

export interface ExchangeRow {
  id: number;
  provider_id: string;
  method: string;
  req_path: string;
  upstream_url: string;
  status: number;
  is_streaming: number;
  incomplete: number;
  ts_start: number;
  ts_first_byte: number | null;
  ts_end: number;
  req_bytes: number;
  resp_bytes: number;
}

export interface SearchHit {
  message_id: number;
  exchange_id: number;
  role: string;
  source: string;
  snippet: string;
}

export class Store {
  private db: Database;
  private insertStmt;

  /**
   * Called with the new id after each raw insert. The app wires this to the
   * normalizer so the proxy itself stays provider-agnostic (dumb proxy).
   */
  onInsert?: (id: number) => void;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exchanges_raw (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id   TEXT    NOT NULL,
        method        TEXT    NOT NULL,
        req_path      TEXT    NOT NULL,
        upstream_url  TEXT    NOT NULL,
        req_headers   TEXT    NOT NULL,   -- json
        req_body      BLOB    NOT NULL,   -- zstd
        req_bytes     INTEGER NOT NULL,   -- uncompressed length
        status        INTEGER NOT NULL,
        resp_headers  TEXT    NOT NULL,   -- json
        resp_body     BLOB    NOT NULL,   -- zstd
        resp_bytes    INTEGER NOT NULL,   -- uncompressed length
        is_streaming  INTEGER NOT NULL,
        incomplete    INTEGER NOT NULL,
        ts_start      INTEGER NOT NULL,
        ts_first_byte INTEGER,
        ts_end        INTEGER NOT NULL,
        chunk_timings TEXT                -- json array or null
      );
      CREATE INDEX IF NOT EXISTS idx_exchanges_ts ON exchanges_raw (ts_start);
      CREATE INDEX IF NOT EXISTS idx_exchanges_provider ON exchanges_raw (provider_id, ts_start);
    `);

    // Derived/normalized layer: rebuildable from exchanges_raw via reparse.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        exchange_id    INTEGER NOT NULL,
        source         TEXT    NOT NULL,   -- 'request' | 'response'
        seq            INTEGER NOT NULL,
        role           TEXT    NOT NULL,
        parser_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_exchange ON messages (exchange_id, source, seq);

      CREATE TABLE IF NOT EXISTS parts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        seq        INTEGER NOT NULL,
        type       TEXT    NOT NULL,
        text       TEXT,                   -- text/thinking
        name       TEXT,                   -- tool name
        data       TEXT                    -- json: args/content/image/other
      );
      CREATE INDEX IF NOT EXISTS idx_parts_message ON parts (message_id, seq);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        role UNINDEXED, source UNINDEXED, exchange_id UNINDEXED, message_id UNINDEXED
      );

      CREATE TABLE IF NOT EXISTS thread_links (
        exchange_id INTEGER PRIMARY KEY,
        thread_id   INTEGER NOT NULL,   -- = root exchange id
        parent_id   INTEGER,
        position    INTEGER NOT NULL,
        prefix_len  INTEGER NOT NULL,   -- matched conversation-message count
        relation    TEXT    NOT NULL,   -- 'root' | 'extend' | 'branch'
        note        TEXT,               -- e.g. 'compaction/edit?'
        req_hashes  TEXT    NOT NULL,   -- json array of conv hashes (request msgs then response msgs)
        model       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_thread_links_thread ON thread_links (thread_id, position);
    `);

    this.insertStmt = this.db.query(`
      INSERT INTO exchanges_raw (
        provider_id, method, req_path, upstream_url,
        req_headers, req_body, req_bytes,
        status, resp_headers, resp_body, resp_bytes,
        is_streaming, incomplete, ts_start, ts_first_byte, ts_end, chunk_timings
      ) VALUES (
        $provider_id, $method, $req_path, $upstream_url,
        $req_headers, $req_body, $req_bytes,
        $status, $resp_headers, $resp_body, $resp_bytes,
        $is_streaming, $incomplete, $ts_start, $ts_first_byte, $ts_end, $chunk_timings
      ) RETURNING id
    `);
  }

  insert(e: ExchangeInput): number {
    const row = this.insertStmt.get({
      $provider_id: e.providerId,
      $method: e.method,
      $req_path: e.reqPath,
      $upstream_url: e.upstreamUrl,
      $req_headers: JSON.stringify(e.reqHeaders),
      $req_body: Bun.zstdCompressSync(e.reqBody),
      $req_bytes: e.reqBody.byteLength,
      $status: e.status,
      $resp_headers: JSON.stringify(e.respHeaders),
      $resp_body: Bun.zstdCompressSync(e.respBody),
      $resp_bytes: e.respBody.byteLength,
      $is_streaming: e.isStreaming ? 1 : 0,
      $incomplete: e.incomplete ? 1 : 0,
      $ts_start: e.tsStart,
      $ts_first_byte: e.tsFirstByte,
      $ts_end: e.tsEnd,
      $chunk_timings: e.chunkTimings ? JSON.stringify(e.chunkTimings) : null,
    }) as { id: number };
    this.onInsert?.(row.id);
    return row.id;
  }

  list(limit = 200): ExchangeRow[] {
    return this.db
      .query(
        `SELECT id, provider_id, method, req_path, upstream_url, status,
                is_streaming, incomplete, ts_start, ts_first_byte, ts_end,
                req_bytes, resp_bytes
         FROM exchanges_raw ORDER BY id DESC LIMIT $limit`,
      )
      .all({ $limit: limit }) as ExchangeRow[];
  }

  /** Full row with decompressed bodies decoded as UTF-8 text for the viewer. */
  get(id: number): Record<string, unknown> | null {
    const row = this.db
      .query(`SELECT * FROM exchanges_raw WHERE id = $id`)
      .get({ $id: id }) as Record<string, unknown> | null;
    if (!row) return null;

    const dec = new TextDecoder();
    return {
      ...row,
      req_headers: JSON.parse(row.req_headers as string),
      resp_headers: JSON.parse(row.resp_headers as string),
      chunk_timings: row.chunk_timings ? JSON.parse(row.chunk_timings as string) : null,
      req_body: dec.decode(Bun.zstdDecompressSync(row.req_body as Uint8Array)),
      resp_body: dec.decode(Bun.zstdDecompressSync(row.resp_body as Uint8Array)),
    };
  }

  // --- Normalized (derived) layer ---------------------------------------

  allExchangeIds(): number[] {
    return (this.db.query(`SELECT id FROM exchanges_raw ORDER BY id`).all() as { id: number }[]).map(
      (r) => r.id,
    );
  }

  /** Raw inputs the normalizer needs for one exchange (bodies decoded to text). */
  rawForNormalize(
    id: number,
  ): { providerId: string; reqBody: string; respBody: string; isStreaming: boolean; tsStart: number } | null {
    const row = this.db
      .query(`SELECT provider_id, req_body, resp_body, is_streaming, ts_start FROM exchanges_raw WHERE id = $id`)
      .get({ $id: id }) as
      | { provider_id: string; req_body: Uint8Array; resp_body: Uint8Array; is_streaming: number; ts_start: number }
      | null;
    if (!row) return null;
    const dec = new TextDecoder();
    return {
      providerId: row.provider_id,
      reqBody: dec.decode(Bun.zstdDecompressSync(row.req_body)),
      respBody: dec.decode(Bun.zstdDecompressSync(row.resp_body)),
      isStreaming: row.is_streaming === 1,
      tsStart: row.ts_start,
    };
  }

  /** Replace all normalized rows for one exchange (idempotent; used by reparse). */
  writeExchangeMessages(exchangeId: number, msgs: StoredMessage[]): void {
    const tx = this.db.transaction(() => {
      this.deleteExchangeNormalized(exchangeId);
      const insMsg = this.db.query(
        `INSERT INTO messages (exchange_id, source, seq, role, parser_version)
         VALUES ($e, $s, $seq, $role, $pv) RETURNING id`,
      );
      const insPart = this.db.query(
        `INSERT INTO parts (message_id, seq, type, text, name, data)
         VALUES ($m, $seq, $type, $text, $name, $data)`,
      );
      const insFts = this.db.query(
        `INSERT INTO messages_fts (text, role, source, exchange_id, message_id)
         VALUES ($text, $role, $source, $e, $m)`,
      );
      for (const m of msgs) {
        const { id: messageId } = insMsg.get({
          $e: exchangeId,
          $s: m.source,
          $seq: m.seq,
          $role: m.role,
          $pv: PARSER_VERSION,
        }) as { id: number };
        m.parts.forEach((p, i) => {
          insPart.run({
            $m: messageId,
            $seq: i,
            $type: p.type,
            $text: "text" in p ? p.text : null,
            $name: p.type === "tool_call" ? p.name : null,
            $data: JSON.stringify(p),
          });
        });
        insFts.run({
          $text: messageText(m),
          $role: m.role,
          $source: m.source,
          $e: exchangeId,
          $m: messageId,
        });
      }
    });
    tx();
  }

  deleteExchangeNormalized(exchangeId: number): void {
    this.db
      .query(`DELETE FROM parts WHERE message_id IN (SELECT id FROM messages WHERE exchange_id = $e)`)
      .run({ $e: exchangeId });
    this.db.query(`DELETE FROM messages_fts WHERE exchange_id = $e`).run({ $e: exchangeId });
    this.db.query(`DELETE FROM messages WHERE exchange_id = $e`).run({ $e: exchangeId });
  }

  clearAllNormalized(): void {
    this.db.exec(`DELETE FROM parts; DELETE FROM messages_fts; DELETE FROM messages; DELETE FROM thread_links;`);
  }

  getMessages(exchangeId: number): StoredMessage[] {
    const rows = this.db
      .query(
        `SELECT id, source, seq, role FROM messages WHERE exchange_id = $e ORDER BY
         CASE source WHEN 'request' THEN 0 ELSE 1 END, seq`,
      )
      .all({ $e: exchangeId }) as { id: number; source: MessageSource; seq: number; role: Role }[];
    const partStmt = this.db.query(`SELECT data FROM parts WHERE message_id = $m ORDER BY seq`);
    return rows.map((r) => ({
      exchangeId,
      source: r.source,
      seq: r.seq,
      role: r.role,
      parts: (partStmt.all({ $m: r.id }) as { data: string }[]).map((p) => JSON.parse(p.data) as Part),
    }));
  }

  search(q: string, limit = 100): SearchHit[] {
    return this.db
      .query(
        `SELECT message_id, exchange_id, role, source,
                snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snippet
         FROM messages_fts WHERE messages_fts MATCH $q ORDER BY rank LIMIT $limit`,
      )
      .all({ $q: q, $limit: limit }) as SearchHit[];
  }

  // --- Threading (derived) ----------------------------------------------

  writeThreadLink(row: ThreadLinkInput): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO thread_links
           (exchange_id, thread_id, parent_id, position, prefix_len, relation, note, req_hashes, model)
         VALUES ($e, $t, $p, $pos, $pl, $rel, $note, $rh, $model)`,
      )
      .run({
        $e: row.exchangeId,
        $t: row.threadId,
        $p: row.parentId,
        $pos: row.position,
        $pl: row.prefixLen,
        $rel: row.relation,
        $note: row.note ?? null,
        $rh: JSON.stringify(row.convHashes),
        $model: row.model ?? null,
      });
  }

  /** Candidate parents: same provider, captured before `beforeId`, within the time window. */
  threadCandidates(providerId: string, beforeId: number, sinceTs: number): ThreadCandidate[] {
    const rows = this.db
      .query(
        `SELECT tl.exchange_id, tl.thread_id, tl.position, tl.req_hashes
         FROM thread_links tl JOIN exchanges_raw e ON e.id = tl.exchange_id
         WHERE e.provider_id = $prov AND tl.exchange_id < $before AND e.ts_start >= $since`,
      )
      .all({ $prov: providerId, $before: beforeId, $since: sinceTs }) as {
      exchange_id: number;
      thread_id: number;
      position: number;
      req_hashes: string;
    }[];
    return rows.map((r) => ({
      exchangeId: r.exchange_id,
      threadId: r.thread_id,
      position: r.position,
      convHashes: JSON.parse(r.req_hashes) as string[],
    }));
  }

  /** Exchanges that are already someone's parent (to distinguish extend vs branch). */
  parentIdSet(): Set<number> {
    const rows = this.db
      .query(`SELECT DISTINCT parent_id FROM thread_links WHERE parent_id IS NOT NULL`)
      .all() as { parent_id: number }[];
    return new Set(rows.map((r) => r.parent_id));
  }

  listThreads(): ThreadSummary[] {
    return this.db
      .query(
        `SELECT tl.thread_id AS id, tl.model AS model, e.ts_start AS started_ts, e.provider_id AS provider_id,
                (SELECT COUNT(*) FROM thread_links x WHERE x.thread_id = tl.thread_id) AS exchange_count,
                (SELECT p.text FROM messages m JOIN parts p ON p.message_id = m.id
                  WHERE m.exchange_id = tl.thread_id AND m.source = 'request' AND m.role = 'user' AND p.type = 'text'
                  ORDER BY m.seq, p.seq LIMIT 1) AS title
         FROM thread_links tl JOIN exchanges_raw e ON e.id = tl.thread_id
         WHERE tl.exchange_id = tl.thread_id
         ORDER BY e.ts_start DESC`,
      )
      .all() as ThreadSummary[];
  }

  threadLinks(threadId: number): ThreadLinkRow[] {
    return this.db
      .query(
        `SELECT exchange_id, thread_id, parent_id, position, prefix_len, relation, note, model
         FROM thread_links WHERE thread_id = $t ORDER BY position, exchange_id`,
      )
      .all({ $t: threadId }) as ThreadLinkRow[];
  }
}

export interface ThreadLinkInput {
  exchangeId: number;
  threadId: number;
  parentId: number | null;
  position: number;
  prefixLen: number;
  relation: "root" | "extend" | "branch";
  note?: string | null;
  /** This exchange's conversation hashes: request messages followed by response messages. */
  convHashes: string[];
  model?: string | null;
}

export interface ThreadCandidate {
  exchangeId: number;
  threadId: number;
  position: number;
  /** Candidate's conversation hashes: its request messages followed by its response messages. */
  convHashes: string[];
}

export interface ThreadSummary {
  id: number;
  model: string | null;
  started_ts: number;
  provider_id: string;
  exchange_count: number;
  title: string | null;
}

export interface ThreadLinkRow {
  exchange_id: number;
  thread_id: number;
  parent_id: number | null;
  position: number;
  prefix_len: number;
  relation: "root" | "extend" | "branch";
  note: string | null;
  model: string | null;
}
