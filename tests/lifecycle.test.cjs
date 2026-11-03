const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, tick, deferred } = require('./helpers/background.cjs');

test('REL-02: worker recreation followed by explicit scan restarts eligible queued work', async () => {
  const first = harness(); first.seed(1);
  await first.context.saveSessions();
  const recreated = harness({ local: first.state.local });
  await recreated.message({ type: 'scan_current_tab' }); await tick();
  assert.equal(recreated.downloads.length, 1);
});

test('REL-02: concurrent popup messages share one recovery and do not duplicate downloads', async () => {
  const first = harness(); first.seed(3); await first.context.saveSessions();
  const h = harness({ local: first.state.local });
  await Promise.all([h.message({ type: 'scan_current_tab' }), h.message({ type: 'get_settings' }), h.message({ type: 'get_session' })]);
  await tick();
  assert.equal(h.downloads.length, 2);
});

test('REL-02: a full browser restart retains queued files until explicit Resume', async () => {
  const first = harness(); first.seed(1); await first.context.saveSessions();
  const h = harness({ local: first.state.local });
  await h.emit('startup');
  const scan = await h.message({ type: 'scan_current_tab' });
  assert.equal(scan.session.paused, true);
  assert.equal(h.downloads.length, 0);
  await h.message({ type: 'resume_downloads', tabId: 1 }); await tick();
  assert.equal(h.downloads.length, 1);
});

test('REL-02: a saved verification pause survives worker recreation', async () => {
  const first = harness(); first.seed(1); first.run('sessions[1].paused=true');
  await first.context.saveSessions();
  const h = harness({ local: first.state.local });
  await h.message({ type: 'scan_current_tab' }); await tick();
  assert.equal(h.downloads.length, 0);
  assert.equal(h.run('sessions[1].paused'), true);
});

test('REL-01: source closure preserves ownership and the queue keeps advancing', async () => {
  const h = harness(); h.seed(3);
  await h.run('pumpQueueForTab(1)'); await tick();
  await h.emit('removed', 1);
  assert.equal(h.run('sessions[1].sourceClosed'), true);
  assert.equal(h.run('downloadIdToKey.size'), 2);
  await h.emit('changed', { id: 1, state: { current: 'complete' } });
  assert.equal(h.downloads.length, 3);
});

test('REL-01: a preserved batch is inspectable and controllable from an unrelated page', async () => {
  const h = harness(); h.seed(2);
  await h.run('pumpQueueForTab(1)'); await tick();
  await h.emit('removed', 1);
  h.state.activeTab = { id: 100, url: 'https://example.com/' };
  const scan = await h.message({ type: 'scan_current_tab' });
  assert.equal(scan.ok, true);
  assert.equal(scan.tabId, 1);
  assert.equal(scan.batches[0].sourceClosed, true);
  assert.equal((await h.message({ type: 'pause_downloads', tabId: 1 })).ok, true);
  assert.deepEqual(h.paused, [1, 2]);
  assert.equal((await h.message({ type: 'resume_downloads', tabId: 1 })).ok, true);
  assert.equal((await h.message({ type: 'cancel_downloads', tabId: 1 })).ok, true);
  assert.deepEqual(h.cancelled, [1, 2]);
});

test('saved batch selection rejects invalid or missing owner IDs', async () => {
  const h = harness();
  for (const tabId of ['1', -99, 999]) {
    assert.equal((await h.message({ type: 'scan_current_tab', tabId })).ok, false);
  }
});

test('an explicit rescan starts fresh selection after viewing terminal results', async () => {
  const h = harness(); h.seed(1); h.run('sessions[1].items[0].state="completed"');
  const result = await h.message({ type: 'scan_current_tab', tabId: 1, refresh: true });
  assert.equal(result.ok, true);
  assert.equal(result.session.hasStarted, false);
  assert.equal(result.session.generation, 1);
  assert.equal(result.session.items[0].state, 'queued');
});

test('rescan cannot discard an active batch or scan an unrelated site', async () => {
  const h = harness(); h.seed(1); h.run('sessions[1].paused=true');
  assert.equal((await h.message({ type: 'scan_current_tab', tabId: 1, refresh: true })).ok, false);
  h.state.activeTab = { id: 999, url: 'https://example.com/' };
  assert.equal((await h.message({ type: 'scan_current_tab', refresh: true })).ok, false);
});

test('REL-03: orphaned starting work is requeued after worker recreation', async () => {
  const first = harness(); first.seed(1);
  first.run('sessions[1].items[0].state="starting"');
  await first.context.saveSessions();
  const h = harness({ local: first.state.local });
  await h.context.reconcileSessionForTab(1);
  assert.equal(h.run('sessions[1].items[0].state'), 'queued');
});

test('REL-03: scanning during a live resolver does not reset or duplicate its work', async () => {
  const h = harness(); h.seed(1);
  const gate = deferred(); let lookups = 0;
  h.context.fetch = async () => {
    lookups++;
    await gate.promise;
    return { ok: true, text: async () => 'https://dl.fuckingfast.co/dl/test.rar' };
  };
  await h.run('pumpQueueForTab(1)');
  const scan = await h.message({ type: 'scan_current_tab' });
  assert.equal(scan.session.items[0].state, 'starting');
  await h.run('pumpQueueForTab(1)');
  assert.equal(lookups, 1);
  gate.resolve(); await tick();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.run('activeResolvers.size'), 0);
});

for (const terminal of ['error', 'completed', 'cancelled']) {
  test(`REL-04: reopening a ${terminal} batch retains its result view`, async () => {
    const h = harness(); h.seed(1);
    h.run(`sessions[1].items[0].state=${JSON.stringify(terminal)}`);
    for (let i = 0; i < 2; i++) {
      const result = await h.message({ type: 'scan_current_tab' });
      assert.equal(result.session.hasStarted, true);
      assert.equal(result.session.items[0].state, terminal);
    }
  });
}

test('REL-04: failed results reconcile and retain Retry after worker recreation', async () => {
  const first = harness(); first.seed(1);
  first.run('sessions[1].items[0].downloadId=42; sessions[1].items[0].state="downloading"');
  await first.context.saveSessions();
  const h = harness({ local: first.state.local, records: new Map([[42, { id: 42, state: 'interrupted', error: 'NETWORK_FAILED' }]]) });
  const result = await h.message({ type: 'scan_current_tab' });
  assert.equal(result.session.hasStarted, true);
  assert.equal(result.session.items[0].state, 'error');
  assert.equal((await h.message({ type: 'retry_failed' })).ok, true);
  await tick();
  assert.equal(h.downloads.length, 1);
});

test('a selected batch starts through the popup message boundary and persists ownership', async () => {
  const h = harness();
  const scan = await h.message({ type: 'scan_current_tab' });
  assert.equal(scan.ok, true);
  assert.equal(scan.session.items.length, 1);
  const started = await h.message({ type: 'start_downloads', items: scan.session.items });
  assert.equal(started.ok, true);
  await tick();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.state.local.ffSessions[1].items[0].downloadId, 1);
  assert.equal(h.state.local.ffDownloadMap[1].tabId, 1);
});

test('completed download frees one slot and starts the next queued file', async () => {
  const h = harness({ concurrency: 1 }); h.seed(2);
  await h.run('pumpQueueForTab(1)'); await tick();
  await h.emit('changed', { id: 1, state: { current: 'complete' } });
  assert.equal(h.downloads.length, 2);
  assert.equal(h.run('sessions[1].items[0].state'), 'completed');
  assert.equal(h.run('sessions[1].items[1].state'), 'downloading');
});

for (const [error, expected] of [['NETWORK_FAILED', 'error'], ['USER_CANCELED', 'cancelled']]) {
  test(`interruption ${error} is reflected in the queue`, async () => {
    const h = harness(); h.seed(1);
    await h.run('pumpQueueForTab(1)'); await tick();
    await h.emit('changed', { id: 1, state: { current: 'interrupted' }, error: { current: error } });
    assert.equal(h.run('sessions[1].items[0].state'), expected);
    assert.equal(h.run('downloadIdToKey.size'), 0);
  });
}

test('untracked and non-terminal download events do not mutate the batch', async () => {
  const h = harness(); h.seed(1);
  const before = h.run('JSON.stringify(sessions)');
  await h.emit('changed', { id: 999, state: { current: 'complete' } });
  await h.emit('changed', { id: 999, paused: { current: true } });
  assert.equal(h.run('JSON.stringify(sessions)'), before);
});

test('worker recreation can reconcile an existing browser download without restarting it', async () => {
  const first = harness(); first.seed(1);
  await first.run('pumpQueueForTab(1)'); await tick();
  const second = harness({ local: first.state.local, records: first.state.records });
  const result = await second.message({ type: 'scan_current_tab' });
  assert.equal(result.session.items[0].state, 'downloading');
  assert.equal(result.session.items[0].downloadId, 1);
  assert.equal(second.downloads.length, 0);
});

for (const [record, expected] of [
  [null, 'cancelled'], [{ state: 'complete' }, 'completed'],
  [{ state: 'interrupted', error: 'NETWORK_FAILED' }, 'error'],
  [{ state: 'interrupted', error: 'USER_CANCELED' }, 'cancelled'],
  [{ state: 'in_progress', paused: true }, 'paused']
]) {
  test(`saved download reconciles to ${expected}`, async () => {
    const h = harness(); h.seed(1);
    h.run('sessions[1].items[0].downloadId = 42; sessions[1].items[0].state = "downloading"');
    if (record) h.state.records.set(42, { id: 42, ...record });
    await h.context.reconcileSessionForTab(1);
    assert.equal(h.run('sessions[1].items[0].state'), expected);
  });
}

test('a stale generation event cannot overwrite the current batch', async () => {
  const h = harness(); h.seed(1);
  h.run('downloadIdToKey.set(42, {tabId:1,index:0,generation:99})');
  await h.emit('changed', { id: 42, state: { current: 'complete' } });
  assert.equal(h.run('sessions[1].items[0].state'), 'queued');
  assert.equal(h.run('downloadIdToKey.size'), 0);
});

test('pause and resume operate on tracked browser downloads', async () => {
  const h = harness(); h.seed(1);
  await h.run('pumpQueueForTab(1)'); await tick();
  assert.equal((await h.message({ type: 'pause_downloads' })).ok, true);
  assert.deepEqual(h.paused, [1]);
  assert.equal((await h.message({ type: 'resume_downloads' })).ok, true);
  assert.deepEqual(h.resumed, [1]);
});

test('cancel cancels active downloads, invalidates work, and returns a fresh selection', async () => {
  const h = harness(); h.seed(3);
  await h.run('pumpQueueForTab(1)'); await tick();
  assert.equal((await h.message({ type: 'cancel_downloads' })).ok, true);
  assert.deepEqual(h.cancelled, [1, 2]);
  assert.equal(h.run('downloadIdToKey.size'), 0);
  assert.equal(h.run('sessions[1].hasStarted'), false);
});

test('retry_failed starts only failed files in a terminal batch', async () => {
  const h = harness(); h.seed(2);
  h.run('sessions[1].items[0].state="completed"; sessions[1].items[1].state="error"');
  const response = await h.message({ type: 'retry_failed' }); await tick();
  assert.equal(response.ok, true);
  assert.equal(h.downloads.length, 1);
  assert.equal(h.run('sessions[1].items[0].state'), 'completed');
});

test('storage rejection reaches the caller rather than reporting a successful scan', async () => {
  const h = harness(); h.state.storageError = new Error('Storage quota exceeded');
  const response = await h.message({ type: 'scan_current_tab' });
  assert.equal(response.ok, false);
  assert.match(response.error, /quota/);
});

test('browser download creation errors are reported without a phantom download ID', async () => {
  const h = harness(); h.seed(1);
  h.chrome.downloads.download = (_opts, callback) => {
    h.chrome.runtime.lastError = { message: 'Download blocked' };
    callback(undefined);
    delete h.chrome.runtime.lastError;
  };
  await h.run('pumpQueueForTab(1)'); await tick();
  assert.equal(h.run('sessions[1].items[0].state'), 'error');
  assert.equal(h.run('sessions[1].items[0].downloadId'), null);
  assert.equal(h.run('downloadIdToKey.size'), 0);
});

test('delayed storage reads are controllable and return independent snapshots', async () => {
  const h = harness({ local: { ffSessions: { value: 1 } } });
  const gate = deferred();
  const get = h.chrome.storage.local.get;
  h.chrome.storage.local.get = async key => { await gate.promise; return get(key); };
  const pending = h.chrome.storage.local.get('ffSessions');
  gate.resolve();
  const snapshot = await pending;
  snapshot.ffSessions.value = 99;
  assert.equal(h.state.local.ffSessions.value, 1);
});

test('unknown messages and missing active tabs are handled without downloads', async () => {
  const h = harness();
  assert.equal(await h.message(null), undefined);
  assert.equal(await h.message({ type: 'unknown' }), undefined);
  h.state.activeTab = null;
  for (const type of ['scan_current_tab', 'start_downloads', 'cancel_downloads', 'pause_downloads', 'retry_failed']) {
    assert.equal((await h.message({ type })).ok, false);
  }
  assert.equal(h.downloads.length, 0);
});

test('settings and session queries round-trip through their message APIs', async () => {
  const h = harness();
  assert.equal((await h.message({ type: 'get_settings' })).settings.concurrency, 2);
  assert.equal((await h.message({ type: 'save_settings', settings: { concurrency: 99 } })).settings.concurrency, 20);
  assert.equal((await h.message({ type: 'get_session' })).ok, true);
});

test('Start refuses a second run while a batch has active work', async () => {
  const h = harness(); h.seed(1);
  const response = await h.message({ type: 'start_downloads', items: [{ url: 'https://fuckingfast.co/file0' }] });
  assert.equal(response.ok, false);
  assert.match(response.error, /already running/);
});

test('Start refuses URLs that are not in the current page scan', async () => {
  const h = harness();
  const response = await h.message({ type: 'start_downloads', items: [{ url: 'https://fuckingfast.co/other' }] });
  assert.equal(response.ok, false);
  assert.match(response.error, /not found/);
  assert.equal(h.downloads.length, 0);
});

test('Start explains an empty selection without changing queue state', async () => {
  const h = harness();
  const response = await h.message({ type: 'start_downloads', items: [] });
  assert.equal(response.ok, false);
  assert.match(response.error, /No files selected/);
});

test('download events clean up mappings for absent sessions and indexes', async () => {
  for (const index of [0, 99]) {
    const h = harness();
    if (index === 99) h.seed(1);
    h.run(`downloadMapLoaded=true; downloadIdToKey.set(42,{tabId:1,index:${index},generation:0})`);
    await h.emit('changed', { id: 42, state: { current: 'complete' } });
    assert.equal(h.run('downloadIdToKey.size'), 0);
  }
});

test('closing an unrelated tab leaves existing batch state intact', async () => {
  const h = harness(); h.seed(1);
  const before = h.run('JSON.stringify(sessions)');
  await h.emit('removed', 999);
  assert.equal(h.run('JSON.stringify(sessions)'), before);
});

test('settings storage failures are returned to the popup', async () => {
  const h = harness();
  h.chrome.storage.sync.set = (_settings, callback) => {
    h.chrome.runtime.lastError = { message: 'Sync storage failed' };
    callback(); delete h.chrome.runtime.lastError;
  };
  const response = await h.message({ type: 'save_settings', settings: { concurrency: 3 } });
  assert.equal(response.ok, false);
  assert.match(response.error, /Sync storage failed/);
});
