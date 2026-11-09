// Fetches the exact Transformers.js the recogniser loads from the CDN, so
// the browser tests can serve it locally (the package itself pulls in
// native Node modules the tests don't need). Run by `npm test`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TRANSFORMERS_VERSION = '4.3.1';
const dir = fileURLToPath(new URL('./.cache/', import.meta.url));
export const TRANSFORMERS_JS = `${dir}package/dist/transformers.min.js`;

if (!existsSync(TRANSFORMERS_JS)) {
  mkdirSync(dir, { recursive: true });
  const tgz = execFileSync('npm', ['pack', `@huggingface/transformers@${TRANSFORMERS_VERSION}`, '--silent'], { cwd: dir }).toString().trim().split('\n').pop();
  execFileSync('tar', ['xzf', tgz, 'package/dist/transformers.min.js'], { cwd: dir });
}
