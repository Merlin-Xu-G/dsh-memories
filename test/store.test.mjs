// Memory-tool write tests — the agent memory tool writes through the same
// store as every other surface (temp home only). A long/workspace write
// saves ONLY the memory file (there is no on-disk index anymore),
// descriptions are validated (≤1000 chars, one line), and an update without
// a description keeps the file's existing Description line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
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

test('tool long writes a global file with a Description line and nothing else', async () => {
  const wroteLong = await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'long', title: 'Tool long memory', description: 'One-line description of the tool-written memory.', text: 'Written by the tool smoke.' },
  );
  assert.ok(wroteLong.ok === true && wroteLong.message.includes('tool-long-memory.md'));
  assert.ok(!wroteLong.message.includes('INDEX'), 'the write result stays silent about the index');
  const file = await readFile(join(fx.home, 'memories', 'global-long-term', 'tool-long-memory.md'), 'utf8');
  assert.ok(file.startsWith('# Tool long memory\n\nDescription: One-line description of the tool-written memory.\n\n'));
  await assert.rejects(access(join(fx.home, 'memories', 'global-long-term', 'INDEX.md')),
    'a write never creates an INDEX.md');
});

test('tool long without a description writes no Description line', async () => {
  await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'long', title: 'Tool bare memory', text: 'No description given.' },
  );
  const file = await readFile(join(fx.home, 'memories', 'global-long-term', 'tool-bare-memory.md'), 'utf8');
  assert.ok(file.startsWith('# Tool bare memory\n\nNo description given.'));
  assert.ok(!file.includes('Description:'));
});

test('tool long update without a description keeps the existing Description line', async () => {
  await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'long', title: 'Keep description', description: 'The description that must survive.', text: 'First body.' },
  );
  await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'long', title: 'Keep description', text: 'Second body, no description argument.' },
  );
  const file = await readFile(join(fx.home, 'memories', 'global-long-term', 'keep-description.md'), 'utf8');
  assert.ok(file.includes('Description: The description that must survive.'));
  assert.ok(file.includes('Second body, no description argument.'));
});

test('tool rejects a description over 1000 chars', async () => {
  await assert.rejects(
    mod.runMemoryTool(
      { dshHome: fx.home, cwd: fx.nested },
      resolved,
      { action: 'long', title: 'Too long', description: 'd'.repeat(1001), text: 'x' },
    ),
    (error) => error.message.includes('at most 1000 characters'),
  );
});

test('tool rejects a multi-line description', async () => {
  await assert.rejects(
    mod.runMemoryTool(
      { dshHome: fx.home, cwd: fx.nested },
      resolved,
      { action: 'long', title: 'Multi line', description: 'line one\nline two', text: 'x' },
    ),
    (error) => error.message.includes('single line'),
  );
});

test('tool workspace writes into the session workspace store', async () => {
  const wroteWs = await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'workspace', title: 'Tool ws memory', description: 'Workspace memory from the tool.', text: 'Written by the tool smoke.' },
  );
  assert.ok(wroteWs.ok === true && wroteWs.message.includes(join(fx.home, 'memories', 'workspace', 'ws')));
  await assert.rejects(access(join(fx.home, 'memories', 'workspace', 'ws', 'INDEX.md')),
    'a workspace write never creates an INDEX.md either');
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

test('save over the cap returns a compact directive and drops nothing', async () => {
  const tiny = mod.resolveConfig({ shortTermMemoriesCap: 60 });
  const over = await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    tiny,
    { action: 'save', text: 'this entry alone pushes the note past the tiny sixty character cap' },
  );
  assert.equal(over.ok, true);
  assert.ok(over.message.includes('over the 60-char cap'));
  assert.ok(over.message.includes('action "compact"'));
  const note = await readFile(join(fx.home, 'memories', 'global-short-term.md'), 'utf8');
  assert.ok(note.includes('tool smoke note'), 'older entries survive — no mechanical drop');
  assert.match(note.trim().split(/\r?\n/).at(-1), /tiny sixty character cap$/);
});

test('save never trims, however large the note already is', async () => {
  const noteFile = join(fx.home, 'memories', 'global-short-term.md');
  await writeFile(noteFile, `- [2026-10-01] ancient line padded ${'o'.repeat(12000)}\n`);
  const saved = await mod.runMemoryTool(
    { dshHome: fx.home, cwd: fx.nested },
    resolved,
    { action: 'save', text: 'newest line after a huge note' },
  );
  assert.equal(saved.ok, true);
  const note = await readFile(noteFile, 'utf8');
  assert.ok(note.includes('ancient line padded'), 'the huge existing note is untouched');
  assert.ok(note.trim().endsWith('newest line after a huge note'), 'the new entry is appended');
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
