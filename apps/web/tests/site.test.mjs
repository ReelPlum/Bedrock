// Bug: the /train pages were built but never published, because the Pages
// workflow copies an explicit list of files. Every top-level file or folder
// the app serves must be in that list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(new URL('../../../.github/workflows/pages.yml', import.meta.url), 'utf8');
// Development and test files are not part of the site.
const NOT_SITE = new Set(['node_modules', 'tests', 'package.json', 'package-lock.json', 'serve.mjs']);

test('the Pages workflow publishes every part of the web app', () => {
  const line = workflow.split('\n').find((l) => l.includes('cp -r') && l.includes('_site'));
  assert.ok(line, 'the copy step exists');
  const copied = new Set(line.trim().split(/\s+/).slice(2, -1));
  const missing = readdirSync(web).filter((f) => !NOT_SITE.has(f) && !f.startsWith('.') && !copied.has(f));
  assert.deepEqual(missing, [], `not published: ${missing.join(', ')}`);
});

// Bug: build-web.sh skipped wasm-opt when it was not installed, and CI never
// installed it, so the published WebAssembly was never optimised.
test('CI and the Pages workflow install wasm-opt and fail without it', () => {
  for (const name of ['pages.yml', 'ci.yml']) {
    const yml = readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8');
    assert.match(yml, /binaryen-version_\d+-x86_64-linux\.tar\.gz/, `${name} installs binaryen`);
    assert.match(yml, /BEDROCK_REQUIRE_WASM_OPT: '1'/, `${name} requires wasm-opt`);
  }
  const script = readFileSync(new URL('../../../scripts/build-web.sh', import.meta.url), 'utf8');
  assert.match(script, /BEDROCK_REQUIRE_WASM_OPT/);
  assert.match(script, /for crate in bedrock-web bedrock-pdf/, 'PDF import is built as its own module');
});
