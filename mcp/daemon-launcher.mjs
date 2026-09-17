// SPDX-License-Identifier: AGPL-3.0-or-later
//
// daemon-launcher.mjs — Standalone launcher that imports proxy/daemon.mjs,
// resolves its config (DCP_RESOLVED_CONFIG_PATH preferred; DCP_CONFIG_PATH /
// DCP_DATA_DIR fallback), and calls startDaemon(). Used by both the MCP
// server's ensureDaemon path and the SessionStart hook so that "spawn the
// local daemon" has exactly one implementation (R11 avoids the v1 port's
// duplicate spawn path that was a silent no-op because daemon.mjs had no
// top-level self-start entry point).
//
// Config resolution order (first match wins):
//   1. DCP_RESOLVED_CONFIG — inline JSON string of the FULLY-RESOLVED config
//      (the parent process already walked the two-level merge; this avoids
//      the cwd-mismatch trap where MCP and daemon resolve different
//      workspace configs and end up on different ports — see R11 I-1
//      regression).
//   2. DCP_CONFIG_PATH — explicit path to a JSON/JSONC config file.
//   3. loadConfig(process.cwd(), dataDir) — the standard two-level layout.
//
// Env contract (all required unless noted):
//   DCP_DATA_DIR      — plugin data directory (admin token + light-state root)
//   DCP_PORT          — (optional) override config.proxy.port BEFORE passing
//                       to startDaemon, so callers can pin a test port
//                       without touching the user's dcp.jsonc.

import fs from "node:fs"
import { startDaemon } from "../proxy/daemon.mjs"
import { DEFAULT_CONFIG, mergeConfig, parseJsonc, loadConfig } from "../proxy/config.mjs"

async function main() {
  const dataDir = process.env.DCP_DATA_DIR
  if (!dataDir) {
    process.stderr.write("[daemon-launcher] DCP_DATA_DIR is required" + String.fromCharCode(10))
    process.exit(2)
  }
  fs.mkdirSync(dataDir, { recursive: true })

  let cfg = DEFAULT_CONFIG
  const inline = process.env.DCP_RESOLVED_CONFIG
  if (inline) {
    try {
      const parsed = JSON.parse(inline)
      cfg = mergeConfig([DEFAULT_CONFIG, parsed])
    } catch (err) {
      process.stderr.write("[daemon-launcher] DCP_RESOLVED_CONFIG parse failed: " + (err && err.message) + String.fromCharCode(10))
      process.exit(3)
    }
  } else if (process.env.DCP_CONFIG_PATH && fs.existsSync(process.env.DCP_CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(process.env.DCP_CONFIG_PATH, "utf8")
      cfg = mergeConfig([DEFAULT_CONFIG, parseJsonc(raw)])
    } catch (err) {
      process.stderr.write("[daemon-launcher] DCP_CONFIG_PATH parse failed: " + (err && err.message) + String.fromCharCode(10))
      process.exit(3)
    }
  } else {
    try {
      const r = loadConfig(process.cwd(), dataDir)
      cfg = r.config
    } catch (err) {
      process.stderr.write("[daemon-launcher] loadConfig failed: " + (err && err.message) + String.fromCharCode(10))
      process.exit(3)
    }
  }

  // Optional port override (test-only path). Production never sets this;
  // production callers pass DCP_RESOLVED_CONFIG with the merged port intact.
  if (process.env.DCP_PORT) {
    const p = Number(process.env.DCP_PORT)
    if (Number.isFinite(p) && p > 0) {
      cfg = { ...cfg, proxy: { ...(cfg.proxy || {}), port: p } }
    }
  }

  try {
    await startDaemon({ config: cfg, dataDir })
  } catch (err) {
    process.stderr.write("[daemon-launcher] startDaemon failed: " + (err && err.message) + String.fromCharCode(10))
    if (err && err.stack) process.stderr.write(err.stack + String.fromCharCode(10))
    process.exit(4)
  }
}

main()
