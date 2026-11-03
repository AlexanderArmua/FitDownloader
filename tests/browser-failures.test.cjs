const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, tick, deferred } = require('./helpers/background.cjs');

function tracked(count = 2, paused = false) {
  const h = harness(); h.seed(count);
  h.run(`fixtureBatch().paused=${paused}; fixtureBatch().sourceAttached=false;
    fixtureBatch().items.forEach((item,index) => {
      item.downloadId=index+11; item.state=${JSON.stringify(paused ? 'paused' : 'downloading')};
      downloadIdToKey.set(item.downloadId,{batchId:fixtureBatch().id,itemId:item.id,generation:0});
    }); recoveryPromise=Promise.resolve();`);
  for (let id = 11; id < 11 + count; id++) h.state.records.set(id, { id, state: 'in_progress', paused });
  return h;
}

test('REL-07: search rejection preserves ownership while other downloads reconcile', async () => {
  const h = tracked();
  const search = h.chrome.downloads.search;
  h.state.records.get(12).state = 'complete';
  h.chrome.downloads.search = (query, callback) => {
    if (query.id !== 11) return search(query, callback);
    h.chrome.runtime.lastError = { message: 'Download history unavailable' };
    callback(); delete h.chrome.runtime.lastError;
  };
  await h.reconcile();
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), 11);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'downloading');
  assert.match(h.run('fixtureBatch().items[0].syncError'), /history unavailable/);
  assert.equal(h.run('downloadIdToKey.has(11)'), true);
  assert.equal(h.run('fixtureBatch().items[1].state'), 'completed');
  h.chrome.downloads.search = search;
  await h.reconcile();
  assert.equal(h.run('fixtureBatch().items[0].syncError'), '');
  assert.equal(h.downloads.length, 0);
});

test('REL-07: partial Pause persists successes and failed ownership, then retries only failures', async () => {
  const h = tracked(), pause = h.chrome.downloads.pause;
  h.chrome.downloads.pause = async id => { if (id === 11) throw new Error('Cannot pause this download'); await pause(id); };
  const response = await h.message({ type: 'pause_downloads', batchId: h.batchId() });
  assert.equal(response.ok, false);
  assert.match(response.error, /pause/i);
  assert.deepEqual(h.paused, [12]);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'downloading');
  assert.equal(h.run('fixtureBatch().items[1].state'), 'paused');
  assert.equal(h.run('fixtureBatch().paused'), true);
  assert.equal(h.run('downloadIdToKey.size'), 2);
  assert.equal(h.state.local.ffBatchState.batches[h.batchId()].pendingControl, 'pause');
  h.chrome.downloads.pause = pause;
  assert.equal((await h.message({ type: 'pause_downloads', batchId: h.batchId() })).ok, true);
  assert.deepEqual(h.paused, [12, 11]);
  assert.equal(h.run('fixtureBatch().controlError'), '');
});

test('REL-07: partial Resume holds queued work and persists each actual browser state', async () => {
  const h = tracked(3, true), resume = h.chrome.downloads.resume;
  h.run('fixtureBatch().items[2].state="queued"; fixtureBatch().items[2].downloadId=null; downloadIdToKey.delete(13)');
  h.chrome.downloads.resume = async id => { if (id === 11) throw new Error('Cannot resume this download'); await resume(id); };
  const response = await h.message({ type: 'resume_downloads', batchId: h.batchId() });
  assert.equal(response.ok, false);
  assert.deepEqual(h.resumed, [12]);
  assert.equal(h.run('fixtureBatch().paused'), true);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'paused');
  assert.equal(h.run('fixtureBatch().items[1].state'), 'downloading');
  assert.equal(h.downloads.length, 0);
  assert.equal(h.state.local.ffBatchState.batches[h.batchId()].items[1].state, 'downloading');
  h.chrome.downloads.resume = resume;
  assert.equal((await h.message({ type: 'resume_downloads', batchId: h.batchId() })).ok, true);
  assert.deepEqual(h.resumed, [12, 11]);
  assert.equal(h.run('fixtureBatch().paused'), false);
  assert.equal(h.run('fixtureBatch().pendingControl'), '');
});

test('REL-07: Cancel awaits Chrome and retains failed downloads under the current generation', async () => {
  const h = tracked(), gate = deferred(), cancel = h.chrome.downloads.cancel;
  let responded = false;
  h.chrome.downloads.cancel = async id => { if (id === 11) { await gate.promise; throw new Error('Cancel rejected'); } await cancel(id); };
  const result = h.message({ type: 'cancel_downloads', batchId: h.batchId() }).then(response => { responded = true; return response; });
  await tick(); const earlyResponse = responded;
  gate.resolve(); const response = await result; await tick();
  assert.equal(earlyResponse, false);
  assert.equal(response.ok, false);
  assert.equal(h.run('fixtureBatch().hasStarted'), true);
  assert.equal(h.run('fixtureBatch().paused'), true);
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), 11);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'downloading');
  assert.equal(h.run('fixtureBatch().items[1].state'), 'cancelled');
  assert.equal(h.run('downloadIdToKey.get(11).generation === fixtureBatch().generation'), true);
  assert.equal(h.run('Object.keys(sessions).length'), 1, 'partial Cancel must not rescan');
  h.chrome.downloads.cancel = cancel;
  assert.equal((await h.message({ type: 'cancel_downloads', batchId: h.batchId() })).ok, true);
  assert.equal(h.run('downloadIdToKey.size'), 0);
});

test('REL-07: failed automatic Pause after Chrome creation persists the real download ID', async () => {
  const h = harness(), created = deferred(); h.seed(1);
  let callback;
  h.chrome.downloads.download = (options, done) => { callback = done; created.resolve(); };
  await h.context.pumpQueueForBatch(h.batchId()); await created.promise;
  await h.message({ type: 'pause_downloads', batchId: h.batchId() });
  h.chrome.downloads.pause = async () => { throw new Error('Automatic pause rejected'); };
  callback(42); await tick();
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), 42);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'downloading');
  assert.equal(h.state.local.ffBatchState.batches[h.batchId()].items[0].downloadId, 42);
  assert.match(h.run('fixtureBatch().controlError'), /pause/i);
});

test('REL-07: failed cancellation of a late creation retains recoverable ownership', async () => {
  const h = harness(), created = deferred(); h.seed(1);
  let callback;
  h.chrome.downloads.download = (options, done) => { callback = done; created.resolve(); };
  await h.context.pumpQueueForBatch(h.batchId()); await created.promise;
  const owner = h.batchId();
  await h.message({ type: 'cancel_downloads', batchId: owner });
  h.chrome.downloads.cancel = async () => { throw new Error('Late cancel rejected'); };
  callback(42); await tick();
  assert.equal(h.run('downloadIdToKey.has(42)'), true);
  const saved = h.state.local.ffBatchState;
  assert.equal(saved.downloadMap[42].batchId, owner);
  assert.equal(saved.batches[owner].hasStarted, true);
  assert.equal(saved.batches[owner].paused, true);
  assert.equal(saved.batches[owner].pendingControl, 'cancel');
});

test('REL-07: partial cancellation survives worker recovery without duplicate starts', async () => {
  const h = tracked(), cancel = h.chrome.downloads.cancel;
  h.chrome.downloads.cancel = async id => { if (id === 11) throw new Error('Still running'); await cancel(id); };
  await h.message({ type: 'cancel_downloads', batchId: h.batchId() });
  const restored = harness({ local: h.state.local, records: h.state.records });
  await restored.message({ type: 'get_session' }); await tick();
  assert.equal(restored.run('fixtureBatch().items[0].downloadId'), 11);
  assert.equal(restored.run('fixtureBatch().pendingControl'), 'cancel');
  assert.equal(restored.run('fixtureBatch().paused'), true);
  assert.equal(restored.run('downloadIdToKey.get(11).generation === fixtureBatch().generation'), true);
  assert.equal(restored.downloads.length, 0);
});

test('REL-07: completion still clears ownership after a rejected Cancel', async () => {
  const h = tracked(1);
  h.chrome.downloads.cancel = async () => { throw new Error('Still running'); };
  await h.message({ type: 'cancel_downloads', batchId: h.batchId() });
  await h.emit('changed', { id: 11, state: { current: 'complete' } });
  assert.equal(h.run('fixtureBatch().items[0].state'), 'completed');
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), null);
  assert.equal(h.run('downloadIdToKey.size'), 0);
  assert.equal(h.run('fixtureBatch().controlError'), '');
  assert.equal(h.run('fixtureBatch().hasStarted'), false);
});

test('REL-07: reconciliation clears a failed control only after Chrome confirms its outcome', async () => {
  const h = tracked(1, true);
  h.chrome.downloads.resume = async () => { throw new Error('Resume outcome unknown'); };
  await h.message({ type: 'resume_downloads', batchId: h.batchId() });
  h.state.records.get(11).paused = false;
  await h.reconcile();
  assert.equal(h.run('fixtureBatch().items[0].state'), 'downloading');
  assert.equal(h.run('fixtureBatch().items[0].controlError'), '');
  assert.equal(h.run('fixtureBatch().controlError'), '');
  assert.equal(h.run('fixtureBatch().paused'), false);
});

for (const mode of ['throws', 'malformed']) {
  test(`REL-07: ${mode} search results preserve the last confirmed download state`, async () => {
    const h = tracked(1);
    h.chrome.downloads.search = (query, callback) => {
      if (mode === 'throws') throw new Error('Search unavailable');
      callback(undefined);
    };
    await h.reconcile();
    assert.equal(h.run('fixtureBatch().items[0].downloadId'), 11);
    assert.equal(h.run('fixtureBatch().items[0].state'), 'downloading');
    assert.match(h.run('fixtureBatch().items[0].syncError'), /Could not check/);
  });
}

test('REL-07: a late uncancellable download cannot overwrite a restarted file', async () => {
  const h = harness(); h.seed(1);
  h.run('fixtureBatch().sourceAttached=false');
  const callbacks = [];
  h.chrome.downloads.download = (options, callback) => { callbacks.push(callback); };
  const owner = h.batchId(), item = h.run('fixtureBatch().items[0].id');
  await h.context.pumpQueueForBatch(owner); await tick();
  await h.message({ type: 'cancel_downloads', batchId: owner });
  await h.message({ type: 'start_downloads', batchId: owner, items: [{ id: item }] }); await tick();
  assert.equal(callbacks.length, 2);
  h.chrome.downloads.cancel = async () => { throw new Error('Old creation still running'); };
  callbacks[0](42); await tick();
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), null);
  assert.equal(h.run('fixtureBatch().items[0].state'), 'starting');
  assert.notEqual(h.run('downloadIdToKey.get(42).itemId'), item);
  callbacks[1](43); await tick();
  assert.equal(h.run('downloadIdToKey.size'), 2);
  assert.equal(h.run('fixtureBatch().items[0].downloadId'), 43);
});

test('REL-07: a late uncancellable download restores a removed batch for recovery', async () => {
  const h = harness(), created = deferred(); h.seed(1);
  let callback;
  h.chrome.downloads.download = (options, done) => { callback = done; created.resolve(); };
  const owner = h.batchId();
  await h.context.pumpQueueForBatch(owner); await created.promise;
  h.state.activeTab = null;
  await h.message({ type: 'cancel_downloads', batchId: owner });
  await h.emit('removed', 1);
  assert.equal(h.run('Object.keys(sessions).length'), 0);
  h.chrome.downloads.cancel = async () => { throw new Error('Still running'); };
  callback(42); await tick();
  assert.equal(h.state.local.ffBatchState.batches[owner].items[0].downloadId, 42);
  assert.equal(h.state.local.ffBatchState.batches[owner].sourceAttached, false);
  assert.equal(h.state.local.ffBatchState.downloadMap[42].batchId, owner);
});
