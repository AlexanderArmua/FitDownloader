const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, tick } = require('./helpers/background.cjs');

function legacy() {
  return {
    ffSessions: { 7: { tabId: 7, sourceUrl: 'https://fitgirl-repacks.site/game/', title: 'Saved game',
      hasStarted: true, paused: true, generation: 3,
      items: [
        { url: 'https://fuckingfast.co/part1', label: 'Part 1', state: 'paused', downloadId: 42 },
        { url: 'https://fuckingfast.co/part2', label: 'Part 2', state: 'queued', downloadId: null }
      ] } },
    ffDownloadMap: { 42: { tabId: 7, index: 0, generation: 3 } }
  };
}

test('REL-05: migration atomically commits durable batch/file IDs and preserves legacy data', async () => {
  const local = legacy(); const before = structuredClone(local);
  const h = harness({ local }); await h.context.loadSessions();
  const snapshot = local.ffBatchState;
  assert.equal(snapshot.schemaVersion, 2);
  const [batch] = Object.values(snapshot.batches);
  assert.notEqual(batch.id, '7');
  assert.equal(batch.sourceTabId, 7);
  assert.equal(batch.generation, 3);
  assert.equal(batch.paused, true);
  assert.equal(new Set(batch.items.map(item => item.id)).size, 2);
  assert.deepEqual(snapshot.downloadMap[42], { batchId: batch.id, itemId: batch.items[0].id, generation: 3 });
  assert.equal(batch.items[0].downloadId, 42);
  assert.deepEqual(local.ffSessions, before.ffSessions);
  assert.deepEqual(local.ffDownloadMap, before.ffDownloadMap);
  const reloaded = harness({ local }); await reloaded.context.loadSessions();
  assert.equal(reloaded.run('Object.values(sessions)[0].id'), batch.id);
  assert.equal(reloaded.run('Object.values(sessions)[0].items[0].id'), batch.items[0].id);
  assert.equal(reloaded.downloads.length, 0);
});

test('REL-05: migrated active Chrome downloads reconcile without being started again', async () => {
  const local = legacy(); local.ffSessions[7].paused = false;
  const h = harness({ local, concurrency: 1, records: new Map([[42, { id: 42, state: 'in_progress', paused: false }]]) });
  await h.message({ type: 'get_session' }); await tick();
  const [batch] = h.run('Object.values(sessions)');
  assert.equal(batch.items[0].downloadId, 42);
  assert.equal(h.downloads.length, 0);
  await h.emit('changed', { id: 42, state: { current: 'complete' } });
  assert.equal(h.downloads.length, 1);
  assert.equal(h.run(`sessions[${JSON.stringify(batch.id)}].items[0].state`), 'completed');
});

test('REL-05: a failed migration write preserves old data and can be retried', async () => {
  const local = legacy(), before = structuredClone(local);
  const h = harness({ local }); const set = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async () => { throw new Error('Disk quota'); };
  await assert.rejects(h.context.loadSessions(), /quota/);
  assert.deepEqual(local, before);
  assert.equal(h.run('sessionsLoaded'), false);
  h.chrome.storage.local.set = set;
  await h.context.loadSessions();
  assert.equal(local.ffBatchState.schemaVersion, 2);
});

test('REL-05: a partial legacy map write recovers ownership from persisted Chrome IDs', async () => {
  const local = legacy(); local.ffDownloadMap = {};
  const h = harness({ local }); await h.context.loadSessions();
  const [batch] = Object.values(local.ffBatchState.batches);
  assert.equal(local.ffBatchState.downloadMap[42].itemId, batch.items[0].id);
});

test('REL-05: a partial legacy session write recovers its Chrome ID from the legacy map', async () => {
  const local = legacy(); local.ffSessions[7].items[0].downloadId = null;
  const h = harness({ local }); await h.context.loadSessions();
  assert.equal(Object.values(local.ffBatchState.batches)[0].items[0].downloadId, 42);
});

test('REL-05: filtering invalid legacy links does not shift download ownership', async () => {
  const local = legacy();
  local.ffSessions[7].items.unshift({ url: 'https://evil.example/', label: 'Invalid', state: 'queued' });
  local.ffDownloadMap[42].index = 1;
  const h = harness({ local }); await h.context.loadSessions();
  const [batch] = Object.values(local.ffBatchState.batches);
  assert.equal(batch.items.length, 2);
  assert.equal(batch.items.find(item => item.id === local.ffBatchState.downloadMap[42].itemId).url, 'https://fuckingfast.co/part1');
});

for (const state of [
  { schemaVersion: 99, batches: {}, downloadMap: {} },
  { schemaVersion: 2, batches: [], downloadMap: {} },
  { schemaVersion: 2, batches: {}, downloadMap: [] },
  { schemaVersion: 2, batches: { owner: { id: 'different', items: [] } }, downloadMap: {} }
]) {
  test(`REL-05: invalid saved state is preserved: ${JSON.stringify(state)}`, async () => {
    const local = { ...legacy(), ffBatchState: state }, before = structuredClone(local);
    const h = harness({ local });
    await assert.rejects(h.context.loadSessions(), /invalid|unsupported/);
    assert.deepEqual(local, before);
    assert.equal(h.downloads.length, 0);
  });
}

test('REL-05: ambiguous duplicate Chrome ownership stops migration without losing data', async () => {
  const local = legacy(); local.ffSessions[8] = structuredClone(local.ffSessions[7]); local.ffSessions[8].tabId = 8;
  const before = structuredClone(local), h = harness({ local });
  await assert.rejects(h.context.loadSessions(), /ambiguous/);
  assert.deepEqual(local, before);
});

test('REL-05: a committed snapshot takes precedence over stale legacy state', async () => {
  const local = legacy(), h = harness({ local }); await h.context.loadSessions();
  const id = Object.keys(local.ffBatchState.batches)[0];
  local.ffSessions[7].title = 'Stale legacy title';
  const reloaded = harness({ local }); await reloaded.context.loadSessions();
  assert.equal(reloaded.run(`sessions[${JSON.stringify(id)}].title`), 'Saved game');
});

test('REL-05: old source-tab control messages cannot target a durable batch accidentally', async () => {
  const h = harness(); h.seed(1);
  for (const batchId of [1, '__proto__', 'constructor', 'unknown']) {
    assert.equal((await h.message({ type: 'pause_downloads', batchId })).ok, false);
  }
  assert.equal((await h.message({ type: 'cancel_downloads', tabId: 1 })).ok, false);
});

test('REL-05: a rescan has new batch/file identities and keeps prior results addressable', async () => {
  const h = harness(); h.seed(1); const original = h.batchId();
  h.run('fixtureBatch().items[0].state="completed"');
  const scan = await h.message({ type: 'scan_current_tab', batchId: original, refresh: true });
  assert.notEqual(scan.batchId, original);
  assert.notEqual(scan.session.items[0].id, h.run(`sessions[${JSON.stringify(original)}].items[0].id`));
  assert.equal(h.run(`sessions[${JSON.stringify(original)}].items[0].state`), 'completed');
});

test('REL-05: full browser startup detaches an old source even if a new tab reuses its ID and URL', async () => {
  const first = harness(); first.seed(1); const oldId = first.batchId(); await first.context.saveSessions();
  const h = harness({ local: first.state.local }); await h.emit('startup');
  const scan = await h.message({ type: 'scan_current_tab' });
  assert.notEqual(scan.batchId, oldId);
  assert.equal(h.run(`sessions[${JSON.stringify(oldId)}].paused`), true);
  assert.equal(h.downloads.length, 0);
});

test('REL-05: file IDs from another batch cannot start downloads even when the URLs match', async () => {
  const h = harness();
  const first = await h.message({ type: 'scan_current_tab' });
  h.state.activeTab = { id: 2, url: 'https://fitgirl-repacks.site/another/' };
  const second = await h.message({ type: 'scan_current_tab' });
  const start = await h.message({ type: 'start_downloads', batchId: first.batchId, items: second.session.items });
  assert.equal(start.ok, false);
  assert.equal(h.downloads.length, 0);
});
