// SPDX-License-Identifier: AGPL-3.0-or-later
//
// daemon.mjs — ZCode dcp proxy daemon (H1 byte-faithful passthrough).
//
// Adapted for ZCode from opencode-dcp v3.1.15. There is no direct upstream
// equivalent — DCP's request-forwarding lives in `lib/hooks.ts` (provider
// adapter) and is invoked from the OpenCode client at every chat call. In
// ZCode the equivalent surface is a local HTTP daemon bound to
// `127.0.0.1:<port>` (DESIGN.md D2 / D5 / D7). This module implements:
//
//   * startDaemon({config, dataDir})
//     - POST /v1/messages                 — Anthropic-protocol passthrough
//       (also accepts ?<anything>; the upstream path is fixed).
//     - GET  /dcp-admin/identify         — token-gated identity probe
//     - GET  /dcp-admin/stats            — token-gated stats snapshot
//     - GET  /dcp-admin/state            — token-gated active-session list
//     - GET  /dcp-admin/state/<action>   — token-gated session-state ops
//                                          (sweep|manual|decompress|recompress)
//     - GET  /dcp-admin/health           — open liveness probe
//   * Token generation on first start (crypto.randomBytes(24).hex), stored
//     at `dataDir/<adminTokenFile>` with chmod 0600 best-effort.
//   * EADDRINUSE handling — on bind failure, probe the occupier via
//     /dcp-admin/identify. If the answer identifies as a sibling (matches
//     our token AND advertises `service: "zcode-dcp"`), resolve gracefully
//     (the second startDaemon call throws a tagged error so the caller can
//     decide reuse vs. report; both are acceptable per the brief).
//   * Idle timer — no inbound model request OR admin heartbeat for
//     `proxy.idleTimeoutMin` minutes → graceful close.
//   * H1 fidelity — see passthrough.mjs. This file does NOT mutate the body
//     other than delegating to `pipeline.transformRequest` (which itself
//     preserves every non-messages field by reference) and to
//     `passthrough.forwardRequest` / `passthrough.pipeResponse` for the
//     byte-level transport. Malformed bodies bypass the pipeline entirely
//     (SPEC R15 / hooks.ts:117-123 "shape defence") and are forwarded
//     byte-for-byte without a 500.

import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { transformRequest } from "./pipeline.mjs"
import { forwardRequest, pipeResponse, writeBodyAndEnd } from "./passthrough.mjs"
import {
  sessionFingerprint,
  loadLightState,
  saveLightState,
  markActive,
} from "./session.mjs"
import { Stats, createDebugLogger } from "./stats.mjs"
import { estimateMessageTokens, estimateTokens } from "./tokens.mjs"

const PLUGIN_VERSION = "0.1.0"
const SERVICE_NAME = "zcode-dcp"
const ADMIN_PREFIX = "/dcp-admin/"

// I-1: whitelist of recognised /dcp-admin/state/<action> verbs. Anything
// not in this set yields a 400 (not a silent no-op) so operators can spot
// typos and clients can degrade gracefully.
const STATE_ACTIONS = new Set(["sweep", "manual", "decompress", "recompress"])

// ---------------------------------------------------------------------------
// Admin token bootstrap (first-start only)
// ---------------------------------------------------------------------------

function readOrCreateAdminToken(dataDir, tokenFile) {
  fs.mkdirSync(dataDir, { recursive: true })
  const tokenPath = path.join(dataDir, tokenFile || "admin-token")
  if (fs.existsSync(tokenPath)) {
    try {
      const existing = fs.readFileSync(tokenPath, "utf8").trim()
      if (existing.length > 0) return existing
    } catch {
      /* fall through to regenerate */
    }
    // I-5: token file exists but is empty (or unreadable as non-empty) —
    // surface so operators can see why a fresh token was generated. Don't
    // auto-regenerate silently; warn and overwrite so the daemon can still
    // start (a missing admin token is a worse outage than a logged rotate).
    // eslint-disable-next-line no-console
    console.warn(
      `[daemon] admin token file at ${tokenPath} was empty or unreadable; ` +
      `generating a new token (clients holding the old token will lose access)`,
    )
  }
  const token = crypto.randomBytes(24).toString("hex")
  // I-5: 'wx' fails if the file already exists (no clobber on re-entry),
  // and writes atomically via tmp+rename to avoid partial-file corruption
  // when the daemon is killed mid-write.
  const tmp = `${tokenPath}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(tmp, token, "utf8")
    fs.renameSync(tmp, tokenPath)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[daemon] failed to persist admin token at ${tokenPath}: ${err.message}`)
  }
  try {
    fs.chmodSync(tokenPath, 0o600)
  } catch {
    /* Windows ACLs are different; chmod is best-effort here */
  }
  return token
}

// ---------------------------------------------------------------------------
// Header utilities
// ---------------------------------------------------------------------------

/**
 * Extract the value of a header (case-insensitive) from a Node headers
 * object. Returns null if not present.
 */
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null
  const lower = String(name).toLowerCase()
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === lower) return headers[k]
  }
  return null
}

/**
 * Return true if the incoming request's auth header(s) match `token`.
 * Accepts either `authorization: Bearer <token>` or `x-api-key: <token>`.
 */
function authorizeAdmin(headers, token) {
  if (!token) return false
  const auth = headerValue(headers, "authorization")
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m && m[1] === token) return true
    // Tolerate raw token form (some clients omit the Bearer prefix).
    if (auth.trim() === token) return true
  }
  const x = headerValue(headers, "x-api-key")
  if (typeof x === "string" && x === token) return true
  return false
}

// ---------------------------------------------------------------------------
// Per-fp in-memory state (last upstream usage, last seen, etc.)
// ---------------------------------------------------------------------------

function makeFingerprintState() {
  return {
    lastUsage: null,
    lastSeenAt: 0,
  }
}

function makeSharedState() {
  return {
    fpStates: new Map(), // fp -> makeFingerprintState()
    adminToken: null,
    dataDir: null,
    config: null,
    logger: null,
    idleTimer: null,
    idleTimeoutMs: 0,
    lastHeartbeatAt: 0,
    activeConnections: 0, // I-3: in-flight /v1/messages + admin requests
    // Hooks (test-only):
    now: () => Date.now(),
    onIdle: null,
  }
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

// ---------------------------------------------------------------------------
// POST /v1/messages handler (H1 byte-faithful passthrough + pipeline)
// ---------------------------------------------------------------------------

function buildUpstreamUrl(config, req) {
  const base = config && config.upstream && config.upstream.baseUrl
  if (typeof base !== "string" || base.length === 0) {
    // No upstream configured → throw a clear error so callers see it.
    throw new Error("upstream.baseUrl is not configured (set dcp.jsonc upstream.baseUrl)")
  }
  // Strip any trailing slash so we don't produce "//v1/messages" when the
  // base happens to end in "/" (e.g. operators paste "https://api.x.com/").
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base
  // The inbound `req.url` carries BOTH the path and the query string (Node
  // leaves them concatenated: "/v1/messages?beta=true"). We forward it
  // verbatim — the upstream's URL parser will split path vs. search. Without
  // this concatenation the daemon would POST to the upstream ROOT regardless
  // of what the client requested, which is exactly what produced the P0 404
  // on every real model call (ZCode sends /v1/messages, the daemon re-sent
  // it to /).
  const tail = req && typeof req.url === "string" && req.url.length > 0 ? req.url : "/"
  return trimmed + tail
  // NOTE: This implementation assumes the Anthropic kind, where baseUrl is
  // the origin root and the client supplies the path (e.g. /v1/messages).
  // For a future OpenAI kind, providers often bake a version suffix into
  // baseUrl (e.g. "https://open.bigmodel.cn/api/anthropic/v4"); the kind-
  // specific behaviour MUST be split out then, not assumed here. This is
  // intentionally TODO — the ZCode Anthropic adapter today only emits the
  // Anthropic shape.
  // TODO(openai-kind): split per-kind when a non-Anthropic adapter lands.
}

/**
 * Try to parse the inbound body as JSON for the pipeline. Returns:
 *   { ok: true, parsed, malformed: false }      — parsed successfully
 *   { ok: true, parsed: null, malformed: 'json' } — not JSON
 *   { ok: true, parsed: null, malformed: 'shape' } — JSON but messages missing/non-array
 *
 * The "malformed" classification drives the SPEC R15 fallback path (forward
 * verbatim, no pipeline, no 500).
 */
function classifyBody(rawBody) {
  const text = rawBody.toString("utf8")
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: true, parsed: null, malformed: "json" }
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: true, parsed: null, malformed: "shape" }
  }
  if (!Array.isArray(parsed.messages)) {
    return { ok: true, parsed: null, malformed: "shape" }
  }
  return { ok: true, parsed, malformed: false }
}

/**
 * Reassemble a JSON body whose ONLY mutation was `messages` (the pipeline
 * returns `{...orig, messages: messages'}`). Critically, we DO NOT call
 * `JSON.stringify` here — that would silently re-serialise every field and
 * destroy the F-N-4 byte-faithful contract (e.g. 9007199254740993 would
 * round-trip through a JS Number and lose precision).
 *
 * Instead we splice the `messages` slice in the raw byte buffer, preserving
 * the exact bytes for every other field. The pipeline produces messages in
 * object form (an Array of objects); we serialise it with the same JSON
 * semantics a JS engine would produce for the equivalent literal, but for
 * every OTHER field the bytes are copied verbatim from the original body.
 *
 * Returns a Buffer ready to forward upstream.
 */
function spliceMessages(originalBody, newMessages) {
  const slice = locateMessagesSlice(originalBody)
  if (!slice) {
    // Safety net — should be unreachable since classifyBody already validated.
    return originalBody
  }
  const before = originalBody.slice(0, slice.start)
  const after = originalBody.slice(slice.end + 1)
  const messagesJson = Buffer.from(JSON.stringify(newMessages), "utf8")
  return Buffer.concat([before, messagesJson, after])
}

/**
 * Locate the BYTE boundaries of the `messages` array in a JSON object body.
 * Returns {start, end} (both inclusive, both byte indices into `bodyBuffer`)
 * where bodyBuffer[start] === 0x5b ('[') and bodyBuffer[end] === 0x5d (']').
 * Returns null if no `messages` key is found.
 *
 * Byte-level (not char-level) iteration is mandatory for H1 byte-faithful
 * passthrough: a CJK character in the body occupies 3 UTF-8 bytes but is
 * 1 UTF-16 code unit; char-based scans would corrupt the splice boundary.
 * We walk raw bytes and only call `Buffer.toString("utf8", 0, j+1).length`
 * where we need the byte↔char conversion (key lookup). The walker itself
 * is purely numeric — it never decodes intermediate characters.
 */
function locateMessagesSlice(bodyBuffer) {
  if (!Buffer.isBuffer(bodyBuffer)) return null
  const keyBytes = Buffer.from('"messages":', "utf8")
  // Buffer.indexOf operates on raw bytes — safe for any UTF-8 content.
  const keyIdx = bodyBuffer.indexOf(keyBytes)
  if (keyIdx < 0) return null
  let i = keyIdx + keyBytes.length
  // Skip ASCII whitespace (space, tab, CR, LF) — JSON spec allows any
  // whitespace between key and value.
  while (i < bodyBuffer.length) {
    const b = bodyBuffer[i]
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) break
    i++
  }
  if (i >= bodyBuffer.length || bodyBuffer[i] !== 0x5b /* '[' */) return null
  const start = i
  let depth = 0
  let inStr = false
  let escape = false
  for (let j = start; j < bodyBuffer.length; j++) {
    const b = bodyBuffer[j]
    if (inStr) {
      if (escape) { escape = false; continue }
      if (b === 0x5c /* '\\' */) { escape = true; continue }
      if (b === 0x22 /* '"' */) inStr = false
      continue
    }
    if (b === 0x22) { inStr = true; continue }
    if (b === 0x5b /* '[' */) depth++
    else if (b === 0x5d /* ']' */) { depth--; if (depth === 0) return { start, end: j } }
  }
  return null
}

/**
 * Estimate sent-token count for an outgoing body Buffer (post-pipeline,
 * pre-forward). Used for the `Stats.sentTokens` counter. We sum
 * estimateTokens across the JSON-stringified body for simplicity — this is
 * the same approximation DCP uses in lib/token-utils.ts when the official
 * Anthropic tokenizer is unavailable.
 */
function estimateBodyTokens(bodyBuffer) {
  try {
    const parsed = JSON.parse(bodyBuffer.toString("utf8"))
    let total = 0
    if (Array.isArray(parsed.messages)) {
      for (const m of parsed.messages) total += estimateMessageTokens(m)
    }
    // Plus a small constant for the wrapping envelope (model/system/tools).
    if (typeof parsed.system === "string") total += estimateTokens(parsed.system)
    else if (Array.isArray(parsed.system)) {
      for (const b of parsed.system) {
        if (b && typeof b === "object" && typeof b.text === "string") {
          total += estimateTokens(b.text)
        }
      }
    }
    return total
  } catch {
    // Fall back to a length/4 estimate so the counter never goes negative.
    return Math.round(bodyBuffer.length / 4)
  }
}

async function handleMessages(req, res, shared, rawBody) {
  // 0. D7 auth gate: inbound POST /v1/messages must present the install-time
  //    admin token (ZCode sends it as `authorization: Bearer <token>` AND/OR
  //    `x-api-key: <token>` — echo confirmed). 127.0.0.1 binding alone is
  //    not enough — any local process with curl can reach us. Rejection is
  //    identical in shape to the /dcp-admin/* gate so a single client helper
  //    can handle both. Auth-failures do NOT call markActivity() — a denied
  //    request must not reset the idle timer (otherwise an attacker could
  //    keep the daemon alive indefinitely with bogus requests).
  if (!authorizeAdmin(req.headers, shared.adminToken)) {
    sendJson(res, 401, { error: "unauthorized" })
    return
  }

  // 1. Mark activity: any inbound request resets the idle timer (R11).
  markActivity(shared)

  // 2. Classify the body for the SPEC R15 shape-defence path.
  const cls = classifyBody(rawBody)
  if (cls.malformed) {
    if (shared.logger) {
      shared.logger.log("warn",
        `messages handler: malformed body (${cls.malformed}); forwarding verbatim per SPEC R15`)
    }
    await forwardVerbatim(req, res, shared, rawBody, { fp: null, malformed: cls.malformed })
    return
  }

  // 3. Pipeline: derive fp, load light state, transform.
  const fp = sessionFingerprint(cls.parsed)
  const lightState = loadLightState(shared.dataDir, fp)
  const lastUsage = getLastUsage(shared, fp)
  let transformResult
  try {
    transformResult = transformRequest(cls.parsed, {
      config: shared.config,
      lightState,
      usage: lastUsage,
      dataDir: shared.dataDir,
      cwd: "",
    })
  } catch (err) {
    // Pipeline failure is logged but should not 500 the client. Fall back
    // to verbatim passthrough so the user can keep talking to the model.
    if (shared.logger) shared.logger.log("error", "pipeline transform failed: " + (err && err.message))
    await forwardVerbatim(req, res, shared, rawBody, { fp, malformed: "pipeline-throw" })
    return
  }

  // 4. Reassemble the body buffer (byte-faithful splice of messages).
  let forwardedBody
  try {
    forwardedBody = spliceMessages(rawBody, transformResult.body.messages)
  } catch (err) {
    // Splice failure means the body shape is incompatible (e.g. malformed
    // JSON, or no messages key — though classifyBody should have caught
    // both). Fall back to verbatim so the user keeps talking to the model.
    if (shared.logger) shared.logger.log("warn",
      `spliceMessages failed: ${err && err.message}; falling back to verbatim`)
    await forwardVerbatim(req, res, shared, rawBody, { fp, malformed: "splice-fail" })
    return
  }

  // 5. Stats: estimate sent/saved.
  const stats = new Stats({ dataDir: shared.dataDir, fp })
  stats.incr("requests", 1)
  stats.incr("sentTokens", estimateBodyTokens(forwardedBody))
  if (transformResult.metrics && typeof transformResult.metrics.savedTokensEst === "number") {
    stats.incr("savedTokens", transformResult.metrics.savedTokensEst)
  }
  if (transformResult.metrics && transformResult.metrics.byStrategy) {
    const bs = transformResult.metrics.byStrategy
    if (typeof bs.dedup === "number") stats.incr("byStrategy.dedup", bs.dedup)
    if (typeof bs.purge === "number") stats.incr("byStrategy.purge", bs.purge)
    if (typeof bs.compress === "number") stats.incr("byStrategy.compress", bs.compress)
    if (typeof bs.sweep === "number") stats.incr("byStrategy.sweep", bs.sweep)
  }
  try {
    stats.snapshot()
  } catch (err) {
    if (shared.logger) shared.logger.log("warn", "stats snapshot failed: " + (err && err.message))
  }

  // 6. Mark active + save light state (if pipeline returned updates).
  try { markActive(shared.dataDir, fp) } catch (err) {
    if (shared.logger) shared.logger.log("warn", `markActive failed for fp=${fp}: ${err && err.message}`)
  }
  if (transformResult.lightStateUpdates) {
    const merged = { ...lightState, ...transformResult.lightStateUpdates }
    try { saveLightState(shared.dataDir, fp, merged) } catch (err) {
      if (shared.logger) shared.logger.log("warn", `saveLightState failed for fp=${fp}: ${err && err.message}`)
    }
  }

  // 7. Forward upstream + tee usage. CRITICAL ORDERING: attach pipeResponse
  // BEFORE writing the body or calling end(), otherwise an upstream that
  // responds immediately (the common case for small Anthropic requests) can
  // emit data/end before our listeners are wired up — we'd drop the entire
  // response on the floor and the client would hang until socket timeout.
  let upstreamReq
  try {
    const upstreamUrl = buildUpstreamUrl(shared.config, req)
    const realKey = (shared.config.upstream && shared.config.upstream.apiKey) || ""
    upstreamReq = forwardRequest(upstreamUrl, req.headers, realKey)
  } catch (err) {
    // Synchronous failure — bad URL scheme, etc. Don't 500: forward the
    // raw body verbatim (the upstream may be reachable on a different URL).
    if (shared.logger) shared.logger.log("warn",
      `forwardRequest failed synchronously: ${err && err.message}; falling back to verbatim`)
    await forwardVerbatim(req, res, shared, rawBody, { fp, malformed: "forward-init" })
    return
  }
  pipeResponse(upstreamReq, res, (usage) => {
    if (!usage) return
    setLastUsage(shared, fp, usage)
    if (shared.logger) shared.logger.log("debug", `usage tee fp=${fp} ${JSON.stringify(usage)}`)
  })
  try {
    writeBodyAndEnd(upstreamReq, forwardedBody)
  } catch (err) {
    // write() can throw if the socket is already closed (e.g. upstream
    // errored between forwardRequest() and our write). pipeResponse has
    // already responded to the client; we just need to log and stop.
    if (shared.logger) shared.logger.log("warn",
      `upstream write/end failed: ${err && err.message}`)
  }

  // 8. Debug log (sanitized) — best effort.
  if (shared.logger) {
    try {
      shared.logger.logRequest(fp, cls.parsed, transformResult.body, transformResult.metrics)
    } catch (err) {
      if (shared.logger) shared.logger.log("warn",
        `logRequest failed: ${err && err.message}`)
    }
  }
}

/**
 * Forward the inbound body to upstream without any pipeline transformation
 * (used for the malformed-body fallback path). C-3: synchronously-throwing
 * forwardRequest paths are wrapped — a bad upstream URL must not produce
 * 500 (the verbatim invariant says: malformed input goes UPSTREAM UNTOUCHED,
 * not refused by the daemon).
 */
async function forwardVerbatim(req, res, shared, rawBody, opts) {
  let upstreamReq
  try {
    const upstreamUrl = buildUpstreamUrl(shared.config, req)
    const realKey = (shared.config.upstream && shared.config.upstream.apiKey) || ""
    upstreamReq = forwardRequest(upstreamUrl, req.headers, realKey)
  } catch (err) {
    if (shared.logger) shared.logger.log("error",
      `forwardVerbatim forwardRequest failed: ${err && err.message}\n${err && err.stack}`)
    if (!res.writableEnded) {
      try {
        sendJson(res, 502, {
          error: "upstream_init_failed",
          message: err && err.message,
        })
      } catch { /* ignore */ }
    }
    return
  }
  pipeResponse(upstreamReq, res)
  try {
    writeBodyAndEnd(upstreamReq, rawBody)
  } catch (err) {
    if (shared.logger) shared.logger.log("warn",
      `forwardVerbatim write/end failed: ${err && err.message}`)
  }
  if (opts.fp) {
    try { markActive(shared.dataDir, opts.fp) } catch (err) {
      if (shared.logger) shared.logger.log("warn", `markActive failed: ${err && err.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Per-fp usage store
// ---------------------------------------------------------------------------

function getLastUsage(shared, fp) {
  const st = shared.fpStates.get(fp)
  return st && st.lastUsage ? st.lastUsage : null
}

function setLastUsage(shared, fp, usage) {
  let st = shared.fpStates.get(fp)
  if (!st) { st = makeFingerprintState(); shared.fpStates.set(fp, st) }
  st.lastUsage = usage
  st.lastSeenAt = shared.now()
}

// ---------------------------------------------------------------------------
// Activity / idle timer
// ---------------------------------------------------------------------------

function markActivity(shared) {
  shared.lastHeartbeatAt = shared.now()
  scheduleIdleCheck(shared)
}

function scheduleIdleCheck(shared) {
  if (!shared.idleTimeoutMs) return
  if (shared.idleTimer) {
    clearTimeout(shared.idleTimer)
    shared.idleTimer = null
  }
  shared.idleTimer = setTimeout(() => {
    // I-3: don't kill the daemon while a request is still streaming. Idle
    // exit is conditional on (a) no heartbeat since this timer was set AND
    // (b) zero active in-flight connections. Without this guard the daemon
    // would close mid-SSE-stream on a long-running model response.
    const idleFor = shared.now() - shared.lastHeartbeatAt
    if (idleFor >= shared.idleTimeoutMs && shared.activeConnections === 0 && !shared.idleFired) {
      shared.idleFired = true
      if (shared.onIdle) shared.onIdle()
      // Graceful close — caller (startDaemon) listens for `close`.
      try { shared.server && shared.server.close() } catch { /* ignore */ }
      return
    }
    // Either a heartbeat landed during this tick, or a connection is still
    // in flight. Re-arm — the next tick will re-evaluate. (activeConnections
    // naturally drops to 0 when the in-flight responses finish, at which
    // point the next tick will exit.)
    scheduleIdleCheck(shared)
  }, shared.idleTimeoutMs)
  // Unref so the timer doesn't hold the process alive on its own.
  if (shared.idleTimer && typeof shared.idleTimer.unref === "function") {
    shared.idleTimer.unref()
  }
}

/**
 * Increment / decrement the in-flight connection counter. The counter is
 * exposed to the idle timer so long-running responses don't get cut off.
 */
function incActive(shared) { shared.activeConnections++ }
function decActive(shared) {
  if (shared.activeConnections > 0) shared.activeConnections--
}

/**
 * Drop fp entries whose `lastSeenAt` is older than the idle window. Keeps
 * the in-memory map bounded so a long-running daemon doesn't accumulate
 * session state for sessions that will never come back.
 */
function pruneStaleFingerprints(shared) {
  if (!shared.idleTimeoutMs) return
  const cutoff = shared.now() - shared.idleTimeoutMs
  for (const [fp, st] of shared.fpStates.entries()) {
    if (!st || st.lastSeenAt === 0 || st.lastSeenAt < cutoff) {
      shared.fpStates.delete(fp)
    }
  }
}

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8")
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.setHeader("content-length", payload.length)
  res.end(payload)
}

function sendText(res, status, text) {
  const payload = Buffer.from(text, "utf8")
  res.statusCode = status
  res.setHeader("content-type", "text/plain; charset=utf-8")
  res.setHeader("content-length", payload.length)
  res.end(payload)
}

function handleAdminIdentify(req, res, shared) {
  if (!authorizeAdmin(req.headers, shared.adminToken)) {
    sendJson(res, 401, { error: "unauthorized" })
    return
  }
  markActivity(shared)
  sendJson(res, 200, { service: SERVICE_NAME, version: PLUGIN_VERSION })
}

function handleAdminStats(req, res, shared) {
  if (!authorizeAdmin(req.headers, shared.adminToken)) {
    sendJson(res, 401, { error: "unauthorized" })
    return
  }
  markActivity(shared)
  // Aggregate all-time stats from dataDir/stats-all.json (Stats writes this).
  const allTimePath = path.join(shared.dataDir, "stats-all.json")
  let all = {
    sentTokens: 0, savedTokens: 0,
    byStrategy: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
    compressRuns: 0, requests: 0,
  }
  try {
    const raw = fs.readFileSync(allTimePath, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") all = { ...all, ...parsed }
  } catch {
    /* fresh daemon — no stats yet */
  }
  // Plus a snapshot of per-fp states (last usage per session).
  const fps = []
  for (const [fp, st] of shared.fpStates.entries()) {
    fps.push({
      fp,
      lastSeenAt: st.lastSeenAt,
      lastUsage: st.lastUsage,
    })
  }
  sendJson(res, 200, { ...all, sessions: fps })
}

function handleAdminState(req, res, shared) {
  if (!authorizeAdmin(req.headers, shared.adminToken)) {
    sendJson(res, 401, { error: "unauthorized" })
    return
  }
  markActivity(shared)
  const activePath = path.join(shared.dataDir, "active-sessions.json")
  let table = {}
  try {
    table = JSON.parse(fs.readFileSync(activePath, "utf8")) || {}
  } catch { /* no active table yet */ }
  const now = shared.now()
  const sessions = []
  for (const [fp, entry] of Object.entries(table)) {
    if (entry && typeof entry.lastSeenTs === "number" && now - entry.lastSeenTs < 30 * 60 * 1000) {
      sessions.push({ fp, lastSeenTs: entry.lastSeenTs })
    }
  }
  sessions.sort((a, b) => b.lastSeenTs - a.lastSeenTs)
  sendJson(res, 200, { sessions })
}

function handleAdminStateAction(req, res, shared, action, queryParams) {
  if (!authorizeAdmin(req.headers, shared.adminToken)) {
    sendJson(res, 401, { error: "unauthorized" })
    return
  }
  if (!STATE_ACTIONS.has(action)) {
    // I-1: unknown action → 400 with the whitelist enumerated so clients
    // can self-correct. The legacy text/plain 401 is preserved for the
    // auth-failure case above; here it's a shape error, not auth.
    sendJson(res, 400, {
      error: "unknown_action",
      action,
      allowed: [...STATE_ACTIONS],
    })
    return
  }
  markActivity(shared)
  // Find the most recently active session.
  const activePath = path.join(shared.dataDir, "active-sessions.json")
  let table = {}
  try { table = JSON.parse(fs.readFileSync(activePath, "utf8")) || {} } catch { /* no table */ }
  const now = shared.now()
  let latestFp = null
  let latestTs = 0
  for (const [fp, entry] of Object.entries(table)) {
    if (entry && typeof entry.lastSeenTs === "number" && entry.lastSeenTs > latestTs && now - entry.lastSeenTs < 30 * 60 * 1000) {
      latestFp = fp
      latestTs = entry.lastSeenTs
    }
  }
  if (!latestFp) {
    sendJson(res, 404, { error: "no_active_session" })
    return
  }
  let ls
  try {
    ls = loadLightState(shared.dataDir, latestFp)
  } catch (err) {
    if (shared.logger) shared.logger.log("warn",
      `loadLightState failed for fp=${latestFp}: ${err && err.message}`)
    sendJson(res, 500, { error: "load_state_failed", message: err && err.message })
    return
  }
  if (action === "sweep") {
    // Mark all currently-resolvable tool_use ids as "sweep" — the pipeline
    // will see lightState.sweepToolCallIds and merge them into the prune
    // set on the next request. (Re-derived from messages each pass.)
    const sweepIds = []
    const arr = Array.isArray(ls.anchors && ls.anchors.context) ? ls.anchors.context : []
    // The sweep set is recomputed each request from the messages; here we
    // just signal "re-derive now" by clearing the dedup cache anchor and
    // letting the pipeline's planPrune recompute. The MCP `sweep` tool
    // passes the explicit ids; the admin endpoint acts as the manual sweep
    // trigger — its effect is "drop any dedup cache hits on next pass".
    if (!Array.isArray(ls.sweepToolCallIds)) ls.sweepToolCallIds = []
    ls.sweepToolCallIds.length = 0 // reset so the next pipeline pass re-runs
    void sweepIds
  } else if (action === "manual") {
    // I-2 (task-13 fix): accept an optional `?enabled=true|false` query param
    // (set by MCP `dcp_manual` tool) so the daemon itself becomes the
    // single-writer for `manualMode`. Without this, the MCP server had to
    // race-read the admin response and write the light-state file directly,
    // which lost to concurrent requests (old read overwrote the new value).
    const enabledParam = queryParams && queryParams.enabled
    if (enabledParam === undefined) {
      // Backwards-compatible legacy: missing param → ON (matches prior
      // /dcp-admin/state/manual behaviour).
      ls.manualMode = true
    } else {
      // Accept "true"/"1"/"on" (case-insensitive) for ON; everything else
      // is OFF. We deliberately do NOT accept "false" stringification of
      // truthy boolean values — only the explicit "false"/"0"/"off".
      const v = String(enabledParam).toLowerCase()
      ls.manualMode = v === "true" || v === "1" || v === "on"
    }
  } else if (action === "decompress") {
    // CAP-20 decompress: clear the operator's exclusion list so future
    // passes re-derive all blocks. The pipeline reads
    // lightState.decompressBlockIds via deriveBlocks(messages, refs, cfg, {excludedBlockIds}).
    if (!Array.isArray(ls.decompressBlockIds)) ls.decompressBlockIds = []
    ls.decompressBlockIds.length = 0
  } else if (action === "recompress") {
    ls.decompressBlockIds = []
    ls.manualMode = false
  }
  try {
    saveLightState(shared.dataDir, latestFp, ls)
  } catch (err) {
    if (shared.logger) shared.logger.log("warn",
      `saveLightState failed for fp=${latestFp}: ${err && err.message}`)
    sendJson(res, 500, { error: "save_state_failed", message: err && err.message })
    return
  }
  sendJson(res, 200, { ok: true, fp: latestFp, action, lightState: ls })
}

function handleAdminHealth(req, res, shared) {
  // Health is intentionally OPEN (no token) — used by mcp-server heartbeat
  // and any operator liveness probe.
  markActivity(shared)
  sendJson(res, 200, { ok: true, service: SERVICE_NAME, uptimeMs: process.uptime() * 1000 })
}

// ---------------------------------------------------------------------------
// EADDRINUSE self-probe
// ---------------------------------------------------------------------------

/**
 * Probe an existing daemon on `host:port`. Returns:
 *   { sibling: true, version }    if the occupier identifies as zcode-dcp
 *                                 AND the token matches
 *   { sibling: false, statusCode } if a response was received but the
 *                                  occupier is not a sibling (reason implicit)
 *   { sibling: false, reason: "timeout", error }  if the probe timed out
 *   { sibling: false, reason: "401", statusCode } if the probe got 401
 *                                                 (different token)
 *   { sibling: false, reason: "unreachable", error } if no response / refused
 *
 * I-4: timeout is configurable via config.proxy.adminProbeTimeoutMs (default
 * 1500 ms). The reason field lets the caller produce a precise remediation
 * hint without parsing free-text error messages.
 */
function probeExistingDaemon(host, port, token, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path: ADMIN_PREFIX + "identify",
        method: "GET",
        headers: token
          ? { authorization: "Bearer " + token, "x-api-key": token }
          : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const reason = res.statusCode === 401 ? "401" : `status_${res.statusCode}`
            resolve({ sibling: false, statusCode: res.statusCode, reason })
            return
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
            if (body && body.service === SERVICE_NAME) {
              resolve({ sibling: true, version: body.version })
            } else {
              resolve({ sibling: false, statusCode: 200, reason: "wrong_service" })
            }
          } catch {
            resolve({ sibling: false, statusCode: 200, reason: "bad_json" })
          }
        })
      },
    )
    req.on("error", (err) => resolve({
      sibling: false,
      reason: err.code === "ECONNREFUSED" ? "refused" : "unreachable",
      error: err.message,
    }))
    req.on("timeout", () => {
      req.destroy()
      resolve({ sibling: false, reason: "timeout", error: "probe timed out after " + timeoutMs + "ms" })
    })
    req.end()
  })
}

// ---------------------------------------------------------------------------
// startDaemon — the public entry point
// ---------------------------------------------------------------------------

/**
 * Start the proxy daemon. Resolves with a handle `{ port, server, close, ... }`
 * once the server is listening. Throws a tagged `EADDRINUSE` error if the
 * port is occupied by a non-sibling; if the occupier IS a sibling, throws
 * a `EADDRINUSE_SIBLING` error so the caller can decide to reuse vs.
 * report (per the brief: "自家→exit 0 复用").
 *
 * @param {{config:object, dataDir:string}} opts
 * @returns {Promise<{port:number, server:http.Server, close:(cb)=>void, ...}>}
 */
export async function startDaemon({ config, dataDir }) {
  if (!config || typeof config !== "object") throw new Error("startDaemon: config required")
  if (!dataDir) throw new Error("startDaemon: dataDir required")
  fs.mkdirSync(dataDir, { recursive: true })

  const adminToken = readOrCreateAdminToken(dataDir, config.proxy && config.proxy.adminTokenFile)
  const shared = makeSharedState()
  shared.adminToken = adminToken
  shared.dataDir = dataDir
  shared.config = config
  shared.logger = createDebugLogger(dataDir, !!(config && config.debug))
  shared.idleTimeoutMs = (config.proxy && config.proxy.idleTimeoutMin)
    ? Math.max(1, Math.floor(config.proxy.idleTimeoutMin)) * 60 * 1000
    : 30 * 60 * 1000
  // I-4: admin probe timeout. Stored on shared so handleAdminStateAction
  // and the EADDRINUSE path can reach it. Default 1500ms (configurable).
  shared.adminProbeTimeoutMs = (config.proxy && Number.isFinite(config.proxy.adminProbeTimeoutMs))
    ? Math.max(100, Math.floor(config.proxy.adminProbeTimeoutMs))
    : 1500
  shared.lastHeartbeatAt = shared.now()

  const server = http.createServer()
  shared.server = server

  // Track last-request state per fp for idle / heartbeat math.
  server.on("request", async (req, res) => {
    incActive(shared)
    // I-3: keep activeConnections incremented for the FULL response
    // lifecycle. handleMessages() returns as soon as the upstream request
    // is sent (fire-and-forget pipeResponse); the actual response bytes
    // stream back asynchronously. decActive on 'finish'/'close' so the
    // idle timer never sees 0 connections mid-stream. A WeakSet tracks
    // which responses have already been decremented so the finally block
    // (synchronous-path completion) and the lifecycle listener (streaming
    // completion) never both decrement the same connection.
    if (!shared._activeDecremented) shared._activeDecremented = new WeakSet()
    let decremented = false
    const safeDec = () => {
      if (decremented) return
      decremented = true
      shared._activeDecremented.add(res)
      decActive(shared)
    }
    res.once("finish", safeDec)
    res.once("close", safeDec)
    try {
      try {
        const url = req.url || "/"
        if (url.startsWith("/v1/messages")) {
          const rawBody = await readBodyBuffer(req)
          await handleMessages(req, res, shared, rawBody)
          return
        }
        if (url === "/dcp-admin/identify") return handleAdminIdentify(req, res, shared)
        if (url === "/dcp-admin/stats") return handleAdminStats(req, res, shared)
        if (url === "/dcp-admin/state") return handleAdminState(req, res, shared)
        if (url.startsWith(ADMIN_PREFIX + "state/")) {
          const tail = url.slice((ADMIN_PREFIX + "state/").length)
          const [action, queryStr = ""] = tail.split("?", 2)
          // Parse URL-encoded query parameters into a plain object. Repeats
          // overwrite (last-write-wins); values are decoded via decodeURIComponent
          // so %20 etc. round-trip correctly. We deliberately do NOT parse
          // arrays — every state-action query in this plugin is flat.
          const queryParams = {}
          if (queryStr) {
            for (const pair of queryStr.split("&")) {
              if (!pair) continue
              const eq = pair.indexOf("=")
              const rawKey = eq === -1 ? pair : pair.slice(0, eq)
              const rawVal = eq === -1 ? "" : pair.slice(eq + 1)
              try {
                queryParams[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal)
              } catch {
                // Malformed encoding → ignore this pair; don't crash the handler.
              }
            }
          }
          return handleAdminStateAction(req, res, shared, action, queryParams)
        }
        if (url === "/dcp-admin/health") return handleAdminHealth(req, res, shared)
        // Unknown path — 404 with a JSON body for consistency.
        sendJson(res, 404, { error: "not_found", path: url })
      } catch (err) {
        if (shared.logger) shared.logger.log("error", "request handler threw: " + (err && err.message))
        if (!res.writableEnded) {
          try {
            sendJson(res, 500, { error: "internal_error", message: err && err.message })
          } catch { /* ignore */ }
        }
      }
    } finally {
      // Synchronous-path completion: if the response has already finished
      // (admin endpoints, error paths) by the time we get here, the
      // finish/close listener above already called safeDec. Otherwise the
      // listener is the path that will eventually fire.
      if (res.writableEnded || res.destroyed) safeDec()
    }
  })

  const port = (config.proxy && typeof config.proxy.port === "number")
    ? config.proxy.port
    : 8367

  // Bind (with EADDRINUSE handling).
  await new Promise((resolve, reject) => {
    const onError = async (err) => {
      server.removeListener("listening", onListening)
      if (err && err.code === "EADDRINUSE") {
        const probe = await probeExistingDaemon(
          "127.0.0.1", port, adminToken, shared.adminProbeTimeoutMs,
        )
        if (probe.sibling) {
          const e = new Error(
            `EADDRINUSE_SIBLING: another zcode-dcp daemon already occupies 127.0.0.1:${port} (version=${probe.version}); refusing to start a second instance`,
          )
          e.code = "EADDRINUSE_SIBLING"
          e.port = port
          reject(e)
          return
        }
        // I-4: precise reason from the probe (timeout / 401 / refused / etc.)
        // so operators get an actionable error message instead of a generic one.
        const reasonText = probe.reason === "timeout"
          ? `probe timed out after ${shared.adminProbeTimeoutMs}ms`
          : probe.reason === "401"
            ? "occupier returned 401 (wrong token / not us)"
            : probe.reason === "refused"
              ? "occupier refused connection"
              : probe.reason === "wrong_service"
                ? "occupier responded but did not advertise as zcode-dcp"
                : probe.error
                  ? `no usable response (${probe.error})`
                  : `occupier status ${probe.statusCode}`
        const e = new Error(
          `EADDRINUSE: 127.0.0.1:${port} is in use and the occupier is not a sibling zcode-dcp daemon (${reasonText}). ` +
            `Either stop the existing process or change dcp.jsonc -> proxy.port to a free port.`,
        )
        e.code = "EADDRINUSE"
        e.port = port
        e.probeReason = probe.reason
        reject(e)
        return
      }
      reject(err)
    }
    const onListening = () => {
      server.removeListener("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, "127.0.0.1")
  })

  // Idle-timer bookkeeping after a successful bind.
  scheduleIdleCheck(shared)

  const addr = server.address()
  return {
    port: typeof addr === "object" && addr ? addr.port : port,
    server,
    close(cb) {
      if (shared.idleTimer) { clearTimeout(shared.idleTimer); shared.idleTimer = null }
      server.close(() => { if (cb) cb() })
    },
    // Test hooks (no-op in production):
    setClock(fn) {
      if (typeof fn === "function") shared.now = fn
    },
    checkIdle() {
      // Manually trigger an idle-deadline check (used by tests to fast-forward
      // past the deadline without waiting for the real setTimeout). The
      // activeConnections guard mirrors scheduleIdleCheck: never kill mid-
      // stream even when the wall clock has passed the deadline.
      if (!shared.idleTimeoutMs) return
      if (shared.idleFired === true) return
      const idleFor = shared.now() - shared.lastHeartbeatAt
      if (idleFor >= shared.idleTimeoutMs && shared.activeConnections === 0) {
        shared.idleFired = true
        if (shared.onIdle) shared.onIdle()
        try { shared.server && shared.server.close() } catch { /* ignore */ }
      }
    },
    idleFired: () => shared.idleFired,
    activeConnections: () => shared.activeConnections,
  }
}

// ---------------------------------------------------------------------------
// Internal exports (for tests + future task-13 cross-module wiring)
// ---------------------------------------------------------------------------

export const __test_internals = {
  readOrCreateAdminToken,
  authorizeAdmin,
  classifyBody,
  spliceMessages,
  locateMessagesSlice,
  estimateBodyTokens,
  probeExistingDaemon,
  buildUpstreamUrl,
}
