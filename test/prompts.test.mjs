// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 (AGPL-3.0) — lib/prompts/* (verbatim text + override store port)
// Behavior-faithful test suite for zcode-dcp/proxy/prompts.mjs + zcode-dcp/proxy/prompts/defaults.mjs
// Tests are independent of implementation: only consume the public surface defined in PLAN.md Task 10.

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { homedir } from "node:os"

import { loadPrompts, wrapReminder, toolDescription } from "../proxy/prompts.mjs"
import {
  COMPRESS_RANGE,
  COMPRESS_MESSAGE,
  CONTEXT_LIMIT_NUDGE,
  TURN_NUDGE,
  ITERATION_NUDGE,
  RANGE_FORMAT_EXTENSION,
  MESSAGE_FORMAT_EXTENSION,
  SYSTEM_PHILOSOPHY,
} from "../proxy/prompts/defaults.mjs"

// ---------- bundled defaults (verbatim copy from DCP source) ----------

describe("bundled defaults", () => {
  it("exports all 5 prompt strings + 2 format extensions + system philosophy", () => {
    assert.equal(typeof COMPRESS_RANGE, "string")
    assert.equal(typeof COMPRESS_MESSAGE, "string")
    assert.equal(typeof CONTEXT_LIMIT_NUDGE, "string")
    assert.equal(typeof TURN_NUDGE, "string")
    assert.equal(typeof ITERATION_NUDGE, "string")
    assert.equal(typeof RANGE_FORMAT_EXTENSION, "string")
    assert.equal(typeof MESSAGE_FORMAT_EXTENSION, "string")
    assert.equal(typeof SYSTEM_PHILOSOPHY, "string")
  })

  it("COMPRESS_RANGE contains the canonical opening sentence (verbatim from source)", () => {
    // Spot-check 1: first sentence must match DCP/lib/prompts/compress-range.ts:1 verbatim
    assert.match(
      COMPRESS_RANGE,
      /^Collapse a range in the conversation into a detailed summary\.$/m,
    )
  })

  it("COMPRESS_RANGE contains the placeholder format rule (verbatim from source)", () => {
    // Spot-check 2: must include "(bN)" placeholder rule exactly as authored
    assert.match(
      COMPRESS_RANGE,
      /When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:[\s\S]*- `\(bN\)`/,
    )
  })

  it("COMPRESS_RANGE contains the batching rule (verbatim from source)", () => {
    // Spot-check 3: batching paragraph must match source wording
    assert.match(
      COMPRESS_RANGE,
      /When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the `content` array of a single tool call/,
    )
  })

  it("COMPRESS_MESSAGE opens with collapse-individual-messages sentence (verbatim from source)", () => {
    assert.match(
      COMPRESS_MESSAGE,
      /^Collapse selected individual messages in the conversation into detailed summaries\.$/m,
    )
  })

  it("COMPRESS_MESSAGE includes priority compression rule (verbatim from source)", () => {
    assert.match(
      COMPRESS_MESSAGE,
      /The `priority` attribute indicates relative context cost\. You MUST compress high-priority messages when their full text is no longer necessary for the active task\./,
    )
  })

  it("CONTEXT_LIMIT_NUDGE opens with dcp-system-reminder tag (verbatim from source)", () => {
    // The source literal ends with `</dcp-system-reminder>\n` — allow that trailing LF.
    assert.match(
      CONTEXT_LIMIT_NUDGE,
      /^<dcp-system-reminder>[\s\S]+CRITICAL WARNING: MAX CONTEXT LIMIT REACHED[\s\S]+<\/dcp-system-reminder>\n?$/,
    )
  })

  it("TURN_NUDGE is wrapped in dcp-system-reminder (verbatim from source)", () => {
    assert.match(
      TURN_NUDGE,
      /^<dcp-system-reminder>\nEvaluate the conversation for compressible ranges\./,
    )
  })

  it("ITERATION_NUDGE is wrapped in dcp-system-reminder (verbatim from source)", () => {
    assert.match(
      ITERATION_NUDGE,
      /^<dcp-system-reminder>\nYou've been iterating for a while after the last user message\./,
    )
  })

  it("RANGE_FORMAT_EXTENSION contains the topic+content schema (verbatim from source)", () => {
    assert.match(RANGE_FORMAT_EXTENSION, /THE FORMAT OF COMPRESS/)
    assert.match(RANGE_FORMAT_EXTENSION, /startId: string/)
    assert.match(RANGE_FORMAT_EXTENSION, /endId: string/)
    assert.match(RANGE_FORMAT_EXTENSION, /summary: string/)
  })

  it("MESSAGE_FORMAT_EXTENSION contains the messageId+topic+summary schema (verbatim from source)", () => {
    assert.match(MESSAGE_FORMAT_EXTENSION, /THE FORMAT OF COMPRESS/)
    assert.match(MESSAGE_FORMAT_EXTENSION, /messageId: string/)
    assert.match(MESSAGE_FORMAT_EXTENSION, /topic: string/)
    assert.match(MESSAGE_FORMAT_EXTENSION, /summary: string/)
  })

  it("SYSTEM_PHILOSOPHY distils the philosophy of compress from system.ts:1-33", () => {
    assert.match(SYSTEM_PHILOSOPHY, /PHILOSOPHY OF COMPRESS/i)
    assert.match(SYSTEM_PHILOSOPHY, /COMPRESS WHEN/)
    assert.match(SYSTEM_PHILOSOPHY, /DO NOT COMPRESS IF/)
    assert.match(SYSTEM_PHILOSOPHY, /<dcp-message-id>/)
  })
})

// ---------- loadPrompts: bundled baseline ----------

describe("loadPrompts (bundled baseline)", () => {
  it("returns 5 keys when no overrides exist and customPrompts=false", () => {
    const fakeCwd = join(tmpdir(), "dcp-prompts-bundled-1")
    const config = { experimental: { customPrompts: false } }
    const prompts = loadPrompts(config, fakeCwd)
    const keys = Object.keys(prompts).sort()
    assert.deepEqual(
      keys,
      [
        "compressMessage",
        "compressRange",
        "contextLimitNudge",
        "iterationNudge",
        "turnNudge",
      ],
    )
  })

  it("bundled values match the source-derived defaults character-for-character", () => {
    const fakeCwd = join(tmpdir(), "dcp-prompts-bundled-2")
    const config = { experimental: { customPrompts: false } }
    const prompts = loadPrompts(config, fakeCwd)
    assert.equal(prompts.compressRange, COMPRESS_RANGE)
    assert.equal(prompts.compressMessage, COMPRESS_MESSAGE)
    assert.equal(prompts.contextLimitNudge, CONTEXT_LIMIT_NUDGE)
    assert.equal(prompts.turnNudge, TURN_NUDGE)
    assert.equal(prompts.iterationNudge, ITERATION_NUDGE)
  })
})

// ---------- loadPrompts: override precedence + customPrompts gate ----------

describe("loadPrompts (override resolution)", () => {
  let projectRoot
  let globalHomeStub
  let savedHome

  before(() => {
    savedHome = process.env.HOME || process.env.USERPROFILE
    projectRoot = mkdtempSync(join(tmpdir(), "dcp-prompts-proj-"))
  })

  after(() => {
    if (savedHome === undefined) {
      delete process.env.HOME
      delete process.env.USERPROFILE
    } else {
      process.env.HOME = savedHome
      process.env.USERPROFILE = savedHome
    }
    rmSync(projectRoot, { recursive: true, force: true })
  })

  function withGlobalOverrides(dir) {
    return dir
  }

  // (withGlobalOverrides retained as a placeholder for any future tests that
  // need to assert against the global layer; the per-test setup above sets
  // USERPROFILE directly to achieve isolation.)

  it("returns bundled when customPrompts=false even if override files exist", () => {
    // Create a project .zcode/dcp-prompts/overrides/compress-range.md
    const zcodeDir = join(projectRoot, ".zcode", "dcp-prompts", "overrides")
    mkdirSync(zcodeDir, { recursive: true })
    writeFileSync(
      join(zcodeDir, "compress-range.md"),
      "<dcp-system-reminder>\nOVERRIDE_TEXT_PROJECT\n</dcp-system-reminder>\n",
      "utf-8",
    )

    const config = { experimental: { customPrompts: false } }
    const prompts = loadPrompts(config, projectRoot)

    // customPrompts=false → must NOT pick up override; should equal bundled
    assert.equal(prompts.compressRange, COMPRESS_RANGE)

    rmSync(zcodeDir, { recursive: true, force: true })
  })

  it("uses project override when customPrompts=true (project beats bundled)", () => {
    const zcodeDir = join(projectRoot, ".zcode", "dcp-prompts", "overrides")
    mkdirSync(zcodeDir, { recursive: true })
    const projectText =
      "<dcp-system-reminder>\nPROJECT_OVERRIDE_RANGE\n</dcp-system-reminder>"
    writeFileSync(join(zcodeDir, "compress-range.md"), projectText, "utf-8")

    const config = { experimental: { customPrompts: true } }
    const prompts = loadPrompts(config, projectRoot)

    // Project override should win for compress-range
    assert.match(prompts.compressRange, /PROJECT_OVERRIDE_RANGE/)
    // Other prompts remain bundled
    assert.equal(prompts.compressMessage, COMPRESS_MESSAGE)
    assert.equal(prompts.turnNudge, TURN_NUDGE)

    rmSync(zcodeDir, { recursive: true, force: true })
  })

  it("ignores empty override files (treats them as no override)", () => {
    const zcodeDir = join(projectRoot, ".zcode", "dcp-prompts", "overrides")
    mkdirSync(zcodeDir, { recursive: true })
    // Empty file (after trim) — should be skipped, fall back to bundled
    writeFileSync(join(zcodeDir, "compress-range.md"), "   \n\n  ", "utf-8")

    const config = { experimental: { customPrompts: true } }
    const prompts = loadPrompts(config, projectRoot)
    assert.equal(prompts.compressRange, COMPRESS_RANGE)

    rmSync(zcodeDir, { recursive: true, force: true })
  })

  it("normalises BOM and CRLF in override content (text after normalisation is loaded)", () => {
    const zcodeDir = join(projectRoot, ".zcode", "dcp-prompts", "overrides")
    mkdirSync(zcodeDir, { recursive: true })
    const raw =
      "\uFEFF<dcp-system-reminder>\r\nBOM_CRLF_RANGE\r\n</dcp-system-reminder>\r\n"
    writeFileSync(join(zcodeDir, "compress-range.md"), raw, "utf-8")

    const config = { experimental: { customPrompts: true } }
    const prompts = loadPrompts(config, projectRoot)

    // BOM stripped, CRLF normalised — body text should still appear
    assert.match(prompts.compressRange, /BOM_CRLF_RANGE/)
    assert.doesNotMatch(prompts.compressRange, /\uFEFF/)

    rmSync(zcodeDir, { recursive: true, force: true })
  })

  it("rejects half-wrapped reminder overrides (only open or only close tag) — falls back to bundled", () => {
    // I-1a: DCP store.ts:221-226 — only-open or only-close wrap is invalid.
    // The candidate must be skipped, NOT loaded.
    const zcodeDir = join(projectRoot, ".zcode", "dcp-prompts", "overrides")
    mkdirSync(zcodeDir, { recursive: true })
    // Only-open-tag override (no closing tag) — malformed
    writeFileSync(
      join(zcodeDir, "turn-nudge.md"),
      "<dcp-system-reminder>\nHALF_OPEN_ONLY\n",
      "utf-8",
    )

    const config = { experimental: { customPrompts: true } }
    const prompts = loadPrompts(config, projectRoot)

    // Bundled TURN_NUDGE must win because the half-wrapped candidate is rejected.
    assert.equal(prompts.turnNudge, TURN_NUDGE)

    rmSync(zcodeDir, { recursive: true, force: true })
  })

  it("project empty override file falls through to bundled (not frozen at first file)", () => {
    // I-1b: DCP store.ts:361-387 — empty/invalid candidate MUST NOT lock the
    // resolution; iteration continues to the next candidate (or bundled).
    // Here the project override exists but is empty → bundled wins.
    const zcodeDir = join(projectRoot, ".zcode", "dcp-prompts", "overrides")
    mkdirSync(zcodeDir, { recursive: true })
    // Empty file (whitespace only)
    writeFileSync(join(zcodeDir, "iteration-nudge.md"), "   \n  \n", "utf-8")

    const config = { experimental: { customPrompts: true } }
    const prompts = loadPrompts(config, projectRoot)

    // Empty project candidate rejected → bundled fallback wins.
    assert.equal(prompts.iterationNudge, ITERATION_NUDGE)

    rmSync(zcodeDir, { recursive: true, force: true })
  })

  it("global layer overrides apply when no project override exists (USERPROFILE redirect)", () => {
    // I-2: global-layer resolution. Redirect USERPROFILE to an isolated tmp
    // dir; create ~/.zcode/dcp/dcp-prompts/overrides/compress-message.md;
    // verify it wins when project has no override.
    const fakeHome = mkdtempSync(join(tmpdir(), "dcp-prompts-home-"))
    const savedUp = process.env.USERPROFILE
    const savedHome = process.env.HOME
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome

    try {
      // Make sure no project .zcode exists above the test cwd — but our test
      // projectRoot IS the cwd-anchor, so explicitly use a separate fresh cwd
      // that has no .zcode dir above it.
      const isolatedCwd = mkdtempSync(join(tmpdir(), "dcp-prompts-iso-"))
      const globalDir = join(fakeHome, ".zcode", "dcp", "dcp-prompts", "overrides")
      mkdirSync(globalDir, { recursive: true })
      const globalText =
        "<dcp-system-reminder>\nGLOBAL_OVERRIDE_MESSAGE\n</dcp-system-reminder>"
      writeFileSync(join(globalDir, "compress-message.md"), globalText, "utf-8")

      const config = { experimental: { customPrompts: true } }
      const prompts = loadPrompts(config, isolatedCwd)

      // Global layer must apply for compress-message
      assert.match(prompts.compressMessage, /GLOBAL_OVERRIDE_MESSAGE/)
      // Other prompts stay bundled
      assert.equal(prompts.compressRange, COMPRESS_RANGE)
      assert.equal(prompts.turnNudge, TURN_NUDGE)

      rmSync(isolatedCwd, { recursive: true, force: true })
    } finally {
      // Restore env
      if (savedUp === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedUp
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it("project override beats global override (USERPROFILE redirect)", () => {
    // I-2 (precedence): project layer must shadow global even when global
    // also has an override for the same prompt.
    const fakeHome = mkdtempSync(join(tmpdir(), "dcp-prompts-home2-"))
    const savedUp = process.env.USERPROFILE
    const savedHome = process.env.HOME
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome

    try {
      const globalDir = join(fakeHome, ".zcode", "dcp", "dcp-prompts", "overrides")
      mkdirSync(globalDir, { recursive: true })
      writeFileSync(
        join(globalDir, "compress-message.md"),
        "<dcp-system-reminder>\nGLOBAL_MSG\n</dcp-system-reminder>",
        "utf-8",
      )

      // Create project override with different content
      const projDir = join(projectRoot, ".zcode", "dcp-prompts", "overrides")
      mkdirSync(projDir, { recursive: true })
      writeFileSync(
        join(projDir, "compress-message.md"),
        "<dcp-system-reminder>\nPROJECT_MSG\n</dcp-system-reminder>",
        "utf-8",
      )

      const config = { experimental: { customPrompts: true } }
      const prompts = loadPrompts(config, projectRoot)

      // Project wins over global
      assert.match(prompts.compressMessage, /PROJECT_MSG/)
      assert.doesNotMatch(prompts.compressMessage, /GLOBAL_MSG/)

      rmSync(projDir, { recursive: true, force: true })
    } finally {
      if (savedUp === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedUp
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it("empty project override falls through to global (USERPROFILE redirect)", () => {
    // I-1b + I-2 interaction: empty project file must NOT freeze the
    // resolution; iteration continues and global layer applies.
    const fakeHome = mkdtempSync(join(tmpdir(), "dcp-prompts-home3-"))
    const savedUp = process.env.USERPROFILE
    const savedHome = process.env.HOME
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome

    try {
      const globalDir = join(fakeHome, ".zcode", "dcp", "dcp-prompts", "overrides")
      mkdirSync(globalDir, { recursive: true })
      writeFileSync(
        join(globalDir, "compress-message.md"),
        "<dcp-system-reminder>\nGLOBAL_FALLTHROUGH\n</dcp-system-reminder>",
        "utf-8",
      )

      const projDir = join(projectRoot, ".zcode", "dcp-prompts", "overrides")
      mkdirSync(projDir, { recursive: true })
      // Empty project file — must NOT block iteration
      writeFileSync(join(projDir, "compress-message.md"), "  \n\n  ", "utf-8")

      const config = { experimental: { customPrompts: true } }
      const prompts = loadPrompts(config, projectRoot)

      // Global layer must apply because project was empty.
      assert.match(prompts.compressMessage, /GLOBAL_FALLTHROUGH/)

      rmSync(projDir, { recursive: true, force: true })
    } finally {
      if (savedUp === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedUp
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it("half-wrapped project override falls through to global (USERPROFILE redirect)", () => {
    // I-1a + I-2 interaction: half-wrapped project candidate must be
    // rejected and global layer must apply.
    const fakeHome = mkdtempSync(join(tmpdir(), "dcp-prompts-home4-"))
    const savedUp = process.env.USERPROFILE
    const savedHome = process.env.HOME
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome

    try {
      const globalDir = join(fakeHome, ".zcode", "dcp", "dcp-prompts", "overrides")
      mkdirSync(globalDir, { recursive: true })
      writeFileSync(
        join(globalDir, "turn-nudge.md"),
        "<dcp-system-reminder>\nGLOBAL_TURN\n</dcp-system-reminder>",
        "utf-8",
      )

      const projDir = join(projectRoot, ".zcode", "dcp-prompts", "overrides")
      mkdirSync(projDir, { recursive: true })
      // Only close-tag (no opening) — malformed, must be rejected
      writeFileSync(join(projDir, "turn-nudge.md"), "MALFORMED_TURN</dcp-system-reminder>\n", "utf-8")

      const config = { experimental: { customPrompts: true } }
      const prompts = loadPrompts(config, projectRoot)

      // Half-wrapped rejected → global applies
      assert.match(prompts.turnNudge, /GLOBAL_TURN/)
      assert.doesNotMatch(prompts.turnNudge, /MALFORMED_TURN/)

      rmSync(projDir, { recursive: true, force: true })
    } finally {
      if (savedUp === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedUp
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

// ---------- wrapReminder: nudge wrapping semantics ----------

describe("wrapReminder", () => {
  it("wraps turn-nudge reminder text in <dcp-system-reminder>...</dcp-system-reminder>", () => {
    const out = wrapReminder("turnNudge", TURN_NUDGE)
    assert.match(
      out,
      /^<dcp-system-reminder>\n[\s\S]+\n<\/dcp-system-reminder>$/,
    )
    assert.match(out, /Evaluate the conversation for compressible ranges/)
  })

  it("wraps iteration-nudge reminder text in <dcp-system-reminder>", () => {
    const out = wrapReminder("iterationNudge", ITERATION_NUDGE)
    assert.match(
      out,
      /^<dcp-system-reminder>\n[\s\S]+\n<\/dcp-system-reminder>$/,
    )
  })

  it("wraps context-limit-nudge reminder text in <dcp-system-reminder>", () => {
    const out = wrapReminder("contextLimitNudge", CONTEXT_LIMIT_NUDGE)
    assert.match(
      out,
      /^<dcp-system-reminder>\n[\s\S]+\n<\/dcp-system-reminder>$/,
    )
    assert.match(out, /CRITICAL WARNING: MAX CONTEXT LIMIT REACHED/)
  })

  it("does NOT wrap compress-range (tool-class) text — returns trimmed text unchanged", () => {
    const out = wrapReminder("compressRange", COMPRESS_RANGE)
    assert.doesNotMatch(out, /^<dcp-system-reminder>/)
    assert.doesNotMatch(out, /<\/dcp-system-reminder>/)
    // Body content is preserved
    assert.match(out, /Collapse a range in the conversation/)
  })

  it("does NOT wrap compress-message (tool-class) text", () => {
    const out = wrapReminder("compressMessage", COMPRESS_MESSAGE)
    assert.doesNotMatch(out, /^<dcp-system-reminder>/)
    assert.doesNotMatch(out, /<\/dcp-system-reminder>/)
    assert.match(out, /Collapse selected individual messages/)
  })

  it("is idempotent: wrapping already-wrapped reminder text yields same outer shape", () => {
    const wrapped = wrapReminder("turnNudge", TURN_NUDGE)
    const twice = wrapReminder("turnNudge", wrapped)
    // Both should have exactly one pair of dcp-system-reminder tags
    const openCount = (twice.match(/<dcp-system-reminder>/g) || []).length
    const closeCount = (twice.match(/<\/dcp-system-reminder>/g) || []).length
    assert.equal(openCount, 1)
    assert.equal(closeCount, 1)
  })
})

// ---------- toolDescription: composition with philosophy + format block ----------

describe("toolDescription", () => {
  const fakeCwd = join(tmpdir(), "dcp-prompts-tool-desc")
  const config = { experimental: { customPrompts: false } }

  it("range description contains body + range format extension + system philosophy", () => {
    const prompts = loadPrompts(config, fakeCwd)
    const desc = toolDescription("range", prompts, config)
    // Body from bundled COMPRESS_RANGE
    assert.match(desc, /Collapse a range in the conversation/)
    // Range format block marker
    assert.match(desc, /THE FORMAT OF COMPRESS/)
    assert.match(desc, /startId: string/)
    // System philosophy block
    assert.match(desc, /PHILOSOPHY OF COMPRESS/i)
    assert.match(desc, /COMPRESS WHEN/)
    assert.match(desc, /DO NOT COMPRESS IF/)
  })

  it("message description contains body + message format extension + system philosophy", () => {
    const prompts = loadPrompts(config, fakeCwd)
    const desc = toolDescription("message", prompts, config)
    // Body from bundled COMPRESS_MESSAGE
    assert.match(desc, /Collapse selected individual messages/)
    // Message format block marker
    assert.match(desc, /THE FORMAT OF COMPRESS/)
    assert.match(desc, /messageId: string/)
    // System philosophy block
    assert.match(desc, /PHILOSOPHY OF COMPRESS/i)
  })

  it("range description does NOT include message-format schema (mutually exclusive)", () => {
    const prompts = loadPrompts(config, fakeCwd)
    const desc = toolDescription("range", prompts, config)
    // The message-format block mentions "Raw message ID only: mNNNN" — this should
    // not appear in the range-mode description (DCP keeps them separate).
    assert.doesNotMatch(desc, /Raw message ID only: mNNNN/)
  })

  it("message description does NOT include range-format schema (mutually exclusive)", () => {
    const prompts = loadPrompts(config, fakeCwd)
    const desc = toolDescription("message", prompts, config)
    assert.doesNotMatch(desc, /startId: string/)
    assert.doesNotMatch(desc, /endId: string/)
  })

  it("description is non-empty and reasonably sized for both modes", () => {
    const prompts = loadPrompts(config, fakeCwd)
    const range = toolDescription("range", prompts, config)
    const message = toolDescription("message", prompts, config)
    assert.ok(range.length > 500, "range description too short")
    assert.ok(message.length > 500, "message description too short")
  })
})
