// Checks a plugin release before it is published, and writes the
// manifest.json that goes into the GitHub release. Used by
// .github/workflows/obsidian-release.yml.
//
// Obsidian and BRAT find the plugin's files in the GitHub release whose tag
// is the plugin version, so plugin releases use bare version tags
// (`0.2.0`, or `0.2.0-beta.1` for a beta). Releases of the other apps must
// not be GitHub releases (see README.md, "Releasing").
//
//   node release.mjs check <tag>          fail unless <tag> can be released
//   node release.mjs stamp <tag> <dir>    write <dir>/manifest.json for <tag>
import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const VERSION = /^\d+\.\d+\.\d+$/;
const TAG = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

/** Obsidian's rules for manifest.json and versions.json
 *  (docs.obsidian.md/Reference/Manifest). Returns a list of problems. */
export function manifestProblems(manifest, versions) {
  const problems = [];
  for (const key of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) problems.push(`manifest.json needs "${key}"`);
  }
  if (typeof manifest.isDesktopOnly !== 'boolean') problems.push('manifest.json needs "isDesktopOnly" (true or false)');
  const { id = '', name = '', version = '', minAppVersion = '', description = '' } = manifest;
  if (!/^[a-z]+(-[a-z]+)*$/.test(id)) problems.push(`id "${id}" may only have lowercase letters and hyphens`);
  if (/obsidian/i.test(id) || /plugin$/.test(id)) problems.push(`id "${id}" must not contain "obsidian" or end with "plugin"`);
  if (/obsidian|plugin/i.test(name)) problems.push(`name "${name}" must not contain "Obsidian" or "Plugin"`);
  if (!VERSION.test(version)) problems.push(`version "${version}" must be x.y.z`);
  if (!VERSION.test(minAppVersion)) problems.push(`minAppVersion "${minAppVersion}" must be x.y.z`);
  if (description.length > 250) problems.push('description must be at most 250 characters');
  if (!description.endsWith('.')) problems.push('description must end with a period');
  if (/^this is a plugin/i.test(description)) problems.push('description must not start with "This is a plugin"');
  if (versions?.[version] !== minAppVersion) {
    problems.push(`versions.json must map "${version}" to "${minAppVersion}" (the manifest's minAppVersion)`);
  }
  return problems;
}

/** What to publish for `tag`: the manifest that goes into the release
 *  (its version is the tag, as Obsidian and BRAT require) and whether it
 *  is a beta. Throws if the tag cannot be released. */
export function planRelease(manifest, versions, tag) {
  const problems = manifestProblems(manifest, versions);
  const m = TAG.exec(tag);
  if (!m) {
    problems.push(`tag "${tag}" is not a plugin version (0.2.0, or 0.2.0-beta.1 for a beta)`);
  } else if (!m[2] && tag !== manifest.version) {
    problems.push(`tag "${tag}" must be the version in manifest.json ("${manifest.version}"); bump manifest.json and versions.json first`);
  }
  if (problems.length) throw new Error(`Cannot release ${tag}:\n- ${problems.join('\n- ')}`);
  return { manifest: { ...manifest, version: tag }, prerelease: Boolean(m[2]) };
}

async function readRoot() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  const versions = JSON.parse(await readFile(join(ROOT, 'versions.json'), 'utf8'));
  return { manifest, versions };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, tag, dir] = process.argv.slice(2);
  try {
    if (!['check', 'stamp'].includes(cmd) || !tag || (cmd === 'stamp' && !dir)) {
      throw new Error('usage: node release.mjs check <tag> | stamp <tag> <dir>');
    }
    const { manifest, versions } = await readRoot();
    const plan = planRelease(manifest, versions, tag);
    if (cmd === 'stamp') {
      await writeFile(join(resolve(dir), 'manifest.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`);
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `prerelease=${plan.prerelease}\n`);
    console.log(`${tag}: ok${plan.prerelease ? ' (beta)' : ''}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
