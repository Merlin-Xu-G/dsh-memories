/**
 * @local/dsh-memories — Host half.
 *
 * A personal DSH memory mechanism with three scopes:
 *
 * 1. GLOBAL LONG-TERM — markdown files under `$DSH_HOME/memories/global-long-term/`.
 *    The directory's `INDEX.md` is what gets injected (hand-editable, or
 *    synthesized read-only from the files' titles when absent).
 * 2. GLOBAL SHORT-TERM — one rolling note `$DSH_HOME/memories/global-short-term.md`
 *    ("what DSH is working on right now"), appended by `/memory save` and the
 *    agent `memory` tool.
 * 3. WORKSPACE — the same long-term mechanism scoped to the current workspace,
 *    stored inside the workspace at `<projectRoot>/.dsh/memories/` so it travels
 *    with the repository (like AGENTS.md).
 *
 * Injection follows the shipped `@deepseek-ai/dsh-agent-instructions` pattern:
 * at the first eligible `agent/pre-step` of a session, one durable user-role
 * baseline message (plugin-owned `<system-reminder>` framing, bounded by
 * configurable per-scope char budgets with honest truncation markers) is
 * spliced into the entering messages right after the last claimed message.
 * The baseline ALWAYS contains a "your memory system" guidance section that
 * introduces the three scopes, when to write each, and the rule to consult
 * memory before asking the user — so memory works automatically even before
 * any memory exists. The message is ordinary session content, so replay,
 * resume, and fork reconstruct it from the log; a visible baseline with a
 * matching identity is never re-injected. Injection is fail-open.
 *
 * Writing happens through three coordinated surfaces that share one code path:
 * the `/memory` human command (save | long | workspace | show), the `memory`
 * agent tool (the same actions, callable by the model), and the web UI's
 * read-only snapshot. The plugin never writes at injection time.
 *
 * Contracts coded against (verified by live inspection of the installed
 * Harness and by reading the extracted built sources of the shipped plugins;
 * the inspected-command record lives in this header — see README "Design
 * notes" for the full list):
 * - `ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => …)`
 *   — waterfall event (payload `{ agent, messages: UserMessage[], turn, step,
 *   signal }`, `next(): Promise<PreStepDecision>`); a listener that does not
 *   own the decision spreads it (`{ ...decision, messages }`).
 * - `agent.session.header.cwd` — absolute session working directory.
 * - `agent.session.surface.nodes` + `agent.session.eventAt(seq)` — visible
 *   session events; `event.type === 'user/message'` carries the message as
 *   `event.data` (with `.source`).
 * - User-message shape mirroring dsh-llm's `createUserMessage`:
 *   `{ role: 'user', content: ContentBlock[], source, id }` (frozen locally).
 * - `ctx.commands.register({ name, description, input: { hint }, recordInput,
 *   handler })` from the `commands` service; handler receives a frozen
 *   `{ commandId, agent, rawInput, attachments, signal }` and returns
 *   `{ kind: 'success', text? }` or `{ kind: 'error', text }`. Commands are
 *   human-only by contract (dsh-commands has no LLM dispatch mode).
 * - `ctx.tools.register(definition)` from the `tools` service (dsh-tools
 *   ToolRuntime.register): `definition` carries `name` (never `run_code`),
 *   `description`, `parameters` (raw JSON Schema, enforced subset:
 *   type/properties/required/additionalProperties/items/enum/const/oneOf),
 *   `output: { schema, render(args, value) => ContentBlock[] }` (render is
 *   validated as a function; output.schema must satisfy the subset check),
 *   and `async execute(args, exec)` returning lossless JSON. `exec` carries
 *   `agent` (so `exec.agent.session.header.cwd` is the session cwd) and
 *   `signal`. Tool errors: a thrown Error settles as an error result.
 * - `ctx.webServer.register(route)` from the `webServer` service
 *   (dsh-host-webserver): `route = { kind: 'exact' | 'prefix', path,
 *   handler(req, res) }`; exact routes win over prefixes; duplicates throw.
 *   Handlers own the full node:http response lifecycle.
 * - `ctx.workspaceRegistry.list()` — `Promise<Workspace[]>`; each Workspace
 *   exposes `.path` (canonical absolute) and `.title`.
 * - `ctx.inject(['commands'], callback)` (cordis Context.inject) starts a
 *   child plugin only while every named service exists and returns its
 *   fiber, whose `dispose()` is this plugin's cleanup.
 * - `export const Config` is consumed through the Standard Schema
 *   `~standard.validate` protocol (cordis `resolveConfig`).
 * - DSH home precedence (dsh-home-paths `resolveDshHome`): explicit configured
 *   path, then a non-blank `$DSH_HOME`, then `~/.dsh`.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Layout under the resolved DSH home (never a machine-specific absolute path in code). */
const MEMORIES_DIR = 'memories';
const GLOBAL_LONG_TERM_DIRNAME = 'global-long-term';
const GLOBAL_SHORT_TERM_FILENAME = 'global-short-term.md';
/** Layout inside a workspace for the workspace-scoped memory. */
const WORKSPACE_MEMORY_SEGMENTS = ['.dsh', 'memories'];
/** The injected artifact of each long-term store. */
const INDEX_FILENAME = 'INDEX.md';
/** Cap on one source memory file read, to bound work on pathological files. */
const MAX_SOURCE_CHARS = 262144;

const TOP_LEVEL_KEYS = new Set([
  'dshHome',
  'longTermMaxChars',
  'shortTermMaxChars',
  'workspaceMaxChars',
  'shortTermFileMaxChars',
  'projectRootMarkers',
]);

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'];
const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..']);
/** Windows reserved device names; a slug that collides gets an `m-` prefix. */
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/* --------------------------------------------------------------------------
 * Config normalization
 * ------------------------------------------------------------------------ */

/**
 * Read a positive-integer option.
 * @param {Record<string, unknown>} raw owner object of the field.
 * @param {string} name field name for diagnostics.
 * @param {number} fallback value used when the field is absent.
 * @returns {number}
 */
function readPositiveInt(raw, name, fallback) {
  const value = raw[name] === undefined ? fallback : raw[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`dsh-memories config "${name}" must be a positive integer`);
  }
  return value;
}

/**
 * Validate and normalize the plugin config. Unknown keys fail at activation
 * so typos never silently disable a budget.
 *
 * @param {unknown} input raw row config; `{}`/`undefined` selects defaults.
 * @returns {Readonly<{dshHome: string | undefined, longTermMaxChars: number,
 *   shortTermMaxChars: number, workspaceMaxChars: number,
 *   shortTermFileMaxChars: number, projectRootMarkers: readonly string[]}>}
 */
function resolveConfig(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-memories config must be an object');
  }
  const unknown = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `dsh-memories config has unknown key(s) ${unknown.join(', ')} — allowed keys: ${[...TOP_LEVEL_KEYS].join(', ')}`,
    );
  }
  let dshHome = raw.dshHome;
  if (dshHome !== undefined) {
    if (typeof dshHome !== 'string' || dshHome.trim() === '') {
      throw new TypeError('dsh-memories config "dshHome" must be a non-empty string when present');
    }
    dshHome = dshHome.trim();
  }
  const markersRaw = raw.projectRootMarkers === undefined
    ? [...DEFAULT_PROJECT_ROOT_MARKERS]
    : raw.projectRootMarkers;
  if (!Array.isArray(markersRaw) || markersRaw.some((m) => typeof m !== 'string' || m.trim() === '')) {
    throw new TypeError('dsh-memories config "projectRootMarkers" must be an array of non-empty strings');
  }
  const projectRootMarkers = Object.freeze(
    markersRaw.filter((m) => !RESERVED_PATH_SEGMENTS.has(m) && !/[\\/]/.test(m)),
  );
  return Object.freeze({
    dshHome,
    longTermMaxChars: readPositiveInt(raw, 'longTermMaxChars', 8192),
    shortTermMaxChars: readPositiveInt(raw, 'shortTermMaxChars', 8192),
    workspaceMaxChars: readPositiveInt(raw, 'workspaceMaxChars', 8192),
    shortTermFileMaxChars: readPositiveInt(raw, 'shortTermFileMaxChars', 16384),
    projectRootMarkers,
  });
}

/**
 * The plugin's Config schema, implementing the Standard Schema `~standard`
 * protocol that cordis `resolveConfig` calls (`Config['~standard'].validate`).
 * Dependency-free on purpose: a local bundle must not need zod or Schemastery
 * installed beside it.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: '@local/dsh-memories',
    validate(raw) {
      try {
        return { value: resolveConfig(raw) };
      } catch (error) {
        return {
          issues: [
            {
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  },
};

/* --------------------------------------------------------------------------
 * Path resolution
 * ------------------------------------------------------------------------ */

/**
 * Expand supported tilde prefixes against the OS home (dsh-home-paths parity).
 * @param {string} path
 * @returns {string}
 */
function expandHomePath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the DSH home with the shipped precedence: explicit configured path,
 * then non-blank `$DSH_HOME`, then `~/.dsh`.
 * @param {string | undefined} configured explicit override, highest precedence.
 * @param {Record<string, string | undefined>} [env] environment mapping.
 * @returns {string} normalized absolute harness home path.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env.DSH_HOME;
  const raw = configured !== undefined && configured !== null
    ? configured
    : (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'));
  return resolve(expandHomePath(raw.trim()));
}

/**
 * Climb from `cwd` while no project-root marker is present; with no marker
 * anywhere, the session cwd itself is the root. Probe failures are treated as
 * absence (fail-open: memory discovery must never break a session).
 * @param {string} cwd absolute session working directory.
 * @param {readonly string[]} markers directory names marking the project root.
 * @returns {Promise<string>} absolute project root.
 */
export async function findProjectRoot(cwd, markers) {
  const start = resolve(cwd);
  let current = start;
  for (;;) {
    for (const marker of markers) {
      if (await pathExists(join(current, marker))) return current;
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/** Global long-term memory directory under a resolved DSH home. */
function globalLongTermDir(dshHome) {
  return join(dshHome, MEMORIES_DIR, GLOBAL_LONG_TERM_DIRNAME);
}

/** Global short-term note file under a resolved DSH home. */
function globalShortTermFile(dshHome) {
  return join(dshHome, MEMORIES_DIR, GLOBAL_SHORT_TERM_FILENAME);
}

/* --------------------------------------------------------------------------
 * Small filesystem helpers (node:fs, fail-open)
 * ------------------------------------------------------------------------ */

/**
 * @param {string} path
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function pathExists(path, signal) {
  try {
    await stat(path, { signal });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.name === 'AbortError') return false;
    // Permission or transient I/O failure: treat as absent (fail-open).
    return false;
  }
}

/**
 * @param {string} path
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function isDirectory(path, signal) {
  try {
    return (await stat(path, { signal })).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a UTF-8 file, returning `undefined` when it does not exist.
 * @param {string} path
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | undefined>}
 */
async function readTextIfPresent(path, signal) {
  try {
    return await readFile(path, 'utf8', { signal });
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/* --------------------------------------------------------------------------
 * Memory content loading and rendering
 * ------------------------------------------------------------------------ */

/**
 * Extract the title (first `# ` heading) and one summary line (first
 * non-heading, non-empty line) from a memory file's text.
 * @param {string} text
 * @param {string} fallbackTitle
 * @returns {{ title: string, summary: string }}
 */
function extractTitleAndSummary(text, fallbackTitle) {
  const lines = text.split(/\r?\n/);
  let title = '';
  let summary = '';
  for (const line of lines) {
    if (title === '') {
      const heading = /^#\s+(.*)$/.exec(line);
      if (heading) {
        title = heading[1].trim();
        continue;
      }
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    summary = trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
    break;
  }
  return { title: title === '' ? fallbackTitle : title, summary };
}

/**
 * List the memory files (`*.md`, except the index) of a directory, sorted by name.
 * @param {string} dir
 * @param {AbortSignal} [signal]
 * @returns {Promise<readonly string[]>} file names, possibly empty.
 */
async function listMemoryFiles(dir, signal) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, signal });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== INDEX_FILENAME)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/**
 * Build one UI snapshot file row: name, title, summary, and character count.
 * Read-only; unreadable files degrade to name-only rows.
 * @param {string} dir
 * @param {string} name
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ name: string, title: string, summary: string, chars: number }>}
 */
async function memoryFileRow(dir, name, signal) {
  const fallback = name.slice(0, -'.md'.length);
  const text = await readTextIfPresent(join(dir, name), signal);
  if (text === undefined) return { name, title: fallback, summary: '', chars: 0 };
  const { title, summary } = extractTitleAndSummary(text.slice(0, MAX_SOURCE_CHARS), fallback);
  return { name, title, summary, chars: text.length };
}

/**
 * Synthesize an index body from the memory files of a directory: one list
 * entry per file (title, file name, first summary line). Read-only.
 * @param {string} dir
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | undefined>} index body, or undefined when empty.
 */
async function synthesizeIndex(dir, signal) {
  const names = await listMemoryFiles(dir, signal);
  if (names.length === 0) return undefined;
  const lines = [];
  for (const name of names) {
    const text = await readTextIfPresent(join(dir, name), signal);
    const fallback = name.slice(0, -'.md'.length);
    const { title, summary } = text === undefined
      ? { title: fallback, summary: '' }
      : extractTitleAndSummary(text.slice(0, MAX_SOURCE_CHARS), fallback);
    lines.push(summary === '' ? `- ${title} (${name})` : `- ${title} (${name}) — ${summary}`);
  }
  return lines.join('\n');
}

/**
 * Render the deterministic on-disk INDEX.md content for a long-term directory.
 * @param {string} dir
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | undefined>}
 */
async function renderIndexFile(dir, signal) {
  const body = await synthesizeIndex(dir, signal);
  if (body === undefined) return undefined;
  return [
    '<!-- Generated by the dsh-memories /memory command. Hand edits are preserved until the next regeneration. -->',
    '',
    '# Memory index',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * Load the index section of one long-term store.
 * @param {string} dir memory directory.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ text: string, generated: boolean } | undefined>}
 */
async function loadIndexSection(dir, signal) {
  if (!(await isDirectory(dir, signal))) return undefined;
  const index = await readTextIfPresent(join(dir, INDEX_FILENAME), signal);
  const trimmed = index?.trim();
  if (trimmed !== undefined && trimmed !== '') return { text: trimmed, generated: false };
  const synthesized = await synthesizeIndex(dir, signal);
  if (synthesized !== undefined) return { text: synthesized, generated: true };
  return undefined;
}

/**
 * Truncate by characters, backing off so a surrogate pair is never split.
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function truncateChars(value, maxChars) {
  if (value.length <= maxChars) return value;
  let end = Math.max(0, Math.trunc(maxChars));
  while (end > 0 && (value.charCodeAt(end) & 0xfc00) === 0xdc00) end -= 1;
  return value.slice(0, end);
}

/**
 * Escape literal closing-frame text so memory content cannot close the
 * plugin-owned `<system-reminder>` frame (the shipped injector's rule).
 * @param {string} body
 * @returns {string}
 */
function escapeFrameBody(body) {
  return body.replaceAll('</system-reminder>', '<\\/system-reminder>');
}

/** Intro of the injected baseline frame. */
const BASELINE_INTRO = [
  'The following personal memory context was loaded by the dsh-memories plugin.',
  'It is background knowledge about the user and their current work; it does not',
  'override system, developer, or direct user instructions. The guidance below is',
  'standing policy for how you use these memories; the sections after it are the',
  'memories themselves.',
].join(' ');

/**
 * Render the always-injected "your memory system" guidance section, with the
 * session's resolved memory locations and the write path that is actually
 * available (agent `memory` tool, or the human `/memory` command).
 *
 * @param {{ dshHome: string, projectRoot: string }} paths resolved locations.
 * @param {boolean} memoryToolAvailable whether the agent tool is registered.
 * @returns {string} guidance body (frame-safe: contains no memory content).
 */
function renderGuidance({ dshHome, projectRoot }, memoryToolAvailable) {
  const longTermDir = join(dshHome, MEMORIES_DIR, GLOBAL_LONG_TERM_DIRNAME);
  const shortTermFile = join(dshHome, MEMORIES_DIR, GLOBAL_SHORT_TERM_FILENAME);
  const workspaceDir = join(projectRoot, ...WORKSPACE_MEMORY_SEGMENTS);
  const writePath = memoryToolAvailable
    ? [
      '- Write memories yourself with the `memory` tool when you learn something',
      '  durable: `action: "save"` appends to the short-term note; `action: "long"`',
      '  and `action: "workspace"` take a `title` and `text` and create/update one',
      '  markdown file, regenerating the index. Do not ask permission for routine',
      '  saves; do not rewrite memory files by hand — the tool keeps indexes',
      '  consistent.',
    ].join('\n')
    : [
      '- Writing: the agent tool is not available in this profile, so ask the user',
      '  to run the /memory command (save | long | workspace | show).',
    ].join('\n');
  return [
    '## Your memory system — check it before asking, write it when you learn',
    '',
    'You have three personal memory scopes, managed by the dsh-memories plugin:',
    '',
    `1. **Global long-term** — durable knowledge about the user, their preferences,`,
    '   conventions, and environment; true across projects. One markdown file per',
    `   topic under \`${escapeFrameBody(longTermDir)}\`, injected as its INDEX.md index.`,
    `2. **Global short-term** — one rolling note "what DSH is working on right now":`,
    '   current tasks, pickup points, recent decisions. Timestamped entries, oldest',
    `   drop off. File: \`${escapeFrameBody(shortTermFile)}\`.`,
    '3. **Workspace** — project-local knowledge that travels with this repository.',
    `   Files under \`${escapeFrameBody(workspaceDir)}\`, injected as its index for`,
    '   sessions in this workspace only.',
    '',
    'Standing rules:',
    '',
    '- **Before asking the user for information you lack, check memory first.** The',
    '  indexes below say what exists; read the named files with your file tools for',
    '  details (titles map to file names). Only ask the user when memory does not',
    '  answer the question.',
    writePath,
    '- **Which scope**: cross-project facts about the user and their world → `long`;',
    '  "where work stands / what is in flight / pickup notes" → `save`; knowledge',
    '  meaningful only inside this repository → `workspace`.',
    '- Keep entries concise, factual, and self-contained; never store secrets or',
    '  credentials. When unsure whether something is worth keeping, prefer `save` —',
    '  it ages out of the rolling note.',
    '- Memory edits apply to NEW sessions; a running session keeps the baseline it',
    '  started with (the /memory command and the memory tool report where they wrote).',
  ].join('\n');
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
  return [
    escapeFrameBody(shown),
    '',
    `[memory truncated: showing ${shown.length} of ${text.length} characters to fit the configured budget]`,
  ].join('\n');
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
 * @param {ReturnType<typeof resolveConfig>} resolved validated config.
 * @returns {string} full frame text (never undefined).
 */
export function buildBaselineText({ guidance, longTerm, shortTerm, workspace }, resolved) {
  const parts = [];
  parts.push(guidance);
  if (longTerm !== undefined) {
    const source = longTerm.generated
      ? '(generated from the files in $DSH_HOME/memories/global-long-term/ — no INDEX.md yet)'
      : '(from $DSH_HOME/memories/global-long-term/INDEX.md)';
    parts.push([
      '## Global long-term memory — index',
      '',
      source,
      '',
      renderSectionBody(longTerm.text, resolved.longTermMaxChars),
    ].join('\n'));
  }
  if (shortTerm !== undefined) {
    parts.push([
      '## Global short-term memory — what DSH is working on right now',
      '',
      '(from $DSH_HOME/memories/global-short-term.md; newest entries last)',
      '',
      renderSectionBody(shortTerm, resolved.shortTermMaxChars),
    ].join('\n'));
  }
  if (workspace !== undefined) {
    const source = workspace.generated
      ? '(generated from the files in .dsh/memories/ of this workspace — no INDEX.md yet)'
      : '(from .dsh/memories/INDEX.md of this workspace)';
    parts.push([
      '## Workspace memory — index',
      '',
      source,
      '',
      renderSectionBody(workspace.text, resolved.workspaceMaxChars),
    ].join('\n'));
  }
  return [
    '<system-reminder>',
    BASELINE_INTRO,
    '',
    parts.join('\n\n'),
    '</system-reminder>',
  ].join('\n');
}

/**
 * Load the three scopes for one session and compose the baseline text
 * (guidance + whatever memory exists). Exported for testing and reuse.
 * @param {{ dshHome: string, cwd: string, memoryToolAvailable?: boolean }} paths
 *   resolved locations plus whether the agent memory tool is registered.
 * @param {ReturnType<typeof resolveConfig>} resolved validated config.
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} full frame text (guidance-only when no memory exists).
 */
export async function composeBaselineText({ dshHome, cwd, memoryToolAvailable = false }, resolved, signal) {
  signal?.throwIfAborted();
  const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers);
  const longTerm = await loadIndexSection(globalLongTermDir(dshHome), signal);
  const shortTermRaw = await readTextIfPresent(globalShortTermFile(dshHome), signal);
  const shortTerm = shortTermRaw !== undefined && shortTermRaw.trim() !== '' ? shortTermRaw.trim() : undefined;
  const workspace = await loadIndexSection(join(projectRoot, ...WORKSPACE_MEMORY_SEGMENTS), signal);
  const guidance = renderGuidance({ dshHome, projectRoot }, memoryToolAvailable);
  return buildBaselineText({ guidance, longTerm, shortTerm, workspace }, resolved);
}

/* --------------------------------------------------------------------------
 * Web UI snapshot (read-only)
 * ------------------------------------------------------------------------ */

/**
 * Snapshot one long-term store for the Memories panel: index text plus file
 * rows (name, title, summary, chars) — never file bodies.
 * @param {string} dir memory directory.
 * @param {AbortSignal} [signal]
 */
async function snapshotLongTerm(dir, signal) {
  if (!(await isDirectory(dir, signal))) {
    return { present: false, dir, indexGenerated: false, indexText: '', files: [] };
  }
  const section = await loadIndexSection(dir, signal);
  const names = await listMemoryFiles(dir, signal);
  const files = [];
  for (const name of names) files.push(await memoryFileRow(dir, name, signal));
  return {
    present: true,
    dir,
    indexGenerated: section?.generated ?? false,
    indexText: section?.text ?? '',
    files,
  };
}

/**
 * Build the JSON snapshot the Memories panel renders: full short-term note
 * content, long-term and workspace stores as index + file locations only.
 * Read-only; failures inside one scope degrade that scope, never the rest.
 *
 * @param {{ dshHome: string }} paths resolved locations.
 * @param {ReturnType<typeof resolveConfig>} resolved validated config.
 * @param {readonly { title: string, path: string }[]} workspaces registered
 *   workspace roots to scan for workspace memory (may be empty).
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} JSON-safe snapshot.
 */
export async function buildMemoriesSnapshot({ dshHome }, resolved, workspaces, signal) {
  signal?.throwIfAborted();
  const shortTermPath = globalShortTermFile(dshHome);
  const shortTermRaw = await readTextIfPresent(shortTermPath, signal);
  const shortTerm = shortTermRaw === undefined || shortTermRaw.trim() === ''
    ? { present: false, path: shortTermPath, chars: 0, content: '' }
    : { present: true, path: shortTermPath, chars: shortTermRaw.length, content: shortTermRaw };
  const longTerm = await snapshotLongTerm(globalLongTermDir(dshHome), signal);
  const workspaceSections = [];
  for (const workspace of workspaces) {
    const dir = join(workspace.path, ...WORKSPACE_MEMORY_SEGMENTS);
    const store = await snapshotLongTerm(dir, signal);
    if (store.present) {
      workspaceSections.push({ title: workspace.title, root: workspace.path, ...store });
    }
  }
  return {
    kind: 'dsh-memories-snapshot',
    version: 1,
    generatedAt: new Date().toISOString(),
    dshHome,
    shortTermMaxChars: resolved.shortTermMaxChars,
    shortTerm,
    longTerm,
    workspaces: workspaceSections,
  };
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
function deepFreeze(value) {
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
 * @param {ReturnType<typeof resolveConfig>} resolved
 * @returns {string}
 */
function baselineIdentity(resolved) {
  return JSON.stringify({
    longTermMaxChars: resolved.longTermMaxChars,
    shortTermMaxChars: resolved.shortTermMaxChars,
    workspaceMaxChars: resolved.workspaceMaxChars,
    projectRootMarkers: [...resolved.projectRootMarkers].sort(),
  });
}

/**
 * @param {unknown} data candidate user-message payload.
 * @returns {boolean} whether it is one of this plugin's baseline messages.
 */
function isMemoriesBaseline(data) {
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
function visibleBaselineIdentity(agent, messages) {
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
function createBaselineMessage(text, identity) {
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

/* --------------------------------------------------------------------------
 * Memory writing (shared by the /memory command and the memory tool)
 * ------------------------------------------------------------------------ */

const MEMORY_USAGE = [
  'Usage:',
  '  /memory save <text>                 — append a timestamped note to global short-term memory',
  '  /memory long <title> | <text>       — create/update a global long-term memory file and refresh INDEX.md',
  '  /memory workspace <title> | <text>  — create/update a workspace memory file (.dsh/memories/) and refresh its INDEX.md',
  '  /memory show                        — preview exactly what a new session would receive',
].join('\n');

/**
 * @param {string} rawInput
 * @returns {{ sub: string, args: string }}
 */
function parseInvocation(rawInput) {
  const trimmed = rawInput.trim();
  if (trimmed === '') return { sub: '', args: '' };
  const spaceAt = trimmed.indexOf(' ');
  if (spaceAt === -1) return { sub: trimmed, args: '' };
  return { sub: trimmed.slice(0, spaceAt), args: trimmed.slice(spaceAt + 1).trim() };
}

/**
 * @param {string} title
 * @returns {string} kebab-case slug, never empty, Windows-reserved-safe.
 */
function slugify(title) {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (slug === '') {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    return `memory-${stamp}`;
  }
  return WINDOWS_RESERVED_NAMES.has(slug) ? `m-${slug}` : slug;
}

/**
 * Append one timestamped entry to the global short-term note, then drop the
 * oldest entries while the file exceeds the retention bound (always keeping
 * at least the newest entry).
 * @param {string} dshHome
 * @param {string} text
 * @param {number} fileMax retention bound in characters.
 * @returns {Promise<{ path: string, chars: number }>}
 */
async function appendShortTerm(dshHome, text, fileMax) {
  const file = globalShortTermFile(dshHome);
  await mkdir(dirname(file), { recursive: true });
  const existing = (await readTextIfPresent(file)) ?? '';
  const lines = existing.trim() === '' ? [] : existing.replace(/\r?\n$/, '').split(/\r?\n/);
  lines.push(`- [${new Date().toISOString()}] ${text}`);
  while (lines.length > 1 && lines.join('\n').length > fileMax) lines.shift();
  const content = `${lines.join('\n')}\n`;
  await writeFile(file, content, 'utf8');
  return { path: file, chars: content.length };
}

/**
 * Create/update one long-term memory file and regenerate the directory's
 * INDEX.md deterministically.
 * @param {string} dir memory directory (global long-term or workspace).
 * @param {string} title memory title (becomes the `# ` heading).
 * @param {string} body memory body text.
 * @returns {Promise<{ file: string, index: string }>} display-relative names.
 */
async function writeLongTermMemory(dir, title, body) {
  await mkdir(dir, { recursive: true });
  const fileName = `${slugify(title)}.md`;
  await writeFile(join(dir, fileName), `# ${title}\n\n${body}\n`, 'utf8');
  const index = await renderIndexFile(dir);
  if (index !== undefined) await writeFile(join(dir, INDEX_FILENAME), index, 'utf8');
  return { file: fileName, index: INDEX_FILENAME };
}

/**
 * The /memory command handler body (pure helper; the registered handler wraps
 * it and converts thrown errors into error results).
 * @param {{ dshHome: string, cwd: string }} paths resolved locations.
 * @param {ReturnType<typeof resolveConfig>} resolved validated config.
 * @param {string} rawInput
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
async function runMemoryCommand({ dshHome, cwd }, resolved, rawInput, signal) {
  const { sub, args } = parseInvocation(rawInput);
  switch (sub) {
    case 'save': {
      if (args === '') return { kind: 'error', text: MEMORY_USAGE };
      const { chars } = await appendShortTerm(dshHome, args, resolved.shortTermFileMaxChars);
      return {
        kind: 'success',
        text: `Saved to global short-term memory ($DSH_HOME/${MEMORIES_DIR}/${GLOBAL_SHORT_TERM_FILENAME}, now ${chars} chars; new sessions inject its newest ${resolved.shortTermMaxChars} chars).`,
      };
    }
    case 'long':
    case 'workspace': {
      const separator = args.indexOf('|');
      if (separator === -1) {
        return { kind: 'error', text: `${MEMORY_USAGE}\n\n"${sub}" needs a "|" separating title and text.` };
      }
      const title = args.slice(0, separator).trim();
      const body = args.slice(separator + 1).trim();
      if (title === '' || body === '') {
        return { kind: 'error', text: `"${sub}" needs a non-empty title and text, separated by "|".` };
      }
      if (sub === 'workspace') {
        signal?.throwIfAborted();
        const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers);
        const dir = join(projectRoot, ...WORKSPACE_MEMORY_SEGMENTS);
        const written = await writeLongTermMemory(dir, title, body);
        return {
          kind: 'success',
          text: `Workspace memory saved: .dsh/${MEMORIES_DIR}/${written.file} ("${title}"); ${written.index} regenerated (new sessions in this workspace see it).`,
        };
      }
      const written = await writeLongTermMemory(globalLongTermDir(dshHome), title, body);
      return {
        kind: 'success',
        text: `Global long-term memory saved: $DSH_HOME/${MEMORIES_DIR}/${GLOBAL_LONG_TERM_DIRNAME}/${written.file} ("${title}"); ${written.index} regenerated (new sessions see it).`,
      };
    }
    case 'show': {
      const text = await composeBaselineText({ dshHome, cwd, memoryToolAvailable: true }, resolved, signal);
      return {
        kind: 'success',
        text: `What a NEW session in this workspace would receive:\n\n${text}`,
      };
    }
    default:
      return { kind: 'error', text: MEMORY_USAGE };
  }
}

/**
 * The agent `memory` tool body: the same store and code path as the /memory
 * command, structured arguments instead of a command line, and a plain
 * `{ ok, message }` result (thrown Errors settle as tool error results).
 * Exported for testing.
 *
 * @param {{ dshHome: string, cwd: string }} paths resolved locations.
 * @param {ReturnType<typeof resolveConfig>} resolved validated config.
 * @param {{ action: 'save' | 'long' | 'workspace', title?: string, text: string }} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function runMemoryTool({ dshHome, cwd }, resolved, { action, title, text }, signal) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('memory tool: "text" must be a non-empty string.');
  }
  signal?.throwIfAborted();
  if (action === 'save') {
    const { chars } = await appendShortTerm(dshHome, text.trim(), resolved.shortTermFileMaxChars);
    return {
      ok: true,
      message: `Saved to global short-term memory (now ${chars} chars; new sessions see its newest ${resolved.shortTermMaxChars} chars).`,
    };
  }
  if (action === 'long' || action === 'workspace') {
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    if (trimmedTitle === '') {
      throw new Error(`memory tool: action "${action}" needs a non-empty "title".`);
    }
    const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers);
    const dir = action === 'workspace'
      ? join(projectRoot, ...WORKSPACE_MEMORY_SEGMENTS)
      : globalLongTermDir(dshHome);
    const written = await writeLongTermMemory(dir, trimmedTitle, text.trim());
    const where = action === 'workspace'
      ? `Workspace memory saved: ${written.file} ("${trimmedTitle}") under ${dir}; ${written.index} regenerated (new sessions in this workspace see it).`
      : `Global long-term memory saved: ${written.file} ("${trimmedTitle}") under ${dir}; ${written.index} regenerated (new sessions see it).`;
    return { ok: true, message: where };
  }
  throw new Error('memory tool: "action" must be one of "save", "long", "workspace".');
}

/**
 * The raw ToolDefinition handed to `ctx.tools.register` (dsh-tools
 * ToolRuntime.register contract; parameters/output stay inside the enforced
 * JSON Schema subset: type/properties/required/additionalProperties/items/enum).
 *
 * @param {{ dshHome: string }} paths resolved locations.
 * @param {ReturnType<typeof resolveConfig>} resolved validated config.
 * @returns {object} ToolDefinition.
 */
function memoryToolDefinition({ dshHome }, resolved) {
  return {
    name: 'memory',
    description: 'Write to the user\'s personal DSH memories. action "save" appends a timestamped note to the global short-term rolling note (current work, pickup points); "long" creates/updates a global long-term memory file (durable cross-project knowledge about the user); "workspace" does the same in this workspace\'s .dsh/memories/ (repo-local knowledge). Files and indexes are kept consistent automatically.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'long', 'workspace'],
          description: 'Which memory scope to write: "save" (short-term note), "long" (global long-term file), "workspace" (workspace-local file).',
        },
        title: {
          type: 'string',
          description: 'Memory title (required for "long" and "workspace"; becomes the file name and heading). Ignored for "save".',
        },
        text: {
          type: 'string',
          description: 'The memory text to store. For "save" one concise line works best.',
        },
      },
      required: ['action', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      return await runMemoryTool({ dshHome, cwd }, resolved, args, exec?.signal);
    },
  };
}

/* --------------------------------------------------------------------------
 * Plugin entry
 * ------------------------------------------------------------------------ */

/**
 * Host plugin entry. Registers the `agent/pre-step` baseline injector on the
 * plugin context, the `/memory` command against the optional `commands`
 * service, the agent `memory` tool against the optional `tools` service, and
 * the Memories-panel snapshot route against the optional `webServer` service;
 * returns disposal of all injected fibers as cleanup. Every optional surface
 * is fail-soft: a missing service or a memory error never breaks a step.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config raw row config (already validated via `Config`).
 * @returns {() => void} cleanup.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const identity = baselineIdentity(resolved);
  const dshHome = resolveDshHome(resolved.dshHome);
  /** Flipped while the agent memory tool is registered; the guidance mirrors it. */
  const memoryToolAvailable = { current: false };

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    try {
      const visible = visibleBaselineIdentity(agent, decision.messages);
      if (visible === identity) return decision;
      signal.throwIfAborted();
      const cwd = agent?.session?.header?.cwd ?? process.cwd();
      const text = await composeBaselineText(
        { dshHome, cwd, memoryToolAvailable: memoryToolAvailable.current },
        resolved,
        signal,
      );
      const desired = createBaselineMessage(text, identity);
      const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
      const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
      return { ...decision, messages: entered };
    } catch (error) {
      if (error?.name === 'AbortError') return decision;
      ctx.logger.warn('dsh-memories baseline injection failed: %o', error);
      return decision;
    }
  });

  const commandsFiber = ctx.inject(['commands'], (commandCtx) => {
    return commandCtx.commands.register({
      name: 'memory',
      description: 'Save or preview personal DSH memories (short-term, long-term, workspace)',
      input: {
        hint: '<save|long|workspace|show> [args]',
      },
      // Writes are summarized in the command result; echoing the raw input
      // too would duplicate the memory text in the session log.
      recordInput: false,
      handler: async ({ agent, rawInput = '', signal }) => {
        try {
          const cwd = agent?.session?.header?.cwd ?? process.cwd();
          return await runMemoryCommand({ dshHome, cwd }, resolved, rawInput, signal);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          return {
            kind: 'error',
            text: `/memory failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    });
  });

  const toolsFiber = ctx.inject(['tools'], (toolCtx) => {
    const dispose = toolCtx.tools.register(memoryToolDefinition({ dshHome }, resolved));
    memoryToolAvailable.current = true;
    return () => {
      memoryToolAvailable.current = false;
      dispose();
    };
  });

  const webFiber = ctx.inject(['webServer'], (webCtx) => {
    return webCtx.webServer.register({
      kind: 'exact',
      path: '/memories/snapshot.json',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
            res.end(JSON.stringify({ error: 'method not allowed' }));
            return;
          }
          let workspaces = [];
          try {
            const registry = webCtx.get('workspaceRegistry');
            if (registry !== undefined && typeof registry.list === 'function') {
              const listed = await registry.list();
              workspaces = listed.map((workspace) => ({ title: workspace.title, path: workspace.path }));
            }
          } catch (error) {
            ctx.logger.warn('dsh-memories snapshot workspace listing failed: %o', error);
          }
          const snapshot = await buildMemoriesSnapshot({ dshHome }, resolved, workspaces);
          const body = JSON.stringify(snapshot);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch (error) {
          ctx.logger.warn('dsh-memories snapshot failed: %o', error);
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          }
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      },
    });
  });

  return () => {
    commandsFiber.dispose();
    toolsFiber.dispose();
    webFiber.dispose();
  };
}
