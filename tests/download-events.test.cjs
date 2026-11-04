const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, tick, deferred } = require('./helpers/background.cjs');

async function delayedCreation(count = 2) {
  const h = harness({ concurrency: 1 }); h.seed(count);
  const create = h.chrome.downloads.download;
  let release;
  h.chrome.downloads.download = (options, callback) => create(options, id => {
    if (id === 1) release = () => callback(id); else callback(id);
  });
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  return { h, release };
}

for (const [state, error, expected] of [
  ['complete', undefined, 'completed'],
  ['interrupted', 'NETWORK_FAILED', 'error'],
  ['interrupted', 'USER_CANCELED', 'cancelled']
]) {
  test(`REL-09: early ${state}/${error || 'success'} is recorded and frees exactly one slot`, async () => {
    const { h, release } = await delayedCreation();
    await h.emit('changed', { id: 1, state: { current: state }, ...(error ? { error: { current: error } } : {}) });
    release(); await tick();
    assert.equal(h.run('fixtureBatch().items[0].state'), expected);
    assert.equal(h.run('fixtureBatch().items[0].downloadId'), null);
    assert.equal(h.downloads.length, 2);
    assert.equal(h.run('fixtureBatch().items[1].state'), 'downloading');
    assert.equal(h.run('downloadIdToKey.has(1)'), false);
    await h.emit('changed', { id: 1, state: { current: state } });
    assert.equal(h.downloads.length, 2);
  });
}

test('REL-09: immediate status query catches completion when no event was observed', async () => {
  const { h, release } = await delayedCreation();
  h.state.records.get(1).state = 'complete';
  release(); await tick();
  assert.equal(h.run('fixtureBatch().items[0].state'), 'completed');
  assert.equal(h.downloads.length, 2);
});

test('REL-09: an early terminal event remains authoritative when status lookup fails', async () => {
  const { h, release } = await delayedCreation(1);
  await h.emit('changed', { id: 1, state: { current: 'complete' } });
  h.chrome.downloads.search = () => { throw new Error('Temporary history failure'); };
  release(); await tick();
  assert.equal(h.run('fixtureBatch().items[0].state'), 'completed');
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), null);
  assert.equal(h.run('downloadIdToKey.size'), 0);
});

test('REL-09: Cancel after early completion cannot restart queued files or restore a phantom download', async () => {
  const { h, release } = await delayedCreation();
  const owner = h.batchId();
  await h.emit('changed', { id: 1, state: { current: 'complete' } });
  await h.message({ type: 'cancel_downloads', batchId: owner });
  h.chrome.downloads.cancel = async () => { throw new Error('Already finished'); };
  release(); await tick();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.run('downloadIdToKey.size'), 0);
  assert.equal(h.run('Object.values(sessions).some(batch => batch.items.some(item => item.downloadId != null))'), false);
});

test('REL-08: external Pause/Resume updates live state and paused downloads retain their slots', async () => {
  const h = harness({ concurrency: 2 }); h.seed(3);
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  await h.emit('changed', { id: 1, paused: { current: true } });
  assert.equal(h.run('fixtureBatch().items[0].state'), 'paused');
  assert.equal(h.run('fixtureBatch().paused'), false);
  assert.equal(h.state.local.ffBatchState.batches[h.batchId()].items[0].state, 'paused');
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  assert.equal(h.downloads.length, 2, 'manual Pause must not reserve a replacement slot');
  await h.emit('changed', { id: 1, paused: { current: false }, state: { current: 'in_progress' } });
  assert.equal(h.run('fixtureBatch().items[0].state'), 'downloading');
  assert.equal(h.broadcasts.at(-1).session.items[0].state, 'downloading');
  assert.equal(h.downloads.length, 2);
});

test('REL-08: an external Resume does not release an explicitly paused batch queue', async () => {
  const h = harness({ concurrency: 1 }); h.seed(2);
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  await h.message({ type: 'pause_downloads', batchId: h.batchId() });
  await h.emit('changed', { id: 1, paused: { current: false } });
  assert.equal(h.run('fixtureBatch().items[0].state'), 'downloading');
  assert.equal(h.run('fixtureBatch().paused'), true);
  assert.equal(h.downloads.length, 1);
});

test('REL-08: erasing an active browser download updates ownership and advances the queue', async () => {
  const h = harness({ concurrency: 1 }); h.seed(2);
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  await h.emit('erased', 1);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'cancelled');
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), null);
  assert.equal(h.run('downloadIdToKey.has(1)'), false);
  assert.equal(h.downloads.length, 2);
});

test('REL-08: an early erase is retained even if registration status lookup fails', async () => {
  const { h, release } = await delayedCreation(1);
  await h.emit('erased', 1);
  h.chrome.downloads.search = () => { throw new Error('History unavailable'); };
  release(); await tick();
  assert.equal(h.run('fixtureBatch().items[0].state'), 'cancelled');
  assert.equal(h.run('downloadIdToKey.size'), 0);
});

test('REL-08: unrelated erases do not wake or mutate a batch', async () => {
  const h = harness(); h.seed(1);
  const before = h.run('JSON.stringify(sessions)');
  await h.emit('erased', 999);
  assert.equal(h.run('JSON.stringify(sessions)'), before);
  assert.equal(h.downloads.length, 0);
});

test('REL-08: Chrome can resume an interrupted download after worker recreation without creating another', async () => {
  const h = harness(); h.seed(1);
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  await h.emit('changed', { id: 1, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  const restored = harness({ local: h.state.local, records: h.state.records });
  await restored.emit('changed', { id: 1, state: { current: 'in_progress' }, paused: { current: false } });
  assert.equal(restored.run('fixtureBatch().items[0].state'), 'downloading');
  assert.equal(restored.run('fixtureBatch().items[0].downloadId'), 1);
  assert.equal(restored.run('fixtureBatch().paused'), true, 'external Resume must not silently release queued work');
  assert.equal(restored.downloads.length, 0);
});

test('REL-08: resuming an old Chrome attempt cannot overwrite a new retry of the same file', async () => {
  const h = harness(); h.seed(1);
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  await h.emit('changed', { id: 1, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  await h.message({ type: 'retry_failed', batchId: h.batchId() }); await tick();
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), 2);
  await h.emit('changed', { id: 1, state: { current: 'in_progress' }, paused: { current: false } });
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), 2);
  assert.equal(h.run('downloadIdToKey.size'), 2);
  assert.equal(h.run('fixtureBatch().items.length'), 2);
  assert.notEqual(h.run('downloadIdToKey.get(1).itemId'), h.run('downloadIdToKey.get(2).itemId'));
});

test('REL-08: erasing a finished Chrome record removes its resume association and retains batch results', async () => {
  const h = harness(); h.seed(1);
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  await h.emit('changed', { id: 1, state: { current: 'complete' } });
  assert.ok(h.state.local.ffBatchState.downloadHistory[1]);
  await h.emit('erased', 1);
  assert.equal(h.state.local.ffBatchState.downloadHistory[1], undefined);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'completed');
});

test('REL-08: an early Pause survives a failed registration query without releasing its slot', async () => {
  const { h, release } = await delayedCreation();
  await h.emit('changed', { id: 1, paused: { current: true } });
  h.chrome.downloads.search = () => { throw new Error('History unavailable'); };
  release(); await tick();
  assert.equal(h.run('fixtureBatch().items[0].state'), 'paused');
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), 1);
  assert.equal(h.downloads.length, 1);
});

test('REL-09: early event buffering is bounded and emptied after the creation window', async () => {
  const { h, release } = await delayedCreation(1);
  for (let id = 100; id < 500; id++) h.listeners.changed({ id, state: { current: 'complete' } });
  await tick();
  assert.ok(h.run('earlyDownloadEvents.size') <= 256);
  assert.equal(h.run('downloadIdToKey.size'), 0);
  h.state.records.get(1).state = 'complete';
  release(); await tick();
  assert.equal(h.run('fixtureBatch().items[0].state'), 'completed');
  assert.equal(h.run('earlyDownloadEvents.size'), 0);
  assert.equal(h.run('pendingDownloadCreations.size'), 0);
});

test('REL-09: recovery reconciles a persisted Chrome ID even if registration processing was interrupted', async () => {
  const { h, release } = await delayedCreation();
  h.run('recoveryPromise=Promise.resolve()');
  const gate = deferred();
  const save = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async value => {
    await save(value);
    if (value.ffBatchState.batches[h.batchId()].items[0].downloadId === 1) await gate.promise;
  };
  release(); await tick();
  const local = structuredClone(h.state.local);
  assert.equal(local.ffBatchState.batches[h.batchId()].items[0].downloadId, 1);
  h.state.records.get(1).state = 'complete';
  const restored = harness({ local, records: structuredClone(h.state.records), concurrency: 1 });
  await restored.message({ type: 'get_session' }); await tick();
  assert.equal(restored.run('fixtureBatch().items[0].state'), 'completed');
  assert.equal(restored.downloads.length, 1);
  assert.equal(restored.run('fixtureBatch().items[1].downloadId'), 2);
  gate.reject(new Error('Original worker stopped')); await tick();
});

test('REL-08: invalid saved resume associations are preserved instead of silently discarded', async () => {
  const h = harness(); h.seed(1);
  await h.context.pumpQueueForBatch(h.batchId()); await tick();
  const local = structuredClone(h.state.local);
  local.ffBatchState.downloadHistory[1].url = 'https://evil.example/file';
  const before = structuredClone(local);
  const restored = harness({ local });
  assert.equal((await restored.message({ type: 'get_session' })).ok, false);
  assert.deepEqual(local, before);
  assert.equal(restored.downloads.length, 0);
});

for (const [state, expected] of [['complete', 'completed'], ['interrupted', 'error']]) {
  test(`REL-09: erasing an early ${state} record retains the known terminal result`, async () => {
    const { h, release } = await delayedCreation(1);
    await h.emit('changed', { id: 1, state: { current: state }, error: { current: 'NETWORK_FAILED' } });
    await h.emit('erased', 1);
    release(); await tick();
    assert.equal(h.run('fixtureBatch().items[0].state'), expected);
    assert.equal(h.run('downloadIdToKey.size'), 0);
    assert.equal(h.state.local.ffBatchState.downloadHistory[1], undefined);
  });
}
