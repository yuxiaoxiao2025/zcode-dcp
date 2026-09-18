// SPDX-License-Identifier: AGPL-3.0-or-later
//
// version.mjs — single source of truth for the plugin version string.
//
// SPEC R9 / DESIGN D10: both proxy/daemon.mjs and mcp/mcp-server.mjs
// previously hardcoded their own "0.1.0", drifting from the manifest's
// "0.1.4". This module centralises the read: it parses
// .zcode-plugin/plugin.json and returns its `version` field.
//
// Resilience:
//   * If the manifest is missing or unreadable → returns FALLBACK_VERSION
//     and emits a console.warn (operators see the drift at startup).
//   * If the manifest is malformed JSON → same fallback + warn.
//   * If the manifest has no `version` field → same fallback + warn.
//
// FALLBACK_VERSION must be kept in sync with the manifest by hand — the
// R9.⑤ anti-drift test in test/version.test.mjs pins that invariant.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// IMPORTANT: keep in sync with .zcode-plugin/plugin.json (R9 anti-drift
// test). When you bump the manifest, bump this too.
const FALLBACK_VERSION = "0.1.5"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// proxy/version.mjs → ../.zcode-plugin/plugin.json
// (proxy/ is one level under zcode-dcp/, so ONE ".." gets us to zcode-dcp/.)
const DEFAULT_MANIFEST_PATH = path.resolve(
  __dirname,
  "..",
  ".zcode-plugin",
  "plugin.json",
)

/**
 * Return the plugin version string. Reads `version` from the manifest at
 * `.zcode-plugin/plugin.json`. On any failure (missing file, malformed
 * JSON, missing version field) returns `FALLBACK_VERSION` and emits a
 * `console.warn` describing the failure.
 *
 * @param {{ manifestPath?: string }} [opts] — for tests: override the
 *   manifest path. Production callers leave this empty.
 * @returns {string} the version (never empty)
 */
export function getVersion(opts = {}) {
  const manifestPath = opts.manifestPath || DEFAULT_MANIFEST_PATH
  let raw
  try {
    raw = fs.readFileSync(manifestPath, "utf8")
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[version] failed to read manifest at ${manifestPath}: ${err && err.message}; ` +
      `falling back to ${FALLBACK_VERSION}`,
    )
    return FALLBACK_VERSION
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[version] manifest at ${manifestPath} is malformed JSON: ${err && err.message}; ` +
      `falling back to ${FALLBACK_VERSION}`,
    )
    return FALLBACK_VERSION
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.version !== "string" || parsed.version.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[version] manifest at ${manifestPath} has no usable version field; ` +
      `falling back to ${FALLBACK_VERSION}`,
    )
    return FALLBACK_VERSION
  }
  return parsed.version
}