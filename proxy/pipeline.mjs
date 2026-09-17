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
 *                          activeBlocks, skipped?, nudgeStarved?, compressError? }
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
  // Wire sweepToolCallIds from the user's MCP-driven `/dcp-admin/state/sweep`
  // action into the prune set. These are tool_use ids the operator explicitly
  // marked "sweep" via MCP (DCP `sweepToolCallIds` semantics — the user's
  // earlier sweep marks carry across requests; without merging them here
  // the field is dead state in the proxy). After merging, re-estimate
  // savedTokensEst so the metrics reflect the sweep's contribution (planPrune
  // only accounted for the strategy-picked ids).
  const sweepIds = Array.isArray(lightState.sweepToolCallIds) ? lightState.sweepToolCallIds : []
  if (sweepIds.length > 0 && prunePlan.pruneToolCallIds instanceof Set) {
    if (!Array.isArray(prunePlan.byStrategy.sweep)) prunePlan.byStrategy.sweep = []
    for (const id of sweepIds) {
      if (typeof id === "string" && id.length > 0 && !prunePlan.pruneToolCallIds.has(id)) {
        prunePlan.pruneToolCallIds.add(id)
        prunePlan.byStrategy.sweep.push(id)
      }
    }
    // Re-estimate saved tokens for the sweep additions only (the strategy
    // picks were already accounted for in planPrune's estimate).
    for (const id of prunePlan.byStrategy.sweep) {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (!m || !Array.isArray(m.content)) continue
        for (const p of m.content) {
          if (!p || typeof p !== "object") continue
          if (p.type === "tool_use" && p.id === id) {
            prunePlan.savedTokensEst += estimateMessageTokens({ content: [p] })
          } else if (
            p.type === "tool_result" &&
            p.tool_use_id === id
          ) {
            prunePlan.savedTokensEst += estimateMessageTokens({ content: [p] })
          }
        }
      }
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
  const compressSavings =
    compressErrorMessage ? 0 : coveredIndices.size > 0
      ? estimateCompressSavings(activeBlocks, enhancedSummaries)
      : 0

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
    injectedNudges: nudgePlan.injections ? nudgePlan.injections.length : 0,
    activeBlocks: activeBlocks.length,
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
  }

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
 * Rough token-savings estimate for compress blocks: sum of the original
 * messages' tokens (estimation) minus the summary length tokens. Used for
 * stats display only — not for any control-flow decision.
 */
function estimateCompressSavings(activeBlocks, enhancedSummaries) {
  // We have access to refs.byIndex, not the messages — so an exact recount
  // is not possible here without re-walking. The pruning-side estimate is
  // already accurate for dedup/purge; for compress we report the COUNT of
  // active blocks as a coarse proxy (matches planPrune's "savedTokensEst"
  // being a coarse sum of block tokens — task-9 stats display tolerance).
  if (!Array.isArray(activeBlocks) || activeBlocks.length === 0) return 0
  let total = 0
  for (const b of activeBlocks) {
    const summary = enhancedSummaries.get(b.blockId)
    if (typeof summary === "string") total += Math.max(0, (b.rawSummary || "").length - summary.length)
  }
  // Return a count of "characters saved" / 4 → tokens. Stats display only.
  return Math.max(0, Math.round(total / 4))
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
