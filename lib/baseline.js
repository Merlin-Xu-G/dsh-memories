/**
 * @local/dsh-memories — the session baseline: guidance + memory sections,
 * composed into one durable user-role message spliced at the first eligible
 * `agent/pre-step` (the shipped `@deepseek-ai/dsh-agent-instructions` seam).
 *
 * The baseline ALWAYS contains the "your memory system" guidance section —
 * memory works automatically even before any memory exists. The long-term
 * and workspace indexes are injected WHOLE (no caps since 0.8.0); the
 * short-term note is injected IN FULL (no injection-side calculation — its
 * cap lives in the write path). Message helpers mirror dsh-llm's
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
import { loadIndexSection } from './store.js';

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
    ? `- Write with the \`memory\` tool: \`action: "save"\` appends to the
  short-term note; \`action: "long"\` and \`action: "workspace"\` take a
  \`title\`, an optional one-line \`description\` (at most 1000 chars, no line
  breaks — it becomes the file's "Description:" line and its index entry) and
  the \`text\`, creating/updating one markdown file. Always give long/workspace
  memories a description: files without one are not listed in the index. Do
  not rewrite memory files by hand.
- When a save result says the short-term note is over its cap, compact it
  immediately: \`action: "compact"\` with \`text\` = the rewritten note (you
  decide entry by entry — keep useful ones verbatim, fold related ones into
  dated summary entries, drop finished threads — judging usefulness from each
  entry's text and dates; get under the cap).`
    : `- Writing: the agent tool is not available in this profile, so ask the user
  to run the /memory command (save | long | workspace | show; long and
  workspace take <title> | <description> | <text>).`;
  return `## Your memory system — check it before asking, capture as it happens

You have three personal memory scopes, managed by the dsh-memories plugin:

1. **Global long-term** — durable knowledge about the user, their preferences,
   conventions, and environment; true across projects. One markdown file per
   topic under \`${escapeFrameBody(longTermDir)}\`, injected as its
   name+description index.
2. **Global short-term** — one rolling note "what DSH is working on right now":
   current tasks, pickup points, recent decisions. Date-stamped entries; when a
   save reports the note is over its cap, compact it right away. File: \`${escapeFrameBody(shortTermFile)}\`.
3. **Workspace** — project-local knowledge for this workspace, stored
   centrally under \`${escapeFrameBody(workspaceDir)}\` (one directory per
   workspace), injected as its index for sessions in this workspace only.

Each long-term/workspace index lists \`Title (file-name.md) — description\`; a
memory file carries its one-line description in a \`Description:\` line right
after its \`# Title\` heading. The plugin never writes INDEX.md: it injects the
file when present and otherwise composes the same index read-only from the
files at session start, so freshly written memories appear in new sessions
either way.

**The user never curates memories and will not run the memory command for
you** — writing memories is your job. Capture memories yourself, unprompted
and without asking permission, during the session as things arise, not only
at the end. Standing rules:

- **Before asking the user for information you lack, check memory first.** The
  indexes below say what exists; read the named files with your file tools for
  details (titles map to file names). Only ask the user when memory does not
  answer the question.
- **User corrections and preferences — capture immediately (highest
  priority)**: whenever the user corrects you, states a style, rule, or
  preference, or overrides a default, capture it immediately as a memory
  file. Being corrected twice for the same thing means a capture was missed.
- **Repeated discussions and decisions**: when the same topic or design
  question comes up a second time, or a discussion settles a decision with
  rationale, write or update a topic file so the next session starts from it
  instead of re-deriving.
- **Wrap-up knowledge**: when work reveals durable facts — how this project
  builds, tests, or works; environment facts; tool contracts — write them
  before you declare the work done.
${writePath}
- **Which scope** (route corrections the same way: about this repository's way
  of working → \`workspace\`, about how you should work with the user anywhere
  → \`long\`):
  - knowledge specific to this project — its conventions, commands, layout,
    and design decisions → \`workspace\`;
  - knowledge that crosses projects — the user's workflow preferences,
    machine/environment facts, general tool knowledge → \`long\`;
  - transient state — "where work stands / what is in flight / pickup notes"
    → \`save\`.
- **De-duplicate before writing**: check the injected index below — if a file
  already covers the topic, update that file (keep its title and file name)
  instead of creating a near-duplicate. One topic per file; keep each file
  focused and concise; always include a one-line description.
- \`save\` is for transient pickup notes only. When the knowledge is durable,
  write the durable file NOW — do not park it in the rolling note to age out.
  Only when you are genuinely unsure the knowledge is durable, prefer \`save\`
  — it ages out safely.
- Keep entries concise, factual, and self-contained; never store secrets or
  credentials.
- Mention durable writes briefly in your reply when you make them ("saved
  this preference to long-term memory"); short-term saves need no mention.
- Memory edits apply to NEW sessions; a running session keeps the baseline it
  started with (the /memory command and the memory tool report where they wrote).`;
}

/**
 * Compose the complete baseline text from the guidance plus the three loaded
 * scopes. The guidance section is always present (memory works automatically
 * even before any memory exists); scope sections appear only when non-empty;
 * every section is injected WHOLE — no caps, no truncation markers.
 *
 * @param {object} sections
 * @param {string} sections.guidance frame-safe guidance body.
 * @param {{ text: string, generated: boolean } | undefined} sections.longTerm
 * @param {string | undefined} sections.shortTerm
 * @param {{ text: string, generated: boolean } | undefined} sections.workspace
 * @returns {string} full frame text (never undefined).
 */
export function buildBaselineText({ guidance, longTerm, shortTerm, workspace }) {
  const parts = [];
  parts.push(guidance);
  if (longTerm !== undefined) {
    const source = longTerm.generated
      ? '(no INDEX.md on disk — composed read-only from the files in $DSH_HOME/memories/global-long-term/; the plugin never writes it)'
      : '(from $DSH_HOME/memories/global-long-term/INDEX.md — injected whole, as-is)';
    parts.push(`## Global long-term memory — index

${source}

${escapeFrameBody(longTerm.text)}`);
  }
  if (shortTerm !== undefined) {
    parts.push(`## Global short-term memory — what DSH is working on right now

(from $DSH_HOME/memories/global-short-term.md; newest entries last — injected in full, never truncated)

${escapeFrameBody(shortTerm)}`);
  }
  if (workspace !== undefined) {
    const source = workspace.generated
      ? "(no INDEX.md on disk — composed read-only from the files in this workspace's memory directory; the plugin never writes it — run scripts/generate-index.mjs inside this workspace to keep one)"
      : "(from this workspace memory directory's INDEX.md, generated by scripts/generate-index.mjs — injected whole)";
    parts.push(`## Workspace memory — index

${source}

${escapeFrameBody(workspace.text)}`);
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
