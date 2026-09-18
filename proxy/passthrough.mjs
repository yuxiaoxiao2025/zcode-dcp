// SPDX-License-Identifier: AGPL-3.0-or-later
//
// passthrough.mjs — H1 byte-faithful upstream passthrough for zcode-dcp.
//
// Adapted for ZCode from opencode-dcp v3.1.15. There is no direct upstream
// equivalent — DCP forwards requests through a fetch-style call inside
// `lib/hooks.ts` (which the project adapts at the pipeline boundary in
// pipeline.mjs). This module is the ZCode-native adaptation: a thin wrapper
// around node:http.request that:
//
//   1. Carries every request header verbatim from the inbound request,
//      rewriting only:
//        * `host`             — point at the upstream origin
//        * `authorization`    — replace with the configured upstream key
//        * `x-api-key`        — replace with the configured upstream key
//      All other headers pass through (including `anthropic-version`,
//      `accept-encoding`, `x-zcode-*` telemetry, `x-client-*`, etc.).
//   2. Forwards the request body as the raw Buffer the daemon received — no
//      re-serialisation, no JSON round-trip. This is the structural lock
//      behind F-N-4 byte-faithful passthrough.
//   3. On the response side, sets the status code + every non-hop-by-hop
//      response header verbatim, then `write()`s each chunk as it arrives
//      from upstream. Concurrently a tiny cross-chunk line buffer scans the
//      byte stream for SSE `data:` lines and feeds any `usage` payload to
//      a caller-supplied `onTapLine` callback (consumed by daemon.mjs to
//      feed per-fp statistics and the nudge threshold).
//
// H1 fidelity rules (DESIGN.md D5):
//   * Only `host`, `authorization`, `x-api-key` are rewritten on the
//     REQUEST side.
//   * Hop-by-hop response headers (`connection`, `keep-alive`,
//     `transfer-encoding`, `upgrade`, `proxy-connection`) are stripped per
//     RFC 7230 §6.1. Everything else is passed through.
//   * The response body is NEVER mutated. `parseUsageFromSseLine` parses
//     a transient copy of each `data:` line for stats purposes only; the
//     bytes written to the client are the upstream bytes verbatim.

import http from "node:http"
import https from "node:https"
import { parseUsageFromSseLine } from "./tokens.mjs"

// ---------------------------------------------------------------------------
// Request-side header policy (white-list of rewrites; everything else copies)
// ---------------------------------------------------------------------------

/**
 * Headers we explicitly DO NOT copy from the inbound request. RFC 7230 §6.1
 * hop-by-hop headers MUST be rebuilt by the proxy (or stripped) on every hop,
 * otherwise the upstream can see stale client transport state.
 *
 * `content-length` is added here too — it MUST be recomputed by Node from
 * the actual bytes written to the upstream socket (see forwardRequest: the
 * body buffer is the post-pipeline replacement, which can grow or shrink
 * compared to the inbound body). Carrying the inbound content-length
 * forward silently corrupts the upstream framing: a too-large header
 * truncates the body, a too-small header causes the upstream to wait for
 * bytes that never arrive.
 */
const REQUEST_HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
])

/**
 * Build the upstream request options object from an inbound URL + headers.
 *
 * Strategy (H1 white-list):
 *   1. Parse `upstreamUrl` to discover host, port, path, method (default
 *      POST — Anthropic `/v1/messages` is always POST in practice).
 *   2. Copy EVERY header from `inboundHeaders` EXCEPT the hop-by-hop set
 *      above AND the host (host is overwritten by the upstream URL).
 *   3. Replace `authorization` and `x-api-key` with the real upstream key.
 *
 * @param {string} upstreamUrl   e.g. "https://api.anthropic.com"
 * @param {object} inboundHeaders Caller's req.headers (lowercased keys per Node)
 * @param {string} realApiKey    The configured upstream key
 * @returns {{hostname:string, port:number, path:string, method:string, headers:object, protocol:string}}
 */
export function buildUpstreamRequestOptions(upstreamUrl, inboundHeaders, realApiKey) {
  let parsed
  try {
    parsed = new URL(upstreamUrl)
  } catch (err) {
    throw new TypeError("buildUpstreamRequestOptions: bad upstreamUrl " + upstreamUrl)
  }
  const isHttps = parsed.protocol === "https:"
  const port = parsed.port
    ? Number(parsed.port)
    : isHttps
      ? 443
      : 80
  // We always POST to /v1/messages upstream; the caller can override via
  // `inboundHeaders["x-dcp-method"]` for completeness, but in practice the
  // daemon only calls this for /v1/messages.
  const path = (parsed.pathname || "/") + (parsed.search || "")
  const headers = {}
  for (const [k, v] of Object.entries(inboundHeaders || {})) {
    if (k == null) continue
    const lower = String(k).toLowerCase()
    if (REQUEST_HOP_BY_HOP.has(lower)) continue
    if (lower === "host") continue
    headers[lower] = v
  }
  // Replace auth headers with the real upstream key (Anthropic accepts both
  // `authorization: Bearer <key>` and `x-api-key: <key>`; the brief says we
  // rewrite BOTH so the upstream never sees the client-side placeholder).
  if (realApiKey) {
    headers["authorization"] = "Bearer " + realApiKey
    headers["x-api-key"] = realApiKey
  }
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port,
    path,
    headers,
  }
}

/**
 * Open a node:http.request (or https.request) to upstream. Returns the raw
 * ClientRequest. The caller is responsible for writing the body and
 * handling the response — this helper exists so the policy is testable
 * in isolation.
 *
 * H1-C1 lock: we set `agent: false` to use Connection: close. The caller
 * MUST also set `req.setHeader("content-length", String(body.length))`
 * (and call req.write/end) so the upstream sees a self-consistent
 * (Content-Length, body) pair — Node will NOT auto-compute it on a manual
 * write()+end() without an Agent. Combined with stripping inbound
 * `content-length` (see REQUEST_HOP_BY_HOP), this guarantees the upstream
 * always sees the post-pipeline body length, never the stale inbound one.
 *
 * @param {string} upstreamUrl
 * @param {object} inboundHeaders
 * @param {string} realApiKey
 * @returns {http.ClientRequest}
 */
export function forwardRequest(upstreamUrl, inboundHeaders, realApiKey) {
  const opts = buildUpstreamRequestOptions(upstreamUrl, inboundHeaders, realApiKey)
  const lib = opts.protocol === "https:" ? https : http
  const reqOpts = {
    hostname: opts.hostname,
    port: opts.port,
    path: opts.path,
    method: "POST",
    headers: opts.headers,
    agent: false,
  }
  return lib.request(reqOpts)
}

/**
 * Convenience: write the body buffer to the upstream request and end it.
 * Sets Content-Length from the actual buffer size (H1-C1) so the upstream
 * receives a framing that's consistent with the post-pipeline body even
 * when the pipeline grew or shrank the messages array.
 */
export function writeBodyAndEnd(upstreamReq, bodyBuffer) {
  if (!Buffer.isBuffer(bodyBuffer)) {
    throw new TypeError("writeBodyAndEnd: bodyBuffer must be a Buffer")
  }
  try {
    upstreamReq.setHeader("content-length", String(bodyBuffer.length))
  } catch {
    /* ignore — agent may have already sent headers */
  }
  upstreamReq.write(bodyBuffer)
  upstreamReq.end()
}

// ---------------------------------------------------------------------------
// Response-side: hop-by-hop stripping + tee line scanner
// ---------------------------------------------------------------------------

/**
 * Headers we MUST strip from upstream responses (RFC 7230 §6.1 hop-by-hop).
 * Everything else is forwarded verbatim — H1.
 */
const RESPONSE_HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
])

/**
 * Build a forwardable header list from upstream response `rawHeaders`
 * (Array<string> — alternating name, value, name, value, ...). Strips
 * hop-by-hop headers (compared by lowercased name). Groups multi-value
 * headers (same lowercased name appearing more than once — e.g. multiple
 * Set-Cookie headers from the upstream) into a SINGLE entry whose value
 * is an array; the caller passes that array to one `setHeader()` call so
 * Node emits every value on the wire (rather than dropping all but the
 * last, which is what naive `setHeader` repeats do). Preserves the case
 * of the FIRST occurrence of each name (HTTP/1.1 header names are case-
 * insensitive per RFC 7230 §3.2 — so the upstream's case choice is
 * preserved verbatim downstream, restoring byte-faithful H1 fidelity).
 *
 * Returns `Array<[rawName: string, valueOrArray: string | string[]]>` in
 * the order the upstream sent them (stable across multiple rawHeaders
 * with the same lowercased name — we keep FIRST-occurrence case and emit
 * ALL values in source order).
 *
 * @param {string[]|undefined} rawHeaders  upstreamRes.rawHeaders
 * @returns {Array<[string, string|string[]]>}
 */
function pickForwardableHeadersFromRawHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0) return []
  // Walk the name/value alternating array. Group by lowercased name so
  // multi-value headers collapse to a single entry. The first occurrence's
  // original case is what we emit downstream.
  const groupOrder = []               // ordered list of lowercased keys (first-seen wins case)
  const groupMap = new Map()          // lowercasedName -> { rawName, values: [] }
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const rawName = rawHeaders[i]
    const value = rawHeaders[i + 1]
    if (rawName == null || value == null) continue
    const lower = String(rawName).toLowerCase()
    if (RESPONSE_HOP_BY_HOP.has(lower)) continue
    let entry = groupMap.get(lower)
    if (!entry) {
      entry = { rawName: String(rawName), values: [] }
      groupMap.set(lower, entry)
      groupOrder.push(lower)
    }
    entry.values.push(String(value))
  }
  const out = []
  for (const lower of groupOrder) {
    const entry = groupMap.get(lower)
    if (entry.values.length === 1) {
      out.push([entry.rawName, entry.values[0]])
    } else {
      out.push([entry.rawName, entry.values])
    }
  }
  return out
}

/**
 * Create a SSE-line tee scanner. Buffer incomplete trailing bytes across
 * chunks; flush complete lines (terminated by `\n` or `\r\n`) to the
 * `onLine` callback. Each line is forwarded raw — the callback is free to
 * pass it through `parseUsageFromSseLine` for usage extraction.
 *
 * Returns an object with `write(chunk)` and `end()` methods. `end()` flushes
 * any trailing partial line as if it were a complete line (defensive — SSE
 * streams may end without a trailing newline).
 */
function createLineTee(onLine) {
  let buf = ""
  function flushLine(line) {
    if (!line || line.length === 0) return
    onLine(line)
  }
  return {
    write(chunk) {
      if (chunk == null) return
      const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      buf += s
      // Split on \n; preserve the tail in `buf` if no trailing newline.
      let idx
      while ((idx = buf.indexOf("\n")) >= 0) {
        // Strip an optional \r at the end (CRLF).
        let line = buf.slice(0, idx)
        if (line.endsWith("\r")) line = line.slice(0, -1)
        flushLine(line)
        buf = buf.slice(idx + 1)
      }
    },
    end() {
      if (buf.length > 0) {
        let line = buf
        if (line.endsWith("\r")) line = line.slice(0, -1)
        flushLine(line)
        buf = ""
      }
    },
  }
}

/**
 * Pipe the response from `upstreamReq` (a Node ClientRequest, returned by
 * `forwardRequest`) into `clientRes` (a ServerResponse). The status code +
 * headers are copied (hop-by-hop stripped); the body is forwarded as raw
 * bytes. A teeing line scanner extracts usage from `data:` SSE lines and
 * calls `onTapLine(usage)`.
 *
 * IMPORTANT: this function listens for the `response` event on the
 * ClientRequest. Callers must call `pipeResponse(req, res, cb)` BEFORE
 * `req.write(...)`/`req.end()` so the listener is attached in time — if
 * the upstream responds before pipeResponse runs, we drop the response.
 *
 * Race protection (C-1): a Node ClientRequest can in theory emit BOTH
 * `error` and `response` if the upstream socket closes mid-handshake. The
 * `settled` closure flag ensures we deliver the response (or the error)
 * exactly once — whichever fires second wins. The losing branch is
 * ignored, the upstream request is destroyed, and the local client sees
 * exactly one complete response (or one 502).
 *
 * Headers-sent guard: setHeader() can throw ERR_HTTP_HEADERS_SENT if a
 * concurrent caller already started writing the body. We catch that and
 * log a warning rather than crashing the daemon.
 *
 * Behaviour-faithful to D5: bytes are NEVER mutated. The tee is a passive
 * observer — it parses only a transient copy of each line.
 *
 * @param {http.ClientRequest} upstreamReq  Returned by `forwardRequest`
 * @param {http.ServerResponse} clientRes   The local client response
 * @param {(usage: object|null) => void} [onTapLine]  Optional usage tee
 */
export function pipeResponse(upstreamReq, clientRes, onTapLine) {
  // Tee scanner: wraps `onTapLine` with usage extraction via tokens.mjs.
  const tee = onTapLine
    ? createLineTee((line) => {
        try {
          const usage = parseUsageFromSseLine(line)
          if (usage) onTapLine(usage)
        } catch {
          /* never let a parse error break the byte pipe */
        }
      })
    : null

  // C-1: single-fire race gate. Once any branch (response | error) wins,
  // the other branch becomes a no-op and tears down the upstream.
  let settled = false
  function markSettled(winner) {
    if (settled) return false
    settled = true
    return true
  }
  function destroyUpstream() {
    try { upstreamReq.destroy() } catch { /* ignore */ }
  }

  upstreamReq.on("response", (upstreamRes) => {
    if (!markSettled("response")) {
      // Lost the race against `error` — drop this response and destroy the
      // upstream socket so we don't leak a connection.
      try { upstreamRes.destroy() } catch { /* ignore */ }
      destroyUpstream()
      return
    }
    // 1. Status code — default 200 if upstream didn't set one.
    const status = typeof upstreamRes.statusCode === "number" ? upstreamRes.statusCode : 200
    clientRes.statusCode = status

    // 2. Headers — copy everything except hop-by-hop. R7/D4: iterate
    // rawHeaders (alternating [name, value] array, preserving case and
    // multi-value ordering) instead of upstreamRes.headers (Node already
    // lowercased the keys AND collapsed repeated names). Multi-value
    // headers are aggregated to a single array-valued setHeader() call
    // so Node emits every value on the wire rather than dropping all but
    // the last (which is what naive repeated setHeader(name, v) does).
    const fwdHeaders = pickForwardableHeadersFromRawHeaders(upstreamRes.rawHeaders)
    for (const [k, v] of fwdHeaders) {
      try {
        clientRes.setHeader(k, v)
      } catch (err) {
        // ERR_HTTP_HEADERS_SENT happens when a concurrent caller already
        // flushed headers — log so operators see the race, then continue.
        if (err && err.code === "ERR_HTTP_HEADERS_SENT") {
          // eslint-disable-next-line no-console
          console.warn("[pipeResponse] setHeader race on", k, "— already flushed")
        }
        /* ignore other invalid-header errors defensively */
      }
    }

    upstreamRes.on("data", (chunk) => {
      if (clientRes.writableEnded || clientRes.destroyed) return
      clientRes.write(chunk)
      if (tee) tee.write(chunk)
    })
    upstreamRes.on("end", () => {
      if (tee) tee.end()
      if (!clientRes.writableEnded && !clientRes.destroyed) clientRes.end()
    })
    upstreamRes.on("error", (err) => {
      if (tee) tee.end()
      if (!clientRes.writableEnded && !clientRes.destroyed) {
        try { clientRes.destroy(err) } catch { /* ignore */ }
      }
    })
  })
  upstreamReq.on("error", (err) => {
    if (!markSettled("error")) {
      // Response already started arriving; we can't rewind. Just log.
      // eslint-disable-next-line no-console
      console.warn("[pipeResponse] upstream error after response:", err.message)
      return
    }
    if (tee) tee.end()
    if (!clientRes.writableEnded && !clientRes.destroyed) {
      try {
        clientRes.statusCode = 502
        clientRes.setHeader("content-type", "application/json")
        clientRes.end(JSON.stringify({ error: "upstream_error", message: err.message }))
      } catch { /* ignore */ }
    }
    destroyUpstream()
  })
}
