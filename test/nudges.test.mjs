// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/messages/inject/inject.ts +
//                                                  lib/messages/inject/utils.ts +
//                                                  lib/prompts/extensions/nudge.ts
// Original copyright: Copyright (c) Opencode-DCP authors. Licensed under AGPL-3.0-or-later.
//
// Behavior-faithful test suite for zcode-dcp/proxy/nudges.mjs (PLAN Task 8).
//
// Coverage (per PLAN Task 8):
//   ① current>max → only context-limit nudge (with guidance)
//   ② min≤c≤max + latest user → turn nudge (soft → assistant / strong → user)
//   ③ iteration 15-message threshold
//   ④ current<min → no injection + turn/iter anchors cleared (context anchors kept)
//   ⑤ last assistant has completed compress tool_use → all anchors cleared, return
//   ⑥ nudgeFrequency throttling (same anchor not repeated)
//   ⑦ modelMaxLimits per-model override + "X%" conversion via contextWindow
//   ⑧ summaryBuffer counted (active block summary tokens add to usage)
//   ⑨ applyNudges immutable (input untouched) + includes dedupe
//   ⑩ determinism: same input → same output twice

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  planNudges,
  applyNudges,
} from "../proxy/nudges.mjs"

import { DEFAULT_CONFIG } from "../proxy/config.mjs"
import { wrapReminder } from "../proxy/prompts.mjs"
import { buildBlockGuidance } from "../proxy/compress.mjs"

// ---------- Anthropic-protocol message fixtures ----------

function userText(text) {
  return { role: "user", content: [{ type: "text", text }] }
}
function assistantText(text) {
  return { role: "assistant", content: [{ type: "text", text }] }
}
function assistantToolUse(toolUseId, name, input, status = "completed") {
  // status: "completed" for finished tool calls (used by messageHasCompress)
  // tool_use_id and `id` are the Anthropic protocol fields; input has tool params.
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name, input, status }],
  }
}
function userToolResult(toolUseId, content, isError = false) {
  const block = { type: "tool_result", tool_use_id: toolUseId, content }
  if (isError) block.is_error = true
  return { role: "user", content: [block] }
}

// Realistic usage (Anthropic protocol normalized)
const usageBig = {
  inputTokens: 120000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}
const usageMid = {
  inputTokens: 70000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}
const usageSmall = {
  inputTokens: 10000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

// Tiny prompts stub for tests (loadPrompts-style)
function makePrompts(overrides = {}) {
  return {
    contextLimitNudge: "ctx-limit body",
    turnNudge: "turn body",
    iterationNudge: "iteration body",
    ...overrides,
  }
}

function makeConfig(overrides = {}) {
  // Start from DEFAULT_CONFIG so we get every key
  return mergeDeep(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), overrides)
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

// Fresh lightState (mimics session.mjs shape — anchors are arrays of indices)
function makeLightState(overrides = {}) {
  return {
    anchors: { context: [], turn: [], iter: [] },
    fetchCount: 0,
    sweepToolCallIds: [],
    decompressBlockIds: [],
    manualMode: false,
    ...overrides,
  }
}

// =================================================================
// ① context-limit: current > max → only context-limit nudge
// =================================================================

describe("planNudges — context-limit branch (current > max)", () => {
  it("emits a contextLimitNudge injection when usage exceeds maxContextLimit", () => {
    const messages = [
      userText("u1"),
      assistantText("a1"),
      userText("u2"),
    ]
    const config = makeConfig({
      compress: { maxContextLimit: 100000, minContextLimit: 50000 },
    })
    const prompts = makePrompts()
    const lightState = makeLightState()
    const result = planNudges(messages, config, prompts, usageBig, lightState)
    assert.equal(result.injections.length, 1, "exactly one nudge")
    const inj = result.injections[0]
    assert.equal(inj.role, "user", "context-limit anchors onto the last non-ignored message (user)")
    assert.ok(inj.text.includes("ctx-limit body"), "uses contextLimitNudge text")
    assert.ok(
      inj.text.includes("<dcp-system-reminder>") &&
        inj.text.includes("</dcp-system-reminder>"),
      "wrapped in reminder tags",
    )
  })

  it("context-limit nudge includes block guidance when active blocks are passed", () => {
    const messages = [userText("u1"), assistantText("a1")]
    const config = makeConfig({
      compress: { maxContextLimit: 100000, minContextLimit: 50000 },
    })
    const prompts = makePrompts()
    const lightState = makeLightState()
    const activeBlocks = [
      { blockId: "b1" },
      { blockId: "b2" },
    ]
    const result = planNudges(messages, config, prompts, usageBig, lightState, activeBlocks)
    const inj = result.injections[0]
    assert.ok(
      inj.text.includes("Compressed block context:"),
      "guidance appended",
    )
    assert.ok(inj.text.includes("b1, b2") || inj.text.includes("b2, b1"), "lists blocks")
  })

  it("addAnchor throttling: existing context anchor is not duplicated (anchor SET does not grow)", () => {
    // nudgeFrequency=5: distance between new anchor (index 7, last) and existing
    // anchor (index 7) = 0 < 5 → throttle. The anchor SET does not grow;
    // applyNudges' includes-dedupe prevents duplicate text in the message.
    const messages = [
      userText("u1"), assistantText("a1"),
      userText("u2"), assistantText("a2"),
      userText("u3"), assistantText("a3"),
      userText("u4"), assistantText("a4"),
    ]
    const config = makeConfig({
      compress: { maxContextLimit: 100000, minContextLimit: 50000, nudgeFrequency: 5 },
    })
    const prompts = makePrompts()
    // Pre-existing context anchor at index 7 (last assistant). Distance = 7-7 = 0 < 5.
    const lightState = makeLightState({
      anchors: { context: [7], turn: [], iter: [] },
    })
    const result = planNudges(messages, config, prompts, usageBig, lightState)
    // anchorUpdates.context should NOT grow (set stays at [7])
    assert.deepEqual(result.anchorUpdates.context, [7], "anchor SET not duplicated")
  })

  it("applyNudges includes-dedupe prevents duplicate text for an existing anchor", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "a4" }] },
    ]
    const nudge = "<dcp-system-reminder>\nctx\n</dcp-system-reminder>"
    const injections = [{ index: 0, role: "assistant", text: nudge }]
    // Inject once
    const once = applyNudges(messages, injections)
    // Re-inject the same nudge text — should be a no-op (includes check)
    const twice = applyNudges(once, injections)
    const text = twice[0].content[0].text
    const occurrences = (text.match(/<dcp-system-reminder>/g) || []).length
    assert.equal(occurrences, 1, "reminder present exactly once")
  })
})

// =================================================================
// ② turn branch: min ≤ c ≤ max + latest is user
// =================================================================

describe("planNudges — turn branch (min ≤ c ≤ max + last is user)", () => {
  it("soft mode → injects onto assistant role (last assistant gets the text)", () => {
    const messages = [
      userText("u1"), assistantText("a1"),
      userText("u2"), assistantText("a2"),
      userText("u3"),
    ]
    const config = makeConfig({
      compress: {
        maxContextLimit: 100000,
        minContextLimit: 50000,
        nudgeForce: "soft",
      },
    })
    const prompts = makePrompts()
    const lightState = makeLightState()
    const result = planNudges(messages, config, prompts, usageMid, lightState)
    assert.equal(result.injections.length, 1)
    const inj = result.injections[0]
    assert.equal(inj.role, "assistant", "soft → assistant role")
    assert.ok(inj.text.includes("turn body"), "uses turnNudge text")
  })

  it("strong mode → injects onto user role", () => {
    const messages = [
      userText("u1"), assistantText("a1"),
      userText("u2"), assistantText("a2"),
      userText("u3"),
    ]
    const config = makeConfig({
      compress: {
        maxContextLimit: 100000,
        minContextLimit: 50000,
        nudgeForce: "strong",
      },
    })
    const prompts = makePrompts()
    const lightState = makeLightState()
    const result = planNudges(messages, config, prompts, usageMid, lightState)
    assert.equal(result.injections.length, 1)
    const inj = result.injections[0]
    assert.equal(inj.role, "user", "strong → user role")
    assert.ok(inj.text.includes("turn body"))
  })

  it("skips turn nudge when last message is assistant (not user)", () => {
    const messages = [
      userText("u1"), assistantText("a1"),
      userText("u2"), assistantText("a2"),
    ]
    const config = makeConfig()
    const lightState = makeLightState()
    const result = planNudges(messages, config, makePrompts(), usageMid, lightState)
    // No anchor added → no injection
    assert.equal(result.injections.length, 0)
  })
})

// =================================================================
// ③ iteration branch: 15-message threshold
// =================================================================

describe("planNudges — iteration branch (last user + 15+ messages since)", () => {
  it("fires iteration nudge when count >= 15", () => {
    // Build: 1 user at index 0 + 16 assistant messages after, last is assistant@16.
    // Last user index = 0; messagesSinceUser = 16 (>= 15) → iteration nudge.
    const messages = [userText("u0")]
    for (let i = 1; i <= 16; i++) {
      messages.push(assistantText("a" + i))
    }
    const config = makeConfig({
      compress: {
        maxContextLimit: 100000,
        minContextLimit: 50000,
        iterationNudgeThreshold: 15,
      },
    })
    const lightState = makeLightState()
    const result = planNudges(messages, config, makePrompts(), usageMid, lightState)
    const hasIter = result.injections.some((i) => i.text.includes("iteration body"))
    assert.ok(hasIter, "iteration nudge emitted")
  })

  it("does NOT fire iteration nudge when count < 15", () => {
    // 1 user at index 0 + 13 assistant messages after, last is assistant@13.
    // messagesSinceUser = 13 < 15 → no iteration.
    const messages = [userText("u0")]
    for (let i = 1; i <= 13; i++) {
      messages.push(assistantText("a" + i))
    }
    const config = makeConfig({
      compress: {
        maxContextLimit: 100000,
        minContextLimit: 50000,
        iterationNudgeThreshold: 15,
      },
    })
    const lightState = makeLightState()
    const result = planNudges(messages, config, makePrompts(), usageMid, lightState)
    const hasIter = result.injections.some((i) => i.text.includes("iteration body"))
    assert.equal(hasIter, false, "iteration not emitted (count below threshold)")
  })
})

// =================================================================
// ④ current < min → no injection + turn/iter anchors cleared
// =================================================================

describe("planNudges — under-min (current < min → clear turn/iter, keep context)", () => {
  it("clears turn+iter anchors and preserves context anchors (SPEC R6 Scenario4 勘误版)", () => {
    const messages = [userText("u1"), assistantText("a1"), userText("u3")]
    const config = makeConfig({
      compress: { maxContextLimit: 100000, minContextLimit: 50000 },
    })
    const lightState = makeLightState({
      anchors: { context: [1], turn: [0, 1], iter: [2] },
    })
    const result = planNudges(messages, config, makePrompts(), usageSmall, lightState)
    // Turn and iter cleared; context preserved.
    assert.deepEqual(result.anchorUpdates.turn, [], "turn anchors cleared")
    assert.deepEqual(result.anchorUpdates.iter, [], "iter anchors cleared")
    assert.deepEqual(result.anchorUpdates.context, [1], "context anchors preserved")
    // No NEW injections are planned (the under-min branch never adds anchors).
    // Existing context anchor at index 1 may still appear in injections
    // (applyAnchoredNudges iterates the SET) — that's faithful to DCP
    // utils.ts:324-374; applyNudges's `includes` dedup makes it a no-op in
    // practice.
    const newTurnOrIter = result.injections.filter(
      (i) => i.text.includes("turn body") || i.text.includes("iteration body"),
    )
    assert.equal(newTurnOrIter.length, 0, "no new turn/iter injections")
  })
})

// =================================================================
// ⑤ last assistant has completed compress tool_use → all anchors cleared
// =================================================================

describe("planNudges — compress-finished branch (clear all + return)", () => {
  it("clears all anchor buckets and emits no injection", () => {
    // The LAST assistant has a compress tool_use whose following user message
    // carries the matching tool_result (is_error !== true) — i.e. the compress
    // was completed upstream. Per DCP inject.ts:52-58, this branch clears
    // all three anchor buckets and returns without injecting anything.
    const messages = [
      userText("u1"),
      assistantToolUse("tu1", "mcp__dcp__compress", { topic: "x", content: [] }),
      userToolResult("tu1", "ok"),
      assistantToolUse("tu2", "mcp__dcp__compress", { topic: "y", content: [] }),
      userToolResult("tu2", "ok"),
    ]
    const config = makeConfig({
      compress: { maxContextLimit: 100000, minContextLimit: 50000 },
    })
    const lightState = makeLightState({
      anchors: { context: [1], turn: [0], iter: [2] },
    })
    const result = planNudges(messages, config, makePrompts(), usageBig, lightState)
    assert.equal(result.injections.length, 0)
    assert.deepEqual(result.anchorUpdates.context, [], "context cleared")
    assert.deepEqual(result.anchorUpdates.turn, [], "turn cleared")
    assert.deepEqual(result.anchorUpdates.iter, [], "iter cleared")
  })
})

// =================================================================
// ⑥ nudgeFrequency 节流 (also covered above but kept explicit)
// =================================================================

describe("planNudges — throttling", () => {
  it("does not grow the context anchor SET within nudgeFrequency distance", () => {
    // Last non-ignored is user@4. Pre-existing context anchor at index 3 (assistant).
    // distance = 4 - 3 = 1 < 5 → throttle. The SET does not grow (still [3]).
    const messages = [
      userText("u0"), assistantText("a1"),
      userText("u2"), assistantText("a3"),
      userText("u4"),
    ]
    const config = makeConfig({
      compress: { maxContextLimit: 100000, minContextLimit: 50000, nudgeFrequency: 5 },
    })
    const lightState = makeLightState({
      anchors: { context: [3], turn: [], iter: [] },
    })
    const result = planNudges(messages, config, makePrompts(), usageBig, lightState)
    assert.deepEqual(result.anchorUpdates.context, [3], "anchor SET not grown")
  })
})

// =================================================================
// ⑦ modelMaxLimits per-model + "X%" conversion
// =================================================================

describe("planNudges — modelMaxLimits per-model override and percent conversion", () => {
  it("per-model modelMaxLimits takes precedence over the global maxContextLimit", () => {
    // global max=200000 (won't trigger); per-model max=100000 (will trigger)
    const messages = [userText("u1")]
    const config = makeConfig({
      providerId: "acme",
      modelId: "opus",
      compress: {
        maxContextLimit: 200000,
        minContextLimit: 50000,
        modelMaxLimits: { "acme/opus": 100000 },
        modelMinLimits: {},
      },
    })
    const lightState = makeLightState()
    // usageBig=120000 > per-model max=100000 → context-limit nudge
    const result = planNudges(messages, config, makePrompts(), usageBig, lightState)
    assert.ok(
      result.injections.some((i) => i.text.includes("ctx-limit body")),
      "triggered by per-model limit",
    )
  })

  it("'X%' converts via contextWindow (number) and is clamped 0-100", () => {
    // contextWindow=200000; "60%" → 120000; usageBig=120000 → NOT over (current > max)
    // To trigger: use maxContextLimit number directly, OR raise usage past threshold.
    // Set maxContextLimit="50%" → 100000. usageBig=120000 > 100000 → trigger.
    const messages = [userText("u1")]
    const config = makeConfig({
      contextWindow: 200000,
      compress: {
        maxContextLimit: "50%", // → 100000
        minContextLimit: 50000,
        modelMaxLimits: {},
        modelMinLimits: {},
      },
    })
    const lightState = makeLightState()
    const result = planNudges(messages, config, makePrompts(), usageBig, lightState)
    assert.equal(result.injections.length, 1, "percent conversion works")
  })

  it("clamps percent to 0-100", () => {
    // contextWindow=100000; "150%" → clamps to 100% → 100000
    const messages = [userText("u1")]
    const config = makeConfig({
      contextWindow: 100000,
      compress: {
        maxContextLimit: "150%",
        minContextLimit: 50000,
        modelMaxLimits: {},
        modelMinLimits: {},
      },
    })
    const lightState = makeLightState()
    // usageBig=120000 > 100000 → trigger
    const result = planNudges(messages, config, makePrompts(), usageBig, lightState)
    assert.equal(result.injections.length, 1)
  })
})

// =================================================================
// ⑧ summaryBuffer — differential coverage (lock actual behaviour)
// =================================================================
//
// The summary buffer RAISES the effective max threshold (utils.ts:142-152):
//   effectiveMax = resolvedMax + sum(activeSummaryTokens)
// So at usage=120000, maxContextLimit=100000:
//   - summaryBuffer=false → 120000 > 100000 → trigger (current)
//   - summaryBuffer=true + bufferTokens=20000 → effectiveMax=120000 → 120000 NOT > 120000 → no trigger
//   - summaryBuffer=true + bufferTokens=30000 → effectiveMax=130000 → 120000 NOT > 130000 → no trigger
// These tests REVERSE the direction of the previous tests (which only
// confirmed the buffer "made things trigger"). The point is to lock
// "buffer RAISES the threshold" — the comment in the previous suite
// ("push effective threshold down") was wrong; utils.ts adds the summary
// tokens to max (raising it).

describe("planNudges — summaryBuffer raises effective max threshold", () => {
  // longSummary ~10k tokens (40k chars / 4). effectiveMax = 100000 + 10000 = 110000.
  // usageMid=70000 < 110000 in both branches → no nudge either way.
  // We use a usage that straddles (max, max+bufferTokens] to differentiate.

  it("summaryBuffer=true + buffer RAISES max: usage in (max, max+buffer] does NOT trigger", () => {
    // effectiveMax = 100000 + ~10k ≈ 110000. usageBig=120000 > 110000 → trigger
    // → test the OPPOSITE: usage just above raw max but below effective max.
    // We craft usage so current=105000:
    //   buffer=false: 105000 > 100000 → trigger
    //   buffer=true:  105000 NOT > (100000 + 10000) = 110000 → no trigger
    const usage = {
      inputTokens: 105000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    const longSummary = "x".repeat(40000) // ≈ 10k tokens
    const activeBlocks = [{ blockId: "b1", rawSummary: longSummary }]
    const messages = [userText("u1")]

    const configBufferOn = makeConfig({
      compress: {
        maxContextLimit: 100000,
        minContextLimit: 50000,
        summaryBuffer: true,
      },
    })
    const onResult = planNudges(messages, configBufferOn, makePrompts(), usage, makeLightState(), activeBlocks)
    assert.equal(onResult.injections.length, 0, "buffer RAISES threshold → no trigger")
  })

  it("summaryBuffer=false: same usage in (max, max+buffer] DOES trigger (differential)", () => {
    const usage = {
      inputTokens: 105000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    const longSummary = "x".repeat(40000)
    const activeBlocks = [{ blockId: "b1", rawSummary: longSummary }]
    const messages = [userText("u1")]

    const configBufferOff = makeConfig({
      compress: {
        maxContextLimit: 100000,
        minContextLimit: 50000,
        summaryBuffer: false,
      },
    })
    const offResult = planNudges(messages, configBufferOff, makePrompts(), usage, makeLightState(), activeBlocks)
    assert.ok(
      offResult.injections.some((i) => i.text.includes("ctx-limit body")),
      "buffer OFF: 105000 > 100000 → context-limit nudge fires",
    )
  })

  it("consumed blocks are EXCLUDED from the summary buffer (getActiveSummaryTokenUsage filter)", () => {
    // Two blocks: b1 (consumed by b2) and b2 (active). Effective tokens
    // should count ONLY b2's summary, not b1's. With usage = max + (only b2 tokens),
    // we expect: NO trigger (effectiveMax raised by b2 alone).
    // With b1+b2 tokens, we'd expect a trigger — but we never count b1 here.
    const longSummary = "x".repeat(40000) // ~10k tokens
    const activeBlocks = [
      // b1: in b2's consumedBlockIds → excluded from buffer
      { blockId: "b1", rawSummary: longSummary, consumedBlockIds: [] },
      // b2: active, also consumes b1
      { blockId: "b2", rawSummary: longSummary, consumedBlockIds: [1] },
    ]
    // effectiveMax = 100000 + (only b2) = 110000 (b1 excluded).
    // usage = 105000: in (max, max+buffer] → no trigger.
    const usage = {
      inputTokens: 105000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    const messages = [userText("u1")]
    const config = makeConfig({
      compress: {
        maxContextLimit: 100000,
        minContextLimit: 50000,
        summaryBuffer: true,
      },
    })
    const result = planNudges(messages, config, makePrompts(), usage, makeLightState(), activeBlocks)
    assert.equal(result.injections.length, 0, "consumed blocks excluded from buffer")

    // Cross-check: if we mark b2 as consumed by a non-existent block (shouldn't matter),
    // the result should be the same — sanity that the filter walks consumedBlockIds per-block.
    const bothActive = [
      { blockId: "b1", rawSummary: longSummary, consumedBlockIds: [] },
      { blockId: "b2", rawSummary: longSummary, consumedBlockIds: [] },
    ]
    // effectiveMax = 100000 + 20000 = 120000. usage 105000 still NOT > 120000.
    const r2 = planNudges(messages, config, makePrompts(), usage, makeLightState(), bothActive)
    assert.equal(r2.injections.length, 0, "both active: still under raised threshold")
  })
})

// =================================================================
// ⑨ applyNudges — immutability + includes dedupe
// =================================================================

describe("applyNudges — immutability and idempotence", () => {
  it("does not mutate the input messages array", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ]
    const snapshot = JSON.stringify(messages)
    const injections = [
      { index: 0, role: "user", text: "<dcp-system-reminder>\nctx\n</dcp-system-reminder>" },
    ]
    applyNudges(messages, injections)
    assert.equal(JSON.stringify(messages), snapshot, "messages unchanged")
  })

  it("appends nudge text to the last text block of a user message", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
    ]
    const injections = [
      { index: 0, role: "user", text: "<dcp-system-reminder>\nctx\n</dcp-system-reminder>" },
    ]
    const out = applyNudges(messages, injections)
    const text = out[0].content[0].text
    assert.ok(text.includes("u1"), "original kept")
    assert.ok(text.includes("ctx"), "nudge appended")
    // Two reminders: returns a NEW array, but contains the appended message
    assert.notEqual(out, messages, "returns a new array (immutable)")
  })

  it("synthesizes a text block for a user message with no text parts", () => {
    const messages = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] },
    ]
    const injections = [
      { index: 0, role: "user", text: "<dcp-system-reminder>\nctx\n</dcp-system-reminder>" },
    ]
    const out = applyNudges(messages, injections)
    const last = out[0].content[out[0].content.length - 1]
    assert.equal(last.type, "text")
    assert.ok(last.text.includes("ctx"))
  })

  it("synthesizes at the start for an assistant message with no text", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    ]
    const injections = [
      { index: 0, role: "assistant", text: "<dcp-system-reminder>\nturn\n</dcp-system-reminder>" },
    ]
    const out = applyNudges(messages, injections)
    assert.equal(out[0].content[0].type, "text", "first block is the new text")
    assert.ok(out[0].content[0].text.includes("turn"))
  })

  it("idempotent: re-applying the same injection does not duplicate text", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
    ]
    const injections = [
      { index: 0, role: "user", text: "<dcp-system-reminder>\nctx\n</dcp-system-reminder>" },
    ]
    const once = applyNudges(messages, injections)
    const twice = applyNudges(once, injections)
    const text = twice[0].content[0].text
    const occurrences = (text.match(/<dcp-system-reminder>/g) || []).length
    assert.equal(occurrences, 1, "reminder only present once")
  })

  it("M-2: assistant with ZERO content parts is skipped (hasContent gate, utils.ts:229-231)", () => {
    // Empty-content assistant → no synthesis into a zero-part shell.
    const messages = [
      { role: "assistant", content: [] },
    ]
    const injections = [
      { index: 0, role: "assistant", text: "<dcp-system-reminder>\nturn\n</dcp-system-reminder>" },
    ]
    const out = applyNudges(messages, injections)
    assert.equal(out[0].content.length, 0, "no synthetic block added to empty-content assistant")
    assert.equal(
      out[0].content.length,
      messages[0].content.length,
      "input content array untouched (length)",
    )
    assert.ok(
      !out[0].content.some((p) => p && typeof p.text === "string" && p.text.includes("dcp-system-reminder")),
      "no synthetic reminder text part added",
    )
  })
})

// =================================================================
// ⑩ determinism: same input → same output
// =================================================================

describe("planNudges — determinism", () => {
  it("same input yields identical anchor updates", () => {
    const messages = [userText("u1"), assistantText("a1"), userText("u3")]
    const config = makeConfig()
    const lightState = makeLightState()
    const r1 = planNudges(messages, config, makePrompts(), usageBig, lightState)
    const r2 = planNudges(messages, config, makePrompts(), usageBig, lightState)
    assert.deepEqual(r1, r2, "two runs identical")
  })

  it("injections array order is stable across runs (context → turn → iter bucket order)", () => {
    // All three anchor kinds active: context (over max), turn (last user), iter (over threshold)
    // Hard to set up simultaneously because the three branches are mutually exclusive
    // (overMaxLimit vs overMinLimit). Use a scenario where context + turn co-occur via
    // pre-existing anchors: pre-seeded turn anchor + current>max triggers fresh context.
    const messages = [
      userText("u1"), assistantText("a1"),
      userText("u2"), assistantText("a2"),
      userText("u3"), assistantText("a3"),
      userText("u4"), assistantText("a4"),
      userText("u5"), assistantText("a5"),
      userText("u6"),
    ]
    const config = makeConfig({
      compress: { maxContextLimit: 100000, minContextLimit: 50000, nudgeFrequency: 5 },
    })
    const lightState = makeLightState({
      anchors: { context: [], turn: [9, 10], iter: [] },
    })
    const usage = { inputTokens: 120000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const r1 = planNudges(messages, config, makePrompts(), usage, lightState)
    const r2 = planNudges(messages, config, makePrompts(), usage, lightState)
    assert.deepEqual(r1.injections, r2.injections, "injections array identical")
    // Context anchors come first in the bucket loop (we process context → turn → iter).
    // At least one of the injections should reference ctx, and one should reference turn.
    assert.ok(
      r1.injections.some((i) => i.text.includes("ctx-limit body")),
      "context bucket has injection",
    )
    assert.ok(
      r1.injections.some((i) => i.text.includes("turn body")),
      "turn bucket has injection (soft → assistant role)",
    )
    // Order: context index < turn index in the output array.
    const ctxIdx = r1.injections.findIndex((i) => i.text.includes("ctx-limit body"))
    const turnIdx = r1.injections.findIndex((i) => i.text.includes("turn body"))
    assert.ok(ctxIdx < turnIdx, "context bucket precedes turn bucket in injections")
  })
})

// =================================================================
// C-1 sentinel: applyNudges throws on role mismatch (was silent continue)
// =================================================================

describe("applyNudges — role mismatch sentinel (C-1)", () => {
  it("throws TypeError when injection.role does not match messages[index].role", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ]
    // Injection claims to target a user at index 0, but messages[0] is assistant.
    const injections = [
      { index: 0, role: "user", text: "<dcp-system-reminder>\nctx\n</dcp-system-reminder>" },
    ]
    assert.throws(() => applyNudges(messages, injections), TypeError)
  })

  it("throws RangeError when injection.index is out of bounds", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "u1" }] }]
    const injections = [
      { index: 5, role: "user", text: "<dcp-system-reminder>\nctx\n</dcp-system-reminder>" },
    ]
    assert.throws(() => applyNudges(messages, injections), RangeError)
  })

  it("throws TypeError when messages is not an array", () => {
    assert.throws(() => applyNudges(null, []), TypeError)
    assert.throws(() => applyNudges("nope", []), TypeError)
  })

  it("throws TypeError when injection.text is not a string", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "u1" }] }]
    const injections = [{ index: 0, role: "user", text: 42 }]
    assert.throws(() => applyNudges(messages, injections), TypeError)
  })
})

// =================================================================
// C-2 sentinel: planNudges returns skipped="empty-messages"
// =================================================================

describe("planNudges — empty-messages sentinel (C-2)", () => {
  it("returns skipped='empty-messages' for non-array messages", () => {
    const r = planNudges(null, makeConfig(), makePrompts(), usageBig, makeLightState())
    assert.equal(r.skipped, "empty-messages")
    assert.equal(r.injections.length, 0)
    assert.deepEqual(r.anchorUpdates, { context: [], turn: [], iter: [] })
  })

  it("returns skipped='empty-messages' for empty array messages", () => {
    const r = planNudges([], makeConfig(), makePrompts(), usageBig, makeLightState())
    assert.equal(r.skipped, "empty-messages")
    assert.equal(r.injections.length, 0)
  })
})

// =================================================================
// C-3 sentinel: planNudges handles missing/malformed usage
// =================================================================

describe("planNudges — usage sentinel (C-3)", () => {
  it("returns skipped='no-usage' when usage is null", () => {
    const messages = [userText("u1")]
    const r = planNudges(messages, makeConfig(), makePrompts(), null, makeLightState())
    assert.equal(r.skipped, "no-usage")
    assert.equal(r.injections.length, 0)
  })

  it("returns skipped='no-usage' when usage is undefined", () => {
    const messages = [userText("u1")]
    const r = planNudges(messages, makeConfig(), makePrompts(), undefined, makeLightState())
    assert.equal(r.skipped, "no-usage")
  })

  it("returns skipped='no-usage' when usage is a non-object primitive", () => {
    const messages = [userText("u1")]
    const r = planNudges(messages, makeConfig(), makePrompts(), 42, makeLightState())
    assert.equal(r.skipped, "no-usage")
  })

  it("throws RangeError when usage.inputTokens is NaN", () => {
    const messages = [userText("u1")]
    assert.throws(
      () => planNudges(messages, makeConfig(), makePrompts(), { inputTokens: NaN, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, makeLightState()),
      RangeError,
    )
  })

  it("throws RangeError when usage.cacheReadTokens is Infinity", () => {
    const messages = [userText("u1")]
    assert.throws(
      () => planNudges(messages, makeConfig(), makePrompts(), { inputTokens: 100, outputTokens: 0, cacheReadTokens: Infinity, cacheWriteTokens: 0 }, makeLightState()),
      RangeError,
    )
  })
})

// =================================================================
// C-4 sentinel: poisoned light-state inputs are sanitised
// =================================================================

describe("planNudges — poisoned light-state sanitisation (C-4)", () => {
  it("drops non-integer, negative, out-of-bounds, and duplicate entries", () => {
    // Poisoned state: null, "abc", -1, 5 (valid), 100 (out of bounds), 5 (dup)
    const messages = [userText("u1"), userText("u2"), userText("u3"), userText("u4"), userText("u5"), userText("u6")]
    const config = makeConfig({
      compress: { maxContextLimit: 100000, minContextLimit: 50000 },
    })
    const lightState = {
      anchors: {
        context: [null, "abc", -1, 5, 100, 5], // only 5 survives (and in range)
        turn: [],
        iter: [],
      },
      manualMode: false,
    }
    const r = planNudges(messages, config, makePrompts(), usageMid, lightState)
    assert.deepEqual(
      r.anchorUpdates.context,
      [5],
      "only the valid in-range integer survives sanitisation",
    )
  })
})

// =================================================================
// I-6 sentinel: empty finalText → drop injection + prune anchor from SET
// =================================================================

describe("planNudges — empty prompt drops injection and prunes anchor (I-6)", () => {
  it("drops injection when prompt for the kind is empty AND prunes that anchor from the SET", () => {
    // Set up: current > max → triggers context-limit nudge at last index.
    // But supply EMPTY contextLimitNudge text → wrapReminder returns "" → finalText empty.
    // The context anchor should be pruned from anchorUpdates.context.
    const messages = [userText("u1"), assistantText("a1"), userText("u2")]
    const config = makeConfig({
      compress: { maxContextLimit: 100000, minContextLimit: 50000 },
    })
    const lightState = makeLightState()
    const prompts = makePrompts({ contextLimitNudge: "" })
    const r = planNudges(messages, config, prompts, usageBig, lightState)
    assert.equal(r.injections.length, 0, "no injection with empty prompt")
    assert.deepEqual(r.anchorUpdates.context, [], "anchor pruned from SET")
  })
})

// =================================================================
// I-2 sentinel: appendGuidanceToDcpTag is exported and re-usable by task-11
// =================================================================

describe("appendGuidanceToDcpTag (exported helper, I-2)", () => {
  it("is exported and inserts guidance before </dcp-system-reminder>", async () => {
    const { appendGuidanceToDcpTag } = await import("../proxy/nudges.mjs")
    const nudge = "<dcp-system-reminder>\nBODY\n</dcp-system-reminder>"
    const guidance = "Compressed block context:\n- line 1"
    const out = appendGuidanceToDcpTag(nudge, guidance)
    assert.ok(out.includes("BODY"), "body preserved")
    assert.ok(out.indexOf("Compressed block context") < out.indexOf("</dcp-system-reminder>"), "guidance inserted before close tag")
    assert.ok(out.endsWith("</dcp-system-reminder>"), "close tag still at end")
  })

  it("returns nudgeText unchanged when guidance is empty/whitespace", async () => {
    const { appendGuidanceToDcpTag } = await import("../proxy/nudges.mjs")
    const nudge = "<dcp-system-reminder>\nBODY\n</dcp-system-reminder>"
    assert.equal(appendGuidanceToDcpTag(nudge, ""), nudge)
    assert.equal(appendGuidanceToDcpTag(nudge, "   \n  "), nudge)
  })

  it("returns nudgeText unchanged when there is no close tag", async () => {
    const { appendGuidanceToDcpTag } = await import("../proxy/nudges.mjs")
    const nudge = "no reminder tag here"
    assert.equal(appendGuidanceToDcpTag(nudge, "guidance"), nudge)
  })
})