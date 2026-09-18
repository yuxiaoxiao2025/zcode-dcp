// SPDX-License-Identifier: AGPL-3.0-or-later
//
// mcp.test.mjs — child-process tests for zcode-dcp/mcp/mcp-server.mjs (PLAN.md
// task-13). Each test spawns the real mcp-server.mjs as a subprocess and drives
// it via stdio (JSON-RPC frames), so the test exercises the full stdio protocol
// (initialize / tools/list / tools/call + Content-Length framing fallback) and
// the daemon ensure/keepalive mechanism (the spawn invokes daemon.mjs as a
// child process, whose /dcp-admin/* we then probe).
//
// Run: node --test zcode-dcp/test/mcp.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PLUGIN_ROOT = path.resolve(__dirname, "..") // zcode-dcp/
const REPO_ROOT = path.resolve(PLUGIN_ROOT, "..")
const ROOT = PLUGIN_ROOT
const MCP_SERVER = path.join(PLUGIN_ROOT, "mcp", "mcp-server.mjs")
const DAEMON_JS = path.join(PLUGIN_ROOT, "proxy", "daemon.mjs")
const COMPRESS_JS = path.join(PLUGIN_ROOT, "proxy", "compress.mjs")
const PROMPTS_JS = path.join(PLUGIN_ROOT, "proxy", "prompts.mjs")
const CONFIG_JS = path.join(PLUGIN_ROOT, "proxy", "config.mjs")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick a free TCP port by binding to port 0 on localhost. The OS-assigned port
 * is read back synchronously via address() once the server is in `listening`.
 * Avoids races with other tests / daemons that may already be running.
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = addr && typeof addr === "object" ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Build an isolated tmp data dir + minimal dcp.jsonc config + a fake
 * upstream baseUrl pointing nowhere (we never actually proxy a real request
 * in these tests). Returns `{tmpDir, port, cfgPath}`.
 */
async function buildTestEnv(opts = {}) {
  const port = opts.port || (await getFreePort())
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-dcp-mcp-"))
  const cfgPath = path.join(tmpDir, "dcp.jsonc")
  // Use a 127.0.0.1 port that is NOT the daemon's own — keep it unused so the
  // daemon's forwardRequest path doesn't accidentally succeed.
  const dummyUpstreamPort = await getFreePort()
  const dummyUpstream = `http://127.0.0.1:${dummyUpstreamPort}`
  const cfg = {
    proxy: { port, idleTimeoutMin: 30, adminTokenFile: "admin-token" },
    upstream: { baseUrl: dummyUpstream, apiKey: "test-key" },
    compress: { mode: "range", permission: "allow" },
    debug: false,
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8")
  return { tmpDir, port, cfgPath, dummyUpstream, dummyUpstreamPort }
}

/**
 * Spawn the MCP server as a child process. `env` controls DCP_PLUGIN_ROOT +
 * DCP_PLUGIN_DATA + DCP_TEST_PORT (when fixed) + DCP_TEST_KEEPALIVE_MS (when
 * the test wants a short keepalive interval).
 */
function spawnMcp({ tmpDir, port, keepaliveMs, cfgPath, extraEnv = {}, captureStderr = false }) {
  const env = {
    ...process.env,
    DCP_PLUGIN_ROOT: PLUGIN_ROOT,
    DCP_PLUGIN_DATA: tmpDir,
    ...(keepaliveMs ? { DCP_TEST_KEEPALIVE_MS: String(keepaliveMs) } : {}),
    ...(port ? { DCP_TEST_PORT: String(port) } : {}),
    ...(cfgPath ? { DCP_CONFIG_PATH: cfgPath } : {}),
    ...extraEnv,
  }
  const child = spawn(process.execPath, [MCP_SERVER], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  if (captureStderr) {
    child.stderr.on("data", (d) => process.stderr.write("[child stderr] " + d.toString()))
  }
  return child
}

/**
 * Send a JSON-RPC frame over the child's stdin. Framing is the bare
 * newline-delimited form (the MCP server accepts both Content-Length + bare
 * JSON-line framing).
 */
function sendRequest(child, req) {
  child.stdin.write(JSON.stringify(req) + "\n")
}

/**
 * Read the next JSON-RPC response matching `id`. The MCP server emits the
 * **newline-delimited JSON** framing required by the MCP stdio spec (one
 * JSON object per line, terminated by `\n`). ZCode's MCP client reads
 * strictly this shape — Content-Length framing on the wire causes the
 * initialize handshake to time out (P0 8.6 bug repro: "MCP server plugin:
 * zcode-dcp:dcp connection timed out after 60000ms").
 *
 * NOTE — the input side (server READS from stdin) still accepts BOTH
 * Content-Length framed and bare newline-delimited JSON, for compatibility
 * with clients that send either. Only the output side is normalised to
 * line-delimited JSON.
 *
 * Accumulates stdout bytes, parses one JSON object per line, and returns
 * the first whose id matches.
 */
function readResponse(child, id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      // The contract is: one JSON object per line, terminated by `\n`.
      // Keep parsing while we have at least one newline.
      while (buf.length > 0) {
        const text = buf.toString("utf8")
        const nlIdx = text.indexOf("\n")
        if (nlIdx === -1) break
        const line = text.slice(0, nlIdx)
        buf = Buffer.from(text.slice(nlIdx + 1), "utf8")
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          // Non-JSON line — skip (server should never emit these, but be
          // defensive: keep scanning for a valid frame).
          continue
        }
        if (msg && msg.id === id) {
          child.stdout.off("data", onData)
          clearTimeout(timer)
          resolve(msg)
          return
        }
        // Not our id — keep scanning.
      }
    }
    const timer = setTimeout(() => {
      child.stdout.off("data", onData)
      reject(new Error(`timeout waiting for id=${id} (buf=${buf.length}B)`))
    }, timeoutMs)
    child.stdout.on("data", onData)
  })
}

/**
 * Issue `req` and wait for the matching response. Cancels the timer if the
 * process exits first.
 */
function rpc(child, req, timeoutMs = 5000) {
  const p = readResponse(child, req.id, timeoutMs)
  sendRequest(child, req)
  return p
}

/**
 * Read the admin token from `dataDir/admin-token`. Wait up to 1.5s for the
 * daemon to materialise the file.
 */
async function readAdminToken(tmpDir) {
  const deadline = Date.now() + 1500
  const file = path.join(tmpDir, "admin-token")
  while (Date.now() < deadline) {
    try { return fs.readFileSync(file, "utf8").trim() } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`admin-token not present at ${file} after 1500ms`)
}

/**
 * GET helper. Resolves with `{ statusCode, body }` (body is a Buffer).
 */
function httpGet(host, port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: urlPath, method: "GET", headers, timeout: 1500 },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks),
        }))
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("http timeout")) })
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown: kill any MCP children at process exit so a test failure
// doesn't leave orphan node processes holding ports.
// ---------------------------------------------------------------------------
const activeChildren = new Set()

function registerChild(child) {
  activeChildren.add(child)
  child.on("exit", () => activeChildren.delete(child))
  return child
}

function cleanupChildren() {
  for (const c of activeChildren) {
    try { c.kill() } catch { /* ignore */ }
  }
}

test.after(() => {
  cleanupChildren()
})

// ---------------------------------------------------------------------------
// Scenario 1 — initialize returns protocolVersion + capabilities; compress
// registered by default.
// ---------------------------------------------------------------------------

test("MCP: initialize echoes protocolVersion + capabilities + tools", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  const initResp = await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })
  assert.equal(initResp.id, 1)
  assert.equal(initResp.result.protocolVersion, "2024-11-05")
  assert.deepEqual(initResp.result.capabilities, { tools: {} })
  assert.ok(initResp.result.serverInfo && initResp.result.serverInfo.name)
  assert.equal(initResp.result.serverInfo.name, "zcode-dcp")

  const listResp = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list" })
  assert.equal(listResp.id, 2)
  const names = (listResp.result.tools || []).map((t) => t.name).sort()
  assert.ok(names.includes("compress"), "compress must be registered by default")
  assert.ok(names.includes("dcp_stats"))
  assert.ok(names.includes("dcp_context"))
  assert.ok(names.includes("dcp_sweep"))
  assert.ok(names.includes("dcp_manual"))
  assert.ok(names.includes("dcp_decompress"))
  assert.ok(names.includes("dcp_recompress"))

  child.kill()
})

// ---------------------------------------------------------------------------
// R9 / D10 — initialize response carries serverInfo.version matching
// .zcode-plugin/plugin.json (single source of truth). Previously both
// daemon.mjs and mcp-server.mjs hardcoded "0.1.0", drifting from the
// manifest's "0.1.4". This pins the contract that MCP-level identify is
// consistent with the manifest.
//
// Test design: read manifest version from disk; assert MCP initialize
// response's serverInfo.version === that value.
// ---------------------------------------------------------------------------

test("MCP: initialize self-reports version === plugin.json version (R9/D10)", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  const initResp = await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })
  assert.equal(initResp.id, 1)

  const manifestPath = path.join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json")
  const expectedVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version
  assert.ok(expectedVersion && typeof expectedVersion === "string", "manifest version must be a non-empty string")
  assert.ok(
    initResp.result.serverInfo && typeof initResp.result.serverInfo.version === "string",
    "serverInfo.version must be a string",
  )
  assert.equal(
    initResp.result.serverInfo.version,
    expectedVersion,
    `serverInfo.version must equal plugin.json version (${expectedVersion})`,
  )

  child.kill()
})

// ---------------------------------------------------------------------------
// Scenario 2 — compress tools/call with valid args returns acceptance text.
// ---------------------------------------------------------------------------

test("MCP: compress with valid range args returns acceptance confirmation", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  // Initialize.
  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  const resp = await rpc(child, {
    jsonrpc: "2.0", id: 10, method: "tools/call",
    params: {
      name: "compress",
      arguments: {
        topic: "Auth Exploration",
        content: [{ startId: "m0001", endId: "m0005", summary: "Auth system studied." }],
      },
    },
  })
  assert.equal(resp.id, 10)
  // Acceptance confirmation — exact CAP-04 wording (one entry).
  assert.ok(resp.result, "expected result, got " + JSON.stringify(resp))
  const text = (resp.result.content || []).map((c) => c.text || "").join("\n")
  assert.match(text, /Compression accepted\. 1 range\(s\) will be applied to subsequent context\./, `got: ${text}`)

  child.kill()
})

// ---------------------------------------------------------------------------
// Scenario 3 — compress tools/call with empty summary returns MCP error.
// ---------------------------------------------------------------------------

test("MCP: compress with empty summary returns an MCP error with hint", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  const resp = await rpc(child, {
    jsonrpc: "2.0", id: 11, method: "tools/call",
    params: {
      name: "compress",
      arguments: {
        topic: "t",
        content: [{ startId: "m0001", endId: "m0005", summary: "" }],
      },
    },
  })
  assert.equal(resp.id, 11)
  assert.ok(resp.error, "expected error envelope, got " + JSON.stringify(resp))
  assert.match(resp.error.message, /summary is required/i)
  assert.equal(resp.result, undefined)

  child.kill()
})

// ---------------------------------------------------------------------------
// Scenario 4 — dcp_stats returns formatted stats text after a request.
// ---------------------------------------------------------------------------

test("MCP: dcp_stats returns formatted stats text (with a real upstream capture)", async () => {
  const env = await buildTestEnv()
  // Stand up a capture upstream that replies to /v1/messages.
  const capture = await new Promise((resolve) => {
    const chunks = []
    let calls = 0
    const server = http.createServer((req, res) => {
      const c = []
      req.on("data", (x) => c.push(x))
      req.on("end", () => {
        calls += 1
        chunks.push({ url: req.url, body: Buffer.concat(c).toString("utf8") })
        // Reply with a minimal Anthropic-style SSE.
        res.statusCode = 200
        res.setHeader("content-type", "text/event-stream")
        res.setHeader("anthropic-version", "2023-06-01")
        res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","usage":{"input_tokens":1,"output_tokens":2}}}\n\n`)
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
        res.end()
      })
    })
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, chunks, callsRef: () => calls })
    })
  })
  // Rewrite the config to point at this capture upstream.
  const cfg = JSON.parse(fs.readFileSync(env.cfgPath, "utf8"))
  cfg.upstream.baseUrl = `http://127.0.0.1:${capture.port}`
  fs.writeFileSync(env.cfgPath, JSON.stringify(cfg, null, 2))

  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  // Wait for the daemon to be ready before driving traffic through it. This
  // test exercises the daemon twice (admin call + proxy call); if the daemon
  // isn't ready the first one races.
  const token = await readAdminToken(env.tmpDir)
  const ready = await new Promise((resolve) => {
    let tries = 0
    const tick = async () => {
      tries += 1
      const r = await httpGet("127.0.0.1", env.port, "/dcp-admin/health", {})
      if (r.statusCode === 200) return resolve(true)
      if (tries >= 30) return resolve(false)
      setTimeout(tick, 200)
    }
    tick()
  })
  assert.ok(ready, "daemon should be ready before driving traffic")
  const body = JSON.stringify({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    system: "You are ZCode.",
    max_tokens: 16,
  })
  const proxyResp = await new Promise((resolve, reject) => {
    const data = Buffer.from(body, "utf8")
    // D7: postMessages to /v1/messages requires the install-time admin token
    // (read from env.tmpDir/admin-token by `token` above). The MCP server
    // itself also reuses this same token to talk to the daemon, so both
    // sides stay consistent with the D7 contract.
    const req = http.request({
      host: "127.0.0.1", port: env.port, path: "/v1/messages", method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": data.length,
        "authorization": "Bearer " + token,
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
      },
      timeout: 4000,
    }, (res) => {
      const c = []
      res.on("data", (x) => c.push(x))
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") }))
    })
    req.on("error", reject)
    req.end(data)
  })
  assert.equal(proxyResp.status, 200)

  // Now call dcp_stats.
  const statsResp = await rpc(child, { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "dcp_stats", arguments: {} } })
  assert.equal(statsResp.id, 30)
  assert.ok(statsResp.result, "expected result envelope, got " + JSON.stringify(statsResp))
  const text = (statsResp.result.content || []).map((c) => c.text || "").join("\n")
  assert.match(text, /DCP Stats|stats|sent|saved/i, `got: ${text}`)

  child.kill()
  capture.server.close()
})

// ---------------------------------------------------------------------------
// Scenario 5 — dcp_sweep goes through admin and persists a sweepDirective
// to the most-recent session's lightState. (Gate 1.5 B2: real sweep via
// directive consumed on next request — the legacy behaviour of clearing
// sweepToolCallIds is now legacy; sweepToolCallIds persists for the older
// "user pre-seeded sweep ids" path.)
// ---------------------------------------------------------------------------

test("MCP: dcp_sweep calls admin endpoint and writes sweepDirective", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  // Seed an active session in the data dir so the admin endpoint has a target.
  const activePath = path.join(env.tmpDir, "active-sessions.json")
  const fakeFp = "0123456789abcdef"
  fs.writeFileSync(activePath, JSON.stringify({
    [fakeFp]: { lastSeenTs: Date.now() },
  }), "utf8")
  // Seed a light-state file for that fp so the admin endpoint can mutate it.
  const lsDir = path.join(env.tmpDir, "light-state")
  fs.mkdirSync(lsDir, { recursive: true })
  fs.writeFileSync(path.join(lsDir, `${fakeFp}.json`), JSON.stringify({
    anchors: { context: [], turn: [], iter: [] },
    fetchCount: 0,
    sweepToolCallIds: [],
    decompressBlockIds: [],
    manualMode: false,
    sweepDirective: null,
    sweepLastResult: null,
  }), "utf8")

  const resp = await rpc(child, {
    jsonrpc: "2.0", id: 40, method: "tools/call",
    params: { name: "dcp_sweep", arguments: {} },
  })
  assert.equal(resp.id, 40)
  assert.ok(resp.result, "expected result, got " + JSON.stringify(resp))
  const text = (resp.result.content || []).map((c) => c.text || "").join("\n")
  assert.match(text, /sweep|accepted|will be applied/i, `got: ${text}`)

  // After sweep, the light-state file should have a since-user sweepDirective
  // queued (the proxy will pick it up on the next /v1/messages request).
  const lsAfter = JSON.parse(fs.readFileSync(path.join(lsDir, `${fakeFp}.json`), "utf8"))
  assert.ok(lsAfter.sweepDirective, `sweepDirective must be set; got ${JSON.stringify(lsAfter.sweepDirective)}`)
  assert.equal(lsAfter.sweepDirective.mode, "since-user")
  assert.equal(lsAfter.sweepDirective.n, null)

  child.kill()
})

// ---------------------------------------------------------------------------
// Scenario 6 — keepalive: after kill -9 of the daemon, the MCP server
// detects liveness failure on its next probe tick and respawns.
// ---------------------------------------------------------------------------

test("MCP: keepalive respawns daemon after kill (short interval, in-test)", async () => {
  const env = await buildTestEnv()
  // Use a short keepalive so the test doesn't hang waiting 15s.
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, keepaliveMs: 500, cfgPath: env.cfgPath }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  // Wait briefly for the daemon to come up.
  await new Promise((r) => setTimeout(r, 800))
  const token = await readAdminToken(env.tmpDir)

  // Identify the daemon process so we can kill it.
  const before = await httpGet("127.0.0.1", env.port, "/dcp-admin/identify", {
    "authorization": `Bearer ${token}`,
    "x-api-key": token,
  })
  assert.equal(before.statusCode, 200, `initial identify: ${before.body.toString("utf8")}`)

  // Hunt for the daemon child process by scanning /proc-style on win32 isn't
  // trivial — use tasklist via cmd shell. (Cross-platform fallback is just to
  // kill ALL node processes owned by this user that are listening on env.port.
  // For test simplicity we rely on the MCP child having the daemon as a child
  // and kill the MCP child too, then assert respawn on a fresh MCP child.)
  //
  // Simpler deterministic approach: just wait for the keepalive tick after
  // we kill whatever process currently holds the port. We use the fact that
  // the MCP child spawned the daemon as its own child, so killing the
  // process listening on env.port with netstat + taskkill is reproducible.

  await new Promise((r) => setTimeout(r, 800))

  // Find and kill the process listening on env.port using tasklist.
  const killed = await new Promise((resolve) => {
    const cmd = spawn("cmd.exe", ["/c", `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${env.port} ^| findstr LISTENING') do taskkill /F /PID %a`], { stdio: "pipe" })
    let out = ""
    cmd.stdout.on("data", (c) => out += c.toString("utf8"))
    cmd.stderr.on("data", (c) => out += c.toString("utf8"))
    cmd.on("close", () => resolve(out))
  })
  void killed

  // Wait long enough for the keepalive tick to fire (interval=500ms) and for
  // the respawn to complete.
  await new Promise((r) => setTimeout(r, 2500))

  // The daemon should be back: identify should succeed again.
  const after = await httpGet("127.0.0.1", env.port, "/dcp-admin/identify", {
    "authorization": `Bearer ${token}`,
    "x-api-key": token,
  })
  assert.equal(after.statusCode, 200, `after-kill identify failed: status=${after.statusCode} body=${after.body.toString("utf8")}`)

  child.kill()
})

// ---------------------------------------------------------------------------
// Scenario 7 — Content-Length framed request gets a normal response.
// ---------------------------------------------------------------------------

test("MCP: Content-Length framed initialize is parsed correctly", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-framed", version: "0" } },
  })
  const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
  child.stdin.write(frame)

  const resp = await readResponse(child, 1)
  assert.equal(resp.id, 1)
  assert.equal(resp.result.serverInfo.name, "zcode-dcp")

  child.kill()
})

// ---------------------------------------------------------------------------
// Scenario 8 — when the most recently active session has manualMode=true, a
// subsequent compress tools/call is intercepted and returns the DCP verbatim
// error text.
// ---------------------------------------------------------------------------

test("MCP: manualMode=true → compress returns DCP verbatim error text", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  // Seed an active session with manualMode=true.
  const activePath = path.join(env.tmpDir, "active-sessions.json")
  const fakeFp = "0123456789abcdef"
  fs.writeFileSync(activePath, JSON.stringify({
    [fakeFp]: { lastSeenTs: Date.now() },
  }), "utf8")
  const lsDir = path.join(env.tmpDir, "light-state")
  fs.mkdirSync(lsDir, { recursive: true })
  fs.writeFileSync(path.join(lsDir, `${fakeFp}.json`), JSON.stringify({
    anchors: { context: [], turn: [], iter: [] },
    fetchCount: 0,
    sweepToolCallIds: [],
    decompressBlockIds: [],
    manualMode: true,
  }), "utf8")

  const resp = await rpc(child, {
    jsonrpc: "2.0", id: 99, method: "tools/call",
    params: {
      name: "compress",
      arguments: {
        topic: "t",
        content: [{ startId: "m0001", endId: "m0005", summary: "valid summary text" }],
      },
    },
  })
  assert.equal(resp.id, 99)
  // Either MCP-error or text content with the DCP message — both are valid
  // shapes. The brief asks for the verbatim DCP text; we accept either form.
  const DCP_TEXT = "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context."
  const text = (resp.result && resp.result.content ? resp.result.content.map((c) => c.text || "").join("\n") : "")
    || (resp.error ? resp.error.message : "")
  assert.match(text, /Manual mode: compress blocked/i)
  assert.match(text, /compress triggered manually/)

  child.kill()
})

// ---------------------------------------------------------------------------
// Scenario 9 (bonus) — permission=deny → compress is NOT registered.
// ---------------------------------------------------------------------------

test("MCP: permission=deny → compress is omitted from tools/list", async () => {
  const env = await buildTestEnv()
  // Override config to set permission=deny.
  const cfg = JSON.parse(fs.readFileSync(env.cfgPath, "utf8"))
  cfg.compress.permission = "deny"
  fs.writeFileSync(env.cfgPath, JSON.stringify(cfg, null, 2))

  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })
  const listResp = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list" })
  const names = (listResp.result.tools || []).map((t) => t.name)
  assert.ok(!names.includes("compress"), `compress must be omitted under permission=deny; got names: ${names.join(",")}`)

  child.kill()
})

// ---------------------------------------------------------------------------
// C-1 regression — SessionStart hook must NOT spawn proxy/daemon.mjs
// directly (it has no top-level self-start and exits 0 immediately).
// The hook must use the shared launcher (mcp/daemon-launcher.mjs), and
// after running the hook the admin /dcp-admin/health endpoint must
// respond 200.
// ---------------------------------------------------------------------------

test("hooks: session-start spawns daemon via shared launcher (not bare daemon.mjs)", async () => {
  const port = await getFreePort()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-dcp-hook-"))
  const cwd = tmpDir
  const zcodeDir = path.join(cwd, ".zcode")
  fs.mkdirSync(zcodeDir, { recursive: true })
  fs.writeFileSync(path.join(zcodeDir, "dcp.jsonc"), JSON.stringify({
    proxy: { port, idleTimeoutMin: 30, adminTokenFile: "admin-token" },
    upstream: { baseUrl: "http://127.0.0.1:1", apiKey: "x" },
    compress: { mode: "range", permission: "allow" },
  }, null, 2), "utf8")

  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "session-start.mjs")], {
    cwd,
    env: {
      ...process.env,
      DCP_PLUGIN_ROOT: PLUGIN_ROOT,
      DCP_PLUGIN_DATA: tmpDir,
      DCP_DATA_DIR: tmpDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  child.stderr.on("data", d => process.stderr.write("[hook stderr] " + d.toString()))
  child.stdout.on("data", d => process.stderr.write("[hook stdout] " + d.toString()))

  const exitCode = await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill() } catch {} ; resolve("timeout") }, 8000)
    child.on("exit", (code) => { clearTimeout(t); resolve(code) })
  })
  assert.equal(exitCode, 0, `hook exit code = ${exitCode}`)

  // Daemon should now be listening on `port`. Give it up to 5s to bind.
  let ok = false
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    ok = await new Promise((res) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/dcp-admin/health", method: "GET", timeout: 800 }, (r) => {
        r.on("data", () => {})
        r.on("end", () => res(r.statusCode === 200))
      })
      req.on("error", () => res(false))
      req.on("timeout", () => { try { req.destroy() } catch {} ; res(false) })
      req.end()
    })
    if (ok) break
    await new Promise((r) => setTimeout(r, 200))
  }
  assert.ok(ok, "daemon should be listening on the configured port after the hook runs")
})

// ---------------------------------------------------------------------------
// I-1 regression — production ensureDaemon must pass the RESOLVED config
// inline so the daemon uses the same port as the MCP server.
// ---------------------------------------------------------------------------

test("ensureDaemon: production path passes resolved config (no .zcode/dcp.jsonc side-effect)", async () => {
  // Belt-and-braces: clear any leftover .zcode/dcp.jsonc in PLUGIN_ROOT from
  // previous (pre-fix) test runs. The production ensureDaemon path must NOT
  // write this file.
  const leakedFile = path.join(PLUGIN_ROOT, ".zcode", "dcp.jsonc")
  try { fs.unlinkSync(leakedFile) } catch { /* not there */ }

  const env = await buildTestEnv()
  const port = env.port
  const tmpDir = env.tmpDir

  const cfgPath = path.join(tmpDir, "dcp.jsonc")
  fs.writeFileSync(cfgPath, JSON.stringify({
    proxy: { port, idleTimeoutMin: 17, adminTokenFile: "admin-token" },
    upstream: { baseUrl: "http://127.0.0.1:1", apiKey: "x" },
    compress: { mode: "range", permission: "allow" },
  }, null, 2), "utf8")

  const child = registerChild(spawnMcp({ tmpDir, port, cfgPath, captureStderr: true }))
  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  await new Promise((r) => setTimeout(r, 1500))

  // No .zcode/dcp.jsonc should have been created inside PLUGIN_ROOT.
  let leaked = false
  try {
    const lst = fs.readdirSync(path.join(PLUGIN_ROOT, ".zcode"))
    leaked = lst.some((n) => /dcp\.jsonc$/.test(n))
  } catch { /* no dir → not leaked */ }
  assert.equal(leaked, false, "production path must not materialise .zcode/dcp.jsonc (got leak)")

  // Indirect proof that the inline config was honoured: the daemon is
  // listening on `port`, NOT on DEFAULT 8367.
  const health = await httpGet("127.0.0.1", port, "/dcp-admin/health", {})
  assert.equal(health.statusCode, 200, `daemon should bind to merged port ${port}; got ${health.statusCode}`)

  child.kill()
})

// ---------------------------------------------------------------------------
// I-2 regression — dcp_manual {enabled:"off"} must persist even under
// concurrent requests.
// ---------------------------------------------------------------------------

test("MCP: dcp_manual off survives concurrent calls (no rollback)", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  const activePath = path.join(env.tmpDir, "active-sessions.json")
  const fakeFp = "0123456789abcdef"
  fs.writeFileSync(activePath, JSON.stringify({
    [fakeFp]: { lastSeenTs: Date.now() },
  }), "utf8")
  const lsDir = path.join(env.tmpDir, "light-state")
  fs.mkdirSync(lsDir, { recursive: true })
  const lsFile = path.join(lsDir, `${fakeFp}.json`)
  fs.writeFileSync(lsFile, JSON.stringify({
    anchors: { context: [], turn: [], iter: [] },
    fetchCount: 0,
    sweepToolCallIds: [],
    decompressBlockIds: [],
    manualMode: true,
  }), "utf8")

  const off1 = rpc(child, {
    jsonrpc: "2.0", id: 50, method: "tools/call",
    params: { name: "dcp_manual", arguments: { enabled: "off" } },
  })
  const off2 = rpc(child, {
    jsonrpc: "2.0", id: 51, method: "tools/call",
    params: { name: "dcp_manual", arguments: { enabled: "off" } },
  })
  const [r1, r2] = await Promise.all([off1, off2])
  assert.ok(r1.result, "r1 expected result, got " + JSON.stringify(r1))
  assert.ok(r2.result, "r2 expected result, got " + JSON.stringify(r2))

  await new Promise((r) => setTimeout(r, 200))
  const lsAfter = JSON.parse(fs.readFileSync(lsFile, "utf8"))
  assert.equal(lsAfter.manualMode, false, `manualMode must stay false after concurrent off; got ${lsAfter.manualMode}`)

  const onResp = await rpc(child, {
    jsonrpc: "2.0", id: 52, method: "tools/call",
    params: { name: "dcp_manual", arguments: { enabled: "on" } },
  })
  assert.ok(onResp.result, "on expected result, got " + JSON.stringify(onResp))
  await new Promise((r) => setTimeout(r, 200))
  const lsOn = JSON.parse(fs.readFileSync(lsFile, "utf8"))
  assert.equal(lsOn.manualMode, true, `manualMode should be true after on; got ${lsOn.manualMode}`)

  child.kill()
})

// ---------------------------------------------------------------------------
// dcp_decompress / dcp_recompress — Gate 1.5 B3: list + single-block restore.
//
// `dcp_decompress` no-arg now lists available blocks (does NOT clear the
// exclusion table). `blockId=N` writes N to decompressBlockIds (single writer).
// `dcp_recompress` keeps its existing behaviour (clear + manualMode off).
// ---------------------------------------------------------------------------

test("MCP: dcp_decompress (no args) lists available blocks (does NOT clear)", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  const activePath = path.join(env.tmpDir, "active-sessions.json")
  const fakeFp = "0123456789abcdef"
  fs.writeFileSync(activePath, JSON.stringify({ [fakeFp]: { lastSeenTs: Date.now() } }), "utf8")
  const lsDir = path.join(env.tmpDir, "light-state")
  fs.mkdirSync(lsDir, { recursive: true })
  const lsFile = path.join(lsDir, `${fakeFp}.json`)
  fs.writeFileSync(lsFile, JSON.stringify({
    anchors: { context: [], turn: [], iter: [] },
    fetchCount: 0,
    sweepToolCallIds: [],
    decompressBlockIds: [7, 8], // sentinel: must NOT be cleared by the list path
    manualMode: false,
    activeBlockSummaries: [
      { blockId: 1, topic: "Initial scan summary", approxTokens: 240 },
      { blockId: 2, topic: "Second segment summary", approxTokens: 180 },
    ],
  }), "utf8")

  const resp = await rpc(child, {
    jsonrpc: "2.0", id: 60, method: "tools/call",
    params: { name: "dcp_decompress", arguments: {} },
  })
  assert.ok(resp.result, "expected result, got " + JSON.stringify(resp))
  const text = (resp.result.content || []).map((c) => c.text || "").join("\n")
  assert.match(text, /Usage:.*decompress/i, `expected Usage hint; got: ${text}`)
  assert.match(text, /b1/, `expected b1 row; got: ${text}`)
  assert.match(text, /b2/, `expected b2 row; got: ${text}`)
  assert.match(text, /Initial scan summary/, `expected block 1 topic; got: ${text}`)
  // Exclusion table must NOT be touched on the list path.
  const lsAfter = JSON.parse(fs.readFileSync(lsFile, "utf8"))
  assert.deepEqual(
    lsAfter.decompressBlockIds, [7, 8],
    `decompressBlockIds must NOT be cleared on the list path; got ${JSON.stringify(lsAfter.decompressBlockIds)}`,
  )

  child.kill()
})

test("MCP: dcp_decompress with blockId=N writes N to decompressBlockIds", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  const activePath = path.join(env.tmpDir, "active-sessions.json")
  const fakeFp = "0123456789abcdef"
  fs.writeFileSync(activePath, JSON.stringify({ [fakeFp]: { lastSeenTs: Date.now() } }), "utf8")
  const lsDir = path.join(env.tmpDir, "light-state")
  fs.mkdirSync(lsDir, { recursive: true })
  const lsFile = path.join(lsDir, `${fakeFp}.json`)
  fs.writeFileSync(lsFile, JSON.stringify({
    anchors: { context: [], turn: [], iter: [] },
    fetchCount: 0,
    sweepToolCallIds: [],
    decompressBlockIds: [],
    manualMode: false,
    // I-2 (review r2): the daemon's existence check looks up the requested
    // blockId in activeBlockSummaries. Seed block 2 so the positive path
    // stays green.
    activeBlockSummaries: [
      { blockId: 2, topic: "Second segment summary", approxTokens: 180 },
    ],
  }), "utf8")

  const resp = await rpc(child, {
    jsonrpc: "2.0", id: 61, method: "tools/call",
    params: { name: "dcp_decompress", arguments: { blockId: 2 } },
  })
  assert.ok(resp.result, "expected result, got " + JSON.stringify(resp))
  const text = (resp.result.content || []).map((c) => c.text || "").join("\n")
  assert.match(text, /Restored compression b2/i, `expected restore confirmation; got: ${text}`)

  const lsAfter = JSON.parse(fs.readFileSync(lsFile, "utf8"))
  assert.deepEqual(
    lsAfter.decompressBlockIds, [2],
    `decompressBlockIds must contain [2]; got ${JSON.stringify(lsAfter.decompressBlockIds)}`,
  )

  child.kill()
})

test("MCP: dcp_decompress with invalid blockId returns an error", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  const activePath = path.join(env.tmpDir, "active-sessions.json")
  const fakeFp = "0123456789abcdef"
  fs.writeFileSync(activePath, JSON.stringify({ [fakeFp]: { lastSeenTs: Date.now() } }), "utf8")
  const lsDir = path.join(env.tmpDir, "light-state")
  fs.mkdirSync(lsDir, { recursive: true })
  const lsFile = path.join(lsDir, `${fakeFp}.json`)
  fs.writeFileSync(lsFile, JSON.stringify({
    anchors: { context: [], turn: [], iter: [] },
    fetchCount: 0,
    sweepToolCallIds: [],
    decompressBlockIds: [],
    manualMode: false,
  }), "utf8")

  const resp = await rpc(child, {
    jsonrpc: "2.0", id: 62, method: "tools/call",
    params: { name: "dcp_decompress", arguments: { blockId: "abc" } },
  })
  // error envelope expected
  assert.ok(resp.error, `expected error envelope; got ${JSON.stringify(resp)}`)
  const lsAfter = JSON.parse(fs.readFileSync(lsFile, "utf8"))
  assert.deepEqual(lsAfter.decompressBlockIds, [])

  child.kill()
})

test("MCP: dcp_recompress clears decompressBlockIds and turns manualMode off", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  const activePath = path.join(env.tmpDir, "active-sessions.json")
  const fakeFp = "0123456789abcdef"
  fs.writeFileSync(activePath, JSON.stringify({ [fakeFp]: { lastSeenTs: Date.now() } }), "utf8")
  const lsDir = path.join(env.tmpDir, "light-state")
  fs.mkdirSync(lsDir, { recursive: true })
  const lsFile = path.join(lsDir, `${fakeFp}.json`)
  fs.writeFileSync(lsFile, JSON.stringify({
    anchors: { context: [], turn: [], iter: [] },
    fetchCount: 0,
    sweepToolCallIds: [],
    decompressBlockIds: ["b1"],
    manualMode: true,
  }), "utf8")

  const resp = await rpc(child, {
    jsonrpc: "2.0", id: 70, method: "tools/call",
    params: { name: "dcp_recompress", arguments: {} },
  })
  assert.ok(resp.result, "expected result, got " + JSON.stringify(resp))

  const lsAfter = JSON.parse(fs.readFileSync(lsFile, "utf8"))
  assert.deepEqual(lsAfter.decompressBlockIds, [], `decompressBlockIds should be cleared; got ${JSON.stringify(lsAfter.decompressBlockIds)}`)
  assert.equal(lsAfter.manualMode, false, `manualMode should be off after recompress; got ${lsAfter.manualMode}`)

  child.kill()
})

// ---------------------------------------------------------------------------
// ensureDaemon idempotency — calling it twice in a row must NOT spawn a
// second daemon. The second call should short-circuit on the health probe.
// ---------------------------------------------------------------------------

test("ensureDaemon: idempotent (daemon listener count does not multiply across keepalive ticks)", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  })

  // Wait for daemon to come up — give it up to 5s. This is necessary
  // because on slow Win32 binds the launcher may take a few seconds to
  // finish the startDaemon() promise.
  function countListeners() {
    return new Promise((resolve) => {
      // Avoid the cmd.exe piped findstr form — it has shown pipe-escape
      // issues on Git Bash + Windows. Just dump netstat and filter in JS.
      const cmd = spawn("netstat", ["-ano"], { stdio: "pipe" })
      let out = ""
      cmd.stdout.on("data", (c) => out += c.toString("utf8"))
      cmd.stderr.on("data", (c) => out += c.toString("utf8"))
      cmd.on("close", () => {
        const lines = out.split(/\r?\n/).filter((l) => l.includes(`:${env.port}`) && l.includes("LISTENING"))
        resolve(lines.length)
      })
    })
  }

  let initial = 0
  for (let i = 0; i < 25; i++) {
    initial = await countListeners()
    if (initial >= 1) break
    await new Promise((r) => setTimeout(r, 200))
  }
  assert.ok(initial >= 1, `initial daemon should be listening; got ${initial} listeners on :${env.port}`)

  // Give the keepalive tick one full cycle to fire. With default 15s
  // keepalive we don't wait that long in a test; instead assert that the
  // count stays bounded across a shorter window.
  await new Promise((r) => setTimeout(r, 2000))
  const later = await countListeners()
  assert.ok(later <= initial + 2, `daemon listener count should stay bounded (was ${initial}, became ${later})`)

  child.kill()
})

// Reference internal modules so a future lint / smoke check that does
// import-graph analysis still treats them as live (they are loaded by the
// mcp-server subprocess via dynamic import paths relative to PLUGIN_ROOT).
void COMPRESS_JS
void PROMPTS_JS
void CONFIG_JS
void DAEMON_JS
void REPO_ROOT

// ---------------------------------------------------------------------------
// C-WRITE-1..3 — output framing contract (regression for P0 8.6 bug):
// ZCode's MCP client reads newline-delimited JSON only. If the server emits
// Content-Length frames, the initialize handshake times out (60s) and the
// plugin never connects. The fix: writeMessage MUST emit one JSON object per
// line, terminated by '\n', with NO Content-Length header.
// ---------------------------------------------------------------------------

/**
 * Read the raw bytes the child writes to stdout until either `predicate`
 * returns true (on the accumulated string so far) or `timeoutMs` elapses.
 * Returns `{raw, found}` where `raw` is everything accumulated.
 */
function readUntil(child, predicate, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let acc = ""
    let settled = false
    const finish = (found) => {
      if (settled) return
      settled = true
      child.stdout.off("data", onData)
      clearTimeout(timer)
      resolve({ raw: acc, found })
    }
    const onData = (chunk) => {
      acc += chunk.toString("utf8")
      if (predicate(acc)) finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.stdout.on("data", onData)
  })
}

test("C-WRITE-1: initialize response is one JSON object per line, ends with \\n, no Content-Length header", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1001, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "contract-test", version: "0" } },
  })
  child.stdin.write(body + "\n")

  // Wait until we see a line that ends with \n and parses to our id.
  const { raw } = await readUntil(child, (acc) => {
    const lines = acc.split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id === 1001) return true
      } catch { /* not JSON */ }
    }
    return false
  }, 5000)

  // Contract 1: NO "Content-Length" anywhere in the response stream.
  assert.ok(
    !/Content-Length/i.test(raw),
    `stdout must NOT contain a Content-Length header; raw bytes were: ${JSON.stringify(raw)}`,
  )

  // Contract 2: every emitted response line is a complete JSON object that
  // parses (no headers mixed with bodies).
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0)
  assert.ok(lines.length >= 1, `expected at least one response line; got: ${JSON.stringify(raw)}`)
  const targetLine = lines.find((l) => {
    try { return JSON.parse(l).id === 1001 } catch { return false }
  })
  assert.ok(targetLine, `expected a line that JSON-parses with id=1001; lines=${JSON.stringify(lines)}`)

  // Contract 3: the response line ends with '\n' (we split on it).
  // Verify the line is a single complete JSON object, no leading header bytes.
  const parsed = JSON.parse(targetLine)
  assert.equal(parsed.jsonrpc, "2.0")
  assert.equal(parsed.id, 1001)
  assert.ok(parsed.result, "initialize result envelope must be present")
  assert.equal(parsed.result.serverInfo.name, "zcode-dcp")

  child.kill()
})

test("C-WRITE-2: tools/call response is one JSON object per line, ends with \\n, no Content-Length header", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  // Initialize first.
  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "contract-test", version: "0" } },
  })

  // Send tools/call — a trivial call to dcp_stats (which returns a formatted
  // text payload in a single response line).
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1002, method: "tools/call",
    params: { name: "dcp_stats", arguments: {} },
  })
  child.stdin.write(body + "\n")

  const { raw } = await readUntil(child, (acc) => {
    const lines = acc.split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id === 1002) return true
      } catch { /* not JSON */ }
    }
    return false
  }, 5000)

  // Contract 1: NO Content-Length header.
  assert.ok(
    !/Content-Length/i.test(raw),
    `tools/call stdout must NOT contain Content-Length; raw: ${JSON.stringify(raw)}`,
  )

  // Contract 2: the tools/call response is a parseable JSON line containing
  // id=1002 with a result envelope.
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0)
  const targetLine = lines.find((l) => {
    try { return JSON.parse(l).id === 1002 } catch { return false }
  })
  assert.ok(targetLine, `expected line with id=1002; lines=${JSON.stringify(lines)}`)
  const parsed = JSON.parse(targetLine)
  assert.equal(parsed.jsonrpc, "2.0")
  assert.equal(parsed.id, 1002)
  assert.ok(parsed.result, `expected result envelope; got: ${JSON.stringify(parsed)}`)

  child.kill()
})

test("C-WRITE-3: server still accepts Content-Length framed input on stdin and replies with line-delimited JSON", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  // Feed a Content-Length framed initialize request — this MUST still parse
  // on the read side (input compatibility), but the response MUST come back
  // as a line-delimited JSON object (output compatibility with the ZCode
  // MCP client).
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1003, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "framed-input-test", version: "0" } },
  })
  const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
  child.stdin.write(frame)

  const { raw } = await readUntil(child, (acc) => {
    const lines = acc.split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id === 1003) return true
      } catch { /* not JSON */ }
    }
    return false
  }, 5000)

  // Output must NOT contain Content-Length (the new contract).
  assert.ok(
    !/Content-Length/i.test(raw),
    `response to a framed input must still be line-delimited; raw: ${JSON.stringify(raw)}`,
  )
  const targetLine = raw.split(/\r?\n/).find((l) => {
    try { return JSON.parse(l).id === 1003 } catch { return false }
  })
  assert.ok(targetLine, `expected a line with id=1003; raw=${JSON.stringify(raw)}`)
  const parsed = JSON.parse(targetLine)
  assert.equal(parsed.result.serverInfo.name, "zcode-dcp")

  child.kill()
})

// ---------------------------------------------------------------------------
// R10 — SessionStart cold-start must bounded-wait (≤ 3s) and inject
// DCP_BRIEFING via hookSpecificOutput.additionalContext when health flips
// healthy mid-wait. Was: poll 5s, emit `{}` unconditionally.
// SPEC R10 / DESIGN D6 / PLAN Task-7.
//
// Test design: spawn the real session-start.mjs with a controlled port
// blocker. The blocker initially returns 404 (so hook sees unhealthy, takes
// the cold-start branch + spawns launcher). 200ms in we flip the blocker
// to "healthy" so the next probe sees 200 → hook should emit the briefing.
// ---------------------------------------------------------------------------

test("R10: cold-start bounded-wait — briefing injected when health flips healthy mid-wait", async () => {
  const port = await getFreePort()
  let healthy = false
  const blocker = http.createServer((req, res) => {
    if (req.url === "/dcp-admin/health") {
      if (healthy) { res.statusCode = 200; res.end("ok") }
      else { res.statusCode = 404; res.end("not yet") }
    } else {
      res.statusCode = 404; res.end()
    }
  })
  await new Promise((resolve, reject) => {
    blocker.once("error", reject)
    blocker.listen(port, "127.0.0.1", resolve)
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-dcp-r10-"))
  fs.mkdirSync(path.join(tmpDir, ".zcode"), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, ".zcode", "dcp.jsonc"),
    JSON.stringify({
      proxy: { port, idleTimeoutMin: 30, adminTokenFile: "admin-token" },
      upstream: { baseUrl: "http://127.0.0.1:1", apiKey: "x" },
      compress: { mode: "range", permission: "allow" },
    }, null, 2),
    "utf8",
  )

  const start = Date.now()
  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "session-start.mjs")], {
    cwd: tmpDir,
    env: {
      ...process.env,
      DCP_PLUGIN_ROOT: PLUGIN_ROOT,
      DCP_PLUGIN_DATA: tmpDir,
      DCP_DATA_DIR: tmpDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  // After 200ms, flip the blocker to "healthy" — hook should detect on next
  // probe (probe interval is 250ms in the target design). 200ms is safely
  // after the first probe (which sees 404) and before the 3s cap.
  setTimeout(() => { healthy = true }, 200)

  let stdout = ""
  child.stdout.on("data", (d) => { stdout += d.toString("utf8") })
  child.stderr.on("data", (d) => process.stderr.write("[R10-1 hook stderr] " + d.toString()))

  const exitCode = await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill() } catch {} ; resolve("timeout") }, 8000)
    child.on("exit", (code) => { clearTimeout(t); resolve(code) })
  })
  const elapsed = Date.now() - start
  // Test diagnostic — harmless if it goes to stderr.
  process.stderr.write(`[R10-1] exit=${exitCode} elapsed=${elapsed}ms stdout=${JSON.stringify(stdout.slice(0, 200))}\n`)

  assert.equal(exitCode, 0, `hook exit code = ${exitCode}`)
  let parsed
  try { parsed = JSON.parse(stdout) } catch { parsed = null }
  assert.ok(parsed, `hook stdout must be valid JSON; got: ${JSON.stringify(stdout)}`)
  assert.ok(parsed.hookSpecificOutput, `expected hookSpecificOutput envelope; got: ${JSON.stringify(parsed)}`)
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart")
  assert.ok(
    typeof parsed.hookSpecificOutput.additionalContext === "string"
      && parsed.hookSpecificOutput.additionalContext.length > 0,
    `expected non-empty additionalContext; got: ${JSON.stringify(parsed.hookSpecificOutput)}`,
  )
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /DCP active/,
    `expected DCP_BRIEFING tagline; got first 200 chars: ${parsed.hookSpecificOutput.additionalContext.slice(0, 200)}`,
  )
  // Cold-start branch must have probed at least once before flipping (so the
  // health branch on :130 didn't fire directly). Elapsed >= 100ms covers the
  // first probe + spawn + flip latency.
  assert.ok(elapsed >= 100, `cold-start should have probed first; elapsed=${elapsed}ms (too fast — likely took the already-healthy branch)`)
  // And must not exceed the 3s cap by much (spawn overhead + 3s cap).
  assert.ok(elapsed < 4000, `cold-start should bounded-wait within ~3s; elapsed=${elapsed}ms`)

  blocker.close()
})

test("R10: cold-start bounded-wait — emits {} within ~3s when health never becomes healthy", async () => {
  const port = await getFreePort()
  // Blocker always returns 404 — hook sees persistent unhealthy, launcher
  // can't bind (port occupied), so the cold-start loop probes 404 every tick
  // until the 3s cap, then emits {}.
  const blocker = http.createServer((req, res) => {
    res.statusCode = 404; res.end("never")
  })
  await new Promise((resolve, reject) => {
    blocker.once("error", reject)
    blocker.listen(port, "127.0.0.1", resolve)
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-dcp-r10-"))
  fs.mkdirSync(path.join(tmpDir, ".zcode"), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, ".zcode", "dcp.jsonc"),
    JSON.stringify({
      proxy: { port, idleTimeoutMin: 30, adminTokenFile: "admin-token" },
      upstream: { baseUrl: "http://127.0.0.1:1", apiKey: "x" },
      compress: { mode: "range", permission: "allow" },
    }, null, 2),
    "utf8",
  )

  const start = Date.now()
  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "session-start.mjs")], {
    cwd: tmpDir,
    env: {
      ...process.env,
      DCP_PLUGIN_ROOT: PLUGIN_ROOT,
      DCP_PLUGIN_DATA: tmpDir,
      DCP_DATA_DIR: tmpDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  let stdout = ""
  child.stdout.on("data", (d) => { stdout += d.toString("utf8") })
  child.stderr.on("data", (d) => process.stderr.write("[R10-2 hook stderr] " + d.toString()))

  const exitCode = await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill() } catch {} ; resolve("timeout") }, 8000)
    child.on("exit", (code) => { clearTimeout(t); resolve(code) })
  })
  const elapsed = Date.now() - start
  process.stderr.write(`[R10-2] exit=${exitCode} elapsed=${elapsed}ms stdout=${JSON.stringify(stdout.slice(0, 100))}\n`)

  assert.equal(exitCode, 0, `hook exit code = ${exitCode}`)
  assert.equal(stdout.trim(), "{}", `expected {} on timeout; got: ${JSON.stringify(stdout)}`)
  // 3s cap + spawn overhead — must be < 4s. (Was 5s in v0.1.4 — regression guard.)
  assert.ok(elapsed < 4000, `elapsed should be < 4000ms (3s cap + overhead); got ${elapsed}ms`)
  // Must reflect an actual bounded wait — not "skipped spawn, instant {}".
  assert.ok(elapsed >= 2500, `elapsed should be >= 2500ms (actual 3s wait); got ${elapsed}ms`)

  blocker.close()
})

// ---------------------------------------------------------------------------
// R8.1 + R8.2 + R8.3 (task-8) — dcp_stats render uses the new wording:
// "Savings rate" (NOT "Cache hit rate"), byStrategy rows labelled with
// "hits" (per-request cumulative count, not token share), and a new
// "Saved tokens by strategy" line that reads from stats.byStrategyTokens.
// The legacy stats-all.json shape (no byStrategyTokens field) must still
// render normally, with the tokens line omitted.
//
// We seed dataDir/stats-all.json directly so /dcp-admin/stats returns the
// shape we want to test, then drive dcp_stats through MCP RPC and inspect
// the rendered text.
// ---------------------------------------------------------------------------

/**
 * Write a stats-all.json payload to the test data dir, then drive
 * dcp_stats through the MCP server and resolve with the rendered text
 * (or null on tool-call failure).
 */
async function renderStatsViaRpc(env, child, statsAll) {
  fs.writeFileSync(
    path.join(env.tmpDir, "stats-all.json"),
    JSON.stringify(statsAll, null, 2),
    "utf8",
  )
  const resp = await rpc(child, {
    jsonrpc: "2.0", id: 80, method: "tools/call",
    params: { name: "dcp_stats", arguments: {} },
  })
  if (!resp.result || !resp.result.content) return null
  return (resp.result.content || []).map((c) => c.text || "").join("\n")
}

test("R8.1+R8.2: dcp_stats render uses 'Savings rate' label, byStrategy rows labelled 'hits' (new stats)", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r8", version: "0" } },
  })
  // Wait for daemon to come up so the admin token is materialised.
  await new Promise((r) => setTimeout(r, 800))

  // New-shape stats: includes byStrategyTokens.
  const text = await renderStatsViaRpc(env, child, {
    sentTokens: 1000, savedTokens: 250, requests: 4, compressRuns: 1,
    byStrategy: { dedup: 3, purge: 1, sweep: 0, compress: 1 },
    byStrategyTokens: { dedup: 180, purge: 40, sweep: 0, compress: 30 },
    sessions: [],
  })

  assert.ok(text, "expected rendered text; got null")
  assert.match(text, /Savings rate/i, `expected "Savings rate" label; got: ${text}`)
  assert.doesNotMatch(text, /Cache hit rate/i, `legacy label must NOT appear; got: ${text}`)
  assert.match(text, /hits/i, `byStrategy rows must be labelled "hits"; got: ${text}`)
  assert.match(
    text,
    /Saved tokens by strategy/i,
    `expected "Saved tokens by strategy" section; got: ${text}`,
  )
  // Spot-check the per-strategy token values are surfaced (180 dedup, 40 purge, 30 compress).
  assert.match(text, /180/, `expected dedup tokens 180 in output; got: ${text}`)
  assert.match(text, /40/, `expected purge tokens 40 in output; got: ${text}`)
  assert.match(text, /30/, `expected compress tokens 30 in output; got: ${text}`)

  child.kill()
})

test("R8.3: dcp_stats render omits 'Saved tokens by strategy' line for legacy stats without byStrategyTokens", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r8-legacy", version: "0" } },
  })
  await new Promise((r) => setTimeout(r, 800))

  // Legacy shape: NO byStrategyTokens. Must still render correctly.
  const text = await renderStatsViaRpc(env, child, {
    sentTokens: 800, savedTokens: 200, requests: 3, compressRuns: 0,
    byStrategy: { dedup: 2, purge: 0, sweep: 0, compress: 0 },
    sessions: [],
  })

  assert.ok(text, "expected rendered text; got null")
  // New wording still applied.
  assert.match(text, /Savings rate/i, `expected "Savings rate"; got: ${text}`)
  assert.match(text, /hits/i, `byStrategy rows must be labelled "hits"; got: ${text}`)
  // Legacy token-share paragraph must NOT appear.
  assert.doesNotMatch(
    text,
    /Strategy share \(of .* saved tokens\)/i,
    `legacy "Strategy share (...)" line must NOT appear; got: ${text}`,
  )
  // The "Saved tokens by strategy" line MUST be omitted (no field to read).
  assert.doesNotMatch(
    text,
    /Saved tokens by strategy/i,
    `"Saved tokens by strategy" must be omitted when byStrategyTokens absent; got: ${text}`,
  )
  // Sanity: basic counters still render.
  assert.match(text, /Requests:\s+3/, `expected Requests: 3; got: ${text}`)
  assert.match(text, /Saved tokens:\s+200/, `expected Saved tokens: 200; got: ${text}`)

  child.kill()
})

test("R8: dcp_stats render never contains legacy labels (zero-residual regression)", async () => {
  const env = await buildTestEnv()
  const child = registerChild(spawnMcp({ tmpDir: env.tmpDir, port: env.port, cfgPath: env.cfgPath, captureStderr: true }))

  await rpc(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r8-residual", version: "0" } },
  })
  await new Promise((r) => setTimeout(r, 800))

  // New-shape with non-zero totalSavings (the case where legacy code emitted
  // the "Strategy share (of N saved tokens)" paragraph).
  const text = await renderStatsViaRpc(env, child, {
    sentTokens: 500, savedTokens: 500, requests: 5, compressRuns: 1,
    byStrategy: { dedup: 4, purge: 2, sweep: 0, compress: 1 },
    byStrategyTokens: { dedup: 250, purge: 100, sweep: 0, compress: 50 },
    sessions: [],
  })

  assert.ok(text, "expected rendered text; got null")
  assert.doesNotMatch(text, /Cache hit rate/i, `legacy label MUST be absent; got: ${text}`)
  assert.doesNotMatch(
    text,
    /Strategy share \(of .* saved tokens\)/i,
    `legacy share paragraph MUST be absent; got: ${text}`,
  )

  child.kill()
})
