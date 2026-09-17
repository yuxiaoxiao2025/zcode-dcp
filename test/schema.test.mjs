// Schema + commands test — PLAN task-14
// Asserts that:
//   1) dcp.schema.json (load + JSON.parse) is structurally consistent with
//      proxy/config.mjs DEFAULT_CONFIG (schema top-level properties ⊇ DEFAULT_CONFIG keys
//      − `$schema`) and matches VALID_CONFIG_KEYS for nested keys we care about.
//   2) All nine zcode-dcp/commands/*.md files exist and have a parseable
//      YAML-ish frontmatter with a non-empty `description` field.
//   3) dcp-compress.md body contains both `<compress triggered manually>` and
//      `$ARGUMENTS`.
//   4) ZCode session-classification keys (internalAgentSignatures,
//      extraMainSignatures) are accepted by both schema and validateConfig
//      without "Unknown key" warnings — they are consumed at runtime by
//      proxy/protect.mjs:256-285.
//
// Zero external deps (no ajv). Validation is by key-set assertions, mirroring
// what config.mjs's validateConfig does, plus structural checks. If the schema
// ever drifts from config.mjs, the diff shows up here.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { DEFAULT_CONFIG, validateConfig } from "../proxy/config.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PLUGIN_ROOT = join(__dirname, "..")
const SCHEMA_PATH = join(PLUGIN_ROOT, "dcp.schema.json")
const COMMANDS_DIR = join(PLUGIN_ROOT, "commands")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect dotted key paths from an object (mirrors config.mjs
 * getConfigKeyPaths). Used so we can compare schema-property key names against
 * DEFAULT_CONFIG key names.
 *
 * @param {object} obj
 * @param {string} prefix
 * @returns {string[]}
 */
function collectKeyPaths(obj, prefix = "") {
    const keys = []
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return keys
    }
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...collectKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

/**
 * Parse a minimal frontmatter block delimited by `---` lines. Returns null
 * when the file does not start with a frontmatter block. We do NOT pull in
 * a YAML dep — frontmatter here is `key: "string"` or `key: string` only,
 * which a regex + line-split handles safely.
 *
 * @param {string} text
 * @returns {Record<string,string>|null}
 */
function parseFrontmatter(text) {
    if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null
    // Find the closing fence
    const afterOpen = text.indexOf("\n") + 1
    const closeIdx = text.indexOf("\n---", afterOpen)
    if (closeIdx < 0) return null
    const block = text.slice(afterOpen, closeIdx)
    const out = {}
    for (const line of block.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
        if (!m) continue
        let v = m[2].trim()
        // strip surrounding double quotes if present
        if (v.startsWith('"') && v.endsWith('"')) {
            v = v.slice(1, -1)
        }
        out[m[1]] = v
    }
    return out
}

// ---------------------------------------------------------------------------
// 1. Schema vs. config.mjs DEFAULT_CONFIG alignment
// ---------------------------------------------------------------------------

describe("dcp.schema.json ↔ proxy/config.mjs DEFAULT_CONFIG", () => {
    test("schema file exists and parses as JSON", () => {
        assert.ok(existsSync(SCHEMA_PATH), `schema missing: ${SCHEMA_PATH}`)
        const raw = readFileSync(SCHEMA_PATH, "utf-8")
        const parsed = JSON.parse(raw) // throws on malformed JSON
        assert.equal(parsed.type, "object")
        assert.ok(parsed.properties && typeof parsed.properties === "object")
    })

    test("schema top-level properties cover every DEFAULT_CONFIG key (except `$schema`)", () => {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"))
        const schemaTopKeys = new Set(Object.keys(schema.properties))
        const defaultKeys = Object.keys(DEFAULT_CONFIG)

        const missing = []
        for (const k of defaultKeys) {
            if (k === "$schema") continue // not present in DEFAULT_CONFIG (would be user-supplied)
            if (!schemaTopKeys.has(k)) {
                missing.push(k)
            }
        }
        assert.deepEqual(
            missing,
            [],
            `schema.properties missing keys that DEFAULT_CONFIG has: ${missing.join(", ")}`,
        )
    })

    test("schema does NOT include removed upstream-only keys (autoUpdate, pruneNotificationType)", () => {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"))
        assert.equal(
            "autoUpdate" in schema.properties,
            false,
            "schema must not define autoUpdate (removed in ZCode port)",
        )
        assert.equal(
            "pruneNotificationType" in schema.properties,
            false,
            "schema must not define pruneNotificationType (removed in ZCode port)",
        )
    })

    test("schema defines ZCode-only keys: proxy, upstream, contextWindow", () => {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"))
        for (const k of ["proxy", "upstream", "contextWindow"]) {
            assert.ok(
                k in schema.properties,
                `schema.properties must define ZCode-only key: ${k}`,
            )
        }
        // proxy must expose the four expected sub-keys
        const proxyProps = Object.keys(schema.properties.proxy.properties)
        for (const sub of ["port", "idleTimeoutMin", "adminTokenFile", "adminProbeTimeoutMs"]) {
            assert.ok(
                proxyProps.includes(sub),
                `proxy.properties missing: ${sub} (have: ${proxyProps.join(", ")})`,
            )
        }
        // upstream must expose baseUrl + apiKey
        const upstreamProps = Object.keys(schema.properties.upstream.properties)
        for (const sub of ["baseUrl", "apiKey"]) {
            assert.ok(
                upstreamProps.includes(sub),
                `upstream.properties missing: ${sub} (have: ${upstreamProps.join(", ")})`,
            )
        }
    })

    test("schema nested `compress` properties include the keys DEFAULT_CONFIG.compress declares", () => {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"))
        const compressProps = new Set(Object.keys(schema.properties.compress.properties))
        const defaultCompressKeys = Object.keys(DEFAULT_CONFIG.compress)
        const missing = defaultCompressKeys.filter((k) => !compressProps.has(k))
        assert.deepEqual(
            missing,
            [],
            `compress.properties missing keys vs DEFAULT_CONFIG.compress: ${missing.join(", ")}`,
        )
    })

    test("schema nested `strategies` properties include deduplication + purgeErrors with expected sub-keys", () => {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"))
        const strategies = schema.properties.strategies.properties
        assert.ok(strategies.deduplication, "strategies.deduplication missing")
        assert.ok(strategies.purgeErrors, "strategies.purgeErrors missing")
        for (const sub of ["enabled", "protectedTools"]) {
            assert.ok(
                sub in strategies.deduplication.properties,
                `strategies.deduplication.properties missing: ${sub}`,
            )
        }
        for (const sub of ["enabled", "turns", "protectedTools"]) {
            assert.ok(
                sub in strategies.purgeErrors.properties,
                `strategies.purgeErrors.properties missing: ${sub}`,
            )
        }
        // DEFAULT_CONFIG.strategies.{deduplication,purgeErrors}.{enabled,protectedTools} covered
        const dedupDefault = Object.keys(DEFAULT_CONFIG.strategies.deduplication)
        const purgeDefault = Object.keys(DEFAULT_CONFIG.strategies.purgeErrors)
        for (const k of dedupDefault) {
            assert.ok(
                k in strategies.deduplication.properties,
                `strategies.deduplication.properties missing DEFAULT_CONFIG key: ${k}`,
            )
        }
        for (const k of purgeDefault) {
            assert.ok(
                k in strategies.purgeErrors.properties,
                `strategies.purgeErrors.properties missing DEFAULT_CONFIG key: ${k}`,
            )
        }
    })
})

// ---------------------------------------------------------------------------
// 2. Command files — existence + frontmatter shape
// ---------------------------------------------------------------------------

const EXPECTED_COMMANDS = [
    "dcp-compress.md",
    "dcp-stats.md",
    "dcp-context.md",
    "dcp-manual.md",
    "dcp-sweep.md",
    "dcp-decompress.md",
    "dcp-recompress.md",
    "dcp-setup.md",
    "dcp-help.md",
]

describe("zcode-dcp/commands/ — nine slash-command files", () => {
    test("directory exists and contains exactly the nine expected files", () => {
        assert.ok(existsSync(COMMANDS_DIR), `commands dir missing: ${COMMANDS_DIR}`)
        const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md")).sort()
        assert.deepEqual(files, [...EXPECTED_COMMANDS].sort())
    })

    for (const filename of EXPECTED_COMMANDS) {
        test(`${filename}: exists, frontmatter parses, description is non-empty`, () => {
            const path = join(COMMANDS_DIR, filename)
            assert.ok(existsSync(path), `missing: ${path}`)
            const text = readFileSync(path, "utf-8")
            const fm = parseFrontmatter(text)
            assert.ok(fm, `${filename}: frontmatter missing or unparseable`)
            assert.ok(
                typeof fm.description === "string" && fm.description.length > 0,
                `${filename}: description must be non-empty string, got ${JSON.stringify(fm.description)}`,
            )
        })
    }
})

// ---------------------------------------------------------------------------
// 3. dcp-compress.md body content — verbatim COMPRESS_TRIGGER_PROMPT from
//    upstream opencode-dcp v3.1.15 lib/commands/manual.ts:23-29.
// ---------------------------------------------------------------------------

describe("dcp-compress.md body", () => {
    test("contains the verbatim <compress triggered manually> trigger marker", () => {
        const text = readFileSync(join(COMMANDS_DIR, "dcp-compress.md"), "utf-8")
        assert.ok(
            text.includes("<compress triggered manually>"),
            "dcp-compress.md must contain the trigger marker <compress triggered manually>",
        )
    })

    test("contains the literal $ARGUMENTS placeholder", () => {
        const text = readFileSync(join(COMMANDS_DIR, "dcp-compress.md"), "utf-8")
        assert.ok(
            text.includes("$ARGUMENTS"),
            "dcp-compress.md must contain the literal $ARGUMENTS placeholder",
        )
    })
})

// ---------------------------------------------------------------------------
// 4. Session-classification signature keys — internalAgentSignatures +
//    extraMainSignatures. Consumed at runtime by proxy/protect.mjs:256-285
//    (isMainSession). Pre-fix: validateConfig silently rejected them as
//    "Unknown key", even though the runtime read them from config. Post-fix:
//    schema, VALID_CONFIG_KEYS, and validateConfig type-check all agree.
// ---------------------------------------------------------------------------

describe("session-classification signature keys (internalAgentSignatures / extraMainSignatures)", () => {
    test("schema declares both keys at top level as string[]", () => {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"))
        for (const k of ["internalAgentSignatures", "extraMainSignatures"]) {
            assert.ok(
                k in schema.properties,
                `schema.properties must declare ${k}`,
            )
            const def = schema.properties[k]
            assert.equal(def.type, "array", `${k} must be type:array`)
            assert.equal(def.items.type, "string", `${k}.items.type must be string`)
        }
    })

    test("validateConfig accepts valid string[] values without 'Unknown key' warnings", () => {
        // Post-fix assertion: keys are recognized, no Unknown-key warning emitted.
        // (Pre-fix behavior — captured during TDD red probe before this commit —
        // produced ["Unknown key: internalAgentSignatures",
        //  "Unknown key: extraMainSignatures"]. See commit message for the
        // captured FAIL trail.)
        const cfg = {
            internalAgentSignatures: ["You are a custom internal summarizer"],
            extraMainSignatures: ["You are Claude"],
        }
        const warnings = validateConfig(cfg)
        const unknownWarnings = warnings.filter((w) => w.startsWith("Unknown key:"))
        assert.deepEqual(
            unknownWarnings,
            [],
            `Unknown key warnings present: ${unknownWarnings.join(" | ")}`,
        )
    })

    test("validateConfig rejects non-string entries in the signature arrays", () => {
        const cfg = {
            internalAgentSignatures: [1, 2],
            extraMainSignatures: [true],
        }
        const warnings = validateConfig(cfg)
        assert.ok(
            warnings.some((w) => w.includes("internalAgentSignatures: non-string")),
            `expected non-string warning for internalAgentSignatures; got: ${JSON.stringify(warnings)}`,
        )
        assert.ok(
            warnings.some((w) => w.includes("extraMainSignatures: non-string")),
            `expected non-string warning for extraMainSignatures; got: ${JSON.stringify(warnings)}`,
        )
    })

    test("validateConfig rejects non-array values for the signature keys", () => {
        const cfg = {
            internalAgentSignatures: "not-an-array",
            extraMainSignatures: 42,
        }
        const warnings = validateConfig(cfg)
        assert.ok(
            warnings.some((w) => w.startsWith("internalAgentSignatures: expected string[]")),
            `expected type warning for internalAgentSignatures; got: ${JSON.stringify(warnings)}`,
        )
        assert.ok(
            warnings.some((w) => w.startsWith("extraMainSignatures: expected string[]")),
            `expected type warning for extraMainSignatures; got: ${JSON.stringify(warnings)}`,
        )
    })
})
