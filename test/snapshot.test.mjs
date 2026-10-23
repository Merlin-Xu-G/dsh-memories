// Snapshot and detail-read tests — smoke sections 5 and 7 of the scratch
// smoke (.tmp/smoke-v2.mjs): the v2 Memories-tab snapshot (full short-term
// content, index + file rows, session-cwd workspace only) and the validated
// one-file detail reads, against a runtime-generated temp DSH home.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import * as mod from '../index.js';
import { OVERSIZED_SHORT_TERM, buildFixture } from './helpers.mjs';

const fx = await buildFixture();
after(() => fx.dispose());

// The oversized short-term note exercises the "full content served — and
// injected in full" guarantee (there is no truncation step anymore; the cap
// lives only in the write path as a compaction prompt).
await writeFile(join(fx.home, 'memories', 'global-short-term.md'), OVERSIZED_SHORT_TERM);

const resolved = mod.Config['~standard'].validate({}).value;

test('snapshot: kind/version and the full short-term note', async () => {
  const snapshot = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, { cwd: fx.nested });
  assert.ok(snapshot.kind === 'dsh-memories-snapshot' && snapshot.version === 2);
  assert.equal(snapshot.shortTermMemoriesCap, 10000);
  assert.equal(snapshot.shortTerm.present, true);
  assert.equal(snapshot.shortTerm.content.length, snapshot.shortTerm.chars);
  assert.ok(snapshot.shortTerm.content.startsWith('- [2026-10-11T10:00:00.000Z]'));
});

test('snapshot: long-term index plus file rows that carry no bodies', async () => {
  const snapshot = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, { cwd: fx.nested });
  assert.equal(snapshot.longTerm.present, true);
  assert.equal(snapshot.longTerm.files.length, 2);
  const alpha = snapshot.longTerm.files.find((f) => f.name === 'alpha-conventions.md');
  assert.ok(alpha !== undefined && alpha.title === 'Alpha conventions' && alpha.chars > 0);
  assert.ok(!('content' in snapshot.longTerm.files[0]) && !('body' in snapshot.longTerm.files[0]));
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
    await mod.readMemoryFile({ dshHome: fx.home, cwd: fx.emptyHome }, resolved, { scope: 'workspace', name: 'release.md' }),
    undefined,
  );
});
