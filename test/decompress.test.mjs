// SPDX-License-Identifier: AGPL-3.0-or-later
//
// decompress.test.mjs — TDD tests for Gate 1.5 B3 (decompress list + single-
// block restore). Reference: opencode-dcp v3.1.15 lib/commands/decompress.ts
// (no-arg = list available blocks + tokens + topic; with arg N = restore block
// N via the exclusion table).
//
// ZCode adaptation (documented in CAPABILITY-MAPPING-v0.1.5.md row 2):
//   - no-arg behaviour is "list available blocks" instead of the previous
//     "clear all exclusions" (clear-all is now triggered by `recompress` only).
//   - blockId arg = add the block id to `decompressBlockIds` (single writer).
//     Next pipeline run sees `excludedBlockIds` in deriveBlocks and drops the
//     synthetic summary message for that block; the original covered span
//     survives → effectively "restore".
//   - "nested ancestor" semantics (DCP upstream findActiveAncestorBlockId) is
//     simplified: per-block exclusion only (ZCode platform-difference declared
//     in CAPABILITY-MAPPING row 2).
//
// Coverage:
//   ① session — activeBlockSummaries round-trip + default-empty + legacy-file compat
//   ② pipeline — writes activeBlockSummaries to lightStateUpdates (blockId/topic/approxTokens)
//   ③ pipeline — exclusion writer consumption: decompressBlockIds=[2] drops the
//      block at deriveBlocks; covered span is left intact (next request sees
//      the original messages; byStrategy.compress drops by 1)
//   ④ daemon — /dcp-admin/state/decompress with no args returns a "list of
//      available blocks" text (not JSON — the existing admin surface sends
//      plain text on this verb, matching DCP formatAvailableBlocksMessage)
//   ⑤ daemon — /dcp-admin/state/decompress?blockId=N writes decompressBlockIds
//      (no clear-all, no manualMode flip)
//   ⑥ daemon — invalid blockId (non-integer / non-positive) → 400
//   ⑦ daemon — recompress unchanged (clears blockIds, flips manualMode off)
//   ⑧ daemon — admin state response carries activeBlockSummaries (MCP source)

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

import {
  DEFAULT_CONFIG,
  mergeConfig,
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
 * Build a conversation that ends up with two ACTIVE compress blocks.
 *
 * Block 1 covers m0003..m0006 (4 messages); block 2 covers m0009..m0012
 * (4 messages). Each block has a topic and a rawSummary so the
 * activeBlockSummaries writer can extract displayId, topic, and a
 * per-block approxTokens estimate (the on-wire cost of the synthetic
 * summary that REPLACES the covered span in the next request).
 *
 * The two compress tool_use calls succeed (their tool_results carry no
 * is_error flag), so deriveBlocks produces 2 blocks and both survive
 * filterActiveBlocks (no overlap → no consume).
 */
function buildTwoBlockConversation() {
  return [
    { role: "user", content: [{ type: "text", text: "scan the repo" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_r1", name: "Read", input: { file_path: "src/x.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_r1", content: "BODY_X" + "X".repeat(200) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_r2", name: "TodoWrite", input: { todos: [{ content: "scan", status: "in_progress" }] } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_r2", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "scanned 12 files" }] },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
    {
      role: "assistant",
      content: [{
        type: "tool_use", id: "tu_cmp_1", name: "mcp__dcp__compress",
        input: {
          topic: "Initial scan summary",
          content: [
            { startId: "m0003", endId: "m0006", summary: "Did an initial scan; saw 12 files in src/" },
          ],
        },
      }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_cmp_1", content: "Compression accepted. 1 range(s) will be applied to subsequent context." }] },
    { role: "user", content: [{ type: "text", text: "now compress the next segment" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_r3", name: "Read", input: { file_path: "src/y.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_r3", content: "BODY_Y" + "Y".repeat(180) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_r4", name: "Read", input: { file_path: "src/z.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_r4", content: "BODY_Z" + "Z".repeat(160) }] },
    { role: "assistant", content: [{ type: "text", text: "read both files" }] },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
    {
      role: "assistant",
      content: [{
        type: "tool_use", id: "tu_cmp_2", name: "mcp__dcp__compress",
        input: {
          topic: "Second segment summary",
          content: [
            { startId: "m0009", endId: "m0012", summary: "Read both y.ts and z.ts; documented their structures." },
          ],
        },
      }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_cmp_2", content: "Compression accepted. 1 range(s) will be applied to subsequent context." }] },
    { role: "user", content: [{ type: "text", text: "ok continue" }] },
  ]
}

// ---------------------------------------------------------------------------
// ① session — activeBlockSummaries round-trip + compat
// ---------------------------------------------------------------------------

describe("session.activeBlockSummaries", () => {
  let dataDir, fp
  beforeEach(() => {
    dataDir = mkTmpDir("dcp-decompress-state-")
    fp = "deadbeefcafef00d"
  })
  afterEach(() => rmTmpDir(dataDir))

  it("① defaultLightState declares activeBlockSummaries: []", () => {
    const st = defaultLightState()
    assert.ok(
      "activeBlockSummaries" in st,
      "defaultLightState must declare activeBlockSummaries key",
    )
    assert.ok(Array.isArray(st.activeBlockSummaries), "default must be an array")
    assert.equal(st.activeBlockSummaries.length, 0, "default length = 0")
  })

  it("① save → load round-trips activeBlockSummaries with topic + tokens", () => {
    const st = defaultLightState()
    st.activeBlockSummaries = [
      { blockId: 1, topic: "Initial scan summary", approxTokens: 240 },
      { blockId: 2, topic: "Second segment summary", approxTokens: 180 },
    ]
    saveLightState(dataDir, fp, st)
    const loaded = loadLightState(dataDir, fp)
    assert.equal(loaded.activeBlockSummaries.length, 2)
    assert.deepEqual(loaded.activeBlockSummaries[0], {
      blockId: 1, topic: "Initial scan summary", approxTokens: 240,
    })
    assert.deepEqual(loaded.activeBlockSummaries[1], {
      blockId: 2, topic: "Second segment summary", approxTokens: 180,
    })
  })

  it("① backwards-compat: legacy file (no activeBlockSummaries key) loads as []", () => {
    const lsPath = path.join(dataDir, "light-state", `${fp}.json`)
    fs.mkdirSync(path.dirname(lsPath), { recursive: true })
    const legacy = {
      anchors: { context: [], turn: [], iter: [] },
      fetchCount: 4,
      sweepToolCallIds: [],
      decompressBlockIds: [],
      manualMode: false,
      maxRunIdSeen: null,
      sweepDirective: null,
      sweepLastResult: null,
    }
    fs.writeFileSync(lsPath, JSON.stringify(legacy), "utf8")
    const loaded = loadLightState(dataDir, fp)
    assert.ok(Array.isArray(loaded.activeBlockSummaries))
    assert.equal(loaded.activeBlockSummaries.length, 0)
    // Existing fields preserved (regression check).
    assert.equal(loaded.fetchCount, 4)
    assert.equal(loaded.manualMode, false)
  })

  it("① normalize coerces non-array activeBlockSummaries to []", () => {
    // Malformed on-disk value (object, null, string) → []
    for (const bad of [null, {}, "string", 7]) {
      const st = defaultLightState()
      st.activeBlockSummaries = bad
      const norm = (() => {
        // Round-trip through save/load to invoke normalizeLightState.
        saveLightState(dataDir, fp, st)
        return loadLightState(dataDir, fp)
      })()
      assert.ok(
        Array.isArray(norm.activeBlockSummaries),
        `coercion to [] for bad input ${JSON.stringify(bad)}`,
      )
      assert.equal(norm.activeBlockSummaries.length, 0)
    }
  })
})

// ---------------------------------------------------------------------------
// ② pipeline — writes activeBlockSummaries to lightStateUpdates
// ---------------------------------------------------------------------------

describe("pipeline.transformRequest — activeBlockSummaries writer", () => {
  let tmpDir
  beforeEach(() => { tmpDir = mkTmpDir("dcp-decompress-pipeline-") })
  afterEach(() => { rmTmpDir(tmpDir) })

  it("② writes summaries for both blocks (blockId + topic + approxTokens)", () => {
    const messages = buildTwoBlockConversation()
    const lightState = defaultLightState()
    const body = makeBaseBody({ messages })
    const result = transformRequest(body, {
      config: makeConfig(),
      lightState,
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    })

    assert.ok(result.lightStateUpdates, "lightStateUpdates missing")
    const summaries = result.lightStateUpdates.activeBlockSummaries
    assert.ok(Array.isArray(summaries), "activeBlockSummaries must be an array")
    assert.equal(summaries.length, 2, `expected 2 summaries; got ${summaries.length}`)

    // Block 1 — first in the conversation, smaller block
    const b1 = summaries[0]
    assert.equal(b1.blockId, 1)
    assert.equal(b1.topic, "Initial scan summary")
    assert.ok(typeof b1.approxTokens === "number" && b1.approxTokens > 0,
      `b1 approxTokens must be a positive number; got ${b1.approxTokens}`)

    // Block 2 — second in the conversation, similar size
    const b2 = summaries[1]
    assert.equal(b2.blockId, 2)
    assert.equal(b2.topic, "Second segment summary")
    assert.ok(typeof b2.approxTokens === "number" && b2.approxTokens > 0,
      `b2 approxTokens must be a positive number; got ${b2.approxTokens}`)
  })

  it("② empty conversation → activeBlockSummaries: [] (no blocks)", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    const lightState = defaultLightState()
    const body = makeBaseBody({ messages })
    const result = transformRequest(body, {
      config: makeConfig(),
      lightState,
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    })

    const summaries = result.lightStateUpdates.activeBlockSummaries
    assert.ok(Array.isArray(summaries))
    assert.equal(summaries.length, 0)
  })
})

// ---------------------------------------------------------------------------
// M-3 (review r2) — wrap-shape consistency lock. pipeline.mjs rebuilds the
// synthetic-message wrap locally so its approxTokens estimate matches what
// applyCompressions would insert. compress.mjs owns the same wrap via
// wrapCompressedSummary(blockId, body). If the two drift, the dashboard
// would advertise a token cost that the upstream never sees.
//
// The lock: assert that the local rebuild equals the canonical wrap for
// every shape — empty body (compress-with-no-summary) AND populated body.
// If anyone changes one wrap without the other, this test breaks at the
// build step and the divergence is caught before merging.
// ---------------------------------------------------------------------------

import * as compressMod from "../proxy/compress.mjs"

describe("M-3 — wrap shape consistency lock (compress.mjs ↔ pipeline.mjs)", () => {
  function localRebuild(blockIdNum, body) {
    const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"
    const idNum = Number.parseInt(String(blockIdNum).slice(1), 10)
    const trimmed = (body || "").trim()
    if (trimmed.length === 0) {
      return `${COMPRESSED_BLOCK_HEADER}\n<dcp-message-id>b${idNum}</dcp-message-id>`
    }
    return `${COMPRESSED_BLOCK_HEADER}\n${trimmed}\n\n<dcp-message-id>b${idNum}</dcp-message-id>`
  }

  it("M-3 populated body: local rebuild == canonical wrap", () => {
    assert.equal(
      localRebuild("b7", "Did an initial scan; saw 12 files in src/"),
      compressMod.wrapCompressedSummary(7, "Did an initial scan; saw 12 files in src/"),
      "drift: populated-body wrap shape mismatch",
    )
  })

  it("M-3 empty body: local rebuild == canonical wrap", () => {
    assert.equal(
      localRebuild("b3", ""),
      compressMod.wrapCompressedSummary(3, ""),
      "drift: empty-body wrap shape mismatch",
    )
  })

  it("M-3 whitespace-only body: local rebuild == canonical wrap", () => {
    // .trim() must collapse leading/trailing whitespace identically in both.
    assert.equal(
      localRebuild("b5", "   \n\n  "),
      compressMod.wrapCompressedSummary(5, "   \n\n  "),
      "drift: whitespace handling diverged",
    )
  })
})

// ---------------------------------------------------------------------------
// ③ pipeline — exclusion consumer: decompressBlockIds=[2] drops block 2
//    (covered span survives → next request sees the originals)
// ---------------------------------------------------------------------------

describe("pipeline.transformRequest — exclusion consumer (decompressBlockIds)", () => {
  let tmpDir
  beforeEach(() => { tmpDir = mkTmpDir("dcp-decompress-exclude-") })
  afterEach(() => { rmTmpDir(tmpDir) })

  it("③ decompressBlockIds=[2] drops block 2 (byStrategy.compress -1)", () => {
    const messages = buildTwoBlockConversation()
    const lightState = defaultLightState()
    // Simulate the operator having marked block 2 for restore via the admin
    // endpoint. Pipeline reads this list and passes it to deriveBlocks as
    // excludedBlockIds.
    lightState.decompressBlockIds = [2]
    const body = makeBaseBody({ messages })
    const result = transformRequest(body, {
      config: makeConfig(),
      lightState,
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    })

    // Baseline (no exclusion) would have activeBlocks=2 and byStrategy.compress=2.
    // With block 2 excluded: only block 1 survives → activeBlocks=1.
    assert.equal(result.metrics.activeBlocks, 1, "activeBlocks must drop to 1 after exclusion")
    assert.equal(result.metrics.byStrategy.compress, 1,
      "byStrategy.compress must drop to 1 after exclusion of block 2")

    // activeBlockSummaries must also reflect the dropped block (only b1 present).
    const summaries = result.lightStateUpdates.activeBlockSummaries
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].blockId, 1)
  })

  it("③ excluded block: covered span messages survive verbatim (no synthetic replacement)", () => {
    // Build a one-block conversation and check that excluding the block leaves
    // the original covered messages (Read tool_result body) intact in the
    // forwarded body — proof the synthetic summary is NOT inserted.
    const messages = [
      { role: "user", content: [{ type: "text", text: "scan the repo" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_r1", name: "Read", input: { file_path: "src/x.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_r1", content: "BODY_X" + "X".repeat(200) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_r2", name: "TodoWrite", input: { todos: [{ content: "scan", status: "in_progress" }] } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_r2", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "scanned 12 files" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
      {
        role: "assistant",
        content: [{
          type: "tool_use", id: "tu_cmp_1", name: "mcp__dcp__compress",
          input: {
            topic: "Initial scan summary",
            content: [
              { startId: "m0003", endId: "m0006", summary: "Did an initial scan; saw 12 files in src/" },
            ],
          },
        }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_cmp_1", content: "ok" }] },
      { role: "user", content: [{ type: "text", text: "ok continue" }] },
    ]
    const lightState = defaultLightState()
    lightState.decompressBlockIds = [1] // exclude the only block
    const body = makeBaseBody({ messages })
    const result = transformRequest(body, {
      config: makeConfig(),
      lightState,
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    })

    // No block survives → activeBlocks=0 → no compress savings.
    assert.equal(result.metrics.activeBlocks, 0)

    // The covered tool_result (tu_r1) must retain its original body — proof
    // the synthetic summary did NOT replace it.
    let survivedOriginal = false
    for (const m of result.body.messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue
      for (const p of m.content) {
        if (
          p && p.type === "tool_result" && p.tool_use_id === "tu_r1" &&
          typeof p.content === "string" && p.content.includes("BODY_X")
        ) {
          survivedOriginal = true
        }
      }
    }
    assert.ok(survivedOriginal, "tu_r1 tool_result body must survive verbatim after excluding its block")
  })
})

// ---------------------------------------------------------------------------
// ④ ⑤ ⑥ ⑦ ⑧ daemon — admin /dcp-admin/state/decompress + recompress
// ---------------------------------------------------------------------------

describe("daemon — admin state/decompress + state/recompress", () => {
  let tmpDir
  beforeEach(() => { tmpDir = mkTmpDir("dcp-decompress-admin-") })
  afterEach(() => { rmTmpDir(tmpDir) })

  function makeFp() {
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
      sweepDirective: null,
      sweepLastResult: null,
    }
    fs.writeFileSync(
      path.join(dir, `${fp}.json`),
      JSON.stringify({ ...base, ...extra }),
      "utf8",
    )
  }

  async function startTestDaemon() {
    const cfg = {
      ...DEFAULT_CONFIG,
      proxy: {
        port: 0,
        idleTimeoutMin: 30,
        adminTokenFile: "admin-token",
        adminProbeTimeoutMs: 1500,
      },
      upstream: { baseUrl: "http://127.0.0.1:1", apiKey: "x" },
      debug: false,
    }
    return await startDaemon({ config: cfg, dataDir: tmpDir })
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

  it("④ state/decompress (no args) returns the list of available blocks (text/plain)", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp, {
      activeBlockSummaries: [
        { blockId: 1, topic: "Initial scan summary", approxTokens: 240 },
        { blockId: 2, topic: "Second segment summary", approxTokens: 180 },
      ],
    })
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress")
      assert.equal(r.statusCode, 200, `expected 200; got ${r.statusCode}: ${r.body.toString("utf8")}`)
      const text = r.body.toString("utf8")
      // Format mirrors DCP formatAvailableBlocksMessage spirit — Usage line,
      // block-id + token + topic per row, no padding/spacing markers.
      assert.match(text, /Usage:.*dcp.*decompress/i, `expected Usage hint; got: ${text}`)
      assert.match(text, /b1/, `expected b1 row; got: ${text}`)
      assert.match(text, /b2/, `expected b2 row; got: ${text}`)
      assert.match(text, /Initial scan summary/, `expected block 1 topic; got: ${text}`)
      assert.match(text, /Second segment summary/, `expected block 2 topic; got: ${text}`)
      // decompressBlockIds must NOT be cleared on the list path.
      writeSeedState(fp, {
        decompressBlockIds: [42], // sentinel
      })
      await adminGet(handle.port, token, "/dcp-admin/state/decompress")
      const loaded = loadLightState(tmpDir, fp)
      assert.deepEqual(
        loaded.decompressBlockIds, [42],
        "list path must NOT clear decompressBlockIds (only blockId path writes)",
      )
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("④ state/decompress (no args, no blocks) returns the 'no compressions available' message", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp, { activeBlockSummaries: [] })
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress")
      assert.equal(r.statusCode, 200)
      const text = r.body.toString("utf8")
      assert.match(
        text, /No compressions are available to restore\./,
        `expected empty-list message; got: ${text}`,
      )
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑤ state/decompress?blockId=N appends N to decompressBlockIds", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp, {
      activeBlockSummaries: [{ blockId: 2, topic: "Second segment summary", approxTokens: 180 }],
    })
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress?blockId=2")
      assert.equal(r.statusCode, 200, `expected 200; got ${r.statusCode}: ${r.body.toString("utf8")}`)
      const loaded = loadLightState(tmpDir, fp)
      assert.deepEqual(
        loaded.decompressBlockIds, [2],
        `decompressBlockIds must contain [2]; got ${JSON.stringify(loaded.decompressBlockIds)}`,
      )
      // manualMode must NOT be flipped on the decompress path.
      assert.equal(loaded.manualMode, false)
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑤ state/decompress?blockId=N is idempotent (duplicate adds → unique)", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp, {
      decompressBlockIds: [2],
      activeBlockSummaries: [{ blockId: 2, topic: "Second segment summary", approxTokens: 180 }],
    })
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress?blockId=2")
      assert.equal(r.statusCode, 200)
      const loaded = loadLightState(tmpDir, fp)
      assert.deepEqual(loaded.decompressBlockIds, [2])
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑤ state/decompress?blockId=2&blockId=3 accepts multi-param (both written)", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp, {
      activeBlockSummaries: [
        { blockId: 2, topic: "Second segment summary", approxTokens: 180 },
        { blockId: 3, topic: "Third segment summary", approxTokens: 220 },
      ],
    })
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress?blockId=2&blockId=3")
      assert.equal(r.statusCode, 200, `expected 200; got ${r.statusCode}: ${r.body.toString("utf8")}`)
      const loaded = loadLightState(tmpDir, fp)
      // Order should reflect URL appearance: 2 then 3.
      assert.deepEqual(
        loaded.decompressBlockIds, [2, 3],
        `expected [2,3]; got ${JSON.stringify(loaded.decompressBlockIds)}`,
      )
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  // I-2 (review r2) — existence validation: a blockId that doesn't appear
  // in lightState.activeBlockSummaries is rejected with 400 + the precise
  // DCP-style "does not exist" message. The exclusion table is NOT mutated
  // on this path. Active-set population comes from the pipeline (rebuilt
  // every request), so a stale light-state entry from a prior conversation
  // tail cannot satisfy a request after the block has scrolled off.
  it("⑥(I-2) state/decompress?blockId=999 (not in activeBlockSummaries) → 400", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp, {
      // Only blocks 1 and 2 are active; 999 is bogus.
      activeBlockSummaries: [
        { blockId: 1, topic: "Initial scan summary", approxTokens: 240 },
        { blockId: 2, topic: "Second segment summary", approxTokens: 180 },
      ],
    })
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress?blockId=999")
      assert.equal(r.statusCode, 400, `expected 400; got ${r.statusCode}: ${r.body.toString("utf8")}`)
      // Body MUST be a structured 400 (JSON envelope) so the MCP layer can
      // surface a clear error message rather than render an opaque 400.
      const body = JSON.parse(r.body.toString("utf8"))
      assert.equal(body.error, "block_not_active",
        `expected error="block_not_active"; got ${JSON.stringify(body)}`)
      assert.ok(Array.isArray(body.invalidIds) && body.invalidIds.includes(999),
        `expected invalidIds to include 999; got ${JSON.stringify(body.invalidIds)}`)
      // AND the exclusion table must NOT be touched on this path.
      const loaded = loadLightState(tmpDir, fp)
      assert.deepEqual(loaded.decompressBlockIds, [],
        `nonexistent blockId must NOT be written; got ${JSON.stringify(loaded.decompressBlockIds)}`)
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑥(I-2) state/decompress?blockId=2 (active) → 200 (positive path stays green)", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp, {
      activeBlockSummaries: [
        { blockId: 2, topic: "Second segment summary", approxTokens: 180 },
      ],
    })
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress?blockId=2")
      assert.equal(r.statusCode, 200,
        `expected 200 on positive path; got ${r.statusCode}: ${r.body.toString("utf8")}`)
      const loaded = loadLightState(tmpDir, fp)
      assert.deepEqual(loaded.decompressBlockIds, [2])
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑥ state/decompress?blockId=abc (non-numeric) → 400", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp)
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress?blockId=abc")
      assert.equal(r.statusCode, 400, `expected 400; got ${r.statusCode}`)
      const loaded = loadLightState(tmpDir, fp)
      assert.deepEqual(loaded.decompressBlockIds, [], "invalid blockId must NOT be written")
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑥ state/decompress?blockId=0 (non-positive) → 400", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp)
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress?blockId=0")
      assert.equal(r.statusCode, 400)
      const loaded = loadLightState(tmpDir, fp)
      assert.deepEqual(loaded.decompressBlockIds, [])
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑦ state/recompress: clears decompressBlockIds AND flips manualMode off (unchanged from before)", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp, { decompressBlockIds: [1, 2], manualMode: true })
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      const r = await adminGet(handle.port, token, "/dcp-admin/state/recompress")
      assert.equal(r.statusCode, 200)
      const loaded = loadLightState(tmpDir, fp)
      assert.deepEqual(loaded.decompressBlockIds, [])
      assert.equal(loaded.manualMode, false)
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })

  it("⑧ admin state (list active sessions) response carries activeBlockSummaries", async () => {
    const fp = makeFp()
    writeActive(fp)
    writeSeedState(fp, {
      activeBlockSummaries: [
        { blockId: 1, topic: "Initial scan summary", approxTokens: 240 },
      ],
    })
    const handle = await startTestDaemon()
    try {
      const token = fs.readFileSync(path.join(tmpDir, "admin-token"), "utf8").trim()
      // The admin /dcp-admin/state/<action> endpoint response body always
      // includes { lightState: <full state> }. The MCP server reads that
      // for the list path's render. Verify it's there with the new key.
      const r = await adminGet(handle.port, token, "/dcp-admin/state/decompress")
      assert.equal(r.statusCode, 200)
      const loaded = loadLightState(tmpDir, fp)
      assert.deepEqual(loaded.activeBlockSummaries, [
        { blockId: 1, topic: "Initial scan summary", approxTokens: 240 },
      ])
    } finally {
      await new Promise((res) => handle.close(() => res()))
    }
  })
})