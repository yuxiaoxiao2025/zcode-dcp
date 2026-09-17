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
    // TodoWrite is in DEFAULT_PROTECTED_TOOLS — but config.strategies.deduplication.protectedTools
    // is the dedup-specific list (PLAN: DCP strategies.{strategy}.protectedTools is
    // a separate list from DEFAULT_PROTECTED_TOOLS). Add it explicitly here.
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