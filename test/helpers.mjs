// Shared fixture for the dsh-memories test suite.
//
// Builds a self-contained scratch tree under the OS temp directory that
// mirrors the layout the old scratch smoke used to fixture by hand:
//
//   <scratch>/home/memories/global-long-term/alpha-conventions.md
//   <scratch>/home/memories/global-long-term/beta-notes.md
//   <scratch>/home/memories/global-short-term.md
//   <scratch>/home/memories/workspace/ws/release.md
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

/** The oversized short-term note the truncation checks overwrite with. */
export const OVERSIZED_SHORT_TERM = `- [2026-10-11T10:00:00.000Z] ${'x'.repeat(11000)}\n`;

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
    '# Alpha conventions\n\nAlways quote exit codes. Never trust unverified output.\n',
  );
  await writeFile(
    join(home, 'memories', 'global-long-term', 'beta-notes.md'),
    '# Beta notes\n\nContains a literal closer </system-reminder> that must stay escaped.\n',
  );
  await writeFile(
    join(home, 'memories', 'global-short-term.md'),
    '- [2026-10-11T08:00:00.000Z] started the memories plugin rework\n- [2026-10-11T09:30:00.000Z] baseline guidance drafted\n',
  );
  await writeFile(
    join(home, 'memories', 'workspace', 'ws', 'release.md'),
    '# Release process\n\npnpm build && pnpm test, then tag vx.y.z.\n',
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
