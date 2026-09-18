// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Behaviour-faithful test suite for zcode-dcp/proxy/stats.mjs
//
// Covers R8.3 / DESIGN D3 / D3a:
//   * `Stats` exposes a `byStrategyTokens.{dedup,purge,sweep,compress}`
//     counter set, propagated through snapshot()/normalize/mergeAggregate.
//   * `appendRequestLine(rec)` writes a per-request jsonl record to
//     `dataDir/stats/requests.jsonl`, rotates when the live file has
//     reached 100,000 lines, and swallows write failures (no throw).
//
// DESIGN D3a: each record schema is
//   { ts:number, fp:string, sent:number, saved:number, byStrategy:object, byStrategyTokens:object }

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  Stats,
  appendRequestLine,
} from "../proxy/stats.mjs"

// ---------- helpers ----------

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

function makeRec(overrides = {}) {
  return {
    ts: Date.now(),
    fp: "abc123",
    sent: 100,
    saved: 50,
    byStrategy: { dedup: 2, purge: 1, sweep: 0, compress: 1 },
    byStrategyTokens: { dedup: 30, purge: 15, sweep: 0, compress: 5 },
    ...overrides,
  }
}

// =================================================================
// Stats.byStrategyTokens — propagate through all five places
// =================================================================
//
// DESIGN D3: a per-strategy split of savedTokens. The fields must be
// plumbed through:
//   1. freshPerSessionCounters()
//   2. freshAllTimeCounters()
//   3. snapshot() per-session file
//   4. normalizeAggregate() legacy-stats loader
//   5. mergeAggregate() all-time roll-up

describe("Stats: byStrategyTokens propagated everywhere (D3)", () => {
  let tmpDir
  before(() => { tmpDir = mkTmpDir("zcode-dcp-stats-") })
  after(() => { rmTmpDir(tmpDir) })

  it("D3.① Stats instance exposes byStrategyTokens (fresh shape)", () => {
    const stats = new Stats({ dataDir: tmpDir, fp: "fp1" })
    assert.ok(stats.counters.byStrategyTokens, "counters.byStrategyTokens must exist")
    assert.equal(stats.counters.byStrategyTokens.dedup, 0)
    assert.equal(stats.counters.byStrategyTokens.purge, 0)
    assert.equal(stats.counters.byStrategyTokens.sweep, 0)
    assert.equal(stats.counters.byStrategyTokens.compress, 0)
  })

  it("D3.② incr('byStrategyTokens.dedup', N) accumulates correctly", () => {
    const stats = new Stats({ dataDir: tmpDir, fp: "fp1b" })
    stats.incr("byStrategyTokens.dedup", 17)
    stats.incr("byStrategyTokens.purge", 5)
    stats.incr("byStrategyTokens.sweep", 3)
    stats.incr("byStrategyTokens.compress", 9)
    assert.equal(stats.counters.byStrategyTokens.dedup, 17)
    assert.equal(stats.counters.byStrategyTokens.purge, 5)
    assert.equal(stats.counters.byStrategyTokens.sweep, 3)
    assert.equal(stats.counters.byStrategyTokens.compress, 9)
  })

  it("D3.③ incr with unknown sub-field is silently ignored", () => {
    const stats = new Stats({ dataDir: tmpDir, fp: "fp1c" })
    // No throw on unknown sub-field (defensive — never crash on typo).
    stats.incr("byStrategyTokens.unknownField", 999)
    assert.equal(stats.counters.byStrategyTokens.unknownField, undefined)
  })

  it("D3.④ snapshot() per-session file carries byStrategyTokens", () => {
    const fp = "fp_snap"
    const stats = new Stats({ dataDir: tmpDir, fp })
    stats.incr("byStrategyTokens.dedup", 12)
    stats.incr("byStrategyTokens.purge", 4)
    stats.incr("byStrategyTokens.sweep", 2)
    stats.incr("byStrategyTokens.compress", 7)
    stats.incr("requests", 1)

    const snap = stats.snapshot()
    assert.ok(snap.byStrategyTokens, "snap must include byStrategyTokens")
    assert.equal(snap.byStrategyTokens.dedup, 12)
    assert.equal(snap.byStrategyTokens.purge, 4)
    assert.equal(snap.byStrategyTokens.sweep, 2)
    assert.equal(snap.byStrategyTokens.compress, 7)

    // Per-session file on disk
    const file = path.join(tmpDir, "stats", `${fp}.json`)
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.ok(onDisk.byStrategyTokens, "on-disk per-session file must carry byStrategyTokens")
    assert.equal(onDisk.byStrategyTokens.dedup, 12)
    assert.equal(onDisk.byStrategyTokens.purge, 4)
    assert.equal(onDisk.byStrategyTokens.sweep, 2)
    assert.equal(onDisk.byStrategyTokens.compress, 7)
  })

  it("D3.⑤ snapshot() also includes byStrategy.sweep (R3 review pre-existing bug fix)", () => {
    // Pre-existing bug: daemon.mjs:418 calls incr('byStrategy.sweep', N)
    // but snapshot() (stats.mjs:139-149) does not include sweep in its snap
    // object, so the increment was lost on disk. This test pins the fix.
    const fp = "fp_sweep"
    const stats = new Stats({ dataDir: tmpDir, fp })
    stats.incr("byStrategy.sweep", 6)
    const snap = stats.snapshot()
    assert.ok(
      Object.prototype.hasOwnProperty.call(snap.byStrategy, "sweep"),
      "snap.byStrategy must include the sweep key",
    )
    assert.equal(snap.byStrategy.sweep, 6)
  })

  it("D3.⑥ all-time aggregate (stats-all.json) rolls up byStrategyTokens across two snapshots", () => {
    // Use an isolated tmpDir so the aggregate starts at zero — the shared
    // describe-level tmpDir accumulates across earlier tests in the suite.
    const isolated = mkTmpDir("zcode-dcp-stats-agg-")
    try {
      // Two requests → two Stats instances → two snapshots → all-time roll-up
      // must equal the sum of the two contributions per bucket.
      const fp = "fp_aggregate"
      // First request
      const s1 = new Stats({ dataDir: isolated, fp })
      s1.incr("byStrategyTokens.dedup", 10)
      s1.incr("byStrategyTokens.purge", 20)
      s1.incr("byStrategyTokens.sweep", 30)
      s1.incr("byStrategyTokens.compress", 40)
      s1.incr("requests", 1)
      s1.snapshot()

      // Second request
      const s2 = new Stats({ dataDir: isolated, fp })
      s2.incr("byStrategyTokens.dedup", 1)
      s2.incr("byStrategyTokens.purge", 2)
      s2.incr("byStrategyTokens.sweep", 3)
      s2.incr("byStrategyTokens.compress", 4)
      s2.incr("requests", 1)
      s2.snapshot()

      const allTime = JSON.parse(
        fs.readFileSync(path.join(isolated, "stats-all.json"), "utf8"),
      )
      assert.ok(allTime.byStrategyTokens, "all-time must include byStrategyTokens")
      assert.equal(allTime.byStrategyTokens.dedup, 11, "dedup sum")
      assert.equal(allTime.byStrategyTokens.purge, 22, "purge sum")
      assert.equal(allTime.byStrategyTokens.sweep, 33, "sweep sum")
      assert.equal(allTime.byStrategyTokens.compress, 44, "compress sum")
      assert.equal(allTime.requests, 2, "requests sum")
    } finally {
      rmTmpDir(isolated)
    }
  })

  it("D3.⑦ normalizeAggregate() reads a legacy stats file without byStrategyTokens → default 0s", () => {
    // Isolated tmpDir — the legacy aggregate gets normalised from a known
    // starting state (the hand-crafted stats file below).
    const isolated = mkTmpDir("zcode-dcp-stats-legacy-")
    try {
      // Write a hand-crafted legacy stats file (no byStrategyTokens field).
      const fp = "fp_legacy"
      const legacy = {
        sentTokens: 1000,
        savedTokens: 200,
        byStrategy: { dedup: 5, purge: 2, sweep: 1, compress: 3 },
        compressRuns: 1,
        requests: 7,
      }
      fs.mkdirSync(path.join(isolated, "stats"), { recursive: true })
      fs.writeFileSync(
        path.join(isolated, "stats", `${fp}.json`),
        JSON.stringify(legacy),
        "utf8",
      )
      // Snapshot against this legacy file — the mergeAggregate step must NOT
      // crash on missing byStrategyTokens; it must default to 0 across buckets.
      const stats = new Stats({ dataDir: isolated, fp })
      stats.incr("byStrategyTokens.dedup", 50)
      stats.incr("requests", 1)
      stats.snapshot()

      const allTime = JSON.parse(
        fs.readFileSync(path.join(isolated, "stats-all.json"), "utf8"),
      )
      assert.ok(allTime.byStrategyTokens)
      assert.equal(allTime.byStrategyTokens.dedup, 50, "this-request dedup")
      assert.equal(allTime.byStrategyTokens.purge, 0, "missing field defaults to 0")
      assert.equal(allTime.byStrategyTokens.sweep, 0)
      assert.equal(allTime.byStrategyTokens.compress, 0)
    } finally {
      rmTmpDir(isolated)
    }
  })

  it("D3.⑧ per-session file also includes byStrategy.sweep (regression for prior bug)", () => {
    // Confirms the sweep key reaches the per-session file on disk.
    const fp = "fp_sweep_disk"
    const stats = new Stats({ dataDir: tmpDir, fp })
    stats.incr("byStrategy.sweep", 11)
    stats.snapshot()
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "stats", `${fp}.json`), "utf8"),
    )
    assert.equal(onDisk.byStrategy.sweep, 11)
  })
})

// =================================================================
// appendRequestLine — D3a per-request jsonl record
// =================================================================
//
// DESIGN D3a: each transformed request is appended as a single JSON line
// to `dataDir/stats/requests.jsonl`. The schema is
//   { ts:number, fp:string, sent:number, saved:number,
//     byStrategy:object, byStrategyTokens:object }
// Rotation: when the live file's line count is already at/over the
// rotation threshold (100,000 lines per PLAN Task 4 — implementation
// constant), the live file is moved aside to `requests.jsonl.1` (single
// generation, overwrite on next rotation) and a fresh live file starts.
// Write failures must NOT throw — they are warnings (so the request
// forward path is never blocked by a stats error).

describe("appendRequestLine — per-request jsonl record (D3a)", () => {
  let tmpDir
  before(() => { tmpDir = mkTmpDir("zcode-dcp-requests-") })
  after(() => { rmTmpDir(tmpDir) })

  it("D3a.① writes a single valid JSON line to dataDir/stats/requests.jsonl", async () => {
    const isolated = mkTmpDir("zcode-dcp-requests-single-")
    try {
      const fp = "fpA"
      const rec = makeRec({ fp, sent: 200, saved: 80 })
      await appendRequestLine(isolated, rec)

      const file = path.join(isolated, "stats", "requests.jsonl")
      assert.ok(fs.existsSync(file), "requests.jsonl must be created")
      const text = fs.readFileSync(file, "utf8")
      const lines = text.split("\n").filter((l) => l.length > 0)
      assert.equal(lines.length, 1, "exactly one line after one append")
      const parsed = JSON.parse(lines[0])
      assert.equal(parsed.fp, fp)
      assert.equal(parsed.sent, 200)
      assert.equal(parsed.saved, 80)
      assert.equal(typeof parsed.ts, "number")
      assert.ok(parsed.byStrategy)
      assert.ok(parsed.byStrategyTokens)
      assert.equal(parsed.byStrategy.dedup, 2)
      assert.equal(parsed.byStrategyTokens.dedup, 30)
    } finally {
      rmTmpDir(isolated)
    }
  })

  it("D3a.② appends sequentially (each request = one new line)", async () => {
    const isolated = mkTmpDir("zcode-dcp-requests-seq-")
    try {
      const fp = "fpB"
      await appendRequestLine(isolated, makeRec({ fp, sent: 100 }))
      await appendRequestLine(isolated, makeRec({ fp, sent: 200 }))
      await appendRequestLine(isolated, makeRec({ fp, sent: 300 }))
      const file = path.join(isolated, "stats", "requests.jsonl")
      const text = fs.readFileSync(file, "utf8")
      const lines = text.split("\n").filter((l) => l.length > 0)
      assert.equal(lines.length, 3)
      const sentSeq = lines.map((l) => JSON.parse(l).sent)
      assert.deepEqual(sentSeq, [100, 200, 300])
    } finally {
      rmTmpDir(isolated)
    }
  })

  it("D3a.③ rotates to requests.jsonl.1 when live file has ≥100,000 lines", async () => {
    // Construct a live file with exactly the rotation threshold so the
    // NEXT append triggers rotation. (Faster than writing 100k lines.)
    const isolated = mkTmpDir("zcode-dcp-requests-rot-")
    try {
      const file = path.join(isolated, "stats", "requests.jsonl")
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const stream = fs.createWriteStream(file, "utf8")
      const lineCount = 100000
      // Write a minimal placeholder line shape that matches the schema
      // (the rotation only counts lines, not the contents).
      const placeholder = JSON.stringify({
        ts: 0, fp: "x", sent: 0, saved: 0,
        byStrategy: {}, byStrategyTokens: {},
      })
      for (let i = 0; i < lineCount; i++) {
        stream.write(placeholder + "\n")
      }
      await new Promise((resolve) => stream.end(resolve))

      // Now append — should rotate: live file goes to .1, fresh live file
      // is created with just the new record.
      await appendRequestLine(isolated, makeRec({ fp: "rotator", sent: 999 }))

      const rotatedFile = path.join(isolated, "stats", "requests.jsonl.1")
      assert.ok(fs.existsSync(rotatedFile), "requests.jsonl.1 must exist after rotation")
      // Live file now has only the post-rotation record (1 line).
      const liveText = fs.readFileSync(file, "utf8")
      const liveLines = liveText.split("\n").filter((l) => l.length > 0)
      assert.equal(liveLines.length, 1, "live file must contain exactly the post-rotation record")
      const parsed = JSON.parse(liveLines[0])
      assert.equal(parsed.fp, "rotator")
      assert.equal(parsed.sent, 999)
    } finally {
      rmTmpDir(isolated)
    }
  })

  it("D3a.④ single-generation rotation: rotating twice overwrites .1 (no chain)", async () => {
    // After D3a.③ the file is in its post-rotation state (1 line live).
    // Force another rotation by stuffing 100k lines into the live file,
    // then appending. The new .1 must OVERWRITE the previous one
    // (single-generation chain per PLAN Task 4 requirement).
    const isolated = mkTmpDir("zcode-dcp-requests-rot2-")
    try {
      const file = path.join(isolated, "stats", "requests.jsonl")
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const stream = fs.createWriteStream(file, "utf8")
      const placeholder = JSON.stringify({
        ts: 0, fp: "y", sent: 0, saved: 0,
        byStrategy: {}, byStrategyTokens: {},
      })
      for (let i = 0; i < 100000; i++) {
        stream.write(placeholder + "\n")
      }
      await new Promise((resolve) => stream.end(resolve))

      await appendRequestLine(isolated, makeRec({ fp: "rotator2", sent: 1 }))

      // Only requests.jsonl (live) and requests.jsonl.1 (rotated) must exist —
      // no .2 / .3 chain.
      const statsDir = path.join(isolated, "stats")
      const entries = fs.readdirSync(statsDir)
      const jsonls = entries.filter((e) => e.startsWith("requests.jsonl")).sort()
      assert.deepEqual(jsonls, ["requests.jsonl", "requests.jsonl.1"])
    } finally {
      rmTmpDir(isolated)
    }
  })

  it("D3a.⑤ write failure does NOT throw (swallowed as warning)", async () => {
    // Point at a path whose parent directory cannot be created (e.g.
    // treating a file as a directory). The function must not throw.
    const isolated = mkTmpDir("zcode-dcp-requests-fail-")
    try {
      const badDir = path.join(isolated, "this-is-a-file-not-a-dir")
      fs.writeFileSync(badDir, "not a directory", "utf8")
      const rec = makeRec({ fp: "fpFail" })
      // Must resolve, not reject. Capture any unexpected rejection.
      let rejected = null
      try {
        await appendRequestLine(badDir, rec)
      } catch (err) {
        rejected = err
      }
      assert.equal(rejected, null, "appendRequestLine must swallow write failures")
    } finally {
      rmTmpDir(isolated)
    }
  })
})

// =================================================================
// Gate 1.5 C1 — in-memory line counter for requests.jsonl
// =================================================================
//
// Pre-fix: appendRequestLine called countLines (full-file newline scan)
// on EVERY append. With a 100k-line file (~30-60MB), each request paid
// a 5-order-of-magnitude IO cost. Post-fix: a module-level counter
// keyed by the liveFile path is incremented on every append; the
// initial count is taken once on first observation, and the counter is
// reset to 1 (or re-counted) on rotation.
//
// The counter is an implementation detail, but the EXTERNAL invariants
// are:
//
//   * After rotation, the counter equals the post-rotation file's
//     actual line count (1, since the new record is the only line in
//     the fresh live file).
//   * Subsequent appends keep the counter in sync (no off-by-one, no
//     double rotation).
//   * Stuffing the live file past the threshold between appends is
//     detected on the next append (counter re-syncs when needed).
//
// Behaviour-equivalence (per spec): the public shape and side effects
// are unchanged; only the IO cost drops. These tests pin the
// behaviour and protect against regression in the rotation/append
// boundary logic.

describe("appendRequestLine — in-memory line counter (Gate 1.5 C1)", () => {
  it("C1.① rotation: in-memory counter matches actual file line count after the rotation", async () => {
    // Stuff the live file with exactly the rotation threshold (100k lines).
    // The next append triggers rotation. Post-rotation, the live file has
    // exactly ONE line (the freshly-appended record); the counter must
    // reflect that, NOT the pre-rotation count of 100000 (otherwise the
    // very next append would immediately re-rotate, churning the disk).
    const isolated = mkTmpDir("zcode-dcp-c1-rot-")
    try {
      const file = path.join(isolated, "stats", "requests.jsonl")
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const stream = fs.createWriteStream(file, "utf8")
      const placeholder = JSON.stringify({
        ts: 0, fp: "x", sent: 0, saved: 0,
        byStrategy: {}, byStrategyTokens: {},
      })
      for (let i = 0; i < 100000; i++) {
        stream.write(placeholder + "\n")
      }
      await new Promise((r) => stream.end(r))

      // The trigger append — rotates live → .1, writes the new record.
      await appendRequestLine(isolated, makeRec({ fp: "rotator", sent: 999 }))

      // Live file: exactly 1 line (the post-rotation record).
      const liveText = fs.readFileSync(file, "utf8")
      const liveLines = liveText.split("\n").filter((l) => l.length > 0)
      assert.equal(liveLines.length, 1, "live file has exactly the post-rotation record")
      const parsed = JSON.parse(liveLines[0])
      assert.equal(parsed.fp, "rotator")
      assert.equal(parsed.sent, 999)

      // 50 subsequent appends → counter must stay in sync with file,
      // and rotation must NOT fire again (the file grows from 1→51 lines,
      // never near the 100k threshold).
      for (let i = 0; i < 50; i++) {
        await appendRequestLine(isolated, makeRec({ fp: "seq", sent: i }))
      }
      const finalText = fs.readFileSync(file, "utf8")
      const finalLines = finalText.split("\n").filter((l) => l.length > 0)
      assert.equal(
        finalLines.length, 51,
        `live file must have 51 lines (1 post-rotation + 50 subsequent); got ${finalLines.length}`,
      )

      // The .1 file must be untouched after the post-rotation appends
      // (no double-rotation). Verify its size matches the pre-rotation
      // content (100k placeholder lines).
      const rotatedFile = path.join(isolated, "stats", "requests.jsonl.1")
      const rotatedText = fs.readFileSync(rotatedFile, "utf8")
      const rotatedLines = rotatedText.split("\n").filter((l) => l.length > 0)
      assert.equal(
        rotatedLines.length, 100000,
        `rotated .1 file must still hold the original 100k lines (no double rotation); got ${rotatedLines.length}`,
      )
    } finally {
      rmTmpDir(isolated)
    }
  })

  it("C1.② just-under-threshold: append at 99999 lines does NOT rotate", async () => {
    // Boundary case: 99999 lines (one short of threshold) → append once →
    // file has 100000 lines, NO rotation (the check is `>= threshold` so
    // exactly 100000 still does not rotate; we need one MORE append to
    // cross the boundary). This pins that the counter doesn't get an
    // off-by-one.
    const isolated = mkTmpDir("zcode-dcp-c1-under-")
    try {
      const file = path.join(isolated, "stats", "requests.jsonl")
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const stream = fs.createWriteStream(file, "utf8")
      const placeholder = JSON.stringify({
        ts: 0, fp: "x", sent: 0, saved: 0,
        byStrategy: {}, byStrategyTokens: {},
      })
      for (let i = 0; i < 99999; i++) {
        stream.write(placeholder + "\n")
      }
      await new Promise((r) => stream.end(r))

      await appendRequestLine(isolated, makeRec({ fp: "u", sent: 1 }))

      const liveText = fs.readFileSync(file, "utf8")
      const liveLines = liveText.split("\n").filter((l) => l.length > 0)
      assert.equal(liveLines.length, 100000, "99999 + 1 = 100000, no rotation yet")

      // Now append once more → counter sees 100000 >= threshold → rotate.
      await appendRequestLine(isolated, makeRec({ fp: "u", sent: 2 }))
      const liveText2 = fs.readFileSync(file, "utf8")
      const liveLines2 = liveText2.split("\n").filter((l) => l.length > 0)
      assert.equal(liveLines2.length, 1, "100000 + 1 triggers rotation; live file has just the post-rotation record")
    } finally {
      rmTmpDir(isolated)
    }
  })

  it("C1.③ many appends to a fresh file: file line count grows by 1 per call", async () => {
    // Sanity / regression pin: appending N times to a fresh file produces
    // exactly N lines (no skips, no double-writes). This is the
    // "behaviour-equivalence" guardrail for the counter — if the in-memory
    // state ever desyncs from the file, this test catches it.
    const isolated = mkTmpDir("zcode-dcp-c1-fresh-")
    try {
      for (let i = 0; i < 100; i++) {
        await appendRequestLine(isolated, makeRec({ fp: "f", sent: i }))
      }
      const file = path.join(isolated, "stats", "requests.jsonl")
      const text = fs.readFileSync(file, "utf8")
      const lines = text.split("\n").filter((l) => l.length > 0)
      assert.equal(lines.length, 100, `100 appends → 100 lines; got ${lines.length}`)
    } finally {
      rmTmpDir(isolated)
    }
  })
})
