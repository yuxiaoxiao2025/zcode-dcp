// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the daemon-side `estimateBodyTokens` (the sentTokens
// estimator used for stats.sentTokens AND per-request jsonl `sent` field).
//
// This file is DELIBERATELY separate from replay-analysis.test.mjs:
//   * scripts/replay-analysis.mjs exports its own `estimateBodyTokens`
//     with a 4-bucket return shape {system, tools, messages, total} —
//     used for offline root-cause analysis only.
//   * proxy/daemon.mjs has its own `estimateBodyTokens` that takes a
//     raw Buffer (the wire-format forwarded body) and returns a single
//     scalar — used on the hot request path.
// The two functions are intentionally independent (different callers,
// different return shapes). This file tests the daemon's. Do NOT mix
// their assertion signatures.

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { __test_internals } from "../proxy/daemon.mjs"

const { estimateBodyTokens } = __test_internals

// =================================================================
// Gate 1.5 A2 — sentTokens full-denominator (now includes tools)
// =================================================================
//
// SPEC H2 / 08 问③: the daemon's sentTokens counter is the
// post-prune billable amount the proxy will actually forward. Pre-fix
// it counted messages + system but NOT the tools array, so the
// displayed "sent" missed the tool-definition bytes that DO count
// toward the upstream-billed token count (28.8% of typical sessions
// per the root-cause replay). The fix: sum estimateTokens over
// JSON.stringify(tool) for every tool in body.tools, in the same way
// tokens.mjs's `tool_use` estimator does for tool calls (whole block
// serialized — matches the convention this module already uses for
// message content).
//
// The fix is symmetric: estimateBodyTokens feeds BOTH the per-request
// jsonl `sent` field AND stats.incr("sentTokens"), so a single change
// in this function keeps the two surfaces in lock-step (the "jsonl
// sent ↔ stats-all sentTokens 同源一致" property is preserved by
// construction — no extra wiring needed).

function makeBodyWithTools(tools, opts = {}) {
  const body = {
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    messages: opts.messages || [{ role: "user", content: "hello" }],
  }
  if (opts.system !== undefined) body.system = opts.system
  if (tools !== undefined) body.tools = tools
  return Buffer.from(JSON.stringify(body), "utf8")
}

describe("daemon.estimateBodyTokens — sentTokens full-denominator (Gate 1.5 A2)", () => {
  it("A2.① body with non-trivial tools array → estimateBodyTokens includes a tools component (RED pre-fix)", () => {
    // A Read tool definition with a JSON schema ~250 chars → ~60 tokens.
    // The current estimator returns the messages+system total ONLY, so
    // adding tools does not change the result. Post-fix it must.
    const readTool = {
      name: "Read",
      description: "Reads a file from the local filesystem. Returns the file contents and metadata.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          start_line: { type: "number", description: "Optional start line (0-indexed)" },
          end_line: { type: "number", description: "Optional end line (inclusive)" },
        },
        required: ["file_path"],
      },
    }
    const editTool = {
      name: "Edit",
      description: "Performs an exact string replace in a file.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["file_path", "old_text", "new_text"],
      },
    }

    const withoutTools = makeBodyWithTools(undefined)
    const withTools = makeBodyWithTools([readTool, editTool])

    const t0 = estimateBodyTokens(withoutTools)
    const t1 = estimateBodyTokens(withTools)

    assert.ok(
      t1 > t0,
      `estimateBodyTokens must count tool definitions; got withTools=${t1}, withoutTools=${t0}`,
    )
    // Sanity: 2 tool defs ≈ 250+200 chars ≈ 110 tokens of overhead.
    // Assert at least 50 tokens of tools-component contribution (the
    // pre-fix estimator returns the EXACT same value with and without
    // tools, so any positive delta proves the fix).
    const delta = t1 - t0
    assert.ok(
      delta >= 50,
      `tools component must add ≥ 50 tokens for 2 non-trivial tool defs; got delta=${delta}`,
    )
  })

  it("A2.② empty tools array → estimateBodyTokens unchanged from no-tools (no regression)", () => {
    // Boundary case: tools:[] must NOT contribute tokens (zero elements).
    // This pins the invariant that the tools loop is element-count-driven,
    // not array-presence-driven.
    const withoutTools = makeBodyWithTools(undefined)
    const withEmptyTools = makeBodyWithTools([])
    const t0 = estimateBodyTokens(withoutTools)
    const t1 = estimateBodyTokens(withEmptyTools)
    assert.equal(t1, t0, `empty tools array must contribute 0 tokens; got ${t1} vs ${t0}`)
  })

  it("A2.③ tools component uses the same estimator as the tool_use block estimator (estimateTokens over JSON.stringify)", () => {
    // The doc-comment promise: "matches tokens.mjs's tool_use estimator
    // behaviour (whole block serialized)". Pin it explicitly so a future
    // refactor cannot quietly switch to a per-field estimator without
    // updating the docs.
    const t = {
      name: "Foo",
      description: "x".repeat(100),
      input_schema: { type: "object", properties: { a: { type: "string" } } },
    }
    const body = makeBodyWithTools([t])
    const total = estimateBodyTokens(body)
    const baseBody = makeBodyWithTools(undefined)
    const base = estimateBodyTokens(baseBody)
    // Re-derive what estimateTokens(JSON.stringify(t)) should give:
    const expectedToolTokens = Math.round(JSON.stringify(t).length / 4)
    const delta = total - base
    assert.ok(
      Math.abs(delta - expectedToolTokens) <= 2,
      `tools component must equal estimateTokens(JSON.stringify(t)) within 2 tokens; got ${delta}, expected ~${expectedToolTokens}`,
    )
  })

  it("A2.④ system string body still works (regression — pre-fix covered this)", () => {
    // Sanity: the pre-fix system branch must still work post-fix.
    const body = Buffer.from(JSON.stringify({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      system: "You are ZCode. Be helpful.",
    }), "utf8")
    const total = estimateBodyTokens(body)
    assert.ok(total > 0, "system string must contribute to estimateBodyTokens")
  })

  it("A2.⑤ system array body still works (regression — pre-fix covered this)", () => {
    const body = Buffer.from(JSON.stringify({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      system: [{ type: "text", text: "You are ZCode." }, { type: "text", text: "Be helpful." }],
    }), "utf8")
    const total = estimateBodyTokens(body)
    assert.ok(total > 0, "system array must contribute to estimateBodyTokens")
  })
})
