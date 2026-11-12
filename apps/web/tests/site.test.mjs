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
