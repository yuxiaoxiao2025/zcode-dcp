// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/token-utils.ts (estimation-only port)
// Behavior-faithful test suite for zcode-dcp/proxy/tokens.mjs
// Tests are independent of implementation: only consume the public surface defined in PLAN.md Task 4.

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  estimateTokens,
  estimateMessageTokens,
  parseUsageFromSseLine,
} from "../proxy/tokens.mjs"

// ---------- estimateTokens ----------

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0)
  })

  it("divides ASCII length by default ratio=4 and rounds", () => {
    // 12 ASCII chars / 4 = 3
    assert.equal(estimateTokens("hello world!"), 3)
  })

  it("honours a custom ratio", () => {
    // 8 ASCII chars / 2 = 4
    assert.equal(estimateTokens("abcdefgh", 2), 4)
  })

  it("weights CJK characters ~1.5 (len + cjkCount*0.5 then / ratio)", () => {
    // 4 pure CJK chars: len=4, cjkCount=4, weighted=4+4*0.5=6, /4 = 1.5 -> round = 2
    assert.equal(estimateTokens("你好世界"), 2)
  })

  it("weights mixed ASCII + CJK correctly", () => {
    // "hi你好" -> len=4, cjkCount=2 -> 4+2*0.5=5 -> /4 = 1.25 -> round = 1
    assert.equal(estimateTokens("hi你好"), 1)
  })

  it("rounds to nearest integer (banker's rounding via Math.round)", () => {
    // 5 ASCII chars -> 5/4 = 1.25 -> 1
    assert.equal(estimateTokens("abcde"), 1)
    // 7 ASCII chars -> 7/4 = 1.75 -> 2
    assert.equal(estimateTokens("abcdefg"), 2)
  })
})

// ---------- estimateMessageTokens ----------

describe("estimateMessageTokens", () => {
  it("counts a single user text block", () => {
    const msg = { role: "user", content: [{ type: "text", text: "hello world" }] }
    // "hello world" -> 11/4 = 2.75 -> 3
    assert.equal(estimateMessageTokens(msg), 3)
  })

  it("sums multiple text blocks in one message", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "hello" }, // 5/4 = 1.25 -> 1
        { type: "text", text: "world!" }, // 6/4 = 1.5 -> 2 (Math.round(1.5)=2 in V8)
      ],
    }
    assert.equal(estimateMessageTokens(msg), 3)
  })

  it("counts assistant tool_use blocks via JSON.stringify of the whole block", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: "/tmp/x.ts" },
        },
      ],
    }
    const json = JSON.stringify(msg.content[0])
    const expected = estimateTokens(json)
    assert.equal(estimateMessageTokens(msg), expected)
    // sanity: the stringified block is non-empty so tokens > 0
    assert.ok(expected > 0)
  })

  it("counts user tool_result string content", () => {
    const msg = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "the file contents go here",
        },
      ],
    }
    // 25 chars / 4 = 6.25 -> Math.round = 6
    assert.equal(estimateMessageTokens(msg), 6)
  })

  it("counts user tool_result array-of-blocks content (text blocks only)", () => {
    const msg = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_2",
          content: [
            { type: "text", text: "first part" }, // 10/4 = 2.5 -> 3 (Math.round rounds half away from zero in V8: 2.5->3)
            { type: "text", text: "second" }, // 6/4 = 1.5 -> 2
          ],
        },
      ],
    }
    assert.equal(estimateMessageTokens(msg), 5)
  })

  it("ignores non-text/non-tool_use/tool_result blocks (e.g. image blocks contribute 0)", () => {
    const msg = {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", data: "AAAA" } },
        { type: "text", text: "caption" }, // 7/4 = 1.75 -> 2
      ],
    }
    assert.equal(estimateMessageTokens(msg), 2)
  })

  it("returns 0 for empty content array", () => {
    assert.equal(estimateMessageTokens({ role: "user", content: [] }), 0)
  })

  it("handles string content (single text body on user message)", () => {
    const msg = { role: "user", content: "hello world" } // 11/4 = 2.75 -> 3
    assert.equal(estimateMessageTokens(msg), 3)
  })
})

// ---------- parseUsageFromSseLine ----------

describe("parseUsageFromSseLine", () => {
  it("returns null for empty / non-data lines", () => {
    assert.equal(parseUsageFromSseLine(""), null)
    assert.equal(parseUsageFromSseLine("event: message_start"), null)
    assert.equal(parseUsageFromSseLine(": heartbeat"), null)
    assert.equal(parseUsageFromSseLine("event: ping\ndata: {}"), null) // multi-line input not supported; only single line
  })

  it("returns null for data lines with no usage object", () => {
    assert.equal(parseUsageFromSseLine("data: {\"type\":\"message_start\",\"message\":{}}"), null)
    assert.equal(parseUsageFromSseLine("data: {\"type\":\"content_block_start\"}"), null)
  })

  it("extracts message_start usage at message.usage with all four fields", () => {
    const line =
      'data: {"type":"message_start","message":{"id":"m_1","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}}'
    assert.deepEqual(parseUsageFromSseLine(line), {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    })
  })

  it("extracts message_delta usage at top level", () => {
    const line =
      'data: {"type":"message_delta","usage":{"input_tokens":0,"output_tokens":55,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'
    assert.deepEqual(parseUsageFromSseLine(line), {
      inputTokens: 0,
      outputTokens: 55,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it("treats missing optional cache fields as 0", () => {
    const line =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":3}}}'
    assert.deepEqual(parseUsageFromSseLine(line), {
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it("tolerates a leading space after 'data:'", () => {
    const line =
      'data:  {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":2}}'
    assert.deepEqual(parseUsageFromSseLine(line), {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it("returns null on malformed JSON payload", () => {
    assert.equal(parseUsageFromSseLine("data: {not-json"), null)
  })
})
