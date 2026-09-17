// SPDX-License-Identifier: AGPL-3.0-or-later
// Part of zcode-dcp (AGPL-3.0-or-later) — verification tooling (task-15)
// Behavior-faithful test suite for zcode-dcp/scripts/rollout-stats.mjs
// Tests are independent of implementation: only consume the public surface defined in PLAN.md Task 15.

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SCRIPT = join(__dirname, "..", "scripts", "rollout-stats.mjs")

// ---------- helpers ----------

function writeJsonl(path, lines) {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8")
}

// Build one rollout line with a given (inputTokens, cacheReadTokens) tuple.
// Mirrors ZCode's normalised top-level response.usage shape (task brief).
function rolloutLine(inputTokens, cacheReadTokens, extra = {}) {
  return {
    response: {
      usage: {
        inputTokens,
        outputTokens: 100,
        totalTokens: inputTokens + 100,
        cacheReadTokens,
        cacheWriteTokens: 0,
      },
    },
    ...extra,
  }
}

// Fixture per task brief:
//   A: 3 files [1000, 2000, 3000] input + [500, 500, 500] cache
//      → per-file totals (input+cacheRead) = [1500, 2500, 3500]; median = 2500
//   B: 3 files [800, 1600, 2400] input + [400, 400, 400] cache
//      → per-file totals = [1200, 2000, 2800]; median = 2000
// Reduction = (2500 - 2000) / 2500 = 20.0%
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "rollout-stats-"))
  const aDir = join(root, "A")
  const bDir = join(root, "B")
  mkdirSync(aDir, { recursive: true })
  mkdirSync(bDir, { recursive: true })

  const aInput = [1000, 2000, 3000]
  const aCache = [500, 500, 500]
  for (let i = 0; i < 3; i++) {
    writeJsonl(join(aDir, `run-${i + 1}.jsonl`), [
      rolloutLine(aInput[i], aCache[i], { run: i + 1 }),
      // Also include a malformed line + a non-usage line — must be skipped, totals unchanged.
      { not: "valid json" }, // skipped (bad JSON)
      { response: { no_usage_here: true } }, // skipped (no usage)
      rolloutLine(0, 0, { sentinel: "should not affect total since both are zero" }),
    ])
  }

  const bInput = [800, 1600, 2400]
  const bCache = [400, 400, 400]
  for (let i = 0; i < 3; i++) {
    writeJsonl(join(bDir, `run-${i + 1}.jsonl`), [
      rolloutLine(bInput[i], bCache[i], { run: i + 1 }),
    ])
  }

  return { root, aDir, bDir }
}

// ---------- unit tests against exports ----------

import {
  accumulateFile,
  accumulateDir,
  computeStats,
  formatReport,
  median,
} from "../scripts/rollout-stats.mjs"

describe("rollout-stats: unit exports", () => {
  let tmp
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "rollout-stats-unit-"))
  })
  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it("exports median, accumulateFile, accumulateDir, computeStats, formatReport", () => {
    assert.equal(typeof median, "function")
    assert.equal(typeof accumulateFile, "function")
    assert.equal(typeof accumulateDir, "function")
    assert.equal(typeof computeStats, "function")
    assert.equal(typeof formatReport, "function")
  })

  it("median: odd count picks middle", () => {
    assert.equal(median([1, 2, 3]), 2)
    assert.equal(median([10, 20, 30]), 20)
  })

  it("median: even count averages the two middle values", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5)
  })

  it("median: empty array returns 0 (defensive)", () => {
    assert.equal(median([]), 0)
  })

  it("median: single value returns that value", () => {
    assert.equal(median([42]), 42)
  })

  it("accumulateFile: sums inputTokens+cacheReadTokens across valid lines", () => {
    const p = join(tmp, "acc.jsonl")
    writeJsonl(p, [
      rolloutLine(1000, 500),
      rolloutLine(2000, 1000),
    ])
    // (1000+500) + (2000+1000) = 4500
    assert.equal(accumulateFile(p), 4500)
  })

  it("accumulateFile: skips malformed JSON lines and lines without usage", () => {
    const p = join(tmp, "mixed.jsonl")
    writeFileSync(
      p,
      [
        JSON.stringify(rolloutLine(1000, 500)),
        "{not json",
        JSON.stringify({ response: { no_usage: true } }),
        JSON.stringify(rolloutLine(2000, 1000)),
        "",
      ].join("\n") + "\n",
      "utf8"
    )
    // Only the two valid lines count: (1000+500) + (2000+1000) = 4500
    assert.equal(accumulateFile(p), 4500)
  })

  it("accumulateFile: empty file throws (defensive: empty = no usage)", () => {
    const p = join(tmp, "empty.jsonl")
    writeFileSync(p, "", "utf8")
    assert.throws(() => accumulateFile(p), /no usage lines found/)
  })

  it("accumulateDir: recurses nested *.jsonl and returns per-file totals", () => {
    const dir = join(tmp, "tree")
    mkdirSync(join(dir, "nested"), { recursive: true })
    writeJsonl(join(dir, "run-1.jsonl"), [rolloutLine(1000, 500)])
    writeJsonl(join(dir, "nested", "run-2.jsonl"), [rolloutLine(2000, 1000)])
    const totals = accumulateDir(dir)
    assert.equal(totals.length, 2)
    assert.deepEqual(
      totals.map((t) => t.tokens).sort((a, b) => a - b),
      [1500, 3000]
    )
  })

  it("computeStats: median of per-file totals", () => {
    // Totals [1500, 2500, 3500] → median = 2500
    assert.equal(computeStats([1500, 2500, 3500]), 2500)
    // Totals [1200, 2000, 2800] → median = 2000
    assert.equal(computeStats([1200, 2000, 2800]), 2000)
  })

  it("formatReport: includes both group totals, medians, reduction%, and a details table", () => {
    const out = formatReport({
      aLabel: "A",
      aFiles: [{ tokens: 1500 }, { tokens: 2500 }, { tokens: 3500 }],
      bLabel: "B",
      bFiles: [{ tokens: 1200 }, { tokens: 2000 }, { tokens: 2800 }],
    })
    // Totals
    assert.match(out, /A/)
    assert.match(out, /B/)
    // Median values present
    assert.match(out, /2500/)
    assert.match(out, /2000/)
    // Reduction = 20.0%
    assert.match(out, /20\.0%|20%/)
    // Header
    assert.match(out, /rollout/i)
  })
})

// ---------- CLI integration tests (spawn the actual script) ----------

describe("rollout-stats: CLI integration", () => {
  let fx
  before(() => {
    fx = buildFixture()
  })
  after(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true })
  })

  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 15000,
    })
  }

  it("two directories: produces 20.0% reduction, exits 0", () => {
    const r = run([fx.aDir, fx.bDir])
    assert.equal(r.status, 0, `stderr=${r.stderr}`)
    // Median A = 2500, Median B = 2000, reduction = 20%
    assert.match(r.stdout, /20\.0%|20%/)
    // Sanity: both groups appear in output
    assert.match(r.stdout, /\bA\b/)
    assert.match(r.stdout, /\bB\b/)
  })

  it("two single files: also produces 20.0% reduction, exits 0", () => {
    const aSingle = join(fx.aDir, "run-1.jsonl") // 1000+500 = 1500
    const bSingle = join(fx.bDir, "run-1.jsonl") // 800+400  = 1200
    const r = run([aSingle, bSingle])
    assert.equal(r.status, 0, `stderr=${r.stderr}`)
    // Single-file totals: A=1500, B=1200, reduction = 20%
    assert.match(r.stdout, /20\.0%|20%/)
  })

  it("missing arg: exits non-zero with a clear error (no crash)", () => {
    const r = run([fx.aDir])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr + r.stdout, /usage|missing|argument|require/i)
  })

  it("non-existent path: exits non-zero with a clear error (no crash)", () => {
    const r = run([fx.aDir, join(fx.root, "does-not-exist.jsonl")])
    assert.notEqual(r.status, 0)
    // Should mention the missing path; definitely no crash.
    assert.match(r.stderr + r.stdout, /not found|no such|missing|cannot/i)
  })

  it("empty jsonl file: exits non-zero with clear 'no usage' error (no crash)", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "rollout-stats-empty-"))
    try {
      writeFileSync(join(emptyDir, "empty.jsonl"), "", "utf8")
      const r = run([emptyDir, fx.bDir])
      assert.notEqual(r.status, 0)
      assert.match(r.stderr + r.stdout, /no usage|empty|0 lines|none/i)
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})