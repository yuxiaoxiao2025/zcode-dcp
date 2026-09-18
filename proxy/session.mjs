// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/state/persistence.ts (light-state shape & pruning semantics)
//   Copyright (c) opencode-dcp authors. Licensed under AGPL-3.0-or-later.
//
// Behavior-faithful port — see PLAN.md Task 9.
//
// ZCode adaptations (vs. upstream lib/state/persistence.ts):
//   * This module deliberately re-designs the persistence layer to fit the
//     ZCode proxy architecture (DCP couples state to a SessionState class with
//     a live `state` object mutated in place; the proxy here is stateless across
//     requests, so each call site (pipeline / nudges / mcp tools) passes the
//     loaded state explicitly).
//   * The persistence shape itself (anchors, fetchCount, sweepToolCallIds,
//     decompressBlockIds, manualMode) is faithfully ported from DCP so that
//     downstream pipeline modules (task-8 nudges, task-7 compress) can read
//     identical field names without translation.
//   * markActive is a ZCode-specific addition: the upstream DCP reads recent
//     session metadata from the host app's session store. The proxy has no
//     such source of truth, so we keep our own minimal `{fp -> lastSeenTs}`
//     table for admin endpoints to enumerate "recently active sessions".

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

// ---------- Pure utilities (no I/O) ----------

const SYSTEM_HEAD_BYTES = 2048 // 2 KiB slice from the start of the system surface

// M-6: A session fingerprint is always 16 lowercase hex chars (see
// sessionFingerprint below). We reject any other shape at the I/O boundary so
// that admin endpoints cannot smuggle path-traversal bytes (`..`, `/`,
// absolute paths) into filenames via a malformed fp argument.
const FP_REGEX = /^[0-9a-f]{16}$/

/**
 * Return `fp` unchanged if it matches the canonical 16-hex fingerprint shape,
 * otherwise `null`. Centralised so load/save/markActive stay in sync — if the
 * validation rule ever loosens (e.g. allow fp prefixes for sub-sessions) the
 * change happens here.
 */
function validFp(fp) {
  return typeof fp === "string" && FP_REGEX.test(fp) ? fp : null
}

/**
 * Coerce `body.system` into a stable string.
 *
 * Per Anthropic protocol, `system` may be:
 *   * a string
 *   * an array of `{type:"text", text}` blocks (and rarely images)
 *
 * We extract the text-shaped content and concatenate it. Anything we cannot
 * safely read becomes the empty string so the fingerprint stays deterministic
 * regardless of the call site's choice of system shape.
 */
function extractSystemText(body) {
  const sys = body && body.system
  if (sys == null) return ""
  if (typeof sys === "string") return sys
  if (Array.isArray(sys)) {
    let out = ""
    for (const block of sys) {
      if (!block || typeof block !== "object") continue
      if (block.type === "text" && typeof block.text === "string") {
        out += block.text
      }
    }
    return out
  }
  return ""
}

/**
 * Coerce `body.messages` into a stable JSON-ish slice.
 *
 * We take only the first three messages (PLAN Task 9: "messages[0..2]") so
 * that the fingerprint is stable across tail growth — a long conversation
 * doesn't churn its fingerprint as new turns are added. Anything malformed
 * (missing/non-array) becomes the empty array.
 */
function extractMessageSlice(body) {
  const msgs = body && body.messages
  if (!Array.isArray(msgs)) return []
  return msgs.slice(0, 3)
}

/**
 * Compute a deterministic 16-hex fingerprint for an Anthropic-protocol request
 * body. The fingerprint is the first 16 hex chars of sha256(system[..2048] ||
 * JSON.stringify(messages[0..2])).
 *
 * Behaviour-faithful to DCP's notion of a "session id" used to look up
 * per-session state — here we use the first 3 messages (instead of all) to
 * keep the fingerprint stable as the conversation grows; this matches PLAN's
 * explicit requirement that "messages 尾部增长 fp 不变".
 *
 * Defensive: missing/non-string `system` or missing/non-array `messages`
 * never throw — they degrade to empty strings/arrays.
 *
 * @param {object} body  Anthropic /v1/messages request body
 * @returns {string}     16 lowercase hex chars
 */
export function sessionFingerprint(body) {
  const sysText = extractSystemText(body).slice(0, SYSTEM_HEAD_BYTES)
  const msgSlice = extractMessageSlice(body)
  const payload = sysText + JSON.stringify(msgSlice)
  const hex = crypto.createHash("sha256").update(payload, "utf8").digest("hex")
  return hex.slice(0, 16)
}

// ---------- Light-state persistence (DCP lib/state/persistence.ts shape) ----------

const ACTIVE_TTL_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Build the default light-state object. Faithful to DCP's session state shape
 * (anchors split into context/turn/iter, plus the bookkeeping fields), with
 * ZCode-specific defaults (manualMode starts false).
 */
export function defaultLightState() {
  return {
    anchors: { context: [], turn: [], iter: [] },
    fetchCount: 0,
    sweepToolCallIds: [],
    decompressBlockIds: [],
    manualMode: false,
    // R3 / DESIGN D2: null = first-seen baseline (daemon will write the
    // observed maxRunId without incrementing compressRuns). On subsequent
    // requests the daemon reads this and computes
    //   compressRunsDelta(currentMaxRunId, maxRunIdSeen, !!compressError)
    // — see stats.mjs:compressRunsDelta for the contract.
    maxRunIdSeen: null,
    // Gate 1.5 B2: one-shot sweep directive written by the daemon's
    // /dcp-admin/state/sweep action and consumed by the pipeline on the
    // NEXT inbound request. Null = no pending directive. ZCode-specific
    // adaptation — DCP applies sweep immediately in the handler (state is
    // mutable across calls), but the proxy is stateless across requests, so
    // the directive is queued and applied when messages are next visible.
    // Shape: { mode: "since-user" | "last-n", n: number | null, requestedAt: number }.
    sweepDirective: null,
    // Last applied sweep accounting (filled by the pipeline after consuming
    // a directive; null otherwise). The MCP server reads this to surface
    // "Last sweep: applied N, M protected skipped" on the next dcp_sweep
    // call. Shape: { applied: number, skippedProtected: number }.
    sweepLastResult: null,
    // Gate 1.5 B3: per-fp summary of active compress blocks, written by the
    // pipeline every request so the MCP server can render a "list available
    // blocks" view via /dcp-admin/state/decompress (no-arg). The daemon does
    // NOT persist these — they're recomputed on each request, so a stale
    // summary cannot survive a process restart. Shape:
    //   [{ blockId: number, topic: string, approxTokens: number }]
    // Consumers: daemon.mjs (no-arg list response), MCP server (render text).
    activeBlockSummaries: [],
  }
}

/**
 * Sanitize a loaded state object — anything missing is filled in with the
 * default; any field of the wrong type is reset to the default for that slot.
 *
 * The pipeline only ever reads specific keys, so this normalization is a
 * safety net rather than a transformation.
 */
function normalizeLightState(raw) {
  const def = defaultLightState()
  if (!raw || typeof raw !== "object") return def
  const anchorsIn = raw.anchors && typeof raw.anchors === "object" ? raw.anchors : {}
  return {
    anchors: {
      context: Array.isArray(anchorsIn.context) ? anchorsIn.context.slice() : def.anchors.context.slice(),
      turn: Array.isArray(anchorsIn.turn) ? anchorsIn.turn.slice() : def.anchors.turn.slice(),
      iter: Array.isArray(anchorsIn.iter) ? anchorsIn.iter.slice() : def.anchors.iter.slice(),
    },
    fetchCount: Number.isFinite(raw.fetchCount) ? raw.fetchCount : def.fetchCount,
    sweepToolCallIds: Array.isArray(raw.sweepToolCallIds) ? raw.sweepToolCallIds.slice() : def.sweepToolCallIds.slice(),
    decompressBlockIds: Array.isArray(raw.decompressBlockIds) ? raw.decompressBlockIds.slice() : def.decompressBlockIds.slice(),
    manualMode: typeof raw.manualMode === "boolean" ? raw.manualMode : def.manualMode,
    // R3 / DESIGN D2: maxRunIdSeen is the baseline for compressRuns delta
    // counting. null = first-seen (no prior state); a finite positive
    // integer = last observed maxRunId. sanitize just enforces type
    // coherence; the daemon writes this via the existing
    // lightStateUpdates → saveLightState channel.
    maxRunIdSeen: Number.isFinite(raw.maxRunIdSeen) ? raw.maxRunIdSeen : null,
    // Gate 1.5 B2: backwards-compatible. Legacy light-state files lack
    // sweepDirective / sweepLastResult entirely; default to null.
    sweepDirective: normalizeSweepDirective(raw.sweepDirective),
    sweepLastResult: normalizeSweepLastResult(raw.sweepLastResult),
    // Gate 1.5 B3: backwards-compatible. Legacy files lack
    // activeBlockSummaries entirely; coerce anything that is not a plain
    // array of well-formed entries back to []. The pipeline RE-WRITES this
    // field on every request, so a bad on-disk value is self-healing.
    activeBlockSummaries: normalizeActiveBlockSummaries(raw.activeBlockSummaries),
  }
}

/**
 * Sanitize an activeBlockSummaries value. Shape contract:
 *   [{ blockId: number > 0, topic: string, approxTokens: number >= 0 }, ...]
 * Anything that fails the type check (non-array, missing keys, wrong types)
 * returns []. Defensive against on-disk corruption — the pipeline will
 * overwrite on the next request anyway.
 */
function normalizeActiveBlockSummaries(v) {
  if (!Array.isArray(v)) return []
  const out2 = []
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue
    const blockId = Number(entry.blockId)
    const topic = typeof entry.topic === "string" ? entry.topic : ""
    const approxTokens = Number(entry.approxTokens)
    if (!Number.isInteger(blockId) || blockId <= 0) continue
    if (!Number.isFinite(approxTokens) || approxTokens < 0) continue
    out2.push({ blockId, topic, approxTokens })
  }
  return out2
}

/**
 * Sanitize a sweepDirective value. Shape contract:
 *   { mode: "since-user" | "last-n", n: number | null, requestedAt: number }
 * Anything that fails the type check returns null (treated as "no directive"
 * by the pipeline). Defensive against malformed on-disk values from a future
 * schema migration that the running daemon cannot parse.
 */
function normalizeSweepDirective(v) {
  if (!v || typeof v !== "object") return null
  const mode = v.mode === "since-user" || v.mode === "last-n" ? v.mode : null
  if (!mode) return null
  const n = v.n === null || Number.isFinite(v.n) ? v.n : null
  const requestedAt = Number.isFinite(v.requestedAt) ? v.requestedAt : 0
  return { mode, n, requestedAt }
}

/**
 * Sanitize a sweepLastResult value. Shape contract:
 *   { applied: number, skippedProtected: number }
 * Anything that fails the type check returns null.
 */
function normalizeSweepLastResult(v) {
  if (!v || typeof v !== "object") return null
  const applied = Number.isFinite(v.applied) ? v.applied : 0
  const skippedProtected = Number.isFinite(v.skippedProtected) ? v.skippedProtected : 0
  return { applied, skippedProtected }
}

function lightStatePath(dataDir, fp) {
  return path.join(dataDir, "light-state", `${fp}.json`)
}

// M-4: each corrupt light-state file is renamed aside as `{file}.corrupt-{ts}`
// so the next save produces a clean copy. Without a cap these would accumulate
// unboundedly if some upstream bug kept producing corrupt JSON — cap at 10,
// dropping the oldest (sorted by their embedded timestamp suffix).
const CORRUPT_FILE_CAP = 10

function listCorruptFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      // Match any file with the `.corrupt-{ts}` suffix we produce when
      // quarantining malformed JSON. The matched name is the sidecar basename.
      .filter((n) => /\.json\.corrupt-\d+$/.test(n))
      .map((n) => path.join(dir, n))
  } catch {
    return []
  }
}

function quarantineCorruptFile(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
  } catch {
    /* ignore */
  }
  // Cap: if we now have more than CORRUPT_FILE_CAP, drop the oldest.
  const dir = path.dirname(file)
  const corrupt = listCorruptFiles(dir)
  if (corrupt.length > CORRUPT_FILE_CAP) {
    // Sort by the timestamp suffix (lexicographic == chronological for the
    // exact `corrupt-{ms}` shape we produce). Drop the oldest excess.
    corrupt.sort()
    const excess = corrupt.length - CORRUPT_FILE_CAP
    for (let i = 0; i < excess; i++) {
      try {
        fs.unlinkSync(corrupt[i])
      } catch {
        /* ignore */
      }
    }
  }
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Load light state for the given fingerprint. Returns the default state on
 * any failure (missing file, corrupt JSON, schema mismatch) — the proxy must
 * not crash because a state file is malformed; the pipeline self-heals on the
 * next snapshot.
 *
 * @param {string} dataDir
 * @param {string} fp
 * @returns {object}
 */
export function loadLightState(dataDir, fp) {
  if (!dataDir || !validFp(fp)) return defaultLightState()
  const file = lightStatePath(dataDir, fp)
  let raw
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (err) {
    if (err && err.code === "ENOENT") return defaultLightState()
    return defaultLightState()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Self-heal: rename corrupt file aside so the next save produces a clean one.
    quarantineCorruptFile(file)
    return defaultLightState()
  }
  return normalizeLightState(parsed)
}

/**
 * Atomically persist light state: write to a sibling `.tmp` file then rename
 * to the final name. This is the standard "write-then-rename" pattern that
 * guarantees a reader never sees a half-written file even if the process
 * is killed mid-write.
 *
 * @param {string} dataDir
 * @param {string} fp
 * @param {object} state
 */
export function saveLightState(dataDir, fp, state) {
  if (!dataDir || !validFp(fp)) return
  const dir = path.join(dataDir, "light-state")
  ensureDirSync(dir)
  const finalPath = lightStatePath(dataDir, fp)
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`
  const payload = JSON.stringify(normalizeLightState(state))
  fs.writeFileSync(tmpPath, payload, "utf8")
  fs.renameSync(tmpPath, finalPath)
}

// ---------- Active-session table (ZCode-specific) ----------

function activePath(dataDir) {
  return path.join(dataDir, "active-sessions.json")
}

function loadActiveTable(dataDir) {
  try {
    const raw = fs.readFileSync(activePath(dataDir), "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed
    return {}
  } catch (err) {
    if (err && err.code === "ENOENT") return {}
    return {}
  }
}

function saveActiveTable(dataDir, table) {
  const dir = dataDir
  ensureDirSync(dir)
  const finalPath = activePath(dataDir)
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmpPath, JSON.stringify(table), "utf8")
  fs.renameSync(tmpPath, finalPath)
}

/**
 * Record `fp` as recently active in `dataDir/active-sessions.json`. Entries
 * older than 30 minutes are pruned on every call. The table shape is the
 * minimal `{fp: {lastSeenTs}}` needed by admin endpoints (dcp-admin/identify)
 * to enumerate recent sessions.
 *
 * @param {string} dataDir
 * @param {string} fp
 */
export function markActive(dataDir, fp) {
  if (!dataDir || !validFp(fp)) return
  const table = loadActiveTable(dataDir)
  const now = Date.now()
  // Prune stale entries.
  for (const key of Object.keys(table)) {
    const entry = table[key]
    if (!entry || typeof entry !== "object" || typeof entry.lastSeenTs !== "number") {
      delete table[key]
      continue
    }
    if (now - entry.lastSeenTs > ACTIVE_TTL_MS) delete table[key]
  }
  table[fp] = { lastSeenTs: now }
  saveActiveTable(dataDir, table)
}
