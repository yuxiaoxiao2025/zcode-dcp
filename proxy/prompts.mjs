// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 lib/prompts/* (AGPL-3.0-or-later, © DCP authors) — see NOTICE
//
// Behavior-faithful port of DCP v3.1.15 prompt-loading subsystem (PromptStore):
//   - bundled defaults from ./prompts/defaults.mjs (text verbatim from DCP source)
//   - custom-prompt override resolution: project beats bundled (store.ts:349-393)
//   - customPrompts=false → bundled only (store.ts:349-352)
//   - text normalisation: strip BOM, normalise line endings (store.ts:231-237)
//   - nudge wrapping in <dcp-system-reminder> (wrapRuntimePromptContent store.ts:257-268)
//   - tool-class prompts (compress-range, compress-message) are NOT wrapped
//   - toolDescription composes body + format extension + SYSTEM_PHILOSOPHY for the
//     compress tool description (system.ts:1-33 distilled — see H1 note in defaults.mjs)
//
// ZCode adaptations:
//   - Override root paths: ~/.zcode/dcp/dcp-prompts/overrides/ (global) and
//     <cwd>/.zcode/dcp-prompts/overrides/ (project, walked up by findZcodeDir()).
//     DCP used ~/.config/opencode/dcp-prompts/... and .opencode/...; we keep the
//     same precedence order (project > bundled) but route through .zcode.
//   - No "system" prompt key (we have no system-prompt injection under H1); the
//     philosophy block from DCP's system.ts is folded into toolDescription instead.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

import {
  COMPRESS_RANGE,
  COMPRESS_MESSAGE,
  CONTEXT_LIMIT_NUDGE,
  TURN_NUDGE,
  ITERATION_NUDGE,
  RANGE_FORMAT_EXTENSION,
  MESSAGE_FORMAT_EXTENSION,
  SYSTEM_PHILOSOPHY,
} from "./prompts/defaults.mjs"

// ---------------------------------------------------------------------------
// Prompt definitions — mirrors DCP PROMPT_DEFINITIONS (store.ts:60-109) but
// without the "system" entry (we have no system prompt injection under H1).
// ---------------------------------------------------------------------------

const PROMPT_DEFINITIONS = [
  {
    key: "compress-range",
    fileName: "compress-range.md",
    runtimeField: "compressRange",
    editableKind: "tool", // body used as tool description; NOT wrapped
  },
  {
    key: "compress-message",
    fileName: "compress-message.md",
    runtimeField: "compressMessage",
    editableKind: "tool", // body used as tool description; NOT wrapped
  },
  {
    key: "context-limit-nudge",
    fileName: "context-limit-nudge.md",
    runtimeField: "contextLimitNudge",
    editableKind: "nudge", // injected as <dcp-system-reminder>
  },
  {
    key: "turn-nudge",
    fileName: "turn-nudge.md",
    runtimeField: "turnNudge",
    editableKind: "nudge",
  },
  {
    key: "iteration-nudge",
    fileName: "iteration-nudge.md",
    runtimeField: "iterationNudge",
    editableKind: "nudge",
  },
]

const BUNDLED_PROMPTS = Object.freeze({
  compressRange: COMPRESS_RANGE,
  compressMessage: COMPRESS_MESSAGE,
  contextLimitNudge: CONTEXT_LIMIT_NUDGE,
  turnNudge: TURN_NUDGE,
  iterationNudge: ITERATION_NUDGE,
})

// ---------------------------------------------------------------------------
// Normalisation — port of stripPromptComments (store.ts:231-237) simplified
// for our subset: strip BOM and normalise CRLF/CR → LF; HTML comments and
// legacy //...// line markers are not relevant to our editable subset.
// ---------------------------------------------------------------------------

function normalizePromptContent(raw) {
  if (typeof raw !== "string") return ""
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
}

// ---------------------------------------------------------------------------
// Override-file resolution
//   DCP semantics: per-prompt override resolution walks project → configDir →
//   global; the FIRST existing, VALID file wins (store.ts:361-387). Invalid /
//   empty / half-wrapped candidates are SKIPPED (continue), never short-circuit
//   the loop. We use the same precedence but with .zcode paths:
//     1) <zcodeDir>/dcp-prompts/overrides/<fileName>  (project — walked up from cwd)
//     2) ~/.zcode/dcp/dcp-prompts/overrides/<fileName> (global)
// ---------------------------------------------------------------------------

function findZcodeDir(startDir) {
  // Walk upward from startDir looking for a `.zcode` directory. We probe via
  // readdirSync to ensure it's actually a directory (not a stray file).
  let current = startDir
  while (true) {
    if (!current) break
    const candidate = join(current, ".zcode")
    if (existsSync(candidate)) {
      try {
        readdirSync(candidate)
        return candidate
      } catch {
        // existsSync hit a non-directory or unreadable entry — skip and keep walking.
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function getGlobalOverridesDir() {
  return join(homedir(), ".zcode", "dcp", "dcp-prompts", "overrides")
}

/**
 * Return override candidate paths in precedence order (highest first).
 * Mirrors store.ts:395-415 getOverrideCandidates.
 *
 * @param {string} workingDirectory
 * @param {string} fileName
 * @returns {string[]}
 */
function listOverrideCandidates(workingDirectory, fileName) {
  const candidates = []
  const zcodeDir = findZcodeDir(workingDirectory)
  if (zcodeDir) {
    candidates.push(join(zcodeDir, "dcp-prompts", "overrides", fileName))
  }
  candidates.push(join(getGlobalOverridesDir(), fileName))
  return candidates
}

/**
 * Per-prompt override loader — mirrors store.ts:354-390 effectiveValue logic.
 *
 * Semantics (DCP-faithful):
 *   - customPrompts=false → return bundled (no override resolution at all)
 *   - For each candidate in precedence order (project → global):
 *       - missing file → skip
 *       - read error → skip
 *       - empty after trim → skip (store.ts:368-373)
 *       - reminder-class content with half-wrapped tags (only-open XOR only-close) →
 *         skip (store.ts:221-226 normalizeReminderPromptContent)
 *       - tool-class content with half-wrapped tags → still allowed (tool-class
 *         bodies are not wrapped; half-wrap is harmless and can be re-normalised
 *         downstream by the consumer; matches store.ts:250-252 behaviour where
 *         only non-tool/non-message kinds get the reminder normalisation)
 *       - Otherwise: return this candidate and STOP iteration
 *   - If no candidate produced a valid value, fall back to bundled.
 *
 * Returns the unwrapped, normalised inner text. The caller (wrapReminder for
 * nudge kinds, toolDescription for tool kinds) decides how to wrap.
 */
function loadEffectivePrompt(definition, customPromptsEnabled, workingDirectory) {
  const bundled = BUNDLED_PROMPTS[definition.runtimeField]

  if (!customPromptsEnabled) {
    // store.ts:349-352 — customPrompts=false → bundled only.
    return bundled
  }

  for (const candidatePath of listOverrideCandidates(workingDirectory, definition.fileName)) {
    if (!existsSync(candidatePath)) continue

    let raw
    try {
      raw = readFileSync(candidatePath, "utf-8")
    } catch {
      continue // unreadable → next candidate
    }

    const trimmed = normalizePromptContent(raw).trim()
    if (!trimmed) continue // empty after normalisation → next candidate

    // Reminder-class prompts (nudge kinds): must NOT have half-wrapped tags.
    // DCP store.ts:221-226 — startWrapped XOR endWrapped is invalid.
    if (definition.editableKind === "nudge") {
      const startsWrapped = /^\s*<dcp-system-reminder\b[^>]*>/i.test(trimmed)
      const endsWrapped = /<\/dcp-system-reminder>\s*$/i.test(trimmed)
      if (startsWrapped !== endsWrapped) continue
    }

    // Tool-class prompts: no wrap-required check; the body is used verbatim
    // by toolDescription (matches store.ts:250-252 — non-tool kinds get
    // reminder normalisation, tool kinds bypass it).

    return trimmed
  }

  // No candidate produced a valid value → bundled fallback.
  return bundled
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the runtime prompts set: bundled defaults with optional per-prompt
 * overrides applied (project > global > bundled when customPrompts=true).
 *
 * @param {object} config — proxy config (only `experimental.customPrompts` is read)
 * @param {string} cwd — working directory; used as the override-search anchor
 * @returns {{
 *   compressRange: string,
 *   compressMessage: string,
 *   contextLimitNudge: string,
 *   turnNudge: string,
 *   iterationNudge: string,
 * }}
 *
 * **Contract:** returned values for nudge-class prompts (contextLimitNudge,
 * turnNudge, iterationNudge) are the UNWRAPPED inner text — they MUST be
 * passed through `wrapReminder` before being injected into a message body.
 * Tool-class prompts (compressRange, compressMessage) are already in their
 * final form and go through `toolDescription` for further composition.
 */
export function loadPrompts(config, cwd) {
  const customPromptsEnabled = !!(config && config.experimental && config.experimental.customPrompts)
  const out = {}
  for (const def of PROMPT_DEFINITIONS) {
    out[def.runtimeField] = loadEffectivePrompt(def, customPromptsEnabled, cwd)
  }
  return out
}

/**
 * Wrap reminder text in <dcp-system-reminder>...</dcp-system-reminder>.
 * For nudge-class prompt kinds, the result is what gets injected into the
 * model context. For tool-class kinds (compress-range / compress-message),
 * the text is returned trimmed but NOT wrapped — those bodies are used as
 * tool descriptions, not as injected reminders.
 *
 * @param {"compressRange"|"compressMessage"|"contextLimitNudge"|"turnNudge"|"iterationNudge"} kind
 * @param {string} text
 * @returns {string}
 */
export function wrapReminder(kind, text) {
  const trimmed = (typeof text === "string" ? text : "").trim()
  if (!trimmed) return ""

  if (kind === "compressRange" || kind === "compressMessage") {
    // Tool-class: do NOT wrap. Tool descriptions go through toolDescription instead.
    return trimmed
  }

  // Nudge-class: ensure exactly one pair of dcp-system-reminder tags.
  const inner = stripDcpReminderTags(trimmed)
  return `<dcp-system-reminder>\n${inner}\n</dcp-system-reminder>`
}

function stripDcpReminderTags(text) {
  // If the text is already wrapped, peel one layer so re-wrapping stays idempotent.
  const trimmed = text.trim()
  const opens = /^\s*<dcp-system-reminder\b[^>]*>\s*/i
  const closes = /\s*<\/dcp-system-reminder>\s*$/i
  if (opens.test(trimmed) && closes.test(trimmed)) {
    return trimmed.replace(opens, "").replace(closes, "").trim()
  }
  return trimmed
}

/**
 * Compose the compress tool description from the loaded prompt body, the
 * matching format extension (range or message), and the system philosophy
 * block. The result is a single multi-section string suitable for use as
 * the tool's `description` field in MCP registration.
 *
 * @param {"range"|"message"} mode — compress tool mode (selects body + format)
 * @param {ReturnType<typeof loadPrompts>} prompts — result of loadPrompts
 * @param {object} _config — accepted for parity / future use; not required
 * @returns {string}
 */
export function toolDescription(mode, prompts, _config) {
  const m = mode === "message" ? "message" : "range" // default to range

  const body =
    m === "message" ? prompts.compressMessage : prompts.compressRange
  const formatExt =
    m === "message" ? MESSAGE_FORMAT_EXTENSION : RANGE_FORMAT_EXTENSION

  const sections = []
  if (body && body.trim()) sections.push(body.trim())
  if (formatExt && formatExt.trim()) sections.push(formatExt.trim())
  if (SYSTEM_PHILOSOPHY && SYSTEM_PHILOSOPHY.trim())
    sections.push(SYSTEM_PHILOSOPHY.trim())

  return sections
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n([ \t]*\n)+/g, "\n\n") // collapse runs of blank lines (index.ts:27)
    .trim()
}
