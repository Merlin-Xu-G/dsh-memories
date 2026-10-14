/**
 * @local/dsh-memories — tiny fail-open filesystem helpers (node:fs only).
 *
 * Every probe degrades to "absent" on permission/transient errors: memory
 * discovery must never break a session (the plugin-wide fail-open rule).
 */

import { stat, readFile } from 'node:fs/promises';

/**
 * @param {string} path
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
export async function pathExists(path, signal) {
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
export async function isDirectory(path, signal) {
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
export async function readTextIfPresent(path, signal) {
  try {
    return await readFile(path, 'utf8', { signal });
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}
