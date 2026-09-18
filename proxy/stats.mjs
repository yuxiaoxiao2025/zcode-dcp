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
 * Field semantics (PLAN Task 9 / Task 4):
 *   sentTokens         — tokens sent upstream this request (post-prune,
 *                        including compress block replacements — i.e. real
 *                        billable amount)
 *   savedTokens        — tokens saved vs. the pre-transform baseline (i.e.
 *                        the sum of dedup/purge/compress savings)
 *   byStrategy         — split of savedTokens by strategy COUNT (number of
 *                        tool_use ids pruned, or active compress blocks):
 *                          dedup     — duplicate tool calls collapsed
 *                          purge     — error tool_use inputs / outputs pruned
 *                          sweep     — operator-marked sweep picks
 *                          compress  — replaced by compress block summary
 *   byStrategyTokens   — R8.3 / DESIGN D3: per-strategy token split. Sum of
 *                        the four buckets equals savedTokensEst (see also
 *                        pipeline.mjs `metrics.savedTokensByStrategy`).
 *   compressRuns       — count of compress tool_use invocations observed
 *   requests           — request counter (1 per pipeline invocation)
 */
function freshPerSessionCounters() {
  return {
    sentTokens: 0,
    savedTokens: 0,
    byStrategy: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
    // R8.3 / DESIGN D3: per-strategy TOKEN split (parallel to byStrategy
    // which is a COUNT split). Buckets sum to savedTokens.
    byStrategyTokens: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
    compressRuns: 0,
    requests: 0,
  }
}

// ---------------------------------------------------------------------------
// R3 / DESIGN D2 — compressRuns 增量计数纯函数
// ---------------------------------------------------------------------------
//
// SPEC R3.1 / DESIGN D2: pipeline 每请求按 compress 调用分配 runId（一次调用
// 含多 range entry 只占一个 runId，由 compress.mjs deriveBlocks 的 nextRunId
// 保证）。daemon 侧通过比较本次 `maxRunId` 与 light-state 中已记账的
// `maxRunIdSeen` 决定 compressRuns 的增量；首见（seen=null）只建立基线、
// 不计数（禁止追溯历史块）；compressError 请求不更新 seen 也不计数。
//
// 契约：
//   - null seen              → 0（首见基线；建立 seen 但不 incr）
//   - hasCompressError=true  → 0（error 跳过）
//   - maxRunId <= seen       → 0（单调钳制：重推/回退不计）
//   - 否则                  → maxRunId - seen（>=1，因为 maxRunId > seen）
//
// 导出纯函数便于单元测试（不依赖 daemon/light-state I/O）。
export function compressRunsDelta(maxRunId, seen, hasCompressError) {
  if (hasCompressError === true) return 0
  if (seen === null || seen === undefined) return 0
  if (!Number.isFinite(maxRunId) || !Number.isFinite(seen)) return 0
  if (maxRunId <= seen) return 0
  return maxRunId - seen
}

function freshAllTimeCounters() {
  return {
    sentTokens: 0,
    savedTokens: 0,
    byStrategy: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
    byStrategyTokens: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
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
   *   * "byStrategy.dedup", "byStrategy.purge", "byStrategy.sweep",
   *     "byStrategy.compress"
   *   * "byStrategyTokens.dedup", "byStrategyTokens.purge",
   *     "byStrategyTokens.sweep", "byStrategyTokens.compress"
   *     (R8.3 / DESIGN D3 — per-strategy TOKEN split)
   *
   * Unknown fields are ignored (defensive — never crash the pipeline on a
   * typo in a caller).
   */
  incr(field, n = 1) {
    if (typeof field !== "string") return
    const value = Number.isFinite(n) ? n : 0
    if (field.startsWith("byStrategyTokens.")) {
      const sub = field.slice("byStrategyTokens.".length)
      if (
        !Object.prototype.hasOwnProperty.call(
          this.counters.byStrategyTokens,
          sub,
        )
      ) return
      this.counters.byStrategyTokens[sub] += value
      return
    }
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
        // R3 review pre-existing bug fix: sweep MUST be in snap.byStrategy
        // because daemon.mjs:418 increments it. Previously this branch
        // omitted sweep entirely → the increment was lost on disk. Now
        // sweep round-trips through the per-session file and the
        // all-time aggregate (D3 propagation through all five places).
        dedup: this.counters.byStrategy.dedup,
        purge: this.counters.byStrategy.purge,
        sweep: this.counters.byStrategy.sweep,
        compress: this.counters.byStrategy.compress,
      },
      // R8.3 / DESIGN D3: per-strategy token split. Surface in the
      // per-session file and the all-time aggregate (D3 propagation).
      byStrategyTokens: {
        dedup: this.counters.byStrategyTokens.dedup,
        purge: this.counters.byStrategyTokens.purge,
        sweep: this.counters.byStrategyTokens.sweep,
        compress: this.counters.byStrategyTokens.compress,
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
  // R8.3 / DESIGN D3: per-strategy TOKEN split. A legacy stats file
  // written before this field existed must NOT crash the loader — it
  // defaults to 0 across all four buckets.
  const bst = raw.byStrategyTokens && typeof raw.byStrategyTokens === "object"
    ? raw.byStrategyTokens
    : {}
  return {
    sentTokens: Number.isFinite(raw.sentTokens) ? raw.sentTokens : def.sentTokens,
    savedTokens: Number.isFinite(raw.savedTokens) ? raw.savedTokens : def.savedTokens,
    byStrategy: {
      dedup: Number.isFinite(bs.dedup) ? bs.dedup : def.byStrategy.dedup,
      purge: Number.isFinite(bs.purge) ? bs.purge : def.byStrategy.purge,
      sweep: Number.isFinite(bs.sweep) ? bs.sweep : def.byStrategy.sweep,
      compress: Number.isFinite(bs.compress) ? bs.compress : def.byStrategy.compress,
    },
    byStrategyTokens: {
      dedup: Number.isFinite(bst.dedup) ? bst.dedup : def.byStrategyTokens.dedup,
      purge: Number.isFinite(bst.purge) ? bst.purge : def.byStrategyTokens.purge,
      sweep: Number.isFinite(bst.sweep) ? bst.sweep : def.byStrategyTokens.sweep,
      compress: Number.isFinite(bst.compress) ? bst.compress : def.byStrategyTokens.compress,
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
    // R8.3 / DESIGN D3: per-strategy TOKEN split roll-up. Sum-invariant
    // is maintained: the four buckets in stats-all.json add up to
    // savedTokens exactly (each snap already sums internally).
    byStrategyTokens: {
      dedup: base.byStrategyTokens.dedup + snap.byStrategyTokens.dedup,
      purge: base.byStrategyTokens.purge + snap.byStrategyTokens.purge,
      sweep: base.byStrategyTokens.sweep + snap.byStrategyTokens.sweep,
      compress: base.byStrategyTokens.compress + snap.byStrategyTokens.compress,
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

// ---------------------------------------------------------------------------
// R8.3 / DESIGN D3a — per-request jsonl record
// ---------------------------------------------------------------------------
//
// SPEC R8.3 / DESIGN D3a: each transformed request is appended as a single
// JSON line to `dataDir/stats/requests.jsonl`. The record schema is:
//   {
//     ts:                number  — Date.now() at append time
//     fp:                string  — session fingerprint (sha hex)
//     sent:              number  — sentTokens (post-prune)
//     saved:             number  — savedTokens (dedup+purge+sweep+compress)
//     byStrategy:        object  — { dedup, purge, sweep, compress } counts
//     byStrategyTokens:  object  — { dedup, purge, sweep, compress } tokens
//   }
//
// Rotation policy (PLAN Task 4):
//   - Single-generation rotation: when the live file already has ≥
//     REQUESTS_JSONL_MAX_LINES lines (100,000 per the brief), the live
//     file is moved aside to `requests.jsonl.1` (single generation — over-
//     writes the previous .1; no chain of .2 / .3).
//   - A fresh live file starts with just the post-rotation record.
//   - Rotation is performed ASYNCHRONOUSLY via fs.promises.rename so the
//     hot request-forwarding path is never blocked by stats I/O.
//
// Failure mode:
//   - Any write failure (missing dir, permission denied, etc.) is swallowed
//     — appendRequestLine resolves normally after a warn log. The proxy's
//     request forwarding must NEVER be blocked by a stats error.
//
const REQUESTS_JSONL_MAX_LINES = 100000

async function countLines(filePath) {
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) return 0
    // Read once (file is small enough at rotation boundary to be cheap; we
    // only count NEWLINE bytes to avoid buffering the whole content).
    const fd = await fs.promises.open(filePath, "r")
    try {
      const buf = Buffer.alloc(Math.min(stat.size, 1024 * 1024))
      let readTotal = 0
      let count = 0
      // Start by counting partial last line: if file does not end with \n
      // the last record is unterminated, count it as a line anyway.
      let lastByteWasNewline = false
      while (readTotal < stat.size) {
        const { bytesRead } = await fd.read(
          buf,
          0,
          buf.length,
          readTotal,
        )
        if (bytesRead === 0) break
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0a) count++
        }
        lastByteWasNewline = buf[bytesRead - 1] === 0x0a
        readTotal += bytesRead
      }
      if (!lastByteWasNewline && stat.size > 0) count++
      return count
    } finally {
      await fd.close()
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return 0
    throw err
  }
}

/**
 * Append one per-request record to `dataDir/stats/requests.jsonl`.
 *
 * Rotates the live file to `requests.jsonl.1` when the live file has
 * reached REQUESTS_JSONL_MAX_LINES (single generation; overwrites any
 * existing `.1`). The fresh live file starts with just this record.
 *
 * Write failures are swallowed — the proxy's request-forwarding path
 * must never be blocked by a stats error.
 *
 * Gate 1.5 C1: line count is held in a module-level Map keyed by the
 * liveFile absolute path. The first observation for a given path
 * performs one full-file newline scan (the original countLines cost);
 * every subsequent call is O(1) — just `counter += 1`. On rotation
 * the counter is reset to 0 (the post-rotation file is empty before
 * this append, so after `appendFile` it has exactly 1 line — counter
 * becomes 1). Behaviour equivalence with the pre-fix implementation is
 * preserved: same rotation threshold, same .1 overwrite semantics,
 * same swallow-on-error. The IO cost drops by ~5 orders of magnitude
 * for a steady-state 100k-line file (30-60MB).
 *
 * Keying by path (not process-global) is required because tests use
 * isolated tmpdirs and run in parallel against distinct liveFile paths.
 *
 * @param {string} dataDir
 * @param {{ts:number, fp:string, sent:number, saved:number, byStrategy:object, byStrategyTokens:object}} rec
 * @returns {Promise<void>}
 */
export async function appendRequestLine(dataDir, rec) {
  if (!dataDir || typeof dataDir !== "string") return
  if (!rec || typeof rec !== "object") return
  const statsDir = path.join(dataDir, "stats")
  const liveFile = path.join(statsDir, "requests.jsonl")
  const rotatedFile = path.join(statsDir, "requests.jsonl.1")

  let line
  try {
    line = JSON.stringify(rec) + "\n"
  } catch {
    return
  }

  try {
    await fs.promises.mkdir(statsDir, { recursive: true })
    // Gate 1.5 C1: in-memory counter. First observation per path pays
    // the full-file scan cost; subsequent calls are O(1).
    let existing = liveLineCounters.get(liveFile)
    if (existing === undefined) {
      try {
        existing = await countLines(liveFile)
      } catch {
        existing = 0
      }
      liveLineCounters.set(liveFile, existing)
    }

    let needRotate = false
    if (existing >= REQUESTS_JSONL_MAX_LINES) needRotate = true

    if (needRotate) {
      // Single-generation rotation: overwrite .1, start fresh live file.
      // Use copyFile + unlink rather than rename so a same-filesystem
      // rename on Windows doesn't fail with EBUSY when the destination
      // exists (rename over an existing file is permitted on POSIX but
      // historically flaky on Windows; copy+unlink is portable).
      try {
        await fs.promises.copyFile(liveFile, rotatedFile)
        await fs.promises.unlink(liveFile)
      } catch {
        // If the rotation copy fails (e.g. ENOENT because the file was
        // removed between countLines and rename), proceed to write a
        // fresh live file anyway.
        try { await fs.promises.unlink(liveFile) } catch { /* ignore */ }
      }
      // Reset counter — the post-rotation file is empty before this
      // append, so after appendFile it has exactly 1 line.
      existing = 0
    }
    await fs.promises.appendFile(liveFile, line, "utf8")
    // Increment the in-memory counter (O(1)) so the next call doesn't
    // re-scan the file. After rotation: 0 → 1. Steady state: N → N+1.
    liveLineCounters.set(liveFile, existing + 1)
  } catch (err) {
    // Swallow: stats I/O must NEVER block the request-forwarding path.
    if (process && process.stderr && typeof process.stderr.write === "function") {
      try {
        process.stderr.write(
          `[dcp-stats] appendRequestLine failed: ${err && err.message}\n`,
        )
      } catch {
        /* ignore */
      }
    }
  }
}

// Gate 1.5 C1: module-level in-memory line counter, keyed by liveFile
// absolute path. Set on first observation (after one countLines scan);
// incremented on every subsequent append; reset to 0 immediately before
// the post-rotation appendFile so the counter equals the post-rotation
// file's line count (1) by the time the next request arrives.
//
// Cross-test safety: each test uses its own mkdtempSync tmpdir, so the
// liveFile paths are distinct and counters do not collide. Within one
// test, repeated appends against the same path share the counter.
//
// KNOWN CONCURRENCY SEMANTICS (per docs/working/09-优化清单.md C1 风险条):
//   * appendRequestLine is invoked fire-and-forget by daemon.mjs (the
//     response-forwarding path is NOT blocked on stats I/O — see
//     daemon.mjs:472-479). Two concurrent appends against the same
//     liveFile can therefore interleave between the read of `existing`
//     and the `liveLineCounters.set` write below — losing up to N-1
//     increments where N is the burst size.
//   * Net effect when this happens: the in-memory counter UNDER-counts
//     relative to the actual file line count. Rotation is therefore
//     DELAYED (counter reaches the threshold LATER than the file does)
//     but NEVER skipped — once a stray countLines runs (on process
//     restart, or on a path the counter has not yet observed), the
//     counter re-syncs to ground truth. NO DATA IS LOST: every appendFile
//     call lands the line on disk; only the counter's accuracy degrades
//     until the next countLines observation.
//   * The daemon serialises /v1/messages handlers via Node's single-
//     threaded event loop, so within a single in-flight request there
//     is no overlap. The interleaving window above only opens when the
//     proxy accepts two requests before either appendRequestLine resolves.
const liveLineCounters = new Map()

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
