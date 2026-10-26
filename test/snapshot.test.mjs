// Snapshot and detail-read tests — the v4 Memories-tab snapshot (full
// short-term content, description-bearing file rows, session-cwd workspace
// only, no index document anymore) and the validated one-file detail reads,
// against a runtime-generated temp DSH home.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import * as mod from '../index.js';
import { ALPHA_DESCRIPTION, OVERSIZED_SHORT_TERM, buildFixture } from './helpers.mjs';

const fx = await buildFixture();
after(() => fx.dispose());

// The oversized short-term note exercises the "full content served — and
// injected in full" guarantee (there is no truncation step anymore; the cap
// lives only in the write path as a compaction prompt).
await writeFile(join(fx.home, 'memories', 'global-short-term.md'), OVERSIZED_SHORT_TERM);

const resolved = mod.Config['~standard'].validate({}).value;

test('snapshot: kind/version and the full short-term note', async () => {
  const snapshot = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, { cwd: fx.nested });
  assert.ok(snapshot.kind === 'dsh-memories-snapshot' && snapshot.version === 4);
  assert.equal(snapshot.shortTermMemoriesCap, 10000);
  assert.equal(snapshot.shortTerm.present, true);
  assert.equal(snapshot.shortTerm.content.length, snapshot.shortTerm.chars);
  assert.ok(snapshot.shortTerm.content.startsWith('- [2026-10-11T10:00:00.000Z]'));
});

test('snapshot: long-term description-bearing file rows, no index document', async () => {
  const snapshot = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, { cwd: fx.nested });
  assert.equal(snapshot.longTerm.present, true);
  assert.ok(!('indexText' in snapshot.longTerm) && !('indexGenerated' in snapshot.longTerm),
    'v4 drops the index document fields the tab never used');
  assert.equal(snapshot.longTerm.files.length, 3);
  const alpha = snapshot.longTerm.files.find((f) => f.name === 'alpha-conventions.md');
  assert.ok(alpha !== undefined && alpha.title === 'Alpha conventions' && alpha.description === ALPHA_DESCRIPTION && alpha.chars > 0);
  const gamma = snapshot.longTerm.files.find((f) => f.name === 'gamma-raw-notes.md');
  assert.ok(gamma !== undefined && gamma.description === '', 'a descriptionless file still gets a row, with an empty description');
  assert.ok(!('summary' in snapshot.longTerm.files[0]) && !('content' in snapshot.longTerm.files[0]) && !('body' in snapshot.longTerm.files[0]));
});

test('snapshot: a stray INDEX.md is an ordinary file row', async () => {
  const indexFile = join(fx.home, 'memories', 'global-long-term', 'INDEX.md');
  await writeFile(indexFile, '<!-- hand maintained -->\n\n# Memory index\n\n- Hand row (x.md) — hand text.\n');
  const snapshot = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, { cwd: fx.nested });
  const row = snapshot.longTerm.files.find((f) => f.name === 'INDEX.md');
  assert.notEqual(row, undefined, 'INDEX.md is listed like any other .md file');
  assert.equal(row.title, 'Memory index');
  assert.equal(row.description, '', 'the hand index carries no Description line of its own');
  assert.notEqual(
    await mod.readMemoryFile({ dshHome: fx.home, cwd: fx.nested }, resolved, { scope: 'long', name: 'INDEX.md' }),
    undefined,
    'the detail endpoint serves INDEX.md like any .md',
  );
});

test('snapshot: the workspace section is exactly the cwd workspace', async () => {
  const snapshot = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, { cwd: fx.nested });
  assert.notEqual(snapshot.workspace, undefined);
  assert.equal(snapshot.workspace.root, fx.ws);
  assert.equal(snapshot.workspace.name, 'ws');
  assert.equal(snapshot.workspace.dir, join(fx.home, 'memories', 'workspace', 'ws'));
  assert.ok(snapshot.workspace.files.some((f) => f.name === 'release.md'));
  assert.ok(!('workspaces' in snapshot));
});

test('snapshot: foreign and omitted cwds yield global-only snapshots', async () => {
  const foreign = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, { cwd: fx.emptyHome });
  assert.equal(foreign.workspace, undefined);
  const omitted = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, undefined);
  assert.equal(omitted.workspace, undefined);
  assert.equal(omitted.longTerm.present, true);
});

test('snapshot is JSON-safe', async () => {
  const snapshot = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, { cwd: fx.nested });
  assert.equal(typeof JSON.stringify(snapshot), 'string');
});

test('workspace store resolution: registry title wins, else the root dir name', async () => {
  const registryMock = { resolveByPath: async (path) => (path === fx.ws ? { title: 'My Custom WS!' } : undefined) };
  const resolvedNamed = await mod.resolveWorkspaceStore({ dshHome: fx.home, cwd: fx.nested }, resolved, registryMock);
  assert.equal(resolvedNamed.name, 'My Custom WS!');
  assert.equal(resolvedNamed.dir, join(fx.home, 'memories', 'workspace', 'my-custom-ws'));
  const resolvedFallback = await mod.resolveWorkspaceStore({ dshHome: fx.home, cwd: fx.nested }, resolved, undefined);
  assert.equal(resolvedFallback.name, 'ws');
  assert.equal(resolvedFallback.dir, join(fx.home, 'memories', 'workspace', 'ws'));
});

test('detail reads serve the long and workspace scopes', async () => {
  const alpha = await mod.readMemoryFile(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { scope: 'long', name: 'alpha-conventions.md' },
  );
  assert.notEqual(alpha, undefined);
  assert.equal(alpha.title, 'Alpha conventions');
  assert.ok(alpha.text.includes('quote exit codes') && alpha.chars > 0);
  const wsDetail = await mod.readMemoryFile(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { scope: 'workspace', name: 'release.md' },
  );
  assert.notEqual(wsDetail, undefined);
  assert.ok(wsDetail.text.includes('pnpm build'));
});

test('detail reads reject missing files, unsafe names, bad scopes, foreign workspaces', async () => {
  assert.equal(
    await mod.readMemoryFile({ dshHome: fx.home, cwd: fx.nested }, resolved, { scope: 'long', name: 'no-such-file.md' }),
    undefined,
  );
  assert.equal(
    await mod.readMemoryFile({ dshHome: fx.home, cwd: fx.nested }, resolved, { scope: 'long', name: '..\\global-short-term.md' }),
    undefined,
  );
  assert.equal(
    await mod.readMemoryFile({ dshHome: fx.home, cwd: fx.nested }, resolved, { scope: 'long', name: 'C:\\Users\\x.md' }),
    undefined,
  );
  assert.equal(
    await mod.readMemoryFile({ dshHome: fx.home, cwd: fx.nested }, resolved, { scope: 'short', name: 'release.md' }),
    undefined,
  );
  assert.equal(
    await mod.readMemoryFile({ dshHome: fx.emptyHome, cwd: fx.emptyHome }, resolved, { scope: 'workspace', name: 'release.md' }),
    undefined,
  );
});
