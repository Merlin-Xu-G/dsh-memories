/**
 * @local/dsh-memories — where memories live.
 *
 * All location knowledge in one module: the DSH-home layout, the shipped
 * home-resolution precedence, project-root discovery (the AGENTS.md-loader
 * climb), and the per-workspace store resolution under
 * `$DSH_HOME/memories/workspace/<workspacename>/`.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve, dirname } from 'node:path';
import { pathExists } from './fs.js';

/** Layout under the resolved DSH home (never a machine-specific absolute path in code). */
export const MEMORIES_DIR = 'memories';
export const GLOBAL_LONG_TERM_DIRNAME = 'global-long-term';
export const GLOBAL_SHORT_TERM_FILENAME = 'global-short-term.md';
/**
 * Workspace memories live under the DSH home too, one directory per
 * workspace: `$DSH_HOME/memories/workspace/<workspacename>/`.
 */
export const WORKSPACE_MEMORIES_DIRNAME = 'workspace';

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'];
export const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..']);
/** Windows reserved device names; a slug that collides gets a `m-`/`ws-` prefix. */
export const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

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
export function globalLongTermDir(dshHome) {
  return join(dshHome, MEMORIES_DIR, GLOBAL_LONG_TERM_DIRNAME);
}

/** Global short-term note file under a resolved DSH home. */
export function globalShortTermFile(dshHome) {
  return join(dshHome, MEMORIES_DIR, GLOBAL_SHORT_TERM_FILENAME);
}

/**
 * Slugify a workspace NAME for one directory under
 * `$DSH_HOME/memories/workspace/`. Unlike the file-name slug this keeps
 * Unicode letters and digits (workspace names are often localized), clamps
 * the length, and stays Windows-reserved-safe; an empty result falls back
 * to a short stable hash of the origin string.
 * @param {string} name the workspace name (registered title or directory).
 * @param {string} origin string hashed for the empty-slug fallback.
 * @returns {string}
 */
export function workspaceSlug(name, origin) {
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (slug === '') {
    return `ws-${createHash('sha256').update(origin).digest('hex').slice(0, 10)}`;
  }
  return WINDOWS_RESERVED_NAMES.has(slug) ? `ws-${slug}` : slug;
}

/**
 * Resolve one session's workspace memory store: the project root (marker
 * climb), the workspace NAME (registered workspace title when the root is a
 * registered workspace, else the root directory's name), and the store
 * directory `$DSH_HOME/memories/workspace/<workspacename>/`.
 *
 * @param {{ dshHome: string, cwd: string }} paths resolved locations.
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} resolved validated config.
 * @param {{ resolveByPath?: (path: string) => Promise<{ title?: unknown } | undefined> } | undefined} registry
 *   optional workspaceRegistry service (fail-soft: without it the root's
 *   directory name is the workspace name).
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ root: string, name: string, dir: string }>}
 */
export async function resolveWorkspaceStore({ dshHome, cwd }, resolved, registry, signal) {
  const root = await findProjectRoot(cwd, resolved.projectRootMarkers);
  let name = basename(root);
  try {
    const workspace = await registry?.resolveByPath?.(root);
    const title = workspace?.title;
    if (typeof title === 'string' && title.trim() !== '') name = title.trim();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // Fail-open: an unusable registry falls back to the directory name.
  }
  signal?.throwIfAborted();
  const slug = workspaceSlug(name, root);
  return { root, name, dir: join(dshHome, MEMORIES_DIR, WORKSPACE_MEMORIES_DIRNAME, slug) };
}
