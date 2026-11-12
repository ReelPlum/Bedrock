// Folders in the notes list, and exporting the library for Obsidian, in
// Chromium with the real app and IndexedDB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launch, openApp } from './helpers.mjs';
import { readZip, text } from '../src/zip-read.js';
import { noteOfIndex } from '../src/sidecar.js';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

async function openLibrary(page) {
  if (await page.locator('#library').isHidden()) await page.click('#btn-library');
  await page.waitForSelector('#library:not([hidden])');
}

async function newFolder(page, name) {
  await page.click('#btn-new-folder');
  await page.fill('#note-list .folder-name', name);
  await page.press('#note-list .folder-name', 'Enter');
  await page.waitForSelector(`#note-list li.folder[data-folder] >> text=${name}`);
}

/** Open a folder from the list and wait until the list shows it. */
async function enter(page, name) {
  await page.click(`#note-list li.folder >> text=${name}`);
  await page.waitForFunction((n) => document.getElementById('library-title').textContent === n, name);
}

/** Go up one folder and wait until the list shows `name`. */
async function up(page, name) {
  await page.click('#library-up');
  await page.waitForFunction((n) => document.getElementById('library-title').textContent === n, name);
}

/** "New note" in the list, and wait until the new note is open. */
async function newNote(page) {
  const before = await page.evaluate(() => bedrock.noteId);
  await page.click('#library [data-action="new"]');
  await page.waitForFunction((id) => bedrock.noteId !== id, before);
}

const rows = (page) => page.$$eval('#note-list li', (lis) => lis.map((li) => li.querySelector('strong')?.textContent ?? li.textContent));

test('folders: make nested folders, write a note in one, and find it there after a reload', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const { page, errors } = await openApp(env, { context });
  await openLibrary(page);
  await newFolder(page, 'School');
  await newFolder(page, 'Home');
  assert.deepEqual((await rows(page)).slice(0, 2), ['Home', 'School'], 'folders first, by name');

  await enter(page, 'School');
  await newFolder(page, 'Physics');
  // A second "physics" here is refused, and the name can be fixed.
  await page.click('#btn-new-folder');
  await page.fill('#note-list .folder-name', 'physics');
  await page.press('#note-list .folder-name', 'Enter');
  await page.waitForFunction(() => /already a folder called/.test(document.getElementById('toast').textContent));
  await page.fill('#note-list .folder-name', 'Chemistry');
  await page.press('#note-list .folder-name', 'Enter');
  await page.waitForSelector('#note-list >> text=Chemistry');

  await enter(page, 'Physics');
  assert.equal(await page.textContent('#library-up'), '‹ School');
  assert.deepEqual(await rows(page), ['This folder is empty.']);
  await newNote(page);
  const id = await page.evaluate(async () => {
    document.getElementById('title').value = 'Forces';
    document.getElementById('title').dispatchEvent(new Event('input'));
    await t.line(200, 300, 600, 300);
    await bedrock.saveNow();
    return bedrock.noteId;
  });

  await page.reload();
  await page.waitForFunction(() => window.bedrock && window.bedrock.ready);
  assert.equal(await page.evaluate(() => bedrock.noteId), id, 'the note reopens');
  await openLibrary(page);
  // The list shows the folder it showed.
  await page.waitForFunction(() => document.getElementById('library-title').textContent === 'Physics');
  assert.deepEqual(await rows(page), ['Forces']);
  const saved = await page.evaluate((id) => bedrock.store.get(id).then((n) => n.folder), id);
  const folders = await page.evaluate(() => bedrock.store.listFolders());
  assert.equal(folders.find((f) => f.id === saved)?.name, 'Physics');
  await up(page, 'School');
  await up(page, 'Notes');
  assert.ok(await page.locator('#library-up').isHidden());
  assert.deepEqual(errors, []);
  await context.close();
});

test('an autosave while a folder is being named keeps the name being typed', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const { page, errors } = await openApp(env, { context });
  await openLibrary(page);
  await page.click('#btn-new-folder');
  await page.fill('#note-list .folder-name', 'Half typ');
  await page.evaluate(() => bedrock.saveNow());
  assert.equal(await page.inputValue('#note-list .folder-name'), 'Half typ');
  await page.press('#note-list .folder-name', 'Enter');
  await page.waitForSelector('#note-list li.folder >> text=Half typ');
  assert.deepEqual(errors, []);
  await context.close();
});

test('folders: move a note, rename a folder, and deleting a folder deletes what is in it', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const { page, errors } = await openApp(env, { context });
  const id = await page.evaluate(async () => {
    document.getElementById('title').value = 'Groceries';
    document.getElementById('title').dispatchEvent(new Event('input'));
    await t.line(200, 300, 600, 300);
    await bedrock.saveNow();
    return bedrock.noteId;
  });
  await openLibrary(page);
  await newFolder(page, 'Home');
  // Move it into Home with the row's picker.
  const home = await page.evaluate(() => bedrock.store.listFolders().then((f) => f[0].id));
  await page.selectOption(`#note-list li[data-note="${id}"] select.move`, home);
  await page.waitForFunction(() => !document.querySelector('#note-list li[data-note]'));
  assert.match(await page.textContent('#note-list li.folder'), /1 item/);
  // The open note keeps its new folder when it is saved again.
  await page.evaluate(async () => { await t.line(200, 400, 600, 400); await bedrock.saveNow(); });
  assert.equal(await page.evaluate((id) => bedrock.store.get(id).then((n) => n.folder), id), home);
  await openLibrary(page); // drawing closed it
  await page.waitForSelector('#note-list li.folder');

  await page.click('#note-list li.folder .rename');
  await page.fill('#note-list .folder-name', 'House');
  await page.press('#note-list .folder-name', 'Enter');
  await page.waitForSelector('#note-list li.folder >> text=House');

  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.accept(); });
  await page.click('#note-list li.folder .delete');
  await page.waitForFunction(() => !document.querySelector('#note-list li.folder'));
  assert.match(asked, /Delete the folder “House” and the 1 note in it/);
  assert.equal(await page.evaluate((id) => bedrock.store.get(id), id), null, 'its note is gone');
  assert.notEqual(await page.evaluate(() => bedrock.noteId), id, 'the open note was in it: a new note is open');
  assert.equal(await page.evaluate(() => bedrock.canvas.stroke_count()), 0);
  // ...and is not brought back by a save that was waiting.
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate((id) => bedrock.store.get(id), id), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test('notes saved before folders existed are kept, at the top', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  // A database as the app before folders left it (version 1).
  await page.goto(`${env.url}manifest.webmanifest`);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('bedrock', 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore('notes', { keyPath: 'id' });
      s.createIndex('modified', 'modified');
      r.result.createObjectStore('kv');
      s.put({ id: 'old0000000000001', title: 'Old note', created: 1, modified: 2, data: new Uint8Array([1]) });
    };
    r.onsuccess = () => { r.result.close(); resolve(); };
    r.onerror = () => reject(r.error);
  }));
  const { page: app } = await openApp(env, { context });
  await openLibrary(app);
  // (The blank note the app opened with may be saved at any moment.)
  const mine = async () => (await rows(app)).filter((r) => r !== 'Untitled note');
  await app.waitForSelector('#note-list li[data-note]');
  assert.deepEqual(await mine(), ['Old note']);
  await newFolder(app, 'New');
  assert.deepEqual(await mine(), ['New', 'Old note']);
  await context.close();
});

test('export: the library becomes folders of notes, each with its Obsidian sidecar', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1024, height: 768 }, acceptDownloads: true });
  // A plain download, as on browsers without a save dialog.
  await context.addInitScript(() => { delete window.showSaveFilePicker; });
  const { page, errors } = await openApp(env, { context });
  await openLibrary(page);
  await newFolder(page, 'School');
  await enter(page, 'School');
  await newFolder(page, 'Empty');
  await newNote(page);
  await page.evaluate(async () => {
    document.getElementById('title').value = 'Forces';
    document.getElementById('title').dispatchEvent(new Event('input'));
    await t.line(200, 300, 600, 300);
    await bedrock.saveNow();
  });
  await page.click('#btn-menu');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export-all"]')]);
  assert.match(download.suggestedFilename(), /^Bedrock notes \d{4}-\d\d-\d\d\.zip$/);
  const zip = await readFile(await download.path());
  // Directory names have to be read from the central directory itself:
  // readZip keys entries by their file name.
  const names = [];
  for (let p = 0; (p = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), p)) >= 0; p += 46) {
    names.push(zip.subarray(p + 46, p + 46 + zip.readUInt16LE(p + 28)).toString());
  }
  // (The blank note the app opened with is exported too, at the top.)
  assert.deepEqual(names.filter((n) => n.startsWith('School')), ['School/', 'School/Empty/', 'School/Forces.bedrock', 'School/Forces.bedrock.md']);
  const files = await readZip(zip);
  const md = text(files.get('Forces.bedrock.md'));
  assert.equal(noteOfIndex(md), 'School/Forces.bedrock');
  assert.match(md, /tags: \[bedrock\]/);
  // The note inside is a whole .bedrock file.
  const inner = await readZip(files.get('Forces.bedrock'));
  assert.ok(inner.has('note.json') && inner.has('recognized.json'));
  assert.deepEqual(errors, []);
  await context.close();
});
