// SPDX-License-Identifier: AGPL-3.0-or-later
//
// mcp-server.mjs — ZCode MCP stdio server for the zcode-dcp plugin (PLAN
// task-13). This is the final piece of the ZCode-side puzzle: it is the
// tool surface through which the model (and the user, via slash-commands)
// interact with the DCP proxy daemon. The server itself is a thin glue
// layer — all the heavy lifting lives in:
//
//   * proxy/daemon.mjs        — HTTP admin endpoints + byte-faithful passthrough
//   * proxy/compress.mjs      — validateCompressArgs + (MCP-side) schema mirror
//   * proxy/prompts.mjs       — toolDescription(mode, prompts)
//   * proxy/config.mjs        — loadConfig + DEFAULT_CONFIG
//
// REFERENCE: the stdio INPUT parser (Content-Length + bare-JSON-line
// fallback) is copied verbatim from the ZCode example-plugin
// `mcp/hello-server.mjs` (Apache-2.0 licensed sample), then adapted for our
// tool set. The example plugin's framing is the canonical "two modes" idiom
// ZCode clients can SEND, so we honour both for input compatibility.
//
// OUTPUT framing (2026-09-13 fix, P0 8.6): the server writes newline-
// delimited JSON — one JSON object per line, terminated by '\n', with NO
// Content-Length header. ZCode's MCP client reads strictly this shape per
// the MCP stdio spec; emitting Content-Length framed output caused the
// initialize handshake to time out after 60s and the plugin never
// connected (verified by the user in 8.6 testing — same log pattern as
// the official example-plugin, so the bug was ours, not the client).
//
// Architecture:
//
//   stdio (MCP client)
//        │
//        ▼
//   mcp-server.mjs  ──── spawns/keeps-alive ────▶  proxy/daemon.mjs (HTTP)
//        │                                                ▲
//        └─── tools/call ── admin HTTP ──────────────────┘
//
// Public tools:
//
//   compress   — validateCompressArgs gate → acceptance confirmation
//                (manualMode gate returns DCP verbatim error text)
//   dcp_stats      — admin /dcp-admin/stats
//   dcp_context    — admin /dcp-admin/stats + light-state read
//   dcp_sweep      — admin /dcp-admin/state/sweep
//   dcp_manual     — admin /dcp-admin/state/manual (on|off)
//   dcp_decompress — admin /dcp-admin/state/decompress
//   dcp_recompress — admin /dcp-admin/state/recompress
//
// Compress is hidden when config.compress.permission === "deny" (CAP-04).
//
// The DCP verbatim manual-mode error string is from opencode-dcp
// lib/compress/pipeline.ts:46 (compress/pipeline.ts source line number is
// preserved here for reviewer cross-check; the text is reproduced verbatim
// because the DCP upstream also ships it verbatim):

const DCP_MANUAL_MODE_ERROR =
  "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context."

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { getVersion } from "../proxy/version.mjs"

// Dynamic imports of project modules (resolved relative to this file). The
// import paths match the dependency contract specified in PLAN task-13:
// compress.mjs exports validateCompressArgs; prompts.mjs exports
// toolDescription + loadPrompts; config.mjs exports loadConfig.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = process.env.DCP_PLUGIN_ROOT || path.resolve(__dirname, "..")
const PLUGIN_DATA = process.env.DCP_PLUGIN_DATA || path.join(PLUGIN_ROOT, "data")
const COMPRESS_JS = path.join(PLUGIN_ROOT, "proxy", "compress.mjs")
const PROMPTS_JS = path.join(PLUGIN_ROOT, "proxy", "prompts.mjs")
const CONFIG_JS = path.join(PLUGIN_ROOT, "proxy", "config.mjs")
const DAEMON_JS = path.join(PLUGIN_ROOT, "proxy", "daemon.mjs")
const DAEMON_LAUNCHER_JS = path.join(PLUGIN_ROOT, "mcp", "daemon-launcher.mjs")

// Test-only hook: allow the test harness to override the keepalive interval
// (production default is 15000 ms per R11). When DCP_TEST_KEEPALIVE_MS is
// set, the setInterval period short-circuits — the daemon is probed that
// often. Also lets the test pin the daemon's port ahead of time.
const KEEPALIVE_MS = Number(process.env.DCP_TEST_KEEPALIVE_MS) || 15000

// ---------------------------------------------------------------------------
// Server info + tool registry (built at startup)
// ---------------------------------------------------------------------------

// R9 / D10: version comes from the plugin manifest via getVersion() so
// there's exactly one source of truth (the .zcode-plugin/plugin.json file).
const SERVER_INFO = Object.freeze({
  name: "zcode-dcp",
  version: getVersion(),
})

// ---------------------------------------------------------------------------
// MCP stdio framing.
//
// INPUT  — accepts BOTH Content-Length framed (RFC-style) and bare
//          newline-delimited JSON, per the ZCode example-plugin
//          hello-server.mjs:40-46, 122-154 idiom (Apache-2.0). The parser
//          below mirrors that two-mode shape for compatibility with
//          whichever framing the client sends.
//
// OUTPUT — strictly newline-delimited JSON: one JSON object per line,
//          terminated by '\n', with NO Content-Length header. This is the
//          MCP stdio spec shape that ZCode's MCP client reads. Emitting
//          Content-Length here caused P0 8.6 — the initialize handshake
//          timed out after 60s and the plugin never connected.
// ---------------------------------------------------------------------------

function writeMessage(message) {
  // Line-delimited JSON per MCP stdio spec: one object per '\n'-terminated
  // line, no framing header. The client concatenates bytes and splits on
  // '\n' to recover each message.
  process.stdout.write(JSON.stringify(message) + "\n")
}

function ok(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result })
}

function fail(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  })
}

// ---------------------------------------------------------------------------
// Compress tool schema (mirror of proxy/compress.mjs validateCompressArgs +
// DCP range.ts:29-54 / message.ts:16-39). We expose JSON-Schema so clients
// can introspect the parameter shape via tools/list.
// ---------------------------------------------------------------------------

function compressInputSchema(mode) {
  const m = mode === "message" ? "message" : "range"
  if (m === "message") {
    return {
      type: "object",
      required: ["topic", "content"],
      properties: {
        topic: {
          type: "string",
          description: "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'",
        },
        content: {
          type: "array",
          description: "Batch of individual message summaries to create in one tool call",
          items: {
            type: "object",
            required: ["messageId", "topic", "summary"],
            properties: {
              messageId: { type: "string", description: "Raw message ID to compress (e.g. m0001)" },
              topic: { type: "string", description: "Short label (3-5 words) for this one message summary" },
              summary: { type: "string", description: "Complete technical summary replacing that one message" },
            },
          },
        },
      },
    }
  }
  return {
    type: "object",
    required: ["topic", "content"],
    properties: {
      topic: {
        type: "string",
        description: "Short label (3-5 words) for display - e.g., 'Auth System Exploration'",
      },
      content: {
        type: "array",
        description: "One or more ranges to compress, each with start/end boundaries and a summary",
        items: {
          type: "object",
          required: ["startId", "endId", "summary"],
          properties: {
            startId: { type: "string", description: "Message or block ID marking the beginning of range (e.g. m0001, b2)" },
            endId: { type: "string", description: "Message or block ID marking the end of range (e.g. m0012, b5)" },
            summary: { type: "string", description: "Complete technical summary replacing all content in range" },
          },
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

/**
 * Build the registered tools list for tools/list responses. Compress is
 * omitted when config.compress.permission === "deny".
 *
 * @param {{config:object, prompts:object}} env
 * @returns {Array<object>}
 */
async function buildToolsList(env) {
  const config = env && env.config ? env.config : null
  const prompts = env && env.prompts ? env.prompts : null
  const compressMode = config && config.compress && config.compress.mode === "message"
    ? "message"
    : "range"
  const tools = []

  // Compress — registered unless permission is "deny".
  const perm = config && config.compress && config.compress.permission
  if (perm !== "deny") {
    let description
    try {
      // Lazy-load prompts/toolDescription only when compress is enabled;
      // permission="allow" || "ask" both surface the tool description.
      const mod = await import(pathToFileUrl(PROMPTS_JS))
      description = mod.toolDescription(compressMode, prompts || {}, config || {})
    } catch (err) {
      // Don't crash tools/list if prompts fail to load — return a minimal
      // fallback description so the client can still see the tool exists.
      description = "Compress ranges of conversation into summaries (prompts unavailable: " + (err && err.message) + ")"
    }
    tools.push({
      name: "compress",
      description,
      inputSchema: compressInputSchema(compressMode),
    })
  }

  tools.push({
    name: "dcp_stats",
    description: "Show DCP usage stats: real sent/saved tokens, hit count per strategy, and overall hit rate (all-time + per-session).",
    inputSchema: { type: "object", properties: {} },
  })
  tools.push({
    name: "dcp_context",
    description: "Show a categorised estimate of token usage in the current session (system / user / assistant / tools).",
    inputSchema: { type: "object", properties: {} },
  })
  tools.push({
    name: "dcp_sweep",
    // Gate 1.5 B2: real sweep via directive consumed on next request.
    //
    // DCP upstream applies sweep IMMEDIATELY in the handler because it has
    // live access to the messages array via SessionState. The ZCode proxy
    // is stateless across requests, so the MCP tool queues a directive
    // via /dcp-admin/state/sweep and the daemon's pipeline consumes it on
    // the next /v1/messages inbound request. This means the tool returns
    // immediately with an acceptance message; the actual prune happens
    // when the next model request flows through.
    //
    // `count` argument:
    //   - omitted/null/0 → "since last user message" mode (DCP default)
    //   - positive int N → "last N tool calls" mode
    description: "Queue a one-shot sweep. No-arg sweeps all tool calls since the previous user message; `count: N` sweeps the most recent N tool calls. Effect is applied on this session's NEXT model request (delayed-apply semantics; DCP-faithful except for the immediate vs. deferred-application timing).",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", minimum: 1, description: "Optional positive integer. When set, sweep the most recent N tool calls; when omitted, sweep all tool calls since the previous user message." },
      },
    },
  })
  tools.push({
    name: "dcp_manual",
    description: "Toggle manual mode. In manual mode, automatic compress is blocked; the user must explicitly trigger via /dcp-compress.",
    inputSchema: {
      type: "object",
      required: ["enabled"],
      properties: {
        enabled: { type: "string", enum: ["on", "off"], description: "Target state: 'on' or 'off'." },
      },
    },
  })
  tools.push({
    name: "dcp_decompress",
    // Gate 1.5 B3: per-block decompress (lists available blocks / restores one).
    //
    // DCP v3.1.15 upstream (lib/commands/decompress.ts) behaviour:
    //   * no-arg → list available blocks (displayId + tokens + topic)
    //   * with N → restore block N (target.active=false → exclusion writer)
    //
    // ZCode adaptation (CAPABILITY-MAPPING v0.1.5 row 2): "restore" is
    // implemented as adding the block id to the per-fp exclusion list
    // (lightState.decompressBlockIds). The pipeline drops the synthetic
    // summary for that block at deriveBlocks, and the original covered span
    // survives verbatim in the next request. "Restore all" is the
    // dcp_recompress tool (clears the list + flips manualMode off).
    description: "List available compression blocks (no-arg) or restore a single block by id (blockId=<n>; adds to exclusion list so the original messages return on the next request).",
    inputSchema: {
      type: "object",
      properties: {
        blockId: { type: "number", minimum: 1, description: "Optional positive integer. When set, restore that specific block (add to the exclusion list). When omitted, list the available blocks." },
      },
    },
  })
  tools.push({
    name: "dcp_recompress",
    description: "Recompress the most recently active session: re-apply the current compression set and exit manual mode.",
    inputSchema: {
      type: "object",
      properties: {
        blockId: { type: "string", description: "Optional. Reserved for future use." },
      },
    },
  })
  return tools
}

function pathToFileUrl(p) {
  return pathToFileURL(p).href
}

// ---------------------------------------------------------------------------
// Admin HTTP client (calls /dcp-admin/* on the local daemon)
// ---------------------------------------------------------------------------

function readAdminToken(dataDir, tokenFile) {
  const file = path.join(dataDir, tokenFile || "admin-token")
  // Read with retries — the daemon materialises the token asynchronously after
  // bind. A naive read may catch a moment before the rename has propagated
  // through the OS filesystem cache. Three tries × 100ms is plenty for a
  // localhost daemon whose bind finishes within tens of milliseconds.
  let lastErr = null
  for (let i = 0; i < 8; i++) {
    try {
      const raw = fs.readFileSync(file, "utf8")
      const trimmed = raw.trim()
      if (trimmed) return trimmed
    } catch (err) {
      lastErr = err
    }
    // Sync sleep — busy-wait briefly so we don't yield to other handlers.
    const deadline = Date.now() + 150
    while (Date.now() < deadline) { /* spin */ }
  }
  return null
}

/**
 * Make a GET request to the local daemon. Resolves with
 * `{status, json, text}` (text always populated). Uses the admin token.
 *
 * @param {{host:string,port:number,path:string,token:string|null,timeoutMs?:number}} opts
 * @returns {Promise<{status:number,json:any,text:string}>}
 */
function adminGet({ host, port, urlPath, token, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const headers = {}
    if (token) {
      headers["authorization"] = `Bearer ${token}`
      headers["x-api-key"] = token
    }
    const req = http.request(
      { host, port, path: urlPath, method: "GET", headers, timeout: timeoutMs },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let json = null
          try { json = JSON.parse(text) } catch { /* leave null */ }
          resolve({ status: res.statusCode || 0, json, text })
        })
        res.on("error", () => resolve({ status: 0, json: null, text: "" }))
      },
    )
    req.on("error", () => resolve({ status: 0, json: null, text: "" }))
    req.on("timeout", () => {
      try { req.destroy() } catch { /* ignore */ }
      resolve({ status: 0, json: null, text: "" })
    })
    req.end()
  })
}

/**
 * Retry-on-status-0 wrapper. The daemon may have just been spawned; its
 * bind may not have propagated through the kernel accept queue by the time
 * the first request arrives. Retry up to `maxAttempts` × `retryDelayMs` ms.
 */
async function adminGetWithRetry(opts, maxAttempts = 5, retryDelayMs = 400) {
  let last = { status: 0, json: null, text: "" }
  for (let i = 0; i < maxAttempts; i++) {
    last = await adminGet(opts)
    if (last.status !== 0) return last
    await new Promise((res) => setTimeout(res, retryDelayMs))
  }
  return last
}

/**
 * Health probe — used by keepalive tick to detect a dead daemon.
 * Returns true iff the daemon responds 200 to /dcp-admin/health.
 */
async function probeDaemon(host, port, timeoutMs = 1000) {
  const r = await adminGet({ host, port, urlPath: "/dcp-admin/health", token: null, timeoutMs })
  return r.status === 200
}

// ---------------------------------------------------------------------------
// Daemon ensure + keepalive (R11 30s recovery mechanism)
// ---------------------------------------------------------------------------

/**
 * Try to spawn the daemon. Returns true on success (process started and
 * /dcp-admin/health responded 200 within the probe window), false otherwise.
 * Errors are reported to stderr but never throw — the MCP server must
 * continue running so tools can be re-tried after the keepalive tick
 * (R11 recovery semantics).
 */
async function ensureDaemon({ host, port, configPath, dataDir, config }) {
  // 1. Quick probe: is a healthy daemon already on the port?
  if (await probeDaemon(host, port, 800)) return true

  // 2. Spawn the daemon via the shared launcher (mcp/daemon-launcher.mjs).
  //
  //    I-1 fix: we pass the FULLY-RESOLVED config inline via
  //    `DCP_RESOLVED_CONFIG` (JSON-string). Previously we relied on the
  //    launcher re-resolving via loadConfig(process.cwd(), dataDir) which
  //    ran inside the launcher's cwd (= PLUGIN_ROOT). That made workspace
  //    configs at `<workspace>/.zcode/dcp.jsonc` invisible to the daemon,
  //    while the MCP server's own loadConfig (run from ZCode's cwd) saw
  //    them — the two ended up on different ports and the keepalive looped
  //    forever. Passing the merged config explicitly eliminates the cwd
  //    dependency for the production path.
  //
  //    M-6: removed the v1 port's `DCP_TEST_PORT → write .zcode/dcp.jsonc
  //    inside PLUGIN_ROOT` side-effect. That wrote to a real source tree
  //    during tests (leak in CI) and never matched the MCP server's resolved
  //    port (see I-1).
  fs.mkdirSync(dataDir, { recursive: true })
  const child = spawn(process.execPath, [DAEMON_LAUNCHER_JS], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      ...(configPath ? { DCP_CONFIG_PATH: configPath } : {}),
      DCP_DATA_DIR: dataDir,
      ...(config ? { DCP_RESOLVED_CONFIG: JSON.stringify(config) } : {}),
    },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
    windowsHide: true,
  })
  // M-3: surface spawn-time failures (e.g. binary not found, permission
  // denied) instead of letting the MCP server silently miss the daemon.
  child.on("error", (err) => {
    process.stderr.write(`[mcp-server] daemon spawn error: ${err && err.message}\n`)
  })

  // Capture the launcher's stderr to a log file (truncate past 1 MiB, M-1).
  try {
    const errLogPath = path.join(dataDir, "_daemon-launcher.log")
    const errLog = fs.openSync(errLogPath, "a")
    let bytesWritten = 0
    try { bytesWritten = fs.fstatSync(errLog).size } catch { bytesWritten = 0 }
    child.stderr.on("data", (chunk) => {
      try {
        fs.writeSync(errLog, chunk)
        bytesWritten += chunk.length
        if (bytesWritten > LAUNCHER_LOG_MAX_BYTES) {
          // Rotate: close, read all, keep last 64 KiB, reopen truncated.
          try { fs.closeSync(errLog) } catch { /* ignore */ }
          let buf = Buffer.alloc(0)
          try {
            buf = fs.readFileSync(errLogPath)
            const tail = buf.slice(Math.max(0, buf.length - 65536))
            fs.writeFileSync(errLogPath, tail)
          } catch { /* ignore */ }
          bytesWritten = Math.min(buf.length, 65536)
        }
      } catch { /* ignore */ }
    })
    child.stderr.on("end", () => { try { fs.closeSync(errLog) } catch { /* ignore */ } })
  } catch { /* best-effort */ }
  // Detach so the daemon outlives the MCP process (so the user can quit ZCode
  // and the daemon still serves queued requests). On Windows, detached +
  // ignore yields the desired behaviour; we still unref where supported.
  try { child.unref() } catch { /* ignore */ }

  // 3. Wait up to 10s for the new daemon to come up. We poll every 200ms so a
  // fast spawn catches on the first probe. Longer than 5s for the slow-Win32
  // bind path; the keepalive tick will keep trying afterwards if this returns
  // false.
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await probeDaemon(host, port, 600)) return true
    await new Promise((r) => setTimeout(r, 200))
  }

  // Spawn failed (port still in use by a non-sibling, or the daemon crashed
  // on boot). Report to stderr but DO NOT crash the MCP server — the user
  // can call tools/call which will retry the probe lazily.
  process.stderr.write(
    `[mcp-server] ensureDaemon: daemon did not become healthy at ${host}:${port} within 10s; ` +
    `subsequent tool calls will re-probe (R11 keepalive).`,
  )
  return false
}

/**
 * Background interval that re-probes the daemon every KEEPALIVE_MS. If the
 * probe fails AND we previously believed the daemon was healthy, spawn a new
 * one. If we never managed to get a healthy daemon, keep trying (the user
 * may fix the port collision between calls).
 */
function startKeepalive({ host, port, configPath, dataDir, config }) {
  let everHealthy = false
  const tick = async () => {
    try {
      const ok = await probeDaemon(host, port, 1000)
      if (ok) {
        everHealthy = true
        return
      }
      // Daemon is down (or never came up). Try a single respawn.
      process.stderr.write(`[mcp-server] keepalive: daemon not healthy; respawning`)
      const spawned = await ensureDaemon({ host, port, configPath, dataDir, config })
      if (spawned) everHealthy = true
    } catch (err) {
      process.stderr.write(`[mcp-server] keepalive tick error: ${err && err.message}`)
    }
  }
  // Use unref so the timer doesn't prevent process exit during tests.
  const handle = setInterval(tick, KEEPALIVE_MS)
  if (handle && typeof handle.unref === "function") handle.unref()
  // First tick immediately (don't wait KEEPALIVE_MS for the initial spawn).
  setImmediate(tick)
  return handle
}

// ---------------------------------------------------------------------------
// Compress: manualMode gate + validateCompressArgs + acceptance message
// ---------------------------------------------------------------------------

async function readLightStateForMostRecentSession(dataDir) {
  const activePath = path.join(dataDir, "active-sessions.json")
  let table = {}
  try { table = JSON.parse(fs.readFileSync(activePath, "utf8")) || {} } catch { return null }
  const now = Date.now()
  let latestFp = null
  let latestTs = 0
  for (const [fp, entry] of Object.entries(table)) {
    if (!entry || typeof entry.lastSeenTs !== "number") continue
    if (entry.lastSeenTs > latestTs && now - entry.lastSeenTs < 30 * 60 * 1000) {
      latestFp = fp
      latestTs = entry.lastSeenTs
    }
  }
  if (!latestFp) return null
  const lsPath = path.join(dataDir, "light-state", `${latestFp}.json`)
  try {
    const raw = fs.readFileSync(lsPath, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed
    return null
  } catch {
    return null
  }
}

function compressAcceptanceText(rangeCount, messageCount) {
  // CAP-04 verbatim acceptance message: "Compression accepted. N range(s)/
  // message(s) will be applied to subsequent context."
  const r = Number(rangeCount) || 0
  const m = Number(messageCount) || 0
  if (m > 0 && r === 0) {
    return `Compression accepted. ${m} message(s) will be applied to subsequent context.`
  }
  return `Compression accepted. ${r} range(s) will be applied to subsequent context.`
}

// ---------------------------------------------------------------------------
// tools/call dispatcher
// ---------------------------------------------------------------------------

/**
 * Format a stats snapshot from /dcp-admin/stats into a human-readable text
 * block. Mirrors the DCP `/dcp stats` command's shape (CAP-12). Faithful to
 * the proportional breakdown without copying any DCP-proprietary verbiage.
 *
 * R8.1 / R8.2 / R8.3 (DESIGN D7) wording:
 *   - "Savings rate" replaces "Cache hit rate" — same saved/(sent+saved)
 *     formula, but the label no longer implies an upstream prompt-cache
 *     hit ratio.
 *   - byStrategy rows are labelled "hits" (per-request cumulative count
 *     of strategy occurrences), NOT a share-of-tokens breakdown.
 *   - "Saved tokens by strategy" line is rendered only when the snapshot
 *     carries stats.byStrategyTokens (R8.3 / D3). Legacy stats files
 *     (pre-R8.3) lack this field; the line is omitted to remain
 *     backward-compatible without inventing numbers.
 */
function formatStatsText(json) {
  if (!json || typeof json !== "object") return "No stats available yet."
  const sent = Number(json.sentTokens) || 0
  const saved = Number(json.savedTokens) || 0
  const bs = json.byStrategy || {}
  const dedup = Number(bs.dedup) || 0
  const purge = Number(bs.purge) || 0
  const sweep = Number(bs.sweep) || 0
  const compress = Number(bs.compress) || 0
  const requests = Number(json.requests) || 0
  const compressRuns = Number(json.compressRuns) || 0
  // R8.1: rename label; preserved saved/(sent+saved) ratio (not an upstream
  // prompt-cache rate).
  const savingsRate = sent > 0 ? ((saved / (sent + saved)) * 100).toFixed(1) + "%" : "n/a"
  const lines = []
  lines.push("DCP Stats — all-time aggregate")
  lines.push("-".repeat(40))
  lines.push(`Requests:           ${requests}`)
  lines.push(`Compress runs:      ${compressRuns}`)
  lines.push(`Sent tokens:        ${sent.toLocaleString("en-US")}`)
  lines.push(`Saved tokens:       ${saved.toLocaleString("en-US")}`)
  lines.push(`Savings rate:       ${savingsRate}`)
  lines.push("")
  // R8.2: byStrategy rows are labelled "hits" (per-request cumulative
  // strategy occurrences). No token-share paragraph below.
  lines.push("Savings by strategy (hits — per-request cumulative count):")
  lines.push(`  deduplication:    ${dedup.toLocaleString("en-US")}`)
  lines.push(`  purge-errors:     ${purge.toLocaleString("en-US")}`)
  lines.push(`  sweep:            ${sweep.toLocaleString("en-US")}`)
  lines.push(`  compress:         ${compress.toLocaleString("en-US")}`)
  // R8.3: per-strategy saved-token split. Only render when the field is
  // present in the snapshot — legacy stats-all.json files (pre-R8.3)
  // lack byStrategyTokens, and silently dropping the line keeps the
  // remaining output accurate instead of inventing zeros.
  if (json.byStrategyTokens && typeof json.byStrategyTokens === "object") {
    const bst = json.byStrategyTokens
    const d = Number(bst.dedup) || 0
    const p = Number(bst.purge) || 0
    const s = Number(bst.sweep) || 0
    const c = Number(bst.compress) || 0
    lines.push("")
    lines.push("Saved tokens by strategy:")
    lines.push(`  deduplication:    ${d.toLocaleString("en-US")}`)
    lines.push(`  purge-errors:     ${p.toLocaleString("en-US")}`)
    lines.push(`  sweep:            ${s.toLocaleString("en-US")}`)
    lines.push(`  compress:         ${c.toLocaleString("en-US")}`)
  }
  if (Array.isArray(json.sessions) && json.sessions.length > 0) {
    lines.push("")
    lines.push(`Active sessions:    ${json.sessions.length}`)
    for (const sess of json.sessions.slice(0, 5)) {
      const fp = String(sess.fp || "").slice(0, 8)
      const u = sess.lastUsage || {}
      const total = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
      lines.push(`  ${fp}…  total tokens seen: ${total}`)
    }
  }
  return lines.join("\n")
}

/**
 * Format a categorised context estimate (CAP-11). Reads the per-session
 * light-state for the most recently active session + the daemon's stats
 * (for total). Since the daemon's /dcp-admin/stats does not expose a full
 * token-breakdown, this is a lean, faithful sketch — DCP's `dcp context`
 * command shows per-session breakdown; here we surface a summary using the
 * last assistant's usage that the daemon captured (from SSE).
 */
function formatContextText(statsJson, lightState) {
  if (!statsJson || typeof statsJson !== "object") return "No context data available yet."
  const sessions = Array.isArray(statsJson.sessions) ? statsJson.sessions : []
  if (sessions.length === 0) return "No active session captured yet — start chatting with the model first."
  const sess = sessions[0]
  const u = sess.lastUsage || {}
  const input = Number(u.inputTokens) || 0
  const output = Number(u.outputTokens) || 0
  const cacheRead = Number(u.cacheReadTokens) || 0
  const cacheWrite = Number(u.cacheWriteTokens) || 0
  const total = input + output + cacheRead + cacheWrite
  const lines = []
  lines.push("DCP Context (categorised estimate — proxy never re-estimates upstream values)")
  lines.push("-".repeat(60))
  if (total === 0) {
    lines.push("No upstream usage captured yet (no completed assistant turn).")
    return lines.join("\n")
  }
  const pct = (n) => total > 0 ? ((n / total) * 100).toFixed(1).padStart(5) + "%" : "  0.0%"
  lines.push(`Category            Share  Tokens`)
  lines.push(`input (last turn)  ${pct(input)}  ${input.toLocaleString("en-US")}`)
  lines.push(`output             ${pct(output)}  ${output.toLocaleString("en-US")}`)
  lines.push(`cache.read         ${pct(cacheRead)}  ${cacheRead.toLocaleString("en-US")}`)
  lines.push(`cache.write        ${pct(cacheWrite)}  ${cacheWrite.toLocaleString("en-US")}`)
  lines.push(`TOTAL              ${pct(total)}  ${total.toLocaleString("en-US")}`)
  if (lightState) {
    lines.push("")
    lines.push("Active-session light-state:")
    lines.push(`  manualMode:        ${lightState.manualMode ? "ON" : "off"}`)
    if (lightState.decompressBlockIds) {
      lines.push(`  decompressBlockIds: ${lightState.decompressBlockIds.length}`)
    }
  }
  return lines.join("\n")
}

/**
 * Handle a tools/call for any registered tool. Resolves with either
 * `{ ok: true, result }` or `{ ok: false, error }` where error is
 * `{code, message}`.
 */
async function handleToolCall(name, args, ctx) {
  const { config, dataDir, host, port } = ctx
  // Re-read the admin token on every tool call — the daemon materialises it
  // at startup, and our __ctx snapshot may have been captured BEFORE the
  // daemon finished boot. A 0-token call would always 401.
  const tokenFile = (ctx.config && ctx.config.proxy && ctx.config.proxy.adminTokenFile) || "admin-token"
  const token = readAdminToken(dataDir, tokenFile)
  const cfg = config || {}
  const compressCfg = cfg.compress || {}
  const mode = compressCfg.mode === "message" ? "message" : "range"

  if (name === "compress") {
    // 1. permission gate (CAP-04): if permission=deny, the tool is not
    //    registered in the first place, but we re-check defensively in case
    //    a stale config gets loaded.
    if (compressCfg.permission === "deny") {
      return { ok: false, error: { code: -32600, message: "compress tool is disabled by config (permission=deny)" } }
    }
    // 2. manualMode gate: if the most recently active session has
    //    manualMode=true, intercept and return the DCP verbatim error text.
    //    This matches the brief + SPEC R6.
    const ls = await readLightStateForMostRecentSession(dataDir)
    if (ls && ls.manualMode === true) {
      // Per brief: return DCP manual.ts:44-48 verbatim error text.
      // We return it as MCP text content (the model surfaces the error
      // verbatim) rather than as an error envelope — both are valid MCP
      // shapes, but the DCP user expectation is "you see the message".
      return {
        ok: true,
        result: {
          content: [{ type: "text", text: DCP_MANUAL_MODE_ERROR }],
          isError: true,
        },
      }
    }
    // 3. Validate args via the same module the daemon uses.
    try {
      const compressMod = await import(pathToFileUrl(COMPRESS_JS))
      compressMod.validateCompressArgs(args, mode)
    } catch (err) {
      return { ok: false, error: { code: -32602, message: err && err.message ? err.message : String(err) } }
    }
    // 4. Acceptance text. Per CAP-04 the wording is verbatim.
    const rangeCount = Array.isArray(args && args.content) ? args.content.length : 0
    const text = compressAcceptanceText(rangeCount, 0)
    return {
      ok: true,
      result: { content: [{ type: "text", text }], isError: false },
    }
  }

  if (name === "dcp_stats") {
    const r = await adminGetWithRetry({ host, port, urlPath: "/dcp-admin/stats", token, timeoutMs: 4000 })
    if (r.status === 0) {
      return { ok: false, error: { code: -32000, message: "daemon unreachable; cannot fetch stats" } }
    }
    if (r.status !== 200) {
      return { ok: false, error: { code: -32000, message: `admin /dcp-admin/stats returned ${r.status}: ${r.text}` } }
    }
    return { ok: true, result: { content: [{ type: "text", text: formatStatsText(r.json) }], isError: false } }
  }

  if (name === "dcp_context") {
    const r = await adminGetWithRetry({ host, port, urlPath: "/dcp-admin/stats", token, timeoutMs: 4000 })
    if (r.status === 0) {
      return { ok: false, error: { code: -32000, message: "daemon unreachable; cannot fetch context" } }
    }
    if (r.status !== 200) {
      return { ok: false, error: { code: -32000, message: `admin /dcp-admin/stats returned ${r.status}: ${r.text}` } }
    }
    const ls = await readLightStateForMostRecentSession(dataDir)
    return { ok: true, result: { content: [{ type: "text", text: formatContextText(r.json, ls) }], isError: false } }
  }

  // The remaining tools hit the /dcp-admin/state/<action> endpoint.
  // dcp_recompress keeps the legacy "clear all + manualMode off" semantics
  // (unchanged from before). dcp_decompress is a custom handler (below) —
  // it accepts blockId and renders the list path.
  if (name === "dcp_recompress") {
    const r = await adminGetWithRetry({ host, port, urlPath: "/dcp-admin/state/recompress", token, timeoutMs: 4000 })
    if (r.status === 0) {
      return { ok: false, error: { code: -32000, message: "daemon unreachable; cannot apply recompress (host=" + host + " port=" + port + " token=" + (token ? token.slice(0,8)+"…" : "null") + ")" } }
    }
    if (r.status === 404) {
      return { ok: true, result: { content: [{ type: "text", text: "No active session — recompress applied to nothing." }], isError: false } }
    }
    if (r.status !== 200) {
      return { ok: false, error: { code: -32000, message: `admin /dcp-admin/state/recompress returned ${r.status}: ${r.text}` } }
    }
    const detail = r.json && r.json.fp ? ` (fp=${String(r.json.fp).slice(0, 8)}…)` : ""
    return { ok: true, result: { content: [{ type: "text", text: `Recompress applied${detail}.` }], isError: false } }
  }

  // Gate 1.5 B2 — dcp_sweep has a custom handler because it accepts the
  // `count` argument (forwarded to the admin endpoint as `?n=<int>`) and
  // returns the honest "delayed-apply" semantics. The legacy contract was
  // "applied to nothing because there's no anchor state" — replaced with a
  // real sweep directive that the pipeline consumes on the next request.
  if (name === "dcp_sweep") {
    const countRaw = args && args.count
    let urlPath = "/dcp-admin/state/sweep"
    let modeLabel
    if (countRaw !== undefined && countRaw !== null && countRaw !== "") {
      // Defer numeric validation to the daemon (it returns 400 on bad input).
      const n = Number(countRaw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return {
          ok: false,
          error: { code: -32602, message: "dcp_sweep: count must be a positive integer; got " + JSON.stringify(countRaw) },
        }
      }
      urlPath = "/dcp-admin/state/sweep?n=" + n
      modeLabel = `last ${n} tool call(s)`
    } else {
      modeLabel = "all tool calls since the previous user message"
    }
    const r = await adminGetWithRetry({ host, port, urlPath, token, timeoutMs: 4000 })
    if (r.status === 0) {
      return { ok: false, error: { code: -32000, message: "daemon unreachable; cannot queue sweep" } }
    }
    if (r.status === 404) {
      return { ok: true, result: { content: [{ type: "text", text: "No active session — sweep applied to nothing." }], isError: false } }
    }
    if (r.status === 400) {
      return { ok: false, error: { code: -32602, message: `sweep parameter invalid: ${r.text}` } }
    }
    if (r.status !== 200) {
      return { ok: false, error: { code: -32000, message: `admin /dcp-admin/state/sweep returned ${r.status}: ${r.text}` } }
    }
    const detail = r.json && r.json.fp ? ` (fp=${String(r.json.fp).slice(0, 8)}…)` : ""
    // Honest delay-apply wording: the directive is queued, the actual prune
    // happens when the next /v1/messages request flows through.
    let text = `Sweep accepted: ${modeLabel}. It will be applied on this session's next request.`
    // Surface the last-applied result so the operator can see the prior
    // sweep's outcome (one-shot: cleared after the next read; the daemon
    // returns it on every state/sweep call while the directive is queued).
    if (r.json && r.json.lightState && r.json.lightState.sweepLastResult) {
      const last = r.json.lightState.sweepLastResult
      text += ` Last sweep: applied ${last.applied} tool(s), ${last.skippedProtected} protected skipped.`
    }
    text += detail
    return { ok: true, result: { content: [{ type: "text", text }], isError: false } }
  }

  if (name === "dcp_decompress") {
    // Gate 1.5 B3 — list available blocks (no-arg) OR restore one (blockId=N).
    //
    // The daemon's /dcp-admin/state/decompress endpoint speaks plain text on
    // both paths so the surface stays close to DCP upstream
    // (lib/commands/decompress.ts:formatAvailableBlocksMessage) and the MCP
    // layer just returns the body verbatim. The single-source-of-truth
    // contract: the pipeline writes lightState.activeBlockSummaries on every
    // request (B3), the daemon returns it inside the {lightState} envelope on
    // the blockId path, and the no-arg path renders the same data directly
    // from light-state. The MCP server reads the rendered body back and
    // surfaces it as the tool's text content.
    const blockIdRaw = args && args.blockId
    let urlPath = "/dcp-admin/state/decompress"
    if (blockIdRaw !== undefined && blockIdRaw !== null && blockIdRaw !== "") {
      const n = Number(blockIdRaw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return {
          ok: false,
          error: {
            code: -32602,
            message: "dcp_decompress: blockId must be a positive integer; got " + JSON.stringify(blockIdRaw),
          },
        }
      }
      urlPath = "/dcp-admin/state/decompress?blockId=" + n
    }
    const r = await adminGetWithRetry({ host, port, urlPath, token, timeoutMs: 4000 })
    if (r.status === 0) {
      return { ok: false, error: { code: -32000, message: "daemon unreachable; cannot apply decompress (host=" + host + " port=" + port + " token=" + (token ? token.slice(0,8)+"…" : "null") + ")" } }
    }
    if (r.status === 404) {
      return { ok: true, result: { content: [{ type: "text", text: "No active session — decompress applied to nothing." }], isError: false } }
    }
    if (r.status === 400) {
      return { ok: false, error: { code: -32602, message: `decompress parameter invalid: ${r.text}` } }
    }
    if (r.status !== 200) {
      return { ok: false, error: { code: -32000, message: `admin /dcp-admin/state/decompress returned ${r.status}: ${r.text}` } }
    }
    // The daemon already rendered the response body (text/plain). On the
    // blockId path it's a confirmation message; on the list path it's the
    // Usage hint + block rows. We surface whatever the daemon returned
    // verbatim — the daemon is the single-writer for the exclusion list
    // (B3 contract) so there's nothing for the MCP layer to compute here.
    const detail = r.json && r.json.fp ? ` (fp=${String(r.json.fp).slice(0, 8)}…)` : ""
    const text = (r.text || "").replace(/\r?\n$/, "") + (blockIdRaw !== undefined && blockIdRaw !== "" ? detail : "")
    return { ok: true, result: { content: [{ type: "text", text }], isError: false } }
  }

  if (name === "dcp_manual") {
    // I-2 fix: pass `enabled` to the daemon via query string so the daemon
    // itself becomes the single writer for `manualMode`. The previous
    // implementation had to (a) call /dcp-admin/state/manual (always-on),
    // (b) read the admin response back to find the active fp, then
    // (c) write the light-state file directly. Concurrent MCP requests
    // would race — the read-back could observe a stale value, and our
    // direct write would race against any in-flight daemon write. The
    // daemon now honours `?enabled=true|false` so MCP just tells the
    // daemon the desired target state and lets it persist atomically.
    const enabledRaw = args && args.enabled
    const wantOn = enabledRaw === "on" || enabledRaw === true || (typeof enabledRaw === "string" && enabledRaw.toLowerCase() === "true")
    const urlPath = "/dcp-admin/state/manual?enabled=" + (wantOn ? "true" : "false")
    const r = await adminGetWithRetry({ host, port, urlPath, token, timeoutMs: 4000 })
    if (r.status === 0) {
      return { ok: false, error: { code: -32000, message: "daemon unreachable; cannot toggle manual mode" } }
    }
    if (r.status === 404) {
      return { ok: true, result: { content: [{ type: "text", text: "No active session — manual mode flag not changed." }], isError: false } }
    }
    if (r.status !== 200) {
      return { ok: false, error: { code: -32000, message: `admin /dcp-admin/state/manual returned ${r.status}: ${r.text}` } }
    }
    const msg = wantOn
      ? "Manual mode is now ON. Compress will be blocked until the user explicitly triggers it."
      : "Manual mode is now OFF."
    return { ok: true, result: { content: [{ type: "text", text: msg }], isError: false } }
  }

  return { ok: false, error: { code: -32601, message: `Unknown tool: ${name}` } }
}

function capitalize(s) {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---------------------------------------------------------------------------
// Request dispatcher (initialize / ping / tools/list / tools/call)
// ---------------------------------------------------------------------------

/**
 * Parse a single request line / frame body. Throws on invalid JSON.
 */
function parseRequest(body) {
  const parsed = JSON.parse(body)
  if (Array.isArray(parsed)) {
    // Batch — process each item sequentially; this server doesn't send
    // unsolicited notifications so we just dispatch the calls.
    return { batch: true, items: parsed }
  }
  return { batch: false, msg: parsed }
}

async function dispatchMessage(msg, ctx) {
  const { id, method, params } = msg
  // Notifications (no id) — ignore after initialize.
  if (id === undefined || id === null) {
    if (method === "notifications/initialized" || method === "initialized") return null
    process.stderr.write(`[mcp-server] ignoring notification: ${method}`)
    return null
  }
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params && params.protocolVersion ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    case "ping":
      return ok(id, {})
    case "tools/list": {
      const tools = await buildToolsList(ctx)
      return ok(id, { tools })
    }
    case "tools/call": {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      if (!name || typeof name !== "string") {
        return fail(id, -32602, "tools/call requires params.name")
      }
      const result = await handleToolCall(name, args, ctx)
      if (!result.ok) {
        return fail(id, result.error.code, result.error.message)
      }
      return ok(id, result.result)
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`)
  }
}

function handleRaw(raw, ctx) {
  const trimmed = String(raw).trim()
  if (!trimmed) return
  let parsed
  try {
    parsed = parseRequest(trimmed)
  } catch (err) {
    process.stderr.write(`[mcp-server] dispatch error: ${err && err.message}\n${err && err.stack}\n`)
    return
  }
  if (parsed.batch) {
    // Batch — sequential dispatch.
    ;(async () => {
      for (const item of parsed.items) {
        await dispatchMessage(item, ctx)
      }
    })().catch((err) => {
      process.stderr.write(`[mcp-server] batch dispatch error: ${err && err.message}\n${err && err.stack}\n`)
    })
    return
  }
  dispatchMessage(parsed.msg, ctx).catch((err) => {
    process.stderr.write(`[mcp-server] dispatch error: ${err && err.message}\n${err && err.stack}\n`)
  })
}

// ---------------------------------------------------------------------------
// Stdin framing parser (verbatim shape of ZCode example-plugin
// hello-server.mjs:122-154 — Apache-2.0 — adapted for our handler signature).
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0)

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd === -1) {
      // Fallback: treat the buffer as one-or-more newline-delimited JSON
      // messages. If there's a newline and the buffer starts with '{',
      // split on \n and process each non-empty line.
      const asText = buffer.toString("utf8")
      if (asText.includes("\n") && asText.trimStart().startsWith("{")) {
        const lines = asText.split(/\r?\n/)
        buffer = Buffer.from(lines.pop() || "", "utf8")
        for (const line of lines) {
          if (line.trim()) handleRaw(line, __ctx)
        }
      }
      break
    }
    const header = buffer.slice(0, headerEnd).toString("utf8")
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.slice(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + length
    if (buffer.length < bodyEnd) break
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8")
    buffer = buffer.slice(bodyEnd)
    handleRaw(body, __ctx)
  }
})

process.stdin.on("end", () => {
  if (buffer.length) handleRaw(buffer.toString("utf8"), __ctx)
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Resolve the config path + dataDir + host/port for this MCP process.
 * Honors DCP_TEST_PORT for test pinning; falls back to the default 127.0.0.1:8367.
 */
async function bootstrap() {
  // Config resolution: prefer DCP_CONFIG_PATH (set by this process for the
  // daemon child) or fall back to the standard two-level layout via loadConfig.
  let config = null
  const configPath = process.env.DCP_CONFIG_PATH || null
  if (configPath && fs.existsSync(configPath)) {
    try {
      const configMod = await import(pathToFileUrl(CONFIG_JS))
      const raw = fs.readFileSync(configPath, "utf8")
      const parsed = configMod.parseJsonc(raw)
      config = configMod.mergeConfig([configMod.DEFAULT_CONFIG, parsed])
    } catch (err) {
      process.stderr.write(`[mcp-server] failed to load config at ${configPath}: ${err && err.message}`)
    }
  }
  if (!config) {
    try {
      const configMod = await import(pathToFileUrl(CONFIG_JS))
      const r = configMod.loadConfig(process.cwd(), PLUGIN_DATA)
      config = r.config
    } catch (err) {
      process.stderr.write(`[mcp-server] loadConfig fallback failed: ${err && err.message}; using DEFAULT_CONFIG`)
      const configMod = await import(pathToFileUrl(CONFIG_JS))
      config = configMod.DEFAULT_CONFIG
    }
  }

  // Load prompts for the tool description (compress).
  let prompts = null
  try {
    const promptsMod = await import(pathToFileUrl(PROMPTS_JS))
    prompts = promptsMod.loadPrompts(config, process.cwd())
  } catch (err) {
    process.stderr.write(`[mcp-server] loadPrompts failed: ${err && err.message}`)
  }

  const dataDir = PLUGIN_DATA
  fs.mkdirSync(dataDir, { recursive: true })

  const host = "127.0.0.1"
  const port = Number(process.env.DCP_TEST_PORT) || (config.proxy && config.proxy.port) || 8367
  const tokenFile = (config.proxy && config.proxy.adminTokenFile) || "admin-token"
  const token = readAdminToken(dataDir, tokenFile)

  return { config, configPath, prompts, dataDir, host, port, tokenFile, token }
}

// Cached context for the request handlers. set after bootstrap resolves.
let __ctx = {
  config: null,
  configPath: null,
  prompts: null,
  dataDir: null,
  host: "127.0.0.1",
  port: 8367,
  token: null,
}

// Kick off bootstrap asynchronously. The framing parser is already wired
// above, so once __ctx is populated (a few ms after startup) requests will be
// answered. Requests arriving before bootstrap returns will be answered with
// a "daemon not ready" error.
;(async () => {
  try {
    const ctx = await bootstrap()
    __ctx = ctx
    // Try once synchronously at boot — if a daemon is already running, we
    // reuse it. Otherwise spawn one and wait for it to come up.
    await ensureDaemon({
      host: ctx.host,
      port: ctx.port,
      configPath: ctx.configPath,
      dataDir: ctx.dataDir,
      config: ctx.config,
    })
    // Start the keepalive tick.
    startKeepalive({
      host: ctx.host,
      port: ctx.port,
      configPath: ctx.configPath,
      dataDir: ctx.dataDir,
      config: ctx.config,
    })
    process.stderr.write(
      `[mcp-server] stdio MCP server ready (plugin=${PLUGIN_ROOT}, dataDir=${ctx.dataDir}, daemon=${ctx.host}:${ctx.port}, keepalive=${KEEPALIVE_MS}ms)`,
    )
  } catch (err) {
    process.stderr.write(`[mcp-server] bootstrap failed: ${err && err.message}\n${err && err.stack}`)
  }
})()

// ---------------------------------------------------------------------------
// Graceful shutdown — let the daemon outlive us (we're detached), but stop
// the keepalive timer so we don't try to respawn after the user closes
// ZCode. The MCP stdio transport closes when the parent (ZCode) closes our
// stdin; we don't need to do anything explicit.
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => process.exit(0))
process.on("SIGINT", () => process.exit(0))
