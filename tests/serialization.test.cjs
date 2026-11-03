const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, tick, deferred } = require('./helpers/background.cjs');

test('REL-06: persistence keeps immutable snapshots and serializes overlapping writes', async () => {
  const h = harness(); h.seed(1);
  const gate = deferred(), writes = [];
  h.chrome.storage.local.set = async value => {
    const snapshot = structuredClone(value);
    writes.push(snapshot);
    if (writes.length === 1) await gate.promise;
    Object.assign(h.state.local, snapshot);
  };
  h.run('fixtureBatch().paused=true');
  const older = h.context.saveSessions(); await tick();
  h.run('fixtureBatch().paused=false');
  const newer = h.context.saveSessions(); await tick();
  h.run('fixtureBatch().paused=true');
  const concurrentWrites = writes.length;
  gate.resolve(); await Promise.all([older, newer]);
  assert.equal(concurrentWrites, 1, 'the newer write must wait for the earlier write');
  assert.equal(writes[0].ffBatchState.batches[h.batchId()].paused, true);
  assert.equal(writes[1].ffBatchState.batches[h.batchId()].paused, false);
  assert.equal(h.state.local.ffBatchState.batches[h.batchId()].paused, false);
});

function activeDownload() {
  const h = harness({ records: new Map([[11, { id: 11, state: 'in_progress', paused: false }]]) });
  h.seed(1);
  h.run(`fixtureBatch().sourceClosed=true; fixtureBatch().sourceAttached=false;
    fixtureBatch().items[0].state='downloading'; fixtureBatch().items[0].downloadId=11;
    downloadIdToKey.set(11, {batchId:fixtureBatch().id, itemId:fixtureBatch().items[0].id, generation:0});
    recoveryPromise=Promise.resolve();`);
  return h;
}

test('REL-06: a delayed reconciliation cannot overwrite a newer cancellation', async () => {
  const h = activeDownload(), gate = deferred();
  h.chrome.downloads.search = (query, callback) => {
    const stale = structuredClone(h.state.records.get(query.id));
    gate.promise.then(() => callback([stale]));
  };
  const reconcile = h.context.reconcileBatch(h.batchId()); await tick();
  const cancel = h.message({ type: 'cancel_downloads', batchId: h.batchId() }); await tick();
  gate.resolve(); await reconcile;
  assert.equal((await cancel).ok, true);
  assert.equal(h.run('fixtureBatch().hasStarted'), false);
  assert.equal(h.run('fixtureBatch().generation'), 1);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'cancelled');
  assert.equal(h.run('downloadIdToKey.size'), 0);
});

test('REL-06: overlapping pause and resume follow request order', async () => {
  const h = activeDownload(), gate = deferred();
  const pauseDownload = h.chrome.downloads.pause;
  h.chrome.downloads.pause = async id => { await gate.promise; await pauseDownload(id); };
  const pause = h.message({ type: 'pause_downloads', batchId: h.batchId() }); await tick();
  const resume = h.message({ type: 'resume_downloads', batchId: h.batchId() }); await tick();
  gate.resolve();
  assert.equal((await pause).ok, true);
  assert.equal((await resume).ok, true);
  assert.deepEqual(h.resumed, [11]);
  assert.equal(h.state.records.get(11).paused, false);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'downloading');
  assert.equal(h.run('fixtureBatch().paused'), false);
});

test('REL-06: completion during a delayed pause retains terminal ownership', async () => {
  const h = activeDownload(), gate = deferred();
  h.chrome.downloads.pause = async () => { await gate.promise; };
  const pause = h.message({ type: 'pause_downloads', batchId: h.batchId() }); await tick();
  await h.emit('changed', { id: 11, state: { current: 'complete' } });
  gate.resolve(); await pause; await tick();
  assert.equal(h.run('fixtureBatch().items[0].state'), 'completed');
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), null);
  assert.equal(h.run('downloadIdToKey.size'), 0);
  assert.equal(h.state.local.ffBatchState.batches[h.batchId()].items[0].state, 'completed');
});

test('REL-06: a host fetch does not block cancellation or resurrect its download', async () => {
  const h = harness(), gate = deferred(); h.seed(1);
  h.context.fetch = async () => { await gate.promise; return { ok: true, text: async () => 'https://dl.fuckingfast.co/dl/test.rar' }; };
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  const result = await h.message({ type: 'cancel_downloads', batchId: h.batchId() });
  assert.equal(result.ok, true);
  gate.resolve(); await tick();
  assert.equal(h.downloads.length, 0);
});

test('REL-06: a rejected persistence operation does not poison later writes', async () => {
  const h = harness(); h.seed(1);
  h.state.storageError = new Error('Disk unavailable');
  await assert.rejects(h.context.saveSessions(), /Disk unavailable/);
  h.state.storageError = null;
  h.run('fixtureBatch().paused=true');
  await h.context.saveSessions();
  assert.equal(h.state.local.ffBatchState.batches[h.batchId()].paused, true);
});

test('REL-06: simultaneous scans share one source batch even while extraction is delayed', async () => {
  const h = harness(), gate = deferred();
  const extract = h.chrome.scripting.executeScript;
  let calls = 0;
  h.chrome.scripting.executeScript = async () => { calls++; await gate.promise; return extract(); };
  const first = h.context.ensureSessionForTab(h.state.activeTab); await tick();
  const second = h.context.ensureSessionForTab(h.state.activeTab); await tick();
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  assert.equal(calls, 1);
  assert.equal(h.run('Object.keys(sessions).length'), 1);
});

test('REL-06: a failed control operation does not poison the mutation queue', async () => {
  const h = activeDownload();
  const pause = h.chrome.downloads.pause;
  h.chrome.downloads.pause = async () => { throw new Error('Browser rejected pause'); };
  const failed = await h.message({ type: 'pause_downloads', batchId: h.batchId() });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /rejected pause/);
  h.chrome.downloads.pause = pause;
  assert.equal((await h.message({ type: 'pause_downloads', batchId: h.batchId() })).ok, true);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'paused');
});

test('REL-06: failed reservation persistence releases slots without making host requests', async () => {
  const h = harness(); h.seed(1);
  h.state.storageError = new Error('Disk unavailable');
  await assert.rejects(h.context.pumpQueueForBatch(h.batchId()), /Disk unavailable/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'queued');
  assert.equal(h.run('activeResolvers.size'), 0);
  h.state.storageError = null;
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  assert.equal(h.downloads.length, 1);
});

test('REL-06: late Chrome creation after Cancel is discarded without taking ownership', async () => {
  const h = harness(), created = deferred(); h.seed(1);
  let callback;
  h.chrome.downloads.download = (options, done) => { callback = done; created.resolve(); };
  await h.context.pumpQueueForBatch(h.batchId()); await created.promise;
  assert.equal((await h.message({ type: 'cancel_downloads', batchId: h.batchId() })).ok, true);
  callback(42); await tick();
  assert.deepEqual(h.cancelled, [42]);
  assert.equal(h.run('downloadIdToKey.size'), 0);
  assert.equal(h.run('Object.values(sessions).some(batch => batch.items.some(item => item.downloadId === 42))'), false);
});
