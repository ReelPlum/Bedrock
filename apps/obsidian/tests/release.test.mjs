// The plugin's manifest and the checks run before a release is published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { manifestProblems, planRelease } from '../release.mjs';

const root = (f) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8').then(JSON.parse);

const good = {
  id: 'bedrock-notes',
  name: 'Bedrock',
  version: '0.2.0',
  minAppVersion: '1.5.0',
  description: 'Handwritten notes.',
  author: 'Bedrock',
  isDesktopOnly: false,
};
const goodVersions = { '0.1.0': '1.5.0', '0.2.0': '1.5.0' };

test("manifest.json at the repository root follows Obsidian's rules and is listed in versions.json", async () => {
  const manifest = await root('manifest.json');
  const versions = await root('versions.json');
  assert.deepEqual(manifestProblems(manifest, versions), []);
  assert.equal(manifest.id, 'bedrock-notes', 'the id cannot change once people have installed the plugin');
});

test('a release tag must be the manifest version; a beta tag gets its own version in the released manifest', () => {
  const stable = planRelease(good, goodVersions, '0.2.0');
  assert.equal(stable.prerelease, false);
  assert.equal(stable.manifest.version, '0.2.0');

  const beta = planRelease(good, goodVersions, '0.3.0-beta.1');
  assert.equal(beta.prerelease, true);
  assert.equal(beta.manifest.version, '0.3.0-beta.1', 'BRAT and Obsidian want the tag and the released version to match');
  assert.equal(good.version, '0.2.0', 'the committed manifest is not changed');

  assert.throws(() => planRelease(good, goodVersions, '0.3.0'), /must be the version in manifest.json/);
  for (const tag of ['v0.2.0', 'web-0.2.0', '0.2', '0.2.0-']) {
    assert.throws(() => planRelease(good, goodVersions, tag), /not a plugin version/, tag);
  }
});

test("a release is refused when the manifest breaks Obsidian's rules", () => {
  const cases = [
    [{ ...good, id: 'obsidian-bedrock' }, /must not contain "obsidian"/],
    [{ ...good, id: 'bedrock-plugin' }, /end with "plugin"/],
    [{ ...good, id: 'Bedrock_Notes' }, /lowercase letters and hyphens/],
    [{ ...good, name: 'Bedrock Plugin' }, /must not contain "Obsidian" or "Plugin"/],
    [{ ...good, description: 'No period' }, /end with a period/],
    [{ ...good, description: `${'a'.repeat(250)}.` }, /at most 250/],
    [{ ...good, isDesktopOnly: undefined }, /isDesktopOnly/],
    [{ ...good, minAppVersion: '1.6.0' }, /versions.json must map "0.2.0" to "1.6.0"/],
  ];
  for (const [manifest, problem] of cases) {
    assert.throws(() => planRelease(manifest, goodVersions, manifest.version), problem);
  }
  assert.throws(() => planRelease(good, { '0.1.0': '1.5.0' }, '0.2.0'), /versions.json must map "0.2.0"/);
});
