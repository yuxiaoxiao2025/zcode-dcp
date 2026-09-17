// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/message-ids.ts + lib/messages/utils.ts + lib/messages/inject/inject.ts
// Behavior-faithful test suite for zcode-dcp/proxy/message-ids.mjs
// Tests are independent of implementation: only consume the public surface defined in PLAN.md Task 5.

import { describe, it } from "node:test"
import assert from "node:assert/strict"

// ---------- Helpers to build Anthropic-protocol message fixtures ----------

function userTextMessage(id, text) {
  return { role: "user", id, content: [{ type: "text", text }] }
}
function assistantTextMessage(id, text) {
  return { role: "assistant", id, content: [{ type: "text", text }] }
}
function userToolResultString(id, toolUseId, content) {
  // string-form tool_result (per Anthropic protocol)
  return {
    role: "user",
    id,
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  }
}
function userToolResultArray(id, toolUseId, blocks) {
  // array-form tool_result (per Anthropic protocol)
  return {
    role: "user",
    id,
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: blocks }],
  }
}
function userMixedToolResultWithText(id, toolUseId, blocks, prose) {
  // user message that also has text part(s) — used to verify user text injection
  return {
    role: "user",
    id,
    content: [...blocks, { type: "tool_result", tool_use_id: toolUseId, content: prose }],
  }
}
function assistantToolUse(id, toolUseId, name, input) {
  return {
    role: "assistant",
    id,
    content: [{ type: "tool_use", id: toolUseId, name, input }],
  }
}

const MOD = "../proxy/message-ids.mjs"

describe("message-ids — deterministic assignRefs", () => {
  it("assigns m0001..mNNNN sequentially by index, skipping non user/assistant roles", async () => {
    const { assignRefs } = await import(MOD)
    const messages = [
      userTextMessage("u1", "hi"),
      { role: "system", id: "s1", content: "system" }, // should be skipped
      assistantTextMessage("a1", "ok"),
      { role: "tool", id: "t1", content: "x" }, // should be skipped
      userTextMessage("u2", "again"),
    ]
    const r = assignRefs(messages)
    assert.equal(r.byIndex.get(0).ref, "m0001")
    assert.equal(r.byIndex.get(1), undefined) // system skipped
    assert.equal(r.byIndex.get(2).ref, "m0002")
    assert.equal(r.byIndex.get(3), undefined) // tool skipped
    assert.equal(r.byIndex.get(4).ref, "m0003")
    assert.equal(r.nextBlockId, "b1")
  })

  it("is deterministic — two calls over the same input produce identical refs", async () => {
    const { assignRefs } = await import(MOD)
    const messages = [
      userTextMessage("u1", "hi"),
      assistantTextMessage("a1", "ok"),
      userTextMessage("u2", "again"),
    ]
    const r1 = assignRefs(messages)
    const r2 = assignRefs(messages)
    assert.deepEqual([...r1.byIndex.entries()], [...r2.byIndex.entries()])
    assert.equal(r1.nextBlockId, r2.nextBlockId)
  })

  it("throws when message count exceeds 9999", async () => {
    const { assignRefs } = await import(MOD)
    // 9999 user messages + 1 more = 10000 -> throw
    const messages = []
    for (let i = 0; i < 9999; i++) {
      messages.push(userTextMessage(`u${i}`, "x"))
    }
    messages.push(userTextMessage("u9999", "x"))
    assert.throws(() => assignRefs(messages), /9999|capacity/i)
  })
})

describe("message-ids — formatMessageIdTag", () => {
  it("renders bare ref with no attributes when attrs omitted", async () => {
    const { formatMessageIdTag } = await import(MOD)
    assert.equal(formatMessageIdTag("m0007"), "\n<dcp-message-id>m0007</dcp-message-id>")
  })

  it("serializes attributes in alphabetical order", async () => {
    const { formatMessageIdTag } = await import(MOD)
    const tag = formatMessageIdTag("m0001", { zebra: "z", alpha: "a", middle: "m" })
    assert.equal(
      tag,
      '\n<dcp-message-id alpha="a" middle="m" zebra="z">m0001</dcp-message-id>',
    )
  })

  it("escapes XML special characters in attribute values", async () => {
    const { formatMessageIdTag } = await import(MOD)
    const tag = formatMessageIdTag("m0001", { label: `a&b<c>"d"` })
    assert.equal(
      tag,
      '\n<dcp-message-id label="a&amp;b&lt;c&gt;&quot;d&quot;">m0001</dcp-message-id>',
    )
  })

  it("drops empty-string and whitespace-only attribute names", async () => {
    const { formatMessageIdTag } = await import(MOD)
    const tag = formatMessageIdTag("m0001", { "": "ignored", "   ": "ignored", keep: "ok" })
    assert.equal(tag, '\n<dcp-message-id keep="ok">m0001</dcp-message-id>')
  })
})

describe("message-ids — injectMessageIds", () => {
  it("injects BLOCKED tag at end of last text block for blocked user message", async () => {
    const { assignRefs, injectMessageIds } = await import(MOD)
    const messages = [userTextMessage("u1", "hello")]
    const refs = assignRefs(messages)
    // Cross-file authorization (task-11 review I-2b): blockedSet is keyed by
    // INTEGER MESSAGE INDEX, not by raw message.id. The Anthropic /v1/messages
    // request body has no message.id field, so the upstream byMessageId
    // lookup would always miss.
    injectMessageIds(messages, refs, { blockedSet: new Set([0]) })
    assert.equal(
      messages[0].content[0].text,
      'hello\n\n<dcp-message-id>BLOCKED</dcp-message-id>',
    )
  })

  it("appends to each tool_result string content (string form)", async () => {
    const { assignRefs, injectMessageIds } = await import(MOD)
    const messages = [
      assistantToolUse("a1", "call-1", "Read", { path: "/x" }),
      userToolResultString("u1", "call-1", "the file content"),
    ]
    const refs = assignRefs(messages)
    injectMessageIds(messages, refs)
    const tr = messages[1].content[0]
    assert.equal(tr.content.endsWith("<dcp-message-id>m0002</dcp-message-id>"), true)
    assert.ok(tr.content.includes("the file content"))
  })

  it("appends a new text block to array-form tool_result content", async () => {
    const { assignRefs, injectMessageIds } = await import(MOD)
    const messages = [
      assistantToolUse("a1", "call-1", "Read", { path: "/x" }),
      userToolResultArray("u1", "call-1", [
        { type: "text", text: "first" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      ]),
    ]
    const refs = assignRefs(messages)
    injectMessageIds(messages, refs)
    const tr = messages[1].content[0]
    // Original blocks still present, plus a new text block appended.
    assert.equal(tr.content.length, 3)
    assert.equal(tr.content[0].type, "text")
    assert.equal(tr.content[1].type, "image")
    assert.equal(tr.content[2].type, "text")
    assert.equal(tr.content[2].text, "<dcp-message-id>m0002</dcp-message-id>")
  })

  it("appends to last text block for plain-text user message with no tool_result", async () => {
    const { assignRefs, injectMessageIds } = await import(MOD)
    const messages = [
      userTextMessage("u1", "hello world"),
      assistantTextMessage("a1", "ok"),
    ]
    const refs = assignRefs(messages)
    injectMessageIds(messages, refs)
    assert.equal(
      messages[0].content[0].text,
      'hello world\n\n<dcp-message-id>m0001</dcp-message-id>',
    )
    assert.equal(
      messages[1].content[0].text,
      'ok\n\n<dcp-message-id>m0002</dcp-message-id>',
    )
  })

  it("inserts a synthetic text block at the head when assistant has only tool_use parts", async () => {
    const { assignRefs, injectMessageIds } = await import(MOD)
    const messages = [assistantToolUse("a1", "call-1", "Read", { path: "/x" })]
    const refs = assignRefs(messages)
    injectMessageIds(messages, refs)
    // synthetic text part inserted before first tool part
    assert.equal(messages[0].content.length, 2)
    assert.equal(messages[0].content[0].type, "text")
    assert.equal(messages[0].content[0].text, "<dcp-message-id>m0001</dcp-message-id>")
    assert.equal(messages[0].content[1].type, "tool_use")
  })

  it("uses priority attribute when provided via priorityMap", async () => {
    const { assignRefs, injectMessageIds } = await import(MOD)
    const messages = [userTextMessage("u1", "hi")]
    const refs = assignRefs(messages)
    // Cross-file authorization (task-11 review I-2b): priorityMap is keyed
    // by INTEGER MESSAGE INDEX (Anthropic request bodies have no
    // message.id field). The value shape is the compress.mjs
    // buildPriorityMap entry: { ref, tokenCount, priority } — we extract
    // `priority` for the XML attribute.
    injectMessageIds(messages, refs, {
      priorityMap: new Map([[0, { ref: "m0001", tokenCount: 0, priority: "high" }]]),
      blockedSet: new Set(),
    })
    assert.equal(
      messages[0].content[0].text,
      'hi\n\n<dcp-message-id priority="high">m0001</dcp-message-id>',
    )
  })
})

describe("message-ids — STRIP_PATTERNS + stripDcpTags (4 categories)", () => {
  it("strips injected line-end <dcp-message-id>mNNNN</dcp-message-id> suffix", async () => {
    const { stripDcpTags } = await import(MOD)
    const messages = [
      userTextMessage("u1", "the original prompt\n<dcp-message-id>m0003</dcp-message-id>"),
    ]
    stripDcpTags(messages)
    // Source regex leaves the leading \n (lookbehind) — matches DCP source behaviour.
    assert.equal(messages[0].content[0].text, "the original prompt\n")
  })

  it("strips hallucinated \\nmN</parameter> suffix", async () => {
    const { stripDcpTags } = await import(MOD)
    const messages = [userTextMessage("u1", "some tool output\nm0007</parameter>")]
    stripDcpTags(messages)
    // Source regex leaves the leading \n (lookbehind) — matches DCP source behaviour.
    assert.equal(messages[0].content[0].text, "some tool output\n")
  })

  it("strips paired <dcp…>…</dcp…> blocks (multi-line, case-insensitive)", async () => {
    const { stripDcpTags } = await import(MOD)
    const messages = [
      assistantTextMessage(
        "a1",
        "before\n<DCP-MESSAGE-ID priority=\"high\">m0001</DCP-MESSAGE-ID>\nafter",
      ),
    ]
    stripDcpTags(messages)
    // The block on its own line is replaced by empty (newlines on either side remain).
    assert.equal(messages[0].content[0].text, "before\n\nafter")
  })

  it("strips unpaired <dcp…> tag fragments", async () => {
    const { stripDcpTags } = await import(MOD)
    const messages = [userTextMessage("u1", "alpha <dcp-message-id> beta")]
    stripDcpTags(messages)
    // Unpaired regex /<\/?dcp[^>]*>/gi requires a closing '>' — well-formed fragment removed.
    assert.equal(messages[0].content[0].text, "alpha  beta")
  })

  it("strips 4-pattern mix in one tool_result string", async () => {
    const { stripDcpTags } = await import(MOD)
    const messages = [
      userToolResultString(
        "u1",
        "call-1",
        [
          "line 1",
          "<dcp-message-id>m0001</dcp-message-id>", // paired tag (caught by DCP_PAIRED_TAG)
          "line 2",
          "m0009</parameter>", // hallucinated parameter mid-string (suffix regex requires EOL — left intact)
          "<dcp-system-reminder>hint</dcp-system-reminder>", // paired generic (caught by DCP_PAIRED_TAG)
          "stray <dcp-message-id> <foo>", // unpaired opening tag (caught by DCP_UNPAIRED_TAG)
          "trailing line", // padding so suffix regexes do not match at end
        ].join("\n"),
      ),
    ]
    stripDcpTags(messages)
    // Per source-faithful behaviour (DCP lib/messages/utils.ts:7-11):
    //   - paired <dcp…>…</dcp…>   -> removed (lazy [\s\S]*? across newlines)
    //   - unpaired <dcp…>         -> removed
    //   - suffix regexes only fire at end-of-string with leading \n lookbehind
    // So mid-string m0009</parameter> remains; only paired + unpaired are scrubbed.
    const expected =
      "line 1\n\nline 2\nm0009</parameter>\n\nstray  <foo>\ntrailing line"
    assert.equal(messages[0].content[0].content, expected)
  })
})