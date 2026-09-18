// SPDX-License-Identifier: AGPL-3.0-or-later
//
// version.test.mjs — unit tests for proxy/version.mjs (R9 single-source
// version reporting) and the resolveIdleTimeoutMs pure helper exported
// from proxy/daemon.mjs (R6 idleTimeoutMin 0 = forever).
//
// Covers:
//   * getVersion() — reads .zcode-plugin/plugin.json via import.meta.url-
//     relative path, returns version field; falls back to a hardcoded
//     constant + console.warn on read failure or malformed JSON.
//   * resolveIdleTimeoutMs(min) — pure function:
//       0  → Infinity   (forever; never schedule idle close)
//       +N → N * 60_000 (normal minutes→ms conversion)
//       -N → 1_800_000  + warn (negative falls back to 30 min default)
//       NaN → 1_800_000 + warn
//
// Both warns are captured via a console.warn monkey-patch (restored in
// `finally` so a thrown assertion never leaks the patch).

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { getVersion } from "../proxy/version.mjs"
import { resolveIdleTimeoutMs } from "../proxy/daemon.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.resolve(__dirname, "..")
const MANIFEST_PATH = path.join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json")

// ---------- helpers ----------

/** Run `fn` with console.warn captured; restore on exit. */
function captureWarn(fn) {
  const origWarn = console.warn
  const captured = []
  console.warn = (...args) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
  }
  try {
    return { result: fn(), captured }
  } finally {
    console.warn = origWarn
  }
}

function readManifestVersion() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")).version
}

// =====================================================================
// getVersion — R9 single source of truth
// =====================================================================
//
// SPEC R9 / DESIGN D10: there must be exactly one place that knows the
// plugin version. Both daemon.mjs and mcp-server.mjs should call
// getVersion() rather than each hardcoding "0.1.0" (the previous
// drift).

describe("getVersion — R9 single source of truth (D10)", () => {
  it("R9.① returns the version field from .zcode-plugin/plugin.json", () => {
    const expected = readManifestVersion()
    assert.ok(expected && typeof expected === "string", "manifest version must be a non-empty string")
    // Capture warns to detect accidental fallback (i.e. wrong default path).
    // If getVersion() fell back, a warn about "failed to read manifest" would
    // fire — that's a regression we want to catch here, not just rely on the
    // fallback constant accidentally matching the manifest value.
    const { result, captured } = captureWarn(() => getVersion())
    assert.equal(captured.length, 0, `happy path must NOT warn (would indicate fallback fired); got: ${JSON.stringify(captured)}`)
    assert.equal(result, expected)
  })

  it("R9.② accepts an explicit manifestPath for testing (and reads it)", () => {
    const expected = readManifestVersion()
    assert.equal(getVersion({ manifestPath: MANIFEST_PATH }), expected)
  })

  it("R9.③ falls back to a hardcoded version + warns when manifest is missing", () => {
    const missing = path.join(os.tmpdir(), "zcode-dcp-no-such-manifest-" + Date.now() + ".json")
    const { result, captured } = captureWarn(() => getVersion({ manifestPath: missing }))
    assert.equal(typeof result, "string", "fallback must be a string")
    assert.ok(result.length > 0, "fallback must be non-empty")
    assert.ok(captured.length > 0, "missing manifest must produce a console.warn")
    assert.ok(
      captured.some((m) => /manifest|version|fallback|read/i.test(m)),
      `warn should mention manifest/version/fallback/read; got: ${JSON.stringify(captured)}`,
    )
  })

  it("R9.④ falls back + warns when manifest JSON is malformed", () => {
    const tmp = path.join(os.tmpdir(), "zcode-dcp-malformed-" + Date.now() + ".json")
    fs.writeFileSync(tmp, "{ this is : not, valid json", "utf8")
    try {
      const { result, captured } = captureWarn(() => getVersion({ manifestPath: tmp }))
      assert.equal(typeof result, "string")
      assert.ok(result.length > 0)
      assert.ok(captured.length > 0, "malformed JSON must produce a console.warn")
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  })

  it("R9.⑤ fallback constant is in sync with the manifest (no silent drift)", () => {
    // Anti-drift guard: if the manifest is updated and version.mjs fallback
    // is forgotten, this test fails loudly. R9's whole point is "single
    // source" — the fallback exists only for emergencies (manifest
    // unreadable), so when one is bumped the other must be too.
    const expected = readManifestVersion()
    // We probe by deliberately pointing at a nonexistent path and checking
    // the returned value matches the manifest.
    const missing = path.join(os.tmpdir(), "zcode-dcp-drift-check-" + Date.now() + ".json")
    const { result } = captureWarn(() => getVersion({ manifestPath: missing }))
    assert.equal(result, expected, "fallback constant must mirror manifest.version")
  })
})

// =====================================================================
// resolveIdleTimeoutMs — R6 idleTimeoutMin 0 = forever
// =====================================================================
//
// SPEC R6: proxy.idleTimeoutMin=0 must disable the idle timer (forever).
// Previous behavior swallowed 0 (falsy → 30 min default) AND swallowed
// negative numbers (clamped to 1 min via Math.max(1, floor(min))).
// New behavior:
//   0     → Infinity (timer never fires — caller skips scheduling)
//   +N    → N * 60_000 (unchanged normal path)
//   < 0   → 1_800_000 + warn (fall back to 30 min, surface to operator)
//   NaN   → 1_800_000 + warn (fall back to 30 min)

describe("resolveIdleTimeoutMs — R6 idleTimeoutMin 0 = forever (D5)", () => {
  it("R6.① 0 → Infinity (forever — caller must skip scheduleIdleCheck)", () => {
    const { result, captured } = captureWarn(() => resolveIdleTimeoutMs(0))
    assert.equal(result, Infinity, "0 must return Infinity")
    assert.equal(captured.length, 0, "0 is a documented value; no warning expected")
  })

  it("R6.② positive N → N * 60_000 (30 → 1_800_000)", () => {
    const { result, captured } = captureWarn(() => resolveIdleTimeoutMs(30))
    assert.equal(result, 1_800_000)
    assert.equal(captured.length, 0, "valid positive value: no warning")
  })

  it("R6.③ negative N → 1_800_000 + warn (fall back to default)", () => {
    const { result, captured } = captureWarn(() => resolveIdleTimeoutMs(-5))
    assert.equal(result, 1_800_000, "negative must fall back to 30-min default")
    assert.ok(captured.length > 0, "negative must produce a console.warn")
    assert.ok(
      captured.some((m) => /idle/i.test(m)),
      `warn should mention idle; got: ${JSON.stringify(captured)}`,
    )
  })

  it("R6.④ NaN → 1_800_000 + warn (non-numeric input)", () => {
    const { result, captured } = captureWarn(() => resolveIdleTimeoutMs(NaN))
    assert.equal(result, 1_800_000)
    assert.ok(captured.length > 0, "NaN must produce a console.warn")
    assert.ok(
      captured.some((m) => /idle/i.test(m)),
      `warn should mention idle; got: ${JSON.stringify(captured)}`,
    )
  })
})