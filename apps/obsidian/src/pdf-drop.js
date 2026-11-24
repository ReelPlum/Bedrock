// The drop zone of "Import PDFs" in the settings, and the import's
// progress under it. Plain DOM (no Obsidian imports) so the browser harness
// runs it as the settings do. The import itself is bulk-import.js and lives
// with the plugin, so it goes on when the settings are closed.

/** A dropped or chosen File as the import takes it: read only when its
 *  turn comes, so hundreds of PDFs are never all in memory. */
const entryOf = (file, path = file.name) => ({ name: file.name, path, read: () => file.arrayBuffer() });

/** Every file in a dropped folder (and its folders), as File entries. */
async function walk(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push(entryOf(file, entry.fullPath?.replace(/^\//, '') || file.name));
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  // readEntries answers in batches (100 in Chromium) until an empty one.
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const e of batch) await walk(e, out);
  }
}

/** The files of a drop: folders are walked for their files. Entries must
 *  be taken from the DataTransfer before the drop handler returns. */
export async function droppedFiles(dataTransfer) {
  const items = [...(dataTransfer?.items || [])].filter((i) => i.kind === 'file');
  if (!items.length) return [...(dataTransfer?.files || [])].map((f) => entryOf(f));
  const taken = items.map((i) => ({ entry: i.webkitGetAsEntry?.() || null, file: i.getAsFile() }));
  const out = [];
  for (const { entry, file } of taken) {
    if (entry?.isDirectory) await walk(entry, out).catch(() => null);
    else if (file) out.push(entryOf(file));
  }
  return out;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A line saying how the import went. */
export function summary(s) {
  if (s.running) return `Importing ${s.done + 1 > s.total ? s.total : s.done + 1} of ${s.total}${s.current ? `: ${s.current}` : ''}…`;
  if (!s.total) return '';
  const made = `${plural(s.imported.length, 'note')} made at the top of the vault`;
  const failed = s.failed.length ? `; ${plural(s.failed.length, 'file')} not imported` : '';
  return `${s.stopped ? 'Stopped. ' : 'Done. '}${made}${failed}.`;
}

/** Builds the drop zone in `el` for `job` (a BulkImport). Returns
 *  `{ choose, close }`: choose opens the file picker, close lets go of the
 *  import's updates (the settings were closed). */
export function mountPdfDrop(el, job, doc = el.ownerDocument || document) {
  const make = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const zone = make('div', 'bedrock-pdf-drop');
  zone.tabIndex = 0;
  zone.setAttribute('role', 'button');
  zone.append(make('div', 'bedrock-pdf-drop-title', 'Drop PDFs or folders of PDFs here'));
  zone.append(make('div', 'bedrock-pdf-drop-hint', 'or tap to choose them'));
  const input = make('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.pdf,application/pdf';
  input.hidden = true;
  const status = make('div', 'bedrock-pdf-status');
  status.setAttribute('aria-live', 'polite');
  const line = make('div', 'bedrock-pdf-status-line');
  const bar = make('progress', 'bedrock-pdf-progress');
  const stop = make('button', 'bedrock-pdf-stop', 'Stop');
  stop.type = 'button';
  const row = make('div', 'bedrock-pdf-status-row');
  row.append(line, stop);
  const failures = make('details', 'bedrock-pdf-failures');
  status.append(row, bar, failures);
  el.append(zone, input, status);

  const add = (files) => { if (files.length) job.add(files); };
  const choose = () => input.click();
  zone.addEventListener('click', choose);
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
  input.addEventListener('change', () => {
    add([...(input.files || [])].map((f) => entryOf(f)));
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-dragging');
    droppedFiles(e.dataTransfer).then(add);
  });
  stop.addEventListener('click', () => job.stop());

  let shownFailed = 0;
  const render = (s) => {
    status.hidden = !s.total;
    line.textContent = summary(s);
    bar.max = Math.max(1, s.total);
    bar.value = s.done;
    bar.hidden = !s.running;
    stop.hidden = !s.running || s.stopped;
    failures.hidden = !s.failed.length;
    if (!s.failed.length) shownFailed = 0;
    // Only when it changed: a long list is not rebuilt after every file.
    if (s.failed.length && s.failed.length !== shownFailed) {
      shownFailed = s.failed.length;
      failures.replaceChildren(make('summary', null, `${plural(s.failed.length, 'file')} not imported`));
      const list = make('ul');
      for (const f of s.failed) list.append(make('li', null, `${f.name}: ${f.reason}`));
      failures.append(list);
    }
  };
  const unsubscribe = job.subscribe(render);
  return { choose, close: unsubscribe, zone, status };
}
