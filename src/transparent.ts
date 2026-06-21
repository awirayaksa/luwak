import * as net from "node:net";
import * as tls from "node:tls";

import type { ProviderConfig } from "./config.ts";
import type { Store } from "./db.ts";
import type { ProxyTap } from "./proxy.ts";
import { handleProxy } from "./proxy.ts";
import type { CertificateAuthority } from "./ca.ts";

const HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "accept-encoding",
  "keep-alive", "proxy-connection", "transfer-encoding", "upgrade",
  "proxy-authenticate", "proxy-authorization", "te", "trailers",
]);

interface TransparentOpts {
  hostname: string;
  port: number;
  providers: ProviderConfig[];
  store: Store;
  tap: ProxyTap;
  ca: CertificateAuthority;
}

/**
 * Build a hostname -> provider map from the upstream URLs.
 * When multiple providers share the same hostname, prefer non-translate
 * (passthrough) providers — transparent mode forwards the client's raw
 * request, so passthrough is usually the right choice.
 */
function buildHostMap(providers: ProviderConfig[]): Map<string, ProviderConfig> {
  const map = new Map<string, ProviderConfig>();
  for (const p of providers) {
    try {
      const u = new URL(p.upstream);
      const existing = map.get(u.hostname);
      // Prefer non-translate (passthrough) over translate when both share
      // the same hostname. Translate mode is for the reverse-proxy path
      // where the client overrides its base URL; in transparent mode the
      // client sends the upstream's native format directly.
      if (!existing || (existing.translate && !p.translate)) {
        map.set(u.hostname, p);
      }
    } catch {
      // skip invalid upstream URLs
    }
  }
  return map;
}

/**
 * Blind tunnel: forward bytes without interception for hosts that don't match
 * any configured provider. This lets the user set HTTPS_PROXY globally without
 * breaking non-LLM traffic.
 */
function blindTunnel(clientSocket: net.Socket, hostname: string, port: number): void {
  const upstream = net.connect(port, hostname, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });

  clientSocket.on("data", (d) => { if (!upstream.destroyed) upstream.write(d); });
  upstream.on("data", (d) => { if (!clientSocket.destroyed) clientSocket.write(d); });
  clientSocket.on("end", () => upstream.destroy());
  upstream.on("end", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
  upstream.on("error", () => {
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.destroy();
  });
}

/** Parse an HTTP request from a decrypted TLS stream. */
function parseHttpRequest(buf: Buffer): { method: string; path: string; headers: Record<string, string>; body: Buffer; consumed: number } | null {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerStr = buf.subarray(0, headerEnd).toString();
  const body = buf.subarray(headerEnd + 4);
  const lines = headerStr.split("\r\n");
  const [method, path] = lines[0].split(" ");
  if (!method || !path) return null;

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx > 0) {
      const key = lines[i].substring(0, idx).trim().toLowerCase();
      const val = lines[i].substring(idx + 1).trim();
      headers[key] = val;
    }
  }

  return { method, path, headers, body, consumed: headerEnd + 4 };
}

/** Check if we have the full request body (Content-Length based). */
function hasCompleteBody(headers: Record<string, string>, bodyBuf: Buffer): boolean {
  const cl = headers["content-length"];
  if (cl) return bodyBuf.length >= parseInt(cl);
  // chunked: look for 0\r\n\r\n terminator
  if (headers["transfer-encoding"]?.includes("chunked")) {
    return bodyBuf.includes("0\r\n\r\n") || bodyBuf.includes("0\n\n");
  }
  // no body expected
  return true;
}

const STATUS_TEXTS: Record<number, string> = {
  200: "OK", 201: "Created", 204: "No Content",
  301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict",
  413: "Payload Too Large", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** Write an HTTP response back through a TLS socket. */
async function writeResponse(socket: tls.TLSSocket, response: Response): Promise<void> {
  const statusText = response.statusText || STATUS_TEXTS[response.status] || "OK";
  let head = `HTTP/1.1 ${response.status} ${statusText}\r\n`;

  // Copy response headers, skipping ones we'll set ourselves.
  const skipHeaders = new Set(["connection", "transfer-encoding", "content-length", "keep-alive"]);
  response.headers.forEach((value, key) => {
    if (!skipHeaders.has(key.toLowerCase())) {
      head += `${key}: ${value}\r\n`;
    }
  });

  // Always close the connection after the response (we handle one request per
  // TLS connection in transparent mode).
  head += "connection: close\r\n";

  if (response.body) {
    // Read the full body so we can set content-length.
    const buf = new Uint8Array(await response.arrayBuffer());
    head += `content-length: ${buf.byteLength}\r\n`;
    head += "\r\n";
    if (!socket.destroyed) {
      socket.write(head);
      if (buf.byteLength > 0) socket.write(buf);
    }
  } else {
    head += "content-length: 0\r\n";
    head += "\r\n";
    if (!socket.destroyed) socket.write(head);
  }

  if (!socket.destroyed) socket.end();
}

/** Handle a decrypted TLS connection: parse HTTP, forward, capture. */
async function handleDecrypted(
  tlsSocket: tls.TLSSocket,
  hostname: string,
  provider: ProviderConfig,
  store: Store,
  tap: ProxyTap,
  logPrefix: string,
): Promise<void> {
  let buf = Buffer.alloc(0);

  return new Promise<void>((resolve) => {
    tlsSocket.on("data", (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      const parsed = parseHttpRequest(buf);
      if (!parsed) return; // need more data for headers
      if (!hasCompleteBody(parsed.headers, parsed.body)) return; // need more body

      const { method, path, headers, body } = parsed;
      console.log(`${logPrefix} ${method} ${path}`);

      // Construct a Request object for handleProxy.
      const reqHeaders = new Headers();
      for (const [k, v] of Object.entries(headers)) {
        if (!HOP_BY_HOP.has(k)) reqHeaders.set(k, v);
      }

      // Build the synthetic provider. The key issue: handleProxy constructs the
      // upstream URL as `provider.upstream + rest` where `rest` is the path
      // after stripping `prefix`. In transparent mode the client sends the FULL
      // upstream path (e.g. /zen/go/v1/chat/completions), so:
      //
      // - Non-translate providers: set upstream to just the origin (scheme + host)
      //   so that `origin + full_path` = correct upstream URL.
      // - Translate providers: handleProxyTranslate uses `upstream + chat_path`
      //   (ignoring the request path), so keep the upstream as-is.
      const upstreamUrl = new URL(provider.upstream);
      const origin = upstreamUrl.origin;

      let syntheticProvider: ProviderConfig;
      if (provider.translate) {
        // Translate mode: handleProxyTranslate ignores the request path and
        // uses upstream + chat_path. Keep upstream as-is.
        syntheticProvider = { ...provider, prefix: "" };
      } else {
        // Passthrough mode: handleProxy uses upstream + rest (full path).
        // Set upstream to just the origin to avoid double-pathing.
        syntheticProvider = { ...provider, prefix: "", upstream: origin };
      }

      const syntheticUrl = new URL(`http://${hostname}${path}`);

      const req = new Request(`http://${hostname}${path}`, {
        method,
        headers: reqHeaders,
        body: method !== "GET" && method !== "HEAD" && body.length > 0 ? body : undefined,
        // @ts-expect-error: duplex is needed by some runtimes for streaming body
        duplex: "half",
      });

      handleProxy(req, syntheticUrl, syntheticProvider, store, tap)
        .then((response) => writeResponse(tlsSocket, response))
        .catch((err) => {
          console.error(`${logPrefix} proxy error: ${String(err)}`);
          if (!tlsSocket.destroyed) {
            const errBody = `luwak transparent proxy error: ${String(err)}`;
            tlsSocket.write(
              `HTTP/1.1 502 Bad Gateway\r\n` +
              `content-type: text/plain\r\n` +
              `content-length: ${errBody.length}\r\n` +
              `connection: close\r\n\r\n` +
              errBody
            );
            tlsSocket.end();
          }
        })
        .finally(() => resolve());

      // Stop listening for more data — we only handle one request per connection.
      tlsSocket.removeAllListeners("data");
    });

    tlsSocket.on("end", () => resolve());
    tlsSocket.on("error", (err) => {
      console.error(`${logPrefix} TLS socket error: ${String(err)}`);
      resolve();
    });
  });
}

export function startTransparentProxy(opts: TransparentOpts): net.Server {
  const hostMap = buildHostMap(opts.providers);
  const log = "luwak transparent:";

  const server = net.createServer((clientSocket: net.Socket) => {
    let phase: "connect" | "relay" = "connect";
    let connectBuf = Buffer.alloc(0);
    let relayBuf: Buffer[] = [];
    let internalConn: net.Socket | null = null;

    clientSocket.on("data", (data: Buffer) => {
      if (phase === "connect") {
        connectBuf = Buffer.concat([connectBuf, data]);
        const headerEnd = connectBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const header = connectBuf.subarray(0, headerEnd).toString();
        const remaining = connectBuf.subarray(headerEnd + 4);
        const match = header.match(/^CONNECT (\S+):(\d+)/);
        if (!match) {
          clientSocket.destroy();
          return;
        }

        const hostname = match[1];
        const port = parseInt(match[2]);
        const provider = hostMap.get(hostname);

        phase = "relay";
        if (remaining.length > 0) relayBuf.push(remaining);

        if (!provider) {
          // Not a known LLM provider — blind tunnel without MITM.
          console.log(`${log} tunnel ${hostname}:${port} (no provider match)`);
          blindTunnel(clientSocket, hostname, port);
          return;
        }

        console.log(`${log} MITM ${hostname}:${port} -> provider ${provider.id}`);

        // Create internal TLS server with per-host cert.
        const cert = opts.ca.getCertForHost(hostname);
        const tlsServer = tls.createServer({
          cert: cert.cert,
          key: cert.key,
          // Force HTTP/1.1 via ALPN so HTTP/2-capable clients (many Rust/reqwest
          // and Node --http2 clients) don't try h2 framing, which our parser
          // can't handle. Without this, some clients fail the handshake or send
          // binary HTTP/2 frames that parseHttpRequest silently drops.
          ALPNProtocols: ["http/1.1"],
        });

        // TLS handshake failures (cert rejected, version mismatch, etc.) emit
        // tlsClientError — not "error". Without this handler they are invisible.
        tlsServer.on("tlsClientError", (err: Error, socket: tls.TLSSocket) => {
          console.error(`${log} [${provider.id}] TLS handshake failed for ${hostname}: ${String(err.message)}`);
          socket.destroy();
        });

        tlsServer.on("secureConnection", (tlsSocket: tls.TLSSocket) => {
          console.log(`${log} [${provider.id}] TLS handshake OK for ${hostname}`);
          handleDecrypted(
            tlsSocket, hostname, provider, opts.store, opts.tap,
            `${log} [${provider.id}]`,
          ).finally(() => {
            try { tlsServer.close(); } catch { /* */ }
          });
        });

        tlsServer.on("error", (err) => {
          console.error(`${log} TLS server error: ${String(err)}`);
          clientSocket.destroy();
        });

        tlsServer.listen(0, "127.0.0.1", () => {
          const tlsPort = tlsServer.address() as net.AddressInfo;

          internalConn = net.connect(tlsPort.port, "127.0.0.1", () => {
            console.log(`${log} [${provider.id}] internal TLS connection ready for ${hostname}`);
            for (const b of relayBuf) internalConn!.write(b);
            relayBuf = [];
          });

          // Encrypted bytes: client <-> internal TLS server
          internalConn.on("data", (d: Buffer) => {
            if (!clientSocket.destroyed) clientSocket.write(d);
          });
          internalConn.on("error", (err: Error) => {
            console.error(`${log} [${provider.id}] internal conn error for ${hostname}: ${String(err.message)}`);
            clientSocket.destroy();
            try { tlsServer.close(); } catch { /* */ }
          });
          internalConn.on("close", () => {
            console.log(`${log} [${provider.id}] internal conn closed for ${hostname}`);
            clientSocket.destroy();
            try { tlsServer.close(); } catch { /* */ }
          });

          // NOW send 200 — after internal TLS server is ready.
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        });

      } else {
        // Relay phase: forward to internal TLS server, or buffer.
        if (internalConn && !internalConn.destroyed && internalConn.writable) {
          internalConn.write(data);
        } else {
          relayBuf.push(data);
        }
      }
    });

    clientSocket.on("error", (err: Error) => {
      console.error(`${log} client socket error: ${String(err.message)}`);
    });
    clientSocket.on("close", () => {
      if (internalConn && !internalConn.destroyed) {
        console.log(`${log} client closed connection`);
        internalConn.destroy();
      }
    });
  });

  // Critical: without an error handler, an EADDRINUSE or other listen failure
  // becomes an uncaught exception that kills the entire process — including the
  // reverse proxy. This handler logs and swallows so the main proxy survives.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`${log} port ${opts.port} is already in use — transparent proxy disabled.`);
      console.error(`${log} change the listen port in luwak.yaml or stop the conflicting process.`);
    } else {
      console.error(`${log} server error: ${String(err)}`);
    }
  });

  server.listen(opts.port, opts.hostname, () => {
    const addr = server.address() as net.AddressInfo;
    console.log(`${log} CONNECT proxy on ${addr.address}:${addr.port}`);
    console.log(`${log} set HTTPS_PROXY=http://${addr.address}:${addr.port} in your client`);
    console.log(`${log} intercepting: ${[...hostMap.keys()].join(", ")}`);
  });

  return server;
}
