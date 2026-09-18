// SPDX-License-Identifier: AGPL-3.0-or-later
//
// sweep.test.mjs — TDD tests for Gate 1.5 B2 (real sweep via directive).
//
// Coverage:
//   ① config: commands.protectedTools default = DCP 10-tool list + array-union merge
//   ② session: sweepDirective field round-trip + default-null + legacy-file compat
//   ③ pipeline: since-user mode consumes directive, skips protected tools,
//      skips is_error tool_results, counts applied/skipped, clears directive
//   ④ pipeline: last-n mode consumes directive (n=2)
//   ⑤ pipeline: no-directive regression — behavior unchanged when directive is null
//   ⑥ pipeline: since-user mode → only tool_uses AFTER the LAST user message
//   ⑦ daemon admin: state/sweep?n= writes sweepDirective to most-recent fp
//   ⑧ daemon admin: state/sweep (no args) writes since-user directive
//   ⑨ daemon admin: state/sweep with invalid N → 400 / ignored

import { describe, it, before, after, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

import {
  DEFAULT_CONFIG,
  mergeConfig,
  loadConfig,
  validateConfig,
} from "../proxy/config.mjs"
import {
  defaultLightState,
  loadLightState,
  saveLightState,
  sessionFingerprint,
} from "../proxy/session.mjs"
import { transformRequest } from "../proxy/pipeline.mjs"
import { startDaemon } from "../proxy/daemon.mjs"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAIN_SYSTEM = [{ type: "text", text: "You are ZCode. Be helpful." }]

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function rmTmpDir(p) {
  if (!p) return
  try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ }
}

function makeBaseBody(extra = {}) {
  return {
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    system: MAIN_SYSTEM,
    messages: [],
    ...extra,
  }
}

function makeConfig(overrides = {}) {
  const base = {
    compress: {
      mode: "range",
      permission: "allow",
      summaryBuffer: false,
      maxContextLimit: 100000,
      minContextLimit: 50000,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      nudgeForce: "soft",
      protectedTools: [],
      protectTags: false,
      protectUserMessages: false,
    },
    strategies: {
      deduplication: { enabled: false, protectedTools: [] },
      purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
    },
    turnProtection: { enabled: false, turns: 4 },
    protectedFilePatterns: [],
    commands: { enabled: true, protectedTools: [...DEFAULT_CONFIG.commands.protectedTools] },
    manualMode: { enabled: false, automaticStrategies: true },
    experimental: { allowSubAgents: false, customPrompts: false },
  }
  return mergeDeep(base, overrides)
}

function mergeDeep(target, src) {
  const out = JSON.parse(JSON.stringify(target))
  for (const key of Object.keys(src || {})) {
    const v = src[key]
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      out[key] && typeof out[key] === "object" && !Array.isArray(out[key])
    ) {
      out[key] = mergeDeep(out[key], v)
    } else {
      out[key] = v
    }
  }
  return out
}

const LOW_USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/**
 * Build a conversation with 4 tool calls AFTER the user's last prompt:
 *   - "call_todo"     — TodoWrite (in default commands.protectedTools) → must be SKIPPED
 *   - "call_err"      — Read with is_error=true tool_result → must be SKIPPED
 *                       (purge-errors semantics reserved; sweep must NOT touch errors)
 *   - "call_ok"       — Read with normal content → must be SWEPT
 *   - "call_protect"  — Write with file_path=docs/SPEC.md matching
 *                       protectedFilePatterns → must be SKIPPED
 *
 * Structure: user prompt → 4 tool_use/tool_result pairs. The "now sweep"
 * line is intentionally ABSENT — in real usage the user invokes
 * `/dcp sweep` via ZCode's slash command (which is intercepted client-side
 * and is NOT added to the messages array). So the last user message WITH
 * text content in the array is the user's actual last prompt at index 0.
 */
function buildConversation() {
  return [
    // User's last prompt — anchor for since-user mode
    { role: "user", content: [{ type: "text", text: "do complex task that requires multiple tool calls" }] },
    // 4 tool_use/tool_result pairs after the prompt
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_todo", name: "TodoWrite", input: { todos: [{ content: "x", status: "pending", activeform: "y" }] } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_todo", content: "ok" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_err", name: "Read", input: { file_path: "src/missing.ts" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_err", is_error: true, content: "ENOENT" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_ok", name: "Read", input: { file_path: "src/auth.ts" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_ok", content: "AUTH_BODY" + "Z".repeat(400) }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_protect", name: "Write", input: { file_path: "docs/SPEC.md", content: "spec body" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_protect", content: "ok" }],
    },
  ]
}

// ---------------------------------------------------------------------------
// ① config.commands.protectedTools — DCP-faithful default + array-union merge
// ---------------------------------------------------------------------------

describe("config.commands.protectedTools", () => {
  it("① default includes the 10 DCP-default tools (lowercase)", () => {
    // DCP lib/config.ts:78-89 DEFAULT_PROTECTED_TOOLS — task, skill, todowrite,
    // todoread, compress, batch, plan_enter, plan_exit, write, edit.
    const expected = [
      "task",
      "skill",
      "todowrite",
      "todoread",
      "compress",
      "batch",
      "plan_enter",
      "plan_exit",
      "write",
      "edit",
    ]
    assert.ok(
      Array.isArray(DEFAULT_CONFIG.commands.protectedTools),
      "commands.protectedTools must be an array",
    )
    assert.equal(
      DEFAULT_CONFIG.commands.protectedTools.length,
      expected.length,
      `expected ${expected.length} default tools, got ${DEFAULT_CONFIG.commands.protectedTools.length}`,
    )
    for (const name of expected) {
      assert.ok(
        DEFAULT_CONFIG.commands.protectedTools.includes(name),
        `default must include '${name}'; got ${JSON.stringify(DEFAULT_CONFIG.commands.protectedTools)}`,
      )
    }
  })

  it("① array-union merge: override appends without dropping base entries", () => {
    const base = {
      ...DEFAULT_CONFIG,
      commands: {
        enabled: true,
        protectedTools: [...DEFAULT_CONFIG.commands.protectedTools],
      },
    }
    const override = { commands: { protectedTools: ["mcp__custom__shield"] } }
    const merged = mergeConfig([base, override])
    const arr = merged.commands.protectedTools
    // base 10 + 1 new entry = 11
    assert.equal(arr.length, 11, `expected 11 entries after union; got ${arr.length}: ${JSON.stringify(arr)}`)
    assert.ok(arr.includes("mcp__custom__shield"), "override entry must survive merge")
    for (const def of DEFAULT_CONFIG.commands.protectedTools) {
      assert.ok(arr.includes(def), `default '${def}' must survive merge`)
    }
  })

  it("① validateConfig recognises commands.protectedTools without warnings on default", () => {
    // The DEFAULT_CONFIG.commands.protectedTools must validate clean — no
    // "Unknown key" or "expected string[]" warnings.
    const warnings = validateConfig(DEFAULT_CONFIG)
    const relevant = warnings.filter(
      (w) => /commands\.protectedTools/.test(w) || /Unknown key/.test(w),
    )
    assert.deepEqual(relevant, [], `unexpected warnings: ${JSON.stringify(relevant)}`)
  })
})

// ---------------------------------------------------------------------------
// ② session — sweepDirective field
// ---------------------------------------------------------------------------

describe("session.sweepDirective", () => {
  let dataDir, fp
  beforeEach(() => {
    dataDir = mkTmpDir("dcp-sweep-state-")
    fp = "1234567890abcdef"
  })
  afterEach(() => rmTmpDir(dataDir))

  it("② default state carries sweepDirective=null", () => {
    const st = defaultLightState()
    assert.ok("sweepDirective" in st, "defaultLightState must declare sweepDirective key")
    assert.equal(st.sweepDirective, null, "default sweepDirective must be null")
  })

  it("② round-trip: since-user directive survives save → load", () => {
    const st = defaultLightState()
    st.sweepDirective = { mode: "since-user", n: null, requestedAt: 1234567890 }
    saveLightState(dataDir, fp, st)
    const loaded = loadLightState(dataDir, fp)
    assert.deepEqual(
      loaded.sweepDirective,
      { mode: "since-user", n: null, requestedAt: 1234567890 },
      "since-user directive must round-trip",
    )
  })

  it("② round-trip: last-n directive survives save → load", () => {
    const st = defaultLightState()
    st.sweepDirective = { mode: "last-n", n: 7, requestedAt: 987 }
    saveLightState(dataDir, fp, st)
    const loaded = loadLightState(dataDir, fp)
    assert.deepEqual(
      loaded.sweepDirective,
      { mode: "last-n", n: 7, requestedAt: 987 },
    )
  })

  it("② backwards-compat: legacy file (no sweepDirective field) loads with sweepDirective=null", () => {
    // Pre-B2 light-state files do NOT have a sweepDirective key. normalizeLightState
    // must default to null so a pipeline that consumes the directive does not crash.
    const lsPath = path.join(dataDir, "light-state", `${fp}.json`)
    fs.mkdirSync(path.dirname(lsPath), { recursive: true })
    const legacy = {
      anchors: { context: [], turn: [], iter: [] },
      fetchCount: 7,
      sweepToolCallIds: ["seed"],
      decompressBlockIds: [],
      manualMode: false,
      maxRunIdSeen: null,
    }
    fs.writeFileSync(lsPath, JSON.stringify(legacy), "utf8")
    const loaded = loadLightState(dataDir, fp)
    assert.equal(loaded.sweepDirective, null, "legacy file must load with sweepDirective=null")
    // Existing fields preserved (regression check)
    assert.equal(loaded.fetchCount, 7)
    assert.deepEqual(loaded.sweepToolCallIds, ["seed"])
  })
})

// ---------------------------------------------------------------------------
// ③ pipeline — since-user mode consumes directive
// ---------------------------------------------------------------------------

describe("pipeline.transformRequest — sweepDirective consumption", () => {
  let tmpDir
  before(() => { tmpDir = mkTmpDir("dcp-sweep-pipeline-") })
  after(() => { rmTmpDir(tmpDir) })

  function callTransform(messages, directive, cfgOverrides = {}) {
    const lightState = defaultLightState()
    if (directive !== undefined) lightState.sweepDirective = directive
    const body = makeBaseBody({ messages })
    return transformRequest(body, {
      config: makeConfig(cfgOverrides),
      lightState,
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    })
  }

  it("③ since-user: consumes directive, applies to non-protected non-error tool_uses after last user", () => {
    const messages = buildConversation()
    const directive = { mode: "since-user", n: null, requestedAt: Date.now() }
    const result = callTransform(messages, directive, {
      protectedFilePatterns: ["docs/**"],
    })

    // byStrategy.sweep must reflect applied count = 1 (only call_ok; TodoWrite
    // hits protected-tools, call_err is is_error, call_protect matches
    // protectedFilePatterns).
    assert.ok(result.metrics.byStrategy, "byStrategy missing")
    assert.equal(
      result.metrics.byStrategy.sweep, 1,
      `expected exactly 1 swept tool (call_ok); got byStrategy.sweep=${result.metrics.byStrategy.sweep}`,
    )

    // sweep bucket > 0 (tokens estimated for the call_ok tool_use + tool_result pair)
    assert.ok(
      result.metrics.savedTokensByStrategy.sweep > 0,
      `sweep token bucket must be > 0; got ${result.metrics.savedTokensByStrategy.sweep}`,
    )

    // Directive cleared in lightStateUpdates
    assert.ok(
      result.lightStateUpdates && result.lightStateUpdates.sweepDirective === null,
      `directive must be cleared in lightStateUpdates; got ${JSON.stringify(result.lightStateUpdates && result.lightStateUpdates.sweepDirective)}`,
    )

    // sweepLastResult recorded with applied + skipped count
    assert.ok(
      result.lightStateUpdates && result.lightStateUpdates.sweepLastResult,
      "sweepLastResult must be recorded",
    )
    assert.equal(result.lightStateUpdates.sweepLastResult.applied, 1, "applied=1")
    assert.equal(
      result.lightStateUpdates.sweepLastResult.skippedProtected, 2,
      "skippedProtected=2 (TodoWrite protected + Write protected-by-pattern)",
    )

    // The actual tool_result for call_ok MUST carry PRUNED_TOOL_OUTPUT —
    // proof the applyPrune layer saw the directive-driven id.
    let sawPruned = false
    for (const m of result.body.messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue
      for (const p of m.content) {
        if (
          p && p.type === "tool_result" && p.tool_use_id === "call_ok" &&
          typeof p.content === "string" && p.content.startsWith(
            // PRUNED_TOOL_OUTPUT constant lives in prune.mjs; the sweep path
            // uses the same placeholder so we can match by the substring.
            "[Output removed to save context",
          )
        ) {
          sawPruned = true
        }
      }
    }
    assert.ok(sawPruned, "call_ok's tool_result must be placeholder-substituted")
  })

  it("③ since-user: only tool_uses AFTER the last user message are eligible", () => {
    // Anchor: two user messages. First → 3 tool_uses before it; second → 3
    // tool_uses after it. The since-user mode must target ONLY the 3 after
    // the last user message, leaving the 2 earlier ones untouched.
    const messages = [
      { role: "user", content: [{ type: "text", text: "first ask" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_pre_1", name: "Read", input: { file_path: "a.ts" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_pre_1", content: "BODY_A" + "X".repeat(300) }] },
      { role: "user", content: [{ type: "text", text: "second ask — last user before sweep trigger" }] },
      // ↑ anchor: all tool_uses AFTER this are eligible for since-user sweep
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_post_1", name: "Read", input: { file_path: "b.ts" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_post_1", content: "BODY_B" + "Y".repeat(300) }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_post_2", name: "Read", input: { file_path: "c.ts" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_post_2", content: "BODY_C" + "Z".repeat(300) }] },
    ]
    const directive = { mode: "since-user", n: null, requestedAt: Date.now() }
    const result = callTransform(messages, directive)

    // byStrategy.sweep must equal 2 (call_post_1 + call_post_2). The earlier
    // call_pre_1 is BEFORE the last user message → must NOT be touched.
    assert.equal(
      result.metrics.byStrategy.sweep, 2,
      `expected 2 swept tools (post-anchor); got ${result.metrics.byStrategy.sweep}`,
    )

    // call_pre_1's tool_result body must still contain BODY_A (proof the
    // pre-anchor tool_use was not swept).
    let preAnchorsurvives = false
    for (const m of result.body.messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue
      for (const p of m.content) {
        if (
          p && p.type === "tool_result" && p.tool_use_id === "call_pre_1" &&
          typeof p.content === "string" && p.content.includes("BODY_A")
        ) {
          preAnchorsurvives = true
        }
      }
    }
    assert.ok(preAnchorsurvives, "call_pre_1 (pre-anchor) must NOT be swept")
  })

  // ④ last-n mode
  it("④ last-n: consumes directive (n=2), applies to most recent 2 tool_uses", () => {
    const messages = buildConversation()
    const directive = { mode: "last-n", n: 2, requestedAt: Date.now() }
    const result = callTransform(messages, directive)

    // byStrategy.sweep must equal the count of non-protected, non-error,
    // non-protected-by-pattern tools AMONG the most recent 2 tool_uses.
    // Tool-use order in buildConversation:
    //   1. call_todo  (TodoWrite → protected, skip)
    //   2. call_err   (is_error → skip)
    //   3. call_ok    (apply)
    //   4. call_protect (Write + protectedFilePatterns → skip)
    // last-2 = [call_ok, call_protect] → only call_ok applies → applied=1.
    assert.equal(
      result.metrics.byStrategy.sweep, 1,
      `last-n=2 expected 1 sweep (call_ok); got ${result.metrics.byStrategy.sweep}`,
    )
    assert.equal(result.lightStateUpdates.sweepLastResult.applied, 1)
  })

  // ⑤ no-directive regression
  it("⑤ no-directive regression: lightState without sweepDirective behaves like baseline", () => {
    // When sweepDirective is absent (legacy / never-set state), the pipeline
    // must behave IDENTICALLY to before — no sweep additions, no skippedProtected
    // counted, no byStrategy.sweep increments.
    const messages = buildConversation()
    const lightState = defaultLightState()
    // explicit: no sweepDirective, no sweepToolCallIds
    const body = makeBaseBody({ messages })
    const result = transformRequest(body, {
      config: makeConfig(),
      lightState,
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    })
    assert.equal(result.metrics.byStrategy.sweep, 0, "no directive → byStrategy.sweep===0")
    assert.equal(result.metrics.savedTokensByStrategy.sweep, 0, "no directive → token bucket=0")
  })

  it("⑤ no-directive: lightStateUpdates must NOT carry sweepLastResult", () => {
    // Without a directive, the pipeline should not emit a sweepLastResult —
    // that field is reserved for the post-consume accounting.
    const messages = buildConversation()
    const result = callTransform(messages, null)
    assert.ok(result.lightStateUpdates)
    assert.equal(
      result.lightStateUpdates.sweepLastResult, undefined,
      `without directive, sweepLastResult must be undefined; got ${JSON.stringify(result.lightStateUpdates.sweepLastResult)}`,
    )
  })
})

// ---------------------------------------------------------------------------
// ⑦⑧ daemon admin — state/sweep writes directive to most-recent fp
// ---------------------------------------------------------------------------

describe("daemon — admin state/sweep action", () => {
  let tmpDir
  beforeEach(() => { tmpDir = mkTmpDir("dcp-sweep-admin-") })
  afterEach(() => { rmTmpDir(tmpDir) })

  function makeFp() {
    // We need a real fp that survives sessionFingerprint(). Write a body
    // fingerprint locally so the admin's "latest fp" lookup finds it.
    return sessionFingerprint({
      model: "x",
      system: "You are ZCode.",
      messages: [
        { role: "user", content: [{ type: "text", text: "session anchor" }] },
      ],
    })
  }

  function writeActive(fp, ts = Date.now()) {
    const activePath = path.join(tmpDir, "active-sessions.json")
    fs.writeFileSync(activePath, JSON.stringify({ [fp]: { lastSeenTs: ts } }), "utf8")
  }

  function writeSeedState(fp, extra = {}) {
    const dir = path.join(tmpDir, "light-state")
    fs.mkdirSync(dir, { recursive: true })
    const base = {
      anchors: { context: [], turn: [], iter: [] },
      fetchCount: 0,
      sweepToolCallIds: [],
      decompressBlockIds: [],
      manualMode: false,
      maxRunIdSeen: null,
    }
    fs.writeFileSync(path.join(dir, `${fp}.json`), JSON.stringify({ ...base, ...extra }), "utf8")
  }

  async function startTestDaemon() {
    const cfg = {
      ...DEFAULT_CONFIG,
      proxy: {
        port: 0, // OS-assigned
        idleTimeoutMin: 30,
        adminTokenFile: "admin-token",
        adminProbeTimeoutMs: 1500,
      },
      upstream: { baseUrl: "http://127.0.0.1:1", apiKey: "x" },
      debug: false,
    }
    const handle = await startDaemon({ config: cfg, dataDir: tmpDir })
    return handle
  }

  function adminGet(port, token, urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1", port, path: urlPath, method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            "x-api-key": token,
          },
          timeout: 4000,
        },
        (res) => {
          const chunks = []
          res.on("data", (c) => chunks.push(c))
          res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }))
          res.on("error", reject)
        },
      )
      req.on("error", reject)
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
      req.end()
    })
  }

  it("⑦ state/sweep (no args) writes since-user directive to most-recent fp", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp)
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/sweep")
      assert.equal(r.statusCode, 200, `expected 200; got ${r.statusCode}: ${r.body.toString("utf8")}`)
      const loaded = loadLightState(tmpDir, fp)
      assert.ok(loaded.sweepDirective, "sweepDirective must be set after admin call")
      assert.equal(loaded.sweepDirective.mode, "since-user")
      assert.equal(loaded.sweepDirective.n, null)
      assert.ok(typeof loaded.sweepDirective.requestedAt === "number")
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑦ state/sweep?n=3 writes last-n directive with n=3", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp)
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/sweep?n=3")
      assert.equal(r.statusCode, 200)
      const loaded = loadLightState(tmpDir, fp)
      assert.ok(loaded.sweepDirective)
      assert.equal(loaded.sweepDirective.mode, "last-n")
      assert.equal(loaded.sweepDirective.n, 3)
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑨ state/sweep?n=abc (invalid) → 400 (NOT silently ignored)", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp)
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/sweep?n=abc")
      assert.equal(r.statusCode, 400, `expected 400 on bad n; got ${r.statusCode}`)
      // And the directive must NOT have been written
      const loaded = loadLightState(tmpDir, fp)
      assert.equal(loaded.sweepDirective, null, "invalid n must not leave a partial directive")
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑨ state/sweep?n=-5 (negative) → 400", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp)
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/sweep?n=-5")
      assert.equal(r.statusCode, 400, `expected 400 on negative n; got ${r.statusCode}`)
      const loaded = loadLightState(tmpDir, fp)
      assert.equal(loaded.sweepDirective, null)
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑦ no active session → 404 (unchanged from before)", async () => {
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/sweep")
      assert.equal(r.statusCode, 404)
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })
})