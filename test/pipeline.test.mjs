// SPDX-License-Identifier: AGPL-3.0-or-later
// Integration test suite for zcode-dcp/proxy/pipeline.mjs
//
// This is the "glue" test that exercises the full orchestration path of the
// proxy request transform. Each test follows the PLAN.md Task 11 contract:
//   - ① main path: dedup placeholder, range replacement, nudge injection,
//     ID tags, OTHER body fields passed through by reference
//   - ② gate rejection path: body unchanged (Object.is verified)
//   - ③ bad compress range: pipeline continues + error reminder appended
//   - ④ manualMode overlay: dedup still runs, nudges silenced
//   - ⑤ skipped signal: usage=null → metrics.skipped="no-usage"
//   - ⑥ message-mode priority guidance appended to context-limit nudge
//   - ⑦ determinism: two runs on identical input produce identical output
//   - ⑧ full-chain immutability: input body JSON snapshot unchanged

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { transformRequest } from "../proxy/pipeline.mjs"
import { defaultLightState } from "../proxy/session.mjs"
import { PRUNED_TOOL_OUTPUT } from "../proxy/prune.mjs"

// ---------------------------------------------------------------------------
// Fixtures — synthetic Anthropic-protocol request bodies
// ---------------------------------------------------------------------------

// System surface that passes the default main-session whitelist gate
// ("You are ZCode"). Used in every passing-gate scenario.
const MAIN_SYSTEM = [{ type: "text", text: "You are ZCode. Be helpful." }]

// An internal-helper-style system surface (will be rejected by the gate).
const HELPER_SYSTEM = [{ type: "text", text: "You are a title generator. Compress titles." }]

function makeBaseBody(extra = {}) {
  return {
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    thinking: { type: "enabled", budget_tokens: 1024 },
    tools: [
      { name: "Read", description: "read file" },
      { name: "mcp__dcp__compress", description: "compress" },
    ],
    metadata: { user_id: "abc-123" },
    system: MAIN_SYSTEM,
    messages: [],
    ...extra,
  }
}

// 3 identical Read calls (same file_path → dedup) + 1 error tool_use + 1 successful compress tool_use
// that compresses the 3 reads (range mode). Constructed deterministically so
// the test does NOT depend on prior m-prefix assignment — we let the pipeline
// call assignRefs itself.
function makeIntegrationMessages() {
  return [
    { role: "user", content: [{ type: "text", text: "Inspect the auth module." }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "src/auth.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "AAA_AUTH_MODULE_BODY_FIRST_READ" + "X".repeat(800),
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_2", name: "Read", input: { file_path: "src/auth.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_2",
          content: "AAA_AUTH_MODULE_BODY_SECOND_READ" + "Y".repeat(800),
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_3", name: "Read", input: { file_path: "src/auth.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_3",
          content: "AAA_AUTH_MODULE_BODY_THIRD_READ" + "Z".repeat(800),
        },
      ],
    },
    // Some text-only follow-up so the conversation has a real tail.
    {
      role: "assistant",
      content: [{ type: "text", text: "Got the auth module contents." }],
    },
    { role: "user", content: [{ type: "text", text: "Now compress the auth read history." }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_compress_1",
          name: "mcp__dcp__compress",
          input: {
            topic: "auth module intro",
            content: [
              // Compress only the initial user instruction (m0001) so the three
              // Read call pairs SURVIVE for the dedup assertion. This makes the
              // test exercise both transforms independently.
              { startId: "m0001", endId: "m0001", summary: "User asked to inspect the auth module." },
            ],
          },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_compress_1",
          content: "Compression accepted. 1 range(s) will be applied to subsequent context.",
        },
      ],
    },
    // The 4th user turn that creates enough distance for purgeErrors strategy
    // to fire on the error tool_use below (turns=4 → requires ≥4 user messages
    // AFTER the error).
    { role: "user", content: [{ type: "text", text: "do thing 1" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_err_1", name: "Bash", input: { command: "ls /missing" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_err_1",
          is_error: true,
          content: "ENOENT: no such file or directory",
        },
      ],
    },
    // 4 user turns after the error so purgeErrors can prune its input
    { role: "user", content: [{ type: "text", text: "do thing 2" }] },
    { role: "user", content: [{ type: "text", text: "do thing 3" }] },
    { role: "user", content: [{ type: "text", text: "do thing 4" }] },
    { role: "user", content: [{ type: "text", text: "do thing 5 — present request" }] },
  ]
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
      protectedTools: ["Agent", "Task", "Skill", "TodoWrite", "TodoRead"],
      protectTags: false,
      protectUserMessages: false,
    },
    strategies: {
      deduplication: { enabled: true, protectedTools: [] },
      purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
    },
    turnProtection: { enabled: false, turns: 4 },
    protectedFilePatterns: [],
    manualMode: { enabled: false, automaticStrategies: true },
    experimental: { allowSubAgents: false, customPrompts: false },
  }
  return mergeDeep(base, overrides)
}

function mergeDeep(target, src) {
  const out = JSON.parse(JSON.stringify(target))
  for (const key of Object.keys(src || {})) {
    const v = src[key]
    if (v && typeof v === "object" && !Array.isArray(v) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = mergeDeep(out[key], v)
    } else {
      out[key] = v
    }
  }
  return out
}

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

// Usage that is safely BELOW maxContextLimit (no nudge injection expected).
const LOW_USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

// Usage that is ABOVE maxContextLimit → context-limit nudge expected.
const HIGH_USAGE = {
  inputTokens: 120000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("pipeline.transformRequest — integration", () => {
  let tmpDir
  before(() => {
    tmpDir = mkTmpDir("zcode-dcp-pipeline-")
  })
  after(() => {
    rmTmpDir(tmpDir)
  })

  // ============================
  // ① MAIN PATH
  // ============================
  it("① runs the full pipeline: dedup placeholder + range replacement + ID tags + passthrough fields", () => {
    const body = makeBaseBody({ messages: makeIntegrationMessages() })
    const ctx = {
      config: makeConfig(),
      lightState: defaultLightState(),
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const result = transformRequest(body, ctx)

    // Return shape
    assert.ok(result && typeof result === "object")
    assert.ok(result.body, "result.body missing")
    assert.ok(result.metrics, "result.metrics missing")
    assert.ok(result.lightStateUpdates, "result.lightStateUpdates missing")
    assert.ok(Array.isArray(result.body.messages), "messages should be array")

    // Other body fields passed through by reference (D5 — shallow merge)
    assert.ok(Object.is(result.body.model, body.model), "model must be same reference")
    assert.ok(Object.is(result.body.max_tokens, body.max_tokens), "max_tokens same ref")
    assert.ok(Object.is(result.body.thinking, body.thinking), "thinking same ref")
    assert.ok(Object.is(result.body.metadata, body.metadata), "metadata same ref")
    assert.ok(Object.is(result.body.system, body.system), "system same ref")

    // Dedup placeholder: the FIRST two Read tool_results (call_1, call_2) should
    // be replaced with PRUNED_TOOL_OUTPUT (call_3 is the most recent, kept).
    // Note: injectMessageIds appends a `<dcp-message-id>` tag AFTER the
    // placeholder text, so we check `startsWith` rather than exact equality.
    const outMessages = result.body.messages
    const prunedResults = []
    for (const m of outMessages) {
      if (m.role !== "user") continue
      const parts = Array.isArray(m.content) ? m.content : []
      for (const p of parts) {
        if (p && p.type === "tool_result" &&
            typeof p.content === "string" &&
            p.content.startsWith(PRUNED_TOOL_OUTPUT)) {
          prunedResults.push(p.tool_use_id)
        }
      }
    }
    assert.ok(prunedResults.includes("call_1"), "call_1 should be dedup-pruned")
    assert.ok(prunedResults.includes("call_2"), "call_2 should be dedup-pruned")
    assert.ok(!prunedResults.includes("call_3"), "call_3 (most recent) must NOT be pruned")

    // Range replacement: a synthetic [Compressed conversation section] message
    // must replace the 3 read pairs.
    const compressedMsgs = outMessages.filter((m) =>
      Array.isArray(m.content) &&
      m.content.some((p) =>
        p && p.type === "text" && p.text && p.text.includes("[Compressed conversation section]")
      )
    )
    assert.ok(compressedMsgs.length >= 1, "synthetic compressed message expected")

    // ID tags: every user/assistant message should now have a <dcp-message-id>
    // appended (after strip + assignRefs + injectMessageIds).
    for (let i = 0; i < outMessages.length; i++) {
      const m = outMessages[i]
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue
      // The synthetic compressed message we injected is a fresh user text block;
      // it must carry an ID tag too.
      const has = messagesHaveTag(m)
      assert.ok(has, `message at index ${i} (role=${m.role}) is missing dcp-message-id tag`)
    }

    // metrics shape
    assert.equal(typeof result.metrics.savedTokensEst, "number")
    assert.ok(result.metrics.byStrategy && typeof result.metrics.byStrategy === "object")
    assert.equal(typeof result.metrics.byStrategy.dedup, "number")
    assert.equal(typeof result.metrics.byStrategy.purge, "number")
    assert.equal(typeof result.metrics.byStrategy.compress, "number")
    assert.equal(typeof result.metrics.injectedNudges, "number")
    assert.equal(typeof result.metrics.activeBlocks, "number")
    assert.ok(result.metrics.byStrategy.compress > 0, "compress savings should be > 0 after successful compress tool_use")

    // lightStateUpdates — fetchCount incremented by exactly 1 per request
    assert.equal(result.lightStateUpdates.fetchCount, 1)
  })

  // ============================
  // ② GATE REJECTION
  // ============================
  it("② returns body untouched when isMainSession gate fails (helper signature)", () => {
    const body = makeBaseBody({
      system: HELPER_SYSTEM,
      messages: makeIntegrationMessages(),
    })
    const ctx = {
      config: makeConfig(),
      lightState: defaultLightState(),
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const result = transformRequest(body, ctx)

    // Body passed through unchanged (shallow merge with new body that has same fields)
    assert.deepEqual(result.body.messages, body.messages, "messages must be untouched on gate reject")
    // Object.is: messages array is the SAME reference (pipeline never copied)
    assert.ok(Object.is(result.body.messages, body.messages), "messages must be same reference")
    assert.equal(result.metrics.skipped, "gate")
    assert.equal(result.metrics.injectedNudges, 0)
  })

  // ============================
  // ③ BAD COMPRESS RANGE
  // ============================
  it("③ continues pipeline + appends error reminder when compress range fails to resolve", () => {
    // Build a smaller conversation so the failing range is easy to identify.
    const messages = [
      { role: "user", content: [{ type: "text", text: "look at the config" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_x1", name: "Read", input: { file_path: "src/config.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_x1",
            content: "CFG_BODY" + "X".repeat(600),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_bad_compress",
            name: "mcp__dcp__compress",
            input: {
              topic: "config",
              content: [
                // m9999 was never assigned → deriveBlocks throws
                { startId: "m9999", endId: "m9998", summary: "Bogus range" },
              ],
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_bad_compress",
            content: "Compression accepted. 1 range(s) will be applied to subsequent context.",
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "follow up" }] },
    ]
    const body = makeBaseBody({ messages })
    const ctx = {
      config: makeConfig(),
      lightState: defaultLightState(),
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const result = transformRequest(body, ctx)

    // Pipeline did NOT crash — we have a body and metrics
    assert.ok(result.body && Array.isArray(result.body.messages))
    assert.ok(result.metrics, "metrics present")

    // Error message appended (last message is a synthetic user reminder)
    const lastMsg = result.body.messages[result.body.messages.length - 1]
    assert.equal(lastMsg.role, "user", "last message must be the error reminder user msg")
    const reminderText = collectText(lastMsg)
    assert.ok(
      reminderText.includes("compress tool error"),
      `expected error reminder, got: ${reminderText.slice(0, 200)}`
    )
    assert.ok(
      reminderText.includes("</dcp-system-reminder>"),
      "error reminder must be wrapped in dcp-system-reminder tag"
    )

    // Other pruning still ran: dedup would not apply here (only one Read) but
    // no throw should bubble out. The call_x1 tool_result should still be
    // intact (dedup keeps single occurrences).
    const out = result.body.messages
    const allText = out.map((m) => collectText(m)).join("\n")
    assert.ok(allText.includes("CFG_BODY"), "original Read content should be preserved (no dedup hit)")
  })

  // ============================
  // ④ MANUAL MODE OVERLAY
  // ============================
  it("④ manualMode: lightState.manualMode=true silences nudges but dedup still runs (automaticStrategies=true)", () => {
    const body = makeBaseBody({ messages: makeIntegrationMessages() })
    const lightState = defaultLightState()
    lightState.manualMode = true
    const ctx = {
      config: makeConfig(),
      lightState,
      usage: HIGH_USAGE, // would normally trigger context-limit nudge
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const result = transformRequest(body, ctx)

    // Nudges must be 0 (manual mode silences them)
    assert.equal(result.metrics.injectedNudges, 0, "manual mode should silence nudges")
    // Dedup still ran (automaticStrategies defaults to true)
    const prunedCount = countPrunedToolResults(result.body.messages)
    assert.ok(prunedCount >= 2, `dedup should still run; got prunedCount=${prunedCount}`)
  })

  // ============================
  // ⑤ SKIPPED SIGNAL (usage=null)
  // ============================
  it("⑤ records metrics.skipped='no-usage' when usage is null", () => {
    const body = makeBaseBody({ messages: makeIntegrationMessages() })
    const ctx = {
      config: makeConfig(),
      lightState: defaultLightState(),
      usage: null,
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const result = transformRequest(body, ctx)

    assert.equal(result.metrics.skipped, "no-usage")
    assert.equal(result.metrics.injectedNudges, 0)
    // Pipeline still ran other steps (compress + dedup) — byStrategy.compress > 0
    assert.ok(result.metrics.byStrategy.compress > 0)
  })

  // ============================
  // ⑥ MESSAGE-MODE PRIORITY GUIDANCE
  // ============================
  it("⑥ appends DCP-faithful message-mode priority guidance to context-limit nudge when usage > max", () => {
    // Rebuild a conversation that contains enough token-bearing text to bump
    // some messages into the high priority bucket (≥5000 tokens via estimate).
    const bigText = "X".repeat(24000) // ~6000 tokens at default ratio
    const messages = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ]
    const body = makeBaseBody({ messages })
    const ctx = {
      config: makeConfig({ compress: { mode: "message" } }),
      lightState: defaultLightState(),
      usage: HIGH_USAGE, // over max → triggers context-limit nudge
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const result = transformRequest(body, ctx)

    // At least one context-limit nudge was injected
    const nudges = collectAllText(result.body.messages)
    const hasContextLimit = result.body.messages.some((m) => {
      if (!m || !Array.isArray(m.content)) return false
      return m.content.some((p) =>
        p && p.type === "text" && typeof p.text === "string" &&
        p.text.includes("<dcp-system-reminder>") &&
        (p.text.includes("context") || p.text.toLowerCase().includes("limit"))
      )
    })
    assert.ok(hasContextLimit, "context-limit nudge expected in message-mode over-max scenario")

    // DCP-faithful format (nudge.ts:18-26 verbatim):
    //   - 3-line block:
    //       "Message priority context:"
    //       "- Higher-priority older messages consume more context..."
    //       "- High-priority message IDs before this point: mNNNN, mNNNN, ..."
    //   - Refs are mNNNN strings WITHOUT parentheses, comma-separated
    //   - Only refs at index < anchor (listPriorityRefsBeforeIndex)
    const hasPriorityGuidance = result.body.messages.some((m) => {
      if (!m || !Array.isArray(m.content)) return false
      return m.content.some((p) => {
        if (!p || p.type !== "text" || typeof p.text !== "string") return false
        return (
          p.text.includes("Message priority context:") &&
          /High-priority message IDs before this point:\s*m\d{4}/.test(p.text)
        )
      })
    })
    assert.ok(
      hasPriorityGuidance,
      "expected DCP-faithful priority guidance (no parens, comma-separated) appended to context-limit nudge",
    )

    // The exact-bucket assertion: the 2 big assistant messages (m0002, m0004)
    // are HIGH priority and appear before the final user message at index 4
    // (where the context-limit nudge lands). They must be present in the
    // rendered list (and not the low-priority user messages).
    const lastMsg = result.body.messages[result.body.messages.length - 1]
    const lastText = collectText(lastMsg)
    assert.ok(
      /m0002/.test(lastText) && /m0004/.test(lastText),
      "expected m0002 and m0004 (high-priority refs before anchor) in the rendered list",
    )
    // No parentheses — strict no-paren assertion (DCP nudge.ts:18-26 verbatim)
    assert.ok(
      !/\(m\d{4}\)/.test(lastText),
      "guidance must NOT use parentheses around mNNNN refs (DCP verbatim format)",
    )
    // Comma-separated (at least one comma between two refs)
    assert.ok(
      /m\d{4},\s*m\d{4}/.test(lastText),
      "guidance must be comma-separated (DCP nudge.ts:18-19 verbatim)",
    )

    // Light sanity: nudges > 0
    assert.ok(result.metrics.injectedNudges > 0, "at least one nudge expected")
  })

  // ============================
  // ⑦ DETERMINISM
  // ============================
  it("⑦ two runs on identical input produce byte-identical output", () => {
    const body = makeBaseBody({ messages: makeIntegrationMessages() })
    const ctx = {
      config: makeConfig(),
      lightState: defaultLightState(),
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const r1 = transformRequest(body, ctx)
    const r2 = transformRequest(body, ctx)

    // Same body messages content
    assert.equal(
      JSON.stringify(r1.body.messages),
      JSON.stringify(r2.body.messages),
      "determinism: messages JSON should match across two runs"
    )
    // Same metrics
    assert.equal(
      JSON.stringify(r1.metrics),
      JSON.stringify(r2.metrics),
      "determinism: metrics should match across two runs"
    )
  })

  // ============================
  // ⑧ IMMUTABILITY OF INPUT
  // ============================
  it("⑧ input body JSON snapshot is unchanged after transformRequest (no mutation)", () => {
    const messages = makeIntegrationMessages()
    const body = makeBaseBody({ messages })
    const before = JSON.stringify(body)
    const ctx = {
      config: makeConfig(),
      lightState: defaultLightState(),
      usage: HIGH_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const _result = transformRequest(body, ctx)
    const after = JSON.stringify(body)
    assert.equal(before, after, "input body must not be mutated by the pipeline")
  })

  // ============================
  // ⑨ C-1 REGRESSION: tags match content after compress (≥3 covered)
  // ============================
  it("⑨ C-1 regression: after compressing ≥3 messages, every dcp-message-id tag corresponds to its content (off-by-N regression)", () => {
    // Build a 9-message conversation with explicit unique content markers
    // so we can match each tag back to its message. We compress 5 messages
    // (m0002..m0006) — covering the 3 Read pairs. After the splice, the
    // surviving messages occupy new positions; the regression is that the
    // old byIndex (built in step 3) would re-label them with stale refs.
    const marker = (n) => `MSG_MARKER_${n}_UNIQUE_42`
    const messages = [
      { role: "user", content: [{ type: "text", text: marker(1) }] }, // m0001
      { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "Read", input: { file_path: "a.ts" } }] }, // m0002
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: marker(2) }] }, // m0003
      { role: "assistant", content: [{ type: "tool_use", id: "call_b", name: "Read", input: { file_path: "a.ts" } }] }, // m0004
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_b", content: marker(3) }] }, // m0005
      { role: "assistant", content: [{ type: "tool_use", id: "call_c", name: "Read", input: { file_path: "a.ts" } }] }, // m0006
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_c", content: marker(4) }] }, // m0007
      { role: "assistant", content: [{ type: "text", text: marker(5) }] }, // m0008
      { role: "user", content: [{ type: "text", text: marker(6) }] }, // m0009
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_cmp",
          name: "mcp__dcp__compress",
          input: {
            topic: "reads",
            content: [{ startId: "m0002", endId: "m0006", summary: "three Read calls" }],
          },
        }],
      }, // m0010
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_cmp", content: "accepted" }] }, // m0011
    ]
    const body = makeBaseBody({ messages })
    const ctx = {
      config: makeConfig(),
      lightState: defaultLightState(),
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    }
    const result = transformRequest(body, ctx)

    // For each surviving message, the tag appended by injectMessageIds must
    // match the marker text that *currently* lives in that message. If the
    // byIndex map was stale (C-1 bug), some marker would carry the WRONG
    // tag — i.e. m0005's marker would appear with m0007's tag, etc.
    //
    // Note: the synthetic compressed-block message carries BOTH tags —
    // `<dcp-message-id>b1</dcp-message-id>` (block ref from compress.mjs
    // wrapCompressedSummary) AND `<dcp-message-id>mNNNN</dcp-message-id>`
    // (message ref from injectMessageIds). We must match BOTH/all tag
    // occurrences and filter to only the mNNNN (message) namespace.
    const tagPerIndex = []
    for (let i = 0; i < result.body.messages.length; i++) {
      const m = result.body.messages[i]
      const text = collectText(m)
      // Use a GLOBAL regex so multi-tag messages (synthetic compressed block)
      // contribute all their mNNNN tags to the count.
      const tagMatches = [...text.matchAll(/<dcp-message-id[^>]*>([^<]+)<\/dcp-message-id>/g)]
      for (const tm of tagMatches) {
        const tag = tm[1]
        // Only count mNNNN tags (skip bN block refs)
        if (tag && /^m\d+$/.test(tag)) {
          tagPerIndex.push({ idx: i, tag, text: text.slice(0, 80) })
        }
      }
    }

    // The "every tag unique" + "dense sequence" invariants are the strict
    // C-1 regression assertions. With a stale byIndex map, the sequence
    // would have DUPLICATES (multiple mNNNNs reused after the splice)
    // and/or GAPS (some original positions were deleted).
    const tags = tagPerIndex.map((r) => r.tag)
    const uniq = new Set(tags)
    assert.equal(
      uniq.size,
      tags.length,
      "every message-ref tag must be unique (no stale-byIndex duplicates): " + JSON.stringify(tags),
    )

    // Tags should form a dense sequence m0001..mNNNN with no holes.
    for (let i = 0; i < tags.length; i++) {
      const expected = `m${String(i + 1).padStart(4, "0")}`
      assert.equal(
        tags[i],
        expected,
        `tag at output index ${i} should be ${expected}, got ${tags[i]} (all tags: ${JSON.stringify(tags)})`,
      )
    }

    // Specific spot check: the first user message (MSG_MARKER_1) should
    // carry m0001 (it was the first message before compress too, so this
    // is the strongest evidence the splice didn't shift it).
    const firstUser = result.body.messages[0]
    const firstText = collectText(firstUser)
    assert.ok(
      firstText.includes(marker(1)),
      "first surviving message should contain MSG_MARKER_1",
    )
    assert.ok(
      /<dcp-message-id[^>]*>m0001<\/dcp-message-id>/.test(firstText),
      "first surviving message should be tagged m0001 (not m0003 / m0005 — the C-1 bug signature)",
    )

    // Stronger spot check: the LAST message before compress (m0011 user
    // tool_result with content "accepted") must carry m0007 — the message
    // it became after the 5-message splice. If the byIndex was stale, this
    // would carry m0011 instead (the old ref), proving the off-by-N bug.
    const lastMsg = result.body.messages[result.body.messages.length - 1]
    const lastText = collectText(lastMsg)
    assert.ok(
      /<dcp-message-id[^>]*>m0007<\/dcp-message-id>/.test(lastText),
      "last surviving message (post-compress tool_result) must carry m0007 (its NEW position ref), not m0011 (its old position ref)",
    )
  })

  // ============================
  // ⑩ I-2b BLOCKED + priority attribute (message mode + protectUserMessages)
  // ============================
  it("⑩ I-2b: in message mode + protectUserMessages, user messages get BLOCKED tag; high-priority messages get priority attribute", () => {
    // Build messages that include both a high-priority (big) message and a
    // user message. With protectUserMessages=true, the user msg should be
    // BLOCKED. The big assistant should get priority="high" attribute.
    const bigText = "Y".repeat(24000) // ~6000 tokens → high priority
    const messages = [
      { role: "user", content: [{ type: "text", text: "first user" }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] }, // high priority
      { role: "user", content: [{ type: "text", text: "second user — should be BLOCKED" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "now" }] }, // context-limit nudge anchor
    ]
    const body = makeBaseBody({ messages })
    const ctx = {
      config: makeConfig({
        compress: { mode: "message", protectUserMessages: true },
      }),
      lightState: defaultLightState(),
      usage: HIGH_USAGE, // triggers context-limit nudge
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const result = transformRequest(body, ctx)

    // Every user-role message should have a BLOCKED tag at the end of its
    // last text block (the I-2b BLOCKED behavior — DCP inject.ts:165).
    let userCount = 0
    let blockedUserCount = 0
    let highAttrCount = 0
    for (const m of result.body.messages) {
      if (!m || !Array.isArray(m.content)) continue
      const text = collectText(m)
      if (m.role === "user") {
        userCount++
        if (/<dcp-message-id>BLOCKED<\/dcp-message-id>/.test(text)) {
          blockedUserCount++
        }
      }
      if (/<dcp-message-id\s+priority="high">m\d{4}<\/dcp-message-id>/.test(text)) {
        highAttrCount++
      }
    }
    assert.ok(userCount >= 2, `expected at least 2 user messages, got ${userCount}`)
    assert.equal(
      blockedUserCount,
      userCount,
      `all ${userCount} user messages should carry BLOCKED tag (got ${blockedUserCount})`,
    )
    assert.ok(
      highAttrCount >= 1,
      `expected at least one high-priority tag attribute, got ${highAttrCount}`,
    )
  })

  // ============================
  // ⑪ I-2a fidelity: prompt override doesn't break guidance injection
  // ============================
  it("⑪ I-2a fidelity: overriding the context-limit nudge prompt does NOT break priority guidance injection (kind-based identification)", () => {
    // Write an override file for context-limit-nudge in a tmp dir so the
    // prompt loader picks it up. The override text must NOT contain the
    // default CRITICAL WARNING signature — if pipeline.mjs relied on text
    // matching (the old approach), guidance would silently disappear.
    const overrideDir = path.join(tmpDir, ".zcode", "dcp-prompts", "overrides")
    fs.mkdirSync(overrideDir, { recursive: true })
    fs.writeFileSync(
      path.join(overrideDir, "context-limit-nudge.md"),
      "CUSTOM_OVERRIDE_NO_SIGNATURE_AT_ALL\n\nPlease compress before continuing.\n",
      "utf8",
    )

    const bigText = "Z".repeat(24000)
    const messages = [
      { role: "user", content: [{ type: "text", text: "start" }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] }, // high
      { role: "user", content: [{ type: "text", text: "again" }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] }, // high
      { role: "user", content: [{ type: "text", text: "trigger" }] },
    ]
    const body = makeBaseBody({ messages })
    const ctx = {
      config: makeConfig({
        compress: { mode: "message" },
        experimental: { customPrompts: true },
      }),
      lightState: defaultLightState(),
      usage: HIGH_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    const result = transformRequest(body, ctx)

    // The custom override text should appear (proof loadPrompts honoured it)
    const allText = collectAllText(result.body.messages)
    assert.ok(
      allText.includes("CUSTOM_OVERRIDE_NO_SIGNATURE_AT_ALL"),
      "expected the custom override text in the output (proof of override resolution)",
    )

    // CRITICAL: the priority guidance must STILL be appended — kind-based
    // identification (nudges.mjs:563 kind field) is the only path that
    // survives prompt overrides. Text-signature matching would silently
    // fail here.
    const hasPriorityGuidance = result.body.messages.some((m) => {
      if (!m || !Array.isArray(m.content)) return false
      return m.content.some((p) =>
        p && p.type === "text" && typeof p.text === "string" &&
        p.text.includes("Message priority context:") &&
        /High-priority message IDs before this point:\s*m\d{4}/.test(p.text),
      )
    })
    assert.ok(
      hasPriorityGuidance,
      "priority guidance must STILL be appended even when the nudge prompt is overridden (kind-based identification)",
    )
  })

  // ============================
  // ⑫ STRING-CONTENT NORMALIZATION (Anthropic content shorthand)
  // ============================
  // Anthropic /v1/messages accepts EITHER a content array OR a plain string
  // for user/assistant messages ("content":"hi" shorthand, equivalent to
  // [{type:"text", text:"hi"}]). The proxy pipeline's downstream consumers
  // (stripDcpTags / prune walkToolUses / nudges injectIntoMessage / compress
  // walk / injectMessageIds) all assume content is an array — a raw string
  // causes message-ids.mjs:266 `message.content.push(...)` → TypeError and
  // crashes the whole pipeline (8.6 production bug).
  //
  // The pipeline must normalize string content to a single text block at
  // the gate-passed boundary (between gate and stripDcpTags), so every
  // downstream consumer sees the canonical array shape. This is a faithful
  // within-protocol transformation (string ↔ single text block array).
  it("⑫ normalizes string-content user messages to [{type:text,text:...}] and injects ID tag (no crash)", () => {
    // Conversation that uses Anthropic's content shorthand. Two user messages
    // and one assistant message — all use string content. One assistant
    // tool_use call (must survive normalization into block-array form on
    // an array-shape message, so the mix exercises both paths).
    const messages = [
      { role: "user", content: "Hello there." },
      { role: "assistant", content: [{ type: "text", text: "Hi — what would you like to inspect?" }] },
      { role: "user", content: "Please read the README." },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_str_1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_str_1",
            content: "README_BODY" + "Q".repeat(400),
          },
        ],
      },
      { role: "user", content: "thanks" },
    ]
    const body = makeBaseBody({ messages })
    const ctx = {
      config: makeConfig(),
      lightState: defaultLightState(),
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    // Critical assertion 1: pipeline does NOT throw (regression for 8.6 bug).
    let result
    assert.doesNotThrow(
      () => { result = transformRequest(body, ctx) },
      "pipeline must not crash on string-content user messages (8.6 regression)",
    )

    // Critical assertion 2: every output message has array content.
    assert.ok(result && result.body && Array.isArray(result.body.messages))
    for (let i = 0; i < result.body.messages.length; i++) {
      const m = result.body.messages[i]
      assert.ok(
        m && Array.isArray(m.content),
        `message at index ${i} (role=${m && m.role}) must have array content after normalization`,
      )
    }

    // Critical assertion 3: the string-content user messages were converted to
    // a single text block with the original text preserved. We check the
    // ORIGINAL text markers are present (proving the string was carried over,
    // not dropped or duplicated).
    const allText = collectAllText(result.body.messages)
    assert.ok(
      allText.includes("Hello there."),
      "first user message text 'Hello there.' must be preserved (string→block conversion)",
    )
    assert.ok(
      allText.includes("Please read the README."),
      "second user message text must be preserved",
    )
    assert.ok(
      allText.includes("thanks"),
      "last user message text must be preserved",
    )

    // Critical assertion 4: ID tags injected successfully on EVERY user/
    // assistant message (this is what was crashing in message-ids.mjs:266).
    for (let i = 0; i < result.body.messages.length; i++) {
      const m = result.body.messages[i]
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue
      assert.ok(
        messagesHaveTag(m),
        `message at index ${i} (role=${m.role}) must carry a <dcp-message-id> tag after normalization`,
      )
    }

    // Light sanity: metrics produced normally (no error swallowed)
    assert.ok(result.metrics && typeof result.metrics === "object")
    assert.equal(typeof result.metrics.savedTokensEst, "number")
  })

  // ============================
  // ⑬ STRING-CONTENT + REPEATED TOOL CALLS (dedup survives normalization)
  // ============================
  it("⑬ string-content normalization preserves dedup behavior — placeholder appears on tool_result (array form)", () => {
    // 3 identical Read calls (same file_path → dedup) wrapped in a conversation
    // that uses string content for the user prompts. After normalization,
    // dedup must still kick in and replace the first two tool_results with
    // PRUNED_TOOL_OUTPUT placeholders. The third (most recent) survives.
    const messages = [
      { role: "user", content: "Inspect the auth module." }, // string shorthand
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_s1", name: "Read", input: { file_path: "src/auth.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_s1",
            content: "AUTH_BODY_FIRST" + "X".repeat(800),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_s2", name: "Read", input: { file_path: "src/auth.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_s2",
            content: "AUTH_BODY_SECOND" + "Y".repeat(800),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_s3", name: "Read", input: { file_path: "src/auth.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_s3",
            content: "AUTH_BODY_THIRD" + "Z".repeat(800),
          },
        ],
      },
      { role: "user", content: "thanks, that's enough" }, // string shorthand again
    ]
    const body = makeBaseBody({ messages })
    const ctx = {
      config: makeConfig(),
      lightState: defaultLightState(),
      usage: LOW_USAGE,
      dataDir: tmpDir,
      cwd: tmpDir,
    }

    // No crash on string content
    let result
    assert.doesNotThrow(
      () => { result = transformRequest(body, ctx) },
      "pipeline must not crash on string-content messages in dedup scenario",
    )

    // Dedup placeholder visible on the array-form tool_result (the FIRST two
    // read calls get pruned, the third survives). This proves dedup ran AFTER
    // normalization (if it ran on the string content directly, it would have
    // crashed instead of producing placeholders).
    const outMessages = result.body.messages
    const prunedResults = []
    for (const m of outMessages) {
      if (m.role !== "user") continue
      const parts = Array.isArray(m.content) ? m.content : []
      for (const p of parts) {
        if (
          p && p.type === "tool_result" &&
          typeof p.content === "string" &&
          p.content.startsWith(PRUNED_TOOL_OUTPUT)
        ) {
          prunedResults.push(p.tool_use_id)
        }
      }
    }
    assert.ok(
      prunedResults.includes("call_s1"),
      `call_s1 should be dedup-pruned (got: ${JSON.stringify(prunedResults)})`,
    )
    assert.ok(
      prunedResults.includes("call_s2"),
      `call_s2 should be dedup-pruned (got: ${JSON.stringify(prunedResults)})`,
    )
    assert.ok(
      !prunedResults.includes("call_s3"),
      "call_s3 (most recent read) must NOT be pruned",
    )

    // The string-shorthand user messages were normalized to text blocks
    // (still present in output) AND carry ID tags (proves injection hit the
    // normalized array form, not the original string).
    const allText = collectAllText(result.body.messages)
    assert.ok(allText.includes("Inspect the auth module."), "string user msg 1 preserved")
    assert.ok(allText.includes("thanks, that's enough"), "string user msg 2 preserved")
    for (let i = 0; i < outMessages.length; i++) {
      const m = outMessages[i]
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue
      assert.ok(
        messagesHaveTag(m),
        `message at index ${i} (role=${m.role}) must carry ID tag (post-normalization)`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messagesHaveTag(message) {
  if (!message || !Array.isArray(message.content)) return false
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text" && typeof part.text === "string") {
      if (/<dcp-message-id[^>]*>m\d+<\/dcp-message-id>/.test(part.text)) return true
    }
    if (part.type === "tool_result") {
      const c = part.content
      if (typeof c === "string") {
        if (/<dcp-message-id[^>]*>m\d+<\/dcp-message-id>/.test(c)) return true
      } else if (Array.isArray(c)) {
        for (const inner of c) {
          if (inner && inner.type === "text" && typeof inner.text === "string" &&
              /<dcp-message-id[^>]*>m\d+<\/dcp-message-id>/.test(inner.text)) {
            return true
          }
        }
      }
    }
  }
  return false
}

function collectText(message) {
  if (!message || !Array.isArray(message.content)) return ""
  let out = ""
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text" && typeof part.text === "string") out += part.text
    if (part.type === "tool_result") {
      const c = part.content
      if (typeof c === "string") out += c
      else if (Array.isArray(c)) {
        for (const inner of c) {
          if (inner && inner.type === "text" && typeof inner.text === "string") out += inner.text
        }
      }
    }
  }
  return out
}

function countPrunedToolResults(messages) {
  let n = 0
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (p && p.type === "tool_result" &&
          typeof p.content === "string" &&
          p.content.startsWith(PRUNED_TOOL_OUTPUT)) n++
    }
  }
  return n
}

function collectAllText(messages) {
  let out = ""
  for (const m of messages) out += collectText(m) + "\n"
  return out
}
