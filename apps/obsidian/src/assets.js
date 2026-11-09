// The plugin ships as one main.js (that is all Obsidian's plugin directory
// installs), so the web app's files are packed into it at build time
// (build.mjs) and unpacked into the plugin's folder on first start and after
// each update. The view then loads them in an iframe from there, exactly as
// a browser loads the web app: same HTML, modules, workers and WebAssembly.

const b64 = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Unpack `bundle` ({ hash, files: { path: base64 } }) into `dir` with an
 *  Obsidian DataAdapter, unless that version is already there. Returns
 *  true if it wrote files. */
export async function installWebApp(adapter, dir, bundle) {
  const stamp = `${dir}/.version`;
  if ((await adapter.exists(stamp)) && (await adapter.read(stamp)).trim() === bundle.hash) return false;
  const made = new Set();
  for (const [path, data] of Object.entries(bundle.files)) {
    const full = `${dir}/${path}`;
    const parts = full.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (made.has(d)) continue;
      if (!(await adapter.exists(d))) await adapter.mkdir(d);
      made.add(d);
    }
    const bytes = b64(data);
    await adapter.writeBinary(full, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  await adapter.write(stamp, bundle.hash);
  return true;
}

/** The iframe address of the unpacked web app. */
export function webAppUrl(adapter, dir, hash) {
  const base = adapter.getResourcePath(`${dir}/index.html`).replace(/\?.*$/, '');
  return `${base}?host=obsidian&v=${encodeURIComponent(hash)}`;
}
