/**
 * @local/dsh-memories — the read-only JSON payloads the Memories tab renders:
 * the list snapshot (full short-term note content; long-term/workspace stores
 * as file rows, never file bodies) and the one-file detail read. Failures
 * inside one scope degrade that scope, never the rest. v4: file rows carry
 * the parsed `Description:` line (empty string when absent); the index
 * document is no longer part of the snapshot (v3's `indexText`/
 * `indexGenerated` are dropped — indexes are composed only for the injected
 * baseline, and `client.js` never read them).
 */

import { join } from 'node:path';
import { readTextIfPresent, isDirectory } from './fs.js';
import {
  RESERVED_PATH_SEGMENTS,
  WINDOWS_RESERVED_NAMES,
  globalLongTermDir,
  globalShortTermFile,
  resolveWorkspaceStore,
} from './paths.js';
import { MAX_SOURCE_CHARS, parseMemoryMeta, listMemoryFiles } from './store.js';

/**
 * Build one UI snapshot file row: name, title, description, and character
 * count. Read-only; unreadable files degrade to name-only rows.
 * @param {string} dir
 * @param {string} name
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ name: string, title: string, description: string, chars: number }>}
 */
async function memoryFileRow(dir, name, signal) {
  const fallback = name.slice(0, -'.md'.length);
  const text = await readTextIfPresent(join(dir, name), signal);
  if (text === undefined) return { name, title: fallback, description: '', chars: 0 };
  const { title, description } = parseMemoryMeta(text.slice(0, MAX_SOURCE_CHARS), fallback);
  return { name, title, description: description ?? '', chars: text.length };
}

/**
 * Snapshot one long-term store for the Memories tab: file rows (name, title,
 * description, chars) — never file bodies.
 * @param {string} dir memory directory.
 * @param {AbortSignal} [signal]
 */
async function snapshotLongTerm(dir, signal) {
  if (!(await isDirectory(dir, signal))) {
    return { present: false, dir, files: [] };
  }
  const names = await listMemoryFiles(dir, signal);
  const files = [];
  for (const name of names) files.push(await memoryFileRow(dir, name, signal));
  return { present: true, dir, files };
}

/**
 * Build the JSON snapshot the Memories tab renders: full short-term note
 * content, the global long-term store as file rows, and — when
 * `workspace.cwd` names the requesting session's working directory — exactly
 * that session's workspace store (never any other workspace's). Read-only.
 *
 * @param {{ dshHome: string }} paths resolved locations.
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} resolved validated config.
 * @param {{ cwd: string, workspaceRegistry?: object } | undefined} workspace
 *   the requesting session's working directory (and optional registry);
 *   omit it for a global-only snapshot.
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} JSON-safe snapshot (`workspace` is undefined
 *   when the session's workspace has no memory store).
 */
export async function buildMemoriesSnapshot({ dshHome }, resolved, workspace, signal) {
  signal?.throwIfAborted();
  const shortTermPath = globalShortTermFile(dshHome);
  const shortTermRaw = await readTextIfPresent(shortTermPath, signal);
  const shortTerm = shortTermRaw === undefined || shortTermRaw.trim() === ''
    ? { present: false, path: shortTermPath, chars: 0, content: '' }
    : { present: true, path: shortTermPath, chars: shortTermRaw.length, content: shortTermRaw };
  const longTerm = await snapshotLongTerm(globalLongTermDir(dshHome), signal);
  let workspaceSection;
  if (workspace !== undefined && typeof workspace.cwd === 'string' && workspace.cwd !== '') {
    const store = await resolveWorkspaceStore(
      { dshHome, cwd: workspace.cwd },
      resolved,
      workspace.workspaceRegistry,
      signal,
    );
    const section = await snapshotLongTerm(store.dir, signal);
    workspaceSection = section.present ? { root: store.root, name: store.name, ...section } : undefined;
  }
  return {
    kind: 'dsh-memories-snapshot',
    version: 4,
    generatedAt: new Date().toISOString(),
    dshHome,
    shortTermMemoriesCap: resolved.shortTermMemoriesCap,
    shortTerm,
    longTerm,
    workspace: workspaceSection,
  };
}

/** Memory-detail scopes the file endpoint serves. */
const DETAIL_SCOPES = new Set(['long', 'workspace']);

/**
 * Whether a detail request names a safe memory file: a plain `*.md` base
 * name with no separators and no drive/parent tricks.
 * @param {unknown} name
 * @returns {boolean}
 */
function isSafeMemoryFileName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (!name.toLowerCase().endsWith('.md')) return false;
  return !name.includes('/') && !name.includes('\\') && !name.includes(':')
    && !RESERVED_PATH_SEGMENTS.has(name)
    && !WINDOWS_RESERVED_NAMES.has(name.split('.')[0].toLowerCase());
}

/**
 * Read one memory file's full content for the Memories detail page.
 * Read-only and validated; exported for testing.
 *
 * @param {{ dshHome: string, cwd: string, workspaceRegistry?: object }} paths
 *   resolved locations (cwd + registry are used for `workspace` only).
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} resolved validated config.
 * @param {{ scope: 'long' | 'workspace', name: string }} request
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ scope: string, name: string, title: string, chars: number, text: string } | undefined>}
 *   the file's detail, or undefined when the request is invalid or the file
 *   does not exist.
 */
export async function readMemoryFile({ dshHome, cwd, workspaceRegistry }, resolved, { scope, name }, signal) {
  signal?.throwIfAborted();
  if (!DETAIL_SCOPES.has(scope) || !isSafeMemoryFileName(name)) return undefined;
  const dir = scope === 'workspace'
    ? (await resolveWorkspaceStore({ dshHome, cwd }, resolved, workspaceRegistry, signal)).dir
    : globalLongTermDir(dshHome);
  const raw = await readTextIfPresent(join(dir, name), signal);
  if (raw === undefined) return undefined;
  const text = raw.slice(0, MAX_SOURCE_CHARS);
  const { title } = parseMemoryMeta(text, name.slice(0, -'.md'.length));
  return { scope, name, title, chars: raw.length, text };
}
