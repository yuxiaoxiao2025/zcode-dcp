// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/messages/inject/inject.ts +
//                                                  lib/messages/inject/utils.ts +
//                                                  lib/prompts/extensions/nudge.ts
// Original copyright:
//   Copyright (c) Opencode-DCP authors. Licensed under AGPL-3.0-or-later.
//
// Behavior-faithful port adapted to ZCode Anthropic-protocol proxy (stateless).
// Differences from upstream (documented in docs/current/CAPABILITY-MAPPING.md):
//   * The upstream `injectCompressNudges` mutates a `SessionState` in place; the
//     ZCode proxy is stateless across requests, so planNudges returns an
//     `anchorUpdates` object describing what the caller should persist into the
//     light state — never mutates `lightState` directly. The anchor buckets
//     (context/turn/iter) store integer message INDEXES (not raw ids) — see
//     PLAN.md task-5 / task-9 "key by index" decision; Anthropic /v1/messages
//     requests don't carry a message `id` field.
//   * `getModelInfo` / `getLastUserMessage` are unnecessary here: the caller
//     already knows the provider/model when it constructs the proxy request.
//     planNudges receives `providerId` / `modelId` derived from the upstream
//     request body (or undefined) and passes them straight into
//     resolveContextTokenLimit — the limit resolution + percent conversion +
//     summary-buffer accounting remain faithful to utils.ts:87-163. The
//     `getActiveSummaryTokenUsage` port estimates raw block summaries at the
//     default 4 chars/token ratio; this matches upstream semantics for
//     "tokens consumed by active summaries" but may differ by the wrapper
//     header/footer overhead of a fully-enhanced summary (tens of tokens per
//     block). Acceptable approximation: the buffer is a soft ceiling, not a
//     hard budget, and a few-tokens deviation never changes a yes/no trigger.
//   * `messageHasCompress` adapted to Anthropic protocol: scans for a
//     `tool_use` block whose `name` matches the configured compress tool
//     pattern and whose corresponding `tool_result` (in the next user
//     message) has `is_error !== true`. Status field is read when present.
//   * `findLastNonIgnoredMessage` reduced to "last message" — the proxy
//     stateless model has no "ignored" annotation (no SessionState.ignored),
//     so the only filter is the role+message-shape existence check.
//   * `applyNudges` is the reverse of `injectMessageIds`: it appends (user) or
//     prepends (assistant) reminder-wrapped nudge text onto the matched
//     message, deduping with `includes`. Returns a NEW messages array; never
//     mutates the caller's array (matches inject.ts:145-215 mutation safety +
//     task-6 C-1 immutable-copy lesson).

import { wrapReminder } from "./prompts.mjs"
import { buildBlockGuidance } from "./compress.mjs"
import { estimateTokens } from "./tokens.mjs"

// ---------------------------------------------------------------------------
// Helpers — port of utils.ts:87-130 (limit parsing)
// ---------------------------------------------------------------------------

const DCP_TAG_CLOSE = "</dcp-system-reminder>"

/**
 * Parse a single limit value (utils.ts:94-115 verbatim):
 *   - number  → returned as-is
 *   - "N%"    → (N clamped to 0-100) / 100 * modelContextLimit; returns undefined
 *               if there is no modelContextLimit to convert against
 *   - other   → undefined
 */
function parseLimitValue(limit, modelContextLimit) {
  if (limit === undefined) return undefined
  if (typeof limit === "number") return limit
  if (typeof limit !== "string") return undefined
  if (!limit.endsWith("%")) return undefined
  if (modelContextLimit === undefined || modelContextLimit === null) return undefined
  const parsedPercent = parseFloat(limit.slice(0, -1))
  if (Number.isNaN(parsedPercent)) return undefined
  const roundedPercent = Math.round(parsedPercent)
  const clampedPercent = Math.max(0, Math.min(100, roundedPercent))
  return Math.round((clampedPercent / 100) * Number(modelContextLimit))
}

/**
 * Resolve the max/min token limit for a given provider/model pair
 * (utils.ts:87-130 verbatim precedence):
 *   1. modelMaxLimits / modelMinLimits["provider/model"] (per-model override)
 *   2. global compress.maxContextLimit / compress.minContextLimit
 *
 * Returns `undefined` if neither source yields a value.
 */
function resolveContextTokenLimit(config, providerId, modelId, modelContextLimit, threshold) {
  const modelLimits =
    threshold === "max" ? config.compress.modelMaxLimits : config.compress.modelMinLimits
  if (modelLimits && providerId !== undefined && modelId !== undefined) {
    const key = `${providerId}/${modelId}`
    const modelLimit = modelLimits[key]
    if (modelLimit !== undefined) {
      return parseLimitValue(modelLimit, modelContextLimit)
    }
  }
  const globalLimit =
    threshold === "max" ? config.compress.maxContextLimit : config.compress.minContextLimit
  return parseLimitValue(globalLimit, modelContextLimit)
}

/**
 * Sum active summary tokens (utils.ts:139 — getActiveSummaryTokenUsage inline).
 * Faithful: each block's rawSummary is estimated at the default ratio; the
 * block must NOT be in any other block's consumedBlockIds list to count
 * (active = "not consumed by anyone").
 */
function getActiveSummaryTokenUsage(activeBlocks) {
  if (!Array.isArray(activeBlocks) || activeBlocks.length === 0) return 0
  const consumed = new Set()
  for (const b of activeBlocks) {
    if (Array.isArray(b && b.consumedBlockIds)) {
      for (const id of b.consumedBlockIds) consumed.add(Number(id))
    }
  }
  let total = 0
  for (const b of activeBlocks) {
    if (!b || typeof b.blockId !== "string") continue
    const id = parseInt(b.blockId.slice(1), 10)
    if (consumed.has(id)) continue
    const raw = typeof b.rawSummary === "string" ? b.rawSummary : ""
    total += estimateTokens(raw)
  }
  return total
}

/**
 * Compute "overMaxLimit" / "overMinLimit" (utils.ts:132-163 verbatim).
 *
 * `currentTokens` is the upstream-reported total (inputTokens + outputTokens +
 * cacheReadTokens + cacheWriteTokens) — proxy tee-parses the SSE usage line
 * and passes it as `usage` to planNudges. This faithfully matches
 * `getCurrentTokenUsage(state, messages)` upstream: the SessionState already
 * tracks the latest API-reported usage, so the proxy takes it as an argument
 * rather than re-deriving from messages (we'd just be re-tokenizing what the
 * upstream API already gave us for free).
 *
 * Summary buffer: when `compress.summaryBuffer === true`, the active-block
 * summary tokens are added to the resolved max threshold (utils.ts:139-141).
 */
function isContextOverLimits(config, providerId, modelId, modelContextLimit, usage, activeBlocks) {
  const summaryExtension =
    config.compress && config.compress.summaryBuffer
      ? getActiveSummaryTokenUsage(activeBlocks)
      : 0
  const resolvedMax = resolveContextTokenLimit(
    config,
    providerId,
    modelId,
    modelContextLimit,
    "max",
  )
  const maxWithBuffer =
    resolvedMax === undefined ? undefined : resolvedMax + summaryExtension
  const min = resolveContextTokenLimit(config, providerId, modelId, modelContextLimit, "min")

  const current = currentUsageTokens(usage)
  const overMaxLimit = maxWithBuffer === undefined ? false : current > maxWithBuffer
  // Upstream semantics: if no min is configured, treat as "over min" so the
  // middle branch (turn / iteration) does not gate on it (utils.ts:157).
  const overMinLimit = min === undefined ? true : current >= min

  return { overMaxLimit, overMinLimit, current }
}

function currentUsageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0
  return (
    (Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0) +
    (Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0) +
    (Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0) +
    (Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0)
  )
}

// ---------------------------------------------------------------------------
// Helpers — anchor bookkeeping (utils.ts:165-193 verbatim)
// ---------------------------------------------------------------------------

/**
 * Throttled anchor insertion (utils.ts:165-193 verbatim). `anchorIndex` is the
 * integer index into `messages`; `anchorIds` stores indices in a Set, so the
 * "is this anchor already present" lookup is direct.
 *
 * Returns `true` if the anchor was newly added (caller persists to state),
 * `false` if it was throttled or invalid.
 */
function addAnchor(anchorIds, anchorIndex, messages, interval) {
  if (typeof anchorIndex !== "number" || anchorIndex < 0) return false
  if (anchorIndex >= messages.length) return false

  // Find latest existing anchor index (utils.ts:176-181 walk from tail).
  let latestAnchorIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (anchorIds.has(i)) {
      latestAnchorIndex = i
      break
    }
  }
  const shouldAdd =
    latestAnchorIndex < 0 || anchorIndex - latestAnchorIndex >= interval
  if (!shouldAdd) return false

  const previousSize = anchorIds.size
  anchorIds.add(anchorIndex)
  return anchorIds.size !== previousSize
}

// ---------------------------------------------------------------------------
// Helpers — compress-recognition (DCP query.ts:22-36 adapted to Anthropic)
// ---------------------------------------------------------------------------

function isToolNameMatch(name, pattern) {
  if (!name || !pattern) return false
  const regex = new RegExp(
    "^" +
      String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*") +
      "$",
  )
  return regex.test(name)
}

/**
 * Equivalent of DCP `messageHasCompress` (query.ts:22-36) adapted to
 * Anthropic-protocol message shapes. A "completed compress" is an assistant
 * tool_use whose `name` matches the configured compress tool pattern AND whose
 * following user message carries a tool_result with matching `tool_use_id`
 * and `is_error !== true`.
 */
function messageHasCompress(message, messages, index, toolPattern) {
  if (!message || message.role !== "assistant") return false
  if (!Array.isArray(message.content)) return false
  let toolUse = null
  for (const part of message.content) {
    if (part && part.type === "tool_use") {
      toolUse = part
      break
    }
  }
  if (!toolUse || !toolUse.name) return false
  if (!isToolNameMatch(toolUse.name, toolPattern)) return false
  // Status check (DCP parity): some Anthropic tool_use blocks carry a `status`
  // field; we honour it if present but don't require it (Anthropic's protocol
  // doesn't mandate it).
  if (toolUse.status && toolUse.status !== "completed") return false
  // The "completed" check upstream is: the next user message has a matching
  // tool_result with no is_error. We mirror that:
  const next = index + 1 < messages.length ? messages[index + 1] : null
  if (!next || next.role !== "user") return false
  if (!Array.isArray(next.content)) return false
  for (const part of next.content) {
    if (!part || part.type !== "tool_result") continue
    if (part.tool_use_id !== toolUse.id) continue
    if (part.is_error === true) return false
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Helpers — guidance insertion (nudge.ts:28-43 verbatim)
// ---------------------------------------------------------------------------

/**
 * `appendGuidanceToDcpTag` (nudge.ts:28-43 verbatim). Inserts guidance text
 * immediately before `</dcp-system-reminder>`. If there is no close tag, the
 * nudge text is returned unchanged (the caller will surface this as a no-op).
 *
 * Exported (I-2): task-11 pipeline layer reuses this for message-mode
 * priority guidance composition. The signature is identical to upstream
 * (nudge.ts:28) so the pipeline call site stays one-to-one.
 */
export function appendGuidanceToDcpTag(nudgeText, guidance) {
  if (!guidance || !guidance.trim()) return nudgeText
  const idx = nudgeText.lastIndexOf(DCP_TAG_CLOSE)
  if (idx === -1) return nudgeText
  const beforeClose = nudgeText.slice(0, idx).trimEnd()
  const afterClose = nudgeText.slice(idx)
  return `${beforeClose}\n\n${guidance}\n${afterClose}`
}

// ---------------------------------------------------------------------------
// Helpers — message-shape utilities
// ---------------------------------------------------------------------------

function findLastNonIgnoredMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.role !== "user" && msg.role !== "assistant") continue
    return { message: msg, index: i }
  }
  return null
}

function findLastAssistantMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg && msg.role === "assistant") {
      return { message: msg, index: i }
    }
  }
  return null
}

function getLastUserMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg && msg.role === "user") return i
  }
  return -1
}

/**
 * `countMessagesAfterIndex` (utils.ts:57-69) — counts user/assistant messages
 * strictly after `index` (so `index + 1 .. end`). Reduced ignore filter: no
 * SessionState.ignored annotation in the proxy model.
 */
function countMessagesAfterIndex(messages, index) {
  let count = 0
  for (let i = index + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.role !== "user" && msg.role !== "assistant") continue
    count++
  }
  return count
}

// ---------------------------------------------------------------------------
// planNudges (PLAN Task 8 signature)
// ---------------------------------------------------------------------------

/**
 * Compute the nudge plan: list of injections + anchor updates.
 *
 * Mirrors DCP `injectCompressNudges` (inject.ts:33-143) on the control-flow
 * shape:
 *   1. permission=deny    → return empty (no anchors changed)
 *   2. manualMode=true    → return empty
 *   3. last assistant has completed compress → clear all anchors, return empty
 *   4. compute overMaxLimit / overMinLimit
 *   5. !overMinLimit → clear turn + iter anchors (keep context)
 *   6. overMaxLimit → addAnchor(contextLimitAnchors, lastMessage)
 *      else if overMinLimit → record turn anchors (last user + last assistant)
 *                            + maybe addAnchor(iterationNudgeAnchors, lastMessage)
 *   7. applyAnchoredNudges (turn role filtered by nudgeForce)
 *
 * Returns `{injections, anchorUpdates}` — and **also** an optional `skipped`
 * string field for defensive signals:
 *   - `"empty-messages"` — `messages` was not a non-empty array (no history to
 *     nudge; pipeline callsite likely just initialised a fresh session)
 *   - `"no-usage"`       — `usage` was null/undefined/non-object (first request
 *     before any SSE usage has been tee-parsed; nudging without a token budget
 *     would mislead the model)
 *
 * These `skipped` cases return an empty plan rather than throwing — the
 * planNudges contract is "advisory". The pipeline caller can branch on the
 * `skipped` field if it wants to log why no nudges were emitted.
 *
 * @param {Array} messages
 * @param {object} config
 * @param {{contextLimitNudge:string, turnNudge:string, iterationNudge:string}} prompts
 * @param {{inputTokens:number, outputTokens:number, cacheReadTokens:number, cacheWriteTokens:number} | null} usage
 * @param {object} lightState — { anchors:{context:[],turn:[],iter:[]}, manualMode:boolean, ... }
 * @param {Array} [activeBlocks] — optional array of compress blocks (for guidance + summary buffer)
 * @returns {{injections: Array<{index:number, role:"user"|"assistant", text:string}>, anchorUpdates:{context:number[], turn:number[], iter:number[]}, skipped?: "empty-messages"|"no-usage"}}
 */
export function planNudges(messages, config, prompts, usage, lightState, activeBlocks) {
  // C-2 (silent-hunt defensive): non-array / empty messages → skipped signal.
  // A request with no messages has no anchors to track and no nudge to inject;
  // returning a structured "skipped" lets the pipeline log the situation
  // without us pretending we processed it.
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      injections: [],
      anchorUpdates: { context: [], turn: [], iter: [] },
      skipped: "empty-messages",
    }
  }

  // C-3 (silent-hunt defensive): null/undefined/non-object usage → skipped.
  // First request: no upstream usage has been tee-parsed yet. Pushing a
  // nudge without a token budget would invite the model to compress
  // prematurely (the upstream hasn't even told us how big context is).
  if (usage == null || typeof usage !== "object") {
    return {
      injections: [],
      anchorUpdates: { context: [], turn: [], iter: [] },
      skipped: "no-usage",
    }
  }

  // C-3 strict (caller-bug guard): usage is an object but its fields are
  // NaN/Infinity → throw RangeError. This is a programming error upstream
  // (an SSE line was misparsed into NaN, or an arithmetic op went wrong);
  // failing fast surfaces the bug instead of producing a silently wrong plan.
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    const v = usage[field]
    if (typeof v === "number" && (!Number.isFinite(v) || Number.isNaN(v))) {
      throw new RangeError(
        `planNudges: usage.${field} is non-finite (${v}); upstream SSE parser likely produced NaN`,
      )
    }
  }

  const safeMessages = messages
  const safePrompts =
    prompts && typeof prompts === "object"
      ? prompts
      : { contextLimitNudge: "", turnNudge: "", iterationNudge: "" }
  const safeConfig = config || {}
  const safeState =
    lightState && typeof lightState === "object"
      ? lightState
      : { anchors: { context: [], turn: [], iter: [] }, manualMode: false }
  const safeBlocks = Array.isArray(activeBlocks) ? activeBlocks : []

  const emptyAnchors = () => ({ context: [], turn: [], iter: [] })
  const emptyInjections = () => []

  // Gate 1: permission=deny (compress-permission module reads state; we use
  // the config.compress.permission directly — gate lives at the top of
  // inject.ts:41-43).
  if (safeConfig.compress && safeConfig.compress.permission === "deny") {
    return { injections: emptyInjections(), anchorUpdates: emptyAnchors() }
  }

  // Gate 2: manualMode (inject.ts:45-47).
  if (safeState.manualMode === true) {
    return { injections: emptyInjections(), anchorUpdates: emptyAnchors() }
  }

  const last = findLastNonIgnoredMessage(safeMessages)
  const lastAssistant = findLastAssistantMessage(safeMessages)

  // Gate 3: last assistant has completed compress tool_use → clear all and
  // return (inject.ts:52-58). We treat this as the same shape as upstream.
  const compressToolPattern =
    (safeConfig.compress && safeConfig.compress.compressToolName) || "mcp__*__compress"
  if (lastAssistant && messageHasCompress(lastAssistant.message, safeMessages, lastAssistant.index, compressToolPattern)) {
    return { injections: emptyInjections(), anchorUpdates: emptyAnchors() }
  }

  // Compute overMax / overMin (utils.ts:132-163 semantics).
  // We accept optional providerId / modelId / modelContextLimit on config
  // (proxy caller supplies them from the request body). Defaults are
  // undefined → fallback paths in resolveContextTokenLimit apply.
  const providerId = safeConfig.providerId
  const modelId = safeConfig.modelId
  const modelContextLimit =
    safeConfig.modelContextLimit !== undefined
      ? safeConfig.modelContextLimit
      : safeConfig.contextWindow

  const { overMaxLimit, overMinLimit } = isContextOverLimits(
    safeConfig,
    providerId,
    modelId,
    modelContextLimit,
    usage,
    safeBlocks,
  )

  // C-4 (silent-hunt defensive): filter anchor Sets on load so a poisoned
  // light-state file (negative indices, non-integers, NaN from a prior bug)
  // can't survive into this plan. We keep only `Number.isInteger(i) && i >= 0`.
  // This prevents long-term state pollution via the persistence boundary.
  const sanitiseAnchors = (raw) => {
    if (!Array.isArray(raw)) return []
    const out = []
    const seen = new Set()
    for (const v of raw) {
      if (!Number.isInteger(v) || v < 0) continue
      if (v >= safeMessages.length) continue // out-of-bounds: drop silently
      if (seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
    return out
  }

  // Local mutable copies for the duration of this call. They are returned as
  // anchorUpdates; the caller's lightState is never mutated.
  const nextContext = new Set(
    sanitiseAnchors(safeState.anchors && safeState.anchors.context),
  )
  const nextTurn = new Set(sanitiseAnchors(safeState.anchors && safeState.anchors.turn))
  const nextIter = new Set(sanitiseAnchors(safeState.anchors && safeState.anchors.iter))

  // Clear turn + iter when usage falls below min (inject.ts:71-80 + SPEC R6
  // Scenario4 勘误版: contextLimitAnchors are NOT cleared).
  if (!overMinLimit) {
    if (nextTurn.size > 0 || nextIter.size > 0) {
      nextTurn.clear()
      nextIter.clear()
    }
  }

  if (overMaxLimit) {
    if (last) {
      const interval = getNudgeFrequency(safeConfig)
      addAnchor(nextContext, last.index, safeMessages, interval)
    }
  } else if (overMinLimit) {
    const isLastMessageUser = last && last.message.role === "user"

    // Turn anchors (inject.ts:99-106): last user + previous assistant.
    if (isLastMessageUser && lastAssistant) {
      nextTurn.add(last.index)
      nextTurn.add(lastAssistant.index)
    }

    // Iteration (inject.ts:108-135): count messages after last user; if above
    // iterationNudgeThreshold and last non-ignored message is past the user,
    // addAnchor(iter, last).
    const lastUserIdx = getLastUserMessageIndex(safeMessages)
    if (lastUserIdx >= 0 && last && last.index > lastUserIdx) {
      const since = countMessagesAfterIndex(safeMessages, lastUserIdx)
      const threshold = getIterationNudgeThreshold(safeConfig)
      if (since >= threshold) {
        const interval = getNudgeFrequency(safeConfig)
        addAnchor(nextIter, last.index, safeMessages, interval)
      }
    }
  }

  // Build injections from the resulting anchor sets (utils.ts:324-374 + 211-248
  // adapt — see applyAnchoredNudges below for the role filter).
  // I-6 (silent-hunt defensive): an injection with empty finalText is a
  // pointless message-cycle (nudge injection loop), so we drop it AND
  // remove the offending index from the corresponding anchor SET so the
  // update propagates to the caller's persisted light-state.
  const injections = []
  for (const { bucket, set, prompt, guidance, kind, targets } of [
    { bucket: "context", set: nextContext, prompt: safePrompts.contextLimitNudge, guidance: buildGuidance(safeConfig, safeBlocks), kind: "contextLimitNudge", targets: "context" },
    { bucket: "turn", set: filteredTurnAnchors(safeMessages, nextTurn, safeConfig), prompt: safePrompts.turnNudge, guidance: buildGuidance(safeConfig, safeBlocks), kind: "turnNudge", targets: "turn" },
    { bucket: "iter", set: nextIter, prompt: safePrompts.iterationNudge, guidance: buildGuidance(safeConfig, safeBlocks), kind: "iterationNudge", targets: "iter" },
  ]) {
    for (const idx of set) {
      const msg = safeMessages[idx]
      if (!msg) {
        // Out-of-bounds after sanitisation (defensive) — prune from set.
        set.delete(idx)
        continue
      }
      if (msg.role !== "user" && msg.role !== "assistant") {
        // Unexpected role — prune from set.
        set.delete(idx)
        continue
      }
      const wrapped = wrapReminder(kind, prompt || "")
      if (!wrapped) {
        // Empty prompt (e.g. loadPrompts returned "" for this kind). The
        // injection would be empty after wrapping, which would loop on
        // every request — prune.
        set.delete(idx)
        continue
      }
      const finalText = guidance ? appendGuidanceToDcpTag(wrapped, guidance) : wrapped
      if (!finalText.trim()) {
        set.delete(idx)
        continue
      }
      injections.push({ index: idx, role: msg.role, text: finalText, kind })
    }
  }

  return {
    injections,
    anchorUpdates: {
      context: [...nextContext],
      turn: [...nextTurn],
      iter: [...nextIter],
    },
  }
}

function buildGuidance(safeConfig, safeBlocks) {
  // Range mode: append blockGuidance to each injection's reminder tag.
  // Message mode: skip — pipeline layer composes priority guidance via the
  // shared appendGuidanceToDcpTag helper (exported below for task-11).
  const mode = safeConfig.compress && safeConfig.compress.mode === "message" ? "message" : "range"
  if (mode !== "range") return ""
  return buildBlockGuidance(safeBlocks || [])
}

function filteredTurnAnchors(messages, turnAnchors, safeConfig) {
  const targetRole =
    safeConfig.compress && safeConfig.compress.nudgeForce === "strong" ? "user" : "assistant"
  const out = new Set()
  for (const idx of turnAnchors) {
    const msg = messages[idx]
    if (!msg) continue
    if (msg.role === targetRole) out.add(idx)
  }
  return out
}

function getNudgeFrequency(config) {
  return Math.max(1, Math.floor((config && config.compress && config.compress.nudgeFrequency) || 1))
}

function getIterationNudgeThreshold(config) {
  return Math.max(
    1,
    Math.floor((config && config.compress && config.compress.iterationNudgeThreshold) || 1),
  )
}

// ---------------------------------------------------------------------------
// applyNudges (PLAN Task 8 signature) — immutable message-array rewrite
// ---------------------------------------------------------------------------

/**
 * Apply a list of injections to a deep copy of `messages` and return it.
 *
 * Per-message injection (utils.ts:211-248 adapted):
 *   - user     → append to last text block; synthesize a text block if none
 *   - assistant → append to FIRST text block (mirrors inject.ts:145-215's
 *                 assistant ladder: try tool_parts → last_text → last_text
 *                 of first_tool); synthesize text before the first tool_use
 *                 if no text parts exist (hasContent gate skipped for
 *                 "parts.length > 0 but no text")
 *
 * Idempotence: if the injected text (or its normalized form) already appears
 * in the target text block, the call is a no-op (uses `includes`). This
 * matches `appendToTextPart`'s includes check (message-ids.mjs:160).
 *
 * Immutability: the input array AND every modified message are deep-cloned
 * before mutation (task-6 C-1 lesson — never mutate the caller's array).
 *
 * C-1 (silent-hunt defensive): an injection whose `role` does not match the
 * message role at `inj.index` is a programming error — planNudges only
 * emits injections whose role was sampled from the message at that index,
 * so a mismatch means the caller re-used an injection against a different
 * messages array. We throw rather than silently skip: the previous "continue"
 * behaviour hid bugs in the pipeline orchestration layer.
 *
 * Throws TypeError on:
 *   - non-array messages / injections
 *   - injection with non-string `text`
 *   - injection.role mismatch (C-1)
 */
export function applyNudges(messages, injections) {
  if (!Array.isArray(messages)) {
    throw new TypeError("applyNudges: messages must be an array")
  }
  if (!Array.isArray(injections)) {
    throw new TypeError("applyNudges: injections must be an array")
  }

  if (injections.length === 0) {
    // Still return a fresh array so callers can't accidentally mutate input.
    return messages.map(cloneMessageShallow)
  }

  // Validate each injection up-front — fail fast on contract violations.
  for (let k = 0; k < injections.length; k++) {
    const inj = injections[k]
    if (!inj || typeof inj !== "object") {
      throw new TypeError(`applyNudges: injections[${k}] is not an object`)
    }
    if (typeof inj.index !== "number" || inj.index < 0 || inj.index >= messages.length) {
      throw new RangeError(
        `applyNudges: injections[${k}].index=${inj.index} is out of bounds (messages.length=${messages.length})`,
      )
    }
    if (inj.role !== "user" && inj.role !== "assistant") {
      throw new TypeError(`applyNudges: injections[${k}].role must be "user"|"assistant", got ${JSON.stringify(inj.role)}`)
    }
    if (typeof inj.text !== "string") {
      throw new TypeError(`applyNudges: injections[${k}].text must be a string`)
    }
  }

  // C-1: role match against the message at inj.index. planNudges always
  // emits injections whose role was sampled from messages[idx]; if applyNudges
  // is reused with a different messages array, the mismatch surfaces here.
  for (let k = 0; k < injections.length; k++) {
    const inj = injections[k]
    const target = messages[inj.index]
    if (target.role !== inj.role) {
      throw new TypeError(
        `applyNudges: injections[${k}] targets ${inj.role} at index ${inj.index} but messages[${inj.index}].role=${JSON.stringify(target.role)} — caller reused an injection against a different messages array`,
      )
    }
  }

  // Build the set of indices we'll touch so we only clone those messages.
  const touched = new Set()
  for (const inj of injections) {
    touched.add(inj.index)
  }

  const out = messages.map((msg, i) => (touched.has(i) ? cloneMessageDeep(msg) : cloneMessageShallow(msg)))

  for (const inj of injections) {
    const text = inj.text
    if (!text) continue // empty text → no-op (contract: caller passed empty)
    const msg = out[inj.index]
    injectIntoMessage(msg, text)
  }

  return out
}

function cloneMessageShallow(msg) {
  if (!msg || typeof msg !== "object") return msg
  return { ...msg }
}

function cloneMessageDeep(msg) {
  if (!msg || typeof msg !== "object") return msg
  const out = { ...msg }
  if (Array.isArray(msg.content)) {
    out.content = msg.content.map((part) => {
      if (!part || typeof part !== "object") return part
      const cloned = { ...part }
      if (Array.isArray(part.content)) {
        cloned.content = part.content.map((c) => (c && typeof c === "object" ? { ...c } : c))
      }
      return cloned
    })
  }
  return out
}

/**
 * Append `text` to the matching slot of `message` based on its role.
 * Idempotent (already-present text = no-op).
 *
 * Source-faithful ladder (utils.ts:233-247 in
 * lib/messages/inject/utils.ts → `injectAnchoredNudge`):
 *   - user     → last text block; synthesize at end if none
 *   - assistant → FIRST text block; if no text parts exist at all, synthesize
 *                 a text block BEFORE the first tool_use (or at the end if no
 *                 tool_use either) — hasContent gate mirrors utils.ts:229-231
 *                 so empty-content assistants (tool_use only) get a synthetic
 *                 head, while truly content-less messages (no parts at all)
 *                 are skipped (we don't synthesize into a zero-part shell).
 */
function injectIntoMessage(message, text) {
  if (message.role === "user") {
    const parts = Array.isArray(message.content) ? message.content : []
    // Find last text part (utils.ts:217-223 ladder).
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (part && part.type === "text" && typeof part.text === "string") {
        if (part.text.includes(text)) return // idempotent
        const baseText = part.text.replace(/\n*$/, "")
        part.text = baseText.length > 0 ? `${baseText}\n\n${text}` : text
        return
      }
    }
    // No text part → synthesize one at the end (no leading newline).
    parts.push({ type: "text", text })
    message.content = parts
    return
  }

  if (message.role === "assistant") {
    const parts = Array.isArray(message.content) ? message.content : []
    // hasContent gate (utils.ts:229-231): an assistant with no content at all
    // is skipped rather than synthesised into — matches upstream behaviour
    // where "no parts" means the message is malformed/in-flight.
    if (parts.length === 0) return

    // First text part wins (utils.ts:233-239 ladder).
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part && part.type === "text" && typeof part.text === "string") {
        if (part.text.includes(text)) return
        const baseText = part.text.replace(/\n*$/, "")
        part.text = baseText.length > 0 ? `${baseText}\n\n${text}` : text
        return
      }
    }
    // No text part (but other parts exist — e.g. tool_use) → synthesize at
    // the head, before first tool_use (utils.ts:241-247).
    const synthetic = { type: "text", text }
    const firstToolIdx = parts.findIndex((p) => p && p.type === "tool_use")
    if (firstToolIdx === -1) {
      parts.push(synthetic)
    } else {
      parts.splice(firstToolIdx, 0, synthetic)
    }
    message.content = parts
  }
}