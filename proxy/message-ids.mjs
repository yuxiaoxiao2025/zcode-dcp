// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/message-ids.ts + lib/messages/utils.ts + lib/messages/inject/inject.ts
// Copyright (c) DCP authors. See DCP/LICENSE for upstream licensing.
//
// Behavior-faithful port adapted to ZCode Anthropic-protocol proxy (stateless).
// Differences from upstream (documented in docs/current/CAPABILITY-MAPPING.md):
//   - assignRefs is stateless + deterministic (no SessionState; idempotent over the
//     same input array — upstream uses SessionState to track byRawId across calls;
//     we rebuild it from scratch each request, matching the message array shape).
//   - injectMessageIds accepts opts.blockedSet instead of
//     isProtectedUserMessage(config, message) (gate lives in pipeline.mjs; here we
//     take the precomputed set to keep this module single-purpose).
//   - formatMessageIdTag and strip helpers port verbatim.

const MESSAGE_REF_WIDTH = 4
const MESSAGE_REF_MIN_INDEX = 1
export const MESSAGE_REF_MAX_INDEX = 9999

const MESSAGE_ID_TAG_NAME = "dcp-message-id"

// --- Format helpers (verbatim from DCP message-ids.ts:24-117) ---

export function formatMessageRef(index) {
    if (
        !Number.isInteger(index) ||
        index < MESSAGE_REF_MIN_INDEX ||
        index > MESSAGE_REF_MAX_INDEX
    ) {
        throw new Error(
            `Message ID index out of bounds: ${index}. Supported range is 0-${MESSAGE_REF_MAX_INDEX}.`,
        )
    }
    return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`
}

export function formatBlockRef(blockId) {
    if (!Number.isInteger(blockId) || blockId < 1) {
        throw new Error(`Invalid block ID: ${blockId}`)
    }
    return `b${blockId}`
}

function escapeXmlAttribute(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

export function formatMessageIdTag(ref, attributes) {
    const serializedAttributes = Object.entries(attributes || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
            if (
                name.trim().length === 0 ||
                typeof value !== "string" ||
                value.length === 0
            ) {
                return ""
            }
            return ` ${name}="${escapeXmlAttribute(value)}"`
        })
        .join("")

    return `\n<${MESSAGE_ID_TAG_NAME}${serializedAttributes}>${ref}</${MESSAGE_ID_TAG_NAME}>`
}

// Strip the leading \n+ that formatMessageIdTag embeds — the rendered tag body
// used in text parts is the same shape appendToTextPart produces after normalization.
function tagBody(tag) {
    return tag.replace(/^\n+/, "")
}

// --- assignRefs: stateless deterministic assignment (ZCode adaptation) ---

export function assignRefs(messages) {
    const byIndex = new Map()
    let allocated = 0
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i]
        if (!message || typeof message !== "object") continue
        const role = message.role
        if (role !== "user" && role !== "assistant") {
            continue
        }
        allocated++
        if (allocated > MESSAGE_REF_MAX_INDEX) {
            throw new Error(
                `Message ID alias capacity exceeded. Cannot allocate more than ${formatMessageRef(MESSAGE_REF_MAX_INDEX)} aliases in this session.`,
            )
        }
        const ref = formatMessageRef(allocated)
        byIndex.set(i, { ref, kind: "message" })
    }
    return { byIndex, nextBlockId: "b1" }
}

// --- Strip patterns (port from DCP lib/messages/utils.ts:7-11) ---
//
// 4 categories:
//   1. INJECTED_MESSAGE_ID_SUFFIX — legitimate trailing <dcp-message-id>mN</dcp-message-id>
//   2. HALLUCINATED_PARAMETER_SUFFIX — trailing \nmN</parameter> (model confused tool param)
//   3. DCP_PAIRED_TAG — any <dcp…>…</dcp…> (model hallucinated a tag+close pair)
//   4. DCP_UNPAIRED_TAG — stray opening/closing tag fragments

export const STRIP_PATTERNS = Object.freeze({
    INJECTED_MESSAGE_ID_SUFFIX:
        /(?<=\n)<dcp-message-id[^>]*>m\d+<\/dcp-message-id>\s*$/,
    HALLUCINATED_PARAMETER_SUFFIX: /(?<=\n)m\d+<\/parameter>\s*$/,
    DCP_PAIRED_TAG: /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi,
    DCP_UNPAIRED_TAG: /<\/?dcp[^>]*>/gi,
})

function stripHallucinationsFromString(text) {
    if (typeof text !== "string" || text.length === 0) return text
    return text
        .replace(STRIP_PATTERNS.INJECTED_MESSAGE_ID_SUFFIX, "")
        .replace(STRIP_PATTERNS.HALLUCINATED_PARAMETER_SUFFIX, "")
        .replace(STRIP_PATTERNS.DCP_PAIRED_TAG, "")
        .replace(STRIP_PATTERNS.DCP_UNPAIRED_TAG, "")
}

export function stripDcpTags(messages) {
    if (!Array.isArray(messages)) return
    for (const message of messages) {
        if (!message || !Array.isArray(message.content)) continue
        for (const block of message.content) {
            if (!block || typeof block !== "object") continue
            if (block.type === "text" && typeof block.text === "string") {
                block.text = stripHallucinationsFromString(block.text)
                continue
            }
            if (block.type === "tool_result") {
                const c = block.content
                if (typeof c === "string") {
                    block.content = stripHallucinationsFromString(c)
                } else if (Array.isArray(c)) {
                    for (const inner of c) {
                        if (
                            inner &&
                            inner.type === "text" &&
                            typeof inner.text === "string"
                        ) {
                            inner.text = stripHallucinationsFromString(inner.text)
                        }
                    }
                }
            }
        }
    }
}

// --- Injection helpers (port from DCP lib/messages/utils.ts:72-130) ---

function appendToTextPart(part, injection) {
    if (!part || part.type !== "text" || typeof part.text !== "string") return false
    const normalizedInjection = injection.replace(/^\n+/, "")
    if (!normalizedInjection.trim()) return false
    if (part.text.includes(normalizedInjection)) return true
    const baseText = part.text.replace(/\n*$/, "")
    part.text = baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection
    return true
}

function appendToToolPart(toolResultBlock, tag) {
    if (!toolResultBlock || toolResultBlock.type !== "tool_result") return false
    const c = toolResultBlock.content
    if (typeof c === "string") {
        if (c.includes(tag)) return true
        toolResultBlock.content = `${c}${tag}`
        return true
    }
    if (Array.isArray(c)) {
        // Per PLAN + inject.ts:145-215 semantics: append a new text block.
        // Strip the leading \n+ from the tag (matches appendToTextPart normalization
        // so downstream stripDcpTags / downstream consumers see a clean body).
        toolResultBlock.content.push({ type: "text", text: tagBody(tag) })
        return true
    }
    return false
}

function findLastTextPart(message) {
    const parts = Array.isArray(message.content) ? message.content : []
    for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === "text") return parts[i]
    }
    return null
}

function appendToLastTextPart(message, tag) {
    const part = findLastTextPart(message)
    if (!part) return false
    return appendToTextPart(part, tag)
}

function appendToAllToolParts(message, tag) {
    const parts = Array.isArray(message.content) ? message.content : []
    let injected = false
    for (const part of parts) {
        if (part.type === "tool_result") {
            injected = appendToToolPart(part, tag) || injected
        }
    }
    return injected
}

function messageHasToolResult(message) {
    const parts = Array.isArray(message.content) ? message.content : []
    return parts.some((p) => p && p.type === "tool_result")
}

function messageHasText(message) {
    const parts = Array.isArray(message.content) ? message.content : []
    return parts.some((p) => p && p.type === "text")
}

// --- injectMessageIds (ZCode adaptation of DCP inject.ts:145-215) ---

export function injectMessageIds(messages, refs, opts = {}) {
    if (!Array.isArray(messages) || !refs || !refs.byIndex) return
    const priorityMap = opts.priorityMap || new Map()
    const blockedSet = opts.blockedSet || new Set()
    for (let i = 0; i < messages.length; i++) {
        const entry = refs.byIndex.get(i)
        if (!entry) continue
        const message = messages[i]
        if (!message) continue
        // ZCode adaptation (cross-file authorization, task-11 review I-2b):
        // priorityMap and blockedSet are keyed by INTEGER MESSAGE INDEX into
        // the current `messages` array — NOT by raw `message.id`. Anthropic
        // /v1/messages request bodies never carry a message `id` field (SPEC
        // decision 2026-09-11 22:50), so the upstream byMessageId lookup
        // would always miss. Using `i` directly mirrors the project's
        // "messages are indexed, refs are derived" invariant; the pipeline
        // must re-assignRefs after applyCompressions (which mutates the
        // array shape) to keep i in sync with refs.byIndex.
        const isBlocked = blockedSet.has(i)
        // priorityMap is keyed by integer index (I-2b cross-file authorization).
        // The value shape is { ref, tokenCount, priority: "high"|"medium"|"low" }
        // — we extract just the priority string for the XML attribute.
        const priorityEntry = priorityMap.get(i)
        const priorityAttr = priorityEntry && typeof priorityEntry === "object" && priorityEntry.priority
            ? priorityEntry.priority
            : undefined
        const tag = formatMessageIdTag(
            isBlocked ? "BLOCKED" : entry.ref,
            priorityAttr ? { priority: priorityAttr } : undefined,
        )

        if (message.role === "user") {
            if (messageHasToolResult(message)) {
                for (const part of message.content) {
                    if (part.type === "tool_result") {
                        appendToToolPart(part, tag)
                    }
                }
                continue
            }
            if (messageHasText(message)) {
                appendToLastTextPart(message, tag)
                continue
            }
            // No text, no tool_result — synthesize a text block at the end (no leading newline).
            message.content.push({ type: "text", text: tagBody(tag) })
            continue
        }

        if (message.role === "assistant") {
            // Anthropic assistant parts: tool_use + text only. We adapt DCP's
            // "try tool parts first, then text parts, then synthesize" ladder.
            if (appendToAllToolParts(message, tag)) continue
            if (appendToLastTextPart(message, tag)) continue
            const firstToolIndex = message.content.findIndex(
                (p) => p && p.type === "tool_use",
            )
            const synthetic = { type: "text", text: tagBody(tag) }
            if (firstToolIndex === -1) {
                message.content.push(synthetic)
            } else {
                message.content.splice(firstToolIndex, 0, synthetic)
            }
        }
    }
}