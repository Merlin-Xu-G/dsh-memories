#!/usr/bin/env node
/**
 * dsh-memories — regenerate the CURRENT workspace's memory INDEX.md.
 *
 * The ONLY writer of INDEX.md: the plugin itself never writes it (it injects
 * the file when present and otherwise composes the exact same document
 * read-only at session start — the automatic memory needs no INDEX.md at
 * all). Dependency-free — `node:*` builtins and the plugin's own `lib/`
 * modules only.
 *
 *   node scripts/generate-index.mjs [--home <path>]
 *
 * Deliberately parameter-free: the command processes ONLY the memories of
 * the workspace it is run in — commands are assists; the automatic
 * injection is the core feature. The workspace is derived from the current
 * working directory exactly like the plugin derives a session's workspace:
 * climb to the project root (default marker `.git`), take the root
 * directory's name, slugify it (registered workspace titles live in a Host
 * service the script cannot see — it uses the directory name, the plugin's
 * no-registry fallback), then regenerate that store's
 * `$DSH_HOME/memories/workspace/<slug>/INDEX.md` when it has memory files.
 * The global long-term store has no generator by design — keep it
 * file-free and let every session compose its index read-only. Files
 * without a `Description:` line right after the `# Title` heading are not
 * listed; over-long descriptions (1000+ chars) are honestly truncated in
 * the index (the file itself is never touched). No `--check` mode, no
 * scoping parameter.
 */

import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  MEMORIES_DIR,
  WORKSPACE_MEMORIES_DIRNAME,
  findProjectRoot,
  resolveDshHome,
  workspaceSlug,
} from '../lib/paths.js';
import { isDirectory } from '../lib/fs.js';
import { INDEX_FILENAME, composeIndexDocument } from '../lib/store.js';

/** Default project-root markers (the same default the plugin config uses). */
const PROJECT_ROOT_MARKERS = ['.git'];

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

async function main() {
  const home = resolveDshHome(parseHomeFlag(process.argv.slice(2)));
  const root = await findProjectRoot(process.cwd(), PROJECT_ROOT_MARKERS);
  const name = basename(root);
  const slug = workspaceSlug(name, root);
  const dir = join(home, MEMORIES_DIR, WORKSPACE_MEMORIES_DIRNAME, slug);
  console.log(`[dsh-memories] DSH home: ${home}`);
  console.log(`[dsh-memories] current workspace: "${name}" (root ${root})`);
  if (!(await isDirectory(dir))) {
    console.log(`[dsh-memories] memories/workspace/${slug}: no store yet — nothing to do`);
    return;
  }
  const document = await composeIndexDocument(dir);
  if (document === undefined) {
    console.log(`[dsh-memories] memories/workspace/${slug}: no memory files — nothing written`);
    return;
  }
  await writeFile(join(dir, INDEX_FILENAME), `${document}\n`, 'utf8');
  const entries = (document.match(/^- /gm) ?? []).length;
  console.log(`[dsh-memories] memories/workspace/${slug}: ${entries} entr${entries === 1 ? 'y' : 'ies'} -> ${INDEX_FILENAME}`);
}

main().catch((error) => {
  console.error(`[dsh-memories] generate-index failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
