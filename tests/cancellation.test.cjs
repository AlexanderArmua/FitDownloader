const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, tick, deferred } = require('./helpers/background.cjs');

function waitForAbort(signal, entered) {
  entered.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

for (const phase of ['landing fetch', 'landing body', 'POST fetch', 'POST body']) {
  test(`REL-10: Cancel aborts ${phase} without errors or replacement downloads`, async () => {
    const h = harness({ concurrency: 1 }), entered = deferred(); h.seed(2);
    const signals = [];
    h.context.fetch = async (url, options) => {
      signals.push(options.signal);
      const post = options.method === 'POST';
      if (phase === (post ? 'POST fetch' : 'landing fetch')) return waitForAbort(options.signal, entered);
      return { ok: true, status: 200, headers: new Headers(), text: async () => {
        if (phase === (post ? 'POST body' : 'landing body')) return waitForAbort(options.signal, entered);
        return post ? 'https://dl.fuckingfast.co/dl/tiny.txt' : '<button hx-post="/f/file0/go">Download</button>';
      } };
    };
    const owner = h.batchId();
    await h.context.pumpQueueForBatch(owner); await entered.promise;
    assert.equal((await h.message({ type: 'cancel_downloads', batchId: owner })).ok, true);
    await tick();
    assert.equal(signals.at(-1).aborted, true);
    assert.equal(h.downloads.length, 0);
    assert.equal(signals.length, phase.startsWith('POST') ? 2 : 1);
    assert.equal(h.warnings.length, 0);
    assert.equal(h.run('resolverRequests.size'), 0);
    assert.equal(h.run(`sessions[${JSON.stringify(owner)}].items.every(item => item.state === 'cancelled')`), true);
  });
}

test('REL-10: cancelling one batch leaves another batch request untouched', async () => {
  const h = harness(), signals = new Map(); h.seed(1);
  h.context.fetch = (url, options) => {
    signals.set(url, options.signal);
    return waitForAbort(options.signal, deferred());
  };
  const first = h.batchId();
  const second = h.run(`(() => {
    const batch=createSessionFromExtractedLinks({id:2,url:'https://fitgirl-repacks.site/other/'},'Other',
      [{url:'https://fuckingfast.co/other0',label:'Other file'}],0);
    batch.hasStarted=true; sessions[batch.id]=batch; return batch.id;
  })()`);
  await Promise.all([h.context.pumpQueueForBatch(first), h.context.pumpQueueForBatch(second)]); await tick();
  await h.message({ type: 'cancel_downloads', batchId: first }); await tick();
  assert.equal(signals.get('https://fuckingfast.co/file0').aborted, true);
  assert.equal(signals.get('https://fuckingfast.co/other0').aborted, false);
  await h.message({ type: 'cancel_downloads', batchId: second }); await tick();
  assert.equal(h.warnings.length, 0);
});

test('REL-10: an ordinary request timeout still reports failure rather than intentional cancellation', async () => {
  const h = harness(), entered = deferred(), timeout = new AbortController(); h.seed(1);
  h.context.AbortSignal = { timeout: () => timeout.signal, any: AbortSignal.any.bind(AbortSignal) };
  h.context.fetch = (url, options) => waitForAbort(options.signal, entered);
  await h.context.pumpQueueForBatch(h.batchId()); await entered.promise;
  timeout.abort(new Error('Host timed out')); await tick();
  assert.equal(h.run('fixtureBatch().items[0].state'), 'error');
  assert.match(h.run('fixtureBatch().items[0].error'), /Host timed out/);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.run('resolverRequests.size'), 0);
});
