// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/token-utils.ts
// Behavior-faithful port (estimation only — no Anthropic tokenizer dependency).
// Original copyright:
//   Copyright (c) opencode-dcp authors
//
// Differences from upstream:
//   * No Anthropic tokenizer (zero-dep); estimateTokens always uses the
//     `Math.round(text.length / 4)` fallback semantics from token-utils.ts:69-76,
//     augmented with a CJK ~1.5x weight approximation per PLAN.md Task 4.
//   * No SessionState/WithParts coupling; this is a pure stateless utility
//     module consumed by the proxy (countAllMessageTokens semantics are
//     preserved in estimateMessageTokens — text blocks + tool_use JSON +
//     tool_result text content).

// CJK Unified Ideographs + common CJK extension blocks.
// Source: Unicode ranges U+3000–U+303F (CJK symbols), U+3400–U+4DBF (Ext A),
// U+4E00–U+9FFF (CJK Unified), U+AC00–U+D7AF (Hangul — weighted similarly),
// U+F900–U+FAFF (CJK Compat Ideographs), U+FF00–U+FFEF (Fullwidth).
const CJK_REGEX = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/g

/**
 * Estimate token count for a text string.
 *
 * Faithful to DCP `lib/token-utils.ts:69-76` fallback semantics
 * (`Math.round(text.length / 4)`) when the official Anthropic tokenizer
 * is unavailable, with an additional ~1.5x weight for CJK characters
 * (PLAN.md Task 4):
 *
 *     weightedLen = len + cjkCount * 0.5
 *     tokens      = Math.round(weightedLen / ratio)
 *
 * @param {string} text
 * @param {number} [ratio=4]  Approx chars per token (default ASCII ratio).
 * @returns {number}
 */
export function estimateTokens(text, ratio = 4) {
  if (!text) return 0
  if (typeof text !== "string") return 0
  const len = text.length
  const cjkMatches = text.match(CJK_REGEX)
  const cjkCount = cjkMatches ? cjkMatches.length : 0
  const weighted = len + cjkCount * 0.5
  return Math.round(weighted / ratio)
}

/**
 * Normalize an Anthropic-protocol content field to an array of content
 * blocks, so downstream code can iterate uniformly.
 *
 * Accepts:
 *   * `[{type:"text",...}, ...]` — array form (most blocks)
 *   * `"plain string"`            — shorthand string body (Anthropic allows
 *                                   this on `user` messages; treated as a
 *                                   single text block)
 *
 * @param {unknown} content
 * @returns {Array<object>}
 */
function normalizeContent(content) {
  if (content == null) return []
  if (typeof content === "string") {
    return [{ type: "text", text: content }]
  }
  if (Array.isArray(content)) return content
  return []
}

/**
 * Estimate tokens for one Anthropic-protocol message.
 *
 * Behavior-faithful to DCP `lib/token-utils.ts:152-164`
 * `countAllMessageTokens` — sums **all text** plus **all tool content**:
 *
 *   * `{type:"text",text}`            → estimateTokens(text)
 *   * `{type:"tool_use",...}`         → estimateTokens(JSON.stringify(block))
 *   * `{type:"tool_result",content}`  → string content as-is; array content
 *                                       summed over its text blocks
 *   * everything else (image, etc.)   → contributes 0
 *
 * @param {{role?:string, content:unknown}} msg
 * @returns {number}
 */
export function estimateMessageTokens(msg) {
  if (!msg || msg.content == null) return 0
  const blocks = normalizeContent(msg.content)
  if (blocks.length === 0) return 0

  let total = 0
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue
    const type = block.type
    if (type === "text") {
      total += estimateTokens(typeof block.text === "string" ? block.text : "")
    } else if (type === "tool_use") {
      // Whole block serialized (matches DCP `extractToolContent` for tool input)
      total += estimateTokens(JSON.stringify(block))
    } else if (type === "tool_result") {
      const c = block.content
      if (typeof c === "string") {
        total += estimateTokens(c)
      } else if (Array.isArray(c)) {
        for (const sub of c) {
          if (sub && sub.type === "text") {
            total += estimateTokens(typeof sub.text === "string" ? sub.text : "")
          }
        }
      }
    }
    // Other block types (image, tool_use_result, etc.) intentionally
    // contribute 0 — they have no textual estimate surface here.
  }
  return total
}

/**
 * Parse an Anthropic SSE `data: {...}` line and extract usage into a
 * normalized shape `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`.
 *
 * Compatible with both SSE event shapes emitted by the upstream API:
 *
 *   1. `message_start` — usage lives at `message.usage`:
 *        `{"type":"message_start","message":{"usage":{...}}}`
 *   2. `message_delta` — usage lives at top level:
 *        `{"type":"message_delta","usage":{...}}}`
 *
 * Field mapping (Anthropic → normalized):
 *   input_tokens              → inputTokens
 *   output_tokens             → outputTokens
 *   cache_read_input_tokens   → cacheReadTokens
 *   cache_creation_input_tokens → cacheWriteTokens
 *
 * Missing optional cache fields default to 0. Any line that is not a
 * `data:` payload, or that carries no usage object, returns `null`.
 *
 * @param {string} line  A single SSE line (no embedded newlines expected).
 * @returns {{inputTokens:number, outputTokens:number, cacheReadTokens:number, cacheWriteTokens:number} | null}
 */
export function parseUsageFromSseLine(line) {
  if (typeof line !== "string" || line.length === 0) return null
  if (!line.startsWith("data:")) return null
  // Strip optional leading whitespace after "data:" per SSE spec.
  const payload = line.slice(5).replace(/^\s+/, "")
  if (!payload) return null
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null

  // Two valid locations for usage:
  const usage =
    (parsed.message && typeof parsed.message === "object" && parsed.message.usage) ||
    (parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null)

  if (!usage) return null

  const input = Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0
  const output = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0
  const cacheRead = Number.isFinite(usage.cache_read_input_tokens)
    ? usage.cache_read_input_tokens
    : 0
  const cacheWrite = Number.isFinite(usage.cache_creation_input_tokens)
    ? usage.cache_creation_input_tokens
    : 0

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}
