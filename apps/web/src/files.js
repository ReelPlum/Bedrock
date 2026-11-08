// Getting notes into and out of iCloud Drive (and any other Files location).
//
// A website cannot write to iCloud Drive directly. What works today:
//  * iPad / iPhone Safari: the share sheet (navigator.share with a file)
//    offers "Save to Files", where iCloud Drive is the default location.
//    Opening uses the Files picker, which browses iCloud Drive.
//  * Chrome / Edge on a Mac or PC: the File System Access API saves straight
//    into a folder, e.g. ~/Library/Mobile Documents/com~apple~CloudDocs
//    (iCloud Drive), and later saves overwrite the same file.
//  * Everything else: a normal download.
// Automatic iCloud sync needs CloudKit; see cloud.js and docs/icloud.md.

export function safeFileName(title, ext) {
  const base = (title || 'Untitled note').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'note';
  return `${base}.${ext}`;
}

/**
 * Save bytes as a file. Returns how it was saved:
 * 'picker' | 'share' | 'download' | 'cancelled'.
 * `handleStore` (optional) remembers file handles so re-saving overwrites.
 */
export async function saveFile(bytes, name, mime, { handleKey, handleStore } = {}) {
  const blob = new Blob([bytes], { type: mime });

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      let handle = handleKey && handleStore ? await handleStore.getKv(`handle:${handleKey}`) : null;
      if (handle && (await handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
        if ((await handle.requestPermission?.({ mode: 'readwrite' })) !== 'granted') handle = null;
      }
      if (!handle) {
        const ext = name.slice(name.lastIndexOf('.'));
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Bedrock note', accept: { [mime]: [ext] } }],
        });
      }
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      if (handleKey && handleStore) await handleStore.setKv(`handle:${handleKey}`, handle).catch(() => {});
      return 'picker';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // Fall through to the other methods.
    }
  }

  const file = new File([blob], name, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'share';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'download';
}

/** Let the user pick a file (Files app / iCloud Drive on iPad). */
export function pickFile(input) {
  return new Promise((resolve) => {
    // No `accept` filter: iOS greys out unknown extensions such as .bedrock.
    input.value = '';
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    };
    input.click();
  });
}
