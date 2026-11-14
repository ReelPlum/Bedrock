// keepStorage(): asking the browser to keep the notes and cached models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepStorage } from '../src/storage.js';

test('the browser is asked to keep storage, once kept it is not asked again, and nothing throws', async () => {
  let asked = 0;
  assert.equal(await keepStorage({ persisted: async () => false, persist: async () => { asked++; return true; } }), true);
  assert.equal(asked, 1);
  assert.equal(await keepStorage({ persisted: async () => true, persist: async () => { asked++; return true; } }), true);
  assert.equal(asked, 1, 'already kept: not asked');
  assert.equal(await keepStorage({ persisted: async () => false, persist: async () => false }), false, 'the browser said no');
  assert.equal(await keepStorage({ persist: async () => { throw new Error('denied'); } }), false);
  assert.equal(await keepStorage(undefined), false, 'no storage manager (older browsers)');
});
