// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/logger.ts (log file layout) + lib/state/stats.ts (counters shape)
//   Copyright (c) opencode-dcp authors. Licensed under AGPL-3.0-or-later.
//
// Behaviour-faithful port — see PLAN.md Task 9.
//
// ZCode adaptations:
//   * Stats class: in-memory counters keyed by `fp`; snapshot() persists a
//     per-session JSON file and atomically merges into an all-time aggregate.
//     Upstream DCP uses a single in-memory aggregate mutated by hooks; here
//     we have a stateless proxy so the counters live in the Stats instance
//     constructed per-request and roll up via snapshot().
//   * createDebugLogger: header sanitization is a ZCode addition that does
//     NOT exist in upstream DCP's lib/logger.ts (verified by reviewer reading
//     the upstream source). It is required by SPEC R10 — the proxy must never
//     persist upstream API keys, regardless of how the caller passes them
//     (string log message, object body, or nested config). The very first
//     sanitize test in session.test.mjs asserts that `Authorization`,
//     `x-api-key`, `api-key` headers and `apiKey` / `api_key` field values
//     are all replaced with `***` in the persisted payload, and a follow-up
//     test (I-1) asserts the same redaction applies when log() is called
//     with an object message (e.g. `lg.log("debug", config)`).

import fs from "node:fs"
import path from "node:path"

// ---------- Stats ----------

/**
 * Per-session counter fields, mirrored to disk on snapshot().
 *
 * Field semantics (PLAN Task 9):
 *   sentTokens     — tokens sent upstream this request (post-prune, including
 *                    compress block replacements — i.e. real billable amount)
 *   savedTokens    — tokens saved vs. the pre-transform baseline (i.e. the
 *                    sum of dedup/purge/compress savings)
 *   byStrategy     — split of savedTokens by strategy:
 *                      dedup     — duplicate tool calls collapsed
 *                      purge     — error tool_use inputs / outputs pruned
 *                      compress  — replaced by compress block summary
 *   compressRuns   — count of compress tool_use invocations observed
 *   requests       — request counter (1 per pipeline invocation)
 */
function freshPerSessionCounters() {
  return {
    sentTokens: 0,
    savedTokens: 0,
    byStrategy: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
    compressRuns: 0,
    requests: 0,
  }
}

function freshAllTimeCounters() {
  return {
    sentTokens: 0,
    savedTokens: 0,
    byStrategy: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
    compressRuns: 0,
    requests: 0,
  }
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function atomicWriteJson(finalPath, payload) {
  ensureDirSync(path.dirname(finalPath))
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf8")
  fs.renameSync(tmpPath, finalPath)
}

/**
 * Per-session statistics accumulator.
 *
 * Construct one instance per request lifecycle, feed it via `incr(field, n)`,
 * then call `snapshot()` once at the end of the pipeline. `snapshot()` writes
 * the current counters to disk and folds them into `dataDir/stats-all.json`
 * (all-time aggregate).
 */
export class Stats {
  /**
   * @param {{dataDir: string, fp: string}} opts
   */
  constructor({ dataDir, fp }) {
    if (!dataDir || !fp) throw new Error("Stats requires {dataDir, fp}")
    this.dataDir = dataDir
    this.fp = fp
    this.counters = freshPerSessionCounters()
  }

  /**
   * Increment a counter field by `n` (default 1).
   *
   * Supported `field` paths:
   *   * "requests", "sentTokens", "savedTokens", "compressRuns"
   *   * "byStrategy.dedup", "byStrategy.purge", "byStrategy.compress"
   *
   * Unknown fields are ignored (defensive — never crash the pipeline on a
   * typo in a caller).
   */
  incr(field, n = 1) {
    if (typeof field !== "string") return
    const value = Number.isFinite(n) ? n : 0
    if (field.startsWith("byStrategy.")) {
      const sub = field.slice("byStrategy.".length)
      if (!Object.prototype.hasOwnProperty.call(this.counters.byStrategy, sub)) return
      this.counters.byStrategy[sub] += value
      return
    }
    if (!Object.prototype.hasOwnProperty.call(this.counters, field)) return
    this.counters[field] += value
  }

  /**
   * Persist the current counters and fold them into the all-time aggregate.
   * Returns a deep copy of the snapshot (so subsequent `incr` calls do not
   * mutate the returned value).
   *
   * Contract — task-12 admin endpoints consume these files as follows:
   *   * `dataDir/stats/{fp}.json` holds ONLY the most recent snapshot's
   *     counters for the session — i.e. the cumulative values from the
   *     single most recent pipeline invocation. It is NOT a running
   *     per-session total across the session's lifetime. Each request
   *     constructs a fresh Stats instance, so a per-session aggregate
   *     across requests is not recoverable from this file alone.
   *   * `dataDir/stats-all.json` is the running all-time aggregate across
   *     EVERY snapshot ever persisted (all sessions, all requests). It
   *     monotonically grows; it is never decremented or pruned here.
   *
   * Side effects:
   *   * writes `dataDir/stats/{fp}.json`
   *   * reads + rewrites `dataDir/stats-all.json` (missing file is treated
   *     as zero baseline — first snapshot creates it).
   */
  snapshot() {
    const snap = {
      sentTokens: this.counters.sentTokens,
      savedTokens: this.counters.savedTokens,
      byStrategy: {
        dedup: this.counters.byStrategy.dedup,
        purge: this.counters.byStrategy.purge,
        compress: this.counters.byStrategy.compress,
      },
      compressRuns: this.counters.compressRuns,
      requests: this.counters.requests,
    }

    // 1. Per-session file.
    const perSessionPath = path.join(this.dataDir, "stats", `${this.fp}.json`)
    atomicWriteJson(perSessionPath, snap)

    // 2. All-time aggregate.
    const allTimePath = path.join(this.dataDir, "stats-all.json")
    const base = readAllTimeAggregate(allTimePath)
    const merged = mergeAggregate(base, snap)
    atomicWriteJson(allTimePath, merged)

    return snap
  }
}

function readAllTimeAggregate(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return freshAllTimeCounters()
    return normalizeAggregate(parsed)
  } catch (err) {
    if (err && err.code === "ENOENT") return freshAllTimeCounters()
    return freshAllTimeCounters()
  }
}

function normalizeAggregate(raw) {
  const def = freshAllTimeCounters()
  const bs = raw.byStrategy && typeof raw.byStrategy === "object" ? raw.byStrategy : {}
  return {
    sentTokens: Number.isFinite(raw.sentTokens) ? raw.sentTokens : def.sentTokens,
    savedTokens: Number.isFinite(raw.savedTokens) ? raw.savedTokens : def.savedTokens,
    byStrategy: {
      dedup: Number.isFinite(bs.dedup) ? bs.dedup : def.byStrategy.dedup,
      purge: Number.isFinite(bs.purge) ? bs.purge : def.byStrategy.purge,
      sweep: Number.isFinite(bs.sweep) ? bs.sweep : def.byStrategy.sweep,
      compress: Number.isFinite(bs.compress) ? bs.compress : def.byStrategy.compress,
    },
    compressRuns: Number.isFinite(raw.compressRuns) ? raw.compressRuns : def.compressRuns,
    requests: Number.isFinite(raw.requests) ? raw.requests : def.requests,
  }
}

function mergeAggregate(base, snap) {
  return {
    sentTokens: base.sentTokens + snap.sentTokens,
    savedTokens: base.savedTokens + snap.savedTokens,
    byStrategy: {
      dedup: base.byStrategy.dedup + snap.byStrategy.dedup,
      purge: base.byStrategy.purge + snap.byStrategy.purge,
      sweep: base.byStrategy.sweep + snap.byStrategy.sweep,
      compress: base.byStrategy.compress + snap.byStrategy.compress,
    },
    compressRuns: base.compressRuns + snap.compressRuns,
    requests: base.requests + snap.requests,
  }
}

// ---------- createDebugLogger ----------

/**
 * Header names (case-insensitive) whose VALUES must be redacted to "***"
 * before any debug artifact is persisted. Match the full set of surfaces
 * where the upstream API key may ride:
 *
 *   * `authorization` (Anthropic: `Bearer ...`)
 *   * `x-api-key`     (Anthropic explicit header)
 *   * `api-key`       (OpenAI-style fallback / some proxies)
 *
 * Header NAME is preserved in the persisted record (so the operator can see
 * that auth headers were present and redacted); only the VALUE is masked.
 */
const SECRET_HEADER_NAMES = new Set(["authorization", "x-api-key", "api-key"])

/**
 * Field names (case-insensitive) whose VALUES are masked anywhere they
 * appear in a body object. We only redact the values, not the keys.
 */
const SECRET_FIELD_NAMES = new Set(["apikey", "api_key"])

const REDACTED = "***"

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

/**
 * Deep-clone `value` while redacting secret headers and fields. Headers are
 * identified by case-insensitive name match against `SECRET_HEADER_NAMES`;
 * fields by case-insensitive match against `SECRET_FIELD_NAMES`.
 *
 * Cycle protection: a `WeakSet` of seen objects is maintained per top-level
 * call so a circular structure does not infinite-loop (the second visit
 * yields the already-redacted object as-is).
 */
function redactValue(value, seen) {
  if (value == null) return value
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    return value.map((v) => redactValue(v, seen))
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    const out = {}
    for (const k of Object.keys(value)) {
      const lower = k.toLowerCase()
      if (SECRET_HEADER_NAMES.has(lower) || SECRET_FIELD_NAMES.has(lower)) {
        out[k] = REDACTED
      } else {
        out[k] = redactValue(value[k], seen)
      }
    }
    return out
  }
  return value
}

function ymd(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}${m}${day}`
}

function appendLine(filePath, line) {
  fs.appendFileSync(filePath, line, "utf8")
}

// Per-process monotonic counter used to disambiguate logRequest snapshots
// taken within the same millisecond (bursty traffic can produce multiple
// Date.now() collisions). Combined with pid+ts the file name is unique
// across the local filesystem for this process's lifetime.
let logRequestCounter = 0

/**
 * Build a debug logger bound to `dataDir`. When `enabled` is false every
 * method is a no-op (zero overhead — important because the proxy is on the
 * hot path of every request).
 *
 * Two surfaces are written when enabled:
 *   * `log(level, msg)` appends to `dataDir/logs/dcp-YYYYMMDD.log`
 *   * `logRequest(fp, originalBody, forwardedBody, metrics)` writes a
 *     per-request JSON file under `dataDir/logs/context/{fp}/{ts}.json`
 *     with both bodies sanitized.
 */
export function createDebugLogger(dataDir, enabled) {
  const noop = () => {}
  if (!enabled || !dataDir) {
    return { log: noop, logRequest: noop }
  }

  const logsDir = path.join(dataDir, "logs")

  return {
    log(level, msg) {
      const stamp = new Date().toISOString()
      const safeLevel = typeof level === "string" ? level : "info"
      // Symmetric with logRequest(): non-string msg goes through redactValue so
      // callers like `lg.log("debug", config)` cannot leak upstream.apiKey or
      // `authorization` headers. Strings pass through unchanged (no surprises
      // for existing string-form call sites).
      let safeMsg
      if (typeof msg === "string") {
        safeMsg = msg
      } else if (msg == null) {
        safeMsg = ""
      } else {
        const seen = new WeakSet()
        const redacted = redactValue(msg, seen)
        try {
          safeMsg = JSON.stringify(redacted)
        } catch {
          safeMsg = String(msg)
        }
      }
      const file = path.join(logsDir, `dcp-${ymd()}.log`)
      ensureDirSync(logsDir)
      appendLine(file, `[${stamp}] [${safeLevel}] ${safeMsg}\n`)
    },

    logRequest(fp, originalBody, forwardedBody, metrics) {
      const seen = new WeakSet()
      const originalSafe = redactValue(originalBody == null ? {} : originalBody, seen)
      const seen2 = new WeakSet()
      const forwardedSafe = redactValue(forwardedBody == null ? {} : forwardedBody, seen2)
      const safeMetrics = redactValue(metrics == null ? {} : metrics, new WeakSet())
      const payload = {
        originalBody: originalSafe,
        forwardedBody: forwardedSafe,
        metrics: safeMetrics,
      }
      const ctxDir = path.join(logsDir, "context", fp)
      ensureDirSync(ctxDir)
      const ts = Date.now()
      // M-3: per-process monotonic counter lets two snapshots taken in the same
      // millisecond coexist (process.pid alone collides; ts alone collides
      // under bursty load; pid+ts+counter covers both).
      logRequestCounter += 1
      const seq = logRequestCounter
      const file = path.join(ctxDir, `${ts}-${seq}.json`)
      // Atomic write — tmp+rename keeps partial writes from corrupting a
      // snapshot under crash; the tmp suffix carries pid+ts+seq so concurrent
      // logRequest calls in the same process cannot collide.
      const tmp = `${file}.tmp-${process.pid}-${ts}-${seq}`
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8")
      fs.renameSync(tmp, file)
    },
  }
}
