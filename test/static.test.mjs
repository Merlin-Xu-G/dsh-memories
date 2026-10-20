// Static verification bar — ported from the scratch checker
// (.tmp/verify-static.cjs): the browser half compiles as a classic script
// (never executed), the manifests parse as JSON, and no tracked file
// carries a machine-specific path literal (user name, repo location, or
// profile root). The repo root is derived from this file's location
// instead of an argv path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('client.js compiles as a classic script (never executed)', () => {
  const source = readFileSync(join(repo, 'client.js'), 'utf8');
  new vm.Script(source, { filename: 'client.js' }); // throws on a syntax error
});

test('index.js carries ESM syntax (the other suites cover the full import)', () => {
  const source = readFileSync(join(repo, 'index.js'), 'utf8');
  if (typeof vm.SourceTextModule === 'function') {
    new vm.SourceTextModule(source, { identifier: 'index.js' });
  } else {
    assert.match(source, /^import[ \t]|^export[ \t]/m);
  }
});

test('JSON manifests parse', () => {
  for (const file of ['package.json', 'locale/en.json', 'locale/zh.json']) {
    const parsed = JSON.parse(readFileSync(join(repo, file), 'utf8'));
    assert.ok(parsed !== null && typeof parsed === 'object', `${file} parsed to an object`);
  }
});

test('no machine-specific path literals in tracked files', () => {
  const rootFiles = readdirSync(repo, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|json|md|yml)$/.test(entry.name))
    .map((entry) => entry.name);
  const libFiles = existsSync(join(repo, 'lib'))
    ? readdirSync(join(repo, 'lib'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => `lib/${entry.name}`)
    : [];
  const testFiles = readdirSync(join(repo, 'test'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name))
    .map((entry) => `test/${entry.name}`);
  const files = [...rootFiles, ...libFiles, ...testFiles];
  const forbidden = [process.env.USERNAME, repo, process.env.DSH_PROFILE_DIR]
    .filter((value) => typeof value === 'string' && value.trim() !== '');
  assert.ok(forbidden.length > 0, 'scan needs at least the user name and repo root as needles');
  for (const file of files) {
    const text = readFileSync(join(repo, file), 'utf8');
    for (const needle of forbidden) {
      // Normalized separators so 'C:\Users\x' and 'C:/Users/x' both match.
      const flatText = text.replaceAll('\\', '/').toLowerCase();
      const flatNeedle = needle.replaceAll('\\', '/').toLowerCase();
      assert.ok(
        !flatText.includes(flatNeedle),
        `${file} contains machine path ${JSON.stringify(needle)}`,
      );
    }
  }
});
