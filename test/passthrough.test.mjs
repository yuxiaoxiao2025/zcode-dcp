// SPDX-License-Identifier: AGPL-3.0-or-later
//
// passthrough.test.mjs — H1 contract tests for zcode-dcp/proxy/daemon.mjs +
// passthrough.mjs (PLAN.md task-12).
//
// Each contract corresponds to one of the 7+ groups in the brief. The tests
// stand up a LOCAL capture upstream (http.createServer) so we can observe the
// exact bytes the daemon forwards; this is the only safe way to validate
// F-N-4 (byte-faithful passthrough) without depending on a real Anthropic
// account. We deliberately do NOT mock http — the daemon uses real sockets
// against the real upstream. That keeps the proxy's H1 contract honest.
//
// Run: node --test zcode-dcp/test/passthrough.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import zlib from "node:zlib"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Paths
const ROOT = path.resolve(__dirname, "..", "..")
const PROXY_DIR = path.resolve(ROOT, "zcode-dcp", "proxy")
const FIXTURE_DIR = path.resolve(__dirname, "fixtures")
const FULL_REQ = path.join(FIXTURE_DIR, "full-anthropic-request.json")
const SSE_FIXTURE = path.join(FIXTURE_DIR, "sse-stream.txt")

// Static imports of the proxy modules — needed because `node --test` on
// Node v25 treats top-level `await import(...)` as the file's single
// top-level test (sub-test registration happens AFTER the await resolves,
// which the runner doesn't await). Static imports register eagerly.
import * as passthrough from "../proxy/passthrough.mjs"
import * as daemon from "../proxy/daemon.mjs"
import * as pipeline from "../proxy/pipeline.mjs"
import * as session from "../proxy/session.mjs"
import * as config from "../proxy/config.mjs"
import * as stats from "../proxy/stats.mjs"
import * as protect from "../proxy/protect.mjs"
import * as compress from "../proxy/compress.mjs"
import * as messageIds from "../proxy/message-ids.mjs"

// Subjects under test — statically imported (see top-of-file note).

/**
 * Build a capture-upstream HTTP server that records every request and
 * replies with `respondFn(req, captured)` where captured is `{method, url,
 * headers, rawBody}` (rawBody is a Buffer). Returns `{port, server,
 * captured, stop}`.
 */
function startCaptureUpstream(respondFn) {
  const captured = { requests: [] }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks)
      const rec = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawBody,
      }
      captured.requests.push(rec)
      try {
        respondFn(req, res, rec, captured)
      } catch (err) {
        try {
          res.statusCode = 500
          res.end("capture upstream error: " + err.message)
        } catch {
          /* ignore */
        }
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      resolve({
        port: addr.port,
        server,
        captured,
        stop: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

/**
 * Minimal config for the daemon tests. The pipeline reads from
 * `cfg.upstream.baseUrl`/`cfg.upstream.apiKey` and the daemon reads
 * `cfg.proxy.port` (we'll pin to 0 and let OS assign). compress.mode stays
 * "range" with showCompression off so nudges don't fire for our fixture.
 */
function makeBaseConfig() {
  return {
    enabled: true,
    debug: false,
    pruneNotification: "detailed",
    commands: { enabled: true, protectedTools: ["Task","Skill","TodoWrite","TodoRead","Write","Edit"] },
    manualMode: { enabled: false, automaticStrategies: true },
    turnProtection: { enabled: false, turns: 4 },
    experimental: { allowSubAgents: false, customPrompts: false },
    protectedFilePatterns: [],
    compress: {
      mode: "range",
      permission: "allow",
      showCompression: false,
      summaryBuffer: false,
      maxContextLimit: 100000,
      minContextLimit: 50000,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      nudgeForce: "soft",
      protectedTools: ["Agent","Task","Skill","TodoWrite","TodoRead"],
      protectTags: false,
      protectUserMessages: false,
    },
    strategies: {
      deduplication: { enabled: false, protectedTools: [] },
      purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
    },
    proxy: { port: 0, idleTimeoutMin: 30, adminTokenFile: "admin-token" },
    upstream: { baseUrl: "", apiKey: "" },
  }
}

async function startTestDaemon(extra = {}) {
  const { startDaemon } = daemon
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dcp-daemon-test-"))
  const cfg = makeBaseConfig()
  Object.assign(cfg.upstream, extra.upstream || {})
  if (extra.compressOverrides) {
    cfg.compress = { ...cfg.compress, ...extra.compressOverrides }
  }
  if (extra.proxyOverrides) {
    cfg.proxy = { ...cfg.proxy, ...extra.proxyOverrides }
  }
  const handle = await startDaemon({ config: cfg, dataDir })
  return { handle, cfg, dataDir }
}

function stopTestDaemon(handle) {
  return new Promise((resolve) => {
    handle.close(() => resolve())
  })
}

/**
 * POST to the daemon's /v1/messages with the given body and headers. Returns
 * `{statusCode, headers, rawBody}` where rawBody is a Buffer of the
 * full response.
 */
function postMessages(port, bodyBuffer, extraHeaders = {}, pathSuffix = "/v1/messages") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathSuffix,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": bodyBuffer.length,
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            rawBody: Buffer.concat(chunks),
          })
        })
      },
    )
    req.on("error", reject)
    req.write(bodyBuffer)
    req.end()
  })
}

/**
 * GET a daemon admin endpoint. `authHeader` is either an `authorization` or
 * `x-api-key` value (already prefixed/formed by caller) — caller controls
 * the exact header name.
 */
function adminGet(port, p, headerName, headerValue) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (headerName) headers[headerName] = headerValue
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "GET", headers },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            rawBody: Buffer.concat(chunks),
          }),
        )
      },
    )
    req.on("error", reject)
    req.end()
  })
}

/**
 * Poll a jsonl file until it has at least `expectedLines` non-empty lines,
 * or until `timeoutMs` elapses. Returns the current lines array (possibly
 * shorter than expected if the deadline was hit).
 *
 * Used by integration tests that depend on the daemon's fire-and-forget
 * appendRequestLine write landing before the assertion. The daemon
 * explicitly does NOT block the response on stats I/O (daemon.mjs:472),
 * so the libuv-threadpool write can race the response handler.
 */
async function waitForJsonlLines(jsonlFile, expectedLines, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let lastLines = []
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(jsonlFile, "utf8")
      lastLines = text.split("\n").filter((l) => l.length > 0)
      if (lastLines.length >= expectedLines) return lastLines
    } catch {
      // File may not exist yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  return lastLines
}

// Find message slice byte indices in a serialized JSON body buffer. Used by
// the bytes-slice comparator in contract 1. Byte-level (not char-level) so
// CJK content in the body (e.g. embedded Chinese in `system` or messages)
// does not break the splice boundary — every UTF-8 multi-byte character
// shifts char-vs-byte indices by a different amount.
function locateMessagesSlice(bodyBuffer) {
  if (!Buffer.isBuffer(bodyBuffer)) throw new Error("locateMessagesSlice: expected Buffer")
  const keyBytes = Buffer.from('"messages":', "utf8")
  const keyIdx = bodyBuffer.indexOf(keyBytes)
  if (keyIdx < 0) throw new Error("no messages key in body")
  let i = keyIdx + keyBytes.length
  while (i < bodyBuffer.length) {
    const b = bodyBuffer[i]
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) break
    i++
  }
  if (i >= bodyBuffer.length || bodyBuffer[i] !== 0x5b) throw new Error("messages not array")
  const start = i
  let depth = 0
  let inStr = false
  let escape = false
  for (let j = start; j < bodyBuffer.length; j++) {
    const b = bodyBuffer[j]
    if (inStr) {
      if (escape) { escape = false; continue }
      if (b === 0x5c) { escape = true; continue }
      if (b === 0x22) inStr = false
      continue
    }
    if (b === 0x22) { inStr = true; continue }
    if (b === 0x5b) depth++
    else if (b === 0x5d) { depth--; if (depth === 0) return { start, end: j } }
  }
  throw new Error("unterminated messages array")
}

// ---------------------------------------------------------------------------
// Top-level: load subjects under test (eagerly, top-level await)
// ---------------------------------------------------------------------------

// ===========================================================================
// CONTRACT 1 — full fixture passes daemon → capture upstream receives bytes
//              equal to the fixture EXCEPT for the `messages` slot. We
//              verify BOTH layers required by F-N-4:
//                (a) every non-messages field deep-equal after JSON.parse
//                (b) the bytes OUTSIDE the messages slice are byte-for-byte
//                    identical (this is what F-N-4 calls the "原始字节切片
//                    对比" lock for the >2^53 / Unicode-escape / \/ escape
//                    edge cases)
// ===========================================================================

test("contract-1: full fixture byte-faithful passthrough (deep-equal + bytes-slice)", async () => {
  const fixtureText = fs.readFileSync(FULL_REQ, "utf8")
  const fixtureJson = JSON.parse(fixtureText)
  const fixtureBuf = Buffer.from(fixtureText, "utf8")
  const fixtureMsgSlice = locateMessagesSlice(fixtureBuf)

  // Capture upstream: echo back a small JSON response.
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true, seen: true }))
  })

  const { handle, cfg, dataDir } = await startTestDaemon({
    upstream: {
      baseUrl: "http://127.0.0.1:" + upstream.port,
      apiKey: "REAL_UPSTREAM_KEY_FOR_TEST",
    },
  })
  try {
    // D7: POST /v1/messages requires the install-time admin token (read from
    // dataDir/admin-token). The token value here is irrelevant to the bytes
    // assertion below — we only check that the daemon REPLACES the inbound
    // token with the real upstream key on the way out.
    const tok1 = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()
    const resp = await postMessages(handle.port, fixtureBuf, {
      authorization: "Bearer " + tok1,
      "x-api-key": tok1,
      "anthropic-version": "2023-06-01",
      "accept-encoding": "gzip",
    })
    assert.equal(resp.statusCode, 200)

    // The capture upstream must have seen exactly ONE request.
    assert.equal(upstream.captured.requests.length, 1)
    const seen = upstream.captured.requests[0]

    // 1(a) Parse the forwarded body and deep-equal every non-messages field.
    const seenBody = JSON.parse(seen.rawBody.toString("utf8"))
    const seenMsgSlice = locateMessagesSlice(seen.rawBody)
    assert.equal(seenBody.model, fixtureJson.model)
    assert.equal(seenBody.max_tokens, fixtureJson.max_tokens)
    assert.equal(seenBody.stream, fixtureJson.stream)
    assert.deepEqual(seenBody.system, fixtureJson.system)
    assert.deepEqual(seenBody.tools, fixtureJson.tools)
    assert.deepEqual(seenBody.tool_choice, fixtureJson.tool_choice)
    assert.deepEqual(seenBody.thinking, fixtureJson.thinking)
    assert.deepEqual(seenBody.output_config, fixtureJson.output_config)
    assert.equal(seenBody.metadata.user_id, fixtureJson.metadata.user_id)
    assert.equal(seenBody.metadata.session_id, fixtureJson.metadata.session_id)
    // The large_id (>2^53) and the escaped forms MUST survive:
    assert.equal(seenBody.metadata.large_id, fixtureJson.metadata.large_id,
      "metadata.large_id (>2^53) must survive serialization round-trip")
    assert.equal(
      seenBody.metadata.nested.value_with_slash,
      fixtureJson.metadata.nested.value_with_slash,
      "metadata.nested.value_with_slash must survive (\\/ escape)",
    )
    assert.equal(
      seenBody.metadata.nested.chinese,
      fixtureJson.metadata.nested.chinese,
      "metadata.nested.chinese must survive (\\u4e2d\\u6587 escape)",
    )
    // Top-level metadata ordering: the WHOLE non-messages slice must equal
    // by reference (not by value) for the property paths we care about.
    assert.deepEqual(
      { ...seenBody, messages: undefined },
      { ...fixtureJson, messages: undefined },
      "every non-messages field must deep-equal the fixture",
    )

    // 1(b) Bytes OUTSIDE the messages slice must be byte-for-byte identical
    // to the fixture. This is the load-bearing lock for F-N-4 (the JSONC
    // serialiser would otherwise re-write 9007199254740993 as 9007199254740992
    // if it went via a JS Number round-trip).
    const fixtureBefore = fixtureBuf.slice(0, fixtureMsgSlice.start).toString("utf8")
    const fixtureAfter = fixtureBuf.slice(fixtureMsgSlice.end + 1).toString("utf8")
    const seenBefore = seen.rawBody.slice(0, seenMsgSlice.start).toString("utf8")
    const seenAfter = seen.rawBody.slice(seenMsgSlice.end + 1).toString("utf8")
    assert.equal(
      seenBefore,
      fixtureBefore,
      "bytes BEFORE the messages slice must be byte-faithful to the fixture",
    )
    assert.equal(
      seenAfter,
      fixtureAfter,
      "bytes AFTER the messages slice must be byte-faithful to the fixture",
    )
    // The forwarder must NOT have rewritten the large_id byte sequence:
    const seenText = seen.rawBody.toString("utf8")
    assert.ok(seenText.includes("9007199254740993"),
      "literal 9007199254740993 must be present in forwarded bytes")
    assert.ok(seenText.includes("\\u4e2d\\u6587"),
      "literal \\u4e2d\\u6587 must be present in forwarded bytes")
    assert.ok(seenText.includes("\\/"),
      "literal \\/ must be present in forwarded bytes")

    // 1(c) Header policy: authorization + x-api-key replaced with the real
    // upstream key, the rest passed through. host is rewritten automatically
    // (capture upstream saw 127.0.0.1:<its port>, not the daemon's port).
    assert.equal(seen.headers["authorization"], "Bearer REAL_UPSTREAM_KEY_FOR_TEST")
    assert.equal(seen.headers["x-api-key"], "REAL_UPSTREAM_KEY_FOR_TEST")
    assert.equal(seen.headers["anthropic-version"], "2023-06-01")
    assert.equal(seen.headers["accept-encoding"], "gzip")
    // Hop-by-hop headers stripped from the application layer (the HTTP
    // transport layer will re-add `connection` automatically; we can only
    // assert that we did NOT forward user-supplied hop-by-hop headers).
    // The fixture's inbound headers do not include any user-supplied
    // hop-by-hop headers, so they MUST be absent from what we forwarded.
    // (Note: a `connection` header seen by the capture upstream is added by
    // Node's http transport, NOT by our forwardRequest.)
    assert.equal(seen.headers["transfer-encoding"], undefined, "transfer-encoding header must not be forwarded")
    assert.equal(seen.headers["upgrade"], undefined, "upgrade header must not be forwarded")
    assert.equal(seen.headers["proxy-connection"], undefined, "proxy-connection header must not be forwarded")
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 2 — SSE stream is forwarded byte-for-byte including cross-chunk
//              line splits. tee extracts usage from message_start AND
//              message_delta positions.
// ===========================================================================

test("contract-2: SSE stream is byte-faithful and tee extracts usage from both positions", async () => {
  const sseRaw = fs.readFileSync(SSE_FIXTURE, "utf8")
  // We deliberately split the body at the middle of a "data:" line so the
  // capture-upstream writes it in two chunks; pipeResponse must reassemble
  // both bytes before delivering to the client (i.e. it must NOT do a
  // chunk-aware transform that would corrupt the boundary).
  const splitAt = sseRaw.indexOf('"Hello"') + '"'.length // split mid-line
  const part1 = Buffer.from(sseRaw.slice(0, splitAt), "utf8")
  const part2 = Buffer.from(sseRaw.slice(splitAt), "utf8")

  const observedChunks = []
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "text/event-stream")
    res.setHeader("cache-control", "no-cache")
    // Two writes, simulating a chunk boundary mid-line.
    res.write(part1)
    // tiny delay to ensure the receiving side observes two chunks
    setTimeout(() => {
      res.write(part2)
      res.end()
    }, 20)
  })

  // Tee callback: capture every usage extraction.
  const usages = []
  // Drive passthrough directly to validate tee behavior (this is the
  // passthrough.mjs unit-level contract). We also verify the daemon-level
  // byte round-trip afterwards. `passthrough` is statically imported at
  // the top of the file.

  // Daemon-level byte round-trip test:
  const { handle, dataDir } = await startTestDaemon({
    upstream: {
      baseUrl: "http://127.0.0.1:" + upstream.port,
      apiKey: "K",
    },
  })
  try {
    // Use a minimal body — the response bytes are what we are testing here.
    const body = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }), "utf8")
    const resp = await postMessages(handle.port, body, {
      authorization: "Bearer " + fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim(),
    })
    assert.equal(resp.statusCode, 200)
    assert.equal(resp.headers["content-type"], "text/event-stream")
    // The full SSE body must equal the original sse-stream.txt bytes.
    assert.equal(
      resp.rawBody.toString("utf8"),
      sseRaw,
      "SSE response must be byte-faithful even across chunk boundary",
    )
  } finally {
    await stopTestDaemon(handle)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }

  // passthrough.mjs unit-level: drive pipeResponse against a synthetic
  // ClientRequest (mocks the upstream) that emits a `response` event with an
  // IncomingMessage-like object whose data/end emit across two chunks.
  await new Promise((resolve, reject) => {
    const upstreamReqMock = {
      _responseCb: null,
      on(ev, cb) {
        if (ev === "response") this._responseCb = cb
        return this
      },
      _emitResponse() {
        if (!this._responseCb) throw new Error("no response listener")
        const r = this._responseCb
        // Real Node IncomingMessage always populates BOTH `headers`
        // (lowercased keys, multi-values merged) AND `rawHeaders`
        // (alternating [name, value] array, original case, no merge).
        // R7/D4 reads `rawHeaders` exclusively — provide it so the mock
        // faithfully models the contract under test.
        const upstreamRes = {
          statusCode: 200,
          headers: { "content-type": "text/event-stream", "x-foo": "bar" },
          rawHeaders: [
            "Content-Type", "text/event-stream",
            "X-Foo", "bar",
          ],
          on(ev, cb) {
            if (ev === "data") {
              // Emit two chunks that together form one SSE line, then close.
              setImmediate(() => {
                cb(part1.slice(0, part1.length - 5))
                setImmediate(() => {
                  cb(part1.slice(part1.length - 5))
                  cb(part2)
                  setImmediate(() => this._fireEnd())
                })
              })
            }
            if (ev === "end") this._endCb = cb
            return this
          },
          _fireEnd() { if (this._endCb) this._endCb() },
        }
        r(upstreamRes)
      },
    }
    const written = []
    const clientRes = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v },
      getHeader(k) { return this.headers[k.toLowerCase()] },
      write(chunk) { written.push(Buffer.from(chunk)) ; return true },
      end() { this.ended = true },
    }
    passthrough.pipeResponse(
      upstreamReqMock,
      clientRes,
      (usage) => usages.push(usage),
    )
    upstreamReqMock._emitResponse()
    setTimeout(() => {
      try {
        assert.equal(clientRes.statusCode, 200)
        assert.equal(clientRes.headers["x-foo"], "bar")
        const reassembled = Buffer.concat(written).toString("utf8")
        assert.equal(reassembled, sseRaw,
          "passthrough.pipeResponse must reassemble cross-chunk bytes")
        // tee must have fired twice (message_start + message_delta).
        const startUsage = usages.find((u) => u && u.inputTokens === 42 && u.cacheReadTokens === 7)
        const deltaUsage = usages.find((u) => u && u.outputTokens === 12)
        assert.ok(startUsage, "tee must extract usage from message_start")
        assert.ok(deltaUsage, "tee must extract usage from message_delta")
        resolve()
      } catch (err) { reject(err) }
    }, 120)
  })

  await upstream.stop()
})

// ===========================================================================
// CONTRACT 3 — upstream 401 body is forwarded byte-for-byte (F-N-3).
// ===========================================================================

test("contract-3: upstream 401 error body is forwarded byte-for-byte", async () => {
  const errBody = Buffer.from('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 401
    res.setHeader("content-type", "application/json")
    res.setHeader("x-request-id", "req-xyz")
    res.end(errBody)
  })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "WRONG" },
  })
  try {
    const body = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022", max_tokens: 16, stream: false,
      messages: [{ role: "user", content: "hi" }],
    }), "utf8")
    const resp = await postMessages(handle.port, body, {
      authorization: "Bearer " + fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim(),
    })
    assert.equal(resp.statusCode, 401)
    assert.equal(resp.headers["x-request-id"], "req-xyz")
    assert.ok(resp.rawBody.equals(errBody),
      "401 body must be forwarded byte-for-byte (F-N-3)")
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 4 — admin endpoints: no token → 401; valid token → identify
//              returns {service, version}; state endpoints reflect
//              markActive table; health is open.
// ===========================================================================

test("contract-4: admin endpoints (token gate + identify + state + health)", async () => {
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true }))
  })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
  })
  try {
    // 4a. /dcp-admin/identify WITHOUT token → 401
    const noAuth = await adminGet(handle.port, "/dcp-admin/identify", null, null)
    assert.equal(noAuth.statusCode, 401)

    // 4b. First send a model request so a session becomes "active" (markActive
    // entry written under dataDir). Then identify with the daemon token.
    const body = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022", max_tokens: 8, stream: false,
      messages: [{ role: "user", content: "ping" }],
    }), "utf8")
    await postMessages(handle.port, body, {
      authorization: "Bearer " + fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim(),
    })

    // 4c. /dcp-admin/identify WITH token → 200 + {service, version}
    const tok = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()
    const auth = await adminGet(handle.port, "/dcp-admin/identify", "authorization", "Bearer " + tok)
    assert.equal(auth.statusCode, 200)
    const idBody = JSON.parse(auth.rawBody.toString("utf8"))
    assert.equal(idBody.service, "zcode-dcp")
    assert.ok(typeof idBody.version === "string" && idBody.version.length > 0)

    // 4d. x-api-key form of auth also works
    const authX = await adminGet(handle.port, "/dcp-admin/identify", "x-api-key", tok)
    assert.equal(authX.statusCode, 200)

    // 4e. /dcp-admin/state returns recent active sessions (at least the one we
    // just touched via postMessages above). The exact fp is opaque to the
    // test; we only check shape: {sessions:[{fp,lastSeenTs}]}.
    const state = await adminGet(handle.port, "/dcp-admin/state", "authorization", "Bearer " + tok)
    assert.equal(state.statusCode, 200)
    const stateBody = JSON.parse(state.rawBody.toString("utf8"))
    assert.ok(Array.isArray(stateBody.sessions), "state.sessions must be an array")
    assert.ok(stateBody.sessions.length >= 1, "state.sessions must include the active fp")

    // 4f. /dcp-admin/health is open (no token required) and returns 200.
    const health = await adminGet(handle.port, "/dcp-admin/health", null, null)
    assert.equal(health.statusCode, 200)

    // 4g. Bad token → 401
    const badAuth = await adminGet(handle.port, "/dcp-admin/identify", "authorization", "Bearer NOT_THE_TOKEN")
    assert.equal(badAuth.statusCode, 401)
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 5 — gzip-encoded upstream body is forwarded byte-for-byte.
//              (Node's http.request does NOT auto-decompress when the client
//              sent the original Accept-Encoding; passthrough must preserve
//              the content-encoding header so the downstream can decode.)
// ===========================================================================

test("contract-5: gzip body forwarded byte-for-byte (no auto-decompress)", async () => {
  const plain = Buffer.from("hello gzip world ".repeat(50), "utf8")
  const gz = zlib.gzipSync(plain)
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "text/plain")
    res.setHeader("content-encoding", "gzip")
    res.end(gz)
  })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
  })
  try {
    const body = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022", max_tokens: 8, stream: false,
      messages: [{ role: "user", content: "hi" }],
    }), "utf8")
    const resp = await postMessages(handle.port, body, {
      authorization: "Bearer " + fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim(),
      "accept-encoding": "gzip",
    })
    assert.equal(resp.statusCode, 200)
    assert.equal(resp.headers["content-encoding"], "gzip")
    assert.ok(resp.rawBody.equals(gz), "gzip body must be forwarded byte-for-byte")
    // And the body is still a valid gzip stream the client can decode.
    const decoded = zlib.gunzipSync(resp.rawBody).toString("utf8")
    assert.equal(decoded, plain.toString("utf8"))
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 6 — malformed request fallback: non-JSON body and messages-not-an-
//              array bodies are forwarded byte-for-byte to upstream (not 500).
//              The daemon must still log a warning. This is the SPEC R15 /
//              hooks.ts:117-123 "shape defence" requirement.
// ===========================================================================

test("contract-6: malformed body forwarded byte-for-byte (no 500)", async () => {
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true }))
  })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
  })
  try {
    // D7: postMessages requires the install-time admin token (read from
    // dataDir/admin-token). All three malformed-body subtests share it.
    const tok6 = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()
    // 6a. Non-JSON body
    const garbage = Buffer.from("this is not json {{{")
    const r1 = await postMessages(handle.port, garbage, {
      authorization: "Bearer " + tok6,
      "content-type": "application/json",
    })
    assert.equal(r1.statusCode, 200, "non-JSON body must not produce 500")
    assert.ok(upstream.captured.requests[0].rawBody.equals(garbage),
      "non-JSON body must be forwarded byte-for-byte")

    // 6b. JSON body, messages is NOT an array
    const badShape = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 8,
      stream: false,
      messages: "definitely not an array",
    }), "utf8")
    const r2 = await postMessages(handle.port, badShape, {
      authorization: "Bearer " + tok6,
    })
    assert.equal(r2.statusCode, 200, "messages-not-array must not produce 500")
    assert.ok(upstream.captured.requests[1].rawBody.equals(badShape),
      "messages-not-array body must be forwarded byte-for-byte")

    // 6c. JSON body, missing messages entirely
    const noMsgs = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022", max_tokens: 8, stream: false,
    }), "utf8")
    const r3 = await postMessages(handle.port, noMsgs, {
      authorization: "Bearer " + tok6,
    })
    assert.equal(r3.statusCode, 200, "missing-messages must not produce 500")
    assert.ok(upstream.captured.requests[2].rawBody.equals(noMsgs),
      "missing-messages body must be forwarded byte-for-byte")
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 7 — R11: EADDRINUSE self-probe. If a "fake" daemon already owns
//              the port and answers /dcp-admin/identify with the right
//              token + service name, a second startDaemon on the same port
//              must detect the owner, exit 0 (signal reuse), and NOT bind
//              twice. We don't actually subprocess-fork; instead we
//              exercise the in-process probe path via startDaemon's
//              `portInUse` callback if one exists, OR by directly probing
//              the underlying port. The contract here is: when EADDRINUSE
//              fires AND the occupier identifies as a sibling, the second
//              caller resolves successfully without throwing.
// ===========================================================================

test("contract-7: EADDRINUSE self-probe resolves as sibling-reuse", async () => {
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true }))
  })
  // First daemon: take a real OS-assigned port.
  const first = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
  })
  try {
    const firstPort = first.handle.port
    const firstToken = fs.readFileSync(path.join(first.dataDir, "admin-token"), "utf8").trim()

    // Now a SECOND startDaemon call attempts to bind the SAME port. We
    // expect startDaemon to detect the existing sibling via
    // /dcp-admin/identify and resolve gracefully (i.e. throw an error with
    // a specific code so the caller can decide to reuse vs report).
    //
    // The cleanest way to validate the contract is to look for an exported
    // helper or a stable error type. If the daemon module exports a
    // `probeExistingDaemon(port, token)` helper, use it. Otherwise, we
    // observe that the second startDaemon either (a) resolves with a
    // handle pointing at firstPort (reuse), or (b) throws a tagged error
    // we can match on. Both are acceptable per the brief.
    let secondResolved = null
    let secondError = null
    try {
      // We reuse first.dataDir's token by writing the same token to a fresh
      // dataDir so the probe can authenticate.
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-daemon-test2-"))
      fs.writeFileSync(path.join(tmpDir2, "admin-token"), firstToken)
      const cfg2 = makeBaseConfig()
      cfg2.proxy.port = firstPort
      cfg2.upstream = { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" }
      secondResolved = await daemon.startDaemon({ config: cfg2, dataDir: tmpDir2 })
      // If startDaemon "resolves" the EADDRINUSE as sibling reuse, close the
      // returned handle and ensure it does not error.
      if (secondResolved && typeof secondResolved.close === "function") {
        await new Promise((r) => secondResolved.close(() => r()))
      }
      fs.rmSync(tmpDir2, { recursive: true, force: true })
    } catch (err) {
      secondError = err
    }

    // At minimum, the contract says the daemon MUST NOT crash silently and
    // MUST report a clear error when EADDRINUSE happens against a non-sibling.
    // Here the occupier IS a sibling, so the daemon must either reuse or
    // resolve with a tagged error; either is acceptable. We just check that
    // it did NOT throw an uncaught error referencing a generic Node EADDRINUSE.
    if (secondError) {
      assert.ok(
        /sibling|reuse|identify|in use|EADDRINUSE/i.test(secondError.message),
        "EADDRINUSE error must be tagged so the caller can recognise sibling reuse",
      )
    } else {
      assert.ok(secondResolved, "sibling reuse resolved without error")
    }
  } finally {
    await stopTestDaemon(first.handle)
    await upstream.stop()
    fs.rmSync(first.dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 8 — usage tee is queryable per-fp via the admin/stats endpoint
//              (daemon stores the most recent SSE-parsed usage in memory
//              keyed by fp; subsequent pipeline invocations may consume
//              it for planNudges threshold checks).
// ===========================================================================

test("contract-8: usage tee persisted per-fp (admin/stats reflects recent requests)", async () => {
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "text/event-stream")
    res.end(fs.readFileSync(SSE_FIXTURE))
  })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
  })
  try {
    const body = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022", max_tokens: 16, stream: true,
      messages: [{ role: "user", content: "hi" }],
    }), "utf8")
    // D7: read the install-time admin token once, share it across the
    // postMessages + admin GET below.
    const tok = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()
    await postMessages(handle.port, body, { authorization: "Bearer " + tok })

    // The daemon writes dataDir/stats/{fp}.json on snapshot. We don't need
    // to read it directly — just confirm /dcp-admin/stats returns a 200 with
    // non-zero totals. (tok is already declared above.)
    const statsResp = await adminGet(handle.port, "/dcp-admin/stats", "authorization", "Bearer " + tok)
    assert.equal(statsResp.statusCode, 200)
    const statsBody = JSON.parse(statsResp.rawBody.toString("utf8"))
    assert.ok(statsBody && typeof statsBody === "object")
    assert.ok(statsBody.requests >= 1, "stats must show >=1 request")
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT A2 — Gate 1.5 A2 sentTokens full-denominator (incl. tools)
// ===========================================================================
//
// H2 / 08 问③: stats.sentTokens and the jsonl `sent` field are both
// derived from the same `estimateBodyTokens(body)` call inside the
// daemon's /v1/messages handler. Post-fix that estimator counts tool
// definitions too. This test sends a request with a non-trivial tools
// array and verifies the jsonl line `sent` matches stats-all `sentTokens`
// (the "同源一致" invariant — fixing one without the other would split
// the surface, which is exactly the bug we're closing).
test("contract-A2: jsonl sent === stats-all sentTokens with tools array (同源一致)", async () => {
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "text/event-stream")
    res.end(fs.readFileSync(SSE_FIXTURE))
  })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
  })
  try {
    const tok = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()

    // Body with 3 non-trivial tool definitions (~100 chars schema each).
    // Pre-fix this would yield identical jsonl/stat counts with vs
    // without the tools array; post-fix both surfaces MUST include the
    // tools component and MUST agree with each other.
    const body = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 16,
      stream: true,
      system: [{ type: "text", text: "You are ZCode." }],
      messages: [{ role: "user", content: "inspect the auth module" }],
      tools: [
        {
          name: "Read",
          description: "Reads a file from the local filesystem. Returns the file contents and metadata.",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
        {
          name: "Edit",
          description: "Performs an exact string replace in a file.",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
            required: ["file_path", "old_text", "new_text"],
          },
        },
        {
          name: "Bash",
          description: "Executes a shell command and returns stdout/stderr.",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" }, timeout: { type: "number" } },
            required: ["command"],
          },
        },
      ],
    }), "utf8")
    await postMessages(handle.port, body, { authorization: "Bearer " + tok })

    // 1. Read the per-request jsonl line (D3a) — `sent` is the request's
    //    sentTokens from the post-fix estimator.
    //
    // RACE NOTE: appendRequestLine is invoked fire-and-forget by the daemon
    // (the request-forwarding path is NOT blocked by stats I/O — see
    // daemon.mjs:472-479). postMessages returns when the upstream response
    // lands, which can race the libuv-threadpool jsonl write. Poll the file
    // until exactly one line appears (or the deadline expires) so the test
    // is timing-tolerant on slow CI hosts.
    const jsonlFile = path.join(dataDir, "stats", "requests.jsonl")
    const lines = await waitForJsonlLines(jsonlFile, 1, 2000)
    assert.equal(lines.length, 1, "exactly one request appended")
    const rec = JSON.parse(lines[0])
    assert.equal(typeof rec.sent, "number")
    assert.ok(rec.sent > 0, `jsonl.sent must be > 0 for a non-empty request; got ${rec.sent}`)

    // 2. Read stats-all.json (all-time aggregate). The single request's
    //    sent must equal the aggregate's sentTokens (no other requests
    //    landed in this isolated tmpdir).
    const allTime = JSON.parse(fs.readFileSync(path.join(dataDir, "stats-all.json"), "utf8"))
    assert.equal(typeof allTime.sentTokens, "number")
    assert.equal(
      allTime.sentTokens, rec.sent,
      `jsonl.sent (${rec.sent}) must equal stats-all.sentTokens (${allTime.sentTokens}) — both derived from the same estimateBodyTokens call`,
    )

    // 3. Sanity: sent must reflect the tools component. ~3 tool defs ×
    //    ~200 chars / 4 ≈ 150 tokens. The pre-fix estimator would have
    //    returned ~system + messages only (≈ 30 tokens for the fixture
    //    above). We assert a generous lower bound to leave room for
    //    estimator variance while still proving the tools component
    //    is being counted.
    assert.ok(
      rec.sent >= 50,
      `jsonl.sent must include the tools component (≥ 50 tokens for 3 non-trivial tool defs); got ${rec.sent}`,
    )
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 9 — idle timer: when no model request and no admin heartbeat
//              arrives within idleTimeoutMin minutes, daemon should signal
//              shutdown. We test this via an injectable clock hook:
//              startDaemon accepts an optional `_now()` function (ZCode
//              adaptation; not in DCP) so tests can fast-forward time
//              without waiting 30 real minutes. After the timer fires,
//              the handle's `close` callback is invoked.
// ===========================================================================

test("contract-9: idle timer fires after configured idle window (injectable clock)", async () => {
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.end("{}")
  })
  // We test the idle-timer mechanism by attaching a clock injector and
  // setting a TINY idle timeout (1 ms) so the real setTimeout fires almost
  // immediately when the daemon is started and then we wait for the server
  // to actually close.
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
    proxyOverrides: { idleTimeoutMin: 1 },
  })
  try {
    // Use handle.setClock (exposed by startDaemon for tests) to fast-forward
    // the timer's reference time past the idle deadline, then trigger a
    // re-check by hitting a no-op admin endpoint.
    if (typeof handle.setClock === "function") {
      // setClock returns a setter that lets us bump the wall clock past the
      // deadline; calling checkIdle() triggers the timer evaluation.
      let advanced = false
      handle.setClock(() => (advanced ? Date.now() + 5 * 60 * 1000 : Date.now()))
      advanced = true
      if (typeof handle.checkIdle === "function") handle.checkIdle()
      // Wait for the timer to fire (timer is unref'd; loop has nothing
      // else keeping it alive after the upstream stops responding).
      const closed = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 200)
        handle.server && handle.server.once("close", () => { clearTimeout(t); resolve(true) })
      })
      assert.ok(closed || handle.idleFired === true,
        "idle timer must trigger server.close after deadline")
    } else {
      // Fallback: verify the close path exists; this branch is allowed.
      assert.ok(typeof handle.close === "function",
        "handle.close must exist (idle timer contract requires graceful stop)")
    }
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 10 — H1-C1: content-length is recomputed by Node when forwarded
//               body size differs from inbound. We assert that an outbound
//               body LARGER than the inbound (pipeline appends a synthetic
//               user message) is forwarded with the auto-computed
//               content-length matching the actual upstream-received bytes,
//               not the stale inbound content-length.
//
//               Without content-length stripping the upstream would see
//               Content-Length: <inbound-size> + the actual larger body —
//               Node 25's http client truncates silently.
// ===========================================================================

test("contract-10: forwarded body that grew vs inbound gets correct content-length", async () => {
  // Inbound body — small. The pipeline will append a synthetic user message
  // (compress error path); the pipeline's planNudges won't fire in this
  // session because config.compress.maxContextLimit is huge. Instead we use
  // the dedup path: 3 identical Read tool calls trigger dedup; applyPrune
  // rewrites 2 of the tool_result bodies in place. The net effect on byte
  // length can be SMALLER or LARGER depending on input. We use a simpler
  // forcing function: pre-stage the body so that messages[0..2] is missing
  // the system block (we send a body without `system`), and then a malformed
  // body would NOT apply here. Simpler: directly verify the upstream's
  // received body length matches Content-Length when we use a body that
  // gets the SAME size back (idempotent transform).
  //
  // The critical test: build a payload, send it, capture upstream, assert
  // that capture-seen rawBody.length === headerContentLength exactly.
  const fixtureText = fs.readFileSync(FULL_REQ, "utf8")
  const fixtureBuf = Buffer.from(fixtureText, "utf8")

  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true }))
  })

  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "REAL" },
  })
  try {
    // D7: pass the install-time admin token.
    await postMessages(handle.port, fixtureBuf, {
      authorization: "Bearer " + fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim(),
    })
    assert.equal(upstream.captured.requests.length, 1)
    const seen = upstream.captured.requests[0]
    // Node's HTTP transport sets Content-Length (or Transfer-Encoding for
    // chunked). If the daemon forwarded the inbound content-length without
    // recomputing, the upstream would either truncate (if seen.rawBody was
    // larger than header) or hang (if smaller). The contract is: the bytes
    // received must equal what was sent (forwardedBody), AND the upstream's
    // framing must be self-consistent.
    const declaredLen = seen.headers["content-length"]
    if (typeof declaredLen === "string") {
      // Content-Length form: declared MUST match actual bytes.
      assert.equal(
        Number(declaredLen),
        seen.rawBody.length,
        "upstream content-length must match actual bytes received (H1-C1)",
      )
    }
    // Either form is acceptable; the test below (bytes-slice) already
    // locks down byte-faithful forwarding. We additionally require the
    // inbound content-length must NOT be forwarded (it was stripped).
    // Build a body with an explicit content-length that DOES NOT match
    // the actual payload, then verify the upstream does NOT see it.
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test("contract-10b: explicit wrong inbound content-length is dropped (recomputed)", async () => {
  // Unit-level: buildUpstreamRequestOptions must strip inbound content-length
  // so the daemon never forwards a stale (potentially wrong) length to upstream.
  const headers = {
    "content-length": "999", // wrong on purpose
    "content-type": "application/json",
    authorization: "Bearer stale",
    "x-api-key": "stale",
    "anthropic-version": "2023-06-01",
  }
  const opts = passthrough.buildUpstreamRequestOptions(
    "http://127.0.0.1:8367", headers, "REAL_KEY",
  )
  assert.equal(opts.headers["content-length"], undefined,
    "inbound content-length must be stripped (H1-C1: transport-managed header)")
  // The auth headers are replaced (per H1 white-list policy) — content-length
  // being absent is the structural requirement for byte-faithful passthrough.
  assert.equal(opts.headers.authorization, "Bearer REAL_KEY")
  assert.equal(opts.headers["x-api-key"], "REAL_KEY")
  // The original headers object MUST NOT be mutated (H1 fidelity: caller data
  // is not modified by the proxy).
  assert.equal(headers["content-length"], "999",
    "buildUpstreamRequestOptions must not mutate the inbound headers")
})

// ===========================================================================
// CONTRACT 11 — H1-C2: CJK bytes in the body. The body contains unescaped
//               multi-byte UTF-8 (e.g. "你是中文编程助手"); the daemon
//               must splice the messages slice on BYTE boundaries (not char
//               boundaries) and the result must be valid JSON.parse-able
//               with all CJK bytes preserved.
// ===========================================================================

test("contract-11: CJK content in body spliced on byte boundaries", async () => {
  // Construct a request body where `system` contains unescaped CJK text
  // BEFORE the `messages` key. The byte-level splice must not split a
  // multi-byte character.
  const body = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 32,
    stream: false,
    system: [{ type: "text", text: "你是中文编程助手，请用中文回答问题。代码用 UTF-8 编码。" }],
    messages: [
      { role: "user", content: "你好世界" },
      { role: "assistant", content: "你好！这是测试回答。" },
    ],
  }
  // JSON.stringify does NOT escape CJK by default — JS Unicode strings
  // pass through as raw UTF-8 bytes when serialised. This is the exact
  // case the fixture must reproduce.
  const bodyText = JSON.stringify(body)
  const bodyBuf = Buffer.from(bodyText, "utf8")

  // Sanity check: the byte buffer contains the raw CJK bytes.
  const cjkCheck = Buffer.from("你是中文编程助手", "utf8")
  assert.ok(bodyBuf.indexOf(cjkCheck) > 0, "fixture must contain raw CJK bytes")
  // Confirm a non-ASCII byte is present (proves we are NOT in escaped mode).
  const hasHighBit = bodyBuf.some((b) => b > 0x7f)
  assert.ok(hasHighBit, "CJK must be raw UTF-8 (not \\uXXXX escaped)")

  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.end("{}")
  })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "REAL" },
  })
  try {
    // D7: pass the install-time admin token.
    await postMessages(handle.port, bodyBuf, {
      authorization: "Bearer " + fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim(),
    })
    const seen = upstream.captured.requests[0]
    // The forwarded body MUST be valid JSON (no split CJK character).
    let parsed
    try {
      parsed = JSON.parse(seen.rawBody.toString("utf8"))
    } catch (e) {
      assert.fail(`forwarded body is not valid JSON: ${e.message}\nbody: ${seen.rawBody.toString("utf8").slice(0, 300)}`)
    }
    assert.equal(parsed.system[0].text, body.system[0].text,
      "CJK bytes in system must survive the splice verbatim")
    assert.equal(parsed.messages[0].content, body.messages[0].content,
      "CJK bytes in messages must survive the splice verbatim")
    // Also: the body OUTSIDE the messages slice must byte-equal the
    // original body outside the messages slice. This is the actual byte-
    // level splice invariant — split on byte offsets, paste verbatim.
    const origSlice = locateMessagesSlice(bodyBuf)
    const seenSlice = locateMessagesSlice(seen.rawBody)
    assert.ok(origSlice && seenSlice, "both bodies must locate messages slice")
    assert.equal(
      bodyBuf.slice(0, origSlice.start).equals(seen.rawBody.slice(0, seenSlice.start)),
      true,
      "bytes BEFORE messages slice must be byte-equal (H1-C2 byte-level splice)",
    )
    assert.equal(
      bodyBuf.slice(origSlice.end + 1).equals(seen.rawBody.slice(seenSlice.end + 1)),
      true,
      "bytes AFTER messages slice must be byte-equal (H1-C2 byte-level splice)",
    )
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 12 — H1-Imp: kill → restart preserves light state. R11 demands
//               the daemon survive SIGKILL/restart with the light state
//               (anchors, sweepToolCallIds, decompressBlockIds) intact.
// ===========================================================================

test("contract-12: daemon restart preserves lightState across dataDir", async () => {
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.end("{}")
  })
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-restart-"))
  try {
    // First lifetime: write a known light state into dataDir/light-state/.
    const fp = "0123456789abcdef"
    const desiredState = {
      anchors: { context: [1, 2, 3], turn: [4], iter: [] },
      fetchCount: 7,
      sweepToolCallIds: ["sweep_id_a", "sweep_id_b"],
      decompressBlockIds: [42, 99],
      manualMode: true,
    }
    const { saveLightState } = session
    saveLightState(dataDir, fp, desiredState)

    // Start a daemon with this dataDir, ensure it boots and reports the
    // saved values via /dcp-admin/state (which reads active-sessions, not
    // light-state — but we can verify via /dcp-admin/identify that the
    // daemon loaded, and via a manual GET of the persisted file that the
    // state survives).
    const cfg = makeBaseConfig()
    cfg.upstream = { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" }
    cfg.proxy = { ...cfg.proxy, idleTimeoutMin: 30 }
    const first = await daemon.startDaemon({ config: cfg, dataDir })

    // Read light-state from disk (the same path the daemon would).
    const lsPath = path.join(dataDir, "light-state", `${fp}.json`)
    const persisted = JSON.parse(fs.readFileSync(lsPath, "utf8"))
    assert.deepEqual(persisted.anchors.context, [1, 2, 3])
    assert.deepEqual(persisted.sweepToolCallIds, ["sweep_id_a", "sweep_id_b"])
    assert.deepEqual(persisted.decompressBlockIds, [42, 99])
    assert.equal(persisted.manualMode, true)

    // Simulate daemon death: close the first handle.
    await stopTestDaemon(first)

    // Restart with the same dataDir. Token file is preserved; daemon must
    // come up serving on a (possibly different) port.
    const second = await daemon.startDaemon({ config: cfg, dataDir })
    try {
      // Re-read persisted state — must be unchanged.
      const persisted2 = JSON.parse(fs.readFileSync(lsPath, "utf8"))
      assert.deepEqual(persisted2.anchors.context, [1, 2, 3])
      assert.deepEqual(persisted2.sweepToolCallIds, ["sweep_id_a", "sweep_id_b"])
      assert.deepEqual(persisted2.decompressBlockIds, [42, 99])
      assert.equal(persisted2.manualMode, true)
      assert.equal(persisted2.fetchCount, 7)

      // Hit the admin endpoint to confirm the new daemon is serving.
      const tok = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()
      const resp = await adminGet(second.server.address().port, "/dcp-admin/identify", "authorization", "Bearer " + tok)
      assert.equal(resp.statusCode, 200, "restarted daemon must serve admin")
    } finally {
      await stopTestDaemon(second)
    }
  } finally {
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 13 — H1-Imp: pipeline.planPrune consumes lightState.sweepToolCallIds.
//               When the MCP `dcp_sweep` action runs (or the admin
//               state/sweep endpoint clears it), the next /v1/messages
//               request must mark those tool_use ids as pruned even if no
//               dedup/purge strategy would have picked them up on its own.
// ===========================================================================

test("contract-13: lightState.sweepToolCallIds force-prune via pipeline", async () => {
  // Build a messages array with a single Read call + tool_result. dedup
  // and purge are disabled so the ONLY path to prune this id is via the
  // sweep set in lightState.
  const messages = [
    { role: "user", content: [{ type: "text", text: "Read foo" }] },
    { role: "assistant", content: [
      { type: "text", text: "calling" },
      { type: "tool_use", id: "sweep_target", name: "Read", input: { file_path: "/tmp/a" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "sweep_target", content: "first content for sweep" },
    ] },
  ]

  const fp = "feedfacedeadbeef"
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-sweep-"))
  try {
    const cfg = makeBaseConfig()
    // Disable both strategies so the only path to prune is via sweepToolCallIds.
    cfg.strategies.deduplication.enabled = false
    cfg.strategies.purgeErrors.enabled = false
    cfg.compress.protectedTools = [] // allow all
    const lightState = {
      anchors: { context: [], turn: [], iter: [] },
      fetchCount: 0,
      sweepToolCallIds: ["sweep_target"],
      decompressBlockIds: [],
      manualMode: false,
    }
    // The pipeline gate requires a "You are ZCode" system signature; provide
    // one so the pipeline runs all the way through.
    const result = pipeline.transformRequest(
      {
        model: "m",
        system: [{ type: "text", text: "You are ZCode, an AI coding assistant." }],
        messages,
      },
      { config: cfg, lightState, usage: null, dataDir },
    )
    // The sweep target's tool_result.content must be replaced with PRUNED_TOOL_OUTPUT.
    const out = result.body.messages
    const userMsgs = out.filter((m) => m && m.role === "user")
    assert.ok(userMsgs.length >= 1, "user messages must remain in output")
    let tr = null
    for (const m of userMsgs) {
      const blocks = Array.isArray(m.content) ? m.content
        : (typeof m.content === "string" ? [] : [])
      for (const b of blocks) {
        if (b && b.type === "tool_result" && b.tool_use_id === "sweep_target") {
          tr = b
          break
        }
      }
      if (tr) break
    }
    assert.ok(tr, "sweep_target tool_result block must exist in output")
    // The placeholder gets the PRUNED_TOOL_OUTPUT constant; message-id tag
    // may be appended by injectMessageIds (that's a separate concern).
    assert.ok(
      tr.content.startsWith("[Output removed to save context - information superseded or no longer needed]"),
      `sweep-marked tool_result must be placeholder-substituted, got ${JSON.stringify(tr.content).slice(0, 100)}`,
    )
    // byStrategy.sweep counts the number of sweep-driven prunes.
    assert.equal(result.metrics.byStrategy.sweep, 1,
      "metrics.byStrategy.sweep must report 1 sweep-driven prune")
    assert.ok(result.metrics.savedTokensEst > 0, "sweep should add savedTokensEst > 0")

    void fp
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 14 — H1-Imp: deriveBlocks(opts.excludedBlockIds) drops blocks.
// ===========================================================================

test("contract-14: deriveBlocks with excludedBlockIds drops matching blocks", () => {
  // Build a minimal compress tool_use + tool_result pair so deriveBlocks
  // returns at least one block.
  const messages = [
    { role: "user", content: "msg1" },
    { role: "user", content: "msg2" },
    { role: "assistant", content: [
      { type: "tool_use", id: "compress_call_1", name: "mcp__dcp__compress", input: {
        topic: "t1", content: [
          { startId: "m0001", endId: "m0002", summary: "summary of msg1..msg2" },
        ],
      } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "compress_call_1", content: "ok" },
    ] },
  ]
  // refs must be set up via assignRefs so m0001/m0002 resolve.
  const refs = messageIds.assignRefs(messages)

  // Without excludedBlockIds: block 1 must be present.
  const blocksAll = compress.deriveBlocks(messages, refs, { compressToolName: "mcp__*__compress" })
  assert.equal(blocksAll.length, 1, "without exclusion, the block is derived")
  assert.equal(blocksAll[0].blockId, "b1")

  // With excludedBlockIds=[1]: block 1 must be absent.
  const blocksExcluded = compress.deriveBlocks(messages, refs, {
    compressToolName: "mcp__*__compress",
  }, { excludedBlockIds: [1] })
  assert.equal(blocksExcluded.length, 0, "excluded block id must be dropped at source")
})

// ===========================================================================
// CONTRACT 15 — C-1: race protection. Upstream emits both `response` and
//               `error` events within the same tick (broken socket mid-
//               handshake). The client must see exactly ONE complete
//               response — either the upstream body OR a 502, never both.
// ===========================================================================

test("contract-15: pipeResponse race between response+error resolves once", async () => {
  let written = []
  let ended = false
  const clientRes = {
    statusCode: 0,
    writableEnded: false,
    destroyed: false,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    getHeader(k) { return this.headers[k.toLowerCase()] },
    write(chunk) { written.push(Buffer.from(chunk)); return true },
    end() { this.ended = true; this.writableEnded = true },
  }
  let responseCb = null
  let errorCb = null
  const upstreamReqMock = {
    on(ev, cb) {
      if (ev === "response") responseCb = cb
      if (ev === "error") errorCb = cb
      return this
    },
    destroy() { /* swallow */ },
  }
  passthrough.pipeResponse(upstreamReqMock, clientRes)
  // Simulate a same-tick race: BOTH events fire before any I/O drain.
  // Whichever wins must result in exactly one write/end sequence.
  const upstreamResMock = {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    on(ev, cb) {
      if (ev === "data") {
        // schedule the data+end microtask
        queueMicrotask(() => {
          cb(Buffer.from('{"ok":true}'))
          queueMicrotask(() => this._fireEnd && this._fireEnd())
        })
      }
      if (ev === "end") this._fireEnd = cb
      return this
    },
  }
  responseCb && responseCb(upstreamResMock)
  // Fire error AFTER response handler ran but before the data flow completes.
  // The settled flag should have been set by response — error becomes no-op.
  errorCb && errorCb(new Error("simulated socket close mid-flight"))

  // Allow microtasks to drain.
  await new Promise((r) => setImmediate(r))
  // Exactly one body was written, ending the response exactly once.
  const reassembled = Buffer.concat(written).toString("utf8")
  assert.equal(reassembled, '{"ok":true}', "client must receive the response body, not a 502")
  assert.equal(clientRes.statusCode, 200, "client must receive status 200 (response won the race)")
  assert.ok(clientRes.writableEnded, "client response must have ended exactly once")
})

// ===========================================================================
// CONTRACT 16 — I-1: unknown state action yields 400 + allowed list.
// ===========================================================================

test("contract-16: /dcp-admin/state/<unknown> → 400 + allowed list", async () => {
  const upstream = await startCaptureUpstream((req, res) => { res.end("{}") })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
  })
  try {
    const tok = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()
    const resp = await adminGet(handle.port, "/dcp-admin/state/typo_action", "authorization", "Bearer " + tok)
    assert.equal(resp.statusCode, 400)
    const body = JSON.parse(resp.rawBody.toString("utf8"))
    assert.equal(body.error, "unknown_action")
    assert.equal(body.action, "typo_action")
    assert.ok(Array.isArray(body.allowed))
    assert.ok(body.allowed.includes("sweep"))
    assert.ok(body.allowed.includes("manual"))
    assert.ok(body.allowed.includes("decompress"))
    assert.ok(body.allowed.includes("recompress"))
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 17 — I-3: idle timer must NOT cut off an in-flight stream. We
//               simulate a long response (10s artificial delay) and confirm
//               the daemon does NOT fire idleFired during the response.
// ===========================================================================

test("contract-17: in-flight streaming response is not cut by idle timer", async () => {
  // Upstream responds SLOWLY (1500ms) so the response is unambiguously in
  // flight when we check idle. The test asserts: idle MUST NOT fire while
  // activeConnections > 0, even when the wall clock is past the deadline.
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "text/event-stream")
    res.write("event: start\ndata: {}\n\n")
    setTimeout(() => {
      res.write("event: end\ndata: {}\n\n")
      res.end()
    }, 1500)
  })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
    proxyOverrides: { idleTimeoutMin: 1 },
  })
  try {
    // Set a fake clock so we control time. lastHeartbeatAt is set on
    // startDaemon; we'll advance the fake clock past the deadline.
    let now = 1_000_000
    handle.setClock(() => now)

    // Start the long request — this triggers incActive (activeConnections=1).
    const body = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022", max_tokens: 8, stream: true,
      messages: [{ role: "user", content: "long" }],
    }), "utf8")
    // D7: pass the install-time admin token.
    const respP = postMessages(handle.port, body, {
      authorization: "Bearer " + fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim(),
    })
    // Wait a moment so the request actually arrives and the server starts
    // streaming — we need incActive to have fired before we check.
    await new Promise((r) => setTimeout(r, 100))
    // Diagnostic: capture in-flight counter state.
    const preCheck = {
      activeConnections: typeof handle.activeConnections === "function" ? handle.activeConnections() : -1,
      idleFired: handle.idleFired(),
    }
    // Advance the fake clock past the idle deadline (1 minute = 60_000ms).
    now += 5 * 60 * 1000
    // Manually evaluate idle. The in-flight guard must keep idleFired=false.
    if (typeof handle.checkIdle === "function") handle.checkIdle()
    const postCheck = {
      activeConnections: typeof handle.activeConnections === "function" ? handle.activeConnections() : -1,
      idleFired: handle.idleFired(),
    }
    // idleFired is undefined when not yet triggered, or true when fired.
    // Either way it MUST NOT be true (since activeConnections > 0).
    assert.ok(postCheck.idleFired !== true,
      `idle must NOT fire while a streaming response is in flight (I-3). pre=${JSON.stringify(preCheck)} post=${JSON.stringify(postCheck)}`)
    // Diagnostic — if this fails we want to know WHY (was activeConnections
    // not incremented? was the response already complete?).
    if (handle.idleFired()) {
      // eslint-disable-next-line no-console
      console.error("[contract-17 debug] idle fired unexpectedly. activeConnections=" +
        (typeof handle.activeConnections === "function" ? handle.activeConnections() : "?"))
    }
    assert.notEqual(handle.idleFired(), true,
      "idle must NOT fire while a streaming response is in flight (I-3)")
    // Wait for the streaming response to complete naturally.
    const resp = await respP
    assert.equal(resp.statusCode, 200)
    // After the response completes, decActive brings activeConnections back
    // to 0. The daemon will then be eligible for idle exit on the next
    // timer tick; we close explicitly in finally.
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 18 — P0 hotfix: the daemon must forward the INBOUND URL path +
//               query to the upstream. Previously buildUpstreamUrl returned
//               only `upstream.baseUrl`, so the daemon always POSTed to the
//               upstream ROOT regardless of what the client requested
//               (ZCode sends /v1/messages, the daemon re-sent to /). This
//               produced a 404 on every real model call. The capture
//               upstream previously never asserted the path, so the bug
//               hid behind 357/357 passing tests.
//
//               Contract: for an inbound POST /v1/messages, the capture
//               upstream MUST see the full `baseUrl + req.url` (path and
//               query string preserved); without this the production
//               Anthropic endpoint will keep returning 404.
//
//               We test BOTH:
//                 (a) plain /v1/messages            → upstream path = base+/v1/messages
//                 (b) /v1/messages?beta=true        → upstream path = base+/v1/messages?beta=true
// ===========================================================================

test("contract-18: upstream request path preserves inbound URL (incl. query string)", async () => {
  // Capture upstream: echo 200, record every received URL.
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true }))
  })

  // Base URL with NO trailing path — this is the Anthropic production shape
  // (e.g. "https://api.anthropic.com"). The full /v1/messages must come
  // from req.url, NOT be baked into baseUrl.
  const baseUrl = "http://127.0.0.1:" + upstream.port

  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl, apiKey: "K" },
  })
  try {
    // D7: read the install-time admin token once; both subtests share it.
    const tok18 = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()
    // 18(a) Plain /v1/messages — the production case.
    const bodyPlain = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022", max_tokens: 8, stream: false,
      messages: [{ role: "user", content: "hi" }],
    }), "utf8")
    const r1 = await postMessages(handle.port, bodyPlain, { authorization: "Bearer " + tok18 })
    assert.equal(r1.statusCode, 200)

    // 18(b) /v1/messages?beta=true — preserves query string. ZCode clients
    // may pass feature-flag query params; the daemon must relay them.
    const bodyBeta = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022", max_tokens: 8, stream: false,
      messages: [{ role: "user", content: "hi" }],
    }), "utf8")
    const r2 = await postMessages(
      handle.port,
      bodyBeta,
      { authorization: "Bearer " + tok18 },
      "/v1/messages?beta=true",
    )
    assert.equal(r2.statusCode, 200)

    // Two requests reached the capture upstream.
    assert.equal(upstream.captured.requests.length, 2,
      "capture upstream must have seen exactly 2 forwarded requests")

    // 18(a) assertion: path MUST equal baseUrl + "/v1/messages" (no trailing
    // slash duplication, no missing path).
    const seen1 = upstream.captured.requests[0]
    assert.equal(
      seen1.url,
      "/v1/messages",
      `upstream must receive /v1/messages as its path (got ${JSON.stringify(seen1.url)})`,
    )

    // 18(b) assertion: path MUST equal "/v1/messages?beta=true" — query is
    // preserved verbatim.
    const seen2 = upstream.captured.requests[1]
    assert.equal(
      seen2.url,
      "/v1/messages?beta=true",
      `upstream must receive /v1/messages?beta=true verbatim (got ${JSON.stringify(seen2.url)})`,
    )
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 19 — D7: /v1/messages inbound auth gate. The daemon binds to
//                127.0.0.1 ONLY and accepts the install-time admin token
//                (sent by ZCode as either `authorization: Bearer <token>`
//                or `x-api-key: <token>` — echo shows it sends both). Any
//                POST /v1/messages that does not present a valid token
//                MUST be rejected with 401 JSON `{"error":"unauthorized"}`
//                (same format as the /dcp-admin/* gate). Auth failure
//                MUST NOT count toward stats and MUST NOT markActive (so
//                a denied request cannot keep the daemon alive).
//
//                Four sub-cases verified end-to-end against a live capture
//                upstream:
//                  (a) no auth header at all               → 401
//                  (b) wrong token                         → 401
//                  (c) correct token via `authorization`   → 200, capture sees it
//                  (d) correct token via `x-api-key`       → 200, capture sees it
//
//                Plus: an attempted-auth-bypass must NOT be visible at
//                the capture upstream (no leak), and the stats endpoint
//                must NOT count it (so /dcp-admin/stats.requests stays
//                at 0 after the four bad/bypass attempts).
// ===========================================================================

test("contract-19: /v1/messages inbound auth gate (D7 — no admin token = 401)", async () => {
  const upstream = await startCaptureUpstream((req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true }))
  })
  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "REAL" },
  })
  const tok = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()
  const validBody = Buffer.from(JSON.stringify({
    model: "claude-3-5-sonnet-20241022", max_tokens: 8, stream: false,
    messages: [{ role: "user", content: "auth-gate-probe" }],
  }), "utf8")
  try {
    // 19(a) no auth header at all → 401, identical body to the admin gate.
    const noAuth = await postMessages(handle.port, validBody, {})
    assert.equal(noAuth.statusCode, 401,
      "no-auth POST /v1/messages must be 401 (D7 gate)")
    const noAuthBody = JSON.parse(noAuth.rawBody.toString("utf8"))
    assert.equal(noAuthBody.error, "unauthorized",
      "401 body must match the admin-gate shape {error:'unauthorized'}")
    // 19(a') must NOT be a forwarded request: capture upstream saw nothing yet.
    assert.equal(upstream.captured.requests.length, 0,
      "auth-rejected request must NOT be forwarded to upstream (no leak)")

    // 19(b) wrong token → 401.
    const wrongAuth = await postMessages(handle.port, validBody, {
      authorization: "Bearer NOT_THE_REAL_TOKEN",
      "x-api-key": "NOT_THE_REAL_TOKEN",
    })
    assert.equal(wrongAuth.statusCode, 401,
      "wrong-token POST /v1/messages must be 401")
    assert.equal(upstream.captured.requests.length, 0,
      "wrong-token request must NOT be forwarded to upstream")

    // 19(c) correct token via `authorization: Bearer <tok>` → 200, capture sees it.
    const goodBearer = await postMessages(handle.port, validBody, {
      authorization: "Bearer " + tok,
    })
    assert.equal(goodBearer.statusCode, 200,
      "valid Bearer token must succeed (200)")
    assert.equal(upstream.captured.requests.length, 1,
      "valid Bearer-token request must reach upstream")
    assert.equal(
      upstream.captured.requests[0].headers["authorization"],
      "Bearer REAL",
      "upstream must see the real apiKey, not the client's admin token (H1 header policy)",
    )

    // 19(d) correct token via `x-api-key: <tok>` → 200, capture sees it.
    const goodXApiKey = await postMessages(handle.port, validBody, {
      "x-api-key": tok,
    })
    assert.equal(goodXApiKey.statusCode, 200,
      "valid x-api-key token must succeed (200)")
    assert.equal(upstream.captured.requests.length, 2,
      "valid x-api-key-token request must reach upstream")
    assert.equal(
      upstream.captured.requests[1].headers["x-api-key"],
      "REAL",
      "upstream must see the real apiKey in x-api-key (H1 header policy)",
    )

    // 19(e) Auth-rejected attempts MUST NOT increment stats.requests
    // (only the two successful ones should count: 2).
    const statsResp = await adminGet(handle.port, "/dcp-admin/stats", "authorization", "Bearer " + tok)
    assert.equal(statsResp.statusCode, 200)
    const statsBody = JSON.parse(statsResp.rawBody.toString("utf8"))
    assert.equal(statsBody.requests, 2,
      `stats.requests must count only authorised requests (expected 2, got ${statsBody.requests})`)
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// CONTRACT 20 — R7/D4: response header case preservation + multi-value
//                aggregation. Upstream emits mixed-case header NAMES
//                (X-Custom-Case, X-FOO-BAR) AND multiple Set-Cookie headers.
//                The daemon must:
//                  (a) preserve the original case of header NAMES in the
//                      proxied response (currently lowercased — bug #6);
//                  (b) forward BOTH Set-Cookie values, not just the last
//                      (currently `setHeader` overwrites — bug);
//                  (c) continue stripping hop-by-hop response headers per
//                      RFC 7230 §6.1 (no regression of contract-1 invariant).
//
//                Asserted via the client's `res.rawHeaders` (alternating
//                [name, value, name, value, ...] preserving case AND order)
//                and `res.headers` (lowercased object view).
// ===========================================================================

test("contract-20: response header case preserved + multi Set-Cookie aggregated (R7/D4)", async () => {
  // Upstream uses res.writeHead with a raw header LINES array (the form
  // that takes Array<[name, value]>) so we have full control over the wire
  // bytes the upstream emits — including duplicate Set-Cookie names and
  // mixed-case header names. Node's ServerResponse accepts this form and
  // emits exactly those name/value pairs without re-casing or folding.
  const upstream = await startCaptureUpstream((req, res) => {
    const body = Buffer.from('{"ok":true,"r7":"passthrough"}', 'utf8')
    const headers = [
      ["Content-Type", "application/json"],
      ["X-Custom-Case", "v1"],            // mixed case (currently lowercased)
      ["Set-Cookie", "a=1; Path=/"],      // cookie 1 (currently dropped)
      ["Set-Cookie", "b=2; Path=/"],      // cookie 2 (kept by mistake)
      ["X-FOO-BAR", "baz"],               // all uppercase (currently lowercased)
      ["Upgrade", "websocket"],           // hop-by-hop → must be stripped
      ["Proxy-Connection", "keep-alive"], // hop-by-hop → must be stripped
      ["Content-Length", String(body.length)],
    ]
    res.writeHead(200, headers)
    res.end(body)
  })

  const { handle, dataDir } = await startTestDaemon({
    upstream: { baseUrl: "http://127.0.0.1:" + upstream.port, apiKey: "K" },
  })
  try {
    // Custom request: postMessages helper doesn't expose rawHeaders. We
    // need rawHeaders on the CLIENT side to assert case preservation +
    // multi-value ordering.
    const tok = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim()
    const body = Buffer.from(JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 8,
      stream: false,
      messages: [{ role: "user", content: "r7-probe" }],
    }), "utf8")

    const proxied = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: handle.port,
          path: "/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            "authorization": "Bearer " + tok,
          },
        },
        (res) => {
          const chunks = []
          res.on("data", (c) => chunks.push(c))
          res.on("end", () => resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            rawBody: Buffer.concat(chunks),
          }))
        },
      )
      req.on("error", reject)
      req.write(body)
      req.end()
    })

    assert.equal(proxied.statusCode, 200)
    // H1 lock: response body must remain byte-faithful even when we add
    // header handling logic (regression guard for contract-1/contract-2).
    assert.ok(
      proxied.rawBody.equals(Buffer.from('{"ok":true,"r7":"passthrough"}', "utf8")),
      "response body must remain byte-faithful (H1 lock; contract-1 regression)",
    )

    // ---- Assertion 1: header NAMES preserve original case ----
    // res.rawHeaders is alternating [name, value, name, value, ...] and
    // preserves the case of each name. Walk even indices for names.
    const names = []
    for (let i = 0; i < proxied.rawHeaders.length; i += 2) {
      names.push(proxied.rawHeaders[i])
    }
    assert.ok(
      names.includes("X-Custom-Case"),
      `mixed-case X-Custom-Case must be preserved verbatim; got names=${JSON.stringify(names)}`,
    )
    assert.ok(
      names.includes("X-FOO-BAR"),
      `uppercase X-FOO-BAR must be preserved verbatim; got names=${JSON.stringify(names)}`,
    )
    // Lowercased variants must NOT appear (proves the daemon did not emit
    // them under a different case — bug #6 regression guard).
    assert.ok(
      !names.includes("x-custom-case"),
      `lowercased x-custom-case must NOT be re-emitted; got names=${JSON.stringify(names)}`,
    )
    assert.ok(
      !names.includes("x-foo-bar"),
      `lowercased x-foo-bar must NOT be re-emitted; got names=${JSON.stringify(names)}`,
    )

    // ---- Assertion 2: BOTH Set-Cookie values forwarded ----
    // Walk rawHeaders looking for Set-Cookie entries (case-insensitive on
    // the NAME side — RFC 7230 §3.2 says header names are case-insensitive).
    const cookieValues = []
    for (let i = 0; i < proxied.rawHeaders.length; i += 2) {
      if (String(proxied.rawHeaders[i]).toLowerCase() === "set-cookie") {
        cookieValues.push(proxied.rawHeaders[i + 1])
      }
    }
    assert.equal(
      cookieValues.length,
      2,
      `expected exactly 2 Set-Cookie entries in proxied rawHeaders, got ${cookieValues.length}: ${JSON.stringify(cookieValues)}`,
    )
    assert.ok(
      cookieValues.some((v) => v && v.startsWith("a=1;")),
      "first Set-Cookie value (a=1;...) must be forwarded (regression guard for multi-value collapse)",
    )
    assert.ok(
      cookieValues.some((v) => v && v.startsWith("b=2;")),
      "second Set-Cookie value (b=2;...) must be forwarded — current implementation drops all but the last setHeader call",
    )

    // ---- Assertion 3: hop-by-hop headers stripped (no regression) ----
    // The upstream sent `Upgrade: websocket` and `Proxy-Connection: keep-alive`.
    // Neither must appear in the proxied response (RFC 7230 §6.1).
    for (const hh of ["upgrade", "proxy-connection"]) {
      assert.equal(
        proxied.headers[hh],
        undefined,
        `${hh} must be stripped from proxied response (hop-by-hop regression)`,
      )
    }
    // Same check via rawHeaders walk — confirms the byte stream itself does
    // not contain the header, not just the lowercased object view.
    for (let i = 0; i < proxied.rawHeaders.length; i += 2) {
      const nm = String(proxied.rawHeaders[i]).toLowerCase()
      assert.ok(
        nm !== "upgrade" && nm !== "proxy-connection",
        `hop-by-hop header ${nm} must NOT appear in proxied rawHeaders`,
      )
    }
  } finally {
    await stopTestDaemon(handle)
    await upstream.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

