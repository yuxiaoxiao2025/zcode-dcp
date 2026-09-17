// proxy/protect.mjs
// Ported from opencode-dcp v3.1.15 lib/protected-patterns.ts (AGPL-3.0-or-later)
//
// Copyright (c) Opencode-DCP authors. Licensed under AGPL-3.0-or-later.
//
// ZCode adaptations (per port-opencode-dcp-to-zcode PLAN Task 3, H1/H5):
//   - DEFAULT_PROTECTED_TOOLS: ZCode tool-name mapping. DCP's lowercase opencode
//     names ('task','todowrite','todoread') are mapped to ZCode's PascalCase
//     ('Task','TodoWrite','TodoRead'). ZCode-specific tools added: 'Agent' (the
//     sub-agent invocation tool, distinct from Task), 'Skill', 'Write', 'Edit'.
//     opencode-only entries (batch/plan_enter/plan_exit) are dropped — they
//     have no ZCode equivalent. The compress tool name is matched dynamically
//     by callers via a glob like 'mcp__*__compress', so it is NOT listed here.
//   - COMPRESS_PROTECTED_TOOLS: subset used by the compress pipeline (per-task
//     append), aligned to the DCP default of task/skill/todowrite/todoread with
//     the same ZCode name mapping.
//   - getFilePathsFromParameters: only the common ZCode parameter keys
//     ('file_path', 'path') are recognised. DCP's opencode-only branches
//     (apply_patch patchText extraction, multiedit nested edits) are removed
//     because those tools do not exist in ZCode.
//   - isMainSession: DCP detects sub-agents via Opencode session metadata
//     (parentID), and detects internal helpers by matching system[0] against
//     INTERNAL_AGENT_SIGNATURES (hooks.ts:42-56). In ZCode proxy mode the
//     session metadata is not available, so we rely entirely on the system-
//     text signatures.
//       - Default (allowSubAgents !== true): whitelist gate — system[0] must
//         contain the ZCode main-session signature ("You are ZCode") to be
//         processed. Extra main signatures may be added via
//         config.extraMainSignatures.
//       - allowSubAgents === true: blacklist gate — only requests whose
//         system[0] matches the internal-agent signature list are skipped;
//         main-session AND sub-agent requests both pass. The default
//         internal-agent list is ported verbatim from DCP hooks.ts:42-47
//         (4 entries). Extra internal signatures may be added via
//         config.internalAgentSignatures.

// ---------- Default protected tool lists (ZCode name mapping) ----------

export const DEFAULT_PROTECTED_TOOLS = [
    "Agent", // ZCode sub-agent invocation (DCP: 'task')
    "Task", // ZCode Task (background / dispatch)
    "Skill", // ZCode Skill execution
    "TodoWrite", // ZCode todo write (DCP: 'todowrite')
    "TodoRead", // ZCode todo read (DCP: 'todoread')
    "Write", // ZCode file write
    "Edit", // ZCode file edit
    // compress tool name is NOT listed here; callers pass it dynamically
    // (e.g. patterns = [...DEFAULT_PROTECTED_TOOLS, 'mcp__dcp__compress'])
    // so the same default works regardless of MCP server name.
]

export const COMPRESS_PROTECTED_TOOLS = [
    "Agent",
    "Task",
    "Skill",
    "TodoWrite",
    "TodoRead",
]

// ---------- Glob → RegExp (移植自 DCP protected-patterns.ts:13-62) ----------

function normalizePath(input) {
    // DCP: a single backslash. The previous "\\\\" was a two-character string,
    // so it only matched a doubled separator. Normalisation is now a real
    // no-op-on-Windows.
    return input.replaceAll("\\", "/")
}

function escapeRegExpChar(ch) {
    return /[\\.^$+{}()|\[\]]/.test(ch) ? `\\${ch}` : ch
}

/**
 * Convert a glob pattern to an anchored RegExp.
 *
 * Glob semantics (ported from DCP protected-patterns.ts:13-62):
 *   - two-star-slash  : zero or more directories, ZERO-LEVEL match allowed
 *   - two-star        : any chars including '/'
 *   - star            : any chars except '/', does NOT cross '/'
 *   - question-mark   : exactly one non-'/' char
 *   - slash           : literal slash, no escaping
 *   - backslash       : normalised to slash (Windows separator)
 *   - other           : regex-escaped literal
 *   - entire pattern anchored with ^ and $ (full-string match).
 */
export function globToRegExp(pattern) {
    let regex = "^"
    const pat = normalizePath(pattern)

    for (let i = 0; i < pat.length; i++) {
        const ch = pat[i]

        if (ch === "*") {
            const next = pat[i + 1]
            if (next === "*") {
                const after = pat[i + 2]
                if (after === "/") {
                    // **/  (zero or more directories; zero-level allowed)
                    regex += "(?:.*/)?"
                    i += 2
                    continue
                }
                // **
                regex += ".*"
                i++
                continue
            }
            // *
            regex += "[^/]*"
            continue
        }

        if (ch === "?") {
            regex += "[^/]"
            continue
        }

        if (ch === "/") {
            regex += "/"
            continue
        }

        regex += escapeRegExpChar(ch)
    }

    regex += "$"
    return new RegExp(regex)
}

function matchesGlob(inputPath, pattern) {
    if (!pattern) return false
    const input = normalizePath(inputPath)
    return globToRegExp(pattern).test(input)
}

// ---------- File-path extraction (ZCode 工具参数：file_path / path 键) ----------

/**
 * Extract file paths from ZCode tool parameters. Recognises the two common
 * parameter keys used by ZCode tools: 'file_path' (Write/Edit/Read-style) and
 * 'path' (Skill/Tool-style). DCP's opencode-only branches (apply_patch patchText
 * parsing, multiedit nested edits) are intentionally absent — those tools do
 * not exist in ZCode (PLAN Task 3 / ZCode 适配).
 */
export function getFilePathsFromParameters(tool, parameters) {
    if (typeof parameters !== "object" || parameters === null) {
        return []
    }

    const paths = []
    const params = parameters

    if (typeof params.file_path === "string") {
        paths.push(params.file_path)
    }
    if (typeof params.path === "string") {
        paths.push(params.path)
    }

    // Return unique non-empty paths
    return [...new Set(paths)].filter((p) => p.length > 0)
}

export function isFilePathProtected(filePaths, patterns) {
    if (!filePaths || filePaths.length === 0) return false
    if (!patterns || patterns.length === 0) return false

    return filePaths.some((path) => patterns.some((pattern) => matchesGlob(path, pattern)))
}

// ---------- Tool-name protection (精确 Set + glob; MCP 前缀剥除) ----------

const GLOB_CHARS = /[*?]/

/**
 * Test whether a tool name is protected by the given pattern list.
 *
 * MCP-aware: when the tool arrives as `mcp__<server>__<tool>`, the server
 * prefix is stripped so that a pattern of the bare tool name (e.g. 'compress')
 * still matches. Both the full name and the bare name are tried against the
 * pattern list — this preserves correctness whether the caller lists the
 * fully-qualified name or the bare name.
 *
 * Patterns are split into exact (Set) and glob buckets for efficiency: exact
 * matches short-circuit, glob patterns are matched via matchesGlob().
 */
export function isToolNameProtected(toolName, patterns) {
    if (!toolName || !patterns || patterns.length === 0) return false

    const exactPatterns = new Set()
    const globPatterns = []

    for (const pattern of patterns) {
        if (GLOB_CHARS.test(pattern)) {
            globPatterns.push(pattern)
        } else {
            exactPatterns.add(pattern)
        }
    }

    // 1. Try the full name (preserves explicit full-name matches)
    if (exactPatterns.has(toolName)) return true
    if (globPatterns.some((pattern) => matchesGlob(toolName, pattern))) return true

    // 2. Strip MCP `mcp__<server>__` prefix and try the bare tool name.
    //    Assumes server names are single tokens (no '_'). Empirically all 10
    //    real ZCode MCP server prefixes observed in test-lab/echo-capture.jsonl
    //    use hyphens (e.g. 'mcp__dcp__compress', 'mcp__filesystem__read'),
    //    so the regex `/^mcp__<token>__<rest>/` is correct for current usage.
    //    If a server name ever contains '_' the prefix stripping degrades
    //    gracefully — the full name is still tried in step 1 above and the
    //    bare tool name still matches via the same glob (e.g. `mcp__*__compress`).
    const mcpPrefixMatch = /^mcp__(?:[^_]+(?:__[^_]+)*?)__([^_].*)$/.exec(toolName)
    if (mcpPrefixMatch) {
        const bare = mcpPrefixMatch[1]
        if (exactPatterns.has(bare)) return true
        if (globPatterns.some((pattern) => matchesGlob(bare, pattern))) return true
    }

    return false
}

/**
 * Strip an optional `mcp__<server>__` prefix from a tool name. Bare name
 * matching is needed because DCP-style protectedTools ("TodoWrite", "Bash")
 * must also match the fully-qualified form ("mcp__zcode__Bash").
 *
 *   "TodoWrite"        → "TodoWrite"
 *   "mcp__foo__Bash"   → "Bash"
 *
 * Exported so sibling modules (e.g. prune.mjs) can share this single
 * definition instead of duplicating the regex.
 */
export function stripMcpPrefix(name) {
    if (typeof name !== "string") return name
    const m = /^mcp__(?:[^_]+(?:__[^_]+)*?)__([^_].*)$/.exec(name)
    return m ? m[1] : name
}

// ---------- Main-session whitelist gate (对齐 SPEC R7.7 / DCP hooks.ts:42-56) ----------

const DEFAULT_MAIN_SIGNATURES = ["You are ZCode"]

// Ported verbatim from DCP hooks.ts:42-47 — used as the blacklist when
// allowSubAgents=true (only internal-helper sessions are skipped; main and
// sub-agent requests both pass).
const DEFAULT_INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

/**
 * Decide whether the request should be processed by the pruning pipeline.
 *
 * Whitelist mode (default, allowSubAgents !== true):
 *   - Returns true iff the first system block's text contains one of the
 *     configured main signatures (default: 'You are ZCode'; extended via
 *     config.extraMainSignatures). Sub-agents and internal helper sessions
 *     use different system prompts and therefore fail this check, so their
 *     messages are passed through untouched.
 *
 * Blacklist mode (allowSubAgents === true):
 *   - Returns false (skip) iff the first system block's text contains one of
 *     the configured internal-agent signatures (default = DCP hooks.ts:42-47
 *     verbatim; extended via config.internalAgentSignatures). Main-session
 *     and sub-agent requests BOTH pass — only internal helpers are skipped.
 *     This aligns with DCP's allowSubAgents semantics: when sub-agents are
 *     permitted, the gate no longer blocks them; it only filters out
 *     internal-helper compaction/summarisation calls.
 */
export function isMainSession(systemBlocks, config) {
    if (!Array.isArray(systemBlocks) || systemBlocks.length === 0) return false

    const first = systemBlocks[0]
    if (!first || typeof first !== "object") return false
    const text = first.text
    if (typeof text !== "string" || text.length === 0) return false

    const allowSubAgents =
        !!(config && config.experimental && config.experimental.allowSubAgents === true)

    if (allowSubAgents) {
        // Blacklist: skip only internal-helper sessions
        const extras =
            config && Array.isArray(config.internalAgentSignatures)
                ? config.internalAgentSignatures
                : []
        const signatures = [...DEFAULT_INTERNAL_AGENT_SIGNATURES, ...extras]
        const hitInternal = signatures.some((sig) => text.includes(sig))
        return !hitInternal
    }

    // Whitelist (default): only signed main-session requests pass
    const extras =
        config && Array.isArray(config.extraMainSignatures)
            ? config.extraMainSignatures
            : []
    const signatures = [...DEFAULT_MAIN_SIGNATURES, ...extras]
    return signatures.some((sig) => text.includes(sig))
}
