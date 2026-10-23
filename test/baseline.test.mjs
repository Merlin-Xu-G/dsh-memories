// Baseline composition tests — the durable parts of the scratch live test
// (.tmp/test-memories.mjs: module load, exports, config validation,
// project-root climb, render sanity) plus baseline sections 1–4 of the
// scratch smoke (.tmp/smoke-v2.mjs: full frame, no-tool fallback, empty
// store, truncation), adapted to import the repo's own modules via a
// relative path and to run against a runtime-generated temp DSH home.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import * as mod from '../index.js';
import { OVERSIZED_SHORT_TERM, buildFixture } from './helpers.mjs';

const fx = await buildFixture();
after(() => fx.dispose());

const validated = mod.Config['~standard'].validate({});
const resolved = validated.value;

test('Config validates an empty config to the documented defaults', () => {
  assert.equal(validated.issues, undefined);
  assert.deepEqual(resolved, {
    dshHome: undefined,
    longTermMaxChars: 8192,
    shortTermMemoriesCap: 10000,
    workspaceMaxChars: 8192,
    projectRootMarkers: ['.git'],
  });
  const explicit = mod.Config['~standard'].validate({
    longTermMaxChars: 8192,
    shortTermMemoriesCap: 10000,
    workspaceMaxChars: 8192,
    projectRootMarkers: ['.git'],
  });
  assert.equal(explicit.issues, undefined);
  assert.ok(Array.isArray(mod.Config['~standard'].validate({ longTermMaxChars: 0 }).issues));
  assert.ok(Array.isArray(mod.Config['~standard'].validate({ nope: 1 }).issues));
});

test('Config: shortTermMaxChars is a deprecated alias; removed/both-set keys fail', () => {
  assert.equal(mod.resolveConfig({ shortTermMaxChars: 512 }).shortTermMemoriesCap, 512);
  assert.equal(mod.resolveConfig({ shortTermMemoriesCap: 2048 }).shortTermMemoriesCap, 2048);
  assert.ok(Array.isArray(mod.Config['~standard'].validate({
    shortTermMemoriesCap: 1,
    shortTermMaxChars: 2,
  }).issues), 'setting both the cap and its alias is an error');
  assert.ok(Array.isArray(mod.Config['~standard'].validate({ shortTermFileMaxChars: 4096 }).issues),
    'the removed 0.6.x key shortTermFileMaxChars now fails as unknown');
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
  assert.ok(full.includes('Before asking the user for information you lack, check memory first'));
  assert.ok(full.includes('`memory` tool'));
  assert.ok(
    full.includes(join(fx.home, 'memories', 'global-long-term'))
    && full.includes(join(fx.home, 'memories', 'workspace', 'ws')),
  );
  assert.ok(full.includes('## Global long-term memory — index'));
  assert.ok(full.includes('alpha-conventions.md') && full.includes('Beta notes'));
  assert.ok(full.includes('## Global short-term memory'));
  assert.ok(full.includes('## Workspace memory — index') && full.includes('release.md'));
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

test('buildBaselineText renders sections from preloaded scope payloads', () => {
  const sample = mod.buildBaselineText(
    {
      guidance: '## Your memory system — fixture guidance',
      longTerm: { text: '# demo index', generated: false },
      shortTerm: undefined,
      workspace: undefined,
    },
    resolved,
  );
  assert.ok(sample.startsWith('<system-reminder>') && sample.endsWith('</system-reminder>'));
  assert.ok(sample.includes('Global long-term memory'));
  assert.ok(sample.includes('# demo index'));
});
