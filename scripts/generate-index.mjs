#!/usr/bin/env node
/**
 * dsh-memories — regenerate every memory `INDEX.md`.
 *
 * The ONLY writer of INDEX.md: the plugin itself never writes it (it injects
 * the file when present and otherwise composes the exact same document
 * read-only at session start). Dependency-free — `node:*` builtins and the
 * plugin's own `lib/` modules only.
 *
 *   node scripts/generate-index.mjs [--home <path>]
 *
 * DSH home precedence (the same rule the plugin uses): `--home`, then a
 * non-blank `$DSH_HOME`, then `~/.dsh`. Regenerates
 * `$DSH_HOME/memories/global-long-term/INDEX.md` and `INDEX.md` for every
 * `$DSH_HOME/memories/workspace/<store>/` that has memory files. Only files
 * with a `Description:` line right after the `# Title` heading are listed;
 * over-long descriptions (1000+ chars) are honestly truncated in the index
 * (the file itself is never touched). No `--check` mode, no per-store
 * scoping — run it and every index is rewritten.
 */

import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GLOBAL_LONG_TERM_DIRNAME,
  MEMORIES_DIR,
  WORKSPACE_MEMORIES_DIRNAME,
  resolveDshHome,
} from '../lib/paths.js';
import { isDirectory } from '../lib/fs.js';
import { INDEX_FILENAME, composeIndexDocument } from '../lib/store.js';

/**
 * Parse `--home <path>` / `--home=<path>`; anything else is a usage error.
 * @param {readonly string[]} argv
 * @returns {string | undefined} the configured home, when given.
 */
function parseHomeFlag(argv) {
  let home;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--home') {
      home = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--home=')) {
      home = arg.slice('--home='.length);
    } else {
      throw new Error(`unknown argument "${arg}" — usage: node scripts/generate-index.mjs [--home <path>]`);
    }
    if (home === undefined || home.trim() === '') {
      throw new Error('--home needs a non-empty path');
    }
  }
  return home;
}

/**
 * Regenerate one store's INDEX.md, or report why there is nothing to do.
 * @param {string} label store label for the log line.
 * @param {string} dir store directory.
 */
async function regenerateStore(label, dir) {
  if (!(await isDirectory(dir))) {
    console.log(`[dsh-memories] ${label}: directory missing — skipped`);
    return;
  }
  const document = await composeIndexDocument(dir);
  if (document === undefined) {
    console.log(`[dsh-memories] ${label}: no memory files — skipped`);
    return;
  }
  await writeFile(join(dir, INDEX_FILENAME), `${document}\n`, 'utf8');
  const entries = (document.match(/^- /gm) ?? []).length;
  console.log(`[dsh-memories] ${label}: ${entries} entr${entries === 1 ? 'y' : 'ies'} -> ${INDEX_FILENAME}`);
}

async function main() {
  const home = resolveDshHome(parseHomeFlag(process.argv.slice(2)));
  const memoriesDir = join(home, MEMORIES_DIR);
  console.log(`[dsh-memories] DSH home: ${home}`);
  if (!(await isDirectory(memoriesDir))) {
    console.log('[dsh-memories] no memories directory under this home — nothing to do');
    return;
  }
  await regenerateStore(
    `${MEMORIES_DIR}/${GLOBAL_LONG_TERM_DIRNAME}`,
    join(memoriesDir, GLOBAL_LONG_TERM_DIRNAME),
  );
  const workspaceRoot = join(memoriesDir, WORKSPACE_MEMORIES_DIRNAME);
  if (await isDirectory(workspaceRoot)) {
    const stores = (await readdir(workspaceRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    for (const store of stores) {
      await regenerateStore(
        `${MEMORIES_DIR}/${WORKSPACE_MEMORIES_DIRNAME}/${store}`,
        join(workspaceRoot, store),
      );
    }
  }
}

main().catch((error) => {
  console.error(`[dsh-memories] generate-index failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
