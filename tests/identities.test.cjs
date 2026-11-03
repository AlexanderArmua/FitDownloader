const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, tick, deferred } = require('./helpers/background.cjs');

test('REL-05: a reused source-tab ID cannot select or overwrite an older batch', async () => {
  const h = harness(); h.seed(1);
  h.run('fixtureBatch().paused=true; fixtureBatch().sourceClosed=true');
  h.state.activeTab = { id: 1, url: 'https://fitgirl-repacks.site/new-game/' };
  const scan = await h.message({ type: 'scan_current_tab' });
  assert.equal(scan.session.sourceUrl, h.state.activeTab.url);
  assert.equal(Object.keys((await h.message({ type: 'get_session' })).sessions).length, 2);
});

test('REL-05: completion follows the original file after queue reordering', async () => {
  const h = harness(); h.seed(3);
  await h.context.recoverSessions(); await tick();
  h.run('fixtureBatch().items.reverse()');
  await h.emit('changed', { id: 1, state: { current: 'complete' } });
  assert.equal(h.run('fixtureBatch().items.find(item=>item.url.endsWith("file0")).state'), 'completed');
});

test('REL-05: a live resolver keeps its file identity while the queue is reordered', async () => {
  const h = harness({ concurrency: 1 }); h.seed(2);
  const gate = deferred();
  h.context.fetch = async () => { await gate.promise; return { ok: true, text: async () => 'https://dl.fuckingfast.co/dl/file' }; };
  await h.run('pumpQueueForBatch(fixtureBatch().id)');
  h.run('fixtureBatch().items.reverse()');
  gate.resolve(); await tick();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.run('fixtureBatch().items.find(item=>item.url.endsWith("file0")).downloadId'), 1);
});
