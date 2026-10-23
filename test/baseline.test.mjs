// Baseline composition tests — module load, exports, config validation,
// project-root climb, render sanity, plus baseline sections: full frame,
// no-tool fallback, empty store, whole-index injection (no caps since
// 0.8.0), the Description convention, the fresh in-memory index
// composition (no INDEX.md boilerplate since 0.9.0), and the locked
// automatic-capture acceptance rules (kept verbatim through the 0.9.0
// guidance trim).
// Runs against a runtime-generated temp DSH home.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import * as mod from '../index.js';
import { ALPHA_DESCRIPTION, OVERSIZED_SHORT_TERM, buildFixture } from './helpers.mjs';

const fx = await buildFixture();
after(() => fx.dispose());

const validated = mod.Config['~standard'].validate({});
const resolved = validated.value;

test('Config validates an empty config to the documented defaults', () => {
  assert.equal(validated.issues, undefined);
  assert.deepEqual(resolved, {
    dshHome: undefined,
    shortTermMemoriesCap: 10000,
    projectRootMarkers: ['.git'],
  });
  const explicit = mod.Config['~standard'].validate({
    shortTermMemoriesCap: 10000,
    projectRootMarkers: ['.git'],
  });
  assert.equal(explicit.issues, undefined);
  assert.ok(Array.isArray(mod.Config['~standard'].validate({ shortTermMemoriesCap: 0 }).issues));
  assert.ok(Array.isArray(mod.Config['~standard'].validate({ nope: 1 }).issues));
});

test('Config: removed injection caps fail as unknown keys; alias still works; both-set fails', () => {
  assert.equal(mod.resolveConfig({ shortTermMaxChars: 512 }).shortTermMemoriesCap, 512);
  assert.equal(mod.resolveConfig({ shortTermMemoriesCap: 2048 }).shortTermMemoriesCap, 2048);
  assert.ok(Array.isArray(mod.Config['~standard'].validate({
    shortTermMemoriesCap: 1,
    shortTermMaxChars: 2,
  }).issues), 'setting both the cap and its alias is an error');
  assert.ok(Array.isArray(mod.Config['~standard'].validate({ longTermMaxChars: 4096 }).issues),
    'the removed 0.7.x injection cap longTermMaxChars now fails as unknown');
  assert.ok(Array.isArray(mod.Config['~standard'].validate({ workspaceMaxChars: 4096 }).issues),
    'the removed 0.7.x injection cap workspaceMaxChars now fails as unknown');
});

test('module loads and re-exports its public API', () => {
  // `Config` is the Standard Schema object (`Config['~standard'].validate`),
  // every other public export is a function.
  assert.ok(mod.Config !== null && typeof mod.Config === 'object');
  assert.equal(typeof mod.Config['~standard']?.validate, 'function');
  for (const name of [
    'resolveConfig',
    'resolveDshHome',
    'findProjectRoot',
    'resolveWorkspaceStore',
    'buildBaselineText',
    'composeBaselineText',
    'buildMemoriesSnapshot',
    'readMemoryFile',
    'runMemoryTool',
    'apply',
  ]) {
    assert.equal(typeof mod[name], 'function', `${name} is a function export`);
  }
});

test('resolveDshHome precedence: configured > non-blank $DSH_HOME > ~/.dsh', () => {
  assert.equal(mod.resolveDshHome(fx.home, {}), resolve(fx.home));
  assert.equal(mod.resolveDshHome(undefined, { DSH_HOME: fx.ws }), resolve(fx.ws));
  assert.equal(mod.resolveDshHome(undefined, { DSH_HOME: '   ' }), join(homedir(), '.dsh'));
  assert.equal(mod.resolveDshHome(undefined, {}), join(homedir(), '.dsh'));
});

test('findProjectRoot climbs to the nearest marker and falls back to the start', async () => {
  assert.equal(await mod.findProjectRoot(fx.nested, ['.git']), fx.ws);
  assert.equal(await mod.findProjectRoot(fx.nested, ['.no-such-marker-anywhere']), fx.nested);
});

test('full baseline: guidance plus all three scopes, nested cwd climbs to the ws root', async () => {
  const full = await mod.composeBaselineText(
    { dshHome: fx.home, cwd: fx.nested, memoryToolAvailable: true },
    resolved,
  );
  assert.ok(full.startsWith('<system-reminder>') && full.endsWith('</system-reminder>'));
  assert.ok(full.includes('## Your memory system'));
  assert.ok(
    full.includes('**Global long-term**')
    && full.includes('**Global short-term**')
    && full.includes('**Workspace**'),
  );
  assert.ok(full.includes('Check memory before asking the user for information you lack'));
  assert.ok(full.includes('`memory` tool'));
  assert.ok(full.includes('one-line'), 'the guidance teaches the description convention');
  assert.ok(
    full.includes(join(fx.home, 'memories', 'global-long-term'))
    && full.includes(join(fx.home, 'memories', 'workspace', 'ws')),
  );
  assert.ok(
    full.includes(`## Global long-term memory — index\n\n- Alpha conventions (alpha-conventions.md) — ${ALPHA_DESCRIPTION}`),
    'the heading is followed directly by the composed entry lines',
  );
  assert.ok(
    full.includes('## Workspace memory — index\n\n- Release process (release.md) — Build, test, tag; the CHANGELOG entry is mandatory.'),
    'the workspace heading is followed directly by its entry lines',
  );
  assert.ok(!full.includes('INDEX.md'), 'no INDEX.md boilerplate appears anywhere');
  assert.ok(!full.includes('# Memory index'), 'the old sub-heading is gone');
  assert.ok(!full.includes('Generated by'), 'the old generated-by comment is gone');
  assert.ok(full.includes('## Global short-term memory'));
  assert.ok(full.includes('(from $DSH_HOME/memories/global-short-term.md; newest entries last — injected in full, never truncated)'),
    'the short-term provenance line stays verbatim');
  assert.ok(full.includes('- Release process (release.md) — Build, test, tag; the CHANGELOG entry is mandatory.'));
  assert.ok(!full.includes('Gamma raw'), 'a file without a Description line is not listed');
  assert.ok(!full.includes('gamma-raw-notes.md'));
  const closers = full.match(/<\/system-reminder>/g) ?? [];
  const escaped = full.match(/<\\\/system-reminder>/g) ?? [];
  assert.ok(closers.length === 1 && escaped.length === 1, `closers=${closers.length} escaped=${escaped.length}`);
});

test('tool unavailable: guidance falls back to the /memory command', async () => {
  const noTool = await mod.composeBaselineText(
    { dshHome: fx.home, cwd: fx.nested, memoryToolAvailable: false },
    resolved,
  );
  assert.ok(noTool.includes('/memory command') && !noTool.includes('`memory` tool'));
  assert.ok(noTool.includes('<title> | <description> | <text>'), 'the fallback grammar includes the description field');
});

test('empty store: guidance-only baseline (automatic memory from day one)', async () => {
  const empty = await mod.composeBaselineText(
    { dshHome: fx.emptyHome, cwd: fx.emptyHome, memoryToolAvailable: true },
    resolved,
  );
  assert.ok(typeof empty === 'string' && empty.includes('## Your memory system'));
  assert.ok(
    !empty.includes('## Global long-term memory')
    && !empty.includes('## Global short-term memory')
    && !empty.includes('## Workspace memory'),
  );
});

test('guidance acceptance: the automatic-capture rules are all present (locked)', async () => {
  // The six acceptance rules of the automatic-capture design, locked as
  // permanent regression strings against an empty temp home (guidance-only
  // baseline); the 0.9.0 token trim kept every rule's meaning. Whitespace
  // is normalized first: the locked strings span the guidance's hard-wrapped
  // lines, and the wrapping must not weaken the lock.
  const empty = await mod.composeBaselineText(
    { dshHome: fx.emptyHome, cwd: fx.emptyHome, memoryToolAvailable: true },
    resolved,
  );
  const flat = empty.replaceAll(/\s+/g, ' ');
  assert.ok(flat.includes('The user never curates memories'),
    'rule 1: the user never curates memories');
  assert.ok(
    flat.includes('whenever the user corrects you, states a style, rule, or preference, or overrides a default, capture it immediately'),
    'rule 2: the correction-capture trigger');
  assert.ok(flat.includes('when the same topic or design question comes up a second time'),
    'rule 3: the repeated-discussions trigger');
  assert.ok(flat.includes('before you declare the work done'),
    'rule 4: the wrap-up trigger');
  assert.ok(
    flat.includes('and design decisions → `workspace`')
      && flat.includes('machine/environment facts, general tool knowledge → `long`'),
    'rule 5: the scope-routing rule names both destinations');
  assert.ok(
    flat.includes('update that file (keep its title and file name)')
      && flat.includes('instead of creating a near-duplicate')
      && flat.includes('One topic per file'),
    'rule 6: the de-duplication rule');
  assert.ok(flat.includes('unprompted'), 'capture is the agent\'s own unprompted job');
});

test('a stray INDEX.md is an ordinary memory file, composed like any other', async () => {
  const stray = join(fx.home, 'memories', 'global-long-term', 'INDEX.md');
  await writeFile(stray, '# Stray index note\n\nDescription: A hand-dropped INDEX.md described like any memory.\n\nBody.\n');
  try {
    const withStray = await mod.composeBaselineText(
      { dshHome: fx.home, cwd: fx.nested, memoryToolAvailable: true },
      resolved,
    );
    assert.ok(
      withStray.includes('- Stray index note (INDEX.md) — A hand-dropped INDEX.md described like any memory.'),
      'a described INDEX.md is indexed like every other file',
    );
    assert.ok(withStray.includes(`- Alpha conventions (alpha-conventions.md) — ${ALPHA_DESCRIPTION}`),
      'the store\'s other described files are still composed');
    assert.ok(!withStray.includes('no INDEX.md on disk'), 'no INDEX.md provenance exists anymore');
  } finally {
    await rm(stray, { force: true }); // restore the fixture for later tests
  }
});

test('oversized short-term note is injected in full, with no truncation marker', async () => {
  await writeFile(join(fx.home, 'memories', 'global-short-term.md'), OVERSIZED_SHORT_TERM);
  const whole = await mod.composeBaselineText(
    { dshHome: fx.home, cwd: fx.nested, memoryToolAvailable: true },
    resolved,
  );
  assert.ok(!whole.includes('[memory truncated'), 'no truncation marker may appear');
  assert.ok(whole.includes('injected in full, never truncated'), 'the section says so honestly');
  assert.ok(whole.includes(OVERSIZED_SHORT_TERM.trim()), 'the entire note body is present, tail (newest) included');
});

test('huge index content is injected whole — no caps, no truncation markers', async () => {
  const longDir = join(fx.home, 'memories', 'global-long-term');
  await writeFile(
    join(longDir, 'delta-huge.md'),
    `# Delta huge\n\nDescription: ${'h'.repeat(100000)}\n\nBody.\n`,
  );
  const whole = await mod.composeBaselineText(
    { dshHome: fx.home, cwd: fx.nested, memoryToolAvailable: true },
    resolved,
  );
  assert.ok(!whole.includes('[memory truncated'), 'no truncation marker may appear anywhere');
  const onDisk = await readFile(join(longDir, 'delta-huge.md'), 'utf8');
  assert.ok(onDisk.includes('h'.repeat(100000)), 'the over-long hand-edited file is untouched');
  // The index view of it is clamped to exactly 1000 chars (999 + ellipsis).
  const clamped = whole.match(/- Delta huge \(delta-huge\.md\) — (h|…)+/)?.[0] ?? '';
  assert.ok(clamped !== '', 'the delta line is present');
  assert.ok(clamped.endsWith(`${'h'.repeat(999)}…`), 'the description is honestly truncated to 1000 chars');
});

test('buildBaselineText renders sections from preloaded scope payloads', () => {
  const sample = mod.buildBaselineText({
    guidance: '## Your memory system — fixture guidance',
    longTerm: '- demo line (demo.md) — demo entry',
    shortTerm: undefined,
    workspace: undefined,
  });
  assert.ok(sample.startsWith('<system-reminder>') && sample.endsWith('</system-reminder>'));
  assert.ok(sample.includes('Global long-term memory'));
  assert.ok(sample.includes('- demo line (demo.md) — demo entry'));
});
