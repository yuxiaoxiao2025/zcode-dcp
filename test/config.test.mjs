// Ported from opencode-dcp v3.1.15 tests for lib/config.ts (AGPL-3.0-or-later, © DCP authors) — see NOTICE
// Tests for proxy/config.mjs: parseJsonc, DEFAULT_CONFIG, mergeConfig, loadConfig, validateConfig

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    parseJsonc,
    DEFAULT_CONFIG,
    mergeConfig,
    loadConfig,
    validateConfig,
} from "../proxy/config.mjs"

describe("parseJsonc", () => {
    test("strips // line comments", () => {
        const text = `{
            // this is a comment
            "port": 8367
        }`
        const v = parseJsonc(text)
        assert.equal(v.port, 8367)
    })

    test("strips /* block */ comments", () => {
        const text = `{ "port": /* inline */ 8367, /* multi\nline */ "enabled": true }`
        const v = parseJsonc(text)
        assert.equal(v.port, 8367)
        assert.equal(v.enabled, true)
    })

    test("tolerates trailing commas in objects and arrays", () => {
        const text = `{
            "a": [1, 2, 3,],
            "b": {"x": 1, "y": 2,},
        }`
        const v = parseJsonc(text)
        assert.deepEqual(v.a, [1, 2, 3])
        assert.deepEqual(v.b, { x: 1, y: 2 })
    })

    test("does NOT strip comma-like characters that live inside string values", () => {
        // String values whose contents end with "," followed by "}" or "]"
        // would be corrupted by a naive regex-based stripper (the regex would
        // see the inner ",}" / ",]" and delete the comma, mangling the value).
        // Use a wrapper array with whitespace + a trailing close so the JSONC
        // trailing-comma tolerance has work to do on the OUTER level, proving
        // the inner strings are not touched.
        const text = `{ "patterns": ["foo,}", "bar,]"], "k": 1 }`
        const v = parseJsonc(text)
        assert.equal(v.patterns[0], "foo,}", "string-internal ',}' must survive")
        assert.equal(v.patterns[1], "bar,]", "string-internal ',]' must survive")
        assert.equal(v.k, 1)
    })

    test("preserves // inside strings", () => {
        const text = `{ "url": "https://example.com/path", "msg": "note // not a comment" }`
        const v = parseJsonc(text)
        assert.equal(v.url, "https://example.com/path")
        assert.equal(v.msg, "note // not a comment")
    })

    test("throw error includes line and column information on bad input", () => {
        const text = `{
            "port": 8367
            "enabled": true
        }`
        assert.throws(
            () => parseJsonc(text),
            (err) => {
                return /line \d+/i.test(err.message) && /column \d+/i.test(err.message)
            },
        )
    })
})

describe("DEFAULT_CONFIG", () => {
    test("contains all DCP-aligned top-level keys", () => {
        for (const key of [
            "enabled",
            "debug",
            "commands",
            "manualMode",
            "turnProtection",
            "experimental",
            "protectedFilePatterns",
            "compress",
            "strategies",
        ]) {
            assert.ok(key in DEFAULT_CONFIG, `missing key ${key}`)
        }
    })

    test("contains ZCode-only adaptation keys", () => {
        assert.ok("proxy" in DEFAULT_CONFIG)
        assert.ok("upstream" in DEFAULT_CONFIG)
        assert.ok("contextWindow" in DEFAULT_CONFIG)
        assert.equal(DEFAULT_CONFIG.proxy.port, 8367)
        assert.equal(DEFAULT_CONFIG.proxy.idleTimeoutMin, 30)
    })

    test("does NOT contain keys dropped for ZCode", () => {
        assert.equal("autoUpdate" in DEFAULT_CONFIG, false)
        assert.equal("pruneNotificationType" in DEFAULT_CONFIG, false)
    })

    test("compress defaults match DCP defaultConfig (lib/config.ts:679-692)", () => {
        const c = DEFAULT_CONFIG.compress
        assert.equal(c.mode, "range")
        assert.equal(c.permission, "allow")
        assert.equal(c.showCompression, false)
        assert.equal(c.summaryBuffer, true)
        assert.equal(c.maxContextLimit, 100000)
        assert.equal(c.minContextLimit, 30000)
        assert.equal(c.nudgeFrequency, 5)
        assert.equal(c.iterationNudgeThreshold, 15)
        assert.equal(c.nudgeForce, "soft")
        assert.equal(c.protectTags, false)
        assert.equal(c.protectUserMessages, false)
    })

    test("strategies defaults match DCP defaultConfig (lib/config.ts:693-703)", () => {
        assert.equal(DEFAULT_CONFIG.strategies.deduplication.enabled, true)
        assert.deepEqual(DEFAULT_CONFIG.strategies.deduplication.protectedTools, [])
        assert.equal(DEFAULT_CONFIG.strategies.purgeErrors.enabled, true)
        assert.equal(DEFAULT_CONFIG.strategies.purgeErrors.turns, 4)
        assert.deepEqual(DEFAULT_CONFIG.strategies.purgeErrors.protectedTools, [])
    })
})

describe("mergeConfig", () => {
    test("arrays union across layers; lower layer entries survive higher layer", () => {
        const base = {
            ...DEFAULT_CONFIG,
            strategies: {
                deduplication: {
                    enabled: true,
                    protectedTools: ["alpha", "beta"],
                },
                purgeErrors: {
                    enabled: true,
                    turns: 4,
                    protectedTools: ["gamma"],
                },
            },
        }
        const override = {
            strategies: {
                deduplication: { protectedTools: ["beta", "delta"] },
            },
        }
        const merged = mergeConfig([base, override])
        assert.deepEqual(
            merged.strategies.deduplication.protectedTools.sort(),
            ["alpha", "beta", "delta"],
        )
    })

    test("modelLimits are whole-table replacement (override wins entirely)", () => {
        const base = {
            ...DEFAULT_CONFIG,
            compress: {
                ...DEFAULT_CONFIG.compress,
                modelMaxLimits: { "anthropic/claude-opus": 200000 },
                modelMinLimits: { "anthropic/claude-opus": 100000 },
            },
        }
        const override = {
            compress: {
                modelMaxLimits: { "anthropic/claude-sonnet": 180000 },
            },
        }
        const merged = mergeConfig([base, override])
        assert.deepEqual(merged.compress.modelMaxLimits, {
            "anthropic/claude-sonnet": 180000,
        })
        // modelMinLimits is not in override -> falls back to base (undefined means fall-back? actually no, override only has modelMaxLimits)
        assert.deepEqual(merged.compress.modelMinLimits, {
            "anthropic/claude-opus": 100000,
        })
    })

    test("scalar fields use override-wins semantics", () => {
        const base = { ...DEFAULT_CONFIG, debug: false, pruneNotification: "detailed" }
        const override = { debug: true, pruneNotification: "minimal" }
        const merged = mergeConfig([base, override])
        assert.equal(merged.debug, true)
        assert.equal(merged.pruneNotification, "minimal")
    })

    test("two-layer merging respects priority order (later layer wins)", () => {
        const layer0 = { ...DEFAULT_CONFIG, enabled: true, debug: false }
        const layer1 = { enabled: false }
        const layer2 = { debug: true }
        const merged = mergeConfig([layer0, layer1, layer2])
        assert.equal(merged.enabled, false)
        assert.equal(merged.debug, true)
    })
})

describe("loadConfig", () => {
    test("returns DEFAULT_CONFIG + empty warnings when no config files exist", () => {
        // Isolate homedir to a fresh empty tmp dir so a user-side ~/.zcode/dcp/dcp.jsonc
        // can't make this test flaky. (loadConfig reads homedir() unconditionally.)
        const fakeHome = mkdtempSync(join(tmpdir(), "dcp-empty-home-"))
        const tmpCwd = mkdtempSync(join(tmpdir(), "dcp-cfg-empty-"))
        const tmpData = mkdtempSync(join(tmpdir(), "dcp-data-empty-"))
        const origHome = process.env.HOME
        const origUserProfile = process.env.USERPROFILE
        process.env.HOME = fakeHome
        process.env.USERPROFILE = fakeHome
        try {
            const { config, warnings } = loadConfig(tmpCwd, tmpData)
            assert.equal(config.enabled, DEFAULT_CONFIG.enabled)
            assert.equal(config.compress.maxContextLimit, 100000)
            assert.deepEqual(warnings, [])
        } finally {
            process.env.HOME = origHome
            process.env.USERPROFILE = origUserProfile
        }
    })

    test("project layer overrides user layer for scalar fields", () => {
        // Build user + project layout
        const userHome = mkdtempSync(join(tmpdir(), "dcp-user-"))
        const userCfgDir = join(userHome, ".zcode", "dcp")
        mkdirSync(userCfgDir, { recursive: true })
        writeFileSync(
            join(userCfgDir, "dcp.jsonc"),
            '{ "debug": false, "pruneNotification": "detailed" }',
        )

        const projectRoot = mkdtempSync(join(tmpdir(), "dcp-proj-"))
        const projectCfgDir = join(projectRoot, ".zcode")
        mkdirSync(projectCfgDir, { recursive: true })
        writeFileSync(
            join(projectCfgDir, "dcp.jsonc"),
            '{ "debug": true, "compress": { "maxContextLimit": 50000 } }',
        )

        // Use process.env override (no global env var exists in test by default)
        const origHome = process.env.HOME
        const origUserProfile = process.env.USERPROFILE
        process.env.HOME = userHome
        process.env.USERPROFILE = userHome
        try {
            const { config } = loadConfig(projectRoot, join(userHome, "data"))
            assert.equal(config.debug, true, "project should override user")
            assert.equal(config.compress.maxContextLimit, 50000, "project override scalar compress")
            assert.equal(config.pruneNotification, "detailed", "user value survives when project doesn't touch it")
        } finally {
            process.env.HOME = origHome
            process.env.USERPROFILE = origUserProfile
        }
    })

    test("returns parseError -> warning when file is invalid (graceful degrade)", () => {
        const userHome = mkdtempSync(join(tmpdir(), "dcp-bad-"))
        const userCfgDir = join(userHome, ".zcode", "dcp")
        mkdirSync(userCfgDir, { recursive: true })
        writeFileSync(
            join(userCfgDir, "dcp.jsonc"),
            '{ "debug": true, "compress": { "maxContextLimit": 50', // truncated
        )

        const origHome = process.env.HOME
        const origUserProfile = process.env.USERPROFILE
        process.env.HOME = userHome
        process.env.USERPROFILE = userHome
        try {
            const { config, warnings } = loadConfig(userHome, join(userHome, "data"))
            // Should still return a usable config (defaults)
            assert.equal(config.debug, DEFAULT_CONFIG.debug)
            assert.ok(warnings.length >= 1)
            assert.match(warnings[0], /parse|invalid|error/i)
        } finally {
            process.env.HOME = origHome
            process.env.USERPROFILE = origUserProfile
        }
    })
})

describe("validateConfig", () => {
    test("returns no warnings for DEFAULT_CONFIG", () => {
        const warnings = validateConfig(DEFAULT_CONFIG)
        assert.deepEqual(warnings, [])
    })

    test("warns on unknown top-level keys", () => {
        const warnings = validateConfig({ ...DEFAULT_CONFIG, totallyMadeUpKey: 42 })
        assert.ok(
            warnings.some((w) => /unknown/i.test(w) && /totallyMadeUpKey/.test(w)),
            `expected unknown-key warning, got: ${JSON.stringify(warnings)}`,
        )
    })

    test("warns on unknown nested keys (compress.foo)", () => {
        const cfg = {
            ...DEFAULT_CONFIG,
            compress: { ...DEFAULT_CONFIG.compress, foo: "bar" },
        }
        const warnings = validateConfig(cfg)
        assert.ok(warnings.some((w) => /compress\.foo/.test(w)))
    })

    test("warns on type errors (debug: number)", () => {
        const cfg = { ...DEFAULT_CONFIG, debug: 123 }
        const warnings = validateConfig(cfg)
        assert.ok(warnings.some((w) => /debug/.test(w) && /boolean/.test(w)))
    })
})
