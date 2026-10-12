/**
 * @local/dsh-memories — Host half.
 *
 * A personal DSH memory mechanism with three scopes:
 *
 * 1. GLOBAL LONG-TERM — markdown files under `$DSH_HOME/memories/global-long-term/`.
 *    The directory's `INDEX.md` is what gets injected (hand-editable, or
 *    synthesized read-only from the files' titles when absent).
 * 2. GLOBAL SHORT-TERM — one rolling note `$DSH_HOME/memories/global-short-term.md`
 *    ("what DSH is working on right now"), appended by `/memory save`.
 * 3. WORKSPACE — the same long-term mechanism scoped to the current workspace,
 *    stored inside the workspace at `<projectRoot>/.dsh/memories/` so it travels
 *    with the repository (like AGENTS.md).
 *
 * Injection follows the shipped `@deepseek-ai/dsh-agent-instructions` pattern
 * exactly: at the first eligible `agent/pre-step` of a session, one durable
 * user-role baseline message (plugin-owned `<system-reminder>` framing, bounded
 * by configurable per-scope char budgets with honest truncation markers) is
 * spliced into the entering messages right after the last claimed message. The
 * message is ordinary session content, so replay, resume, and fork reconstruct
 * it from the log; a visible baseline with a matching identity is never
 * re-injected. Injection is fail-open: any memory error is logged and the step
 * proceeds untouched.
 *
 * Writing happens through the `/memory` human command (save | long | workspace
 * | show). The plugin never writes outside `/memory` invocations and never at
 * injection time.
 *
 * Contracts coded against (verified by inspection of the installed Harness and
 * by reading the extracted built sources of the shipped plugins):
 * - `ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => …)`
 *   — waterfall event (payload `{ agent, messages: UserMessage[], turn, step,
 *   signal }`, `next(): Promise<PreStepDecision>`); a listener that does not
 *   own the decision spreads it (`{ ...decision, messages }`) so fields such as
 *   `startsRequestSeries` survive.
 * - `agent.session.header.cwd` — absolute session working directory (the
 *   dsh-agent-instructions source uses `agent.session.header.cwd ?? process.cwd()`).
 * - `agent.session.surface.nodes` + `agent.session.eventAt(seq)` — visible
 *   session events; `event.type === 'user/message'` carries the message as
 *   `event.data` (with `.source`).
 * - User-message shape mirroring dsh-llm's `createUserMessage`:
 *   `{ role: 'user', content: ContentBlock[], source, id }` (the id brand is a
 *   compile-time no-op, so a locally built frozen object is identical).
 * - `ctx.commands.register({ name, description, input: { hint }, recordInput,
 *   handler })` from the `commands` service (@deepseek-ai/dsh-commands). The
 *   handler receives a frozen `{ commandId, agent, rawInput, attachments,
 *   signal }`, may be async, and returns `{ kind: 'success', text? }` or
 *   `{ kind: 'error', text }`.
 * - `ctx.inject(['commands'], callback)` (cordis Context.inject) starts a child
 *   plugin only while the optional `commands` service exists and returns its
 *   fiber, whose `dispose()` is this plugin's cleanup.
 * - `export const Config` is consumed through the Standard Schema
 *   `~standard.validate` protocol (cordis `resolveConfig`); the schema below is
 *   a dependency-free implementation of that contract.
 * - DSH home precedence (dsh-home-paths `resolveDshHome`): explicit configured
 *   path, then a non-blank `$DSH_HOME`, then `~/.dsh`; a blank `$DSH_HOME` is
 *   treated as unset.
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
 * installed beside it. Settings surfaces that project known schema vendors will
 * not render a form for this schema; the row config in `cordis.patch.yml`
 * remains the declarative way to configure the plugin.
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
  'Use it as background knowledge about the user and their current work; it does',
  'not override system, developer, or direct user instructions. The user can',
  'update these memories with the /memory command (save | long | workspace | show).',
].join(' ');

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
 * Compose the complete baseline text from the three loaded scopes.
 * @param {object} sections
 * @param {{ text: string, generated: boolean } | undefined} sections.longTerm
 * @param {string | undefined} sections.shortTerm
 * @param {{ text: string, generated: boolean } | undefined} sections.workspace
 * @param {ReturnType<typeof resolveConfig>} resolved validated config.
 * @returns {string | undefined} full frame text, or undefined when nothing to inject.
 */
export function buildBaselineText({ longTerm, shortTerm, workspace }, resolved) {
  const parts = [];
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
  if (parts.length === 0) return undefined;
  return [
    '<system-reminder>',
    BASELINE_INTRO,
    '',
    parts.join('\n\n'),
    '</system-reminder>',
  ].join('\n');
}

/**
 * Load all three scopes for one session and compose the baseline text.
 * Exported for testing and reuse.
 * @param {{ dshHome: string, cwd: string }} paths resolved locations.
 * @param {ReturnType<typeof resolveConfig>} resolved validated config.
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | undefined>}
 */
export async function composeBaselineText({ dshHome, cwd }, resolved, signal) {
  signal?.throwIfAborted();
  const longTerm = await loadIndexSection(globalLongTermDir(dshHome), signal);
  const shortTermRaw = await readTextIfPresent(globalShortTermFile(dshHome), signal);
  const shortTerm = shortTermRaw !== undefined && shortTermRaw.trim() !== '' ? shortTermRaw.trim() : undefined;
  const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers);
  const workspace = await loadIndexSection(join(projectRoot, ...WORKSPACE_MEMORY_SEGMENTS), signal);
  return buildBaselineText({ longTerm, shortTerm, workspace }, resolved);
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
 * /memory command implementation
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
      const text = await composeBaselineText({ dshHome, cwd }, resolved, signal);
      if (text === undefined) {
        return {
          kind: 'success',
          text: 'No memories yet — a new session would receive nothing. Create some with /memory save or /memory long.',
        };
      }
      return {
        kind: 'success',
        text: `What a NEW session in this workspace would receive:\n\n${text}`,
      };
    }
    default:
      return { kind: 'error', text: MEMORY_USAGE };
  }
}

/* --------------------------------------------------------------------------
 * Plugin entry
 * ------------------------------------------------------------------------ */

/**
 * Host plugin entry. Registers the `agent/pre-step` baseline injector on the
 * plugin context and the `/memory` command against the optional `commands`
 * service; returns the injected fiber's disposal as cleanup.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config raw row config (already validated via `Config`).
 * @returns {() => void} cleanup.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const identity = baselineIdentity(resolved);

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    try {
      const visible = visibleBaselineIdentity(agent, decision.messages);
      if (visible === identity) return decision;
      signal.throwIfAborted();
      const cwd = agent?.session?.header?.cwd ?? process.cwd();
      const text = await composeBaselineText(
        { dshHome: resolveDshHome(resolved.dshHome), cwd },
        resolved,
        signal,
      );
      if (text === undefined) return decision;
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

  const fiber = ctx.inject(['commands'], (commandCtx) => {
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
          return await runMemoryCommand({ dshHome: resolveDshHome(resolved.dshHome), cwd }, resolved, rawInput, signal);
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
  return () => fiber.dispose();
}
