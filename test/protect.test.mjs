// test/protect.test.mjs
// TDD tests for proxy/protect.mjs (task-3 of port-opencode-dcp-to-zcode)
//
// Coverage (per PLAN Task 3):
//   - glob semantics (8 cases incl. zero-level **/ + non-cross /)
//   - MCP tool name prefix stripping for isToolNameProtected
//   - main-session whitelist gate (3 states: main passes / sub-agent rejected /
//     allowSubAgents=true inverts to blacklist)
//   - file path extraction (ZCode tool params: file_path/path)
//   - ZCode name mapping for COMPRESS_PROTECTED_TOOLS
//     (the historical DEFAULT_PROTECTED_TOOLS was removed in R2 — it was
//     a dead constant with zero production consumers; the dedup-side
//     "default" lives in prune.mjs as `SKIP_TOOLS`).

import { test } from "node:test"
import assert from "node:assert/strict"

import {
    COMPRESS_PROTECTED_TOOLS,
    isToolNameProtected,
    globToRegExp,
    getFilePathsFromParameters,
    isFilePathProtected,
    isMainSession,
} from "../proxy/protect.mjs"

// ---------- COMPRESS_PROTECTED_TOOLS (ZCode 映射) ----------

test("COMPRESS_PROTECTED_TOOLS is the ZCode-mapped compress-strategy default", () => {
    assert.ok(Array.isArray(COMPRESS_PROTECTED_TOOLS))
    // PLAN: [Agent, Task, Skill, TodoWrite, TodoRead]
    assert.deepEqual(
        [...COMPRESS_PROTECTED_TOOLS].sort(),
        ["Agent", "Skill", "Task", "TodoRead", "TodoWrite"],
    )
})

// ---------- globToRegExp (移植自 DCP protected-patterns.ts:13-62) ----------

test("globToRegExp: exact literal pattern produces ^...$ anchored RegExp", () => {
    const re = globToRegExp("docs/SPEC.md")
    assert.equal(re.flags, "")
    assert.equal(re.test("docs/SPEC.md"), true)
    assert.equal(re.test("other/docs/SPEC.md"), false, "must be anchored to full string")
})

test("globToRegExp: single '*' does NOT cross '/'", () => {
    const re = globToRegExp("docs/*.md")
    assert.equal(re.test("docs/SPEC.md"), true)
    assert.equal(re.test("docs/sub/SPEC.md"), false, "* must not cross '/'")
})

test("globToRegExp: '**' matches anything including '/'", () => {
    const re = globToRegExp("**/*.md")
    assert.equal(re.test("a.md"), true)
    assert.equal(re.test("docs/a.md"), true)
    assert.equal(re.test("docs/sub/a.md"), true, "** crosses '/'")
    assert.equal(re.test("a.txt"), false)
})

test("globToRegExp: '**/' matches zero or more directory levels (zero-level allowed)", () => {
    const re = globToRegExp("**/x.ts")
    assert.equal(re.test("x.ts"), true, "zero-level match: no directory prefix")
    assert.equal(re.test("a/x.ts"), true)
    assert.equal(re.test("a/b/x.ts"), true)
    assert.equal(re.test("y.ts"), false)
})

test("globToRegExp: '?' matches exactly one non-'/' char", () => {
    const re = globToRegExp("docs/?.md")
    assert.equal(re.test("docs/a.md"), true)
    assert.equal(re.test("docs/ab.md"), false, "'?' matches one char only")
    assert.equal(re.test("docs/X.md"), true)
})

test("globToRegExp: backslashes normalized to '/' in the pattern", () => {
    // globToRegExp normalises backslashes IN THE PATTERN (not the input).
    // Input-path normalisation happens in matchesGlob / isFilePathProtected.
    const re = globToRegExp("docs\\SPEC.md")
    assert.equal(re.test("docs/SPEC.md"), true, "backslash in pattern normalised to '/'")
})

test("globToRegExp: regex special chars are escaped in literal segments", () => {
    const re = globToRegExp("a.b+c(d).md")
    assert.equal(re.test("a.b+c(d).md"), true)
    // The literal dot must not match any char
    assert.equal(re.test("aXb+c(d).md"), false)
})

test("globToRegExp: combined pattern **/lib/*.ts", () => {
    const re = globToRegExp("**/lib/*.ts")
    assert.equal(re.test("lib/a.ts"), true, "zero-level lib/")
    assert.equal(re.test("src/lib/a.ts"), true)
    assert.equal(re.test("lib/sub/a.ts"), false, "single * does not cross /")
    assert.equal(re.test("src/lib/sub/a.ts"), false, "single * does not cross / even under **/")
})

test("globToRegExp: ** NOT adjacent to '/' is treated as two adjacent 'any' tokens", () => {
    // DCP semantics: '**' alone (without trailing '/') becomes '.*' — but
    // when surrounded by other chars (e.g. 'a**b'), each '*' is part of an
    // independent '**' collapse and the whole pattern still anchors to the
    // full string. 'a**b' becomes 'a.*b' (effectively), matching any
    // 'a<anything>b' (including the empty 'ab').
    const re = globToRegExp("a**b")
    assert.equal(re.test("ab"), true, "empty middle is OK (a<none>b)")
    assert.equal(re.test("axb"), true)
    assert.equal(re.test("axxxb"), true)
    assert.equal(re.test("a/b"), true, "** crosses '/'")
    assert.equal(re.test("a"), false, "missing trailing 'b'")
    assert.equal(re.test("b"), false)
})

// ---------- isToolNameProtected (精确 Set + glob; MCP 前缀剥除) ----------

test("isToolNameProtected: exact match (ZCode name)", () => {
    assert.equal(isToolNameProtected("Agent", ["Agent", "Task"]), true)
    assert.equal(isToolNameProtected("Task", ["Agent", "Task"]), true)
    assert.equal(isToolNameProtected("Read", ["Agent", "Task"]), false)
})

test("isToolNameProtected: glob match (e.g. mcp__*__compress wildcard)", () => {
    assert.equal(isToolNameProtected("mcp__dcp__compress", ["mcp__*__compress"]), true)
    assert.equal(isToolNameProtected("mcp__other__compress", ["mcp__*__compress"]), true)
    assert.equal(isToolNameProtected("mcp__dcp__other", ["mcp__*__compress"]), false)
})

test("isToolNameProtected: MCP prefix is stripped so bare name also matches", () => {
    // DCP calls compress as 'compress'; with ZCode MCP wiring it arrives as 'mcp__dcp__compress'.
    // Both forms must match a patterns list that contains the bare name 'compress'.
    assert.equal(isToolNameProtected("mcp__dcp__compress", ["compress"]), true)
    assert.equal(isToolNameProtected("compress", ["compress"]), true)
    assert.equal(isToolNameProtected("mcp__dcp__compress", ["Agent", "Task", "compress"]), true)
})

test("isToolNameProtected: full name is also tried against exact set (no false negative)", () => {
    // If the caller lists the fully-qualified name explicitly, the function must match it too
    // (PLAN: '剥前缀后同时匹配全名与裸名').
    assert.equal(isToolNameProtected("mcp__dcp__compress", ["mcp__dcp__compress"]), true)
})

test("isToolNameProtected: empty inputs return false", () => {
    assert.equal(isToolNameProtected("", ["Agent"]), false)
    assert.equal(isToolNameProtected("Agent", []), false)
    assert.equal(isToolNameProtected("Agent", null), false)
})

// ---------- getFilePathsFromParameters (ZCode 工具参数：file_path/path 键) ----------

test("getFilePathsFromParameters: returns file_path for Write/Edit/Read-style tools", () => {
    const paths = getFilePathsFromParameters("Write", { file_path: "src/a.ts", content: "x" })
    assert.deepEqual(paths, ["src/a.ts"])
})

test("getFilePathsFromParameters: returns path for Skill/Tool-style tools", () => {
    const paths = getFilePathsFromParameters("Skill", { path: ".zcode/skills/foo/SKILL.md" })
    assert.deepEqual(paths, [".zcode/skills/foo/SKILL.md"])
})

test("getFilePathsFromParameters: returns [] when parameters is null/non-object", () => {
    assert.deepEqual(getFilePathsFromParameters("Read", null), [])
    assert.deepEqual(getFilePathsFromParameters("Read", undefined), [])
    assert.deepEqual(getFilePathsFromParameters("Read", "string-not-allowed"), [])
})

test("getFilePathsFromParameters: ignores empty path values", () => {
    assert.deepEqual(getFilePathsFromParameters("Write", { file_path: "" }), [])
})

test("getFilePathsFromParameters: dedups multiple paths", () => {
    const paths = getFilePathsFromParameters("Edit", {
        file_path: "a.ts",
        path: "a.ts", // duplicate
    })
    assert.deepEqual(paths, ["a.ts"])
})

// ---------- isFilePathProtected (glob 命中) ----------

test("isFilePathProtected: glob hit returns true; miss returns false", () => {
    assert.equal(isFilePathProtected(["docs/SPEC.md"], ["docs/*"]), true)
    assert.equal(isFilePathProtected(["docs/sub/SPEC.md"], ["docs/*"]), false)
    assert.equal(isFilePathProtected(["src/a.ts"], ["docs/*", "**/*.md"]), false)
    assert.equal(isFilePathProtected(["README.md"], ["**/*.md"]), true)
})

test("isFilePathProtected: empty inputs return false", () => {
    assert.equal(isFilePathProtected([], ["docs/*"]), false)
    assert.equal(isFilePathProtected(["a"], []), false)
    assert.equal(isFilePathProtected(null, ["docs/*"]), false)
})

test("isFilePathProtected: input path backslashes are normalised (Windows)", () => {
    // Input normalisation lives in matchesGlob / isFilePathProtected (not globToRegExp).
    assert.equal(isFilePathProtected(["docs\\SPEC.md"], ["docs/*"]), true)
    assert.equal(isFilePathProtected(["docs\\sub\\SPEC.md"], ["docs/*"]), false)
})

// ---------- isMainSession (白名单 gate：system blocks[0].text 含主签名) ----------

test("isMainSession: system containing 'You are ZCode' main signature passes", () => {
    const system = [{ type: "text", text: "You are ZCode, a coding assistant." }]
    assert.equal(isMainSession(system, {}), true)
})

test("isMainSession: sub-agent system without main signature is rejected", () => {
    // Sub-agent task system does NOT include 'You are ZCode'.
    const system = [{ type: "text", text: "You are a sub-agent tasked with reviewing code." }]
    assert.equal(isMainSession(system, {}), false)
})

test("isMainSession: allowSubAgents=true inverts to blacklist (only internal helpers are skipped)", () => {
    // Blacklist mode: only requests whose system[0] matches the
    // INTERNAL_AGENT_SIGNATURES list are skipped. Main-session AND sub-agent
    // requests both pass.
    const mainSystem = [{ type: "text", text: "You are ZCode, a coding assistant." }]
    const subSystem = [{ type: "text", text: "You are a sub-agent tasked with reviewing code." }]
    assert.equal(isMainSession(mainSystem, { experimental: { allowSubAgents: true } }), true,
        "main-session request passes (not on internal blacklist)")
    assert.equal(isMainSession(subSystem, { experimental: { allowSubAgents: true } }), true,
        "sub-agent request passes (not on internal blacklist)")
})

test("isMainSession: blacklist mode skips requests matching internal-helper signatures (DCP hooks.ts:42-47)", () => {
    // The 4 INTERNAL_AGENT_SIGNATURES from DCP must each trigger skip().
    const cases = [
        "You are a title generator",
        "You are a helpful AI assistant tasked with summarizing conversations",
        "You are an anchored context summarization assistant for coding sessions",
        "Summarize what was done in this conversation",
    ]
    for (const sig of cases) {
        const system = [{ type: "text", text: `${sig}. Please proceed.` }]
        assert.equal(
            isMainSession(system, { experimental: { allowSubAgents: true } }),
            false,
            `internal signature '${sig}' must trigger skip in blacklist mode`,
        )
    }
})

test("isMainSession: config.extraMainSignatures extends whitelist (default mode)", () => {
    const system = [{ type: "text", text: "You are Claude, an internal summarizer." }]
    // Default whitelist does NOT contain 'You are Claude' → rejected
    assert.equal(isMainSession(system, {}), false)
    // After adding 'You are Claude' to extraMainSignatures → passes
    assert.equal(
        isMainSession(system, { extraMainSignatures: ["You are Claude"] }),
        true,
        "extra main signature extends whitelist",
    )
})

test("isMainSession: config.internalAgentSignatures extends blacklist (allowSubAgents mode)", () => {
    const system = [{ type: "text", text: "You are a custom internal summarizer for QA." }]
    // Not in default internal list → passes
    assert.equal(
        isMainSession(system, { experimental: { allowSubAgents: true } }),
        true,
        "non-matching custom signature passes by default",
    )
    // After adding to internalAgentSignatures → skipped
    assert.equal(
        isMainSession(system, {
            experimental: { allowSubAgents: true },
            internalAgentSignatures: ["You are a custom internal summarizer"],
        }),
        false,
        "extra internal signature extends blacklist",
    )
})

test("isMainSession: empty/non-array system returns false (defensive)", () => {
    assert.equal(isMainSession([], {}), false)
    assert.equal(isMainSession(null, {}), false)
    assert.equal(isMainSession(undefined, {}), false)
})

test("isMainSession: missing/empty blocks[0].text returns false", () => {
    assert.equal(isMainSession([{}], {}), false)
    assert.equal(isMainSession([{ type: "text" }], {}), false)
})
