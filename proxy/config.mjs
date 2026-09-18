// Ported from opencode-dcp v3.1.15 lib/config.ts (AGPL-3.0-or-later, © DCP authors) — see NOTICE
//
// Behavior-faithful port of DCP v3.1.15 config subsystem, with ZCode adaptations:
//   - Added: proxy { port, idleTimeoutMin, adminTokenFile }, upstream { baseUrl, apiKey }, contextWindow (no default)
//   - Removed: autoUpdate, pruneNotificationType (not applicable in ZCode host; see CAPABILITY-MAPPING.md)
//
// JSONC parsing implemented locally (no jsonc-parser dependency). Merge semantics follow
// lib/config.ts:932-1007 (mergeLayer): array-typed fields = union across layers; scalar =
// override-wins; compress.model{Min,Max}Limits = whole-table replacement; nested objects =
// recursive partial override.

import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// JSONC parser (string-aware // /* */ + trailing commas; no jsonc-parser dep)
// ---------------------------------------------------------------------------

/**
 * Parse JSONC text into a JS value. String-aware (does not strip // inside strings).
 * Strips line/block comments and trailing commas. Throws on parse failure with
 * line/column info.
 *
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
    if (typeof text !== "string") {
        throw new TypeError("parseJsonc: input must be a string")
    }

    // Strip comments
    let stripped = ""
    let i = 0
    let line = 1
    let col = 1
    while (i < text.length) {
        const ch = text[i]
        const next = text[i + 1]

        // Track newline before consuming char
        if (ch === "\n") {
            stripped += ch
            line++
            col = 1
            i++
            continue
        }
        if (ch === "\r") {
            // Normalize CRLF / CR; advance past \r and let \n increment line.
            stripped += ch
            col++
            i++
            continue
        }

        // String literal: pass through, watching for escape and // inside.
        if (ch === '"') {
            stripped += ch
            i++
            col++
            while (i < text.length) {
                const c = text[i]
                if (c === "\\") {
                    // Pass escape + next char verbatim
                    stripped += c
                    if (i + 1 < text.length) {
                        stripped += text[i + 1]
                        i += 2
                        col += 2
                    } else {
                        i++
                    }
                    continue
                }
                if (c === '"') {
                    stripped += c
                    i++
                    col++
                    break
                }
                if (c === "\n") {
                    stripped += c
                    line++
                    col = 1
                    i++
                } else {
                    stripped += c
                    col++
                    i++
                }
            }
            continue
        }

        // Line comment // ...
        if (ch === "/" && next === "/") {
            // Skip until newline (but keep newline in output)
            while (i < text.length && text[i] !== "\n") {
                i++
            }
            continue
        }

        // Block comment /* ... */
        if (ch === "/" && next === "*") {
            i += 2
            col += 2
            while (i < text.length) {
                if (text[i] === "*" && text[i + 1] === "/") {
                    i += 2
                    col += 2
                    break
                }
                if (text[i] === "\n") {
                    line++
                    col = 1
                } else {
                    col++
                }
                i++
            }
            continue
        }

        stripped += ch
        col++
        i++
    }

    // Remove trailing commas in objects / arrays. The naive regex /,(\s*[}\]])/g
    // is unsafe because it doesn't know about strings — a glob value like
    // "foo,}" would have its ',' deleted. Scan the output character-by-character,
    // skipping string literals (with their escape handling), and at each unquoted
    // ',' look ahead for optional whitespace + a closer ('}' or ']') to absorb.
    {
        let out = ""
        let j = 0
        while (j < stripped.length) {
            const c = stripped[j]
            if (c === '"') {
                // Pass the string literal through verbatim, watching for escapes.
                out += c
                j++
                while (j < stripped.length) {
                    const cc = stripped[j]
                    if (cc === "\\") {
                        out += cc
                        if (j + 1 < stripped.length) {
                            out += stripped[j + 1]
                            j += 2
                        } else {
                            j++
                        }
                        continue
                    }
                    if (cc === '"') {
                        out += cc
                        j++
                        break
                    }
                    out += cc
                    j++
                }
                continue
            }
            if (c === ",") {
                // Look ahead past whitespace for '}' or ']'.
                let k = j + 1
                while (k < stripped.length && (stripped[k] === " " || stripped[k] === "\t" || stripped[k] === "\n" || stripped[k] === "\r")) {
                    k++
                }
                if (k < stripped.length && (stripped[k] === "}" || stripped[k] === "]")) {
                    // Skip emitting the comma; emit the closer in its place.
                    j = k
                    out += stripped[j]
                    j++
                    continue
                }
                out += c
                j++
                continue
            }
            out += c
            j++
        }
        stripped = out
    }

    try {
        return JSON.parse(stripped)
    } catch (err) {
        // Re-throw with line/column context from the underlying SyntaxError when available
        const msg = err && err.message ? err.message : String(err)
        throw new SyntaxError(`JSONC parse error: ${msg} (line ~${line}, column ~${col})`)
    }
}

// ---------------------------------------------------------------------------
// Defaults — line-by-line port of DCP lib/config.ts:78-91, 656-704
// ---------------------------------------------------------------------------

const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "skill",
    "todowrite",
    "todoread",
    "compress",
    "batch",
    "plan_enter",
    "plan_exit",
    "write",
    "edit",
]

// ZCode-mapped names (PLAN task-3 / task-7 alignment). The lowercase DCP
// defaults ('task' / 'skill' / 'todowrite' / 'todoread') were left in the
// original v3.1.15 port but they never match the actual ZCode PascalCase
// tool names emitted at runtime, which silently disabled the protected-tools
// append path (R5 verification failure). Fixed in port task-7 review
// (2026-09-11 cross-file authorization; spec-correction-not-behavior-change).
const COMPRESS_DEFAULT_PROTECTED_TOOLS = [
    "Agent",
    "Task",
    "Skill",
    "TodoWrite",
    "TodoRead",
]

export const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    debug: false,
    pruneNotification: "detailed",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
    },
    manualMode: {
        enabled: false,
        automaticStrategies: true,
    },
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    experimental: {
        allowSubAgents: false,
        customPrompts: false,
    },
    protectedFilePatterns: [],
    compress: {
        mode: "range",
        permission: "allow",
        showCompression: false,
        summaryBuffer: true,
        maxContextLimit: 100000,
        minContextLimit: 30000,
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS],
        protectTags: false,
        protectUserMessages: false,
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [],
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [],
        },
    },
    // ---- ZCode adaptations ----
    proxy: {
        port: 8367,
        idleTimeoutMin: 30,
        adminTokenFile: "admin-token",
        adminProbeTimeoutMs: 1500,
    },
    upstream: {
        baseUrl: "",
        apiKey: "",
    },
    // No default — left to upstream provider / explicit override.
    contextWindow: undefined,
})

// ---------------------------------------------------------------------------
// Valid keys (for validateConfig). Mirrors DCP VALID_CONFIG_KEYS (lib/config.ts:93-137)
// plus the ZCode adaptation keys.
// ---------------------------------------------------------------------------

const VALID_CONFIG_KEYS = new Set([
    "$schema",
    "enabled",
    "debug",
    "pruneNotification",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "experimental",
    "experimental.allowSubAgents",
    "experimental.customPrompts",
    "protectedFilePatterns",
    "commands",
    "commands.enabled",
    "commands.protectedTools",
    "manualMode",
    "manualMode.enabled",
    "manualMode.automaticStrategies",
    "compress",
    "compress.mode",
    "compress.permission",
    "compress.showCompression",
    "compress.summaryBuffer",
    "compress.maxContextLimit",
    "compress.minContextLimit",
    "compress.modelMaxLimits",
    "compress.modelMinLimits",
    "compress.nudgeFrequency",
    "compress.iterationNudgeThreshold",
    "compress.nudgeForce",
    "compress.protectedTools",
    "compress.protectTags",
    "compress.protectUserMessages",
    "strategies",
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
    // ZCode adaptations
    "proxy",
    "proxy.port",
    "proxy.idleTimeoutMin",
    "proxy.adminTokenFile",
    "proxy.adminProbeTimeoutMs",
    "upstream",
    "upstream.baseUrl",
    "upstream.apiKey",
    "contextWindow",
    // ZCode session-classification whitelists / blacklists (consumed by
    // proxy/protect.mjs:256-285). Previously silently rejected as "Unknown
    // key" by validateConfig when users supplied them in dcp.jsonc — fixed
    // here so the schema + runtime + validator agree.
    "internalAgentSignatures",
    "extraMainSignatures",
])

function getConfigKeyPaths(obj, prefix = "") {
    const keys = []
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return keys
    }
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)
        // model*Limits are dynamic maps keyed by providerID/modelID; do not recurse.
        if (fullKey === "compress.modelMaxLimits" || fullKey === "compress.modelMinLimits") {
            continue
        }
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

// ---------------------------------------------------------------------------
// Merge helpers — port of lib/config.ts:804-897, 932-952
// ---------------------------------------------------------------------------

function arrUnion(a, b) {
    return [...new Set([...(a ?? []), ...(b ?? [])])]
}

function mergeCommands(base, override) {
    if (!override) return { ...base, protectedTools: [...base.protectedTools] }
    return {
        enabled: override.enabled ?? base.enabled,
        protectedTools: arrUnion(base.protectedTools, override.protectedTools),
    }
}

function mergeManualMode(base, override) {
    if (override === undefined) return { ...base }
    return {
        enabled: override.enabled ?? base.enabled,
        automaticStrategies: override.automaticStrategies ?? base.automaticStrategies,
    }
}

function mergeExperimental(base, override) {
    if (override === undefined) return { ...base }
    return {
        allowSubAgents: override.allowSubAgents ?? base.allowSubAgents,
        customPrompts: override.customPrompts ?? base.customPrompts,
    }
}

function mergeCompress(base, override) {
    if (!override) return { ...base, protectedTools: [...base.protectedTools] }
    return {
        mode: override.mode ?? base.mode,
        permission: override.permission ?? base.permission,
        showCompression: override.showCompression ?? base.showCompression,
        summaryBuffer: override.summaryBuffer ?? base.summaryBuffer,
        maxContextLimit: override.maxContextLimit ?? base.maxContextLimit,
        minContextLimit: override.minContextLimit ?? base.minContextLimit,
        // modelLimits: whole-table replacement (override entirely wins if present)
        modelMaxLimits: override.modelMaxLimits ?? base.modelMaxLimits,
        modelMinLimits: override.modelMinLimits ?? base.modelMinLimits,
        nudgeFrequency: override.nudgeFrequency ?? base.nudgeFrequency,
        iterationNudgeThreshold: override.iterationNudgeThreshold ?? base.iterationNudgeThreshold,
        nudgeForce: override.nudgeForce ?? base.nudgeForce,
        protectedTools: arrUnion(base.protectedTools, override.protectedTools),
        protectTags: override.protectTags ?? base.protectTags,
        protectUserMessages: override.protectUserMessages ?? base.protectUserMessages,
    }
}

function mergeStrategies(base, override) {
    if (!override) return { ...base }
    return {
        deduplication: {
            enabled: override.deduplication?.enabled ?? base.deduplication.enabled,
            protectedTools: arrUnion(base.deduplication.protectedTools, override.deduplication?.protectedTools),
        },
        purgeErrors: {
            enabled: override.purgeErrors?.enabled ?? base.purgeErrors.enabled,
            turns: override.purgeErrors?.turns ?? base.purgeErrors.turns,
            protectedTools: arrUnion(base.purgeErrors.protectedTools, override.purgeErrors?.protectedTools),
        },
    }
}

function mergeProxy(base, override) {
    if (!override) return { ...base }
    return {
        port: override.port ?? base.port,
        idleTimeoutMin: override.idleTimeoutMin ?? base.idleTimeoutMin,
        adminTokenFile: override.adminTokenFile ?? base.adminTokenFile,
        adminProbeTimeoutMs: override.adminProbeTimeoutMs ?? base.adminProbeTimeoutMs,
    }
}

function mergeUpstream(base, override) {
    if (!override) return { ...base }
    return {
        baseUrl: override.baseUrl ?? base.baseUrl,
        apiKey: override.apiKey ?? base.apiKey,
    }
}

/**
 * Apply a single layer on top of an existing config snapshot. Mirrors DCP
 * mergeLayer (lib/config.ts:932-952): array fields union, scalars override,
 * modelLimits whole-table replace, nested objects recursively merged.
 *
 * @param {object} config — current accumulated config
 * @param {object} data — user-supplied layer
 * @returns {object} merged config
 */
export function mergeConfig(layers) {
    if (!Array.isArray(layers) || layers.length === 0) {
        throw new TypeError("mergeConfig: layers must be a non-empty array")
    }

    // Start from a mutable clone of the first layer so callers don't share refs.
    let acc = deepClone(layers[0])

    for (let idx = 1; idx < layers.length; idx++) {
        const data = layers[idx] || {}
        acc = {
            enabled: data.enabled ?? acc.enabled,
            debug: data.debug ?? acc.debug,
            pruneNotification: data.pruneNotification ?? acc.pruneNotification,
            commands: mergeCommands(acc.commands, data.commands),
            manualMode: mergeManualMode(acc.manualMode, data.manualMode),
            turnProtection: {
                enabled: data.turnProtection?.enabled ?? acc.turnProtection.enabled,
                turns: data.turnProtection?.turns ?? acc.turnProtection.turns,
            },
            experimental: mergeExperimental(acc.experimental, data.experimental),
            protectedFilePatterns: arrUnion(acc.protectedFilePatterns, data.protectedFilePatterns),
            compress: mergeCompress(acc.compress, data.compress),
            strategies: mergeStrategies(acc.strategies, data.strategies),
            proxy: mergeProxy(acc.proxy, data.proxy),
            upstream: mergeUpstream(acc.upstream, data.upstream),
            contextWindow: data.contextWindow ?? acc.contextWindow,
        }
    }

    return acc
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj))
}

// ---------------------------------------------------------------------------
// Validation — port of lib/config.ts:139-160 (unknown keys) + 168-608 (types)
// We emit string[] warnings (not structured errors) to match loadConfig's return shape.
// ---------------------------------------------------------------------------

/**
 * Validate a config object against the DCP-known key set and type constraints.
 * Returns an array of human-readable warning strings; empty array = clean.
 *
 * @param {object} config
 * @returns {string[]}
 */
export function validateConfig(config) {
    const warnings = []
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        warnings.push("config: expected object, got " + typeof config)
        return warnings
    }

    // 1) Unknown keys (recursive, except model*Limits dynamic maps)
    const userKeys = getConfigKeyPaths(config)
    const unknown = userKeys.filter((k) => !VALID_CONFIG_KEYS.has(k))
    for (const key of unknown) {
        warnings.push(`Unknown key: ${key}`)
    }

    // 2) Type / value checks
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        warnings.push(`enabled: expected boolean, got ${typeof config.enabled}`)
    }
    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        warnings.push(`debug: expected boolean, got ${typeof config.debug}`)
    }
    if (config.pruneNotification !== undefined) {
        const ok = ["off", "minimal", "detailed"].includes(config.pruneNotification)
        if (!ok) warnings.push(`pruneNotification: expected one of off|minimal|detailed, got ${JSON.stringify(config.pruneNotification)}`)
    }
    if (config.protectedFilePatterns !== undefined) {
        if (!Array.isArray(config.protectedFilePatterns)) {
            warnings.push(`protectedFilePatterns: expected string[], got ${typeof config.protectedFilePatterns}`)
        } else if (!config.protectedFilePatterns.every((v) => typeof v === "string")) {
            warnings.push(`protectedFilePatterns: non-string entries`)
        }
    }
    if (config.turnProtection) {
        if (config.turnProtection.enabled !== undefined && typeof config.turnProtection.enabled !== "boolean") {
            warnings.push(`turnProtection.enabled: expected boolean, got ${typeof config.turnProtection.enabled}`)
        }
        if (config.turnProtection.turns !== undefined && typeof config.turnProtection.turns !== "number") {
            warnings.push(`turnProtection.turns: expected number, got ${typeof config.turnProtection.turns}`)
        } else if (typeof config.turnProtection.turns === "number" && config.turnProtection.turns < 1) {
            warnings.push(`turnProtection.turns: expected positive number (>= 1), got ${config.turnProtection.turns}`)
        }
    }
    if (config.experimental !== undefined) {
        if (typeof config.experimental !== "object" || config.experimental === null || Array.isArray(config.experimental)) {
            warnings.push(`experimental: expected object, got ${typeof config.experimental}`)
        } else {
            if (config.experimental.allowSubAgents !== undefined && typeof config.experimental.allowSubAgents !== "boolean") {
                warnings.push(`experimental.allowSubAgents: expected boolean, got ${typeof config.experimental.allowSubAgents}`)
            }
            if (config.experimental.customPrompts !== undefined && typeof config.experimental.customPrompts !== "boolean") {
                warnings.push(`experimental.customPrompts: expected boolean, got ${typeof config.experimental.customPrompts}`)
            }
        }
    }
    if (config.commands !== undefined) {
        if (typeof config.commands !== "object" || config.commands === null || Array.isArray(config.commands)) {
            warnings.push(`commands: expected object, got ${typeof config.commands}`)
        } else {
            if (config.commands.enabled !== undefined && typeof config.commands.enabled !== "boolean") {
                warnings.push(`commands.enabled: expected boolean, got ${typeof config.commands.enabled}`)
            }
            if (config.commands.protectedTools !== undefined && !Array.isArray(config.commands.protectedTools)) {
                warnings.push(`commands.protectedTools: expected string[], got ${typeof config.commands.protectedTools}`)
            }
        }
    }
    if (config.manualMode !== undefined) {
        if (typeof config.manualMode !== "object" || config.manualMode === null || Array.isArray(config.manualMode)) {
            warnings.push(`manualMode: expected object, got ${typeof config.manualMode}`)
        } else {
            if (config.manualMode.enabled !== undefined && typeof config.manualMode.enabled !== "boolean") {
                warnings.push(`manualMode.enabled: expected boolean, got ${typeof config.manualMode.enabled}`)
            }
            if (config.manualMode.automaticStrategies !== undefined && typeof config.manualMode.automaticStrategies !== "boolean") {
                warnings.push(`manualMode.automaticStrategies: expected boolean, got ${typeof config.manualMode.automaticStrategies}`)
            }
        }
    }
    if (config.compress !== undefined) {
        if (typeof config.compress !== "object" || config.compress === null || Array.isArray(config.compress)) {
            warnings.push(`compress: expected object, got ${typeof config.compress}`)
        } else {
            const c = config.compress
            if (c.mode !== undefined && c.mode !== "range" && c.mode !== "message") {
                warnings.push(`compress.mode: expected range|message, got ${JSON.stringify(c.mode)}`)
            }
            if (c.summaryBuffer !== undefined && typeof c.summaryBuffer !== "boolean") {
                warnings.push(`compress.summaryBuffer: expected boolean, got ${typeof c.summaryBuffer}`)
            }
            if (c.nudgeFrequency !== undefined && typeof c.nudgeFrequency !== "number") {
                warnings.push(`compress.nudgeFrequency: expected number, got ${typeof c.nudgeFrequency}`)
            } else if (typeof c.nudgeFrequency === "number" && c.nudgeFrequency < 1) {
                warnings.push(`compress.nudgeFrequency: expected positive number (>= 1), got ${c.nudgeFrequency}`)
            }
            if (c.iterationNudgeThreshold !== undefined && typeof c.iterationNudgeThreshold !== "number") {
                warnings.push(`compress.iterationNudgeThreshold: expected number, got ${typeof c.iterationNudgeThreshold}`)
            } else if (typeof c.iterationNudgeThreshold === "number" && c.iterationNudgeThreshold < 1) {
                warnings.push(`compress.iterationNudgeThreshold: expected positive number (>= 1), got ${c.iterationNudgeThreshold}`)
            }
            if (c.nudgeForce !== undefined && c.nudgeForce !== "strong" && c.nudgeForce !== "soft") {
                warnings.push(`compress.nudgeForce: expected strong|soft, got ${JSON.stringify(c.nudgeForce)}`)
            }
            if (c.protectedTools !== undefined && !Array.isArray(c.protectedTools)) {
                warnings.push(`compress.protectedTools: expected string[], got ${typeof c.protectedTools}`)
            }
            if (c.protectTags !== undefined && typeof c.protectTags !== "boolean") {
                warnings.push(`compress.protectTags: expected boolean, got ${typeof c.protectTags}`)
            }
            if (c.protectUserMessages !== undefined && typeof c.protectUserMessages !== "boolean") {
                warnings.push(`compress.protectUserMessages: expected boolean, got ${typeof c.protectUserMessages}`)
            }
            // Limit values: number | "<n>%"
            validateLimitFormatted("compress.maxContextLimit", c.maxContextLimit, warnings)
            validateLimitFormatted("compress.minContextLimit", c.minContextLimit, warnings)
            validateModelLimits("compress.modelMaxLimits", c.modelMaxLimits, warnings)
            validateModelLimits("compress.modelMinLimits", c.modelMinLimits, warnings)
            if (c.permission !== undefined && !["ask", "allow", "deny"].includes(c.permission)) {
                warnings.push(`compress.permission: expected ask|allow|deny, got ${JSON.stringify(c.permission)}`)
            }
            if (c.showCompression !== undefined && typeof c.showCompression !== "boolean") {
                warnings.push(`compress.showCompression: expected boolean, got ${typeof c.showCompression}`)
            }
        }
    }
    if (config.strategies !== undefined) {
        const s = config.strategies
        if (s.deduplication) {
            if (s.deduplication.enabled !== undefined && typeof s.deduplication.enabled !== "boolean") {
                warnings.push(`strategies.deduplication.enabled: expected boolean, got ${typeof s.deduplication.enabled}`)
            }
            if (s.deduplication.protectedTools !== undefined && !Array.isArray(s.deduplication.protectedTools)) {
                warnings.push(`strategies.deduplication.protectedTools: expected string[], got ${typeof s.deduplication.protectedTools}`)
            }
        }
        if (s.purgeErrors) {
            if (s.purgeErrors.enabled !== undefined && typeof s.purgeErrors.enabled !== "boolean") {
                warnings.push(`strategies.purgeErrors.enabled: expected boolean, got ${typeof s.purgeErrors.enabled}`)
            }
            if (s.purgeErrors.turns !== undefined && typeof s.purgeErrors.turns !== "number") {
                warnings.push(`strategies.purgeErrors.turns: expected number, got ${typeof s.purgeErrors.turns}`)
            } else if (typeof s.purgeErrors.turns === "number" && s.purgeErrors.turns < 1) {
                warnings.push(`strategies.purgeErrors.turns: expected positive number (>= 1), got ${s.purgeErrors.turns}`)
            }
            if (s.purgeErrors.protectedTools !== undefined && !Array.isArray(s.purgeErrors.protectedTools)) {
                warnings.push(`strategies.purgeErrors.protectedTools: expected string[], got ${typeof s.purgeErrors.protectedTools}`)
            }
        }
    }
    // ZCode-only keys
    if (config.proxy !== undefined) {
        if (typeof config.proxy !== "object" || config.proxy === null || Array.isArray(config.proxy)) {
            warnings.push(`proxy: expected object, got ${typeof config.proxy}`)
        } else {
            if (config.proxy.port !== undefined && typeof config.proxy.port !== "number") {
                warnings.push(`proxy.port: expected number, got ${typeof config.proxy.port}`)
            }
            if (config.proxy.idleTimeoutMin !== undefined && typeof config.proxy.idleTimeoutMin !== "number") {
                warnings.push(`proxy.idleTimeoutMin: expected number, got ${typeof config.proxy.idleTimeoutMin}`)
            }
        if (config.proxy.adminTokenFile !== undefined && typeof config.proxy.adminTokenFile !== "string") {
            warnings.push(`proxy.adminTokenFile: expected string, got ${typeof config.proxy.adminTokenFile}`)
        }
        if (config.proxy.adminProbeTimeoutMs !== undefined && typeof config.proxy.adminProbeTimeoutMs !== "number") {
            warnings.push(`proxy.adminProbeTimeoutMs: expected number, got ${typeof config.proxy.adminProbeTimeoutMs}`)
        } else if (typeof config.proxy.adminProbeTimeoutMs === "number" && config.proxy.adminProbeTimeoutMs < 100) {
            warnings.push(`proxy.adminProbeTimeoutMs: expected >= 100ms, got ${config.proxy.adminProbeTimeoutMs}`)
        }
        }
    }
    if (config.upstream !== undefined) {
        if (typeof config.upstream !== "object" || config.upstream === null || Array.isArray(config.upstream)) {
            warnings.push(`upstream: expected object, got ${typeof config.upstream}`)
        } else {
            if (config.upstream.baseUrl !== undefined && typeof config.upstream.baseUrl !== "string") {
                warnings.push(`upstream.baseUrl: expected string, got ${typeof config.upstream.baseUrl}`)
            }
            if (config.upstream.apiKey !== undefined && typeof config.upstream.apiKey !== "string") {
                warnings.push(`upstream.apiKey: expected string, got ${typeof config.upstream.apiKey}`)
            }
        }
    }
    if (config.contextWindow !== undefined) {
        if (typeof config.contextWindow !== "number") {
            warnings.push(`contextWindow: expected number, got ${typeof config.contextWindow}`)
        }
    }
    // Session-classification signature whitelists / blacklists (consumed by
    // proxy/protect.mjs isMainSession). Both are string arrays; non-array or
    // non-string entries produce a warning but do not abort.
    if (config.internalAgentSignatures !== undefined) {
        if (!Array.isArray(config.internalAgentSignatures)) {
            warnings.push(`internalAgentSignatures: expected string[], got ${typeof config.internalAgentSignatures}`)
        } else if (!config.internalAgentSignatures.every((v) => typeof v === "string")) {
            warnings.push(`internalAgentSignatures: non-string entries`)
        }
    }
    if (config.extraMainSignatures !== undefined) {
        if (!Array.isArray(config.extraMainSignatures)) {
            warnings.push(`extraMainSignatures: expected string[], got ${typeof config.extraMainSignatures}`)
        } else if (!config.extraMainSignatures.every((v) => typeof v === "string")) {
            warnings.push(`extraMainSignatures: non-string entries`)
        }
    }

    return warnings
}

function validateLimitFormatted(key, val, warnings) {
    if (val === undefined) return
    const isNum = typeof val === "number"
    const isPct = typeof val === "string" && /^\d+(?:\.\d+)?%$/.test(val)
    if (!isNum && !isPct) {
        warnings.push(`${key}: expected number|"${val}%", got ${JSON.stringify(val)}`)
    }
}

function validateModelLimits(key, limits, warnings) {
    if (limits === undefined) return
    if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
        warnings.push(`${key}: expected object, got ${typeof limits}`)
        return
    }
    for (const [k, v] of Object.entries(limits)) {
        const isNum = typeof v === "number"
        const isPct = typeof v === "string" && /^\d+(?:\.\d+)?%$/.test(v)
        if (!isNum && !isPct) {
            warnings.push(`${key}.${k}: expected number|"<n>%"`)
        }
    }
}

// ---------------------------------------------------------------------------
// File-system loader — port of lib/config.ts:706-766, 785-802
// User-level (~/.zcode/dcp/dcp.jsonc) → project-level (cwd/.zcode/dcp.jsonc, walked up)
// ---------------------------------------------------------------------------

function getGlobalConfigPath() {
    return join(homedir(), ".zcode", "dcp", "dcp.jsonc")
}

function findZcodeDir(startDir) {
    let current = startDir
    while (true) {
        const candidate = join(current, ".zcode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }
    return null
}

/**
 * Load DCP config from the standard two-level layout (user → project, project
 * overrides user). Returns {config, warnings[]} — config is the merged result,
 * warnings holds parse / unknown-key diagnostics.
 *
 * @param {string} cwd — current working directory (project root search anchor)
 * @param {string} dataDir — plugin data dir (passed for parity with downstream tasks; not used here)
 * @returns {{config: object, warnings: string[]}}
 */
export function loadConfig(cwd, dataDir) {
    const warnings = []
    const layers = [{ path: getGlobalConfigPath(), isProject: false }]

    if (cwd) {
        const zdir = findZcodeDir(cwd)
        if (zdir) {
            layers.push({ path: join(zdir, "dcp.jsonc"), isProject: true })
        }
    }

    let acc = deepClone(DEFAULT_CONFIG)

    for (const layer of layers) {
        if (!layer.path || !existsSync(layer.path)) continue

        let raw
        try {
            raw = readFileSync(layer.path, "utf-8")
        } catch (e) {
            warnings.push(`Failed to read ${layer.path}: ${e.message}`)
            continue
        }

        let parsed
        try {
            parsed = parseJsonc(raw)
        } catch (e) {
            warnings.push(`Failed to parse ${layer.path}: ${e.message}`)
            continue
        }
        if (parsed === undefined || parsed === null) continue

        // Per-layer validation → warnings (does not abort)
        const layerWarnings = validateConfig(parsed)
        for (const w of layerWarnings) {
            warnings.push(`${layer.path}: ${w}`)
        }

        try {
            acc = mergeConfig([acc, parsed])
        } catch (e) {
            warnings.push(`Merge failed for ${layer.path}: ${e.message}`)
        }
    }

    // Touch dataDir if provided (no-op for now; placeholder for downstream task contract)
    if (dataDir && !existsSync(dataDir)) {
        try {
            mkdirSync(dataDir, { recursive: true })
        } catch {
            // best-effort; loadConfig must not throw on dataDir issues
        }
    }

    return { config: acc, warnings }
}
