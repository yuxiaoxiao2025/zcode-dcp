// SPDX-License-Identifier: AGPL-3.0-or-later
// Part of zcode-dcp (AGPL-3.0-or-later) — stage-2 root-cause tooling (PLAN Task 10)
//
// Tests for scripts/replay-analysis.mjs — fixture-driven replay of transformRequest
// for offline root-cause analysis (SPEC R13, DESIGN D8).

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  loadFixture,
  buildRequest,
  replayFixture,
  replaySweep,
  formatReport,
  formatSweepTable,
  parseSweepArg,
} from "../scripts/replay-analysis.mjs"
import { estimateMessageTokens, estimateTokens } from "../proxy/tokens.mjs"

// ---------- fixtures (mini — covers schema only) ----------

const MAIN_SYSTEM_TEXT = "You are ZCode. Be helpful."

function miniFixture() {
  // 2 requests: one with dedup hits (3 identical Reads), one no-hit control.
  return {
    name: "mini",
    system: MAIN_SYSTEM_TEXT,
    config: {
      compress: { minContextLimit: 50000, maxContextLimit: 100000 },
    },
    requests: [
      {
        name: "with-dedup",
        messages: [
          { role: "user", content: [{ type: "text", text: "Inspect auth module." }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "src/auth.ts" } }],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "c1",
              content: "AUTH_BODY_FIRST" + "X".repeat(800),
            }],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c2", name: "Read", input: { file_path: "src/auth.ts" } }],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "c2",
              content: "AUTH_BODY_SECOND" + "Y".repeat(800),
            }],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c3", name: "Read", input: { file_path: "src/auth.ts" } }],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "c3",
              content: "AUTH_BODY_THIRD" + "Z".repeat(800),
            }],
          },
        ],
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      {
        name: "no-hit",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ],
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ],
  }
}

// ---------- loadFixture ----------

describe("replay-analysis: loadFixture", () => {
  it("parses a minimal in-memory fixture object via direct JS object pass-through path", () => {
    // The CLI loads from disk; in-test we hand the object directly to buildRequest.
    // Assert the contract by validating the schema fields a fixture must carry.
    const fx = miniFixture()
    assert.equal(typeof fx.name, "string")
    assert.ok(Array.isArray(fx.requests) && fx.requests.length >= 1)
    assert.equal(typeof fx.system, "string")
    for (const req of fx.requests) {
      assert.equal(typeof req.name, "string")
      assert.ok(Array.isArray(req.messages))
    }
  })

  it("loadFixture reads a JSON file from disk (the CLI entry point)", async () => {
    const fx = miniFixture()
    const { writeFileSync, mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "replay-fx-"))
    const fp = join(dir, "fx.json")
    writeFileSync(fp, JSON.stringify(fx), "utf8")
    const loaded = loadFixture(fp)
    assert.equal(loaded.name, "mini")
    assert.equal(loaded.requests.length, 2)
    assert.equal(loaded.requests[0].name, "with-dedup")
  })
})

// ---------- buildRequest ----------

describe("replay-analysis: buildRequest", () => {
  it("produces a {body, ctx} pair matching pipeline.transformRequest contract", () => {
    const fx = miniFixture()
    const req = fx.requests[0]
    const { body, ctx } = buildRequest(fx, req)
    // body shape
    assert.ok(body && typeof body === "object")
    assert.equal(body.model, "claude-3-7-sonnet")
    assert.ok(Array.isArray(body.system))
    assert.equal(body.system[0].text, MAIN_SYSTEM_TEXT)
    assert.ok(Array.isArray(body.messages))
    assert.equal(body.messages.length, req.messages.length)
    // ctx shape
    assert.ok(ctx && typeof ctx === "object")
    assert.ok(ctx.config)
    assert.equal(ctx.config.compress.minContextLimit, 50000)
    assert.equal(ctx.config.compress.maxContextLimit, 100000)
    assert.ok(ctx.lightState && Array.isArray(ctx.lightState.anchors.context))
    assert.ok(typeof ctx.usage === "object")
    assert.equal(ctx.usage.inputTokens, 100)
  })

  it("uses default config when fixture omits config override", () => {
    const fx = { name: "x", system: "x", requests: [{ name: "r", messages: [] }] }
    const { ctx } = buildRequest(fx, fx.requests[0])
    // DEFAULT_CONFIG.compress.minContextLimit = 30000
    assert.equal(ctx.config.compress.minContextLimit, 30000)
  })
})

// ---------- replayFixture ----------

describe("replay-analysis: replayFixture", () => {
  it("returns an object with per-request rows + a summary (4 strategy buckets + total)", () => {
    const fx = miniFixture()
    const result = replayFixture(fx)
    assert.ok(result && typeof result === "object")
    assert.equal(result.fixture, "mini")
    assert.ok(Array.isArray(result.requests) && result.requests.length === 2)

    // Per-request row schema
    for (const row of result.requests) {
      assert.equal(typeof row.index, "number")
      assert.equal(typeof row.name, "string")
      assert.equal(typeof row.inputTokens, "number")
      assert.equal(typeof row.sentTokens, "number")
      assert.equal(typeof row.savedTokens, "number")
      assert.ok(row.byStrategy && typeof row.byStrategy === "object")
      assert.equal(typeof row.byStrategy.dedup, "number")
      assert.equal(typeof row.byStrategy.purge, "number")
      assert.equal(typeof row.byStrategy.sweep, "number")
      assert.equal(typeof row.byStrategy.compress, "number")
      assert.ok(row.byStrategyTokens)
      assert.equal(typeof row.byStrategyTokens.dedup, "number")
      assert.equal(typeof row.byStrategyTokens.purge, "number")
      assert.equal(typeof row.byStrategyTokens.sweep, "number")
      assert.equal(typeof row.byStrategyTokens.compress, "number")
      assert.equal(typeof row.injectedNudges, "number")
      assert.equal(typeof row.activeBlocks, "number")
      assert.equal(typeof row.maxRunId, "number")
    }

    // Summary schema
    const s = result.summary
    assert.equal(s.totalRequests, 2)
    assert.equal(typeof s.totalSentTokens, "number")
    assert.equal(typeof s.totalSavedTokens, "number")
    assert.equal(typeof s.savingsRate, "number")
    assert.ok(s.byStrategyHits)
    assert.equal(typeof s.byStrategyHits.dedup, "number")
    assert.equal(typeof s.byStrategyHits.purge, "number")
    assert.equal(typeof s.byStrategyHits.sweep, "number")
    assert.equal(typeof s.byStrategyHits.compress, "number")
    assert.ok(s.byStrategyTokens)
    assert.equal(typeof s.byStrategyTokens.dedup, "number")
    assert.equal(typeof s.byStrategyTokens.purge, "number")
    assert.equal(typeof s.byStrategyTokens.sweep, "number")
    assert.equal(typeof s.byStrategyTokens.compress, "number")
    assert.ok(s.strategyShare)
    assert.equal(typeof s.strategyShare.dedup, "number")
    assert.equal(typeof s.strategyShare.purge, "number")
    assert.equal(typeof s.strategyShare.sweep, "number")
    assert.equal(typeof s.strategyShare.compress, "number")
    assert.ok(s.triggerCountByStrategy)
    assert.equal(typeof s.triggerCountByStrategy.dedup, "number")
    assert.equal(typeof s.triggerCountByStrategy.purge, "number")
    assert.equal(typeof s.triggerCountByStrategy.sweep, "number")
    assert.equal(typeof s.triggerCountByStrategy.compress, "number")
  })

  it("first request (3 identical Reads) reports dedup hits > 0 and savedTokens > 0", () => {
    const fx = miniFixture()
    const result = replayFixture(fx)
    const row0 = result.requests[0]
    assert.ok(row0.byStrategy.dedup >= 2, `expected dedup hits ≥ 2; got ${row0.byStrategy.dedup}`)
    assert.ok(row0.savedTokens > 0, `expected savedTokens > 0; got ${row0.savedTokens}`)
    assert.ok(row0.byStrategyTokens.dedup > 0, `expected byStrategyTokens.dedup > 0; got ${row0.byStrategyTokens.dedup}`)
  })

  it("second request (no-hit control) reports all byStrategy hits = 0 and savedTokens = 0", () => {
    const fx = miniFixture()
    const result = replayFixture(fx)
    const row1 = result.requests[1]
    assert.equal(row1.byStrategy.dedup, 0)
    assert.equal(row1.byStrategy.purge, 0)
    assert.equal(row1.byStrategy.sweep, 0)
    assert.equal(row1.byStrategy.compress, 0)
    assert.equal(row1.savedTokens, 0)
  })

  it("summary savingsRate = totalSaved / (totalSent + totalSaved) when totalSent + totalSaved > 0", () => {
    const fx = miniFixture()
    const result = replayFixture(fx)
    const s = result.summary
    const denom = s.totalSentTokens + s.totalSavedTokens
    if (denom === 0) {
      assert.equal(s.savingsRate, 0)
    } else {
      const expected = s.totalSavedTokens / denom
      assert.ok(
        Math.abs(s.savingsRate - expected) < 1e-9,
        `savingsRate=${s.savingsRate}, expected=${expected}`,
      )
    }
  })

  it("summary strategyShare buckets sum to 1.0 when totalSavedTokens > 0", () => {
    const fx = miniFixture()
    const result = replayFixture(fx)
    const s = result.summary
    if (s.totalSavedTokens > 0) {
      const sum =
        s.strategyShare.dedup +
        s.strategyShare.purge +
        s.strategyShare.sweep +
        s.strategyShare.compress
      assert.ok(
        Math.abs(sum - 1.0) < 1e-9,
        `strategyShare sum should be 1.0 when totalSavedTokens > 0; got ${sum}`,
      )
    }
  })

  it("summary triggerCountByStrategy counts requests with >0 hits per bucket", () => {
    const fx = miniFixture()
    const result = replayFixture(fx)
    const s = result.summary
    // Only the first request has dedup hits → triggerCountByStrategy.dedup=1
    assert.equal(s.triggerCountByStrategy.dedup, 1)
    assert.equal(s.triggerCountByStrategy.purge, 0)
    assert.equal(s.triggerCountByStrategy.sweep, 0)
    assert.equal(s.triggerCountByStrategy.compress, 0)
    // triggeredRequests = 1 (just the dedup one)
    assert.equal(s.triggeredRequests, 1)
  })

  it("respects config override from fixture (e.g. minContextLimit=20000 → nudge injection possible)", () => {
    // Set minContextLimit small + usage over min → context-limit nudge path engages
    const fx = {
      name: "nudge-test",
      system: MAIN_SYSTEM_TEXT,
      config: {
        compress: {
          minContextLimit: 100, // very low
          maxContextLimit: 50000,
          nudgeFrequency: 1,    // every fetch qualifies
          nudgeForce: "soft",
          summaryBuffer: false,
          protectedTools: [],
          protectTags: false,
          protectUserMessages: false,
          mode: "range",
          permission: "allow",
        },
      },
      requests: [
        {
          name: "over-min",
          messages: [
            { role: "user", content: [{ type: "text", text: "g".repeat(4000) }] },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
            { role: "user", content: [{ type: "text", text: "g".repeat(4000) }] },
          ],
          usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      ],
    }
    const result = replayFixture(fx)
    assert.ok(result.summary.triggerCountByStrategy.compress === 0, "no compress in this fixture")
    // Either injectedNudges>0 or skipped signal set; the point is the config took effect.
    const row = result.requests[0]
    assert.ok(row.injectedNudges > 0 || typeof row.skipped === "string", "config override should engage nudge path or skip signal")
  })
})

// ---------- replaySweep ----------

describe("replay-analysis: parseSweepArg", () => {
  it("parses key:from:to:step into {key, values: number[]}", () => {
    const parsed = parseSweepArg("compress.minContextLimit:20000:60000:20000")
    assert.equal(parsed.key, "compress.minContextLimit")
    assert.deepEqual(parsed.values, [20000, 40000, 60000])
  })

  it("single-value from=to step (from==to) returns [from]", () => {
    const parsed = parseSweepArg("compress.maxContextLimit:100000:100000:1")
    assert.deepEqual(parsed.values, [100000])
  })

  it("throws on malformed arg", () => {
    assert.throws(() => parseSweepArg("nope"), /expected key:from:to:step/)
    assert.throws(() => parseSweepArg("a:b:c"), /expected key:from:to:step/)
    assert.throws(() => parseSweepArg("a:1:2:notanumber"), /step must be a positive number/)
    assert.throws(() => parseSweepArg("a:10:1:1"), /from must be <= to/)
  })
})

describe("replay-analysis: replaySweep", () => {
  it("returns an array of {paramValue, summary} rows, one per sweep value", () => {
    const fx = miniFixture()
    const out = replaySweep(fx, "compress.minContextLimit:50000:50000:1")
    assert.ok(Array.isArray(out))
    assert.equal(out.length, 1)
    assert.equal(out[0].paramValue, 50000)
    assert.ok(out[0].summary && typeof out[0].summary.totalRequests === "number")
  })

  it("multi-value sweep yields N rows, each with the same fixture.totalRequests but different paramValue", () => {
    const fx = miniFixture()
    const out = replaySweep(fx, "compress.minContextLimit:100:600:100")
    assert.equal(out.length, 6)
    assert.deepEqual(
      out.map((r) => r.paramValue),
      [100, 200, 300, 400, 500, 600],
    )
    for (const r of out) {
      assert.equal(r.summary.totalRequests, fx.requests.length)
    }
  })
})

// ---------- formatReport + formatSweepTable ----------

describe("replay-analysis: formatReport + formatSweepTable", () => {
  it("formatReport emits a header, per-request rows, and a summary line", () => {
    const fx = miniFixture()
    const result = replayFixture(fx)
    const out = formatReport(result)
    assert.ok(typeof out === "string")
    assert.match(out, /mini/)
    assert.match(out, /with-dedup/)
    assert.match(out, /no-hit/)
    assert.match(out, /Summary|SUMMARY|summary/i)
    assert.match(out, /savings rate|savingsRate|SavingsRate/i)
  })

  it("formatSweepTable emits a comparison table with one row per paramValue", () => {
    const fx = miniFixture()
    const rows = replaySweep(fx, "compress.minContextLimit:20000:60000:20000")
    const out = formatSweepTable({
      fixtureName: fx.name,
      paramKey: "compress.minContextLimit",
      rows,
    })
    assert.ok(typeof out === "string")
    assert.match(out, /compress\.minContextLimit/)
    assert.match(out, /20000/)
    assert.match(out, /60000/)
  })
})

// ---------- estimateBodyTokens (the sentTokens estimator) ----------

describe("replay-analysis: estimateBodyTokens for system+tools+messages ceiling", () => {
  // We expose a tiny helper from the script for testability.
  it("computes tokens for system, tools, messages as separate buckets + total", async () => {
    const { estimateBodyTokens } = await import("../scripts/replay-analysis.mjs")
    const body = {
      system: [{ type: "text", text: "You are ZCode." }],
      tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    }
    const r = estimateBodyTokens(body)
    assert.ok(r && typeof r === "object")
    assert.equal(typeof r.system, "number")
    assert.equal(typeof r.tools, "number")
    assert.equal(typeof r.messages, "number")
    assert.equal(typeof r.total, "number")
    // total === sum
    assert.equal(r.total, r.system + r.tools + r.messages)
    // Sanity: tools tokens >= a non-trivial floor (Read tool def is JSON-serialised)
    assert.ok(r.tools > 0)
    // toolsDef is a meaningful fraction of the total — proves tools overhead is real
    assert.ok(r.tools + r.system >= 5)
  })
})
