// Memory-tool write tests — smoke section 6 of the scratch smoke
// (.tmp/smoke-v2.mjs): the agent memory tool writes through the same store
// as every other surface (temp home only), regenerates INDEX.md, and its
// writes are visible to the next snapshot.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import * as mod from '../index.js';
import { buildFixture } from './helpers.mjs';

const fx = await buildFixture();
after(() => fx.dispose());

const resolved = mod.Config['~standard'].validate({}).value;

test('tool save appends to the short-term note', async () => {
  const saved = await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'save', text: 'tool smoke note' },
  );
  assert.ok(saved.ok === true && saved.message.includes('short-term'));
});

test('tool long writes a global file and regenerates INDEX.md', async () => {
  const wroteLong = await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'long', title: 'Tool long memory', text: 'Written by the tool smoke.' },
  );
  assert.ok(wroteLong.ok === true && wroteLong.message.includes('tool-long-memory.md'));
  const regeneratedIndex = await readFile(
    join(fx.home, 'memories', 'global-long-term', 'INDEX.md'),
    'utf8',
  );
  assert.ok(regeneratedIndex.includes('Tool long memory'));
});

test('tool workspace writes into the session workspace store', async () => {
  const wroteWs = await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'workspace', title: 'Tool ws memory', text: 'Written by the tool smoke.' },
  );
  assert.ok(wroteWs.ok === true && wroteWs.message.includes(join(fx.home, 'memories', 'workspace', 'ws')));
});

test('tool rejects a long/workspace write without a title', async () => {
  await assert.rejects(
    mod.runMemoryTool({ dshHome: fx.home, cwd: fx.nested }, resolved, { action: 'long', title: '  ', text: 'x' }),
    (error) => error.message.includes('title'),
  );
});

test('tool writes are visible in the next snapshot', async () => {
  const afterTool = await mod.buildMemoriesSnapshot({ dshHome: fx.home }, resolved, { cwd: fx.nested });
  assert.ok(afterTool.shortTerm.content.includes('tool smoke note'));
  assert.ok(afterTool.longTerm.files.some((f) => f.name === 'tool-long-memory.md'));
  assert.ok(afterTool.workspace.files.some((f) => f.name === 'tool-ws-memory.md'));
});

test('save stamps the local date, not a full timestamp', async () => {
  await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'save', text: 'date stamp probe' },
  );
  const note = await readFile(join(fx.home, 'memories', 'global-short-term.md'), 'utf8');
  assert.match(note, /- \[\d{4}-\d{2}-\d{2}\] date stamp probe\n/);
});

test('save over the cap returns a compact directive', async () => {
  const tiny = mod.resolveConfig({ shortTermMaxChars: 60, shortTermFileMaxChars: 4096 });
  const over = await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    tiny,
    { action: 'save', text: 'this entry alone pushes the note past the tiny sixty character cap' },
  );
  assert.equal(over.ok, true);
  assert.ok(over.message.includes('over the 60-char injection cap'));
  assert.ok(over.message.includes('action "compact"'));
});

test('compact rewrites the note shorter and normalizes the trailing newline', async () => {
  const noteFile = join(fx.home, 'memories', 'global-short-term.md');
  await writeFile(noteFile, '- [2026-10-20] alpha pickup line padded out to give compaction some room to shrink\n- [2026-10-20] beta line also padded so the note is clearly the longer one here\n');
  const done = await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'compact', text: '- [2026-10-20] alpha+beta compacted into one summary line\n\n' },
  );
  assert.equal(done.ok, true);
  assert.ok(done.message.startsWith('Compacted global short-term memory'));
  assert.equal(await readFile(noteFile, 'utf8'), '- [2026-10-20] alpha+beta compacted into one summary line\n');
});

test('compact rejects a rewrite that does not shorten the note', async () => {
  const noteFile = join(fx.home, 'memories', 'global-short-term.md');
  await writeFile(noteFile, '- [2026-10-20] short note\n');
  await assert.rejects(
    mod.runMemoryTool(
      { dshHome: fx.home, cwd: fx.nested },
      resolved,
      { action: 'compact', text: '- [2026-10-20] this replacement text is deliberately much longer than the current short note' },
    ),
    (error) => error.message.includes('must shorten the note'),
  );
  assert.equal(await readFile(noteFile, 'utf8'), '- [2026-10-20] short note\n');
});
