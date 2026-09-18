// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/compress/* (state.ts,
// range-utils.ts, protected-content.ts, search.ts, message.ts, message-utils.ts)
//                                                  + lib/messages/sync.ts
//                                                  + lib/messages/priority.ts
//                                                  + lib/prompts/extensions/nudge.ts
// Original copyright:
//   Copyright (c) Opencode-DCP authors. Licensed under AGPL-3.0-or-later.
//
// Behavior-faithful port adapted to ZCode Anthropic-protocol proxy (stateless).
// Differences from upstream (documented in docs/current/CAPABILITY-MAPPING.md):
//   - Stateless derivation: every block / selection / state is recomputed from
//     the current `messages` array on each call. There is no SessionState,
//     so the upstream `state.prune.messages.byMessageId` Map is reduced to a
//     transient set derived from messages (sync.ts:15-124 semantics applied
//     inline — origin must appear in the current array, otherwise the block
//     is dropped; consumed blocks are deactivated when a later block's
//     covered range subsumes their anchor).
//   - Key by message INDEX, not raw message id: Anthropic /v1/messages
//     request bodies never carry an `id` field on the message itself (SPEC
//     2026-09-11 decision; see test-lab/echo-capture.jsonl). All upstream
//     `byMessageId` Maps become Maps keyed by integer index in this module.
//     The synthetic compressed message is placed at the anchorIndex.
//     NOTE: buildPriorityMap returns entries keyed by the *ref* string (mNNNN)
//     because that is what task-8's listPriorityRefsBeforeIndex consumes
//     (priority.ts:76-102 — it iterates by rawIndex but pulls `entry.ref`).
//   - Tool-name recognition: upstream uses session metadata + the compress
//     tool name registered by the MCP server. In ZCode proxy mode we
//     recognize a compress call by matching the assistant `tool_use` block's
//     `name` against the configured `compressToolName` glob
//     (`mcp__*__compress` by default) AND checking that the following user
//     message carries a `tool_result` with `tool_use_id === tool_use.id` and
//     `is_error !== true`. Failed tool calls are ignored (don't create blocks).
//   - `appendProtectedTools` simplification: upstream awaits an optional
//     session client (used to fetch sub-agent transcripts). The ZCode port
//     uses only the synchronously-available tool_result content; sub-agent
//     result merging is intentionally absent (no equivalent in proxy mode).

import { estimateMessageTokens } from "./tokens.mjs"

// ---------------------------------------------------------------------------
// Public surface (PLAN Task 7)
// ---------------------------------------------------------------------------
//
// deriveBlocks(messages, refs, config)
// enhanceSummary(block, blocks, messages, refs, config)
// applyCompressions(messages, blocks, enhancedSummaries)
// validateCompressArgs(args, mode)
// buildPriorityMap(messages, refs, config)
// buildBlockGuidance(activeBlocks)
// ---------------------------------------------------------------------------

const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"
const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi
const PROTECT_TAG_REGEX = /<protect>([\s\S]*?)<\/protect>/gi
const PROTECTED_TOOLS_HEADING =
    "\n\nThe following protected tools were used in this conversation as well:"
const PROTECTED_USER_MESSAGES_HEADING =
    "\n\nThe following user messages were sent in this conversation verbatim:"
const PROTECTED_PROMPT_INFO_HEADING =
    "\n\nThe following protected prompt information was included in this conversation verbatim:"
const MISSING_BLOCKS_HEADING =
    "\n\nThe following previously compressed summaries were also part of this conversation section:"

const MEDIUM_PRIORITY_MIN_TOKENS = 500
const HIGH_PRIORITY_MIN_TOKENS = 5000

// ---------------------------------------------------------------------------
// Helpers: ID parsing (matches DCP message-ids.ts)
// ---------------------------------------------------------------------------

function parseRef(refString) {
    if (typeof refString !== "string" || refString.length === 0) return null
    const m = refString.match(/^m(\d+)$/i)
    if (m) {
        const n = Number.parseInt(m[1], 10)
        if (!Number.isInteger(n) || n < 1) return null
        return { kind: "message", ref: refString.toLowerCase(), index: n }
    }
    const b = refString.match(/^b(\d+)$/i)
    if (b) {
        const n = Number.parseInt(b[1], 10)
        if (!Number.isInteger(n) || n < 1) return null
        return { kind: "block", ref: refString.toLowerCase(), index: n }
    }
    return null
}

// Resolve a message ref like "m0003" against the refs table produced by
// message-ids.assignRefs. Returns the integer index into messages[].
// Throws (verbatim from DCP search.ts:78-94) if the ref cannot be resolved
// — silent skipping hid broken ranges from the model in the v1 port.
function resolveMessageRef(refString, refs) {
    const parsed = parseRef(refString)
    if (!parsed || parsed.kind !== "message") return null
    for (const [idx, entry] of refs.byIndex.entries()) {
        if (entry && entry.ref === parsed.ref) return idx
    }
    return null
}

// Resolve a block ref like "b1" against the blocks list produced by
// deriveBlocks. Returns the integer index of the referenced block in `blocks`,
// or null if unknown.
function resolveBlockRef(refString, blocks) {
    const parsed = parseRef(refString)
    if (!parsed || parsed.kind !== "block") return null
    const targetRef = `b${parsed.index}`
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].blockId === targetRef) return i
    }
    return null
}

// ---------------------------------------------------------------------------
// Helpers: message-shape utilities (Anthropic protocol)
// ---------------------------------------------------------------------------

function getContentBlocks(message) {
    if (!message || !Array.isArray(message.content)) return []
    return message.content
}

function getTextContent(message) {
    if (!message || !Array.isArray(message.content)) return ""
    for (const part of message.content) {
        if (part && part.type === "text" && typeof part.text === "string") {
            return part.text
        }
    }
    return ""
}

function getToolUse(message) {
    if (!message || !Array.isArray(message.content)) return null
    for (const part of message.content) {
        if (part && part.type === "tool_use") return part
    }
    return null
}

function getToolUses(message) {
    if (!message || !Array.isArray(message.content)) return []
    return message.content.filter((p) => p && p.type === "tool_use")
}

function getToolResults(message) {
    if (!message || !Array.isArray(message.content)) return []
    return message.content.filter((p) => p && p.type === "tool_result")
}

function isToolNameMatch(name, pattern) {
    if (!name || !pattern) return false
    const regex = new RegExp(
        "^" +
            pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
            "$",
    )
    return regex.test(name)
}

function isMcpToolName(name) {
    if (!name || typeof name !== "string") return false
    return /^mcp__[^_]+__[^_]/.test(name)
}

function stripMcpPrefix(name) {
    if (!isMcpToolName(name)) return name
    const match = /^mcp__[^_]+__(.*)$/.exec(name)
    return match ? match[1] : name
}

// ---------------------------------------------------------------------------
// Helpers: restoreSummary / wrapCompressedSummary (DCP state.ts:52-60,
// range-utils.ts:267-278 — verbatim char-for-char)
// ---------------------------------------------------------------------------

function restoreSummary(storedSummary) {
    if (typeof storedSummary !== "string") return ""
    const headerMatch = storedSummary.match(
        /^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]/i,
    )
    if (!headerMatch) return storedSummary
    let result = storedSummary.slice(headerMatch[0].length)
    result = result.replace(/^(?:\r?\n)+/, "")
    result = result.replace(
        /(?:\r?\n)*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i,
        "",
    )
    result = result.replace(/(?:\r?\n)+$/, "")
    return result
}

export function wrapCompressedSummary(blockId, summary) {
    const footer = `<dcp-message-id>b${blockId}</dcp-message-id>`
    const body = (summary || "").trim()
    if (body.length === 0) return `${COMPRESSED_BLOCK_HEADER}\n${footer}`
    return `${COMPRESSED_BLOCK_HEADER}\n${body}\n\n${footer}`
}

// ---------------------------------------------------------------------------
// Helpers: placeholder parsing (DCP range-utils.ts:103-125 verbatim)
// ---------------------------------------------------------------------------

function parseBlockPlaceholders(summary) {
    const placeholders = []
    if (typeof summary !== "string" || summary.length === 0) return placeholders
    const regex = new RegExp(BLOCK_PLACEHOLDER_REGEX)
    let match
    while ((match = regex.exec(summary)) !== null) {
        const blockIdPart = match[1] || match[2]
        const parsed = Number.parseInt(blockIdPart, 10)
        if (!Number.isInteger(parsed)) continue
        placeholders.push({
            raw: match[0],
            blockId: parsed,
            startIndex: match.index,
            endIndex: match.index + match[0].length,
        })
    }
    return placeholders
}

// ---------------------------------------------------------------------------
// Helpers: protected-section appenders (verbatim from DCP
// protected-content.ts:16-208 with three adaptations noted in the file header)
// ---------------------------------------------------------------------------

function isToolNameProtectedForCompress(toolName, patterns) {
    if (!toolName || !patterns || patterns.length === 0) return false
    const exact = new Set()
    const glob = []
    for (const p of patterns) {
        if (typeof p !== "string") continue
        if (/[*?]/.test(p)) glob.push(p)
        else exact.add(p)
    }
    if (exact.has(toolName)) return true
    if (glob.some((p) => matchGlob(toolName, p))) return true
    const stripped = stripMcpPrefix(toolName)
    if (stripped && stripped !== toolName) {
        if (exact.has(stripped)) return true
        if (glob.some((p) => matchGlob(stripped, p))) return true
    }
    return false
}

function matchGlob(input, pattern) {
    let re = "^"
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i]
        const next = pattern[i + 1]
        if (c === "*") {
            if (next === "*") {
                if (pattern[i + 2] === "/") {
                    re += "(?:.*/)?"
                    i += 2
                    continue
                }
                re += ".*"
                i++
                continue
            }
            re += "[^/]*"
            continue
        }
        if (c === "?") {
            re += "[^/]"
            continue
        }
        if (/[.+^${}()|[\]\\]/.test(c)) {
            re += "\\" + c
            continue
        }
        re += c
    }
    re += "$"
    return new RegExp(re).test(input)
}

function matchPathPattern(filePath, pattern) {
    if (!filePath || !pattern) return false
    return matchGlob(
        filePath.replaceAll("\\", "/"),
        pattern.replaceAll("\\", "/"),
    )
}

function getFilePathsFromToolInput(input) {
    if (!input || typeof input !== "object") return []
    const out = []
    if (typeof input.file_path === "string") out.push(input.file_path)
    if (typeof input.path === "string") out.push(input.path)
    return out
}

// ---------------------------------------------------------------------------
// deriveBlocks (PLAN: deriveBlocks(messages, refs, config, opts?))
// ---------------------------------------------------------------------------
//
// Scans the conversation for successful compress tool_use calls, computes the
// covered message indices for each call, and applies nesting (a later block
// whose covered range subsumes an earlier block's anchorIndex consumes the
// earlier one). Failed tool_results (is_error=true) and non-matching tool
// names are ignored.
//
// Returns an array of blocks in chronological order. Each block carries:
//   - blockId: "bN" — sequential allocation per session
//   - runId: integer — shared across blocks created by a single tool call
//   - anchorIndex: integer — message index where the synthetic message lands
//   - coveredIndices: integer[] — sorted, unique message indices consumed
//   - startRef / endRef: raw boundary ids from the tool_use input
//   - topic / rawSummary: verbatim from the tool_use input
//   - consumedBlockIds: integer[] — ids of earlier blocks this block consumed
//     (per DCP state.ts:62-268 — block.consumedBlockIds = the older blocks
//     that THIS block subsumed)
//
// opts (4th arg, optional):
//   excludedBlockIds : number[] — block ids to skip (operator-marked
//     "deactivatedByUser" via /dcp-admin/state/decompress). The matching
//     block is omitted from the returned list entirely (the synthetic
//     message that would replace its covered range is NOT inserted into
//     the messages array). This is the CAP-20 decompress/recompress
//     functionality's persistence layer — DCP keeps these in
//     `state.decompressBlockIds`; the proxy port keeps them in
//     lightState.decompressBlockIds and passes them here per request.
export function deriveBlocks(messages, refs, config, opts) {
    if (!Array.isArray(messages)) return []
    if (!refs || !refs.byIndex) return []
    const cfg = config || {}
    const toolPattern = cfg.compressToolName || "mcp__*__compress"
    const excluded = (opts && Array.isArray(opts.excludedBlockIds))
        ? new Set(opts.excludedBlockIds.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))
        : new Set()
    const blocks = []
    let nextBlockId = 1
    let nextRunId = 1

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (!msg || msg.role !== "assistant") continue
        const toolUse = getToolUse(msg)
        if (!toolUse) continue
        const toolName = toolUse.name
        if (!toolName) continue
        if (!isToolNameMatch(toolName, toolPattern)) continue

        const next = i + 1 < messages.length ? messages[i + 1] : null
        const toolResult = next ? getToolResults(next)[0] : null
        if (!toolResult) continue
        if (toolResult.tool_use_id !== toolUse.id) continue
        if (toolResult.is_error === true) continue

        const input = toolUse.input || {}
        const topic = typeof input.topic === "string" ? input.topic : ""
        const content = Array.isArray(input.content) ? input.content : []
        if (!topic || content.length === 0) continue

        // Per-batch: validateNonOverlapping (range-utils.ts:70-101) before
        // allocating any block for this compress call.
        validateNonOverlapping(content)

        for (let cIdx = 0; cIdx < content.length; cIdx++) {
            const entry = content[cIdx]
            if (!entry) continue
            const startRef =
                typeof entry.startId === "string" ? entry.startId.trim() : ""
            const endRef =
                typeof entry.endId === "string" ? entry.endId.trim() : ""
            const summary =
                typeof entry.summary === "string" ? entry.summary : ""
            if (!startRef || !endRef || !summary.trim()) continue

            // Throws (search.ts:78-94 verbatim) if the ref can't be resolved
            // — silent skipping hid broken ranges in the v1 port (C-1 hunt).
            // Pass the boundary label explicitly so the error message names
            // startId vs endId correctly (Minor-3 review fix).
            const startIdx = resolveMessageRefOrThrow(startRef, refs, "startId")
            const endIdx = resolveMessageRefOrThrow(endRef, refs, "endId")
            if (startIdx > endIdx) {
                throw new Error(
                    `startId ${startRef} appears after endId ${endRef} in the conversation. Start must come before end.`,
                )
            }

            const coveredIndices = collectCoveredIndices(messages, startIdx, endIdx)
            const blockId = nextBlockId++
            const block = {
                blockId: `b${blockId}`,
                runId: nextRunId,
                anchorIndex: startIdx,
                coveredIndices,
                startRef,
                endRef,
                topic,
                rawSummary: summary,
                consumedBlockIds: [],
                mode: "range",
                compressMessageIndex: i,
            }
            // CAP-20 decompress: the operator marked this block id via
            // /dcp-admin/state/decompress. Skip appending it so the
            // pipeline's range-replacement step does NOT insert the
            // synthetic summary message. The original covered messages
            // are left untouched, effectively "restoring" the conversation
            // for downstream requests.
            if (!excluded.has(blockId)) blocks.push(block)
        }
        nextRunId++
    }

    // Chained nesting: for each pair (older, newer) where newer.coveredIndices
    // includes older.anchorIndex, mark older as consumed by newer. Iterate in
    // chronological order so the most-recent consumer wins (I1 fix — the v1
    // port's "older.consumedBlockIds.length > 0" gate only caught DIRECT
    // consumption and missed b2 being consumed by b3 in a 3-deep chain).
    for (let n = 0; n < blocks.length; n++) {
        const newer = blocks[n]
        for (let m = 0; m < n; m++) {
            const older = blocks[m]
            if (newer.consumedBlockIds.includes(parseInt(older.blockId.slice(1), 10)))
                continue
            if (newer.coveredIndices.includes(older.anchorIndex)) {
                newer.consumedBlockIds.push(
                    parseInt(older.blockId.slice(1), 10),
                )
            }
        }
    }

    return blocks
}

function resolveMessageRefOrThrow(refString, refs, label) {
    const idx = resolveMessageRef(refString, refs)
    if (idx == null) {
        throw new Error(
            `${label} ${refString} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }
    return idx
}

// validateNonOverlapping (range-utils.ts:70-101 verbatim) — throws when two
// ranges in a single compress call overlap.
function validateNonOverlapping(content) {
    if (!Array.isArray(content) || content.length < 2) return
    // Sort by startRef / endRef lex order — good enough for mNNNN and bN
    // references since the assignment is deterministic. The full upstream
    // numeric sort requires a SessionState that we don't have; the proxy
    // caller passes already-validated refs so lex order matches numeric
    // order for mNNNN.
    const sorted = content
        .map((entry, index) => ({ entry, index }))
        .slice()
        .sort((a, b) => {
            const aS = a.entry.startId || ""
            const aE = a.entry.endId || ""
            const bS = b.entry.startId || ""
            const bE = b.entry.endId || ""
            return (
                aS.localeCompare(bS) ||
                aE.localeCompare(bE) ||
                a.index - b.index
            )
        })
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]
        const curr = sorted[i]
        if (!prev || !curr) continue
        if (curr.entry.startId.localeCompare(prev.entry.endId) > 0) continue
        throw new Error(
            `content[${prev.index}] (${prev.entry.startId}..${prev.entry.endId}) overlaps content[${curr.index}] (${curr.entry.startId}..${curr.entry.endId}). Overlapping ranges cannot be compressed in the same batch.`,
        )
    }
}

function collectCoveredIndices(messages, startIdx, endIdx) {
    const out = []
    const seen = new Set()
    for (let i = startIdx; i <= endIdx; i++) {
        if (i < 0 || i >= messages.length) continue
        const msg = messages[i]
        if (!msg) continue
        if (!seen.has(i)) {
            seen.add(i)
            out.push(i)
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// enhanceSummary (PLAN: enhanceSummary(block, blocks, messages, refs, config))
// ---------------------------------------------------------------------------
//
// Produces the final stored summary for a block. The "active set" for this
// block is computed inline (blocks excluding any block in this block's own
// consumedBlockIds AND excluding any block consumed by a later block — see
// I6 fix). The upstream search.ts:30-36 only includes active blocks in
// summaryByBlockId / requiredBlockIds; we mirror that.
//
// Order (verbatim from DCP range.ts:99-139):
//   1. Placeholder validation (range-utils.ts:127-168): keep only entries
//      that are known + required + not-yet-kept (isKnown && isRequired &&
//      !isDuplicate). Unknown / non-required / duplicate entries are
//      filtered — the FILTERED entries' RAW TEXT stays in the summary
//      (range-utils.ts:170-201 doesn't touch text outside placeholder
//      boundaries). C-2 fix.
//   2. Placeholder injection (range-utils.ts:170-224): replace kept
//      placeholders in order with the restored body of the referenced
//      block; track consumed ids.
//   3. Boundary absorption (range-utils.ts:280-308): if start or end
//      boundary is a block and that block hasn't been consumed yet,
//      prepend/append.
//   4. Protected-user-message append (protected-content.ts:16-54) —
//      collect ALL user messages in the selection (I3 fix; upstream loop
//      has no early `break`).
//   5. Protected-prompt-info append (protected-content.ts:56-94 + 96-108).
//   6. Protected-tools append (protected-content.ts:110-208, simplified to
//      synchronous tool_result inspection; I4 fix — pair by tool_use_id,
//      not by "previous message"). Skip messages covered by an active block
//      (protected-content.ts:28-31).
//   7. Missing-block append (range-utils.ts:226-265) — appends "### (bN)"
//      subsections for required blocks not yet consumed. Throws (M2 fix)
//      if the referenced block is missing from the active set.
//
// Returns: { summary: <final text>, consumedBlockIds: integer[] }
export function enhanceSummary(block, blocks, messages, refs, config) {
    if (!block) return { summary: "", consumedBlockIds: [] }
    const cfg = config || {}
    const rawSummary = block.rawSummary || ""

    // Active set: blocks minus (a) those consumed by THIS block and (b)
    // those consumed by a later block (so they wouldn't be active in the
    // current session state). I6 fix.
    const consumedByAnyone = new Set()
    for (const b of blocks) {
        if (Array.isArray(b.consumedBlockIds)) {
            for (const id of b.consumedBlockIds) consumedByAnyone.add(id)
        }
    }
    const activeBlocks = blocks.filter(
        (b) => !consumedByAnyone.has(parseInt(b.blockId.slice(1), 10)),
    )
    const summaryByBlockId = buildSummaryByBlockId(activeBlocks)

    // Selection indices (range-utils.ts:124-154 in upstream, keyed by
    // message id; here keyed by integer index).
    const selectionIndices = (block.coveredIndices || []).slice()

    // Required-block ids: active blocks whose anchorIndex lies inside the
    // selection (range-utils.ts:156-181).
    const requiredBlockIds = []
    const requiredBlockSeen = new Set()
    for (const b of activeBlocks) {
        if (b.blockId === block.blockId) continue
        if (selectionIndices.includes(b.anchorIndex)) {
            const id = parseInt(b.blockId.slice(1), 10)
            if (!requiredBlockSeen.has(id)) {
                requiredBlockSeen.add(id)
                requiredBlockIds.push(id)
            }
        }
    }

    // Boundary-optional ids (range-utils.ts:134-146): start/end refs that
    // point to a block don't strictly require (bN) expansion.
    const boundaryOptionalIds = new Set()
    const startBlockIdx = resolveBlockRef(block.startRef, activeBlocks)
    const endBlockIdx = resolveBlockRef(block.endRef, activeBlocks)
    if (startBlockIdx != null) {
        boundaryOptionalIds.add(
            parseInt(activeBlocks[startBlockIdx].blockId.slice(1), 10),
        )
    }
    if (endBlockIdx != null) {
        boundaryOptionalIds.add(
            parseInt(activeBlocks[endBlockIdx].blockId.slice(1), 10),
        )
    }

    // Parse all placeholders from the raw summary; filter via upstream rules.
    const allPlaceholders = parseBlockPlaceholders(rawSummary)
    const requiredSet = new Set(requiredBlockIds)
    const keptIds = new Set()
    const validPlaceholders = []
    for (const ph of allPlaceholders) {
        const isKnown = summaryByBlockId.has(ph.blockId)
        const isRequired = requiredSet.has(ph.blockId)
        const isDuplicate = keptIds.has(ph.blockId)
        // Upstream rule verbatim (range-utils.ts:158):
        if (isKnown && isRequired && !isDuplicate) {
            validPlaceholders.push(ph)
            keptIds.add(ph.blockId)
        }
    }

    // injectBlockPlaceholders — replace KEPT placeholders in order. The
    // filtered-out placeholders' raw text remains verbatim in the summary
    // (range-utils.ts:184-201 only iterates over the kept placeholders).
    let expanded = rawSummary
    const consumedSeen = new Set()
    const consumed = []

    if (validPlaceholders.length > 0) {
        let cursor = 0
        let next = ""
        for (const ph of validPlaceholders) {
            const target = summaryByBlockId.get(ph.blockId)
            if (!target) continue
            next += rawSummary.slice(cursor, ph.startIndex)
            next += restoreSummary(target.rawSummary)
            cursor = ph.endIndex
            if (!consumedSeen.has(ph.blockId)) {
                consumedSeen.add(ph.blockId)
                consumed.push(ph.blockId)
            }
        }
        next += rawSummary.slice(cursor)
        expanded = next
    }

    // injectBoundarySummary (range-utils.ts:280-308): boundary optional ids
    // that we haven't consumed yet (i.e. weren't referenced via (bN) and
    // weren't already absorbed) get prepended/appended.
    if (startBlockIdx != null) {
        const startB = activeBlocks[startBlockIdx]
        const id = parseInt(startB.blockId.slice(1), 10)
        if (!consumedSeen.has(id) && boundaryOptionalIds.has(id)) {
            const left = restoreSummary(startB.rawSummary).trim()
            const right = expanded.trim()
            expanded =
                !left ? right : !right ? left : `${left}\n\n${right}`
            consumedSeen.add(id)
            consumed.push(id)
        }
    }
    if (endBlockIdx != null) {
        const endB = activeBlocks[endBlockIdx]
        const id = parseInt(endB.blockId.slice(1), 10)
        if (!consumedSeen.has(id) && boundaryOptionalIds.has(id)) {
            const left = expanded.trim()
            const right = restoreSummary(endB.rawSummary).trim()
            expanded =
                !left ? right : !right ? left : `${left}\n\n${right}`
            consumedSeen.add(id)
            consumed.push(id)
        }
    }

    // appendProtectedUserMessages (verbatim from protected-content.ts:16-54)
    // Pass `block.blockId` so the helper can distinguish self-coverage
    // (allowed) from sibling-active coverage (skip — protected-content.ts:28-31).
    if (cfg.compress && cfg.compress.protectUserMessages === true) {
        expanded = appendProtectedUserMessagesInternal(
            expanded,
            selectionIndices,
            messages,
            activeBlocks,
            block.blockId,
        )
    }

    // appendProtectedPromptInfo
    if (cfg.compress && cfg.compress.protectTags === true) {
        expanded = appendProtectedPromptInfoInternal(
            expanded,
            selectionIndices,
            messages,
            activeBlocks,
            block.blockId,
        )
    }

    // appendProtectedTools (synchronous tool_result inspection).
    expanded = appendProtectedToolsInternal(
        expanded,
        selectionIndices,
        messages,
        cfg.compress && cfg.compress.protectedTools
            ? cfg.compress.protectedTools
            : [],
        cfg.protectedFilePatterns || [],
        activeBlocks,
        block.blockId,
    )

    // appendMissingBlockSummaries — required blocks that aren't yet consumed
    // get a "### (bN)" subsection appended.
    const missingBlockIds = requiredBlockIds.filter((id) => !consumedSeen.has(id))
    if (missingBlockIds.length > 0) {
        const subsections = []
        for (const id of missingBlockIds) {
            const target = summaryByBlockId.get(id)
            // M2 fix: align with upstream range-utils.ts:241-244 — throw if
            // a referenced block is missing from the active set.
            if (!target) {
                throw new Error(`Compressed block not found: (b${id})`)
            }
            subsections.push(`\n### (b${id})\n${restoreSummary(target.rawSummary)}`)
            consumedSeen.add(id)
            consumed.push(id)
        }
        expanded = expanded + MISSING_BLOCKS_HEADING + subsections.join("")
    }

    return { summary: expanded, consumedBlockIds: consumed }
}

function buildSummaryByBlockId(blocks) {
    const map = new Map()
    for (const b of blocks) {
        const id = parseInt(String(b.blockId).slice(1), 10)
        if (Number.isInteger(id) && id > 0) map.set(id, b)
    }
    return map
}

// Protected-section helpers. Upstream protected-content.ts:28-31
// semantics: skip a message whose compression state already has active
// blocks (here: covered by a SIBLING active block, not the current block
// itself). ownBlockId lets the helper tell the difference.

function appendProtectedUserMessagesInternal(
    summary,
    selectionIndices,
    messages,
    activeBlocks,
    ownBlockId,
) {
    const userTexts = []
    for (const idx of selectionIndices) {
        const msg = messages[idx]
        if (!msg) continue
        if (msg.role !== "user") continue
        // I6 + IMPORTANT-1 review fix: skip messages covered by a SIBLING
        // active block (protected-content.ts:28-31). Self-coverage
        // (ownBlockId === covering block) is allowed.
        if (isMessageCoveredByOtherActive(idx, activeBlocks, ownBlockId))
            continue
        const text = getTextContent(msg)
        if (text && text.trim()) {
            userTexts.push(text)
            // Per upstream protected-content.ts:42-44: take the FIRST non-empty
            // text part per user message (the `break` is INSIDE the per-part
            // loop, not the per-message loop — I3 fix).
        }
    }
    if (userTexts.length === 0) return summary
    const body = userTexts.map((t) => `\n${t}`).join("")
    return summary + PROTECTED_USER_MESSAGES_HEADING + body
}

function appendProtectedPromptInfoInternal(
    summary,
    selectionIndices,
    messages,
    activeBlocks,
    ownBlockId,
) {
    const protectedTexts = []
    for (const idx of selectionIndices) {
        const msg = messages[idx]
        if (!msg) continue
        if (msg.role !== "user") continue
        if (isMessageCoveredByOtherActive(idx, activeBlocks, ownBlockId))
            continue
        const text = getTextContent(msg)
        if (!text) continue
        const matches = text.matchAll(PROTECT_TAG_REGEX)
        for (const match of matches) {
            const inner = match[1] && match[1].trim()
            if (inner) protectedTexts.push(inner)
        }
    }
    if (protectedTexts.length === 0) return summary
    const body = protectedTexts.map((t) => `\n${t}`).join("")
    return summary + PROTECTED_PROMPT_INFO_HEADING + body
}

function appendProtectedToolsInternal(
    summary,
    selectionIndices,
    messages,
    protectedTools,
    protectedFilePatterns,
    activeBlocks,
    ownBlockId,
) {
    if (!protectedTools || protectedTools.length === 0) return summary
    if (!messages) return summary
    const protectedOutputs = []
    for (const idx of selectionIndices) {
        const msg = messages[idx]
        if (!msg) continue
        if (msg.role !== "user") continue
        if (isMessageCoveredByOtherActive(idx, activeBlocks, ownBlockId))
            continue
        // I4 fix: iterate ALL tool_results in this user message and pair each
        // with its originating assistant tool_use by tool_use_id (the upstream
        // uses callID; the Anthropic protocol uses tool_use_id on the
        // tool_result and `id` on the tool_use — they are the same value).
        const toolResults = getToolResults(msg)
        for (const toolResult of toolResults) {
            const toolUseId = toolResult.tool_use_id
            if (typeof toolUseId !== "string") continue
            const { toolUse, toolUseIdx } = findToolUseById(messages, toolUseId, idx)
            if (!toolUse) continue
            const toolName = toolUse.name
            if (!toolName) continue
            let isProtected = isToolNameProtectedForCompress(
                toolName,
                protectedTools,
            )
            if (!isProtected && protectedFilePatterns.length > 0) {
                const filePaths = getFilePathsFromToolInput(toolUse.input)
                isProtected = filePaths.some((p) =>
                    protectedFilePatterns.some((pat) => matchPathPattern(p, pat)),
                )
            }
            if (!isProtected) continue
            const title = `Tool: ${toolName}`
            let output = ""
            const content = toolResult.content
            if (typeof content === "string") {
                output = content
            } else if (Array.isArray(content)) {
                output = content
                    .filter((c) => c && c.type === "text")
                    .map((c) => c.text || "")
                    .join("")
            }
            if (output) {
                protectedOutputs.push(`\n### ${title}\n${output}`)
            }
            // Reference toolUseIdx to satisfy noUnused checks (the index
            // is useful for callers debugging which call a tool came from).
            void toolUseIdx
        }
    }
    if (protectedOutputs.length === 0) return summary
    return summary + PROTECTED_TOOLS_HEADING + protectedOutputs.join("")
}

// Find the assistant tool_use whose `id === toolUseId`, scanning the
// message preceding `userMsgIdx` (and walking back for parallel calls —
// DCP uses byMessageId lookup; we use linear search since we key by index).
function findToolUseById(messages, toolUseId, userMsgIdx) {
    // Look back up to N messages (parallel calls all live in the same
    // assistant message; we accept up to 3 prior assistants to handle
    // interleaved tool_use/tool_result pairs).
    for (let back = 1; back <= 3; back++) {
        const i = userMsgIdx - back
        if (i < 0) break
        const candidate = messages[i]
        if (!candidate || candidate.role !== "assistant") continue
        const uses = getToolUses(candidate)
        for (let j = 0; j < uses.length; j++) {
            if (uses[j].id === toolUseId) {
                return { toolUse: uses[j], toolUseIdx: i }
            }
        }
    }
    return { toolUse: null, toolUseIdx: -1 }
}

// Upstream protected-content.ts:28-31 — skip a message whose compression
// state already has active blocks (here: covered by a SIBLING active block).
// IMPORTANT-1 review fix: the v1 port exempted any message inside the
// current block's own selection (always true, since callers passed the
// same array being iterated) — that made the exemption dead code and
// caused sibling-active overlaps to be double-counted. The correct
// invariant: skip iff an active block OTHER THAN the one we're enhancing
// covers this message. Self-overlap is allowed because the current block
// owns its own covered indices.
function isMessageCoveredByOtherActive(idx, activeBlocks, ownBlockId) {
    for (const b of activeBlocks) {
        if (!b.coveredIndices || !b.coveredIndices.includes(idx)) continue
        if (b.blockId === ownBlockId) continue
        return true
    }
    return false
}

// ---------------------------------------------------------------------------
// applyCompressions (PLAN: applyCompressions(messages, blocks, enhancedSummaries))
// ---------------------------------------------------------------------------
//
// The caller passes the FULL blocks list (consumed + active). We filter
// internally to drop consumed blocks before splicing synthetics. C-2 hunt
// fix: previous implementation had a dead branch (`looksUnfiltered` was
// always false after a recent edit) that re-injected consumed blocks.
//
// For each active block:
//   - Remove all block.coveredIndices from the message list
//   - Insert a single synthetic user message at block.anchorIndex
//   - Synthetic content: [{type:"text", text: wrapCompressedSummary(blockId, body)}]
//
// Multiple active blocks whose anchorIndex collides → throw (M-2 hunt fix).
// Returns a NEW messages array (no mutation of the input).
export function applyCompressions(messages, blocks, enhancedSummaries) {
    if (!Array.isArray(messages)) return []
    if (!Array.isArray(blocks)) blocks = []
    const summaries =
        enhancedSummaries instanceof Map
            ? enhancedSummaries
            : new Map(Object.entries(enhancedSummaries || {}))

    // Active set: blocks not consumed by any other block.
    const consumedSet = new Set()
    for (const b of blocks) {
        if (Array.isArray(b.consumedBlockIds)) {
            for (const id of b.consumedBlockIds) consumedSet.add(id)
        }
    }
    const activeBlocks = blocks.filter(
        (b) => !consumedSet.has(parseInt(String(b.blockId).slice(1), 10)),
    )

    // M-2 hunt fix: shared anchor across active blocks would silently lose
    // the earlier synthetic. Throw to surface the upstream data problem.
    const anchorCounts = new Map()
    for (const b of activeBlocks) {
        anchorCounts.set(b.anchorIndex, (anchorCounts.get(b.anchorIndex) || 0) + 1)
    }
    for (const [anchor, count] of anchorCounts.entries()) {
        if (count > 1) {
            throw new Error(
                `applyCompressions: ${count} active blocks share anchorIndex ${anchor}; rerun compress derivation to ensure anchors are unique.`,
            )
        }
    }

    // Build removeSet and synthetic lookup.
    const removeSet = new Set()
    for (const b of activeBlocks) {
        if (!b || !b.coveredIndices) continue
        for (const idx of b.coveredIndices) removeSet.add(idx)
    }
    const syntheticsByAnchor = new Map()
    for (const b of activeBlocks) {
        const body = summaries.get(b.blockId) || b.rawSummary || ""
        const blockIdNum = parseInt(String(b.blockId).slice(1), 10)
        const wrapped = wrapCompressedSummary(blockIdNum, body)
        const synth = {
            role: "user",
            content: [{ type: "text", text: wrapped }],
        }
        syntheticsByAnchor.set(b.anchorIndex, synth)
    }

    // Splice.
    const output = []
    for (let i = 0; i < messages.length; i++) {
        if (removeSet.has(i)) {
            if (syntheticsByAnchor.has(i)) {
                output.push(syntheticsByAnchor.get(i))
                syntheticsByAnchor.delete(i)
            }
            continue
        }
        output.push(messages[i])
    }
    for (const [anchor, synth] of syntheticsByAnchor.entries()) {
        if (anchor < 0 || anchor >= messages.length) {
            output.push(synth)
        }
    }
    return output
}

// ---------------------------------------------------------------------------
// validateCompressArgs (PLAN: validateCompressArgs(args, mode))
// ---------------------------------------------------------------------------
//
// Range mode:  { topic, content: [{ startId, endId, summary }] }
// Message mode: { topic, content: [{ messageId, topic, summary }] }
export function validateCompressArgs(args, mode) {
    if (!args || typeof args !== "object") {
        throw new Error("args is required and must be an object")
    }
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }
    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }

    if (mode === "message") {
        for (let i = 0; i < args.content.length; i++) {
            const entry = args.content[i]
            const prefix = `content[${i}]`
            if (
                typeof entry?.messageId !== "string" ||
                entry.messageId.trim().length === 0
            ) {
                throw new Error(
                    `${prefix}.messageId is required and must be a non-empty string`,
                )
            }
            if (typeof entry?.topic !== "string" || entry.topic.trim().length === 0) {
                throw new Error(
                    `${prefix}.topic is required and must be a non-empty string`,
                )
            }
            if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
                throw new Error(
                    `${prefix}.summary is required and must be a non-empty string`,
                )
            }
        }
        return
    }

    for (let i = 0; i < args.content.length; i++) {
        const entry = args.content[i]
        const prefix = `content[${i}]`
        if (typeof entry?.startId !== "string" || entry.startId.trim().length === 0) {
            throw new Error(`${prefix}.startId is required and must be a non-empty string`)
        }
        if (typeof entry?.endId !== "string" || entry.endId.trim().length === 0) {
            throw new Error(`${prefix}.endId is required and must be a non-empty string`)
        }
        if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
            throw new Error(`${prefix}.summary is required and must be a non-empty string`)
        }
    }
}

// ---------------------------------------------------------------------------
// buildPriorityMap (PLAN: buildPriorityMap(messages, refs, config))
// ---------------------------------------------------------------------------
//
// Returns Map<index, { ref, tokenCount, priority }> keyed by INTEGER MESSAGE
// INDEX into the current `messages` array (cross-file authorization, task-11
// review I-2b). The `ref` field still carries the mNNNN string for downstream
// rendering (priority list / tag attribute); the *key* is the index so the
// caller can look up priority directly by iterating position.
//
// Mode gate (priority.ts:25-27 verbatim): returns an empty Map when
// config.compress.mode !== "message".
//
// Any message that contains a compress tool_use block is forced to "high"
// (priority.ts:57 — `messageHasCompress(message)`).
//
// Caller contract: the priorityMap key is the index into the messages array
// the caller passed in. The pipeline must rebuild this map AFTER
// applyCompressions (which mutates array shape) so the index→priority mapping
// stays accurate.
export function buildPriorityMap(messages, refs, config) {
    const cfg = config || {}
    if (cfg.compress && cfg.compress.mode !== "message") {
        return new Map()
    }
    const out = new Map()
    if (!Array.isArray(messages)) return out
    if (!refs || !refs.byIndex) return out
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (!msg) continue
        if (msg.role !== "user" && msg.role !== "assistant") continue
        const entry = refs.byIndex.get(i)
        if (!entry || !entry.ref) continue
        const toolUse = getToolUse(msg)
        if (toolUse && isCompressToolUse(toolUse)) {
            out.set(i, {
                ref: entry.ref,
                tokenCount: estimateMessageTokens(msg),
                priority: "high",
            })
            continue
        }
        const tokens = estimateMessageTokens(msg)
        out.set(i, {
            ref: entry.ref,
            tokenCount: tokens,
            priority: classifyPriority(tokens),
        })
    }
    return out
}

function isCompressToolUse(toolUse) {
    if (!toolUse || typeof toolUse.name !== "string") return false
    return isToolNameMatch(toolUse.name, "mcp__*__compress")
}

function classifyPriority(tokenCount) {
    if (tokenCount >= HIGH_PRIORITY_MIN_TOKENS) return "high"
    if (tokenCount >= MEDIUM_PRIORITY_MIN_TOKENS) return "medium"
    return "low"
}

// ---------------------------------------------------------------------------
// buildBlockGuidance (PLAN: buildBlockGuidance(activeBlocks))
// ---------------------------------------------------------------------------
//
// Produces the nudge.ts:3-16 text verbatim. `activeBlocks` is the array of
// blocks from deriveBlocks, with consumed blocks pre-filtered.
export function buildBlockGuidance(activeBlocks) {
    const refs = (activeBlocks || [])
        .map((b) => {
            if (!b || typeof b.blockId !== "string") return null
            const id = parseInt(b.blockId.slice(1), 10)
            return Number.isInteger(id) && id > 0 ? `b${id}` : null
        })
        .filter(Boolean)
        .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"
    return [
        "Compressed block context:",
        `- Active compressed blocks in this session: ${blockCount} (${blockList})`,
        "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`.",
    ].join("\n")
}