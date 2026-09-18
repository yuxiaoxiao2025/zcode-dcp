// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/strategies/deduplication.ts +
//                                                     lib/strategies/purge-errors.ts +
//                                                     lib/messages/prune.ts
//
// Behavior-faithful test suite for zcode-dcp/proxy/prune.mjs
// Tests are independent of implementation: only consume the public surface defined in
// PLAN.md Task 6 (toolSignature / planPrune / applyPrune) plus the three placeholder
// constants (PRUNED_TOOL_OUTPUT / PRUNED_TOOL_ERROR_INPUT / PRUNED_QUESTION_INPUT).

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  toolSignature,
  planPrune,
  applyPrune,
  PRUNED_TOOL_OUTPUT,
  PRUNED_TOOL_ERROR_INPUT,
  PRUNED_QUESTION_INPUT,
  SKIP_TOOLS,
} from "../proxy/prune.mjs"

// ---------- Anthropic-protocol message fixtures ----------
//
// Helper shapes mirror the real Anthropic /v1/messages request form:
//   - user messages carry tool_result blocks referencing an assistant tool_use
//     via tool_use_id; is_error:true marks a failed execution (SPEC-P6 / purge-errors)
//   - assistant messages carry tool_use blocks with a stable id used as the
//     "tool call id" throughout the prune pipeline (this id joins the user
//     tool_result via tool_use_id).
//
// Real traffic from test-lab/echo-capture.jsonl never sets message.id (SPEC
// decision 2026-09-11 22:50); here we pass the index in directly so
// assertions stay human-readable.

function assistantToolUse(idx, id, name, input) {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  }
}

function userToolResult(idx, toolUseId, content, isError = false) {
  const block = { type: "tool_result", tool_use_id: toolUseId, content }
  if (isError) block.is_error = true
  return { role: "user", content: [block] }
}

function userText(idx, text) {
  return { role: "user", content: [{ type: "text", text }] }
}

function assistantText(idx, text) {
  return { role: "assistant", content: [{ type: "text", text }] }
}

// A deterministic config that aligns with DEFAULT_CONFIG for the strategy
// knobs prune.mjs reads. Merged in here so each test can override only the
// bits it cares about (e.g. protectedTools, turnProtection, turns).
function makeConfig(overrides = {}) {
  const config = {
    strategies: {
      deduplication: {
        enabled: true,
        protectedTools: [],
      },
      purgeErrors: {
        enabled: true,
        turns: 4,
        protectedTools: [],
      },
    },
    turnProtection: {
      enabled: false,
      turns: 4,
    },
    protectedFilePatterns: [],
  }
  return mergeDeep(config, overrides)
}

function mergeDeep(base, override) {
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override
  }
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(override)) {
    out[k] = v === undefined ? base?.[k] : mergeDeep(base?.[k], v)
  }
  return out
}

// =================================================================
// Placeholder constants — verbatim from DCP lib/messages/prune.ts:9-11
// =================================================================

describe("prune placeholders (verbatim from DCP prune.ts:9-11)", () => {
  it("PRUNED_TOOL_OUTPUT matches the upstream string byte-for-byte", () => {
    assert.equal(
      PRUNED_TOOL_OUTPUT,
      "[Output removed to save context - information superseded or no longer needed]",
    )
  })

  it("PRUNED_TOOL_ERROR_INPUT matches the upstream string byte-for-byte", () => {
    assert.equal(
      PRUNED_TOOL_ERROR_INPUT,
      "[input removed due to failed tool call]",
    )
  })

  it("PRUNED_QUESTION_INPUT matches the upstream string byte-for-byte", () => {
    assert.equal(
      PRUNED_QUESTION_INPUT,
      "[questions removed - see output for user's answers]",
    )
  })
})

// =================================================================
// toolSignature — deduplication.ts:96-127 (null/undefined strip + rec. sort)
// =================================================================

describe("toolSignature (DCP deduplication.ts:96-127)", () => {
  it("returns tool name when parameters is undefined", () => {
    assert.equal(toolSignature("Read", undefined), "Read::")
  })

  it("includes sorted normalised JSON for non-empty parameters", () => {
    // Two Read calls with the SAME args (different key order) should match.
    const sigA = toolSignature("Read", { file_path: "a.ts", offset: 10 })
    const sigB = toolSignature("Read", { offset: 10, file_path: "a.ts" })
    assert.equal(sigA, sigB)
  })

  it("strips null/undefined values before serialising", () => {
    const sig = toolSignature("Read", { file_path: "a.ts", offset: null, limit: undefined })
    // null + undefined keys absent in normalised JSON
    const sigPlain = toolSignature("Read", { file_path: "a.ts" })
    assert.equal(sig, sigPlain)
  })

  it("distinguishes signatures by parameter value", () => {
    const sigA = toolSignature("Read", { file_path: "a.ts" })
    const sigB = toolSignature("Read", { file_path: "b.ts" })
    assert.notEqual(sigA, sigB)
  })

  it("sorts nested object keys recursively", () => {
    const sigA = toolSignature("Bash", {
      command: "ls",
      env: { FOO: "1", BAR: "2" },
    })
    const sigB = toolSignature("Bash", {
      env: { BAR: "2", FOO: "1" },
      command: "ls",
    })
    assert.equal(sigA, sigB)
  })
})

// =================================================================
// planPrune — F-P-1 dedup (3 same-arg Reads → first 2 in pruneToolCallIds)
// =================================================================

describe("planPrune — deduplication strategy (DCP deduplication.ts:16-94)", () => {
  it("F-P-1: 3 same-arg Read calls keep the last, prune the first two", () => {
    // Session shape:
    //   user(text)  → assistant(tool_use Read[a]) → user(tool_result for a)
    //   assistant(tool_use Read[b] same args)     → user(tool_result for b)
    //   assistant(tool_use Read[c] same args)     → user(tool_result for c)
    //   user(text)
    // Three identical Read tool_use calls. The most recent (c) must remain;
    // a and b are duplicates and must appear in byStrategy.dedup.
    const messages = [
      userText(0, "Read the same file 3 times please"),
      assistantToolUse(1, "tu_a", "Read", { file_path: "src/x.ts" }),
      userToolResult(2, "tu_a", "contents v1"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "src/x.ts" }),
      userToolResult(4, "tu_b", "contents v2"),
      assistantToolUse(5, "tu_c", "Read", { file_path: "src/x.ts" }),
      userToolResult(6, "tu_c", "contents v3"),
      userText(7, "thanks"),
    ]

    const cfg = makeConfig()
    const plan = planPrune(messages, cfg)

    // Both duplicate ids are in the dedup bucket
    assert.deepEqual(plan.byStrategy.dedup.sort(), ["tu_a", "tu_b"])
    // The most recent (tu_c) is NOT marked for pruning
    assert.ok(!plan.byStrategy.dedup.includes("tu_c"))
    // pruneToolCallIds is the union of both strategy buckets
    assert.ok(plan.pruneToolCallIds.has("tu_a"))
    assert.ok(plan.pruneToolCallIds.has("tu_b"))
    assert.ok(!plan.pruneToolCallIds.has("tu_c"))
  })

  it("does NOT dedup calls with different parameters", () => {
    const messages = [
      userText(0, "Read two different files"),
      assistantToolUse(1, "tu_a", "Read", { file_path: "a.ts" }),
      userToolResult(2, "tu_a", "A"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "b.ts" }),
      userToolResult(4, "tu_b", "B"),
    ]

    const plan = planPrune(messages, makeConfig())
    assert.deepEqual(plan.byStrategy.dedup, [])
    assert.equal(plan.pruneToolCallIds.size, 0)
  })

  it("does NOT dedup calls of a tool listed in protectedTools", () => {
    // config.strategies.deduplication.protectedTools is the dedup-specific
    // list (DCP: strategies.{strategy}.protectedTools is independent from
    // any default — R2 confirmed there is no implicit dedup protection).
    // Add the tool explicitly here.
    const messages = [
      userText(0, "plan it out"),
      assistantToolUse(1, "tu_a", "TodoWrite", { items: [{ id: "1", content: "x" }] }),
      userToolResult(2, "tu_a", "ok"),
      assistantToolUse(3, "tu_b", "TodoWrite", { items: [{ id: "1", content: "x" }] }),
      userToolResult(4, "tu_b", "ok"),
    ]

    const cfg = makeConfig({
      strategies: { deduplication: { protectedTools: ["TodoWrite"] } },
    })
    const plan = planPrune(messages, cfg)
    assert.deepEqual(plan.byStrategy.dedup, [])
    assert.equal(plan.pruneToolCallIds.size, 0)
  })

  it("honours strategies.deduplication.enabled = false (no dedup runs)", () => {
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "v1"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "v2"),
    ]
    const cfg = makeConfig({ strategies: { deduplication: { enabled: false } } })
    const plan = planPrune(messages, cfg)
    assert.deepEqual(plan.byStrategy.dedup, [])
  })

  it("honours manualMode + automaticStrategies=false (DCP guard at :22-24)", () => {
    // DCP deduplication.ts:22-24 short-circuits when manualMode is on AND
    // automaticStrategies is off. planPrune mirrors that guard.
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "v1"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "v2"),
    ]
    const cfg = makeConfig()
    cfg.manualMode = { enabled: true, automaticStrategies: false }
    const plan = planPrune(messages, cfg)
    assert.deepEqual(plan.byStrategy.dedup, [])
  })

  it("does NOT dedup calls whose file path matches protectedFilePatterns", () => {
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "docs/SPEC.md" }),
      userToolResult(2, "tu_a", "v1"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "docs/SPEC.md" }),
      userToolResult(4, "tu_b", "v2"),
    ]
    const cfg = makeConfig({ protectedFilePatterns: ["docs/*.md"] })
    const plan = planPrune(messages, cfg)
    assert.deepEqual(plan.byStrategy.dedup, [])
  })

  it("savedTokensEst is positive when duplicates exist", () => {
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "long output ".repeat(200)),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "long output ".repeat(200)),
    ]
    const plan = planPrune(messages, makeConfig())
    assert.ok(plan.savedTokensEst > 0, `expected savedTokensEst>0, got ${plan.savedTokensEst}`)
  })

  it("deterministic — two planPrune calls over the same input yield identical plans", () => {
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "v1"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "v2"),
      assistantToolUse(5, "tu_c", "Read", { file_path: "x.ts" }),
      userToolResult(6, "tu_c", "v3"),
    ]
    const cfg = makeConfig()
    const p1 = planPrune(messages, cfg)
    const p2 = planPrune(messages, cfg)

    // Convert Set to sorted array for stable comparison.
    const ids = (plan) => [...plan.pruneToolCallIds].sort()
    assert.deepEqual(ids(p1), ids(p2))
    assert.deepEqual(p1.byStrategy.dedup, p2.byStrategy.dedup)
    assert.deepEqual(p1.byStrategy.purgeErrors, p2.byStrategy.purgeErrors)
    assert.equal(p1.savedTokensEst, p2.savedTokensEst)
  })
})

// =================================================================
// planPrune — purgeErrors strategy (DCP purge-errors.ts:19-88)
// =================================================================

describe("planPrune — purgeErrors strategy (DCP purge-errors.ts:19-88)", () => {
  it("purges a tool_use whose tool_result has is_error=true AND turnAge >= turns (4)", () => {
    // turns=4 (default). 4 subsequent user messages after the failing call
    // satisfy turnAge >= turns. Build the trace carefully:
    //   idx 0  user(text)            ← turn boundary
    //   idx 1  assistant(tool_use Bash[id=tu_x, cmd="rm /"] )
    //   idx 2  user(tool_result tu_x, is_error=true)   ← failed call
    //   idx 3  user(text)            ← +1 user after failure
    //   idx 4  user(text)            ← +2
    //   idx 5  user(text)            ← +3
    //   idx 6  user(text)            ← +4 → turnAge=4 ≥ 4 → prune input
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_x", "Bash", { command: "rm /important" }),
      userToolResult(2, "tu_x", "Permission denied", true),
      userText(3, "u2"),
      userText(4, "u3"),
      userText(5, "u4"),
      userText(6, "u5"),
    ]
    const cfg = makeConfig()
    const plan = planPrune(messages, cfg)
    assert.ok(
      plan.byStrategy.purgeErrors.includes("tu_x"),
      `expected tu_x in purgeErrors, got ${JSON.stringify(plan.byStrategy.purgeErrors)}`,
    )
    assert.ok(plan.pruneToolCallIds.has("tu_x"))
  })

  it("does NOT purge when there are fewer than `turns` subsequent user messages", () => {
    // Only 3 user messages after the failure → turnAge=3 < turns=4
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_x", "Bash", { command: "rm /important" }),
      userToolResult(2, "tu_x", "Permission denied", true),
      userText(3, "u2"),
      userText(4, "u3"),
      userText(5, "u4"),
    ]
    const plan = planPrune(messages, makeConfig())
    assert.deepEqual(plan.byStrategy.purgeErrors, [])
  })

  it("does NOT purge successful (non-error) tool calls", () => {
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_ok", "Bash", { command: "ls" }),
      userToolResult(2, "tu_ok", "out", false),
      userText(3, "u2"),
      userText(4, "u3"),
      userText(5, "u4"),
      userText(6, "u5"),
    ]
    const plan = planPrune(messages, makeConfig())
    assert.deepEqual(plan.byStrategy.purgeErrors, [])
  })

  it("preserves error tool calls when listed in protectedTools", () => {
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_x", "Bash", { command: "rm /important" }),
      userToolResult(2, "tu_x", "Permission denied", true),
      userText(3, "u2"),
      userText(4, "u3"),
      userText(5, "u4"),
      userText(6, "u5"),
    ]
    const cfg = makeConfig({
      strategies: { purgeErrors: { protectedTools: ["Bash"] } },
    })
    const plan = planPrune(messages, cfg)
    assert.deepEqual(plan.byStrategy.purgeErrors, [])
  })

  it("honours strategies.purgeErrors.enabled = false", () => {
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_x", "Bash", { command: "rm /important" }),
      userToolResult(2, "tu_x", "Permission denied", true),
      userText(3, "u2"),
      userText(4, "u3"),
      userText(5, "u4"),
      userText(6, "u5"),
    ]
    const cfg = makeConfig({ strategies: { purgeErrors: { enabled: false } } })
    const plan = planPrune(messages, cfg)
    assert.deepEqual(plan.byStrategy.purgeErrors, [])
  })

  it("turnProtection (enabled) skips purges when subsequent user count < turnProtection.turns", () => {
    // turnProtection = { enabled:true, turns:6 } — there are only 4 user msgs
    // after the failure, so the protection gate (4 < 6) must short-circuit
    // and skip the purge even though purgeErrors.turns=4 would otherwise match.
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_x", "Bash", { command: "rm /important" }),
      userToolResult(2, "tu_x", "Permission denied", true),
      userText(3, "u2"),
      userText(4, "u3"),
      userText(5, "u4"),
      userText(6, "u5"),
    ]
    const cfg = makeConfig()
    cfg.turnProtection = { enabled: true, turns: 6 }
    const plan = planPrune(messages, cfg)
    assert.deepEqual(plan.byStrategy.purgeErrors, [])
  })

  it("turnProtection does NOT fire when disabled (default) — purge still runs", () => {
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_x", "Bash", { command: "rm /important" }),
      userToolResult(2, "tu_x", "Permission denied", true),
      userText(3, "u2"),
      userText(4, "u3"),
      userText(5, "u4"),
      userText(6, "u5"),
    ]
    const cfg = makeConfig()
    cfg.turnProtection = { enabled: false, turns: 6 } // disabled → ignore threshold
    const plan = planPrune(messages, cfg)
    assert.ok(plan.byStrategy.purgeErrors.includes("tu_x"))
  })
})

// =================================================================
// applyPrune — placeholder injection (DCP prune.ts:73-157)
// =================================================================

describe("applyPrune — placeholder substitution (DCP prune.ts:73-157)", () => {
  it("replaces the tool_result content (string) of a dedup'd id with PRUNED_TOOL_OUTPUT", () => {
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "real contents v1"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "real contents v2"),
    ]

    const cfg = makeConfig()
    const plan = planPrune(messages, cfg)
    const result = applyPrune(messages, plan, new Set())

    // Locate the user tool_result for tu_a (now placeholder) vs tu_b (untouched).
    const userMsgForA = result[1]
    const userMsgForB = result[3]
    assert.equal(
      userMsgForA.content[0].content,
      PRUNED_TOOL_OUTPUT,
      "dedup'd tool_result content should be replaced",
    )
    assert.equal(
      userMsgForB.content[0].content,
      "real contents v2",
      "most-recent tool_result must remain intact",
    )
  })

  it("replaces each string field of a purged error tool_use input with PRUNED_TOOL_ERROR_INPUT", () => {
    // Hand-build the messages and the plan: pretend we already know tu_x is purged.
    const messages = [
      assistantToolUse(1, "tu_x", "Bash", {
        command: "rm /important",
        description: "destructive op",
      }),
      userToolResult(2, "tu_x", "Permission denied", true),
    ]
    const plan = {
      pruneToolCallIds: new Set(["tu_x"]),
      byStrategy: { dedup: [], purgeErrors: ["tu_x"] },
      savedTokensEst: 0,
    }
    const result = applyPrune(messages, plan, new Set())
    const input = result[0].content[0].input
    // Both string-valued fields must be replaced with the placeholder.
    assert.equal(input.command, PRUNED_TOOL_ERROR_INPUT)
    assert.equal(input.description, PRUNED_TOOL_ERROR_INPUT)
    // The corresponding user tool_result stays intact (error output preserved).
    assert.equal(result[1].content[0].content, "Permission denied")
  })

  it("replaces AskUserQuestions input.questions with PRUNED_QUESTION_INPUT", () => {
    // "AskUserQuestions" is the ZCode/MCP name for the question tool.
    const messages = [
      assistantToolUse(1, "tu_q", "AskUserQuestions", {
        questions: [
          { header: "Auth", options: [{ label: "A" }] },
          { header: "Mode", options: [{ label: "B" }] },
        ],
      }),
      userToolResult(2, "tu_q", "user answered A, B"),
    ]
    const plan = {
      pruneToolCallIds: new Set(["tu_q"]),
      byStrategy: { dedup: ["tu_q"], purgeErrors: [] },
      savedTokensEst: 0,
    }
    const result = applyPrune(messages, plan, new Set())
    assert.equal(result[0].content[0].input.questions, PRUNED_QUESTION_INPUT)
    // The matching user tool_result stays intact.
    assert.equal(result[1].content[0].content, "user answered A, B")
  })

  it("leaves the messages array (input) unmutated — returns a NEW array", () => {
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "real contents"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "real contents v2"),
    ]
    const snapshot = JSON.parse(JSON.stringify(messages))
    const plan = planPrune(messages, makeConfig())
    applyPrune(messages, plan, new Set())
    assert.deepEqual(messages, snapshot, "input array must not be mutated")
  })

  it("skips messages whose index is in coveredIndices (compress already covered them)", () => {
    // After compress replaces [idx 1..2] with a synthetic user summary, those
    // messages are "covered" and prune must not touch their tool_result.
    const messages = [
      userText(0, "before compress"),
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "real contents — must remain"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "real contents v2"),
    ]
    const cfg = makeConfig()
    const plan = planPrune(messages, cfg) // tu_a would be in the dedup bucket
    // Indices 1 and 2 are "covered" — applyPrune must skip them.
    const result = applyPrune(messages, plan, new Set([1, 2]))

    // The user message at idx=2 stays intact (covered).
    assert.equal(result[2].content[0].content, "real contents — must remain")
    // The dedup target idx=2 means tu_a's tool_result was NOT replaced.
  })

  it("savedTokensEst sums estimated tokens of pruned content (positive)", () => {
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "x".repeat(2000)),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "y".repeat(2000)),
      assistantToolUse(5, "tu_c", "Read", { file_path: "x.ts" }),
      userToolResult(6, "tu_c", "z".repeat(2000)),
    ]
    const plan = planPrune(messages, makeConfig())
    assert.ok(plan.savedTokensEst > 0)
  })

  // ---- C-1: immutability of original messages across all 3 apply paths ----

  it("C-1a: applyPrune does NOT mutate tool_use input (error input substitution path)", () => {
    // Regression for review C-1. applyToolErrorInputSubstitution writes
    // directly into block.input[key]. If block.input is a shared reference
    // to the caller's object, the original tool_use.input gets corrupted.
    // Required for H1 fidelity and task-9 logRequest originalBody semantics.
    const messages = [
      assistantToolUse(1, "tu_x", "Bash", {
        command: "rm /important",
        description: "destructive op",
      }),
      userToolResult(2, "tu_x", "Permission denied", true),
      userText(3, "u2"),
      userText(4, "u3"),
      userText(5, "u4"),
      userText(6, "u5"),
    ]
    const snapshot = JSON.parse(JSON.stringify(messages))
    const plan = planPrune(messages, makeConfig())
    applyPrune(messages, plan, new Set())
    assert.deepEqual(messages, snapshot, "original messages array must not be mutated")
  })

  it("C-1b: applyPrune does NOT mutate AskUserQuestions input.questions", () => {
    // Regression for review C-1 on the question-substitution path.
    const messages = [
      assistantToolUse(1, "tu_q", "AskUserQuestions", {
        questions: [
          { header: "Auth", options: [{ label: "A" }] },
        ],
      }),
      userToolResult(2, "tu_q", "user answered A"),
    ]
    const snapshot = JSON.parse(JSON.stringify(messages))
    // Force the question id into the prune bucket (same signature dedup).
    const messages2 = [
      assistantToolUse(1, "tu_q1", "AskUserQuestions", {
        questions: [{ header: "Auth", options: [{ label: "A" }] }],
      }),
      userToolResult(2, "tu_q1", "ok"),
      assistantToolUse(3, "tu_q2", "AskUserQuestions", {
        questions: [{ header: "Auth", options: [{ label: "A" }] }],
      }),
      userToolResult(4, "tu_q2", "ok"),
    ]
    const snapshot2 = JSON.parse(JSON.stringify(messages2))
    const plan = planPrune(messages2, makeConfig())
    applyPrune(messages2, plan, new Set())
    assert.deepEqual(messages2, snapshot2, "question input.questions must not leak")
    // And also verify the snapshot for the single-call path wasn't touched.
    assert.deepEqual(messages, snapshot)
  })

  it("C-1c: applyPrune does NOT mutate tool_result.content (string substitution path)", () => {
    // The existing 'leaves the messages array unmutated' test covers array
    // identity; this one locks the contract on the tool_result.content path
    // specifically (verify the string field on the original tool_result is
    // untouched even after a placeholder substitution).
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "real contents v1 (must survive verbatim)"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "real contents v2"),
    ]
    const originalToolResultContent = messages[1].content[0].content
    const plan = planPrune(messages, makeConfig())
    applyPrune(messages, plan, new Set())
    assert.equal(
      messages[1].content[0].content,
      originalToolResultContent,
      "dedup'd tool_result.content on the SOURCE array must remain unchanged",
    )
    assert.equal(messages[1].content[0].content, "real contents v1 (must survive verbatim)")
  })
})

// =================================================================
// Review-fix regression tests: I-1 / I-2 / I-3
// =================================================================

describe("review-fix regressions (I-1 / I-2 / I-3)", () => {
  it("I-2: arrays in tool parameters are kept as-is (not recursively null-stripped)", () => {
    // DCP normalizeParameters at deduplication.ts:105-116 returns arrays
    // untouched at the top level (null-strip applies to plain objects only).
    // Collapsing [{a:null}] -> [{}] broke dedup of array-typed parameters.
    assert.notEqual(
      toolSignature("Foo", [{ a: null }]),
      toolSignature("Foo", [{}]),
      "[{a:null}] must not collapse to [{}]",
    )
    assert.notEqual(
      toolSignature("Foo", [{ a: 1 }]),
      toolSignature("Foo", [{ a: 2 }]),
      "arrays with different element values must produce different signatures",
    )
    // Null-strip DOES still apply to object-valued array elements.
    // {a:null} inside an object normalises to {} (null key removed).
    assert.equal(
      toolSignature("Foo", { a: null }),
      toolSignature("Foo", {}),
      "null-strip still applies to object-typed parameter values",
    )
  })

  it("I-2: arrays with same elements in same order produce the same signature (deterministic)", () => {
    assert.equal(
      toolSignature("Foo", [{ x: 1 }, { x: 2 }]),
      toolSignature("Foo", [{ x: 1 }, { x: 2 }]),
    )
  })

  it("I-1: turnProtection (enabled) skips dedup when subsequent user count < turnProtection.turns", () => {
    // Regression for review I-1: turnProtection previously gated purgeErrors
    // only; dedup also needs the gate per DCP tool-cache.ts semantics.
    // Build a session where:
    //   - there are TWO identical Read tool_use calls (would dedup)
    //   - only 1 user message follows the second call → turnProtection should
    //     prevent the dedup (subsequent user count < turnProtection.turns=4)
    const messages = [
      userText(0, "first request"),
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "v1"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "v2"),
      // Only ONE user message after tu_b's assistant message (idx 3).
      // countUserMessagesAfter(3) = 1 < turnProtectionTurns=4 → skip dedup
      userText(5, "trailing user"),
    ]
    const cfg = makeConfig()
    cfg.turnProtection = { enabled: true, turns: 4 }
    const plan = planPrune(messages, cfg)
    assert.deepEqual(
      plan.byStrategy.dedup,
      [],
      "turnProtection must prevent dedup when call is too recent",
    )
  })

  it("I-1: turnProtection does NOT gate dedup when disabled", () => {
    // Sanity: the gate is opt-in (enabled=false → no gate). The original
    // dedup behaviour is preserved.
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "v1"),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "v2"),
      userText(5, "trailing"),
    ]
    const cfg = makeConfig()
    cfg.turnProtection = { enabled: false, turns: 4 }
    const plan = planPrune(messages, cfg)
    assert.deepEqual(plan.byStrategy.dedup, ["tu_a"])
  })

  it("I-3: an errored call that lands in dedup bucket still has its input cleaned", () => {
    // Regression for review I-3: applyToolErrorInputSubstitution previously
    // iterated only plan.byStrategy.purgeErrors. A failing call that also
    // has an identical twin (same signature) lands in dedup, not purgeErrors;
    // DCP's pruneToolErrors walks the union (state.prune.tools) and gates on
    // status === "error", so the input must be cleaned.
    const messages = [
      assistantToolUse(1, "tu_a", "Bash", { command: "rm /x" }),
      userToolResult(2, "tu_a", "denied", true),
      assistantToolUse(3, "tu_b", "Bash", { command: "rm /x" }),
      userToolResult(4, "tu_b", "denied", true),
    ]
    const plan = planPrune(messages, makeConfig())
    // tu_a is in dedup bucket (same signature as tu_b, came first)
    assert.deepEqual(plan.byStrategy.dedup, ["tu_a"])
    // tu_b is the most recent duplicate, so it has no dedup entry — and the
    // purge strategy needs 4 subsequent user messages, none present.
    assert.deepEqual(plan.byStrategy.purgeErrors, [])
    // pruneToolCallIds contains tu_a (NOT tu_b — most-recent kept)
    assert.ok(plan.pruneToolCallIds.has("tu_a"))
    assert.ok(!plan.pruneToolCallIds.has("tu_b"))

    const result = applyPrune(messages, plan, new Set())
    // tu_a is errored + in pruneToolCallIds → its input IS cleaned.
    assert.equal(
      result[0].content[0].input.command,
      PRUNED_TOOL_ERROR_INPUT,
      "dedup'd errored tool_use input must be cleaned (I-3)",
    )
    // tu_b is the most-recent duplicate — OUTS of pruneToolCallIds, input preserved.
    assert.equal(
      result[2].content[0].input.command,
      "rm /x",
      "most-recent duplicate is OUTSIDE the prune set; its input is preserved",
    )
    // Tool_results for both errored calls must remain intact (error output
    // is preserved per DCP pruneToolErrors — applies to BOTH calls
    // regardless of prune status; only inputs are touched).
    assert.equal(result[1].content[0].content, "denied")
    assert.equal(result[3].content[0].content, "denied")
  })

  it("I-3: input cleanup is NOT applied to non-errored dedup'd calls", () => {
    // Negative case: a dedup'd but SUCCESSFUL call must NOT have its input
    // cleaned (input substitution is gated on is_error).
    const messages = [
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "ok", false),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "ok", false),
    ]
    const plan = planPrune(messages, makeConfig())
    assert.deepEqual(plan.byStrategy.dedup, ["tu_a"])
    const result = applyPrune(messages, plan, new Set())
    // tool_result.content cleared (dedup output path)
    assert.equal(result[1].content[0].content, PRUNED_TOOL_OUTPUT)
    // tool_use input NOT cleaned (no error)
    assert.equal(result[0].content[0].input.file_path, "x.ts")
  })
})

// =================================================================
// R2 fix (SPEC R2 / PLAN Task 2) — dedup skip-list must be bare-name
// case-insensitive, and the OUTPUT replacement skip-list + QUESTION
// input skip-list must share the same set. Both sites must accept the
// PascalCase ZCode tool names (Write/Edit/AskUserQuestion) and the MCP
// full form (mcp__<server>__<tool>).
// =================================================================

describe("R2: skip-list is bare-name case-insensitive and shared (R2.1)", () => {
  it("R2.1a: capitalised Write tool_result is NOT replaced even when its id lands in the dedup bucket", () => {
    // ZCode emits PascalCase tool names ('Write'). The output substitution
    // skip-list must match the bare name case-insensitively — otherwise
    // PRUNED_TOOL_OUTPUT would silently destroy the most recent file write
    // output the model may still need to inspect.
    // Array layout (idx param is documentation only, not position):
    //   [0] user(text)            [1] assistant(tool_use Write[tu_a])
    //   [2] user(tool_result tu_a) [3] assistant(tool_use Write[tu_b])
    //   [4] user(tool_result tu_b) [5] user(text)
    const messages = [
      userText(0, "edit it twice"),
      assistantToolUse(1, "tu_a", "Write", { file_path: "x.ts", content: "v1" }),
      userToolResult(2, "tu_a", "wrote v1 — must survive verbatim"),
      assistantToolUse(3, "tu_b", "Write", { file_path: "x.ts", content: "v1" }),
      userToolResult(4, "tu_b", "wrote v1 v2 — must survive verbatim"),
      userText(5, "thanks"),
    ]
    const cfg = makeConfig()
    const plan = planPrune(messages, cfg)
    // tu_a is the older duplicate, it lands in the dedup bucket.
    assert.ok(plan.pruneToolCallIds.has("tu_a"), "tu_a should be in dedup bucket")
    const result = applyPrune(messages, plan, new Set())
    // tool_result for tu_a is at array index 2 — must NOT be replaced with
    // the placeholder (Write is in the skip-list, case-insensitive on the
    // bare name).
    assert.equal(
      result[2].content[0].content,
      "wrote v1 — must survive verbatim",
      "capitalised Write tool_result must NOT be replaced by dedup output substitution",
    )
  })

  it("R2.1a: capitalised Edit tool_result is NOT replaced (regression companion of Write)", () => {
    // Same case as Write — Edit arrives in PascalCase from ZCode, the skip-list
    // must match after lowercasing the bare name.
    const messages = [
      userText(0, "edit it twice"),
      assistantToolUse(1, "tu_a", "Edit", { file_path: "x.ts", old: "a", new: "b" }),
      userToolResult(2, "tu_a", "edited v1 — must survive verbatim"),
      assistantToolUse(3, "tu_b", "Edit", { file_path: "x.ts", old: "a", new: "b" }),
      userToolResult(4, "tu_b", "edited v2 — must survive verbatim"),
      userText(5, "thanks"),
    ]
    const plan = planPrune(messages, makeConfig())
    assert.ok(plan.pruneToolCallIds.has("tu_a"))
    const result = applyPrune(messages, plan, new Set())
    assert.equal(
      result[2].content[0].content,
      "edited v1 — must survive verbatim",
      "capitalised Edit tool_result must NOT be replaced by dedup output substitution",
    )
  })

  it("R2.1a: MCP-full mcp__srv__Write also skips output substitution (prefix stripped + lowercased)", () => {
    // Same skip-list, exercised through the MCP full form to lock the
    // stripMcpPrefix + lowercase composition.
    const messages = [
      userText(0, "mcp twice"),
      assistantToolUse(1, "tu_a", "mcp__srv__Write", { file_path: "x.ts", content: "v1" }),
      userToolResult(2, "tu_a", "wrote v1 — must survive verbatim"),
      assistantToolUse(3, "tu_b", "mcp__srv__Write", { file_path: "x.ts", content: "v1" }),
      userToolResult(4, "tu_b", "wrote v2 — must survive verbatim"),
      userText(5, "ok"),
    ]
    const plan = planPrune(messages, makeConfig())
    assert.ok(plan.pruneToolCallIds.has("tu_a"))
    const result = applyPrune(messages, plan, new Set())
    assert.equal(
      result[2].content[0].content,
      "wrote v1 — must survive verbatim",
      "MCP-full Write tool_result must NOT be replaced",
    )
  })

  it("R2.1b: singular MCP-full mcp__srv__AskUserQuestion (input.questions) IS replaced by the question path", () => {
    // ZCode emits the question tool in BOTH singular and plural form depending
    // on the MCP server wiring. The questions input-substitution must hit
    // both names. The singular form is the regression case: the previous
    // hardcoded list compared only the literal "AskUserQuestions" and "question",
    // so the singular form silently leaked its (potentially long) questions
    // array into the request even after dedup.
    // Array layout:
    //   [0] user(text)        [1] assistant(tool_use mcp__srv__AskUserQuestion[tu_q1])
    //   [2] user(tool_result) [3] assistant(tool_use ...[tu_q2])
    //   [4] user(tool_result)
    const messages = [
      userText(0, "ask me once"),
      assistantToolUse(1, "tu_q1", "mcp__srv__AskUserQuestion", {
        questions: [
          { header: "Auth", options: [{ label: "A" }] },
          { header: "Mode", options: [{ label: "B" }] },
        ],
      }),
      userToolResult(2, "tu_q1", "user answered A, B"),
      assistantToolUse(3, "tu_q2", "mcp__srv__AskUserQuestion", {
        questions: [
          { header: "Auth", options: [{ label: "A" }] },
          { header: "Mode", options: [{ label: "B" }] },
        ],
      }),
      userToolResult(4, "tu_q2", "user answered A, B again"),
    ]
    const plan = planPrune(messages, makeConfig())
    // tu_q1 is the older duplicate and lands in the dedup bucket.
    assert.ok(plan.pruneToolCallIds.has("tu_q1"), "tu_q1 should be in dedup bucket")
    const result = applyPrune(messages, plan, new Set())
    // Singular form's input.questions must be replaced by the placeholder.
    assert.equal(
      result[1].content[0].input.questions,
      PRUNED_QUESTION_INPUT,
      "singular MCP-full AskUserQuestion input.questions must be replaced",
    )
    // The matching tool_result for the singular form stays intact.
    assert.equal(result[2].content[0].content, "user answered A, B")
  })

  it("R2.1b: bare AskUserQuestions (plural) still hits the question path (regression lock)", () => {
    // The plural form has always worked; this test pins it so a future
    // refactor cannot silently regress one of the two name forms.
    const messages = [
      userText(0, "ask me once"),
      assistantToolUse(1, "tu_q1", "AskUserQuestions", {
        questions: [{ header: "Auth", options: [{ label: "A" }] }],
      }),
      userToolResult(2, "tu_q1", "ok"),
      assistantToolUse(3, "tu_q2", "AskUserQuestions", {
        questions: [{ header: "Auth", options: [{ label: "A" }] }],
      }),
      userToolResult(4, "tu_q2", "ok"),
    ]
    const plan = planPrune(messages, makeConfig())
    assert.ok(plan.pruneToolCallIds.has("tu_q1"))
    const result = applyPrune(messages, plan, new Set())
    assert.equal(
      result[1].content[0].input.questions,
      PRUNED_QUESTION_INPUT,
      "plural AskUserQuestions input.questions must be replaced (regression)",
    )
  })

  it("R2.1c: lowercase 'edit' / 'write' / 'question' tool_results are still NOT replaced (regression guard)", () => {
    // R2 is a SUPERSET-extension of the old DCP baseline. The lowercase
    // names must keep being skipped — this test pins the existing
    // behaviour so the refactor doesn't accidentally drop them.
    // Array layout: [0] user [1] assistant [2] user(tool_result) [3] assistant [4] user(tool_result)
    const cases = [
      { name: "edit", input: { file_path: "x.ts", old: "a", new: "b" }, content: "edit-out-1" },
      { name: "write", input: { file_path: "x.ts", content: "v1" }, content: "write-out-1" },
      { name: "question", input: { questions: [{ header: "X" }] }, content: "question-out-1" },
    ]
    for (const tc of cases) {
      const messages = [
        userText(0, "do twice"),
        assistantToolUse(1, "tu_a", tc.name, tc.input),
        userToolResult(2, "tu_a", tc.content),
        assistantToolUse(3, "tu_b", tc.name, tc.input),
        userToolResult(4, "tu_b", "second " + tc.content),
      ]
      const plan = planPrune(messages, makeConfig())
      const result = applyPrune(messages, plan, new Set())
      assert.equal(
        result[2].content[0].content,
        tc.content,
        `lowercase '${tc.name}' tool_result must remain unchanged (regression)`,
      )
    }
  })

  it("R2.1d: SKIP_TOOLS is exported and matches the documented 5-element set", () => {
    // The two skip sites (output replacement + question input replacement)
    // share the SAME constant. This is the indirect lock on R2.1's "both
    // sites use the same set" requirement: the test imports the constant
    // directly, so a future divergence would fail the import-shape test.
    assert.ok(SKIP_TOOLS instanceof Set, "SKIP_TOOLS must be a Set")
    const expected = new Set([
      "edit",
      "write",
      "question",
      "askuserquestion",
      "askuserquestions",
    ])
    assert.deepEqual(
      new Set(SKIP_TOOLS),
      expected,
      "SKIP_TOOLS must contain the documented 5-element set (lowercase bare names)",
    )
    assert.equal(SKIP_TOOLS.size, expected.size, "SKIP_TOOLS must have exactly 5 elements")
  })

  it("R2.1d: SKIP_TOOLS membership for both bare + MCP-full forms is consistent across sites", () => {
    // Cross-site consistency check (indirect): for every name form, the
    // bare name after stripMcpPrefix + toLowerCase must land in the set.
    // Both applyToolOutputSubstitution and applyQuestionInputSubstitution
    // call SKIP_TOOLS.has(...) the same way — if either site diverged,
    // it would have to be by editing the Set directly, which the export
    // pin above would also catch.
    const sample = [
      "Write",
      "Edit",
      "Question",
      "AskUserQuestion",
      "AskUserQuestions",
      "mcp__srv__Write",
      "mcp__srv__Edit",
      "mcp__srv__Question",
      "mcp__srv__AskUserQuestion",
      "mcp__srv__AskUserQuestions",
      "mcp__other__write",
      "mcp__x__question",
    ]
    for (const name of sample) {
      const bare = name.replace(/^mcp__[^_]+(?:__[^_]+)*?__/, "")
      assert.ok(
        SKIP_TOOLS.has(bare.toLowerCase()),
        `bare name '${bare.toLowerCase()}' (from '${name}') must be in SKIP_TOOLS`,
      )
    }
  })
})

// =================================================================
// R8.3 / DESIGN D3 — per-strategy token attribution (DCP stats fields)
// =================================================================
//
// SPEC R8.3: byStrategyTokens.* — a per-strategy split of savedTokens, so
// operators can see exactly how much each strategy (dedup / purge /
// sweep / compress) contributed to the savings line. This split lives
// on the prune plan object as `byStrategyTokens.{dedup,purge,sweep}`
// (sweep is a separate bucket because the user's /dcp-admin sweep marks
// do not belong to any of the two automatic strategies).
//
// Contract — bucketed sum equals savedTokensEst:
//   byStrategyTokens.dedup + byStrategyTokens.purge + byStrategyTokens.sweep
//     === savedTokensEst
//
// (sweep is added at the pipeline layer after planPrune returns; the
//  pure planPrune contract only has dedup + purge buckets.)

describe("R8.3: planPrune byStrategyTokens bucketed attribution (D3)", () => {
  it("D3.① mixed dedup + purge fixture: dedup bucket sums to dedup items, purge bucket sums to purge items", () => {
    // Build a session that hits BOTH strategies:
    //   - tu_a / tu_b are identical Read calls → tu_a lands in dedup bucket
    //   - tu_x is an errored Bash with enough trailing user turns for purge
    // The dedup bucket must own the estimated tokens for tu_a (its tool_use
    // + tool_result pair); the purge bucket must own the estimate for tu_x.
    const messages = [
      userText(0, "do it"),
      // dedup pair: Read same file twice
      assistantToolUse(1, "tu_a", "Read", { file_path: "src/x.ts" }),
      userToolResult(2, "tu_a", "A".repeat(400)),
      assistantToolUse(3, "tu_b", "Read", { file_path: "src/x.ts" }),
      userToolResult(4, "tu_b", "B".repeat(400)),
      // purge target: errored Bash with 4 trailing user msgs
      assistantToolUse(5, "tu_x", "Bash", { command: "rm /important" }),
      userToolResult(6, "tu_x", "Permission denied", true),
      userText(7, "u2"),
      userText(8, "u3"),
      userText(9, "u4"),
      userText(10, "u5"),
    ]
    const plan = planPrune(messages, makeConfig())

    // Buckets exist on the plan object (shape)
    assert.ok(plan.byStrategyTokens, "plan must expose byStrategyTokens")
    assert.equal(typeof plan.byStrategyTokens.dedup, "number")
    assert.equal(typeof plan.byStrategyTokens.purge, "number")
    // sweep is pipeline-injected; planPrune itself only carries dedup+purge
    assert.ok(
      plan.byStrategyTokens.sweep === undefined || plan.byStrategyTokens.sweep === 0,
      "planPrune itself must not invent a sweep bucket",
    )

    // tu_a is in dedup bucket → its tool_use + tool_result estimates flow into dedup
    assert.ok(plan.byStrategy.dedup.includes("tu_a"), "tu_a should be dedup target")
    // tu_x is in purgeErrors bucket
    assert.ok(plan.byStrategy.purgeErrors.includes("tu_x"), "tu_x should be purge target")

    // Compute the expected estimates by hand (mirror prune.mjs estimate path)
    // so the assertion is independent of the implementation's exact ratio.
    // Production uses estimateMessageTokens → estimateTokens(JSON.stringify(block))
    // for tool_use (whole block), and estimateTokens(content) for tool_result's
    // string content. estimateTokens uses Math.round(text.length / 4) for ASCII.
    function estToolUse(block) { return Math.round(JSON.stringify(block).length / 4) }
    function estToolResult(block) { return Math.round((typeof block.content === "string" ? block.content.length : 0) / 4) }
    let dedupExpected = 0
    for (const m of messages) {
      if (!m || !Array.isArray(m.content)) continue
      for (const p of m.content) {
        if (!p || typeof p !== "object") continue
        if (p.type === "tool_use" && p.id === "tu_a") dedupExpected += estToolUse(p)
        if (p.type === "tool_result" && p.tool_use_id === "tu_a") dedupExpected += estToolResult(p)
      }
    }
    let purgeExpected = 0
    for (const m of messages) {
      if (!m || !Array.isArray(m.content)) continue
      for (const p of m.content) {
        if (!p || typeof p !== "object") continue
        if (p.type === "tool_use" && p.id === "tu_x") purgeExpected += estToolUse(p)
        if (p.type === "tool_result" && p.tool_use_id === "tu_x") purgeExpected += estToolResult(p)
      }
    }

    assert.equal(
      plan.byStrategyTokens.dedup, dedupExpected,
      `dedup bucket must equal sum of tu_a's tool_use+tool_result estimates (got ${plan.byStrategyTokens.dedup}, expected ${dedupExpected})`,
    )
    assert.equal(
      plan.byStrategyTokens.purge, purgeExpected,
      `purge bucket must equal sum of tu_x's tool_use+tool_result estimates (got ${plan.byStrategyTokens.purge}, expected ${purgeExpected})`,
    )

    // Buckets sum to savedTokensEst (R8.3 contract — per-strategy split is exact).
    const sum = plan.byStrategyTokens.dedup + plan.byStrategyTokens.purge +
      (plan.byStrategyTokens.sweep || 0)
    assert.equal(
      sum, plan.savedTokensEst,
      `byStrategyTokens.{dedup,purge,sweep} must sum to savedTokensEst (sum=${sum}, savedTokensEst=${plan.savedTokensEst})`,
    )
  })

  it("D3.② all-duplicate fixture (no purge hits) → purge bucket=0, dedup bucket=savedTokensEst", () => {
    // 3 identical Read calls → 2 in dedup bucket, none errored
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "X".repeat(400)),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "Y".repeat(400)),
      assistantToolUse(5, "tu_c", "Read", { file_path: "x.ts" }),
      userToolResult(6, "tu_c", "Z".repeat(400)),
    ]
    const plan = planPrune(messages, makeConfig())

    assert.equal(plan.byStrategyTokens.purge, 0, "no purge hits → purge bucket=0")
    assert.equal(
      plan.byStrategyTokens.dedup + plan.byStrategyTokens.purge,
      plan.savedTokensEst,
      "sum of buckets must equal savedTokensEst",
    )
    assert.ok(
      plan.byStrategyTokens.dedup > 0,
      "dedup bucket must be > 0 when duplicates exist",
    )
  })

  it("D3.③ empty plan → all buckets=0, sum=0 (regression guard)", () => {
    // No duplicates, no errors → no savings.
    const messages = [
      userText(0, "hi"),
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    const plan = planPrune(messages, makeConfig())
    assert.equal(plan.savedTokensEst, 0)
    assert.equal(plan.byStrategyTokens.dedup, 0)
    assert.equal(plan.byStrategyTokens.purge, 0)
    assert.equal(
      plan.byStrategyTokens.dedup + plan.byStrategyTokens.purge,
      plan.savedTokensEst,
    )
  })

  it("D3.④ empty plan shape (manualMode.automaticStrategies=false) → all buckets=0", () => {
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_a", "Read", { file_path: "x.ts" }),
      userToolResult(2, "tu_a", "X".repeat(400)),
      assistantToolUse(3, "tu_b", "Read", { file_path: "x.ts" }),
      userToolResult(4, "tu_b", "Y".repeat(400)),
    ]
    const cfg = makeConfig()
    cfg.manualMode = { enabled: true, automaticStrategies: false }
    const plan = planPrune(messages, cfg)
    assert.equal(plan.savedTokensEst, 0)
    assert.equal(plan.byStrategyTokens.dedup, 0)
    assert.equal(plan.byStrategyTokens.purge, 0)
  })

  it("D3.⑤ single-attribution rule: dedup/purge overlap → sum=savedTokensEst (D3 review I-1)", () => {
    // Regression for D3 review I-1: a tool_call id can land in BOTH the
    // dedup bucket (it was the older duplicate of a repeated call) AND the
    // purgeErrors bucket (its twin's tool_result.is_error=true with enough
    // trailing user turns). When that happens, the token estimate must be
    // attributed to EXACTLY ONE bucket — otherwise the four-bucket sum
    // exceeds savedTokensEst (byStrategyTokens count was double-counting).
    // Real-world shape: two identical errored Bash commands.
    //   - tu_a (the older one) lands in dedup (its twin tu_b is identical)
    //   - tu_a ALSO lands in purgeErrors (its own tool_result is_error=true
    //     + 4 subsequent user msgs satisfy turns=4)
    //   - tu_b lands in purgeErrors (same reasoning) but NOT in dedup
    //     (it's the most-recent duplicate — dedup keeps the most recent).
    // dedup-first attribution (chosen because the older twin is what
    // becomes "obsolete" once dedup collapses it):
    //   tu_a → dedup bucket (NOT purge, even though also in purgeErrors)
    //   tu_b → purge bucket
    // Expected totals:
    //   savedTokensEst    = est(tu_a tool_use + tool_result) + est(tu_b tool_use + tool_result)
    //   byStrategyTokens.dedup = est(tu_a tool_use + tool_result)
    //   byStrategyTokens.purge = est(tu_b tool_use + tool_result)
    //   sum === savedTokensEst (single attribution per id)
    const messages = [
      userText(0, "do it"),
      assistantToolUse(1, "tu_a", "Bash", { command: "rm /important" }),
      userToolResult(2, "tu_a", "Permission denied".padEnd(400, "."), true),
      assistantToolUse(3, "tu_b", "Bash", { command: "rm /important" }),
      userToolResult(4, "tu_b", "Permission denied".padEnd(400, "."), true),
      userText(5, "u2"),
      userText(6, "u3"),
      userText(7, "u4"),
      userText(8, "u5"),
    ]
    const plan = planPrune(messages, makeConfig())

    // Sanity: tu_a is in BOTH strategy hit arrays (the overlap case).
    assert.ok(plan.byStrategy.dedup.includes("tu_a"), "tu_a in dedup hit array")
    assert.ok(plan.byStrategy.purgeErrors.includes("tu_a"), "tu_a in purge hit array")
    // tu_b is ONLY in purgeErrors (most-recent duplicate is not in dedup bucket).
    assert.ok(!plan.byStrategy.dedup.includes("tu_b"), "tu_b is the most-recent dup — not in dedup hit array")
    assert.ok(plan.byStrategy.purgeErrors.includes("tu_b"), "tu_b in purge hit array")

    // The hit-COUNT arrays are independent of token attribution — keep them
    // as-is. byStrategy (the count split) reports both hits on tu_a as two
    // strategy "wins" — that is correct, an id can be a win for both
    // strategies simultaneously without double-counting tokens.
    assert.deepEqual(plan.byStrategy.dedup, ["tu_a"])
    assert.deepEqual(plan.byStrategy.purgeErrors, ["tu_a", "tu_b"])

    // Core assertion: byStrategyTokens.{dedup,purge} SINGLE-ATTRIBUTES the
    // overlap. sum must equal savedTokensEst (NOT exceed it).
    const sum = plan.byStrategyTokens.dedup + plan.byStrategyTokens.purge
    assert.equal(
      sum, plan.savedTokensEst,
      `single-attribution rule: sum(${sum}) must equal savedTokensEst(${plan.savedTokensEst})`,
    )
    // dedup bucket must contain tu_a's estimate; purge must NOT also count it.
    const estToolUse = (block) => Math.round(JSON.stringify(block).length / 4)
    const estToolResult = (block) => Math.round(
      (typeof block.content === "string" ? block.content.length : 0) / 4,
    )
    let tuAExpected = 0
    for (const m of messages) {
      if (!m || !Array.isArray(m.content)) continue
      for (const p of m.content) {
        if (!p || typeof p !== "object") continue
        if (p.type === "tool_use" && p.id === "tu_a") tuAExpected += estToolUse(p)
        if (p.type === "tool_result" && p.tool_use_id === "tu_a") tuAExpected += estToolResult(p)
      }
    }
    let tuBExpected = 0
    for (const m of messages) {
      if (!m || !Array.isArray(m.content)) continue
      for (const p of m.content) {
        if (!p || typeof p !== "object") continue
        if (p.type === "tool_use" && p.id === "tu_b") tuBExpected += estToolUse(p)
        if (p.type === "tool_result" && p.tool_use_id === "tu_b") tuBExpected += estToolResult(p)
      }
    }
    // Single-attribution: tu_a's estimate is in dedup ONLY (NOT purge).
    assert.equal(
      plan.byStrategyTokens.dedup, tuAExpected,
      `dedup bucket must contain tu_a's estimate (single-attribution, got ${plan.byStrategyTokens.dedup}, expected ${tuAExpected})`,
    )
    assert.equal(
      plan.byStrategyTokens.purge, tuBExpected,
      `purge bucket must contain ONLY tu_b's estimate (tu_a was already attributed to dedup — single-attribution); got ${plan.byStrategyTokens.purge}, expected ${tuBExpected}`,
    )
  })
})