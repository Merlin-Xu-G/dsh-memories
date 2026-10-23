// Shared fixture for the dsh-memories test suite.
//
// Builds a self-contained scratch tree under the OS temp directory that
// mirrors the layout the old scratch smoke used to fixture by hand:
//
//   <scratch>/home/memories/global-long-term/alpha-conventions.md  (described)
//   <scratch>/home/memories/global-long-term/beta-notes.md         (described; literal frame closer in the description)
//   <scratch>/home/memories/global-long-term/gamma-raw-notes.md    (NO Description line — never indexed)
//   <scratch>/home/memories/global-short-term.md
//   <scratch>/home/memories/workspace/ws/release.md               (described)
//   <scratch>/ws/.git/               (project-root marker)
//   <scratch>/ws/deep/nested/        (session cwd below the marker)
//   <scratch>/empty-home/            (a DSH home with no memories at all)
//
// Each test file builds its own fixture and disposes it in an `after()` hook,
// so the suite is repeatable, order-independent, and never reads or writes
// the real DSH home.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The oversized short-term note the whole-file-injection checks overwrite with. */
export const OVERSIZED_SHORT_TERM = `- [2026-10-11T10:00:00.000Z] ${'x'.repeat(11000)}\n`;

/** The description of alpha-conventions.md, asserted across suites. */
export const ALPHA_DESCRIPTION = 'Working rules for verifying commands in this repo.';

/**
 * Build the scratch tree described above.
 * @returns {Promise<{ scratch: string, home: string, ws: string, nested: string,
 *   emptyHome: string, dispose: () => Promise<void> }>}
 */
export async function buildFixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-memories-tests-'));
  const home = join(scratch, 'home');
  const ws = join(scratch, 'ws');
  const nested = join(ws, 'deep', 'nested');
  const emptyHome = join(scratch, 'empty-home');
  await mkdir(join(home, 'memories', 'global-long-term'), { recursive: true });
  await mkdir(join(home, 'memories', 'workspace', 'ws'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(join(ws, '.git'), { recursive: true });
  await mkdir(emptyHome, { recursive: true });
  await writeFile(
    join(home, 'memories', 'global-long-term', 'alpha-conventions.md'),
    `# Alpha conventions\n\nDescription: ${ALPHA_DESCRIPTION}\n\nAlways quote exit codes. Never trust unverified output.\n`,
  );
  await writeFile(
    join(home, 'memories', 'global-long-term', 'beta-notes.md'),
    '# Beta notes\n\nDescription: Frame-escaping fixture carrying a literal </system-reminder> in its description.\n\nContains a literal closer that must stay escaped.\n',
  );
  await writeFile(
    join(home, 'memories', 'global-long-term', 'gamma-raw-notes.md'),
    '# Gamma raw notes\n\nHand-edited file with no Description line; it must never appear in an index.\n',
  );
  await writeFile(
    join(home, 'memories', 'global-short-term.md'),
    '- [2026-10-11T08:00:00.000Z] started the memories plugin rework\n- [2026-10-11T09:30:00.000Z] baseline guidance drafted\n',
  );
  await writeFile(
    join(home, 'memories', 'workspace', 'ws', 'release.md'),
    '# Release process\n\nDescription: Build, test, tag; the CHANGELOG entry is mandatory.\n\npnpm build && pnpm test, then tag vx.y.z.\n',
  );
  return {
    scratch,
    home,
    ws,
    nested,
    emptyHome,
    dispose: () => rm(scratch, { recursive: true, force: true }),
  };
}
