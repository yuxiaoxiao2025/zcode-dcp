// SPDX-License-Identifier: AGPL-3.0-or-later
// Part of zcode-dcp (AGPL-3.0-or-later) — verification tooling (task-15, PLAN §Task 15)
//
// CLI: node zcode-dcp/scripts/rollout-stats.mjs <a.jsonl|dir> <b.jsonl|dir> [--runs N]
//
// Compares two groups of rollout jsonl captures (each line is one rollout record with
// a top-level `response.usage` object — ZCode normalised fields inputTokens /
// cacheReadTokens / outputTokens / totalTokens / cacheWriteTokens).
//
// Per-group metric: sum of (inputTokens + cacheReadTokens) across all valid lines,
// F-P-4 口径 (SPEC R14).
// Per-run metric : one *.jsonl file (or one explicit jsonl path) = one run.
// Multi-run median : across per-run totals of a group.
// Output          : plain text on stdout, machine-parseable by `grep 20%` for F-P-4.
//
// Zero deps, ESM, node >= 20.

import { readFileSync, statSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"

// ---------- core helpers (exported for tests) ----------

/** Numeric median. Empty → 0. Single → that value. Sorts in place (on a copy). */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const n = sorted.length
  const mid = n >> 1
  if (n % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/** Accumulate one jsonl file: sum (inputTokens + cacheReadTokens) over valid lines.
 *  - Skips blank lines, malformed JSON, lines without a response.usage object.
 *  - Missing numeric fields default to 0 (treated as absent).
 */
export function accumulateFile(absPath) {
  let raw
  try {
    raw = readFileSync(absPath, "utf8")
  } catch (err) {
    throw new Error(`cannot read file: ${absPath} (${err.code || err.message})`)
  }

  let total = 0
  let validLines = 0
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    if (line.trim() === "") continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      // malformed line — skip silently (per task brief)
      continue
    }
    const usage = obj && obj.response && obj.response.usage
    if (!usage || typeof usage !== "object") continue

    const input = Number(usage.inputTokens) || 0
    const cacheRead = Number(usage.cacheReadTokens) || 0
    total += input + cacheRead
    validLines += 1
  }

  // Surface "no usage lines" so callers can error early instead of reporting 0 reduction.
  // This covers both truly-empty files and files with only blanks / non-usage lines.
  if (validLines === 0) {
    throw new Error(`no usage lines found in ${absPath}`)
  }

  return total
}

/** Recurse a directory, collect every *.jsonl file, return [{path, tokens}] per file. */
export function accumulateDir(absDir) {
  const results = []
  walk(absDir, results)
  if (results.length === 0) {
    throw new Error(`no *.jsonl files found under directory: ${absDir}`)
  }
  return results
}

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    throw new Error(`cannot read directory: ${dir} (${err.code || err.message})`)
  }
  for (const ent of entries) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      walk(p, out)
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".jsonl")) {
      out.push({ path: p, tokens: accumulateFile(p) })
    }
  }
}

/** Resolve one CLI path argument → list of per-run entries [{path, tokens}]. */
export function resolveGroupPath(p) {
  const abs = resolve(p)
  let st
  try {
    st = statSync(abs)
  } catch (err) {
    throw new Error(`path not found: ${abs} (${err.code || err.message})`)
  }
  if (st.isDirectory()) {
    return accumulateDir(abs)
  }
  if (st.isFile()) {
    return [{ path: abs, tokens: accumulateFile(abs) }]
  }
  throw new Error(`path is neither file nor directory: ${abs}`)
}

/** Group stat: median of per-run totals (number). */
export function computeStats(perRunTotals) {
  return median(perRunTotals)
}

/** Total of per-run totals. */
export function sumTotals(perRunTotals) {
  return perRunTotals.reduce((a, b) => a + b, 0)
}

/** Format a human-readable comparison report. Pure: no side effects. */
export function formatReport({ aLabel, aFiles, bLabel, bFiles }) {
  const aTotals = aFiles.map((f) => f.tokens)
  const bTotals = bFiles.map((f) => f.tokens)
  const aTotal = sumTotals(aTotals)
  const bTotal = sumTotals(bTotals)
  const aMed = computeStats(aTotals)
  const bMed = computeStats(bTotals)
  const aRuns = aTotals.length
  const bRuns = bTotals.length

  const reductionPct = aMed === 0
    ? 0
    : ((aMed - bMed) / aMed) * 100

  const lines = []
  lines.push(`rollout-stats comparison`)
  lines.push("=".repeat(40))
  lines.push(`group ${aLabel}: ${aRuns} run(s), total=${aTotal}, median=${aMed}`)
  lines.push(`group ${bLabel}: ${bRuns} run(s), total=${bTotal}, median=${bMed}`)
  lines.push(`median reduction (${aLabel} -> ${bLabel}): ${reductionPct.toFixed(1)}%`)
  lines.push("")
  lines.push(`details (per-run inputTokens+cacheReadTokens):`)
  lines.push(`  ${aLabel}:`)
  for (const f of aFiles) lines.push(`    - ${f.path} : ${f.tokens}`)
  lines.push(`  ${bLabel}:`)
  for (const f of bFiles) lines.push(`    - ${f.path} : ${f.tokens}`)
  return lines.join("\n")
}

/** main(argv) — parse argv, return { code, stdout, stderr }. Pure (no process.exit). */
export function main(argv) {
  // Strip optional --runs N (recorded but not used yet; median is over all *.jsonl files).
  const args = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") {
      i += 1 // skip value
      continue
    }
    args.push(argv[i])
  }

  if (args.length < 2) {
    return {
      code: 2,
      stdout: "",
      stderr:
        `usage: rollout-stats <a.jsonl|dir> <b.jsonl|dir> [--runs N]\n` +
        `error: missing required argument (need 2 paths)`,
    }
  }
  if (args.length > 2) {
    return {
      code: 2,
      stdout: "",
      stderr: `usage: rollout-stats <a.jsonl|dir> <b.jsonl|dir> [--runs N]\nerror: too many arguments`,
    }
  }

  const [aArg, bArg] = args
  let aFiles, bFiles
  try {
    aFiles = resolveGroupPath(aArg)
    bFiles = resolveGroupPath(bArg)
  } catch (err) {
    return { code: 1, stdout: "", stderr: `error: ${err.message}` }
  }

  const report = formatReport({
    aLabel: relativeOrBasename(aArg),
    aFiles,
    bLabel: relativeOrBasename(bArg),
    bFiles,
  })
  return { code: 0, stdout: report, stderr: "" }
}

function relativeOrBasename(p) {
  const abs = resolve(p)
  const base = abs.split(/[\\/]/).pop()
  return base || abs
}

// ---------- CLI entry ----------
// Only run when invoked directly (not when imported by tests).
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