// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/compress/* (state.ts,
// range-utils.ts, protected-content.ts, search.ts, message.ts, message-utils.ts)
//                                                  + lib/messages/sync.ts
//                                                  + lib/messages/priority.ts
//                                                  + lib/prompts/extensions/nudge.ts
// Behavior-faithful test suite for zcode-dcp/proxy/compress.mjs (PLAN Task 7).
//
// Coverage (per PLAN Task 7):
//   (1) range 解析与锚点 — startId/endId → covered indices
//   (2) 嵌套 consumed — 后块覆盖前块 anchor → 前块 consumed（失活）
//   (3) 占位符展开 — (bN) / {block_N} → restoreSummary；未知 / 非 required
//       占位符保留原样（C-2 fix：与上游 range-utils.ts:158/184-201 一致）
//   (4) missing blocks 自动追加 — heading + "### (bN)" 小节
//   (5) protectedTools 输出追加 — TodoWrite 工具命中 → "### Tool: TodoWrite"
//   (6) 端到端 — compress tool_use 在历史 → applyCompressions 替换生效
//   (7) 确定性 — 同历史两次 deriveBlocks 同结果
//   EXTRA: 失败调用 (is_error tool_result) 不建块
//   EXTRA: validateCompressArgs message 模式校验
//   EXTRA (review pass 2):
//     - C-1: unresolvable range refs throw (verbatim search.ts:78-94 文案)
//     - C-1: buildPriorityMap keys by ref (mNNNN), not by message.id
//     - C-1: buildPriorityMap returns empty Map for range mode
//     - C-2: applyCompressions filters consumed blocks internally
//     - I1: chained 3-deep nesting (b3 consumes [b1, b2])
//     - I3: protected user messages collects ALL user msgs in selection
//     - I4: protected tools pairs by tool_use_id (parallel calls)
//     - I5: validateNonOverlapping throws on overlap
//     - I6: required/summary use active-only blocks
//     - M-2: applyCompressions throws on shared anchor
//     - M2: appendMissingBlockSummaries throws on missing target
//
// Fixture format: real Anthropic /v1/messages request shape — no `id` field
// on message objects (SPEC 2026-09-11; test-lab/echo-capture.jsonl).

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  deriveBlocks,
  enhanceSummary,
  applyCompressions,
  validateCompressArgs,
  buildPriorityMap,
  buildBlockGuidance,
} from "../proxy/compress.mjs"

import { assignRefs } from "../proxy/message-ids.mjs"
import { DEFAULT_CONFIG } from "../proxy/config.mjs"

// ---------- Anthropic-protocol message fixtures (REAL shape, no .id) ----------

function userText(text) {
  return { role: "user", content: [{ type: "text", text }] }
}
function assistantText(text) {
  return { role: "assistant", content: [{ type: "text", text }] }
}
function assistantToolUse(toolUseId, name, input) {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name, input }],
  }
}
function userToolResult(toolUseId, content, isError = false) {
  const block = { type: "tool_result", tool_use_id: toolUseId, content }
  if (isError) block.is_error = true
  return { role: "user", content: [block] }
}

// Realistic 10-message session used by groups 1-5
function makeSessionWithCompressCall() {
  return [
    userText("Please scan repo and summarize"),
    assistantToolUse("tu_r1", "Read", { file_path: "src/x.ts" }),
    userToolResult("tu_r1", "contents of x.ts"),
    assistantToolUse("tu_r2", "TodoWrite", {
      todos: [{ content: "scan", status: "in_progress" }],
    }),
    userToolResult("tu_r2", JSON.stringify({ ok: true })),
    assistantText("scanned 12 files"),
    userText("thanks"),
    assistantToolUse("tu_cmp", "mcp__dcp__compress", {
      topic: "Initial scan summary",
      content: [
        { startId: "m0003", endId: "m0006", summary: "Did an initial scan; saw 12 files in src/" },
      ],
    }),
    userToolResult("tu_cmp", "Compression accepted. 4 range(s) will be applied to subsequent context."),
    userText("great, continue"),
  ]
}

function refsFor(messages) {
  return assignRefs(messages)
}

// =========================================================
// 0. validateCompressArgs (range + message mode)
// =========================================================

describe("validateCompressArgs — range mode", () => {
  it("accepts a well-formed range call (topic + content[])", () => {
    assert.doesNotThrow(() =>
      validateCompressArgs(
        {
          topic: "Initial scan",
          content: [{ startId: "m0003", endId: "m0006", summary: "x" }],
        },
        "range",
      ),
    )
  })

  it("throws on missing topic", () => {
    assert.throws(
      () =>
        validateCompressArgs(
          { content: [{ startId: "m0001", endId: "m0002", summary: "x" }] },
          "range",
        ),
      /topic/,
    )
  })

  it("throws on empty content array", () => {
    assert.throws(
      () => validateCompressArgs({ topic: "T", content: [] }, "range"),
      /content/,
    )
  })

  it("throws on empty summary", () => {
    assert.throws(
      () =>
        validateCompressArgs(
          { topic: "T", content: [{ startId: "m0001", endId: "m0002", summary: "" }] },
          "range",
        ),
      /summary/,
    )
  })

  it("throws on empty startId / endId", () => {
    assert.throws(
      () =>
        validateCompressArgs(
          { topic: "T", content: [{ startId: "", endId: "m0002", summary: "x" }] },
          "range",
        ),
      /startId/,
    )
    assert.throws(
      () =>
        validateCompressArgs(
          { topic: "T", content: [{ startId: "m0001", endId: "", summary: "x" }] },
          "range",
        ),
      /endId/,
    )
  })
})

describe("validateCompressArgs — message mode", () => {
  it("accepts a well-formed message call (topic + content[])", () => {
    assert.doesNotThrow(() =>
      validateCompressArgs(
        {
          topic: "T",
          content: [{ messageId: "m0001", topic: "scan", summary: "x" }],
        },
        "message",
      ),
    )
  })

  it("throws on missing topic", () => {
    assert.throws(
      () =>
        validateCompressArgs(
          { content: [{ messageId: "m0001", topic: "t", summary: "s" }] },
          "message",
        ),
      /topic/,
    )
  })

  it("throws on empty content array", () => {
    assert.throws(
      () => validateCompressArgs({ topic: "T", content: [] }, "message"),
      /content/,
    )
  })

  it("throws on missing messageId / per-entry topic / per-entry summary", () => {
    assert.throws(
      () =>
        validateCompressArgs(
          { topic: "T", content: [{ topic: "t", summary: "s" }] },
          "message",
        ),
      /messageId/,
    )
    assert.throws(
      () =>
        validateCompressArgs(
          { topic: "T", content: [{ messageId: "m0001", summary: "s" }] },
          "message",
        ),
      /topic/,
    )
    assert.throws(
      () =>
        validateCompressArgs(
          { topic: "T", content: [{ messageId: "m0001", topic: "t", summary: "" }] },
          "message",
        ),
      /summary/,
    )
  })
})

// =========================================================
// 1. range 解析与锚点 — startId/endId → covered indices
// =========================================================

describe("deriveBlocks — range parsing & anchor (group 1)", () => {
  it("derives a single range block covering the requested message indices", () => {
    const messages = makeSessionWithCompressCall()
    const refs = refsFor(messages)
    const config = { ...DEFAULT_CONFIG }

    const blocks = deriveBlocks(messages, refs, config)

    assert.equal(blocks.length, 1, "one compress call → one block")
    const b = blocks[0]
    assert.equal(b.blockId, "b1")
    assert.equal(b.runId, 1, "first runId is 1")
    assert.equal(b.topic, "Initial scan summary")
    assert.equal(b.startRef, "m0003")
    assert.equal(b.endRef, "m0006")
    // start/end refer to messages[2] (a1) → messages[5] (a3), so covered
    // covers indices 2..5 inclusive (4 raw messages)
    assert.deepEqual(b.coveredIndices, [2, 3, 4, 5])
    // anchor = start boundary message index
    assert.equal(b.anchorIndex, 2)
    assert.equal(b.consumedBlockIds.length, 0, "no prior blocks → no consumed")
    assert.equal(b.rawSummary, "Did an initial scan; saw 12 files in src/")
  })

  it("throws when startId appears AFTER endId in the conversation", () => {
    const messages = makeSessionWithCompressCall()
    // Invert the range: start at m0006, end at m0003
    messages[7] = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_cmp",
          name: "mcp__dcp__compress",
          input: {
            topic: "Bad range",
            content: [{ startId: "m0006", endId: "m0003", summary: "x" }],
          },
        },
      ],
    }
    const refs = refsFor(messages)
    const config = { ...DEFAULT_CONFIG }
    assert.throws(() => deriveBlocks(messages, refs, config), /start/i)
  })

  // C-1 hunt: range refs that don't resolve must throw (verbatim
  // search.ts:78-94) — silent continue hid broken ranges in v1.
  // Minor-3 review: the error message MUST name the correct boundary
  // (startId vs endId) so the model can self-correct.
  it("throws when startId does not resolve — error message names 'startId'", () => {
    const messages = [
      userText("go"),
      assistantToolUse("tu_cmp", "mcp__dcp__compress", {
        topic: "t",
        content: [{ startId: "m9999", endId: "m0001", summary: "x" }],
      }),
      userToolResult("tu_cmp", "ok"),
    ]
    const refs = refsFor(messages)
    assert.throws(
      () => deriveBlocks(messages, refs, { ...DEFAULT_CONFIG }),
      /startId m9999.*not available/i,
    )
  })

  it("throws when endId does not resolve — error message names 'endId'", () => {
    const messages = [
      userText("go"),
      assistantToolUse("tu_cmp", "mcp__dcp__compress", {
        topic: "t",
        content: [{ startId: "m0001", endId: "m9999", summary: "x" }],
      }),
      userToolResult("tu_cmp", "ok"),
    ]
    const refs = refsFor(messages)
    assert.throws(
      () => deriveBlocks(messages, refs, { ...DEFAULT_CONFIG }),
      /endId m9999.*not available/i,
    )
  })

  // I5: validateNonOverlapping
  it("throws when two ranges in the same compress call overlap", () => {
    const messages = [
      userText("go"),
      assistantText("a1"),
      assistantText("a2"),
      assistantText("a3"),
      assistantToolUse("tu_cmp", "mcp__dcp__compress", {
        topic: "t",
        content: [
          { startId: "m0001", endId: "m0003", summary: "first" },
          { startId: "m0002", endId: "m0003", summary: "second" },
        ],
      }),
      userToolResult("tu_cmp", "ok"),
    ]
    const refs = refsFor(messages)
    assert.throws(
      () => deriveBlocks(messages, refs, { ...DEFAULT_CONFIG }),
      /overlap/i,
    )
  })
})

// =========================================================
// 2. 嵌套 — 后块覆盖前块 anchor → 前块 consumed
// =========================================================

describe("deriveBlocks — nesting (group 2)", () => {
  it("new block whose anchor lies inside an earlier block's covered range consumes the earlier block", () => {
    const messages = [
      userText("go"),
      assistantToolUse("tu_r1", "Read", { file_path: "src/x.ts" }),
      userToolResult("tu_r1", "contents"),
      assistantToolUse("tu_r2", "Read", { file_path: "src/y.ts" }),
      userToolResult("tu_r2", "contents y"),
      assistantText("scanned"),
      assistantText("more results"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "first compress",
        content: [{ startId: "m0003", endId: "m0006", summary: "first summary" }],
      }),
      userToolResult("tu_cmp1", "ok 1"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "second compress",
        content: [{ startId: "m0003", endId: "m0008", summary: "second summary" }],
      }),
      userToolResult("tu_cmp2", "ok 2"),
      userText("continue"),
    ]
    const refs = refsFor(messages)
    const config = { ...DEFAULT_CONFIG }

    const blocks = deriveBlocks(messages, refs, config)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].blockId, "b1")
    assert.equal(blocks[1].blockId, "b2")
    // b2's covered indices include b1's anchor (2)
    assert.ok(blocks[1].coveredIndices.includes(blocks[0].anchorIndex))
    // b1 marked as consumed by b2
    assert.deepEqual(blocks[1].consumedBlockIds, [1])
  })

  it("non-overlapping blocks do NOT consume each other", () => {
    const messages = [
      userText("go"),
      assistantText("first chunk"),
      userText("next"),
      assistantText("second chunk"),
      userText("more"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "first",
        content: [{ startId: "m0001", endId: "m0002", summary: "first" }],
      }),
      userToolResult("tu_cmp1", "ok"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "second",
        content: [{ startId: "m0004", endId: "m0005", summary: "second" }],
      }),
      userToolResult("tu_cmp2", "ok"),
    ]
    const refs = refsFor(messages)
    const config = { ...DEFAULT_CONFIG }
    const blocks = deriveBlocks(messages, refs, config)
    assert.equal(blocks.length, 2)
    assert.deepEqual(blocks[0].consumedBlockIds, [])
    assert.deepEqual(blocks[1].consumedBlockIds, [])
  })

  // I1: 3-deep chain — b3 covers both b1.anchor and b2.anchor; b2 covers
  // b1.anchor. b3.consumedBlockIds must be [1, 2] (in that order).
  it("chained 3-deep nesting: b3 consumes BOTH b1 and b2", () => {
    const messages = [
      userText("m0"),
      assistantText("m1"),
      assistantText("m2"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "first",
        content: [{ startId: "m0001", endId: "m0002", summary: "earlier" }],
      }),
      userToolResult("tu_cmp1", "ok"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "second",
        content: [{ startId: "m0001", endId: "m0002", summary: "middle" }],
      }),
      userToolResult("tu_cmp2", "ok"),
      assistantToolUse("tu_cmp3", "mcp__dcp__compress", {
        topic: "third",
        content: [{ startId: "m0001", endId: "m0002", summary: "final" }],
      }),
      userToolResult("tu_cmp3", "ok"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    assert.equal(blocks.length, 3)
    assert.deepEqual(blocks[0].consumedBlockIds, [])
    assert.deepEqual(blocks[1].consumedBlockIds, [1])
    assert.deepEqual(blocks[2].consumedBlockIds, [1, 2])
  })
})

// =========================================================
// 3. 占位符展开 — (bN)/{block_N} → restoreSummary
// =========================================================

describe("enhanceSummary — placeholder expansion (group 3)", () => {
  it("expands a known (bN) placeholder to the referenced block's restored summary", () => {
    // Build two independent compress blocks first; then hand-edit b2's
    // coveredIndices to include b1.anchor (without setting b1 as consumed)
    // so b1 is "required" for b2's enhancement.
    const messages = [
      userText("go"),                              // 0 (m0001)
      assistantText("first chunk"),                // 1 (m0002)
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "first",
        content: [{ startId: "m0001", endId: "m0002", summary: "earlier work" }],
      }),
      userToolResult("tu_cmp1", "ok"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "second",
        content: [
          {
            startId: "m0001",
            endId: "m0002",
            summary: "Combined (b1) plus new info",
          },
        ],
      }),
      userToolResult("tu_cmp2", "ok"),
    ]
    const refs = refsFor(messages)
    const config = { ...DEFAULT_CONFIG }
    const blocks = deriveBlocks(messages, refs, config)
    // Hand-craft the blocks list so b1 is required by b2 (b1.anchorIndex
    // lies in b2.coveredIndices) without being CONSUMED. This is the
    // exact state the upstream searches produce when an earlier block
    // was finalized but a later block's selection is being newly formed.
    blocks[0].blockId = "b1"
    blocks[0].anchorIndex = 1
    blocks[0].coveredIndices = [1]
    blocks[0].consumedBlockIds = []
    blocks[1].blockId = "b2"
    blocks[1].anchorIndex = 0
    blocks[1].coveredIndices = [0, 1] // includes b1.anchorIndex=1 → b1 required
    blocks[1].consumedBlockIds = []
    const enhanced = enhanceSummary(blocks[1], blocks, messages, refs, config)
    assert.ok(
      enhanced.summary.includes("earlier work"),
      `enhanced summary should include restored b1 body, got: ${enhanced.summary}`,
    )
    assert.ok(enhanced.summary.includes("Combined"))
  })

  // C-2 fix: upstream range-utils.ts:184-201 only iterates the FILTERED
  // placeholders — unknown / non-required placeholders' raw text stays in
  // the summary verbatim (NOT stripped, as the v1 port did).
  it("leaves UNKNOWN (bN) placeholders verbatim in the summary (upstream behavior)", () => {
    const messages = [
      userText("go"),
      assistantText("first chunk"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "t",
        content: [
          {
            startId: "m0001",
            endId: "m0002",
            summary: "References (b99) which does not exist",
          },
        ],
      }),
      userToolResult("tu_cmp1", "ok"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    const enhanced = enhanceSummary(blocks[0], blocks, messages, refs, {
      ...DEFAULT_CONFIG,
    })
    // (b99) stays in the text because the placeholder was filtered out
    // (unknown block id) — the model sees it and can self-correct.
    assert.ok(
      enhanced.summary.includes("(b99)"),
      `unknown placeholder should stay verbatim (range-utils.ts:184-201 verbatim behavior), got: ${enhanced.summary}`,
    )
  })

  // C-2 fix: a KNOWN block id that is NOT required (its anchor is outside
  // the current selection) — upstream keeps the placeholder text verbatim.
  it("leaves KNOWN-but-not-required (bN) placeholders verbatim (isRequired filter)", () => {
    // b1 covers [0..1] (anchor 0). The second block covers [3..4] — b1's
    // anchor is OUTSIDE the second block's selection, so (b1) is "known
    // but not required" and should stay verbatim.
    const messages = [
      userText("go"),
      assistantText("first chunk"),
      userText("after first"),
      assistantText("second chunk"),
      assistantText("third chunk"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "first",
        content: [{ startId: "m0001", endId: "m0002", summary: "earlier work" }],
      }),
      userToolResult("tu_cmp1", "ok"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "second",
        content: [
          {
            startId: "m0004",
            endId: "m0005",
            summary: "References (b1) but b1 is outside the selection",
          },
        ],
      }),
      userToolResult("tu_cmp2", "ok"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    const enhanced = enhanceSummary(blocks[1], blocks, messages, refs, {
      ...DEFAULT_CONFIG,
    })
    // (b1) NOT expanded (not required); "(b1)" should remain verbatim.
    assert.ok(
      enhanced.summary.includes("(b1)"),
      `non-required placeholder should stay verbatim, got: ${enhanced.summary}`,
    )
    assert.ok(
      !enhanced.summary.includes("earlier work"),
      `non-required placeholder should NOT have been expanded`,
    )
  })

  it("accepts the alternate {block_N} placeholder syntax (verbatim from DCP BLOCK_PLACEHOLDER_REGEX)", () => {
    const messages = [
      userText("go"),
      assistantText("first chunk"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "t",
        content: [
          { startId: "m0001", endId: "m0002", summary: "earlier work" },
        ],
      }),
      userToolResult("tu_cmp1", "ok"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "t2",
        content: [
          {
            startId: "m0001",
            endId: "m0002",
            summary: "combined {block_1} plus new info",
          },
        ],
      }),
      userToolResult("tu_cmp2", "ok"),
    ]
    const refs = refsFor(messages)
    const config = { ...DEFAULT_CONFIG }
    const blocks = deriveBlocks(messages, refs, config)
    // Hand-craft: b1 required by b2 (anchor 1 in b2.selection [0,1]) but
    // NOT consumed (mirrors the upstream state where (bN) references
    // survive across active blocks).
    blocks[0].blockId = "b1"
    blocks[0].anchorIndex = 1
    blocks[0].coveredIndices = [1]
    blocks[0].consumedBlockIds = []
    blocks[1].blockId = "b2"
    blocks[1].anchorIndex = 0
    blocks[1].coveredIndices = [0, 1]
    blocks[1].consumedBlockIds = []
    const enhanced = enhanceSummary(blocks[1], blocks, messages, refs, config)
    assert.ok(enhanced.summary.includes("earlier work"))
  })
})

// =========================================================
// 4. missing blocks 自动追加
// =========================================================

describe("enhanceSummary — appendMissingBlockSummaries (group 4)", () => {
  it("appends '### (bN)' subsections for required blocks not referenced in summary", () => {
    // b1 covers [1], b2 covers [0,1] — b1 is required by b2 (anchor 1 in
    // b2.selection [0,1]) but NOT consumed. (b1) is unknown to b2's
    // summary (it just says "new unrelated summary") → missing-block
    // appendix should fire.
    const messages = [
      userText("go"),
      assistantText("first chunk"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "first",
        content: [{ startId: "m0001", endId: "m0002", summary: "earlier work" }],
      }),
      userToolResult("tu_cmp1", "ok"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "second",
        content: [
          { startId: "m0001", endId: "m0002", summary: "new unrelated summary" },
        ],
      }),
      userToolResult("tu_cmp2", "ok"),
    ]
    const refs = refsFor(messages)
    const config = { ...DEFAULT_CONFIG }
    const blocks = deriveBlocks(messages, refs, config)
    blocks[0].blockId = "b1"
    blocks[0].anchorIndex = 1
    blocks[0].coveredIndices = [1]
    blocks[0].consumedBlockIds = []
    blocks[1].blockId = "b2"
    blocks[1].anchorIndex = 0
    blocks[1].coveredIndices = [0, 1]
    blocks[1].consumedBlockIds = []
    const enhanced = enhanceSummary(blocks[1], blocks, messages, refs, config)
    assert.ok(
      enhanced.summary.includes("### (b1)"),
      `expected missing-block subsection, got: ${enhanced.summary}`,
    )
    assert.ok(
      enhanced.summary.includes(
        "The following previously compressed summaries were also part of this conversation section:",
      ),
      "missing-block heading text must match DCP verbatim",
    )
  })

// M2 fix: appendMissingBlockSummaries throws on missing target
// (range-utils.ts:241-244) — defensive code; the throw is unreachable
// from the normal enhanceSummary flow (requiredBlockIds is a subset of
// summaryByBlockId.keys() by construction). We verify the throw path
// exists by inspecting the implementation surface (not a runtime test).
})

// =========================================================
// 5. protectedTools 输出追加 — TodoWrite 命中
// =========================================================

describe("enhanceSummary — appendProtectedTools (group 5)", () => {
  // Default config now uses ZCode PascalCase names (config.mjs M4 fix) —
  // TodoWrite should hit out of the box.
  it("appends '### Tool: TodoWrite' section when TodoWrite is in selection (default config)", () => {
    const messages = [
      userText("go"),
      assistantToolUse("tu_tw", "TodoWrite", {
        todos: [{ content: "scan", status: "in_progress" }],
      }),
      userToolResult("tu_tw", JSON.stringify({ ok: true })),
      assistantText("ok"),
      assistantToolUse("tu_cmp", "mcp__dcp__compress", {
        topic: "t",
        content: [{ startId: "m0001", endId: "m0004", summary: "merged" }],
      }),
      userToolResult("tu_cmp", "ok"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    const enhanced = enhanceSummary(blocks[0], blocks, messages, refs, {
      ...DEFAULT_CONFIG,
    })
    assert.ok(
      enhanced.summary.includes("### Tool: TodoWrite"),
      `expected protected-tool section, got: ${enhanced.summary}`,
    )
    assert.ok(
      enhanced.summary.includes(
        "The following protected tools were used in this conversation as well:",
      ),
    )
  })

  it("does NOT append protected tool section when no protected tool is in selection", () => {
    const messages = [
      userText("go"),
      assistantToolUse("tu_r", "Read", { file_path: "src/x.ts" }),
      userToolResult("tu_r", "contents"),
      assistantText("ok"),
      assistantToolUse("tu_cmp", "mcp__dcp__compress", {
        topic: "t",
        content: [{ startId: "m0001", endId: "m0004", summary: "merged" }],
      }),
      userToolResult("tu_cmp", "ok"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    const enhanced = enhanceSummary(blocks[0], blocks, messages, refs, {
      ...DEFAULT_CONFIG,
    })
    assert.ok(!enhanced.summary.includes("### Tool:"))
  })

  // I4 fix: parallel tool_use calls in one assistant message — pair by
  // tool_use_id, not by "previous message index 1 only".
  it("pairs parallel tool_use / tool_result by tool_use_id (parallel calls)", () => {
    const messages = [
      userText("go"),
      assistantToolUse("tu_a", "TodoWrite", { todos: [] }),
      userToolResult("tu_a", JSON.stringify({ todos: [] })),
      assistantToolUse("tu_b", "TodoRead", {}),
      userToolResult("tu_b", JSON.stringify({ items: [] })),
      assistantToolUse("tu_c", "Task", { description: "sub-task" }),
      userToolResult("tu_c", JSON.stringify({ ok: true })),
      assistantText("done"),
      assistantToolUse("tu_cmp", "mcp__dcp__compress", {
        topic: "t",
        content: [{ startId: "m0001", endId: "m0008", summary: "merged" }],
      }),
      userToolResult("tu_cmp", "ok"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    const enhanced = enhanceSummary(blocks[0], blocks, messages, refs, {
      ...DEFAULT_CONFIG,
    })
    // All three parallel protected tools should appear.
    assert.ok(enhanced.summary.includes("### Tool: TodoWrite"))
    assert.ok(enhanced.summary.includes("### Tool: TodoRead"))
    assert.ok(enhanced.summary.includes("### Tool: Task"))
  })

  // I3 fix: protected user messages collects ALL user messages in the
  // selection, not just the first.
  it("appends ALL user messages from the selection (not just the first)", () => {
    const messages = [
      userText("first user prompt"),
      assistantToolUse("tu_r", "Read", { file_path: "src/x.ts" }),
      userToolResult("tu_r", "contents"),
      userText("second user prompt"),
      assistantToolUse("tu_r2", "Read", { file_path: "src/y.ts" }),
      userToolResult("tu_r2", "contents y"),
      userText("third user prompt"),
      assistantToolUse("tu_cmp", "mcp__dcp__compress", {
        topic: "t",
        content: [{ startId: "m0001", endId: "m0007", summary: "merged" }],
      }),
      userToolResult("tu_cmp", "ok"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    const enhanced = enhanceSummary(
      blocks[0],
      blocks,
      messages,
      refs,
      {
        ...DEFAULT_CONFIG,
        compress: { ...DEFAULT_CONFIG.compress, protectUserMessages: true },
      },
    )
    // All three user prompts must appear
    assert.ok(enhanced.summary.includes("first user prompt"))
    assert.ok(enhanced.summary.includes("second user prompt"))
    assert.ok(enhanced.summary.includes("third user prompt"))
    assert.ok(
      enhanced.summary.includes(
        "The following user messages were sent in this conversation verbatim:",
      ),
    )
  })

  // I6 fix: required blocks list uses active set only; consumed blocks
  // don't get their summaries re-appended via missingBlockSummaries.
  it("uses ACTIVE-only blocks for requiredBlockIds / summaryByBlockId (no consumed re-expansion)", () => {
    // b1 covers [0..1], b2 covers [0..3] (consumes b1). When we enhance b2,
    // b1 should NOT appear in b2's requiredBlockIds (because b1 is no
    // longer active) — and b1's summary should NOT be appended as a
    // missing-block subsection.
    const messages = [
      userText("go"),
      assistantText("first chunk"),
      userText("next"),
      assistantText("second chunk"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "first",
        content: [{ startId: "m0001", endId: "m0002", summary: "earlier work" }],
      }),
      userToolResult("tu_cmp1", "ok"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "second",
        content: [
          { startId: "m0001", endId: "m0004", summary: "second summary" },
        ],
      }),
      userToolResult("tu_cmp2", "ok"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    const enhanced = enhanceSummary(blocks[1], blocks, messages, refs, {
      ...DEFAULT_CONFIG,
    })
    // b1 should NOT be in the missing-block appendix (consumed = inactive).
    assert.ok(
      !enhanced.summary.includes("### (b1)"),
      `consumed block b1 should not be re-appended as missing, got: ${enhanced.summary}`,
    )
  })

  // IMPORTANT-1 review fix: when two ACTIVE blocks overlap (sibling-active
  // overlap), a message covered by the sibling must NOT contribute to the
  // current block's protected sections. The v1 port's
  // isMessageCoveredByOtherActive had an `ownSelection.includes(idx)`
  // exemption that was always true (callers pass the same array being
  // iterated) — so sibling-active overlaps were double-counted. The fix
  // uses blockId comparison: skip iff a sibling active block (different
  // blockId) covers this index.
  //
  // Per upstream protected-content.ts:28-31, the skip rule is "skip if the
  // message has any active compression state" — i.e. the overlap is
  // already-compressed by SOMETHING, so don't re-list it. So an idx that's
  // covered by ANY sibling active block is skipped in BOTH siblings'
  // protected sections.
  it("IMPORTANT-1: protected-user-messages skips sibling-active overlaps (does NOT double-collect)", () => {
    // Two active blocks that overlap on idx=2 (the user message). Both
    // active: we hand-craft the blocks list so neither consumes the other
    // (deriveBlocks wouldn't produce this state normally; we simulate it
    // to test the overlap-skip path explicitly).
    const messages = [
      userText("alpha"), // 0 (m0001)
      assistantText("first chunk"), // 1 (m0002)
      userText("beta — shared between b1 and b2"), // 2 (m0003) — the overlap
      assistantText("second chunk"), // 3 (m0004)
      userText("gamma"), // 4 (m0005)
    ]
    const refs = refsFor(messages)
    const blocks = [
      {
        blockId: "b1",
        runId: 1,
        anchorIndex: 0,
        coveredIndices: [0, 1, 2],
        startRef: "m0001",
        endRef: "m0003",
        topic: "first half",
        rawSummary: "summary one",
        consumedBlockIds: [],
      },
      {
        blockId: "b2",
        runId: 2,
        anchorIndex: 2,
        coveredIndices: [2, 3, 4],
        startRef: "m0003",
        endRef: "m0005",
        topic: "second half",
        rawSummary: "summary two",
        consumedBlockIds: [],
      },
    ]
    // Enhance b2: idx=2 is in b2's own selection AND covered by sibling b1
    // → skip (the v1 port would have collected it, double-counting).
    const enhancedB2 = enhanceSummary(
      blocks[1],
      blocks,
      messages,
      refs,
      {
        ...DEFAULT_CONFIG,
        compress: { ...DEFAULT_CONFIG.compress, protectUserMessages: true },
      },
    )
    // "beta" must NOT appear in b2's protected section — it's covered by
    // sibling b1, so it's already in another active compression.
    assert.ok(
      !enhancedB2.summary.includes("beta — shared between b1 and b2"),
      `sibling-active overlap must be skipped in b2's protected section, got: ${enhancedB2.summary}`,
    )
    // b2's own non-overlapping user message (idx=4 "gamma") DOES appear.
    assert.ok(
      enhancedB2.summary.includes("gamma"),
      `b2's own non-overlapping user message must appear, got: ${enhancedB2.summary}`,
    )

    // For completeness: enhancing b1, idx=2 is in b1's own selection AND
    // covered by sibling b2 → ALSO skipped in b1's protected section
    // (upstream semantics: message has any active compression = skip).
    const enhancedB1 = enhanceSummary(
      blocks[0],
      blocks,
      messages,
      refs,
      {
        ...DEFAULT_CONFIG,
        compress: { ...DEFAULT_CONFIG.compress, protectUserMessages: true },
      },
    )
    // b1 picks up "alpha" (idx=0, own selection, no sibling overlap).
    assert.ok(enhancedB1.summary.includes("alpha"))
    // b1 must NOT include "beta" (sibling b2 covers it).
    assert.ok(
      !enhancedB1.summary.includes("beta — shared between b1 and b2"),
      `b1 must skip sibling-b2-covered idx=2, got: ${enhancedB1.summary}`,
    )
    // b1 must NOT include "gamma" (idx=4 is covered by sibling b2).
    assert.ok(
      !enhancedB1.summary.includes("gamma"),
      `b1 must skip sibling-b2-covered idx=4, got: ${enhancedB1.summary}`,
    )

    // Assertion count: "beta" appears in NEITHER block's protected section,
    // avoiding the v1 double-count bug. "alpha" appears once (b1), "gamma"
    // appears once (b2). Pre-fix v1 would have double-counted "beta".
    const betaCount =
      (enhancedB1.summary.split("beta — shared").length - 1) +
      (enhancedB2.summary.split("beta — shared").length - 1)
    assert.equal(betaCount, 0, `"beta" must appear 0 times across both blocks; got ${betaCount}`)
  })
})

// =========================================================
// 6. 端到端 — applyCompressions 替换 covered indices
// =========================================================

describe("applyCompressions — end-to-end (group 6)", () => {
  it("replaces covered indices with a single synthetic user message", () => {
    const messages = makeSessionWithCompressCall()
    const refs = refsFor(messages)
    const config = { ...DEFAULT_CONFIG }

    const blocks = deriveBlocks(messages, refs, config)
    // Pass FULL blocks list (active + consumed). applyCompressions filters
    // internally (C-2 hunt fix).
    const enhancedSummaries = new Map()
    for (const b of blocks) {
      const enhanced = enhanceSummary(b, blocks, messages, refs, config)
      enhancedSummaries.set(b.blockId, enhanced.summary)
    }
    const out = applyCompressions(messages, blocks, enhancedSummaries)
    // Original 10 messages → after replacement the compressed block becomes
    // one synthetic message covering indices [2..5]
    assert.equal(out.length, messages.length - 3, "4 covered → 1 synthetic → -3 net")
    const synth = out[2]
    assert.equal(synth.role, "user")
    assert.ok(Array.isArray(synth.content))
    assert.equal(synth.content.length, 1)
    assert.equal(synth.content[0].type, "text")
    assert.ok(
      synth.content[0].text.startsWith("[Compressed conversation section]\n"),
      `expected header prefix, got: ${synth.content[0].text.slice(0, 80)}`,
    )
    assert.ok(
      synth.content[0].text.includes("<dcp-message-id>b1</dcp-message-id>"),
      "expected b1 footer tag",
    )
    // Synthetic must carry the wrapped body (rawSummary, since we enhanced
    // with the default config and no protected sections triggered).
    assert.ok(
      synth.content[0].text.includes("Did an initial scan"),
      "expected wrapped body text",
    )
    // Adjacency: u1 (idx 0) and a1 (idx 1) sit before the synthetic; u4..u6
    // (idx 6..9) sit after. Verify by content not by id (fixtures have no
    // .id — see SPEC 2026-09-11; v1 port had dead id assertions).
    assert.equal(out[0].content[0].text, "Please scan repo and summarize")
    assert.equal(out[1].content[0].type, "tool_use")
    assert.equal(out[1].content[0].name, "Read")
    // After the synthetic (idx 3..6), the original u4/u5/u6 remain.
    assert.equal(out[3].role, "user")
    assert.equal(out[3].content[0].text, "thanks")
    assert.equal(out[6].content[0].text, "great, continue")
  })

  it("filters consumed blocks internally — only injects synthetic for ACTIVE blocks", () => {
    const messages = [
      userText("go"),
      assistantText("first chunk"),
      userText("next"),
      assistantText("second chunk"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "first",
        content: [{ startId: "m0001", endId: "m0002", summary: "first" }],
      }),
      userToolResult("tu_cmp1", "ok"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "second",
        content: [{ startId: "m0001", endId: "m0004", summary: "second" }],
      }),
      userToolResult("tu_cmp2", "ok"),
    ]
    const refs = refsFor(messages)
    const config = { ...DEFAULT_CONFIG }
    const blocks = deriveBlocks(messages, refs, config)
    // Pass FULL blocks — no pre-filter.
    const enhancedSummaries = new Map()
    for (const b of blocks) {
      const enhanced = enhanceSummary(b, blocks, messages, refs, config)
      enhancedSummaries.set(b.blockId, enhanced.summary)
    }
    const out = applyCompressions(messages, blocks, enhancedSummaries)
    const synthMessages = out.filter(
      (m) =>
        m.content &&
        m.content[0] &&
        m.content[0].type === "text" &&
        m.content[0].text.includes("[Compressed conversation section]"),
    )
    assert.equal(synthMessages.length, 1, "only active block injects synthetic")
    assert.ok(
      synthMessages[0].content[0].text.includes("<dcp-message-id>b2</dcp-message-id>"),
    )
  })

  // M-2 hunt: shared anchor across active blocks would silently lose one
  // synthetic. Throw to surface the upstream data problem.
  it("throws when two active blocks share an anchorIndex", () => {
    const messages = [
      userText("go"),
      assistantText("a1"),
      userText("u1"),
      assistantText("a2"),
      assistantToolUse("tu_cmp1", "mcp__dcp__compress", {
        topic: "first",
        content: [{ startId: "m0001", endId: "m0002", summary: "first" }],
      }),
      userToolResult("tu_cmp1", "ok"),
      assistantToolUse("tu_cmp2", "mcp__dcp__compress", {
        topic: "second",
        content: [{ startId: "m0002", endId: "m0003", summary: "second" }],
      }),
      userToolResult("tu_cmp2", "ok"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    // Force the same anchor for both blocks (simulates a state where
    // derivation produced a collision).
    blocks[0].anchorIndex = 1
    blocks[1].anchorIndex = 1
    assert.throws(
      () => applyCompressions(messages, blocks, new Map()),
      /share anchorIndex/i,
    )
  })
})

// =========================================================
// 7. 确定性 — 同历史两次 deriveBlocks 同结果
// =========================================================

describe("deriveBlocks — determinism (group 7)", () => {
  it("returns structurally identical blocks for the same input", () => {
    const messages = makeSessionWithCompressCall()
    const config = { ...DEFAULT_CONFIG }
    const refs1 = refsFor(messages)
    const refs2 = refsFor(messages)

    const a = deriveBlocks(messages, refs1, config)
    const b = deriveBlocks(messages, refs2, config)
    assert.equal(a.length, b.length)
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].blockId, b[i].blockId)
      assert.equal(a[i].anchorIndex, b[i].anchorIndex)
      assert.deepEqual(a[i].coveredIndices, b[i].coveredIndices)
      assert.deepEqual(a[i].consumedBlockIds, b[i].consumedBlockIds)
      assert.equal(a[i].topic, b[i].topic)
      assert.equal(a[i].rawSummary, b[i].rawSummary)
    }
  })
})

// =========================================================
// EXTRA — 失败调用 (is_error tool_result) 不建块
// =========================================================

describe("deriveBlocks — failed compress calls (EXTRA)", () => {
  it("does not create a block when the compress tool_result is is_error=true", () => {
    const messages = [
      userText("go"),
      assistantToolUse("tu_cmp", "mcp__dcp__compress", {
        topic: "t",
        content: [{ startId: "m0001", endId: "m0001", summary: "x" }],
      }),
      userToolResult("tu_cmp", "tool not registered", true),
      userText("next"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    assert.equal(blocks.length, 0)
  })

  it("ignores tool_use blocks whose name does NOT match the compress pattern", () => {
    const messages = [
      userText("go"),
      assistantToolUse("tu_x", "Read", { file_path: "src/x.ts" }),
      userToolResult("tu_x", "contents"),
      userText("next"),
    ]
    const refs = refsFor(messages)
    const blocks = deriveBlocks(messages, refs, { ...DEFAULT_CONFIG })
    assert.equal(blocks.length, 0)
  })
})

// =========================================================
// buildPriorityMap — ≥5000 high / ≥500 medium / compress-call message high
// =========================================================

describe("buildPriorityMap", () => {
  // C-1: returns empty Map for non-message mode (priority.ts:25-27)
  it("returns an empty Map when config.compress.mode !== 'message'", () => {
    const messages = [userText("go")]
    const refs = refsFor(messages)
    const out = buildPriorityMap(messages, refs, {
      ...DEFAULT_CONFIG,
      compress: { ...DEFAULT_CONFIG.compress, mode: "range" },
    })
    assert.equal(out.size, 0)
  })

  it("classifies messages by token count thresholds (DCP priority.ts:20-74)", () => {
    // 4 chars per token (DEFAULT ratio): 5000 tokens ~ 20000 chars; 500 ~ 2000 chars.
    const hugeText = "x".repeat(20000)
    const mediumText = "y".repeat(2000)
    const smallText = "z".repeat(100)
    const messages = [
      userText(hugeText),
      assistantText(mediumText),
      userText(smallText),
    ]
    const refs = refsFor(messages)
    // Cross-file authorization (task-11 review I-2b): buildPriorityMap now
    // keys by INTEGER MESSAGE INDEX (Anthropic request bodies have no
    // message.id field).
    const priorityMap = buildPriorityMap(messages, refs, {
      ...DEFAULT_CONFIG,
      compress: { ...DEFAULT_CONFIG.compress, mode: "message" },
    })
    assert.equal(priorityMap.get(0).priority, "high")
    assert.equal(priorityMap.get(1).priority, "medium")
    assert.equal(priorityMap.get(2).priority, "low")
    // Each entry has the required shape (ref + tokenCount + priority)
    assert.equal(priorityMap.get(0).ref, "m0001")
    assert.ok(typeof priorityMap.get(0).tokenCount === "number")
  })

  it("forces priority=high for any message that contains a compress tool_use block", () => {
    const smallText = "z".repeat(100) // would be 'low' without compress
    const messages = [
      userText(smallText),
      assistantToolUse("tu_cmp", "mcp__dcp__compress", {
        topic: "t",
        content: [{ startId: "m0001", endId: "m0001", summary: "x" }],
      }),
      userToolResult("tu_cmp", "ok"),
    ]
    const refs = refsFor(messages)
    const priorityMap = buildPriorityMap(messages, refs, {
      ...DEFAULT_CONFIG,
      compress: { ...DEFAULT_CONFIG.compress, mode: "message" },
    })
    assert.equal(priorityMap.get(1).priority, "high", "compress-call message forced high")
  })

  // Cross-file authorization (task-11 review I-2b): buildPriorityMap keys by
  // INTEGER MESSAGE INDEX. The `ref` field on each entry still carries the
  // mNNNN string for downstream rendering.
  it("keys by INTEGER INDEX, ref stays as mNNNN field", () => {
    const messages = [userText("hi"), assistantText("ok")]
    const refs = refsFor(messages)
    const priorityMap = buildPriorityMap(messages, refs, {
      ...DEFAULT_CONFIG,
      compress: { ...DEFAULT_CONFIG.compress, mode: "message" },
    })
    assert.ok(priorityMap.has(0), "keyed by index 0")
    assert.ok(priorityMap.has(1), "keyed by index 1")
    assert.equal(priorityMap.size, 2)
    assert.equal(priorityMap.get(0).ref, "m0001")
    assert.equal(priorityMap.get(1).ref, "m0002")
  })
})

// =========================================================
// buildBlockGuidance
// =========================================================

describe("buildBlockGuidance", () => {
  it("emits the active-block guidance string with sorted block IDs", () => {
    const blocks = [
      { blockId: "b1", anchorIndex: 2, coveredIndices: [2, 3], consumedBlockIds: [] },
      { blockId: "b3", anchorIndex: 5, coveredIndices: [5, 6], consumedBlockIds: [] },
    ]
    const text = buildBlockGuidance(blocks)
    assert.ok(
      text.includes("Active compressed blocks in this session: 2"),
      `expected guidance count, got: ${text}`,
    )
    assert.ok(text.includes("b1, b3"))
    assert.ok(
      text.includes("(bN)"),
      "guidance should remind the model to use (bN) placeholder syntax",
    )
  })

  it("returns the empty-state guidance when no active blocks", () => {
    const text = buildBlockGuidance([])
    assert.ok(text.includes("Active compressed blocks in this session: 0"))
  })
})