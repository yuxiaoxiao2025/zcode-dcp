// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) —
//     lib/strategies/deduplication.ts (strategy logic) +
//     lib/strategies/purge-errors.ts (strategy logic) +
//     lib/messages/prune.ts (placeholder constants + applyPrune substitution).
//
// Copyright (c) DCP authors. See DCP/LICENSE for upstream licensing.
//
// Behavior-faithful port adapted to the ZCode Anthropic-protocol proxy
// (stateless; runs once per /v1/messages request). Differences from upstream
// (documented in docs/current/CAPABILITY-MAPPING.md):
//   - No SessionState coupling: the scanner rebuilds tool-call metadata from
//     the live messages array each call (DCP keeps it in state.toolParameters /
//     state.toolIdList across calls).
//   - "turn" boundary = a USER-role message (SPEC-P6); the original DCP code
//     uses opencode session metadata for turn counting (state.currentTurn -
//     metadata.turn), which is unavailable in proxy mode.
//   - ZCode question-tool name is "AskUserQuestions"; DCP uses "question".
//     The port keeps the Anthropic-protocol natural name (the tool can also
//     arrive as mcp__<server>__AskUserQuestions — see planPrune normalisation).
//   - The three placeholder constants are ported VERBATIM from
//     lib/messages/prune.ts:9-11 (downstream parsing relies on exact bytes).
//   - coveredIndices parameter skips tool_use/tool_result blocks that a prior
//     compress step has already replaced with a synthetic user summary
//     (pipeline.mjs builds this set; upstream uses isMessageCompacted on
//     SessionState — proxy mode has no state to consult).

import {
  isToolNameProtected,
  isFilePathProtected,
  getFilePathsFromParameters,
  stripMcpPrefix,
} from "./protect.mjs"
import { estimateMessageTokens } from "./tokens.mjs"

// ---------- Placeholder constants (verbatim from DCP lib/messages/prune.ts:9-11) ----------

export const PRUNED_TOOL_OUTPUT =
    "[Output removed to save context - information superseded or no longer needed]"
export const PRUNED_TOOL_ERROR_INPUT = "[input removed due to failed tool call]"
export const PRUNED_QUESTION_INPUT = "[questions removed - see output for user's answers]"

// ---------- Signature (port of DCP deduplication.ts:96-127) ----------

/**
 * Normalise parameters per DCP `normalizeParameters` (deduplication.ts:105-116):
 *   - drop keys whose value is null or undefined
 *   - leave ARRAYS as-is at the top level (DCP returns the array reference
 *     untouched — null-stripping only applies to plain objects; recursing
 *     into array elements collapses `[{a:null}]` and `[{}]` to the same
 *     signature, breaking deduplication of parameter arrays)
 *   - recurse into nested objects
 *
 * Note: arrays are still recursively sorted at the next step (sortObjectKeys
 * maps over array elements), so the final JSON output is deterministic.
 */
function normalizeParameters(params) {
    if (typeof params !== "object" || params === null) return params
    if (Array.isArray(params)) return params
    const out = {}
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue
        out[key] = normalizeParameters(value)
    }
    return out
}

/**
 * Recursively sort object keys (port of `sortObjectKeys`). Arrays are kept
 * in original order; only object keys are alphabetised.
 */
function sortObjectKeys(obj) {
    if (typeof obj !== "object" || obj === null) return obj
    if (Array.isArray(obj)) return obj.map(sortObjectKeys)
    const sorted = {}
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortObjectKeys(obj[key])
    }
    return sorted
}

/**
 * Build a deduplication signature for a tool call:
 *   "<toolName>::<sortedJsonOfNormalisedParameters>"
 *
 * `input` may be undefined/null (no params) or an object (possibly empty).
 * For undefined/null the JSON segment is the empty string; for `{}` it is
 * "{}". Matches DCP `createToolSignature(tool, parameters?)` semantics in
 * deduplication.ts:96-103 verbatim.
 *
 * @param {string} name
 * @param {object|undefined|null} input
 * @returns {string}
 */
export function toolSignature(name, input) {
    if (input === undefined || input === null) {
        return `${name}::`
    }
    const normalized = normalizeParameters(input)
    const sorted = sortObjectKeys(normalized)
    return `${name}::${JSON.stringify(sorted)}`
}

// ---------- Message-walk helpers (stateless, Anthropic-protocol) ----------

/**
 * Yield each assistant tool_use block in document order. We need:
 *   - the call id (block.id)
 *   - the tool name (block.name)
 *   - the parameters (block.input)
 * which together identify the call.
 */
function* walkToolUses(messages) {
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (!m || m.role !== "assistant") continue
        const parts = Array.isArray(m.content) ? m.content : []
        for (const p of parts) {
            if (p && p.type === "tool_use" && typeof p.id === "string") {
                yield {
                    index: i,
                    id: p.id,
                    name: p.name,
                    input: p.input,
                }
            }
        }
    }
}

/**
 * For a given tool_call id, find the matching user tool_result block.
 * Returns the first tool_result whose tool_use_id === id, along with the
 * index of the user message it sits in. SPEC-P6: error state is read from
 * block.is_error === true.
 *
 * @returns {{userIndex:number, block:object, isError:boolean}|null}
 */
function findToolResult(messages, callId) {
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (!m || m.role !== "user") continue
        const parts = Array.isArray(m.content) ? m.content : []
        for (const p of parts) {
            if (
                p &&
                p.type === "tool_result" &&
                p.tool_use_id === callId
            ) {
                return {
                    userIndex: i,
                    block: p,
                    isError: p.is_error === true,
                }
            }
        }
    }
    return null
}

/**
 * Count the number of USER-role messages that appear strictly AFTER the
 * given message index. SPEC-P6: turn boundary = user message.
 */
function countUserMessagesAfter(messages, fromIndex) {
    let count = 0
    for (let i = fromIndex + 1; i < messages.length; i++) {
        if (messages[i] && messages[i].role === "user") count++
    }
    return count
}

// ---------- planPrune: deduplication strategy (DCP deduplication.ts:16-94) ----------

function runDeduplicationStrategy(messages, config, out) {
    if (!config.strategies || !config.strategies.deduplication) return
    const dedup = config.strategies.deduplication
    if (dedup.enabled === false) return
    const protectedTools = dedup.protectedTools || []
    const protectedFiles = (config && config.protectedFilePatterns) || []

    // turnProtection: when enabled, calls with too-few subsequent user
    // messages (i.e. recent enough to still be in the model's working
    // window) must not be added to the dedup cache. Mirrors the same gate
    // applied to purgeErrors below (DCP tool-cache.ts:39-52 semantics:
    // both strategies respect turnProtection).
    const turnProtectionEnabled =
        config.turnProtection && config.turnProtection.enabled === true
    const turnProtectionTurns = turnProtectionEnabled
        ? Math.max(1, Number(config.turnProtection.turns) || 4)
        : 0

    // Group call ids by signature, in document order. The recorded call.index
    // is the assistant message index — needed for the turnProtection check
    // (count user messages after that index).
    const sigToIds = new Map()

    for (const call of walkToolUses(messages)) {
        const protectedByName = isToolNameProtected(call.name, protectedTools)
        if (protectedByName) continue
        const paths = getFilePathsFromParameters(call.name, call.input)
        if (isFilePathProtected(paths, protectedFiles)) continue

        if (turnProtectionEnabled) {
            const subsequentUserCount = countUserMessagesAfter(messages, call.index)
            if (subsequentUserCount < turnProtectionTurns) continue
        }

        const sig = toolSignature(call.name, call.input)
        if (!sigToIds.has(sig)) sigToIds.set(sig, [])
        sigToIds.get(sig).push(call.id)
    }

    // Keep the most recent in each group; prune the rest.
    for (const [, ids] of sigToIds) {
        if (ids.length > 1) {
            const toPrune = ids.slice(0, -1)
            for (const id of toPrune) {
                out.byStrategy.dedup.push(id)
                out.pruneToolCallIds.add(id)
            }
        }
    }
}

// ---------- planPrune: purgeErrors strategy (DCP purge-errors.ts:19-88) ----------

function runPurgeErrorsStrategy(messages, config, out) {
    if (!config.strategies || !config.strategies.purgeErrors) return
    const purge = config.strategies.purgeErrors
    if (purge.enabled === false) return

    const protectedTools = purge.protectedTools || []
    const protectedFiles = (config && config.protectedFilePatterns) || []
    const turnThreshold = Math.max(1, Number(purge.turns) || 4)

    // turnProtection short-circuits the strategy: if enabled and the
    // number of subsequent user messages is < turnProtection.turns, skip.
    const turnProtectionEnabled =
        config.turnProtection && config.turnProtection.enabled === true
    const turnProtectionTurns = turnProtectionEnabled
        ? Math.max(1, Number(config.turnProtection.turns) || 4)
        : 0

    for (const call of walkToolUses(messages)) {
        if (isToolNameProtected(call.name, protectedTools)) continue
        const paths = getFilePathsFromParameters(call.name, call.input)
        if (isFilePathProtected(paths, protectedFiles)) continue

        const result = findToolResult(messages, call.id)
        if (!result) continue
        if (!result.isError) continue

        const subsequentUserCount = countUserMessagesAfter(messages, result.userIndex)
        if (subsequentUserCount < turnThreshold) continue

        if (turnProtectionEnabled && subsequentUserCount < turnProtectionTurns) {
            continue
        }

        out.byStrategy.purgeErrors.push(call.id)
        out.pruneToolCallIds.add(call.id)
    }
}

/**
 * Build a prune plan over the given messages array.
 *
 * Returns a plain object:
 *   {
 *     pruneToolCallIds: Set<string>,         // union of both strategy buckets
 *     byStrategy: {
 *       dedup: string[],                     // dedup.ts:16-94
 *       purgeErrors: string[],               // purge-errors.ts:19-88
 *     },
 *     savedTokensEst: number,                // estimated saved tokens
 *   }
 *
 * Determinism: walks messages in document order, writes to fixed-shape
 * outputs. The same input array + config yields the same plan object (the
 * Set is identical because membership is order-independent for our use).
 *
 * @param {Array<object>} messages
 * @param {object} config
 * @returns {{pruneToolCallIds:Set<string>, byStrategy:{dedup:string[], purgeErrors:string[]}, savedTokensEst:number}}
 */
export function planPrune(messages, config) {
    const safeMessages = Array.isArray(messages) ? messages : []
    const cfg = config || {}

    // DCP short-circuit at the top of each strategy:
    //   if (state.manualMode && !config.manualMode.automaticStrategies) return;
    // In proxy mode we treat manualMode.automaticStrategies=false as "user
    // wants manual-only operation" — neither strategy auto-runs.
    if (
        cfg.manualMode &&
        cfg.manualMode.enabled === true &&
        cfg.manualMode.automaticStrategies === false
    ) {
        return {
            pruneToolCallIds: new Set(),
            byStrategy: { dedup: [], purgeErrors: [] },
            savedTokensEst: 0,
        }
    }

    const out = {
        pruneToolCallIds: new Set(),
        byStrategy: { dedup: [], purgeErrors: [] },
        savedTokensEst: 0,
    }

    runDeduplicationStrategy(safeMessages, cfg, out)
    runPurgeErrorsStrategy(safeMessages, cfg, out)

    // Estimate saved tokens for every tool_use/tool_result block we are
    // about to placeholder-substitute. We use estimateMessageTokens over
    // each affected message; summing the slice we are removing gives a
    // conservative upper bound for "saved".
    for (const id of out.pruneToolCallIds) {
        for (let i = 0; i < safeMessages.length; i++) {
            const m = safeMessages[i]
            if (!m || !Array.isArray(m.content)) continue
            for (const p of m.content) {
                if (!p || typeof p !== "object") continue
                if (p.type === "tool_use" && p.id === id) {
                    out.savedTokensEst += estimateMessageTokens({
                        content: [p],
                    })
                } else if (
                    p.type === "tool_result" &&
                    p.tool_use_id === id
                ) {
                    out.savedTokensEst += estimateMessageTokens({
                        content: [p],
                    })
                }
            }
        }
    }

    return out
}

// ---------- applyPrune: placeholder substitution (DCP prune.ts:73-157) ----------

/**
 * Replace each `tool_result.content` (string form) with PRUNED_TOOL_OUTPUT
 * when its tool_use_id is in pruneToolCallIds AND the message index is NOT
 * in coveredIndices. Mirrors DCP `pruneToolOutputs` (prune.ts:73-97) but
 *   - skips messages already replaced by a prior compress step
 *   - skips error tool_results (DCP `pruneToolOutputs` line 87-88 gates on
 *     `status === "completed"`; we read is_error from the block directly
 *     since proxy mode has no SessionState)
 *   - skips edit / write / question tools (their tool_results are not
 *     "old outputs" we want to clear; their INPUTS are what gets pruned
 *     for question, handled separately below).
 */
function applyToolOutputSubstitution(messages, plan, coveredIndices) {
    for (let i = 0; i < messages.length; i++) {
        if (coveredIndices.has(i)) continue
        const m = messages[i]
        if (!m || m.role !== "user" || !Array.isArray(m.content)) continue
        for (const block of m.content) {
            if (!block || block.type !== "tool_result") continue
            if (!plan.pruneToolCallIds.has(block.tool_use_id)) continue
            // DCP prune.ts:87-88: error tool_results are NOT cleared by
            // `pruneToolOutputs` (only their inputs are cleared by
            // `pruneToolErrors`). The error MESSAGE is preserved.
            if (block.is_error === true) continue
            // DCP prune.ts:90-92: skip question/edit/write.
            const callName = findToolNameById(messages, block.tool_use_id)
            if (
                callName === "edit" ||
                callName === "write" ||
                callName === "question" ||
                callName === "AskUserQuestions"
            ) {
                continue
            }
            // Only string content is substituted — array content blocks are
            // left alone (they preserve images / nested structure).
            if (typeof block.content === "string") {
                block.content = PRUNED_TOOL_OUTPUT
            }
        }
    }
}

/**
 * For a tool_call id, find the matching tool_use block's name. Used by the
 * edit/write/question exclusion check above.
 */
function findToolNameById(messages, callId) {
    for (const call of walkToolUses(messages)) {
        if (call.id === callId) return call.name
    }
    return null
}

/**
 * Replace each string-typed field of an errored tool_use's `input` object
 * with PRUNED_TOOL_ERROR_INPUT. Iterates the FULL pruneToolCallIds set
 * (both dedup + purgeErrors buckets) and gates on
 * `tool_result.is_error === true` for the matching id. Mirrors DCP
 * `pruneToolErrors` (prune.ts:128-157):
 *   - walks state.prune.tools (the union of both strategy buckets)
 *   - checks status === "error"
 *   - replaces string input fields, leaves non-strings alone
 *   - does NOT touch the tool_result (the error message is preserved)
 *
 * A failing call can land in the dedup bucket when an earlier identical
 * call also failed; in that case the dedup strategy alone wouldn't clean
 * its inputs — this function ensures every errored id in the union gets
 * its inputs cleaned.
 */
function applyToolErrorInputSubstitution(messages, plan, coveredIndices) {
    if (plan.pruneToolCallIds.size === 0) return
    for (let i = 0; i < messages.length; i++) {
        if (coveredIndices.has(i)) continue
        const m = messages[i]
        if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue
        for (const block of m.content) {
            if (!block || block.type !== "tool_use") continue
            if (!plan.pruneToolCallIds.has(block.id)) continue
            // Gate: only errored calls have their inputs cleaned.
            const result = findToolResult(messages, block.id)
            if (!result || !result.isError) continue
            const input = block.input
            if (!input || typeof input !== "object") continue
            for (const key of Object.keys(input)) {
                if (typeof input[key] === "string") {
                    input[key] = PRUNED_TOOL_ERROR_INPUT
                }
            }
        }
    }
}

/**
 * Replace `input.questions` of the AskUserQuestions (or "question") tool
 * with PRUNED_QUESTION_INPUT when the id is in the dedup bucket
 * (DCP pruneToolInputs prunes questions across the same set of marked ids).
 * Mirrors DCP `pruneToolInputs` (prune.ts:99-126).
 */
function applyQuestionInputSubstitution(messages, plan, coveredIndices) {
    if (plan.pruneToolCallIds.size === 0) return
    for (let i = 0; i < messages.length; i++) {
        if (coveredIndices.has(i)) continue
        const m = messages[i]
        if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue
        for (const block of m.content) {
            if (!block || block.type !== "tool_use") continue
            if (!plan.pruneToolCallIds.has(block.id)) continue
            const bare = stripMcpPrefix(block.name)
            if (bare !== "AskUserQuestions" && bare !== "question") continue
            if (block.input && typeof block.input === "object") {
                if ("questions" in block.input) {
                    block.input.questions = PRUNED_QUESTION_INPUT
                }
            }
        }
    }
}

/**
 * Apply a prune plan to the messages array. Returns a NEW array (the
 * original is never mutated, per H1 fidelity — the proxy must not destroy
 * data the caller might still inspect). Within each message, however, the
 * placeholders ARE substituted in place on the new object's blocks (this is
 * the intended outcome: a fresh array of messages with substituted content).
 *
 *   messages         : source array (not mutated)
 *   plan             : output of planPrune
 *   coveredIndices   : Set<number> indices already replaced by a prior
 *                      compress step; these are skipped wholesale
 *
 * @param {Array<object>} messages
 * @param {{pruneToolCallIds:Set<string>, byStrategy:{dedup:string[], purgeErrors:string[]}, savedTokensEst:number}} plan
 * @param {Set<number>} coveredIndices
 * @returns {Array<object>}
 */
export function applyPrune(messages, plan, coveredIndices) {
    const safeMessages = Array.isArray(messages) ? messages : []
    const safeCovered = coveredIndices instanceof Set ? coveredIndices : new Set()
    const safePlan = plan || {
        pruneToolCallIds: new Set(),
        byStrategy: { dedup: [], purgeErrors: [] },
        savedTokensEst: 0,
    }

    // Deep-clone each message before mutation. For tool_use blocks the
    // `input` object MUST be deep-cloned too: subsequent passes
    // (applyToolErrorInputSubstitution / applyQuestionInputSubstitution)
    // mutate input string fields in place. A shallow `{...b}` would leave
    // `block.input` shared with the original array, which would corrupt
    // caller's `body` (H1 fidelity — proxy must not mutate incoming data;
    // task-9 logRequest relies on this when capturing the original body
    // for saving metrics).
    //
    // coveredIndices pass through unchanged — the caller's pipeline layer
    // splices them out separately.
    const cloned = safeMessages.map((m) => {
        if (!m || typeof m !== "object") return m
        return {
            ...m,
            content: Array.isArray(m.content)
                ? m.content.map((b) => {
                      if (!b || typeof b !== "object") return b
                      if (
                          b.type === "tool_use" &&
                          b.input &&
                          typeof b.input === "object"
                      ) {
                          return { ...b, input: structuredClone(b.input) }
                      }
                      return { ...b }
                  })
                : m.content,
        }
    })

    applyToolOutputSubstitution(cloned, safePlan, safeCovered)
    applyToolErrorInputSubstitution(cloned, safePlan, safeCovered)
    applyQuestionInputSubstitution(cloned, safePlan, safeCovered)

    return cloned
}