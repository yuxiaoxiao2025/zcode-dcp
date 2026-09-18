// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/hooks.ts:107-165
//   createChatMessageTransformHandler (orchestration shape) +
//   lib/messages/utils.ts (gate-by-signature parity) +
//   lib/messages/priority.ts (message-mode priority list).
//
//   Copyright (c) opencode-dcp authors. Licensed under AGPL-3.0-or-later.
//
// Behavior-faithful orchestration port adapted to the ZCode Anthropic-protocol
// proxy. Each module here consumes the public surface of task-5/6/7/8/9/10
// modules and glues them into a single transformRequest call.
//
// Orchestration order (PLAN.md Task 11, post R2' fix — gate BEFORE strip):
//   1. gate          — isMainSession(system, config); false → return unchanged
//   2. stripDcpTags  — wash hallucinated dcp tags from historical messages
//   3. assignRefs    — deterministic mNNNN allocation
//   4. deriveBlocks  — scan compress tool_use; on THROW → catch, append
//                      synthetic <dcp-system-reminder> compress-error user
//                      message and continue (one bad range must not break the
//                      whole request — see task brief, R15 spirit)
//   5. enhanceSummary(active blocks) + applyCompressions(range replacement)
//   5a. **re-assignRefs** — C-1 fix (review r1): applyCompressions removes
//       N covered messages and inserts 1 synthetic, shrinking the array.
//       The byIndex map built in step 3 is keyed by the OLD indices and
//       would map new positions to stale refs (off-by-N). Re-assign here so
//       every downstream consumer (planNudges, injectMessageIds, priorityMap)
//       sees a consistent index ↔ ref relationship.
//   6. planPrune(covered skipped) + applyPrune
//   7. manualMode overlay — when lightState.manualMode===true, force
//      config.manualMode.enabled=true for downstream calls (preserves
//      automaticStrategies so dedup/purge can still auto-run when configured)
//   8. planNudges    — consumes the skipped signal (empty-messages / no-usage)
//      from nudges.mjs so the caller can record why no nudges were emitted
//   9. **message-mode priority guidance** — when config.compress.mode
//      ==="message", build the per-nudge priority list via
//      renderMessagePriorityGuidance() (DCP nudge.ts:18-26 verbatim format)
//      for EACH of the three nudge kinds (context/turn/iteration), using
//      listPriorityRefsBeforeIndex() semantics — only refs at index < anchor,
//      no parentheses, comma-separated. Guidance is appended via the shared
//      appendGuidanceToDcpTag helper (exported from nudges.mjs).
//      Identification uses `inj.kind` field (nudges.mjs:563, special auth
//      1-line edit) rather than text-signature matching (text signatures
//      break when the user overrides prompts — R6 explicitly allows this).
//  10. applyNudges   — runtime-context injection (mutates a fresh deep clone)
//  11. injectMessageIds(messages, refs, {priorityMap, blockedSet})
//      — priorityMap AND blockedSet are keyed by INTEGER MESSAGE INDEX into
//        the *current* (post-step-5a) messages array (I-2b cross-file
//        authorization). Anthropic /v1/messages has no message.id field.
//        blockedSet is populated by the pipeline:
//          - When mode==="message" AND protectUserMessages===true, all
//            user-role message indices are added (DCP inject.ts:165 +
//            query.ts:61-72 config-driven semantics).
//          - blocked indices are then FILTERED OUT of the priorityMap
//            (DCP priority.ts:35 — blocked messages get no priority).
//  12. return { body: {...body, messages}, metrics, lightStateUpdates }
//
// H1 fidelity: this function returns a NEW shallow body object that preserves
// every top-level field of the input by REFERENCE (only `messages` is replaced
// with the transformed array). Other body fields (model / tools / system /
// thinking / metadata / max_tokens / output_config / tool_choice / stream)
// are NEVER touched — passthrough is structurally guaranteed.

import { isMainSession } from "./protect.mjs"
import {
  isToolNameProtected,
  isFilePathProtected,
  getFilePathsFromParameters,
} from "./protect.mjs"
import { stripDcpTags, assignRefs, injectMessageIds } from "./message-ids.mjs"
import {
  deriveBlocks,
  enhanceSummary,
  applyCompressions,
  buildPriorityMap,
} from "./compress.mjs"
import { planPrune, applyPrune } from "./prune.mjs"
import { planNudges, applyNudges, appendGuidanceToDcpTag } from "./nudges.mjs"
import { loadPrompts, wrapReminder } from "./prompts.mjs"
import { estimateMessageTokens } from "./tokens.mjs"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone the messages array structure (objects + arrays, no class instances).
 * Used at the pipeline boundary so stripDcpTags / injectMessageIds (which
 * mutate in place) cannot corrupt the caller's body.
 */
function deepCloneMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m
    const cloned = { ...m }
    if (Array.isArray(m.content)) {
      cloned.content = m.content.map((b) => {
        if (!b || typeof b !== "object") return b
        const bc = { ...b }
        if (Array.isArray(b.content)) {
          bc.content = b.content.map((c) => (c && typeof c === "object" ? { ...c } : c))
        }
        // Preserve tool_use.input reference (we deep-clone it too — applyPrune
        // would otherwise mutate the caller's input via the input-substitution
        // pass; clone here is the safe path)
        if (b.type === "tool_use" && b.input && typeof b.input === "object") {
          bc.input = JSON.parse(JSON.stringify(b.input))
        }
        return bc
      })
    }
    return cloned
  })
}

/**
 * normalizeMessages — Anthropic /v1/messages accepts EITHER a content array
 * OR a plain string for user/assistant messages (the "content":"hi"
 * shorthand, semantically equivalent to [{type:"text", text:"hi"}]).
 *
 * The proxy pipeline's downstream consumers (stripDcpTags in
 * message-ids.mjs, prune.mjs's walkToolUses, nudges.mjs's injectIntoMessage,
 * compress.mjs's walk, and injectMessageIds at message-ids.mjs:266
 * `message.content.push(...)`) all assume content is an array. A raw
 * string crashes the pipeline with `message.content.push is not a function`
 * (8.6 production bug).
 *
 * This normalizer converts string content to a single text block at the
 * gate-passed boundary, so every downstream consumer sees the canonical
 * array shape. Other roles (tool messages etc.) are left untouched.
 *
 * This is a faithful within-protocol transformation — Anthropic treats
 * string content and a single-text-block array as semantically equivalent,
 * so the upstream model sees the same payload after the conversion.
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return
  for (const m of messages) {
    if (!m || typeof m !== "object") continue
    const role = m.role
    if (role !== "user" && role !== "assistant") continue
    if (typeof m.content === "string") {
      m.content = [{ type: "text", text: m.content }]
    }
  }
}

/**
 * Active set filter — mirrors compress.mjs's internal helper but exposed here
 * so the pipeline can pass active blocks to planNudges (the upstream call site
 * for the summary-buffer accounting in nudges.mjs:getActiveSummaryTokenUsage).
 * Faithful to state.ts:62-268: a block is ACTIVE iff no other block has it
 * in its consumedBlockIds list.
 */
function filterActiveBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return []
  const consumedByAnyone = new Set()
  for (const b of blocks) {
    if (Array.isArray(b && b.consumedBlockIds)) {
      for (const id of b.consumedBlockIds) consumedByAnyone.add(Number(id))
    }
  }
  return blocks.filter((b) => {
    if (!b || typeof b.blockId !== "string") return false
    const id = Number(b.blockId.slice(1))
    return !consumedByAnyone.has(id)
  })
}

/**
 * renderMessagePriorityGuidance — port of DCP nudge.ts:18-26 (verbatim
 * 3-line text format). Refs are mNNNN strings **without parentheses**,
 * **comma-separated**, ordered by document index. The label is the priority
 * name with its first letter capitalised (e.g. "High", "Medium", "Low").
 *
 * This function faithfully reproduces DCP's rendered output — downstream
 * tests / model behaviour that depends on the exact wording will see no
 * drift.
 */
function renderMessagePriorityGuidance(priorityLabel, refs) {
  const refList = Array.isArray(refs) && refs.length > 0 ? refs.join(", ") : "none"
  return [
    "Message priority context:",
    "- Higher-priority older messages consume more context and should be compressed right away if it is safe to do so.",
    `- ${priorityLabel}-priority message IDs before this point: ${refList}`,
  ].join("\n")
}

/**
 * listPriorityRefsBeforeIndex — port of DCP priority.ts:76-102. Walks the
 * `priorityMap` (already keyed by integer index in this port) and emits
 * the `entry.ref` of every entry whose:
 *   - index is in [0, anchorIndex)
 *   - priority === the requested level
 * in document order (the priorityMap is iterated in insertion order, which
 * the builder produces in document order — priorityMap.get(i) for i=0..N-1).
 */
function listPriorityRefsBeforeIndex(priorityMap, anchorIndex, priority) {
  if (!priorityMap || priorityMap.size === 0) return []
  const refs = []
  const seen = new Set()
  // priorityMap keys are integers; sort ascending = document order.
  const keys = [...priorityMap.keys()]
    .map((k) => Number(k))
    .filter((k) => Number.isInteger(k) && k >= 0 && k < anchorIndex)
    .sort((a, b) => a - b)
  for (const k of keys) {
    const entry = priorityMap.get(k)
    if (!entry || entry.priority !== priority) continue
    if (typeof entry.ref !== "string") continue
    if (seen.has(entry.ref)) continue
    seen.add(entry.ref)
    refs.push(entry.ref)
  }
  return refs
}

/**
 * buildMessageModeGuidanceForKind — composes the priority-guidance block
 * for a single nudge injection in message mode. Used by step 9 below for
 * each of the three kinds (context / turn / iteration).
 *
 * @param {"high"|"medium"|"low"} priority
 * @param {Map<number, {ref:string, priority:string}>} priorityMap
 * @param {number} anchorIndex — message index this nudge is being injected at
 * @returns {string} guidance text (empty if no qualifying refs)
 */
function buildMessageModeGuidanceForKind(priority, priorityMap, anchorIndex) {
  const refs = listPriorityRefsBeforeIndex(priorityMap, anchorIndex, priority)
  if (refs.length === 0) return ""
  const label = `${priority[0].toUpperCase()}${priority.slice(1)}`
  return renderMessagePriorityGuidance(label, refs)
}

/**
 * Assemble the blockedSet for injectMessageIds.
 *
 * DCP semantics (inject.ts:165 + query.ts:61-72 port):
 *   - When `config.compress.mode === "message"` AND
 *     `config.compress.protectUserMessages === true`, ALL user-role message
 *     indices are added (the model is told they are protected / BLOCKED so
 *     it doesn't compress them).
 *   - Otherwise the set is empty (no message-level blocking).
 *
 * Returns: Set<number> of blocked indices.
 */
function buildBlockedSet(messages, config) {
  const blocked = new Set()
  const compress = (config && config.compress) || {}
  if (compress.mode === "message" && compress.protectUserMessages === true) {
    if (Array.isArray(messages)) {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (m && m.role === "user") blocked.add(i)
      }
    }
  }
  return blocked
}

// ---------------------------------------------------------------------------
// transformRequest — the single orchestration entry point
// ---------------------------------------------------------------------------

/**
 * Transform an Anthropic /v1/messages request body before it is forwarded
 * upstream. Returns `{body, metrics, lightStateUpdates}`.
 *
 *   body                : { ...body, messages: transformed } (shallow merge,
 *                         every non-messages field passed by reference)
 *   metrics             : { savedTokensEst, byStrategy, injectedNudges,
 *                          activeBlocks, skipped?, nudgeStarved?, compressError?,
 *                          maxRunId }
 *   lightStateUpdates   : { anchors, fetchCount, ... } — caller persists this
 *
 * ctx shape:
 *   {
 *     config:      object  — DCP config (DEFAULT_CONFIG merged with user layers)
 *     lightState:  object  — session light state (anchors, manualMode, ...)
 *     usage:       object|null — last upstream usage (inputTokens etc.)
 *     dataDir:     string  — for debug logging / persistence (unused in
 *                            transformRequest directly; reserved for downstream)
 *     cwd?:        string  — working directory for prompts override resolution
 *   }
 */
export function transformRequest(body, ctx) {
  const safeBody = body && typeof body === "object" ? body : {}
  const cfg = (ctx && ctx.config) || {}
  const lightState =
    (ctx && ctx.lightState) || {
      anchors: { context: [], turn: [], iter: [] },
      manualMode: false,
      fetchCount: 0,
    }
  const usage = ctx ? ctx.usage : null
  const cwd = (ctx && ctx.cwd) || ""

  // Step 1: gate. If the system signature does not pass the main-session
  // whitelist (or matches an internal-agent signature when allowSubAgents is
  // enabled), the pipeline MUST NOT touch the messages array — passthrough
  // is structurally guaranteed. fetchCount is incremented identically (Minor
  // 1 fix: don't hardcode 1; respect existing counter so persistent counts
  // remain monotonic across gate rejections too).
  const systemBlocks = Array.isArray(safeBody.system)
    ? safeBody.system
    : safeBody.system
      ? [{ type: "text", text: String(safeBody.system) }]
      : []

  if (!isMainSession(systemBlocks, cfg)) {
    return {
      body: { ...safeBody, messages: safeBody.messages },
      metrics: {
        savedTokensEst: 0,
        byStrategy: { dedup: 0, purge: 0, compress: 0 },
        // R8.3 / DESIGN D3: gate-rejected requests never run prune/compress,
        // so all four token buckets are zero. Exposed here for shape
        // consistency with the gate-passed branch.
        savedTokensByStrategy: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
        injectedNudges: 0,
        activeBlocks: 0,
        skipped: "gate",
      },
      lightStateUpdates: { fetchCount: (lightState.fetchCount || 0) + 1 },
    }
  }

  // Deep-clone the messages up front so the rest of the pipeline can mutate
  // freely (stripDcpTags / injectMessageIds mutate in place; we never want
  // to write back to the caller's body — H1 fidelity).
  let messages = deepCloneMessages(safeBody.messages)

  // Step 1.5: normalize string content to a single text block. Anthropic's
  // /v1/messages accepts EITHER a content array OR a plain string for
  // user/assistant messages; every downstream consumer (stripDcpTags,
  // prune walkToolUses, nudges injectIntoMessage, compress walk, and
  // injectMessageIds which calls `message.content.push(...)` at
  // message-ids.mjs:266) assumes array shape. A raw string crashes the
  // pipeline with `TypeError: message.content.push is not a function`
  // (8.6 production bug). This step runs AFTER the deep clone so the
  // caller's body is untouched, and BEFORE stripDcpTags so the strip
  // walker also sees the canonical array form.
  normalizeMessages(messages)

  // Step 2: strip hallucinated dcp tags from historical messages (in place
  // on our clone).
  stripDcpTags(messages)

  // Step 3: assign deterministic refs (m0001..). The pipeline uses this for
  // every downstream keyed lookup (priorityMap, injectMessageIds, ...).
  let refs = assignRefs(messages)

  // Step 4: derive blocks (scan compress tool_use calls). On throw (bad
  // range / unresolved ref), we swallow the error and append a synthetic
  // user message at the END of messages so the model sees the error in the
  // same channel DCP's tool-throw path uses (tool_result with the error
  // text). The wrapped text uses `wrapReminder` for format consistency with
  // nudge injections (Minor 2 fix: format alignment with nudge class).
  let blocks = []
  let compressErrorMessage = null
  try {
    // CAP-20 decompress wiring: pass excludedBlockIds from lightState so
    // blocks the operator marked "decompressed" are dropped at the source
    // (no synthetic summary message is inserted for them).
    const excludedBlockIds = Array.isArray(lightState.decompressBlockIds)
      ? lightState.decompressBlockIds
      : []
    blocks = deriveBlocks(messages, refs, cfg, { excludedBlockIds })
  } catch (err) {
    compressErrorMessage = err && err.message ? err.message : String(err)
    blocks = []
    // Wrap as a "nudge-class" reminder so the rendered text matches the
    // dcp-system-reminder format the model already understands from nudge
    // injections. compressError carries the raw message for debugging.
    const reminderBody = `compress tool error: ${compressErrorMessage}`
    const wrappedError = wrapReminder("contextLimitNudge", reminderBody)
    messages = [
      ...messages,
      {
        role: "user",
        content: [{ type: "text", text: wrappedError || reminderBody }],
      },
    ]
    // After appending the synthetic message, prior ref assignments are still
    // valid for existing indices; we'll re-assign in step 5a to be safe.
  }

  // Step 5: enhance summaries for active blocks; build the map of final
  // summaries keyed by blockId.
  const enhancedSummaries = new Map()
  const activeBlocks = filterActiveBlocks(blocks)
  for (const b of activeBlocks) {
    const { summary } = enhanceSummary(b, blocks, messages, refs, cfg)
    enhancedSummaries.set(b.blockId, summary)
  }

  // Step 6: apply range replacements. Produces a NEW messages array plus
  // the coveredIndices set (indices of original messages absorbed by an
  // active block).
  const coveredIndices = new Set()
  for (const b of activeBlocks) {
    if (Array.isArray(b.coveredIndices)) {
      for (const idx of b.coveredIndices) coveredIndices.add(idx)
    }
  }
  // Gate 1.5 A1: compute covered-originals tokens BEFORE applyCompressions
  // mutates the messages array. The pre-fix estimator summed
  // (rawSummary.length − enhancedSummary.length)/4, which is ~0 for any
  // well-behaved compress call (the model writes a concise summary).
  // The fix uses the covered union tokens minus the inserted synthetic
  // tokens — the real on-the-wire savings. Nested consume is naturally
  // handled: consumed blocks are filtered out by filterActiveBlocks, so
  // only ACTIVE blocks contribute to coveredIndices and syntheticTokens
  // (their covered indices are subsumed by the outer block's range).
  const coveredOriginalTokens = activeBlocks.length > 0 && coveredIndices.size > 0
    ? sumTokensForIndices(messages, coveredIndices)
    : 0
  if (activeBlocks.length > 0) {
    messages = applyCompressions(messages, activeBlocks, enhancedSummaries)
  }

  // Step 5a (C-1 fix): re-assign refs after applyCompressions. The earlier
  // byIndex map was keyed by PRE-compression indices; after the splice the
  // surviving messages occupy different positions. Without this rebuild,
  // injectMessageIds would systematically mis-tag messages (e.g. a message
  // at new index 3 would receive the OLD ref for index 3, which is now a
  // different message). This single line of re-assignment closes the
  // off-by-N hole.
  refs = assignRefs(messages)

  // Step 7: plan + apply prune (covered indices are skipped wholesale).
  // The planPrune internal logic already respects manualMode.automaticStrategies
  // but the brief asks for an explicit config overlay when lightState.manualMode
  // is on (so nudges and any future config-aware consumers see the manualMode
  // signal regardless of the persisted config).
  let pruneCfg = cfg
  if (lightState.manualMode === true) {
    pruneCfg = {
      ...cfg,
      manualMode: {
        ...(cfg.manualMode || {}),
        enabled: true,
      },
    }
  }
  let prunePlan = planPrune(messages, pruneCfg)
  let sweepDirectiveResult = null
  // Wire sweepToolCallIds from the user's MCP-driven `/dcp-admin/state/sweep`
  const sweepIds = Array.isArray(lightState.sweepToolCallIds) ? lightState.sweepToolCallIds : []
  if (sweepIds.length > 0 && prunePlan.pruneToolCallIds instanceof Set) {
    if (!Array.isArray(prunePlan.byStrategy.sweep)) prunePlan.byStrategy.sweep = []
    if (!prunePlan.byStrategyTokens || typeof prunePlan.byStrategyTokens !== "object") {
      prunePlan.byStrategyTokens = { dedup: 0, purge: 0, sweep: 0 }
    }
    if (typeof prunePlan.byStrategyTokens.sweep !== "number") {
      prunePlan.byStrategyTokens.sweep = 0
    }
    for (const id of sweepIds) {
      if (typeof id === "string" && id.length > 0 && !prunePlan.pruneToolCallIds.has(id)) {
        prunePlan.pruneToolCallIds.add(id)
        prunePlan.byStrategy.sweep.push(id)
      }
    }
    // Re-estimate saved tokens for the sweep additions only (the strategy
    // picks were already accounted for in planPrune's estimate). The per-block
    // estimate is added to both savedTokensEst and byStrategyTokens.sweep.
    for (const id of prunePlan.byStrategy.sweep) {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (!m || !Array.isArray(m.content)) continue
        for (const p of m.content) {
          if (!p || typeof p !== "object") continue
          if (p.type === "tool_use" && p.id === id) {
            const blockEstimate = estimateMessageTokens({ content: [p] })
            prunePlan.savedTokensEst += blockEstimate
            prunePlan.byStrategyTokens.sweep += blockEstimate
          } else if (
            p.type === "tool_result" &&
            p.tool_use_id === id
          ) {
            const blockEstimate = estimateMessageTokens({ content: [p] })
            prunePlan.savedTokensEst += blockEstimate
            prunePlan.byStrategyTokens.sweep += blockEstimate
          }
        }
      }
    }
  }
  // Gate 1.5 B2 — consume the operator's `sweepDirective` (one-shot).
  //
  // DCP upstream applies sweep IMMEDIATELY in the handler because state is
  // a mutable live object. In the ZCode proxy architecture the handler
  // cannot see the messages — only the pipeline can, on the next inbound
  // request. So we queue a directive via /dcp-admin/state/sweep and consume
  // it here, exactly where the prune plan runs (so applyPrune does the
  // actual placeholder substitution).
  //
  // Skips applied:
  //   - commands.protectedTools hits (DCP sweep.ts:178-180 verbatim) — bare
  //     name comparison with MCP-prefix stripping (protect.mjs helper).
  //   - protectedFilePatterns hits (DCP sweep.ts:184-186 verbatim) — file_path/
  //     path parameter inspection via protect.mjs.
  //   - already in the prune set from prior strategies (dedup/purge) — no
  //     double-application.
  //   - is_error=true tool_results (DCP purgeErrors semantics — error messages
  //     are kept by design, only their inputs are cleaned. Sweep does NOT
  //     touch errors; their detail is still useful in context.)
  const directive = lightState && lightState.sweepDirective
  if (
    directive &&
    typeof directive === "object" &&
    (directive.mode === "since-user" || directive.mode === "last-n") &&
    prunePlan.pruneToolCallIds instanceof Set
  ) {
    // Compute target ids from the live messages array.
    const rawTargets = computeSweepTargetIds(messages, directive)
    const targets = applySweepSkipRules(rawTargets, cfg)
    // Filter to "actually applied" (not skipped) and "skipped-protected" (in
    // target but rejected by a skip rule). These two counters feed
    // sweepLastResult for operator-visible feedback (MCP dcp_sweep response).
    const appliedIds = []
    let skippedProtected = 0
    if (!Array.isArray(prunePlan.byStrategy.sweep)) prunePlan.byStrategy.sweep = []
    if (!prunePlan.byStrategyTokens || typeof prunePlan.byStrategyTokens !== "object") {
      prunePlan.byStrategyTokens = { dedup: 0, purge: 0, sweep: 0 }
    }
    if (typeof prunePlan.byStrategyTokens.sweep !== "number") {
      prunePlan.byStrategyTokens.sweep = 0
    }
    for (const target of targets) {
      if (!target || typeof target.id !== "string" || target.id.length === 0) continue
      // Skip errors — purgeErrors handles error-input cleaning separately.
      if (isToolResultError(messages, target.id)) continue
      if (prunePlan.pruneToolCallIds.has(target.id)) {
        // Already picked up by dedup/purge — count as applied but don't
        // re-estimate tokens (planPrune already accounted for it).
        appliedIds.push(target.id)
        continue
      }
      if (target.isProtected) {
        skippedProtected++
        continue
      }
      prunePlan.pruneToolCallIds.add(target.id)
      prunePlan.byStrategy.sweep.push(target.id)
      appliedIds.push(target.id)
      // Estimate per-block tokens for the new sweep id (tool_use +
      // tool_result pair) and add to both savedTokensEst and the per-
      // strategy token split.
      const est = estimateSweepBlockTokens(messages, target.id)
      prunePlan.savedTokensEst += est
      prunePlan.byStrategyTokens.sweep += est
    }
    sweepDirectiveResult = {
      applied: appliedIds.length,
      skippedProtected,
    }
  }
  messages = applyPrune(messages, prunePlan, coveredIndices)

  // Step 8: plan nudges. The skipped signal from planNudges (empty-messages
  // or no-usage) is consumed by the metrics block below — the caller can
  // log why no nudges were emitted.
  const prompts = loadPrompts(cfg, cwd)
  const nudgePlan = planNudges(messages, pruneCfg, prompts, usage, lightState, activeBlocks)

  // Step 9: message-mode priority guidance composition (verbatim DCP
  // applyAnchoredNudges message-mode branch — utils.ts:333-352). When
  // config.compress.mode==="message" and there is at least one injection,
  // we compute the priorityMap and append the rendered guidance to EACH
  // of the three nudge kinds (context, turn, iteration), filtered to refs
  // at index < anchor (priority.ts:76-102 verbatim). Identification uses
  // the `kind` field emitted by nudges.mjs:563 (I-2a fix — robust to user
  // prompt overrides, unlike the previous text-signature approach).
  if (
    cfg.compress && cfg.compress.mode === "message" &&
    nudgePlan.injections && nudgePlan.injections.length > 0
  ) {
    // priorityMap is keyed by integer INDEX (post-step-5a rebuild).
    const priorityMap = buildPriorityMap(messages, refs, cfg)
    if (priorityMap.size > 0) {
      nudgePlan.injections = nudgePlan.injections.map((inj) => {
        if (!inj || typeof inj.text !== "string") return inj
        if (
          inj.kind !== "contextLimitNudge" &&
          inj.kind !== "turnNudge" &&
          inj.kind !== "iterationNudge"
        ) {
          return inj
        }
        // I-2b: blocked messages get no priority — filter them out before
        // rendering the priority list (DCP priority.ts:35 equivalence).
        const blockedSetForRender = buildBlockedSet(messages, cfg)
        const filteredPriorityMap = new Map()
        for (const [idx, entry] of priorityMap.entries()) {
          if (!blockedSetForRender.has(idx)) filteredPriorityMap.set(idx, entry)
        }
        const anchorIndex = typeof inj.index === "number" ? inj.index : -1
        const guidance = buildMessageModeGuidanceForKind(
          "high",
          filteredPriorityMap,
          anchorIndex,
        )
        if (!guidance) return inj
        return {
          ...inj,
          text: appendGuidanceToDcpTag(inj.text, guidance),
        }
      })
    }
  }

  // Step 10: apply nudges. Returns a NEW array (immutable per task-6 C-1).
  messages = applyNudges(messages, nudgePlan.injections || [])

  // Step 11: inject message IDs. priorityMap + blockedSet are keyed by
  // integer INDEX (the project convention; cross-file authorization I-2b).
  // blockedSet: when message mode + protectUserMessages, all user msg
  // indices are blocked (DCP inject.ts:165 + query.ts:61-72 semantics).
  const priorityMapForIds = buildPriorityMap(messages, refs, cfg)
  const blockedSet = buildBlockedSet(messages, cfg)
  // Filter blocked indices OUT of the priorityMap before passing downstream
  // (DCP priority.ts:35 — blocked messages get no priority). Mirrors the
  // filter applied at step 9's guidance render path.
  for (const idx of blockedSet) priorityMapForIds.delete(idx)
  injectMessageIds(messages, refs, { priorityMap: priorityMapForIds, blockedSet })

  // Step 12: assemble the return. Other body fields pass through by
  // reference (D5: shallow merge). Metrics fold every observed savings
  // signal into a single shape the caller can persist into stats.
  // Gate 1.5 A1: compressSavings = covered-original tokens − synthetic
  // tokens, NOT (rawSummary − enhancedSummary). The latter is ~0 for
  // every well-behaved compress call; the former is the real on-the-wire
  // saving that the user actually sees in /dcp-stats. See
  // estimateCompressSavings below for the full derivation.
  const compressSavings =
    compressErrorMessage ? 0 : activeBlocks.length > 0 && coveredIndices.size > 0
      ? estimateCompressSavings(activeBlocks, enhancedSummaries, coveredOriginalTokens)
      : 0

  // R3 / DESIGN D2: derive the maximum runId across ALL blocks (including
  // excluded/decompressed ones — the runId was assigned at parse time
  // regardless of whether the block survives to activeBlocks). The daemon
  // uses this as the "newly observed compress calls" upper bound; one
  // compress tool_use call contributes a single runId regardless of how
  // many range entries it carries. We therefore take the MAX over the
  // raw `blocks` array (NOT `activeBlocks` — consumed/nested/excluded
  // blocks still count toward runId allocation). compressError implies
  // blocks=[] (caught above), so maxRunId=0 in that case — daemon will
  // skip the seen update via compressRunsDelta.
  const maxRunId = compressErrorMessage
    ? 0
    : (Array.isArray(blocks) && blocks.length > 0
        ? blocks.reduce((m, b) => {
            const r = b && Number.isFinite(b.runId) ? b.runId : 0
            return r > m ? r : m
          }, 0)
        : 0)

  const metrics = {
    savedTokensEst:
      (prunePlan && prunePlan.savedTokensEst ? prunePlan.savedTokensEst : 0) +
      compressSavings,
    byStrategy: {
      dedup: (prunePlan && prunePlan.byStrategy && prunePlan.byStrategy.dedup ? prunePlan.byStrategy.dedup.length : 0),
      purge: (prunePlan && prunePlan.byStrategy && prunePlan.byStrategy.purgeErrors ? prunePlan.byStrategy.purgeErrors.length : 0),
      sweep: (prunePlan && prunePlan.byStrategy && Array.isArray(prunePlan.byStrategy.sweep) ? prunePlan.byStrategy.sweep.length : 0),
      compress: activeBlocks.length,
    },
    // R8.3 / DESIGN D3: per-strategy token split. Each bucket is the saved
    // tokens attributable to that strategy. The four buckets sum to
    // savedTokensEst by construction:
    //   dedup + purge + sweep = prunePlan.savedTokensEst (the prune layer
    //     is responsible for the dedup/purge split; sweep is the value
    //     added by the lightState.sweepToolCallIds merge above)
    //   compress = compressSavings (the value folded into savedTokensEst)
    // The pipeline also exports savedTokensByStrategy for the per-request
    // jsonl record (D3a) and for stats accumulation.
    savedTokensByStrategy: {
      dedup: (prunePlan && prunePlan.byStrategyTokens ? prunePlan.byStrategyTokens.dedup : 0),
      purge: (prunePlan && prunePlan.byStrategyTokens ? prunePlan.byStrategyTokens.purge : 0),
      sweep: (prunePlan && prunePlan.byStrategyTokens ? prunePlan.byStrategyTokens.sweep || 0 : 0),
      compress: compressSavings,
    },
    injectedNudges: nudgePlan.injections ? nudgePlan.injections.length : 0,
    activeBlocks: activeBlocks.length,
    // R3 / DESIGN D2: daemon wires compressRuns via
    //   stats.compressRunsDelta(maxRunId, lightState.maxRunIdSeen, !!compressError)
    // The seen baseline lives in light-state; we only export this request's
    // observed upper bound here.
    maxRunId,
  }
  if (nudgePlan.skipped) metrics.skipped = nudgePlan.skipped
  if (compressErrorMessage) metrics.compressError = compressErrorMessage
  // I-1 observation (brief §14): nudgeStarved = nudge planner produced zero
  // injections while the budget was already over max. Surface as a debug hint.
  if (
    metrics.injectedNudges === 0 &&
    isOverMax(pruneCfg, usage) &&
    nudgePlan.skipped === undefined
  ) {
    metrics.nudgeStarved = true
  }

  const lightStateUpdates = {
    anchors: nudgePlan.anchorUpdates || { context: [], turn: [], iter: [] },
    fetchCount: (lightState.fetchCount || 0) + 1,
    // Gate 1.5 B2 — always clear the directive after the pipeline runs. The
    // directive is a ONE-SHOT instruction consumed (and cleared) on the next
    // request. If we cleared it before processing, a pipeline-throw would
    // lose the directive; clearing it here, AFTER applyPrune, means the
    // directive survives a transient failure and gets retried on the next
    // request — matching the R11 idempotency contract for admin actions.
    sweepDirective: null,
  }
  // After consume: write the last-applied result so the next MCP dcp_sweep
  // call can surface "Last sweep: applied N, M protected skipped." as
  // operator-visible feedback. sweepLastResult is intentionally a separate
  // field from sweepDirective (the directive is gone after consume).
  if (sweepDirectiveResult) {
    lightStateUpdates.sweepLastResult = sweepDirectiveResult
  }

  // Gate 1.5 B3 — write the per-request activeBlockSummaries to the
  // lightStateUpdates so the daemon/MCP server can render the
  // "dcp_decompress (no-arg)" list. The shape is what the admin endpoint
  // serialises back in its {lightState} envelope. Each entry maps
  // blockId (integer) → topic (verbatim from the compress tool_use) →
  // approxTokens (estimated tokens the synthetic replacement would carry
  // — i.e. the on-the-wire cost of the existing summary, NOT the savings).
  // We rebuild this every request from `activeBlocks` so a stale summary
  // can never survive an excluded block becoming active or vice versa.
  // activeBlocks itself is already excluded-block-free (deriveBlocks drops
  // them at the source) so the writer needs no further filtering.
  lightStateUpdates.activeBlockSummaries = summarizeActiveBlocks(activeBlocks, enhancedSummaries)

  return {
    body: { ...safeBody, messages },
    metrics,
    lightStateUpdates,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sum `estimateMessageTokens` across the messages at the given integer
 * indices. Used by estimateCompressSavings to compute the covered-original
 * token total (the "what the upstream would have seen without this
 * compress block" baseline). Indices are unique by construction (caller
 * passes a Set), but we guard against undefined / out-of-range entries
 * defensively.
 *
 * @param {Array<object>} messages
 * @param {Set<number>} indices
 * @returns {number} token total across the indexed messages
 */
function sumTokensForIndices(messages, indices) {
  if (!Array.isArray(messages) || !indices || indices.size === 0) return 0
  let total = 0
  for (const idx of indices) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= messages.length) continue
    total += estimateMessageTokens(messages[idx])
  }
  return total
}

/**
 * Gate 1.5 B3 — build the `activeBlockSummaries` payload for the
 * lightStateUpdates. Each entry has the operator-facing view of one
 * active compress block:
 *
 *   { blockId, topic, approxTokens }
 *
 * `blockId` is the integer id (NOT the "bN" string — the admin endpoint
 * serialises the list and the MCP server formats the same way; the
 * numeric form is what `/dcp-admin/state/decompress?blockId=N` accepts).
 *
 * `topic` is verbatim from the compress tool_use's `input.topic`. Falls
 * back to "" when missing.
 *
 * `approxTokens` is the on-the-wire token estimate of the synthetic
 * summary that REPLACES the covered span in the next request. We
 * re-use the same wrap that `applyCompressions` builds so the value
 * matches what the upstream actually sees (defensive against drift if
 * the wrap changes in the future). This is the same number the MCP
 * server prints next to each block ("bN (~T tokens) - topic") — a
 * positive integer that's stable across requests.
 *
 * @param {Array<object>} activeBlocks — post-step-5a active set
 * @param {Map<string, string>} enhancedSummaries — blockId → summary text
 * @returns {Array<{blockId:number, topic:string, approxTokens:number}>}
 */
function summarizeActiveBlocks(activeBlocks, enhancedSummaries) {
  if (!Array.isArray(activeBlocks) || activeBlocks.length === 0) return []
  const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"
  const out = []
  for (const b of activeBlocks) {
    if (!b || typeof b.blockId !== "string") continue
    const idNum = Number.parseInt(b.blockId.slice(1), 10)
    if (!Number.isInteger(idNum)) continue
    const body = (enhancedSummaries instanceof Map
      ? (enhancedSummaries.get(b.blockId) || b.rawSummary || "")
      : (b.rawSummary || "")).trim()
    const wrapped = body.length === 0
      ? `${COMPRESSED_BLOCK_HEADER}\n<dcp-message-id>b${idNum}</dcp-message-id>`
      : `${COMPRESSED_BLOCK_HEADER}\n${body}\n\n<dcp-message-id>b${idNum}</dcp-message-id>`
    const tokens = estimateMessageTokens({
      role: "user",
      content: [{ type: "text", text: wrapped }],
    })
    out.push({
      blockId: idNum,
      topic: typeof b.topic === "string" ? b.topic : "",
      approxTokens: tokens,
    })
  }
  return out
}

/**
 * Compute the synthetic-message token total for the active compress blocks.
 *
 * Each active block inserts exactly ONE synthetic user message at its
 * `anchorIndex` containing `wrapCompressedSummary(blockId, body)`, where
 * `body` is the final enhanced summary text (or rawSummary as fallback).
 * We reconstruct the same string here so the synthetic token total can
 * be subtracted from the covered-original total.
 *
 * @param {Array<object>} activeBlocks
 * @param {Map<string, string>} enhancedSummaries
 * @returns {number} token total across the inserted synthetics
 */
function sumTokensForSynthetics(activeBlocks, enhancedSummaries) {
  if (!Array.isArray(activeBlocks) || activeBlocks.length === 0) return 0
  const summaries =
    enhancedSummaries instanceof Map
      ? enhancedSummaries
      : new Map(Object.entries(enhancedSummaries || {}))
  const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"
  let total = 0
  for (const b of activeBlocks) {
    if (!b || typeof b.blockId !== "string") continue
    const idNum = Number.parseInt(b.blockId.slice(1), 10)
    if (!Number.isInteger(idNum)) continue
    const body = (summaries.get(b.blockId) || b.rawSummary || "").trim()
    const wrapped = body.length === 0
      ? `${COMPRESSED_BLOCK_HEADER}\n<dcp-message-id>b${idNum}</dcp-message-id>`
      : `${COMPRESSED_BLOCK_HEADER}\n${body}\n\n<dcp-message-id>b${idNum}</dcp-message-id>`
    // The synthetic message is a user-role message with one text block
    // containing the wrapped summary — matches the shape produced by
    // applyCompressions so the estimator matches the on-the-wire cost.
    total += estimateMessageTokens({ role: "user", content: [{ type: "text", text: wrapped }] })
  }
  return total
}

/**
 * Gate 1.5 A1 — compress savings = covered-original tokens − synthetic
 * tokens.
 *
 * Pre-fix estimator summed (rawSummary.length − enhancedSummary.length)/4,
 * which is ~0 for every well-behaved compress call (the model writes a
 * concise summary, often shorter than the placeholder) — production users
 * saw 0 compress savings even after large compress blocks saved real wire
 * tokens. The corrected semantics match the on-the-wire saving the user
 * cares about:
 *
 *     savings = Σ estimateMessageTokens(covered originals, dedup'd via
 *               union of active blocks' coveredIndices)
 *             − Σ estimateMessageTokens(inserted synthetic summaries)
 *
 * The `coveredOriginalTokens` arg is computed by the caller BEFORE
 * applyCompressions (which mutates the messages array); the synthetic
 * total is derived here from enhancedSummaries + activeBlocks directly
 * (we reconstruct what applyCompressions would have inserted).
 *
 * Nested consume semantics: only ACTIVE blocks contribute. Consumed
 * blocks (whose anchor lies inside another active block's covered range)
 * are filtered out by the caller's filterActiveBlocks; their covered
 * indices are subsumed by the consuming block's range and counted exactly
 * once via the coveredIndices Set.
 *
 * @param {Array<object>} activeBlocks
 * @param {Map<string, string>} enhancedSummaries
 * @param {number} coveredOriginalTokens
 * @returns {number} max(0, coveredOriginalTokens − syntheticTokens)
 */
function estimateCompressSavings(activeBlocks, enhancedSummaries, coveredOriginalTokens) {
  if (!Array.isArray(activeBlocks) || activeBlocks.length === 0) return 0
  if (!Number.isFinite(coveredOriginalTokens) || coveredOriginalTokens <= 0) return 0
  const syntheticTokens = sumTokensForSynthetics(activeBlocks, enhancedSummaries)
  return Math.max(0, coveredOriginalTokens - syntheticTokens)
}

/**
 * Lightweight "are we over max context limit" probe — duplicates the resolver
 * logic from nudges.mjs because metrics computation must not depend on the
 * nudge plan's output (would create a feedback loop if nudges are silenced
 * for manual mode etc.).
 */
function isOverMax(cfg, usage) {
  if (!cfg || !cfg.compress || !usage || typeof usage !== "object") return false
  const total =
    (Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0) +
    (Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0) +
    (Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0) +
    (Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0)
  const max = cfg.compress.maxContextLimit
  if (typeof max !== "number" || !Number.isFinite(max)) return false
  return total > max
}

// ---------------------------------------------------------------------------
// Gate 1.5 B2 — sweep helpers
// ---------------------------------------------------------------------------

/**
 * Find the LAST user prompt in `messages` and return its index. Returns
 * -1 if no user prompt exists (DCP sweep.ts:38-47 semantics).
 *
 * ZCode-specific semantic: we want "the user's last prompt that triggered
 * tool activity" — not just any user-role message. Anthropic /v1/messages
 * carries tool_results in user-role messages too, so a literal "last
 * user-role" lookup would point at the trailing tool_result, which would
 * mean "tools after that" = [] and sweep would silently do nothing.
 *
 * The heuristic: a user prompt is a user-role message with at least one
 * `text` content block. Auto-generated tool_result-only user messages
 * (the model echoing tool outputs back) are not prompts and are skipped.
 *
 * Note: this is a faithful approximation of DCP's `isIgnoredUserMessage`
 * filter for the sweep case — DCP filters out messages containing the
 * sweep trigger text; we filter out messages that contain no text at all.
 * In practice, the only way a tool_result-only user message would be the
 * LAST user message in the array is when the user typed `/dcp sweep` via
 * the IDE slash command (which is NOT added to the messages array on
 * ZCode) — so this heuristic correctly skips "trailing protocol noise"
 * without ever blocking a real prompt.
 */
function findLastUserMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== "user" || !Array.isArray(m.content)) continue
    const hasText = m.content.some((p) => p && p.type === "text")
    if (hasText) return i
  }
  return -1
}

/**
 * Find the tool_result block for `callId`. Returns the block or null. The
 * is_error flag on the block drives the "skip errors in sweep" rule.
 */
function findToolResultForSweep(messages, callId) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m || m.role !== "user" || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (
        p && p.type === "tool_result" &&
        typeof p === "object" &&
        p.tool_use_id === callId
      ) {
        return { block: p, isError: p.is_error === true }
      }
    }
  }
  return null
}

/**
 * Compute the list of tool_use ids the sweepDirective should target.
 *
 * Mode semantics (DCP sweep.ts:152-168 port):
 *   - "since-user": every tool_use AFTER the last user message in document
 *     order. If no user message exists, returns [] (matches DCP's
 *     "Nothing swept: no user message found" branch).
 *   - "last-n": the LAST n tool_uses in document order (most-recent first).
 *     If n > total tool_uses, all are targeted.
 *
 * Each returned target carries the metadata the pipeline needs to apply the
 * skip rules (isProtected = protectedTools hit OR protectedFilePatterns hit).
 * The "already in prune set" check is done separately in the consumer (it
 * needs the live prune set).
 *
 * @param {Array<object>} messages
 * @param {{mode:"since-user"|"last-n", n:number|null, requestedAt:number}} directive
 * @returns {Array<{id:string, name:string, parameters:object, isProtected:boolean}>}
 */
function computeSweepTargetIds(messages, directive) {
  const targets = []
  if (!Array.isArray(messages) || !directive) return targets
  // Collect all tool_uses in document order (we need every one, even before
  // the user-anchor, so last-n can take the trailing n).
  const allToolUses = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (
        p && p.type === "tool_use" &&
        typeof p.id === "string" && p.id.length > 0
      ) {
        allToolUses.push({
          id: p.id,
          name: typeof p.name === "string" ? p.name : "",
          parameters: p.input && typeof p.input === "object" ? p.input : {},
          index: i,
        })
      }
    }
  }
  let scoped
  if (directive.mode === "since-user") {
    const lastUser = findLastUserMessageIndex(messages)
    if (lastUser < 0) return []
    scoped = allToolUses.filter((t) => t.index > lastUser)
  } else if (directive.mode === "last-n") {
    const n = Number.isFinite(directive.n) && directive.n > 0 ? Math.floor(directive.n) : 0
    if (n === 0) return []
    // Take the LAST n (most recent) in document order.
    scoped = allToolUses.slice(Math.max(0, allToolUses.length - n))
  } else {
    return []
  }

  // isProtected is derived by applySweepSkipRules below (cfg-driven); the
  // consumer (call site) checks prunePlan.pruneToolCallIds.has(id) for
  // "already applied" against the live prune set.
  return scoped
}

/**
 * Decide which of `targets` is "protected" (skip in sweep). Two reasons:
 *   - tool name hits commands.protectedTools
 *   - tool parameters hit protectedFilePatterns via getFilePathsFromParameters
 * Returns a new array where each target carries `isProtected: boolean`.
 */
function applySweepSkipRules(targets, cfg) {
  const protectedTools = (cfg && cfg.commands && Array.isArray(cfg.commands.protectedTools))
    ? cfg.commands.protectedTools
    : []
  const protectedFilePatterns = (cfg && Array.isArray(cfg.protectedFilePatterns))
    ? cfg.protectedFilePatterns
    : []
  return targets.map((t) => {
    const byName = isToolNameProtected(t.name, protectedTools)
    const paths = getFilePathsFromParameters(t.name, t.parameters)
    const byPath = isFilePathProtected(paths, protectedFilePatterns)
    return {
      ...t,
      isProtected: byName || byPath,
      byName,
      byPath,
      isError: false, // patched by caller after we see the tool_result
    }
  })
}

/**
 * Estimate the per-block token count for a sweep target id — the union of
 * its tool_use block and the matching tool_result block. Mirrors the
 * estimate used by planPrune (dedup/purge buckets).
 */
function estimateSweepBlockTokens(messages, id) {
  let total = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (!p || typeof p !== "object") continue
      if (p.type === "tool_use" && p.id === id) {
        total += estimateMessageTokens({ content: [p] })
      } else if (p.type === "tool_result" && p.tool_use_id === id) {
        total += estimateMessageTokens({ content: [p] })
      }
    }
  }
  return total
}

/**
 * Find a tool_use's tool_result and report whether it's an error. Used by
 * the sweep consume block to detect "is_error" tool_results (skipped by
 * sweep — purgeErrors handles error input cleaning separately).
 */
function isToolResultError(messages, id) {
  const r = findToolResultForSweep(messages, id)
  return r ? r.isError : false
}
