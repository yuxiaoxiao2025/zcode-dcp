#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// hooks/session-start.mjs — ZCode SessionStart hook for the zcode-dcp plugin.
//
// On session start (startup | clear | compact), this hook ensures the local
// DCP daemon is up so the user's first /v1/messages call can be served.
// The actual long-running daemon supervisor lives in mcp/mcp-server.mjs; this
// hook is the early-boot "kick the daemon into existence" — it spawns the
// daemon via the SHARED launcher (mcp/daemon-launcher.mjs) and bounded-waits
// (R10/D6) up to COLD_START_WAIT_MS for /dcp-admin/health to respond 200.
// If health flips healthy mid-wait, emit the DCP briefing via
// hookSpecificOutput.additionalContext; on timeout emit `{}`.
//
// C-1 fix (task-13 review): the v1 port spawned `node proxy/daemon.mjs`
// directly. `daemon.mjs` only exports `startDaemon` and has no top-level
// self-start entry point — so the spawn exited immediately with code 0 and
// nothing was listening. We now spawn the launcher which imports daemon.mjs
// and calls startDaemon for us. R11 double-safety restored.
//
// I-1 companion: we pass the resolved port via DCP_PORT so the launcher
// binds to the same port we probed above. Without this, the launcher
// would re-resolve from its own cwd (= PLUGIN_ROOT) and pick DEFAULT 8367,
// leading to a permanent port mismatch with this hook's discovered port.
//
// M-4 fix: the previous fallback `path.join(__dirname, "..")` was wrong on
// win32 because `__dirname` from `new URL(import.meta.url).pathname` yields
// `/E:/...` (leading slash). Use `fileURLToPath` instead.
//
// Like mcp-server.mjs this is original ZCode glue code; the brief for the
// hooks file is that "进程启动 node 一次即退，不常驻" — one-shot startup,
// not a long-running supervisor.
//
// Output: hookSpecificOutput.additionalContext JSON to stdout when healthy
// (already-healthy branch or cold-start mid-wait flip — R10); empty `{}` on
// cold-start timeout. ZCode's SessionStart contract — empty `{}` is a no-op.

import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = process.env.DCP_PLUGIN_ROOT || path.resolve(__dirname, "..")
const PLUGIN_DATA = process.env.DCP_PLUGIN_DATA || path.join(PLUGIN_ROOT, "data")
const DAEMON_LAUNCHER_JS = path.join(PLUGIN_ROOT, "mcp", "daemon-launcher.mjs")
const DEFAULT_PORT = 8367
// R10/D6: cold-start bounded-wait for clipboard. Hook is a synchronous
// contract (stdout + exit), so waiting is allowed but must be bounded.
// Wait up to 3s for the daemon to come up; probe every 250ms; if health
// flips to 200 mid-wait, emit the briefing; otherwise emit `{}`.
const COLD_START_WAIT_MS = 3000
const COLD_START_PROBE_INTERVAL_MS = 250

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: "/dcp-admin/health", method: "GET", timeout: timeoutMs }, (res) => {
      res.on("data", () => { /* drain */ })
      res.on("end", () => resolve(res.statusCode === 200))
      res.on("error", () => resolve(false))
    })
    req.on("error", () => resolve(false))
    req.on("timeout", () => { try { req.destroy() } catch {} ; resolve(false) })
    req.end()
  })
}

async function discoverConfiguredPort() {
  // Resolve the daemon's configured port by walking the same config layers
  // as mcp-server.mjs (user-level ~/.zcode/dcp/dcp.jsonc → project-level
  // <cwd>/.zcode/dcp.jsonc). We don't need a full config — only `proxy.port`.
  const tryParse = (text) => {
    try {
      // Cheap JSON-ish port extraction: regex match on "proxy": { ... "port": N }
      const m = /"proxy"\s*:\s*\{[\s\S]*?"port"\s*:\s*(\d+)/.exec(text)
      return m ? Number(m[1]) : null
    } catch { return null }
  }

  const cwd = process.cwd()
  // Walk up from cwd to find .zcode/dcp.jsonc.
  let cur = cwd
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(cur, ".zcode", "dcp.jsonc")
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf8")
        const port = tryParse(raw)
        if (port) return port
      } catch { /* ignore */ }
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  // Fall back to user-level ~/.zcode/dcp/dcp.jsonc.
  try {
    const home = process.env.USERPROFILE || process.env.HOME || ""
    if (home) {
      const file = path.join(home, ".zcode", "dcp", "dcp.jsonc")
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf8")
        const port = tryParse(raw)
        if (port) return port
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_PORT
}

// FB-3: inject a compact DCP briefing so the model knows DCP is active from
// the first turn (skills are passive — this is the active channel). Kept to
// ~90 tokens: we are a token-saving plugin, the briefing must not bloat.
const DCP_BRIEFING = [
  "DCP active: this session routes through the local pruning proxy.",
  "Pruning is fully automatic — no action needed: duplicate tool calls (same tool+args) keep only the newest output, older ones become \"[Output removed to save context...]\" placeholders; errored-call inputs are purged after 4 turns.",
  "If you see a placeholder, treat it as \"content expired — the fresh version is elsewhere/later\"; re-read the source if needed.",
  "Optional: when a <dcp-system-reminder> compress nudge appears AND a conversation section is truly finished, call the compress tool with a thorough technical summary (use <dcp-message-id> tags as boundaries). Never compress in-progress work.",
  "DCP runs silently: never narrate or repeat pruning/compress actions to the user unless they ask.",
  "User commands: /dcp-stats (real sent/saved tokens + per-strategy hits), /dcp-context, /dcp-compress, /dcp-sweep, /dcp-manual on|off, /dcp-decompress, /dcp-recompress.",
].join("\n")

function emit(output) {
  // ZCode SessionStart contract: hookSpecificOutput.additionalContext is
  // injected into the conversation (empty {} = no-op).
  process.stdout.write(JSON.stringify(output))
  process.exit(0)
}

async function main() {
  const port = await discoverConfiguredPort()
  const briefing = {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: DCP_BRIEFING },
  }
  // Already healthy? Emit briefing and done.
  if (await probe("127.0.0.1", port, 600)) {
    emit(briefing)
    return
  }
  // C-1 fix: spawn the SHARED launcher (mcp/daemon-launcher.mjs), which
  // imports proxy/daemon.mjs and calls startDaemon for us. The previous
  // version spawned proxy/daemon.mjs directly, which has no top-level
  // self-start entry point — exit 0 with nothing listening, then the
  // user's first /v1/messages call would block until idleTimeoutMin.
  //
  // I-1 companion: pass the resolved port via DCP_PORT so the launcher
  // binds to the same port we probed above.
  fs.mkdirSync(PLUGIN_DATA, { recursive: true })
  const child = spawn(process.execPath, [DAEMON_LAUNCHER_JS], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      DCP_PLUGIN_ROOT: PLUGIN_ROOT,
      DCP_PLUGIN_DATA: PLUGIN_DATA,
      DCP_DATA_DIR: PLUGIN_DATA,
      DCP_PORT: String(port),
    },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  })
  child.on("error", (err) => {
    process.stderr.write(`[session-start] daemon-launcher spawn error: ${err && err.message}\n`)
  })
  try { child.unref() } catch { /* ignore */ }

  // R10/D6: bounded-wait for the daemon. If health flips to 200 during the
  // 3s window, emit the briefing (same shape as the already-healthy branch).
  // Otherwise emit `{}` per ZCode hook contract. v0.1.4 was: unconditional
  // `{}` after the loop — health probe result was ignored.
  //
  // Tightness (R10 review Minor-2): re-check deadline + cap probe timeout to
  // the remaining budget before each probe, so the worst-case tail can't
  // overshoot the cap by a full probe-timeout (was: up to ~3.5s; now: ~3s).
  const deadline = Date.now() + COLD_START_WAIT_MS
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const probeTimeout = Math.min(500, remaining)
    if (probeTimeout <= 0) break
    if (await probe("127.0.0.1", port, probeTimeout)) {
      emit(briefing)
      return
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, COLD_START_PROBE_INTERVAL_MS))
  }

  // Timeout — per ZCode hook contract: emit empty JSON to stdout.
  process.stdout.write("{}")
}

main().catch(() => {
  // Hook must NEVER block startup. Emit empty JSON on any failure and exit 0.
  try { process.stdout.write("{}") } catch { /* ignore */ }
  process.exit(0)
})
