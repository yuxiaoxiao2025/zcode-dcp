// SPDX-License-Identifier: AGPL-3.0-or-later
// Ported from opencode-dcp v3.1.15 lib/prompts/*.ts (AGPL-3.0-or-later, © DCP authors) — see NOTICE
//
// Text below is ported VERBATIM from the following DCP v3.1.15 source files:
//   lib/prompts/compress-range.ts      → COMPRESS_RANGE
//   lib/prompts/compress-message.ts    → COMPRESS_MESSAGE
//   lib/prompts/context-limit-nudge.ts → CONTEXT_LIMIT_NUDGE
//   lib/prompts/turn-nudge.ts          → TURN_NUDGE
//   lib/prompts/iteration-nudge.ts     → ITERATION_NUDGE
//   lib/prompts/extensions/tool.ts     → RANGE_FORMAT_EXTENSION, MESSAGE_FORMAT_EXTENSION
//   lib/prompts/system.ts              → SYSTEM_PHILOSOPHY (distilled subset; see comment below)
//
// SYSTEM_PHILOSOPHY is a ZCode adaptation: we cannot inject an extra system prompt block
// in the Anthropic messages passthrough (H1: messages-passthrough constraint), so we instead
// splice the philosophy/WHEN/dcp-tag guidance into the compress tool's description.
// The content is a faithful subset of DCP's system.ts:1-33 (philosophy + WHEN + DO NOT +
// tag metadata) — wording kept identical where unchanged.

export const COMPRESS_RANGE = `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- \`(bN)\`

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Compressed block IDs always use the \`bN\` form (never \`mNNNN\`) and are represented in the same XML metadata tag format.

Rules:

- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected range.
- Treat \`(bN)\` placeholders as RESERVED TOKENS. Do not emit \`(bN)\` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like \`compressed bN\` (not as a placeholder).
- Preflight check before finalizing: the set of \`(bN)\` placeholders in your summary must exactly match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal (for example, "as noted in \`(b2)\`").
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages
- \`bN\` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like \`<dcp-message-id>...</dcp-message-id>\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.
`

export const COMPRESS_MESSAGE = `Collapse selected individual messages in the conversation into detailed summaries.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings, tool outcomes, and user intent details that matter... EVERYTHING that preserves the value of the selected message after the raw message is removed.

USER INTENT FIDELITY
When a selected message contains user intent, preserve that intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote short user instructions when that best preserves exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool output, and repetition. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.
If a message contains no significant technical decisions, code changes, or user requirements, produce a minimal one-line summary rather than a detailed one.

MESSAGE IDS
You specify individual raw messages by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages

Each message has an ID inside XML metadata tags like \`<dcp-message-id priority="high">m0007</dcp-message-id>\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as message metadata only, not as content to summarize. Use only the inner \`mNNNN\` value as the \`messageId\`.
The \`priority\` attribute indicates relative context cost. You MUST compress high-priority messages when their full text is no longer necessary for the active task.
If prior compress-tool results are present, always compress and summarize them minimally only as part of a broader compression pass. Do not invoke the compress tool solely to re-compress an earlier compression result.
Messages marked as \`<dcp-message-id>BLOCKED</dcp-message-id>\` cannot be compressed.

Rules:

- Pick each \`messageId\` directly from injected IDs visible in context.
- Only use raw message IDs of the form \`mNNNN\`.
- Ignore XML attributes such as \`priority\` when copying the ID; use only the inner \`mNNNN\` value.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
Select MANY messages in a single tool call when they are safe to compress.
Each entry should summarize exactly one message, and the tool can receive as many entries as needed in one batch.

GENERAL CLEANUP
Use the topic "general cleanup" for broad cleanup passes.
During general cleanup, compress all medium and high-priority messages that are not relevant to the active task.
Optimize for reducing context footprint, not for grouping messages by topic.
Do not compress away still-active instructions, unresolved questions, or constraints that are likely to matter soon.
Prioritize the earliest messages in the context as they will be the least relevant to the active task.
General cleanup should be done periodically between other normal compression tool passes, not as the primary form of compression.
`

export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

SELECTION PROCESS
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working messages unless it is clearly closed.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>
`

export const TURN_NUDGE = `<dcp-system-reminder>
Evaluate the conversation for compressible ranges.

If any messages are cleanly closed and unlikely to be needed again, use the compress tool on them.
If direction has shifted, compress earlier ranges that are now less relevant.

The goal is to filter noise and distill key information so context accumulation stays under control.
Keep active context uncompressed.
</dcp-system-reminder>
`

export const ITERATION_NUDGE = `<dcp-system-reminder>
You've been iterating for a while after the last user message.

If there is a closed portion that is unlikely to be referenced immediately (for example, finished research before implementation), use the compress tool on it now.
</dcp-system-reminder>
`

// ---------------------------------------------------------------------------
// Format extensions — kept separate from editable prompts so they cannot be
// modified via custom-prompt overrides. The schemas must match the tool's
// input validation (see task-7 validateCompressArgs) and are not safe to change
// independently.
// ---------------------------------------------------------------------------

export const RANGE_FORMAT_EXTENSION = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: [               // One or more ranges to compress
    {
      startId: string,     // Boundary ID at range start: mNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNN or bN
      summary: string      // Complete technical summary replacing all content in range
    }
  ]
}
\`\`\``

export const MESSAGE_FORMAT_EXTENSION = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) for the overall batch
  content: [               // One or more messages to compress independently
    {
      messageId: string,   // Raw message ID only: mNNNN (ignore metadata attributes like priority)
      topic: string,       // Short label (3-5 words) for this one message summary
      summary: string      // Complete technical summary replacing that one message
    }
  ]
}
\`\`\``

// ---------------------------------------------------------------------------
// SYSTEM_PHILOSOPHY — distilled subset of DCP lib/prompts/system.ts:1-33.
//
// ZCode H1 constraint: the proxy must NOT modify any field other than messages,
// so we cannot inject an extra system prompt block. We splice this guidance
// into the compress tool's description instead. Wording kept identical to the
// DCP source where unchanged; only re-ordered into a tool-description-friendly
// structure.
// ---------------------------------------------------------------------------

export const SYSTEM_PHILOSOPHY = `
THE PHILOSOPHY OF COMPRESS
You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

The ONLY tool you have for context management is \`compress\`. It replaces older conversation content with technical summaries you produce.

\`compress\` transforms conversation content into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

COMPRESS WHEN

A section is genuinely closed and the raw conversation has served its purpose:

- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Dead-end noise can be discarded without waiting for a whole chapter to close

DO NOT COMPRESS IF

- Raw context is still relevant and needed for edits or precise references
- The target content is still actively in progress
- You may need exact code, error messages, or file contents in the immediate next steps

Before compressing, ask: _"Is this section closed enough to become summary-only right now?"_

Evaluate conversation signal-to-noise REGULARLY. Use \`compress\` deliberately with quality-first summaries. Prioritize stale content intelligently to maintain a high-signal context window that supports your agency.

It is of your responsibility to keep a sharp, high-quality context window for optimal performance.

METADATA TAGS
\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.
`
