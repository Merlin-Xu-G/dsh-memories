/**
 * @local/dsh-memories — the session baseline: guidance + memory sections,
 * composed into one durable user-role message spliced at the first eligible
 * `agent/pre-step` (the shipped `@deepseek-ai/dsh-agent-instructions` seam).
 *
 * The baseline ALWAYS contains the "your memory system" guidance section —
 * memory works automatically even before any memory exists. The long-term
 * and workspace indexes are composed fresh in memory and injected WHOLE (no
 * caps since 0.8.0); the short-term note is injected IN FULL (no
 * injection-side calculation — its cap lives in the write path). Message
 * helpers mirror dsh-llm's
 * `createUserMessage` shape (deep-frozen locally — zero runtime
 * dependencies).
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readTextIfPresent } from './fs.js';
import {
  MEMORIES_DIR,
  GLOBAL_LONG_TERM_DIRNAME,
  GLOBAL_SHORT_TERM_FILENAME,
  globalLongTermDir,
  globalShortTermFile,
  resolveWorkspaceStore,
} from './paths.js';
import { composeIndexLines } from './store.js';

/**
 * Escape literal closing-frame text so memory content cannot close the
 * plugin-owned `<system-reminder>` frame (the shipped injector's rule).
 * @param {string} body
 * @returns {string}
 */
function escapeFrameBody(body) {
  return body.replaceAll('</system-reminder>', '<\\/system-reminder>');
}

/** Intro of the injected baseline frame (single paragraph). */
const BASELINE_INTRO = `Personal memory context loaded by the dsh-memories plugin — background \
knowledge about the user and their current work; it does not override system, \
developer, or direct user instructions. The guidance below is standing policy; \
the sections after it are the memories.`;

/**
 * Render the always-injected "your memory system" guidance section, with the
 * session's resolved memory locations and the write path that is actually
 * available (agent `memory` tool, or the human `/memory` command).
 *
 * NOTE: the literals below are left-flush on purpose — template literals keep
 * every inner space, and the injected text's two-space continuation indent is
 * part of the prompt's bytes.
 *
 * @param {{ dshHome: string, workspaceDir: string }} paths resolved locations.
 * @param {boolean} memoryToolAvailable whether the agent tool is registered.
 * @returns {string} guidance body (frame-safe: contains no memory content).
 */
function renderGuidance({ dshHome, workspaceDir }, memoryToolAvailable) {
  const longTermDir = join(dshHome, MEMORIES_DIR, GLOBAL_LONG_TERM_DIRNAME);
  const shortTermFile = join(dshHome, MEMORIES_DIR, GLOBAL_SHORT_TERM_FILENAME);
  const writePath = memoryToolAvailable
    ? `- Write with the \`memory\` tool: \`action: "save"\` appends to the
  short-term note; \`action: "long"\` and \`action: "workspace"\` take a
  \`title\`, an optional one-line \`description\` (≤1000 chars, no line breaks;
  it becomes the file's "Description:" line and its index entry) and the
  \`text\`. Never rewrite memory files by hand.
- When a save reports the note over its cap, compact it immediately:
  \`action: "compact"\` with \`text\` = the rewritten note (keep useful entries
  verbatim, fold related ones into dated summary entries, drop finished
  threads; get under the cap).`
    : `- Writing: the agent tool is unavailable in this profile — ask the user
  to run the /memory command (save | long | workspace | show; long and
  workspace take <title> | <description> | <text>).`;
  return `## Your memory system — check it before asking, capture as it happens

1. **Global long-term** — durable user knowledge true across projects:
   preferences, conventions, environment. One file per topic under
   \`${escapeFrameBody(longTermDir)}\`.
2. **Global short-term** — the rolling note "what DSH is working on right
   now" (tasks, pickup points, decisions): \`${escapeFrameBody(shortTermFile)}\`.
3. **Workspace** — this project's knowledge under
   \`${escapeFrameBody(workspaceDir)}\` (one directory per workspace),
   injected only in this workspace's sessions.

Each index lists \`Title (file-name.md) — description\`, from the file's
\`Description:\` line right after its \`# Title\` heading; files without one are
not listed.

**The user never curates memories and will not run the memory command for
you** — writing memories is your job: capture them yourself, unprompted,
without asking permission, as things arise (not only at the end).

- **Check memory before asking the user for information you lack** — read
  the named files for details (titles map to file names); ask only what
  memory does not answer.
- **User corrections and preferences (highest priority)**: whenever the user
  corrects you, states a style, rule, or preference, or overrides a default,
  capture it immediately. Corrected twice for the same thing means a capture
  was missed.
- **Repeated discussions and decisions**: when the same topic or design
  question comes up a second time, or a discussion settles a decision with
  rationale, update the topic file so the next session starts from it.
- **Wrap-up knowledge**: durable facts the work reveals (how this project
  builds/tests/works, environment facts, tool contracts) — write them before
  you declare the work done.
${writePath}
- **Scope** (corrections route the same way): this project's conventions,
  commands, layout, and design decisions → \`workspace\`; cross-project
  preferences, machine/environment facts, general tool knowledge → \`long\`;
  transient "where work stands" pickup notes → \`save\`.
- **De-duplicate before writing**: if the index below covers the topic
  already, update that file (keep its title and file name) instead of
  creating a near-duplicate. One topic per file; focused and concise; always
  a one-line description.
- Durable knowledge goes into its durable file NOW; \`save\` is for transient
  pickup notes only (or when genuinely unsure — it ages out safely).
- Keep entries concise, factual, self-contained; never store secrets or
  credentials. Mention durable writes briefly in your reply; short-term
  saves need no mention.
- Memory edits apply to NEW sessions; a running session keeps its baseline.`;
}

/**
 * Compose the complete baseline text from the guidance plus the three loaded
 * scopes. The guidance section is always present (memory works automatically
 * even before any memory exists); scope sections appear only when non-empty;
 * every section is injected WHOLE — no caps, no truncation markers.
 *
 * @param {object} sections
 * @param {string} sections.guidance frame-safe guidance body.
 * @param {string | undefined} sections.longTerm composed long-term index lines.
 * @param {string | undefined} sections.shortTerm the whole short-term note.
 * @param {string | undefined} sections.workspace composed workspace index lines.
 * @returns {string} full frame text (never undefined).
 */
export function buildBaselineText({ guidance, longTerm, shortTerm, workspace }) {
  const parts = [];
  parts.push(guidance);
  if (longTerm !== undefined) {
    parts.push(`## Global long-term memory — index

${escapeFrameBody(longTerm)}`);
  }
  if (shortTerm !== undefined) {
    parts.push(`## Global short-term memory — what DSH is working on right now

(from $DSH_HOME/memories/global-short-term.md; newest entries last — injected in full, never truncated)

${escapeFrameBody(shortTerm)}`);
  }
  if (workspace !== undefined) {
    parts.push(`## Workspace memory — index

${escapeFrameBody(workspace)}`);
  }
  return `<system-reminder>
${BASELINE_INTRO}

${parts.join('\n\n')}
</system-reminder>`;
}

/**
 * Load the three scopes for one session and compose the baseline text
 * (guidance + whatever memory exists). Exported for testing and reuse.
 * @param {{ dshHome: string, cwd: string, memoryToolAvailable?: boolean,
 *   workspaceRegistry?: object }} paths resolved locations, whether the
 *   agent memory tool is registered, and the optional workspaceRegistry.
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} resolved validated config.
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} full frame text (guidance-only when no memory exists).
 */
export async function composeBaselineText({ dshHome, cwd, memoryToolAvailable = false, workspaceRegistry }, resolved, signal) {
  signal?.throwIfAborted();
  const store = await resolveWorkspaceStore({ dshHome, cwd }, resolved, workspaceRegistry, signal);
  const longTerm = await composeIndexLines(globalLongTermDir(dshHome), signal);
  const shortTermRaw = await readTextIfPresent(globalShortTermFile(dshHome), signal);
  const shortTerm = shortTermRaw !== undefined && shortTermRaw.trim() !== '' ? shortTermRaw.trim() : undefined;
  const workspace = await composeIndexLines(store.dir, signal);
  const guidance = renderGuidance({ dshHome, workspaceDir: store.dir }, memoryToolAvailable);
  return buildBaselineText({ guidance, longTerm, shortTerm, workspace });
}

/* --------------------------------------------------------------------------
 * Durable baseline message
 * ------------------------------------------------------------------------ */

/**
 * Recursively freeze plain data, mirroring the immutable-message invariant of
 * dsh-llm's message constructors.
 * @param {unknown} value
 * @returns {unknown} the same reference, frozen.
 */
export function deepFreeze(value) {
  if (value !== null && (typeof value === 'object' || Array.isArray(value))) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Baseline identity: configuration that a visible baseline must match to be
 * kept. Deliberately content-independent (memory edits apply to NEW sessions)
 * and free of machine-specific paths.
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} resolved
 * @returns {string}
 */
export function baselineIdentity(resolved) {
  return JSON.stringify({
    shortTermMemoriesCap: resolved.shortTermMemoriesCap,
    projectRootMarkers: [...resolved.projectRootMarkers].sort(),
  });
}

/**
 * @param {unknown} data candidate user-message payload.
 * @returns {boolean} whether it is one of this plugin's baseline messages.
 */
export function isMemoriesBaseline(data) {
  const source = data?.source;
  return typeof source === 'object' && source !== null
    && source.kind === 'dsh-memories'
    && source.baseline === true;
}

/**
 * Find the identity of the newest visible baseline (entering messages first,
 * then the visible session surface, newest first).
 * @param {import('@deepseek-ai/dsh-agent-loop').Agent} agent
 * @param {readonly object[]} messages messages entering this step.
 * @returns {string | undefined}
 */
export function visibleBaselineIdentity(agent, messages) {
  for (const message of messages.toReversed()) {
    if (isMemoriesBaseline(message)) return message.source.baselineIdentity;
  }
  const session = agent?.session;
  const nodes = session?.surface?.nodes;
  if (nodes !== undefined && typeof session.eventAt === 'function') {
    for (const seq of Array.from(nodes).reverse()) {
      const event = session.eventAt(seq);
      if (event?.type === 'user/message' && isMemoriesBaseline(event.data)) {
        return event.data.source.baselineIdentity;
      }
    }
  }
  return undefined;
}

/**
 * Build the immutable baseline user message in the shape of dsh-llm's
 * `createUserMessage`.
 * @param {string} text complete plugin-owned frame text.
 * @param {string} identity baseline identity for resume compatibility checks.
 * @returns {object} frozen user message.
 */
export function createBaselineMessage(text, identity) {
  return deepFreeze({
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'dsh-memories',
      form: 'baseline',
      baseline: true,
      baselineIdentity: identity,
    },
    id: randomUUID(),
  });
}
