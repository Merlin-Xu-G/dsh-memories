/**
 * @local/dsh-memories — the session baseline: guidance + memory sections,
 * composed into one durable user-role message spliced at the first eligible
 * `agent/pre-step` (the shipped `@deepseek-ai/dsh-agent-instructions` seam).
 *
 * The baseline ALWAYS contains the "your memory system" guidance section —
 * memory works automatically even before any memory exists. The long-term
 * and workspace index sections are bounded by their configured char budgets
 * with honest truncation markers; the short-term note is injected IN FULL
 * (no injection-side calculation — the cap lives in the write path).
 * Message helpers mirror dsh-llm's `createUserMessage` shape
 * (deep-frozen locally — zero runtime dependencies).
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
import { loadIndexSection, truncateChars } from './store.js';

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
const BASELINE_INTRO = `The following personal memory context was loaded by the dsh-memories plugin. \
It is background knowledge about the user and their current work; it does not \
override system, developer, or direct user instructions. The guidance below is \
standing policy for how you use these memories; the sections after it are the \
memories themselves.`;

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
    ? `- Write memories yourself with the \`memory\` tool when you learn something
  durable: \`action: "save"\` appends to the short-term note; \`action: "long"\`
  and \`action: "workspace"\` take a \`title\` and \`text\` and create/update one
  markdown file, regenerating the index. Do not ask permission for routine
  saves; do not rewrite memory files by hand — the tool keeps indexes
  consistent.
- When a save result says the short-term note is over its cap, compact it
  immediately: \`action: "compact"\` with \`text\` = the rewritten note (you
  decide entry by entry — keep useful ones verbatim, fold related ones into
  dated summary entries, drop finished threads — judging usefulness from each
  entry's text and dates; get under the cap).`
    : `- Writing: the agent tool is not available in this profile, so ask the user
  to run the /memory command (save | long | workspace | show).`;
  return `## Your memory system — check it before asking, write it when you learn

You have three personal memory scopes, managed by the dsh-memories plugin:

1. **Global long-term** — durable knowledge about the user, their preferences,
   conventions, and environment; true across projects. One markdown file per
   topic under \`${escapeFrameBody(longTermDir)}\`, injected as its INDEX.md index.
2. **Global short-term** — one rolling note "what DSH is working on right now":
   current tasks, pickup points, recent decisions. Date-stamped entries; when a
   save reports the note is over its cap, compact it right away. File: \`${escapeFrameBody(shortTermFile)}\`.
3. **Workspace** — project-local knowledge for this workspace, stored
   centrally under \`${escapeFrameBody(workspaceDir)}\` (one directory per
   workspace), injected as its index for sessions in this workspace only.

Standing rules:

- **Before asking the user for information you lack, check memory first.** The
  indexes below say what exists; read the named files with your file tools for
  details (titles map to file names). Only ask the user when memory does not
  answer the question.
${writePath}
- **Which scope**: cross-project facts about the user and their world → \`long\`;
  "where work stands / what is in flight / pickup notes" → \`save\`; knowledge
  meaningful only inside this repository → \`workspace\`.
- Keep entries concise, factual, and self-contained; never store secrets or
  credentials. When unsure whether something is worth keeping, prefer \`save\` —
  it ages out of the rolling note.
- Memory edits apply to NEW sessions; a running session keeps the baseline it
  started with (the /memory command and the memory tool report where they wrote).`;
}

/**
 * Render one bounded section body with an honest truncation marker.
 * @param {string} text raw section content.
 * @param {number} budget max characters for this section.
 * @returns {string} escaped, budgeted body.
 */
function renderSectionBody(text, budget) {
  if (text.length <= budget) return escapeFrameBody(text);
  const shown = truncateChars(text, budget);
  return `${escapeFrameBody(shown)}

[memory truncated: showing ${shown.length} of ${text.length} characters to fit the configured budget]`;
}

/**
 * Compose the complete baseline text from the guidance plus the three loaded
 * scopes. The guidance section is always present (memory works automatically
 * even before any memory exists); scope sections appear only when non-empty.
 *
 * @param {object} sections
 * @param {string} sections.guidance frame-safe guidance body.
 * @param {{ text: string, generated: boolean } | undefined} sections.longTerm
 * @param {string | undefined} sections.shortTerm
 * @param {{ text: string, generated: boolean } | undefined} sections.workspace
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} resolved validated config.
 * @returns {string} full frame text (never undefined).
 */
export function buildBaselineText({ guidance, longTerm, shortTerm, workspace }, resolved) {
  const parts = [];
  parts.push(guidance);
  if (longTerm !== undefined) {
    const source = longTerm.generated
      ? '(generated from the files in $DSH_HOME/memories/global-long-term/ — no INDEX.md yet)'
      : '(from $DSH_HOME/memories/global-long-term/INDEX.md)';
    parts.push(`## Global long-term memory — index

${source}

${renderSectionBody(longTerm.text, resolved.longTermMaxChars)}`);
  }
  if (shortTerm !== undefined) {
    parts.push(`## Global short-term memory — what DSH is working on right now

(from $DSH_HOME/memories/global-short-term.md; newest entries last — injected in full, never truncated)

${escapeFrameBody(shortTerm)}`);
  }
  if (workspace !== undefined) {
    const source = workspace.generated
      ? "(generated from the files in this workspace's memory directory — no INDEX.md yet)"
      : "(from this workspace memory directory's INDEX.md)";
    parts.push(`## Workspace memory — index

${source}

${renderSectionBody(workspace.text, resolved.workspaceMaxChars)}`);
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
  const longTerm = await loadIndexSection(globalLongTermDir(dshHome), signal);
  const shortTermRaw = await readTextIfPresent(globalShortTermFile(dshHome), signal);
  const shortTerm = shortTermRaw !== undefined && shortTermRaw.trim() !== '' ? shortTermRaw.trim() : undefined;
  const workspace = await loadIndexSection(store.dir, signal);
  const guidance = renderGuidance({ dshHome, workspaceDir: store.dir }, memoryToolAvailable);
  return buildBaselineText({ guidance, longTerm, shortTerm, workspace }, resolved);
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
    longTermMaxChars: resolved.longTermMaxChars,
    shortTermMemoriesCap: resolved.shortTermMemoriesCap,
    workspaceMaxChars: resolved.workspaceMaxChars,
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
