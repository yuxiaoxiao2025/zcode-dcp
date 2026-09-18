// SPDX-License-Identifier: AGPL-3.0-or-later
// Part of zcode-dcp (AGPL-3.0-or-later) — stage-2 root-cause analysis tool
// (PLAN Task 10; SPEC R13; DESIGN D8).
//
// CLI: node scripts/replay-analysis.mjs <fixture.json>
//             [--sweep key:from:to:step]
//             [--out <path>]
//
// What it does
// ------------
// Reads a fixture JSON describing a session corpus (system + tools +
// requests-with-messages), constructs the Anthropic-protocol body+ctx pair
// the daemon would have built in production, and replays each request
// through `pipeline.transformRequest(body, ctx)` offline (no HTTP, no
// upstream). Collects per-request metrics (`savedTokensEst`,
// `byStrategy`, `savedTokensByStrategy`, `maxRunId`, `injectedNudges`,
// `activeBlocks`, `skipped`) plus an input estimate (sent tokens =
// post-transform messages + system + tools — the latter two form the
// "unprunable ceiling" we want to surface to R13 问④).
//
// Output (stdout by default, or to --out path):
//   - Per-request rows: index, name, sentTokens, savedTokens, byStrategy,
//     byStrategyTokens, maxRunId, injectedNudges, activeBlocks, skipped
//   - Summary: totalSent/totalSaved/savingsRate, byStrategyHits (sum of
//     hits), byStrategyTokens (sum of token savings), strategyShare (% of
//     savings), triggerCountByStrategy (# requests with >0 hits per
//     bucket).
//
// --sweep key:from:to:step replays the fixture N times, overriding the
// dotted config key (e.g. "compress.minContextLimit") on each iteration
// with a stepped value, and emits a comparison table.
//
// Zero deps, ESM, node >= 20. Pure: no I/O beyond the optional --out write.

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { transformRequest } from "../proxy/pipeline.mjs"
import { defaultLightState } from "../proxy/session.mjs"
import { DEFAULT_CONFIG, mergeConfig, loadConfig } from "../proxy/config.mjs"
import { estimateMessageTokens, estimateTokens } from "../proxy/tokens.mjs"

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

/**
 * Load a fixture JSON file from disk. Throws with a clear error on missing
 * file / malformed JSON / schema violations. Returns the parsed object.
 *
 * Expected schema (all fields optional unless noted):
 *   {
 *     name: string,
 *     system: string | array<{type, text}>,            // required
 *     tools?: array,                                    // optional
 *     config?: object,                                  // optional override (merged onto DEFAULT_CONFIG)
 *     requests: array<{                                 // required, >=1
 *       name: string,
 *       messages: array,
 *       usage?: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
 *       lightState?: object,                            // optional, merged onto defaultLightState()
 *     }>,
 *   }
 *
 * @param {string} filePath
 * @returns {object}
 */
export function loadFixture(filePath) {
  let raw
  try {
    raw = readFileSync(resolve(filePath), "utf8")
  } catch (err) {
    throw new Error(`cannot read fixture: ${filePath} (${err.code || err.message})`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid JSON in fixture ${filePath}: ${err.message}`)
  }
  validateFixture(parsed, filePath)
  return parsed
}

function validateFixture(fx, source) {
  if (!fx || typeof fx !== "object" || Array.isArray(fx)) {
    throw new Error(`fixture must be an object: ${source}`)
  }
  if (typeof fx.name !== "string") {
    throw new Error(`fixture.name must be a string: ${source}`)
  }
  if (typeof fx.system !== "string" && !Array.isArray(fx.system)) {
    throw new Error(`fixture.system must be a string or array: ${source}`)
  }
  if (!Array.isArray(fx.requests) || fx.requests.length === 0) {
    throw new Error(`fixture.requests must be a non-empty array: ${source}`)
  }
  for (let i = 0; i < fx.requests.length; i++) {
    const r = fx.requests[i]
    if (!r || typeof r !== "object") {
      throw new Error(`fixture.requests[${i}] must be an object: ${source}`)
    }
    if (typeof r.name !== "string") {
      throw new Error(`fixture.requests[${i}].name must be a string: ${source}`)
    }
    if (!Array.isArray(r.messages)) {
      throw new Error(`fixture.requests[${i}].messages must be an array: ${source}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Sweep-arg parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `--sweep` argument of shape `key:from:to:step`.
 * Returns `{ key, values: number[] }` containing the inclusive range.
 *
 * @param {string} arg
 * @returns {{ key: string, values: number[] }}
 */
export function parseSweepArg(arg) {
  if (typeof arg !== "string" || arg.length === 0) {
    throw new Error("expected key:from:to:step sweep argument")
  }
  const parts = arg.split(":")
  if (parts.length !== 4) {
    throw new Error(
      `expected key:from:to:step sweep argument; got ${JSON.stringify(arg)}`,
    )
  }
  const [key, fromStr, toStr, stepStr] = parts
  // Validate step FIRST (it's the most common typo — a non-numeric step
  // is what we want to surface as "step must be a positive number").
  const step = Number(stepStr)
  if (!Number.isFinite(step)) {
    throw new Error(
      `step must be a positive number; got ${JSON.stringify(stepStr)}`,
    )
  }
  if (step <= 0) {
    throw new Error(`step must be a positive number; got ${step}`)
  }
  const from = Number(fromStr)
  const to = Number(toStr)
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error(
      `from/to must be finite numbers; got from=${JSON.stringify(fromStr)}, to=${JSON.stringify(toStr)}`,
    )
  }
  if (from > to) {
    throw new Error(`from must be <= to; got from=${from}, to=${to}`)
  }
  const values = []
  // Inclusive range with step. Use Math.round to avoid float drift accumulation.
  for (let v = from; v < to + step / 2; v += step) {
    const rounded = Math.round(v)
    if (rounded > to) break
    if (values.length === 0 || values[values.length - 1] !== rounded) {
      values.push(rounded)
    }
  }
  if (values.length === 0) {
    throw new Error(`sweep produced no values; got ${JSON.stringify(arg)}`)
  }
  return { key, values }
}

// ---------------------------------------------------------------------------
// Body + ctx construction
// ---------------------------------------------------------------------------

/**
 * Build the (body, ctx) pair that the daemon would have built for a request,
 * derived from a fixture + a single request entry.
 *
 * - body.model hardcoded to "claude-3-7-sonnet" (replay doesn't care about
 *   model identity; only ctx.modelId matters downstream, and that comes from
 *   body.model). Override per-fixture by setting `fixture.model` (not part
 *   of v1 schema; left open).
 * - ctx.config = DEFAULT_CONFIG deep-merged with fixture.config
 * - ctx.lightState = defaultLightState() deep-merged with request.lightState
 * - ctx.usage = request.usage or null (skipped signal path will fire)
 *
 * @param {object} fixture
 * @param {object} request
 * @returns {{body: object, ctx: object}}
 */
export function buildRequest(fixture, request) {
  const config = mergeConfig([
    JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    fixture.config || {},
  ])
  const lightState = mergeLightState(defaultLightState(), request.lightState || {})
  const usage = normalizeUsage(request.usage)
  const body = {
    model: "claude-3-7-sonnet",
    max_tokens: 1024,
    system: normalizeSystem(fixture.system),
    tools: Array.isArray(fixture.tools) ? fixture.tools : [],
    messages: JSON.parse(JSON.stringify(request.messages || [])),
  }
  const ctx = {
    config,
    lightState,
    usage,
    dataDir: "",
    cwd: "",
  }
  return { body, ctx }
}

function mergeLightState(base, override) {
  const out = JSON.parse(JSON.stringify(base))
  for (const k of Object.keys(override || {})) {
    const v = override[k]
    if (v && typeof v === "object" && !Array.isArray(v) &&
        out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = { ...out[k], ...v }
    } else if (v !== undefined) {
      out[k] = JSON.parse(JSON.stringify(v))
    }
  }
  return out
}

function normalizeSystem(system) {
  if (typeof system === "string") return [{ type: "text", text: system }]
  if (Array.isArray(system)) return system
  return []
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null
  const u = {
    inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0,
    outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0,
    cacheReadTokens: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
    cacheWriteTokens: Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
  }
  return u
}

// ---------------------------------------------------------------------------
// Body token estimation — supports R13 问④ "不可裁天花板"
// ---------------------------------------------------------------------------

/**
 * Estimate the post-transform "sent" tokens of a body, split by category so
 * the caller can surface the "unprunable ceiling" (system + tools).
 *
 *   system  : concatenated text of body.system blocks (or string)
 *   tools   : JSON.stringify of each tool definition, summed (matches the
 *             DCP `tool_use` estimator semantics — tool definitions are
 *             INVISIBLE to DCP's save estimators but DO count toward the
 *             upstream-billed token count; surfacing the gap is exactly
 *             R13 问③'s "口径低估" question)
 *   messages: estimateMessageTokens over body.messages
 *   total   : sum of the three buckets
 *
 * @param {object} body
 * @returns {{system:number, tools:number, messages:number, total:number}}
 */
export function estimateBodyTokens(body) {
  let system = 0
  if (typeof body.system === "string") {
    system = estimateTokens(body.system)
  } else if (Array.isArray(body.system)) {
    for (const b of body.system) {
      if (b && typeof b === "object" && typeof b.text === "string") {
        system += estimateTokens(b.text)
      }
    }
  }

  let tools = 0
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      // Conservative: estimate the full tool definition JSON. Matches
      // tokens.mjs's `tool_use` estimator behavior (whole block serialized).
      tools += estimateTokens(JSON.stringify(t))
    }
  }

  let messages = 0
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      messages += estimateMessageTokens(m)
    }
  }

  return { system, tools, messages, total: system + tools + messages }
}

// ---------------------------------------------------------------------------
// Per-request replay
// ---------------------------------------------------------------------------

/**
 * Replay a single request through transformRequest and return the per-request
 * metrics row + the (optional) post-transform body for downstream estimation.
 *
 * @param {object} fixture
 * @param {object} request
 * @param {number} index
 * @returns {object} row (see schema in replayFixture's contract)
 */
function replayOne(fixture, request, index) {
  const { body, ctx } = buildRequest(fixture, request)
  let result
  try {
    result = transformRequest(body, ctx)
  } catch (err) {
    // Surface the failure as a structured row (never throw out of the loop)
    return {
      index,
      name: request.name,
      error: err && err.message ? err.message : String(err),
      inputTokens: Number.isFinite(request.usage?.inputTokens) ? request.usage.inputTokens : 0,
      sentTokens: 0,
      savedTokens: 0,
      byStrategy: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
      byStrategyTokens: { dedup: 0, purge: 0, sweep: 0, compress: 0 },
      maxRunId: 0,
      injectedNudges: 0,
      activeBlocks: 0,
    }
  }

  // Estimate POST-transform sent tokens — that's what the upstream actually
  // billed for this request after DCP did its work.
  const sent = estimateBodyTokens(result.body)
  const m = result.metrics || {}
  const bs = m.byStrategy || { dedup: 0, purge: 0, sweep: 0, compress: 0 }
  const bst = m.savedTokensByStrategy || { dedup: 0, purge: 0, sweep: 0, compress: 0 }
  const row = {
    index,
    name: request.name,
    inputTokens: Number.isFinite(request.usage?.inputTokens) ? request.usage.inputTokens : 0,
    sentTokens: sent.total,
    sentBreakdown: { system: sent.system, tools: sent.tools, messages: sent.messages },
    savedTokens: Number.isFinite(m.savedTokensEst) ? m.savedTokensEst : 0,
    byStrategy: {
      dedup: Number.isFinite(bs.dedup) ? bs.dedup : 0,
      purge: Number.isFinite(bs.purge) ? bs.purge : 0,
      sweep: Number.isFinite(bs.sweep) ? bs.sweep : 0,
      compress: Number.isFinite(bs.compress) ? bs.compress : 0,
    },
    byStrategyTokens: {
      dedup: Number.isFinite(bst.dedup) ? bst.dedup : 0,
      purge: Number.isFinite(bst.purge) ? bst.purge : 0,
      sweep: Number.isFinite(bst.sweep) ? bst.sweep : 0,
      compress: Number.isFinite(bst.compress) ? bst.compress : 0,
    },
    maxRunId: Number.isFinite(m.maxRunId) ? m.maxRunId : 0,
    injectedNudges: Number.isFinite(m.injectedNudges) ? m.injectedNudges : 0,
    activeBlocks: Number.isFinite(m.activeBlocks) ? m.activeBlocks : 0,
  }
  if (m.skipped) row.skipped = m.skipped
  if (m.compressError) row.compressError = m.compressError
  if (m.nudgeStarved) row.nudgeStarved = true
  return row
}

// ---------------------------------------------------------------------------
// Fixture replay (summary)
// ---------------------------------------------------------------------------

/**
 * Replay every request in a fixture and produce the full result object:
 *   { fixture, requests: [...rows], summary }
 *
 * Summary schema:
 *   totalRequests       : number
 *   triggeredRequests   : number (rows with savedTokens > 0)
 *   totalSentTokens     : sum of row.sentTokens
 *   totalSavedTokens    : sum of row.savedTokens
 *   savingsRate         : totalSaved / (totalSent + totalSaved), 0 if denom=0
 *   byStrategyHits      : sum of row.byStrategy.* across rows
 *   byStrategyTokens    : sum of row.byStrategyTokens.* across rows
 *   strategyShare       : each bucket / totalSaved, 0 if totalSaved=0
 *   triggerCountByStrategy : # of rows with that bucket > 0
 *
 * @param {object} fixture
 * @returns {object}
 */
export function replayFixture(fixture) {
  const requests = []
  for (let i = 0; i < fixture.requests.length; i++) {
    requests.push(replayOne(fixture, fixture.requests[i], i))
  }
  const summary = summarise(requests)
  return { fixture: fixture.name, requests, summary }
}

function summarise(rows) {
  const totalSent = rows.reduce((a, r) => a + (r.sentTokens || 0), 0)
  const totalSaved = rows.reduce((a, r) => a + (r.savedTokens || 0), 0)
  const denom = totalSent + totalSaved
  const savingsRate = denom > 0 ? totalSaved / denom : 0
  const byStrategyHits = sumBuckets(rows.map((r) => r.byStrategy))
  const byStrategyTokens = sumBuckets(rows.map((r) => r.byStrategyTokens))
  const strategyShare = totalSaved > 0 ? shareOf(byStrategyTokens, totalSaved) : zeroShare()
  const triggerCountByStrategy = countTriggers(rows)
  const triggeredRequests = rows.filter((r) => (r.savedTokens || 0) > 0).length
  return {
    totalRequests: rows.length,
    triggeredRequests,
    totalSentTokens: totalSent,
    totalSavedTokens: totalSaved,
    savingsRate,
    byStrategyHits,
    byStrategyTokens,
    strategyShare,
    triggerCountByStrategy,
  }
}

function sumBuckets(objs) {
  const out = { dedup: 0, purge: 0, sweep: 0, compress: 0 }
  for (const o of objs) {
    if (!o) continue
    out.dedup += o.dedup || 0
    out.purge += o.purge || 0
    out.sweep += o.sweep || 0
    out.compress += o.compress || 0
  }
  return out
}

function shareOf(buckets, total) {
  return {
    dedup: total > 0 ? buckets.dedup / total : 0,
    purge: total > 0 ? buckets.purge / total : 0,
    sweep: total > 0 ? buckets.sweep / total : 0,
    compress: total > 0 ? buckets.compress / total : 0,
  }
}

function zeroShare() {
  return { dedup: 0, purge: 0, sweep: 0, compress: 0 }
}

function countTriggers(rows) {
  const out = { dedup: 0, purge: 0, sweep: 0, compress: 0 }
  for (const r of rows) {
    const bs = r.byStrategy || {}
    if ((bs.dedup || 0) > 0) out.dedup += 1
    if ((bs.purge || 0) > 0) out.purge += 1
    if ((bs.sweep || 0) > 0) out.sweep += 1
    if ((bs.compress || 0) > 0) out.compress += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Sweep mode
// ---------------------------------------------------------------------------

/**
 * Replay a fixture N times, each time overriding `key` (a dotted config
 * path) with one value from the swept range. Returns an array of
 * `{ paramValue, summary }` rows — one per swept value.
 *
 * @param {object} fixture
 * @param {string} sweepArg  "key:from:to:step"
 * @returns {Array<{paramValue:number, summary:object}>}
 */
export function replaySweep(fixture, sweepArg) {
  const { key, values } = parseSweepArg(sweepArg)
  const rows = []
  for (const v of values) {
    const overridden = applyConfigOverride(fixture, key, v)
    const result = replayFixture(overridden)
    rows.push({ paramValue: v, summary: result.summary })
  }
  return rows
}

function applyConfigOverride(fixture, dottedKey, value) {
  const cloned = JSON.parse(JSON.stringify(fixture))
  if (!cloned.config) cloned.config = {}
  const parts = dottedKey.split(".")
  let cursor = cloned.config
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (!cursor[p] || typeof cursor[p] !== "object") cursor[p] = {}
    cursor = cursor[p]
  }
  cursor[parts[parts.length - 1]] = value
  return cloned
}

// ---------------------------------------------------------------------------
// Reporting (plain-text stdout; machine-parseable by `grep`)
// ---------------------------------------------------------------------------

/**
 * Format a single replayFixture result as a plain-text report.
 *
 * @param {object} result  from replayFixture
 * @returns {string}
 */
export function formatReport(result) {
  const lines = []
  lines.push(`replay-analysis: ${result.fixture}`)
  lines.push("=".repeat(72))
  lines.push(
    "idx  name                    sent     saved   dedup purge sweep compress  nudges  blocks  maxRunId",
  )
  for (const r of result.requests) {
    const sent = pad(r.sentTokens, 7)
    const saved = pad(r.savedTokens, 7)
    const dedup = pad(r.byStrategy.dedup, 5)
    const purge = pad(r.byStrategy.purge, 5)
    const sweep = pad(r.byStrategy.sweep, 5)
    const compress = pad(r.byStrategy.compress, 8)
    const nudges = pad(r.injectedNudges, 6)
    const blocks = pad(r.activeBlocks, 6)
    const runId = pad(r.maxRunId, 8)
    const name = pad(r.name, 22)
    const tag = r.skipped ? ` [skipped=${r.skipped}]` : ""
    lines.push(
      `${pad(r.index, 3)}  ${name} ${sent} ${saved}  ${dedup} ${purge} ${sweep} ${compress}  ${nudges}  ${blocks}  ${runId}${tag}`,
    )
  }
  lines.push("")
  lines.push("Summary")
  lines.push("-".repeat(72))
  const s = result.summary
  lines.push(`  totalRequests       : ${s.totalRequests}`)
  lines.push(`  triggeredRequests   : ${s.triggeredRequests}`)
  lines.push(`  totalSentTokens     : ${s.totalSentTokens}`)
  lines.push(`  totalSavedTokens    : ${s.totalSavedTokens}`)
  lines.push(`  savingsRate         : ${(s.savingsRate * 100).toFixed(2)}%`)
  lines.push(`  byStrategyHits      : dedup=${s.byStrategyHits.dedup} purge=${s.byStrategyHits.purge} sweep=${s.byStrategyHits.sweep} compress=${s.byStrategyHits.compress}`)
  lines.push(`  byStrategyTokens    : dedup=${s.byStrategyTokens.dedup} purge=${s.byStrategyTokens.purge} sweep=${s.byStrategyTokens.sweep} compress=${s.byStrategyTokens.compress}`)
  lines.push(
    `  strategyShare       : dedup=${(s.strategyShare.dedup * 100).toFixed(1)}% purge=${(s.strategyShare.purge * 100).toFixed(1)}% sweep=${(s.strategyShare.sweep * 100).toFixed(1)}% compress=${(s.strategyShare.compress * 100).toFixed(1)}%`,
  )
  lines.push(`  triggerCountByStrategy : dedup=${s.triggerCountByStrategy.dedup} purge=${s.triggerCountByStrategy.purge} sweep=${s.triggerCountByStrategy.sweep} compress=${s.triggerCountByStrategy.compress}`)
  return lines.join("\n")
}

/**
 * Format a sweep result as a comparison table.
 *
 * @param {{fixtureName: string, paramKey: string, rows: Array<{paramValue:number, summary:object}>}} args
 * @returns {string}
 */
export function formatSweepTable(args) {
  const { fixtureName, paramKey, rows } = args
  const lines = []
  lines.push(`replay-sweep: ${fixtureName} (${paramKey})`)
  lines.push("=".repeat(72))
  lines.push(
    `${paramKey.padEnd(36)} sent       saved      savings%   nudges  dedupHits  compressHits`,
  )
  for (const r of rows) {
    const s = r.summary
    const pct = (s.savingsRate * 100).toFixed(2)
    lines.push(
      `${pad(String(r.paramValue), 36)} ${pad(s.totalSentTokens, 10)} ${pad(s.totalSavedTokens, 10)} ${pad(pct + "%", 10)} ${pad(s.byStrategyHits.dedup + s.byStrategyHits.purge, 6)} ${pad(s.triggerCountByStrategy.dedup + s.triggerCountByStrategy.purge, 11)} ${pad(s.triggerCountByStrategy.compress, 0)}`,
    )
  }
  return lines.join("\n")
}

function pad(value, width) {
  const s = String(value)
  if (s.length >= width) return s
  return s + " ".repeat(width - s.length)
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

/**
 * main(argv) — parse argv, return { code, stdout, stderr }. Pure (no
 * process.exit). Both --sweep and --out may appear at most once.
 */
export function main(argv) {
  const args = argv.slice()
  let sweep = null
  let outPath = null
  let fixturePath = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--sweep") {
      if (sweep !== null) {
        return {
          code: 2,
          stdout: "",
          stderr: "error: --sweep specified more than once",
        }
      }
      const v = args[++i]
      if (!v) {
        return { code: 2, stdout: "", stderr: "error: --sweep requires a value" }
      }
      try {
        parseSweepArg(v) // validate early
      } catch (err) {
        return { code: 2, stdout: "", stderr: `error: ${err.message}` }
      }
      sweep = v
      continue
    }
    if (a === "--out") {
      if (outPath !== null) {
        return {
          code: 2,
          stdout: "",
          stderr: "error: --out specified more than once",
        }
      }
      const v = args[++i]
      if (!v) {
        return { code: 2, stdout: "", stderr: "error: --out requires a path" }
      }
      outPath = v
      continue
    }
    if (a === "--help" || a === "-h") {
      return {
        code: 0,
        stdout:
          "usage: replay-analysis <fixture.json> [--sweep key:from:to:step] [--out <path>]\n\n" +
          "Replays fixture requests through pipeline.transformRequest and reports\n" +
          "per-request + per-strategy token savings (R13 / DESIGN D8).",
        stderr: "",
      }
    }
    if (a.startsWith("-")) {
      return { code: 2, stdout: "", stderr: `error: unknown option ${a}` }
    }
    if (fixturePath !== null) {
      return {
        code: 2,
        stdout: "",
        stderr: `error: more than one positional fixture argument (${fixturePath}, ${a})`,
      }
    }
    fixturePath = a
  }
  if (!fixturePath) {
    return {
      code: 2,
      stdout: "",
      stderr:
        "usage: replay-analysis <fixture.json> [--sweep key:from:to:step] [--out <path>]\n" +
        "error: missing required fixture path",
    }
  }

  let fixture
  try {
    fixture = loadFixture(fixturePath)
  } catch (err) {
    return { code: 1, stdout: "", stderr: `error: ${err.message}` }
  }

  let stdout
  if (sweep !== null) {
    const rows = replaySweep(fixture, sweep)
    stdout = formatSweepTable({
      fixtureName: fixture.name,
      paramKey: parseSweepArg(sweep).key,
      rows,
    })
  } else {
    const result = replayFixture(fixture)
    stdout = formatReport(result)
  }

  if (outPath !== null) {
    try {
      writeFileSync(resolve(outPath), stdout + "\n", "utf8")
    } catch (err) {
      return {
        code: 1,
        stdout: "",
        stderr: `error: cannot write to ${outPath} (${err.code || err.message})`,
      }
    }
  }
  return { code: 0, stdout, stderr: "" }
}

// ---------------------------------------------------------------------------
// CLI entry (only when invoked directly)
// ---------------------------------------------------------------------------

const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const r = main(process.argv.slice(2))
  if (r.stdout) process.stdout.write(r.stdout + "\n")
  if (r.stderr) process.stderr.write(r.stderr + "\n")
  process.exit(r.code)
}

// Unused-but-imported retention to silence static analyzers and document the
// `loadConfig` symmetry between the proxy loader and this offline replayer.
void loadConfig
