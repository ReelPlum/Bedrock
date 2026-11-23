// The link picker reads another note's file to show its words
// (src/link-picker.js). Since note.json version 2 the pen samples are in
// points.bin, so the picker reads that too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openApp } from './helpers.mjs';
import { notePicture, readPointsBin } from '../src/link-picker.js';
import { readZip, text } from '../src/zip-read.js';

let env;
before(async () => { env = await launch(); });
after(async () => { await env?.close(); });

// The bug: notes saved since points.bin keep no `points` in note.json, and
// the picker took word bounds from there only, so it showed no words.
test('the link picker finds the words of a note saved with points.bin, at their place (regression)', async () => {
  const { page, ctx } = await openApp(env);
  const { file, json } = await page.evaluate(async () => {
    bedrock.handwriting.engine = async () => ({ text: 'Newtn', engine: 'fake' });
    for (let k = 0; k < 4; k++) {
      const x = 150 + k * 22;
      t.ev('pointerdown', 1, 'pen', x, 300, { pressure: 0.6 });
      for (let j = 1; j <= 8; j++) t.ev('pointermove', 1, 'pen', x + j * 2, 300 - (j % 2) * 26, { pressure: 0.6 });
      t.ev('pointerup', 1, 'pen', x + 16, 300, { pressure: 0 });
    }
    await t.frame();
    await bedrock.handwriting.run();
    await bedrock.saveNow();
    const n = await bedrock.store.get(bedrock.noteId);
    return { file: [...n.data], json: bedrock.canvas.export_json() };
  });
  await ctx.close();
  const bytes = new Uint8Array(file);
  const z = await readZip(bytes);
  const note = JSON.parse(text(z.get('note.json')));
  assert.equal(note.pointsFile, 'points.bin', 'a version 2 file');
  assert.ok(note.strokes.every((s) => !s.points), 'its samples are all in points.bin');

  // points.bin gives exactly the samples the version 1 JSON holds.
  const v1 = JSON.parse(json);
  assert.deepEqual(readPointsBin(z.get('points.bin'), note.channels.length), v1.strokes.map((s) => s.points));

  const pic = await notePicture(bytes);
  assert.equal(pic.words.length, 1);
  assert.equal(pic.words[0].text, 'Newtn');
  assert.ok(note.strokes.some((s) => s.id === pic.words[0].stroke));
  const xs = v1.strokes.flatMap((s) => s.points.filter((_, i) => i % note.channels.length === 0));
  assert.deepEqual([pic.words[0].bounds[0], pic.words[0].bounds[2]], [Math.min(...xs), Math.max(...xs)]);
});

test('a damaged points.bin gives no samples instead of failing, and a crafted count cannot exhaust memory', () => {
  assert.equal(readPointsBin(new Uint8Array([0x42, 0x44, 0x50, 0x54, 1, 6, 1]), 6), null, 'cut short');
  assert.equal(readPointsBin(new TextEncoder().encode('not points'), 6), null, 'not points.bin');
  // One channel "x", one stroke that claims a billion samples.
  const huge = new Uint8Array([0x42, 0x44, 0x50, 0x54, 1, 1, 1, 0x78, 3, 1, 0x80, 0x94, 0xeb, 0xdc, 0x03, 2]);
  assert.equal(readPointsBin(huge, 1), null, 'a count the file cannot hold');
});
