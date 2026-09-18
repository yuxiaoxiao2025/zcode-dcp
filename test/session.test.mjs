// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/state/persistence.ts + lib/logger.ts (sanitization spirit)
// Behavior-faithful test suite for zcode-dcp/proxy/session.mjs + zcode-dcp/proxy/stats.mjs.
// Tests are independent of implementation: only consume the public surface defined in PLAN.md Task 9.

import { describe, it, before, after, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import * as session from "../proxy/session.mjs"
import { Stats, createDebugLogger } from "../proxy/stats.mjs"

// ---------- Helpers / fixtures ----------

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function rmTmpDir(p) {
  if (!p) return
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// Anthropic-protocol request body factory.
function body({
  systemText = "You are ZCode. Be helpful.",
  messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ],
} = {}) {
  // Each system entry can be either a string or a {type:"text",text} block.
  const sys = systemText
  return {
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    system: sys,
    messages,
  }
}

function hex16(s) {
  return /^[0-9a-f]{16}$/.test(s)
}

// ============================================================
// sessionFingerprint
// ============================================================

describe("sessionFingerprint", () => {
  it("returns a 16-character lowercase hex string", () => {
    const fp = session.sessionFingerprint(body())
    assert.equal(typeof fp, "string")
    assert.equal(fp.length, 16)
    assert.ok(hex16(fp), `fp=${fp} not 16-hex`)
  })

  it("is stable across two requests of the same conversation (fp-stable)", () => {
    // Both requests share the same first 3 messages; the second appends a tail
    // (so messages.length is 3 + N for some N>=0). PLAN: "messages 尾部增长 fp 不变"
    // means growth past the 3-message window must NOT change the fingerprint.
    const leading = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]
    const fp1 = session.sessionFingerprint(body({ messages: leading }))
    const fp2 = session.sessionFingerprint(
      body({
        messages: [
          ...leading,
          { role: "assistant", content: [{ type: "text", text: "more" }] },
          { role: "user", content: [{ type: "text", text: "tail" }] },
        ],
      })
    )
    assert.equal(fp1, fp2)
  })

  it("does NOT change when messages array grows at the tail (>=3 entries)", () => {
    // Per PLAN: only first 3 messages are digested, so growing tail must be a no-op.
    const fpShort = session.sessionFingerprint(
      body({
        messages: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "assistant", content: [{ type: "text", text: "ack" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
      })
    )
    const fpLong = session.sessionFingerprint(
      body({
        messages: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "assistant", content: [{ type: "text", text: "ack" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
          { role: "assistant", content: [{ type: "text", text: "more" }] },
          { role: "user", content: [{ type: "text", text: "tail" }] },
          { role: "assistant", content: [{ type: "text", text: "tail2" }] },
        ],
      })
    )
    assert.equal(fpShort, fpLong)
  })

  it("distinguishes conversations that differ in their first user message (fp-distinguish)", () => {
    const fpA = session.sessionFingerprint(
      body({
        messages: [
          { role: "user", content: [{ type: "text", text: "alpha" }] },
        ],
      })
    )
    const fpB = session.sessionFingerprint(
      body({
        messages: [
          { role: "user", content: [{ type: "text", text: "omega" }] },
        ],
      })
    )
    assert.notEqual(fpA, fpB)
  })

  it("uses an empty string when system is missing (defensive)", () => {
    const fp1 = session.sessionFingerprint({
      model: "x",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const fp2 = session.sessionFingerprint({
      model: "x",
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    assert.equal(fp1, fp2)
  })

  it("uses an empty string when messages is missing or empty (defensive)", () => {
    const fp1 = session.sessionFingerprint({ model: "x", system: "s" })
    const fp2 = session.sessionFingerprint({
      model: "x",
      system: "s",
      messages: [],
    })
    assert.equal(fp1, fp2)
  })

  it("treats system as array-of-text-blocks form and matches the equivalent string form (I-2)", () => {
    // Anthropic allows `system` as [{type:"text",text:"..."}, ...]; fingerprint
    // must hash the concatenated text the same way as the equivalent string.
    const sysArr = [
      { type: "text", text: "You are ZCode." },
      { type: "text", text: " Be helpful." },
    ]
    const fpArr = session.sessionFingerprint(
      body({ systemText: undefined, messages: undefined }) // override body()
    )
    // Recompute with explicit body override (body() uses systemText; do it raw):
    const fpArrDirect = session.sessionFingerprint({
      model: "claude-3-7-sonnet",
      max_tokens: 1024,
      system: sysArr,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const fpStrDirect = session.sessionFingerprint({
      model: "claude-3-7-sonnet",
      max_tokens: 1024,
      system: "You are ZCode. Be helpful.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    assert.equal(fpArrDirect, fpStrDirect)
    // Avoid unused-var noise from the fpArr stub above.
    assert.ok(typeof fpArr === "string" && fpArr.length === 16)
  })

  it("system-as-array fingerprint is stable across tail growth (I-2)", () => {
    const sysArr = [{ type: "text", text: "You are ZCode." }]
    const leading = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]
    const fp1 = session.sessionFingerprint({
      system: sysArr,
      messages: leading,
    })
    const fp2 = session.sessionFingerprint({
      system: sysArr,
      messages: [
        ...leading,
        { role: "assistant", content: [{ type: "text", text: "more" }] },
        { role: "user", content: [{ type: "text", text: "tail" }] },
      ],
    })
    assert.equal(fp1, fp2)
  })
})

// ============================================================
// loadLightState / saveLightState
// ============================================================

describe("loadLightState / saveLightState", () => {
  let dataDir, fp
  beforeEach(() => {
    dataDir = mkTmpDir("dcp-state-")
    fp = "abcdef0123456789"
  })
  afterEach(() => rmTmpDir(dataDir))

  it("returns the default state shape when file is missing (no crash)", () => {
    const st = session.loadLightState(dataDir, fp)
    assert.deepEqual(st, {
      anchors: { context: [], turn: [], iter: [] },
      fetchCount: 0,
      sweepToolCallIds: [],
      decompressBlockIds: [],
      manualMode: false,
      maxRunIdSeen: null,
      sweepDirective: null,
      sweepLastResult: null,
      activeBlockSummaries: [],
    })
  })

  it("save then load round-trips a state object", () => {
    const st = {
      anchors: { context: ["m0007"], turn: ["m0009"], iter: [] },
      fetchCount: 3,
      sweepToolCallIds: ["toolu_01", "toolu_02"],
      decompressBlockIds: ["b2"],
      manualMode: true,
      maxRunIdSeen: 5,
      sweepDirective: null,
      sweepLastResult: null,
      activeBlockSummaries: [],
    }
    session.saveLightState(dataDir, fp, st)
    const loaded = session.loadLightState(dataDir, fp)
    assert.deepEqual(loaded, st)
  })

  it("atomic write does not leave a .tmp file behind on success", () => {
    session.saveLightState(dataDir, fp, { anchors: { context: [], turn: [], iter: [] }, fetchCount: 1, sweepToolCallIds: [], decompressBlockIds: [], manualMode: false })
    const dirEntries = fs.readdirSync(path.join(dataDir, "light-state"))
    assert.ok(dirEntries.every((n) => !n.endsWith(".tmp")), `unexpected tmp files: ${dirEntries.join(",")}`)
  })

  it("self-heals when the stored JSON is corrupt (returns default)", () => {
    const dir = path.join(dataDir, "light-state")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${fp}.json`), "{not valid json", "utf8")
    const st = session.loadLightState(dataDir, fp)
    assert.deepEqual(st, {
      anchors: { context: [], turn: [], iter: [] },
      fetchCount: 0,
      sweepToolCallIds: [],
      decompressBlockIds: [],
      manualMode: false,
      maxRunIdSeen: null,
      sweepDirective: null,
      sweepLastResult: null,
      activeBlockSummaries: [],
    })
  })

  it("different fingerprints are stored independently", () => {
    const fpA = "aaaa000000000001" // 16 chars
    const fpB = "bbbb000000000002" // 16 chars
    session.saveLightState(dataDir, fpA, {
      anchors: { context: ["m0001"], turn: [], iter: [] },
      fetchCount: 5,
      sweepToolCallIds: [],
      decompressBlockIds: [],
      manualMode: false,
    })
    session.saveLightState(dataDir, fpB, {
      anchors: { context: [], turn: [], iter: ["m0010"] },
      fetchCount: 1,
      sweepToolCallIds: [],
      decompressBlockIds: [],
      manualMode: true,
    })
    const a = session.loadLightState(dataDir, fpA)
    const b = session.loadLightState(dataDir, fpB)
    assert.equal(a.fetchCount, 5)
    assert.equal(b.fetchCount, 1)
    assert.equal(a.manualMode, false)
    assert.equal(b.manualMode, true)
  })

  it("rejects malformed fp values (path-traversal etc.) on load/save (M-6)", () => {
    // fp must match /^[0-9a-f]{16}$/ — anything else returns the default and
    // does not touch disk.
    const dir = path.join(dataDir, "light-state")
    fs.mkdirSync(dir, { recursive: true })

    const malformed = [
      "../../etc/passwd",
      "abc",
      "ZZZZ000000000001",           // uppercase
      "abcdef0123456789/../escape", // slash
      "abcdef0123456789\x00.json",  // NUL byte
      "",
      null,
      undefined,
    ]
    for (const bad of malformed) {
      const out = session.loadLightState(dataDir, bad)
      assert.deepEqual(out, {
        anchors: { context: [], turn: [], iter: [] },
        fetchCount: 0,
        sweepToolCallIds: [],
        decompressBlockIds: [],
        manualMode: false,
        maxRunIdSeen: null,
        sweepDirective: null,
        sweepLastResult: null,
        activeBlockSummaries: [],
      }, `loadLightState should reject fp=${JSON.stringify(bad)}`)
      session.saveLightState(dataDir, bad, {
        anchors: { context: ["m0001"], turn: [], iter: [] },
        fetchCount: 99,
        sweepToolCallIds: [],
        decompressBlockIds: [],
        manualMode: true,
      })
    }
    // Disk must be untouched by all the rejected writes.
    const persisted = fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
    assert.deepEqual(persisted, [], `unexpected persisted files: ${persisted.join(",")}`)
  })
})

describe("loadLightState — corrupt file quarantine cap (M-4)", () => {
  let dataDir
  beforeEach(() => {
    dataDir = mkTmpDir("dcp-corrupt-")
  })
  afterEach(() => rmTmpDir(dataDir))

  it("caps the number of .corrupt-* sidecars at 10 (drops oldest)", () => {
    // Pre-create 12 already-quarantined corrupt files (older than the 10 cap).
    const dir = path.join(dataDir, "light-state")
    fs.mkdirSync(dir, { recursive: true })
    const fp = "1234567890abcdef"
    const base = path.join(dir, `${fp}.json`)
    for (let i = 0; i < 12; i++) {
      // 12 fake quarantined files with monotonically increasing timestamps.
      fs.writeFileSync(`${base}.corrupt-1700000000${String(i).padStart(2, "0")}`, "old")
    }
    // Write corrupt JSON to the live path, then trigger load (which quarantines
    // and caps).
    fs.writeFileSync(base, "{not valid", "utf8")
    session.loadLightState(dataDir, fp)

    const remaining = fs.readdirSync(dir).filter((n) => n.includes(".corrupt-"))
    assert.ok(
      remaining.length <= 10,
      `expected <=10 corrupt files, got ${remaining.length}: ${remaining.join(",")}`
    )
    // The two oldest (170000000000, 170000000001) must have been dropped.
    assert.ok(!remaining.some((n) => n.endsWith("170000000000")))
    assert.ok(!remaining.some((n) => n.endsWith("170000000001")))
  })
})

// ============================================================
// markActive
// ============================================================

describe("markActive", () => {
  let dataDir
  beforeEach(() => {
    dataDir = mkTmpDir("dcp-active-")
  })
  afterEach(() => rmTmpDir(dataDir))

  it("creates active-sessions.json with the given fp and lastSeenTs", () => {
    session.markActive(dataDir, "1111111111111111")
    const file = path.join(dataDir, "active-sessions.json")
    assert.ok(fs.existsSync(file), "active-sessions.json missing")
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.ok(data["1111111111111111"], "fp key missing")
    assert.ok(Number.isFinite(data["1111111111111111"].lastSeenTs))
  })

  it("updates lastSeenTs on repeated calls for the same fp", async () => {
    const fp = "2222222222222222"
    session.markActive(dataDir, fp)
    const first = JSON.parse(
      fs.readFileSync(path.join(dataDir, "active-sessions.json"), "utf8")
    )[fp].lastSeenTs
    await new Promise((r) => setTimeout(r, 5))
    session.markActive(dataDir, fp)
    const second = JSON.parse(
      fs.readFileSync(path.join(dataDir, "active-sessions.json"), "utf8")
    )[fp].lastSeenTs
    assert.ok(second >= first, `expected second ${second} >= first ${first}`)
  })

  it("purges fingerprints older than 30 minutes", () => {
    const now = Date.now()
    const stale = now - 31 * 60 * 1000 // 31 min ago
    const fpStale = "aaaaaaaaaaaaaaaa"
    const fpFresh = "bbbbbbbbbbbbbbbb"
    // Hand-write a stale entry, then call markActive to trigger pruning.
    fs.writeFileSync(
      path.join(dataDir, "active-sessions.json"),
      JSON.stringify({
        [fpStale]: { lastSeenTs: stale },
        [fpFresh]: { lastSeenTs: now },
      }),
      "utf8"
    )
    session.markActive(dataDir, "cccccccccccccccc")
    const data = JSON.parse(
      fs.readFileSync(path.join(dataDir, "active-sessions.json"), "utf8")
    )
    assert.ok(!data[fpStale], "stale entry should be purged")
    assert.ok(data[fpFresh], "fresh entry should be retained")
    assert.ok(data["cccccccccccccccc"], "new entry should be present")
  })

  it("ignores malformed fp values without touching the active-sessions table (M-6)", () => {
    // Pre-seed a legitimate entry.
    const good = "feedfacefeedface" // 16 chars
    fs.writeFileSync(
      path.join(dataDir, "active-sessions.json"),
      JSON.stringify({ [good]: { lastSeenTs: Date.now() } }),
      "utf8"
    )
    const malformed = ["../../../etc/passwd", "ABCDEF", "", null]
    for (const bad of malformed) {
      session.markActive(dataDir, bad)
    }
    const data = JSON.parse(
      fs.readFileSync(path.join(dataDir, "active-sessions.json"), "utf8")
    )
    // Only the legitimate fp remains; no malformed entries were admitted.
    assert.deepEqual(Object.keys(data), ["feedfacefeedface"])
  })
})

// ============================================================
// Stats
// ============================================================

describe("Stats", () => {
  let dataDir, fp
  beforeEach(() => {
    dataDir = mkTmpDir("dcp-stats-")
    fp = "0000111122223333"
  })
  afterEach(() => rmTmpDir(dataDir))

  it("accumulates per-session counters in memory and persists on snapshot()", () => {
    const s = new Stats({ dataDir, fp })
    s.incr("requests", 1)
    s.incr("sentTokens", 100)
    s.incr("savedTokens", 40)
    s.incr("byStrategy.dedup", 20)
    s.incr("byStrategy.purge", 15)
    s.incr("byStrategy.compress", 5)
    s.incr("compressRuns", 1)

    const snap = s.snapshot()
    // Returned snapshot matches the in-memory state.
    assert.equal(snap.requests, 1)
    assert.equal(snap.sentTokens, 100)
    assert.equal(snap.savedTokens, 40)
    assert.equal(snap.byStrategy.dedup, 20)
    assert.equal(snap.byStrategy.purge, 15)
    assert.equal(snap.byStrategy.compress, 5)
    assert.equal(snap.compressRuns, 1)

    // Per-session file persisted.
    const file = path.join(dataDir, "stats", `${fp}.json`)
    assert.ok(fs.existsSync(file), "stats file not written")
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.deepEqual(persisted, snap)
  })

  it("all-time aggregate accumulates across instances and snapshots (dataDir/stats-all.json)", () => {
    const a = new Stats({ dataDir, fp: "fpA" })
    a.incr("requests", 1)
    a.incr("savedTokens", 10)
    a.snapshot()

    const b = new Stats({ dataDir, fp: "fpB" })
    b.incr("requests", 2)
    b.incr("savedTokens", 30)
    const snapB = b.snapshot()

    const allFile = path.join(dataDir, "stats-all.json")
    assert.ok(fs.existsSync(allFile), "stats-all.json missing")
    const all = JSON.parse(fs.readFileSync(allFile, "utf8"))
    assert.equal(all.requests, 3)
    assert.equal(all.savedTokens, 40)
  })
})

// ============================================================
// createDebugLogger — sanitization (PLAN Task 9 "first test case")
// ============================================================

describe("createDebugLogger", () => {
  let dataDir, fp
  before(() => {
    dataDir = mkTmpDir("dcp-debug-")
    fp = "deadbeefcafef00d"
  })
  after(() => rmTmpDir(dataDir))

  it("when disabled, writes nothing to disk", () => {
    const lg = createDebugLogger(dataDir, false)
    lg.log("info", "should be no-op")
    lg.logRequest(fp, { a: 1 }, { b: 2 }, { saved: 5 })
    // No logs/ dir created, no per-fp dir created.
    assert.ok(!fs.existsSync(path.join(dataDir, "logs")))
  })

  it("writes level messages to dataDir/logs/dcp-YYYYMMDD.log", () => {
    const lg = createDebugLogger(dataDir, true)
    lg.log("info", "hello world")
    lg.log("warn", "another")
    const logFile = path.join(dataDir, "logs", `dcp-${ymd()}.log`)
    assert.ok(fs.existsSync(logFile), `log file missing: ${logFile}`)
    const txt = fs.readFileSync(logFile, "utf8")
    assert.ok(txt.includes("hello world"))
    assert.ok(txt.includes("another"))
  })

  it("log() redacts secret headers/fields when given an object msg (I-1)", () => {
    // The level log path must be symmetric with logRequest(): callers commonly
    // pass the config object directly (e.g. `lg.log("debug", config)`), so the
    // object branch must also redact apiKey/authorization before writing.
    const lg = createDebugLogger(dataDir, true)
    const configLike = {
      upstream: {
        baseUrl: "https://api.example.com",
        apiKey: "upstream-key-DO-NOT-LOG-AAAAA",
      },
      headers: {
        authorization: "Bearer sk-ant-DO-NOT-LOG-BBBBB",
        "content-type": "application/json",
      },
    }
    lg.log("debug", configLike)
    const logFile = path.join(dataDir, "logs", `dcp-${ymd()}.log`)
    const txt = fs.readFileSync(logFile, "utf8")
    assert.ok(!txt.includes("upstream-key-DO-NOT-LOG-AAAAA"))
    assert.ok(!txt.includes("sk-ant-DO-NOT-LOG-BBBBB"))
    assert.ok(txt.includes("***"))
    // Non-secret values must survive the redaction.
    assert.ok(txt.includes("https://api.example.com"))
    assert.ok(txt.includes("application/json"))
  })

  it("sanitizes Authorization, x-api-key and api-key headers AND apiKey field values to '***'", () => {
    const lg = createDebugLogger(dataDir, true)
    const original = {
      model: "claude",
      headers: {
        authorization: "Bearer sk-ant-real-key-DO-NOT-LOG-12345",
        "x-api-key": "sk-ant-x-api-key-DO-NOT-LOG-67890",
        "api-key": "another-secret-key-DO-NOT-LOG",
        "content-type": "application/json",
      },
      apiKey: "field-level-secret-DO-NOT-LOG",
      api_key: "snake-case-secret-DO-NOT-LOG",
    }
    const forwarded = {
      headers: {
        authorization: "Bearer sk-ant-real-key-DO-NOT-LOG-12345",
        "x-api-key": "sk-ant-x-api-key-DO-NOT-LOG-67890",
      },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }
    lg.logRequest(fp, original, forwarded, { savedTokensEst: 12 })

    const ctxDir = path.join(dataDir, "logs", "context", fp)
    assert.ok(fs.existsSync(ctxDir), "context dir missing")
    const files = fs.readdirSync(ctxDir)
    assert.equal(files.length, 1)
    const file = path.join(ctxDir, files[0])
    const txt = fs.readFileSync(file, "utf8")

    // None of the real key material may appear in the persisted log.
    assert.ok(!txt.includes("sk-ant-real-key-DO-NOT-LOG-12345"))
    assert.ok(!txt.includes("sk-ant-x-api-key-DO-NOT-LOG-67890"))
    assert.ok(!txt.includes("another-secret-key-DO-NOT-LOG"))
    assert.ok(!txt.includes("field-level-secret-DO-NOT-LOG"))
    assert.ok(!txt.includes("snake-case-secret-DO-NOT-LOG"))
    // The mask must be present.
    assert.ok(txt.includes("***"))
  })

  it("writes per-request file with originalBody/forwardedBody/metrics structure", () => {
    const lg = createDebugLogger(dataDir, true)
    const fp2 = "feedfacefeedface"
    const originalBody = { model: "x", messages: [{ role: "user", content: "a" }] }
    const forwardedBody = { model: "x", messages: [{ role: "user", content: "a" }] }
    lg.logRequest(fp2, originalBody, forwardedBody, { savedTokensEst: 7 })
    const ctxDir = path.join(dataDir, "logs", "context", fp2)
    assert.ok(fs.existsSync(ctxDir))
    const files = fs.readdirSync(ctxDir)
    assert.equal(files.length, 1)
    const txt = fs.readFileSync(path.join(ctxDir, files[0]), "utf8")
    // File name is `{ts}-{seq}.json` (M-3: per-process sequence counter
    // disambiguates same-millisecond snapshots).
    assert.ok(/^\d+-\d+\.json$/.test(files[0]), `unexpected filename: ${files[0]}`)
    const data = JSON.parse(txt)
    assert.ok("originalBody" in data)
    assert.ok("forwardedBody" in data)
    assert.ok("metrics" in data)
    assert.equal(data.metrics.savedTokensEst, 7)
  })

  it("logRequest uses unique filenames even when called twice in the same ms (M-3)", () => {
    const lg = createDebugLogger(dataDir, true)
    const fp2 = "0123456789abcdef"
    const body1 = { model: "x", messages: [] }
    const body2 = { model: "y", messages: [] }
    // Two calls in immediate succession — at least the sequence counter must
    // keep their filenames distinct (Date.now() may collide; pid is constant).
    lg.logRequest(fp2, body1, body1, {})
    lg.logRequest(fp2, body2, body2, {})
    const ctxDir = path.join(dataDir, "logs", "context", fp2)
    const files = fs.readdirSync(ctxDir)
    assert.equal(files.length, 2)
    assert.notEqual(files[0], files[1])
  })
})

function ymd(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}${m}${day}`
}
