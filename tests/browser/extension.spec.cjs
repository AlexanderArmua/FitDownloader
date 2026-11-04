const { test: base, expect, chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const fixture = '<!doctype html><title>Fixture Game - FitGirl Repacks</title><main class="entry-content">' +
  Array.from({ length: 3 }, (_, i) => `<a href="https://fuckingfast.co/file${i}#part${i}.rar">Part ${i}</a>`).join('') + '</main>';
const test = base.extend({
  extension: async ({}, use) => {
    const profilesRoot = path.join(root, 'node_modules/.cache/test-profiles');
    fs.mkdirSync(profilesRoot, { recursive: true });
    const profile = fs.mkdtempSync(path.join(profilesRoot, 'fixture-'));
    let context;
    async function launch() {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, acceptDownloads: true,
        downloadsPath: path.join(profile, 'downloads'),
        args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
      });
      // No real host pages, advertising or archives are fetched by this suite.
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith('chrome-extension:') || url.startsWith('data:')) return route.continue();
        if (url === 'https://fitgirl-repacks.site/fixture/') return route.fulfill({ contentType: 'text/html', body: fixture });
        return route.abort();
      });
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker');
      const id = new URL(worker.url()).host;
      return { context, worker, id };
    }
    const initial = await launch();
    const { worker, id } = initial;
    const source = await context.newPage();
    await source.goto('https://fitgirl-repacks.site/fixture/');
    const popup = await context.newPage();
    // Seed storage, not production globals, to isolate popup behavior from which
    // tab Chrome considers active when the popup is opened as a normal test tab.
    await worker.evaluate(async () => {
      await chrome.storage.sync.set({ concurrency: 3 });
    });
    const extension = { context, worker, id, source, popup, async restart() {
      await context.close();
      const next = await launch();
      Object.assign(extension, next);
      return next;
    } };
    try { await use(extension); }
    finally {
      await context.close();
      // Delete only the unique profile this test created beneath its cache.
      if (path.dirname(path.resolve(profile)) !== path.resolve(profilesRoot) || !path.basename(profile).startsWith('fixture-')) {
        throw new Error('Refusing to remove an unexpected test-profile path');
      }
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test('loads real MV3 worker and scans a controlled page in the isolated world', async ({ extension }) => {
  const { worker, source } = extension;
  const result = await worker.evaluate(async sourceUrl => {
    const [tab] = await chrome.tabs.query({ url: sourceUrl });
    return extractFuckingFastLinks(tab.id);
  }, source.url());
  expect(result.title).toBe('Fixture Game');
  expect(result.items).toHaveLength(3);
});

async function showSelection(extension) {
  const { popup, id } = extension;
  // The real extension page renders a real scan response. Only active-tab
  // discovery is stubbed; selection/events and Chrome messaging stay real.
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, callback) => {
      if (message.type === 'scan_current_tab') {
        callback({ ok: true, batchId: 'fixture-batch', session: { hasStarted: false, items: [0, 1, 2].map(i => ({
          id: `file-${i}`, url: `https://fuckingfast.co/file${i}`, label: `Part ${i}`, state: 'queued'
        })) } });
      } else return send(message, callback);
    };
  });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  return popup;
}

test('simultaneous real page scans create one durable source batch', async ({ extension }) => {
  const result = await extension.worker.evaluate(async sourceUrl => {
    const [tab] = await chrome.tabs.query({ url: sourceUrl });
    const batches = await Promise.all(Array.from({ length: 3 }, () => ensureSessionForTab(tab)));
    const stored = (await chrome.storage.local.get('ffBatchState')).ffBatchState;
    return {
      ids: batches.map(batch => batch.id),
      files: batches.map(batch => batch.items.length),
      attached: Object.values(stored.batches).filter(batch => batch.sourceAttached && batch.sourceTabId === tab.id).length
    };
  }, extension.source.url());
  expect(new Set(result.ids).size).toBe(1);
  expect(result.files).toEqual([3, 3, 3]);
  expect(result.attached).toBe(1);
});

test('real browser supports row, range, modifier, Select All and Space selection', async ({ extension }) => {
  const popup = await showSelection(extension);
  const rows = popup.locator('.file-row');
  const boxes = popup.locator('#files-list input');
  await expect(rows).toHaveCount(3);
  await rows.nth(0).locator('label').click();
  await expect(boxes.nth(0)).not.toBeChecked();
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await expect(popup.locator('#start-button')).toBeDisabled();
  await rows.nth(1).click({ modifiers: ['Control'] });
  await expect(boxes.nth(1)).toBeChecked();
  await boxes.nth(1).focus(); await boxes.nth(1).press('Space');
  await expect(boxes.nth(1)).not.toBeChecked();
  await popup.locator('#select-all').check();
  await expect(popup.locator('#selection-info')).toHaveText('3 of 3 file(s) selected');
});

test('settings save survives extension-page closure and reopening', async ({ extension }) => {
  const popup = await showSelection(extension);
  await popup.locator('#parallel-input').fill('6');
  await popup.locator('#apply-parallel-button').click();
  await expect(popup.locator('#concurrency-info')).toHaveText('Max concurrent downloads: 6');
  await popup.close();
  const reopened = await extension.context.newPage();
  await reopened.goto(`chrome-extension://${extension.id}/popup.html`);
  await expect(reopened.locator('#parallel-input')).toHaveValue('6');
});

test('pointer checkbox activation and native modifier clicks update selection', async ({ extension }) => {
  const popup = await showSelection(extension);
  const boxes = popup.locator('#files-list input');
  await boxes.nth(0).click();
  await expect(boxes.nth(0)).not.toBeChecked();
  await boxes.nth(2).click({ modifiers: ['Shift'] });
  await expect(popup.locator('#start-button')).toBeDisabled();
  await boxes.nth(1).click({ modifiers: ['Control'] });
  await expect(boxes.nth(1)).toBeChecked();
  await expect(popup.locator('#selection-info')).toHaveText('1 of 3 file(s) selected');
  await boxes.nth(0).click({ modifiers: ['Meta'] });
  await expect(popup.locator('#selection-info')).toHaveText('2 of 3 file(s) selected');
});

test('fresh browser context preserves saved settings and session data for rehydration', async ({ extension }) => {
  await extension.worker.evaluate(async () => {
    await chrome.storage.local.remove('ffBatchState');
    await chrome.storage.local.set({ ffSessions: { 123: { tabId: 123, hasStarted: true, paused: true, items: [{ url: 'https://fuckingfast.co/file', label: 'Saved file', state: 'queued' }] } } });
  });
  const { worker } = await extension.restart();
  const restored = await worker.evaluate(async () => {
    await loadSessions();
    const batch = Object.values(sessions).find(batch => batch.sourceTabId === 123);
    return { label: batch.items[0].label, concurrency: (await getCurrentSettings()).concurrency };
  });
  expect(restored).toEqual({ label: 'Saved file', concurrency: 3 });
});

test('Chrome completes a tiny local data download and reconciliation records completion', async ({ extension }) => {
  const result = await extension.worker.evaluate(async () => {
    const id = await chrome.downloads.download({
      url: 'data:text/plain,FitDownloader%20test%20fixture',
      filename: 'fitdownloader-test-fixture.txt', saveAs: false
    });
    sessionsLoaded = true; downloadMapLoaded = true;
    const batch = createSessionFromExtractedLinks(
      { id: 999, url: 'https://fitgirl-repacks.site/fixture/' }, 'Tiny fixture',
      [{ url: 'https://fuckingfast.co/file', label: 'Tiny fixture' }], 0);
    sessions[batch.id] = batch;
    batch.hasStarted = true;
    batch.items[0].downloadId = id;
    batch.items[0].state = 'downloading';
    return { downloadId: id, batchId: batch.id };
  });
  await expect.poll(() => extension.worker.evaluate(async id => (await chrome.downloads.search({ id }))[0]?.state, result.downloadId)).toBe('complete');
  const state = await extension.worker.evaluate(async batchId => {
    await reconcileBatch(batchId);
    return sessions[batchId].items[0].state;
  }, result.batchId);
  expect(state).toBe('completed');
});

test('closed-source batches remain accessible and cancellable through the real popup', async ({ extension }) => {
  const batchId = await extension.worker.evaluate(async sourceUrl => {
    const [tab] = await chrome.tabs.query({ url: sourceUrl });
    sessionsLoaded = true; downloadMapLoaded = true;
    const batch = createSessionFromExtractedLinks(tab, 'Closed source fixture', [{ url: 'https://fuckingfast.co/file', label: 'Part 1' }], 0);
    sessions[batch.id] = batch;
    batch.hasStarted = true;
    batch.paused = true;
    await saveSessions();
    return batch.id;
  }, extension.source.url());
  await extension.source.close();
  await expect.poll(() => extension.worker.evaluate(id => sessions[id]?.sourceClosed, batchId)).toBe(true);
  await extension.popup.goto(`chrome-extension://${extension.id}/popup.html`);
  await expect(extension.popup.locator('#batch-picker')).toContainText('Closed source fixture (source closed)');
  await expect(extension.popup.locator('#pause-resume-button')).toHaveText('Resume');
  await extension.popup.locator('#cancel-button').click();
  await expect.poll(() => extension.worker.evaluate(id => sessions[id]?.hasStarted, batchId)).toBe(false);
});

test('real Chrome pause rejection stays tracked and offers Retry Pause in the popup', async ({ extension }) => {
  const batchId = await extension.worker.evaluate(async sourceUrl => {
    await loadSessions();
    const [tab] = await chrome.tabs.query({ url: sourceUrl });
    const batch = createSessionFromExtractedLinks(tab, 'Controlled API rejection', [{ url: 'https://fuckingfast.co/file', label: 'Part 1' }], 0);
    batch.hasStarted = true;
    batch.items[0].state = 'downloading'; batch.items[0].downloadId = 987654321;
    sessions[batch.id] = batch;
    // Only status lookup is stubbed. The nonexistent ID makes Chrome itself
    // reject Pause, exercising the real promise error and popup message path.
    const search = chrome.downloads.search.bind(chrome.downloads);
    chrome.downloads.search = (query, callback) => query.id === 987654321
      ? callback([{ id: query.id, state: 'in_progress', paused: false }]) : search(query, callback);
    await reconcileBatch(batch.id);
    await saveSessions();
    return batch.id;
  }, extension.source.url());
  await extension.popup.goto(`chrome-extension://${extension.id}/popup.html`);
  await expect(extension.popup.locator('#pause-resume-button')).toHaveText('Pause');
  await extension.popup.locator('#pause-resume-button').click();
  await expect(extension.popup.locator('#status')).toContainText('Could not pause');
  await expect(extension.popup.locator('#pause-resume-button')).toHaveText('Retry Pause');
  await expect(extension.popup.locator('.file-status')).toHaveText('downloading');
  const item = await extension.worker.evaluate(async id => {
    const state = (await chrome.storage.local.get('ffBatchState')).ffBatchState;
    return state.batches[id].items[0];
  }, batchId);
  expect(item.downloadId).toBe(987654321);
  expect(item.controlError).toBeTruthy();
  await extension.popup.reload();
  await expect(extension.popup.locator('#pause-resume-button')).toHaveText('Retry Pause');
});

test('tiny Chrome downloads finishing before creation returns complete the queue automatically', async ({ extension }) => {
  const batchId = await extension.worker.evaluate(async sourceUrl => {
    await loadSessions();
    const [tab] = await chrome.tabs.query({ url: sourceUrl });
    const batch = createSessionFromExtractedLinks(tab, 'Early completion fixture', [0, 1].map(i => ({
      url: 'https://fuckingfast.co/early' + i, label: 'Tiny file ' + i
    })), 0);
    batch.hasStarted = true; sessions[batch.id] = batch;
    await chrome.storage.sync.set({ concurrency: 1 });
    // Replace only host resolution and the creation wrapper; Chrome really
    // downloads each tiny text file and delivers events before this returns.
    getDirectDownloadUrl = async () => 'https://dl.fuckingfast.co/dl/tiny.txt';
    startDownload = async () => {
      const id = await chrome.downloads.download({ url: 'data:text/plain,Early%20completion%20fixture', saveAs: false });
      for (let attempt = 0; attempt < 500; attempt++) {
        const [download] = await chrome.downloads.search({ id });
        if (download?.state === 'complete') return id;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Tiny fixture did not finish before creation returned');
    };
    await pumpQueueForBatch(batch.id);
    return batch.id;
  }, extension.source.url());
  await expect.poll(() => extension.worker.evaluate(id => sessions[id].items.map(item => item.state), batchId)).toEqual(['completed', 'completed']);
  const saved = await extension.worker.evaluate(async id => (await chrome.storage.local.get('ffBatchState')).ffBatchState.batches[id], batchId);
  expect(saved.items.every(item => item.downloadId === null)).toBe(true);
});

test('real browser download controls update the open popup without rescanning', async ({ extension }) => {
  const body = Buffer.from('Controlled text fixture.\n'.repeat(1000));
  const held = new Set();
  const server = http.createServer((request, response) => {
    const offset = Number(request.headers.range?.match(/bytes=(\d+)/)?.[1] || 0);
    response.writeHead(offset ? 206 : 200, { 'Content-Type': 'text/plain', 'Content-Length': body.length - offset,
      'Accept-Ranges': 'bytes', 'Content-Disposition': 'attachment; filename="controlled-text.txt"',
      ...(offset ? { 'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}` } : {}) });
    response.write(body.subarray(offset, offset + 4096));
    held.add(response); response.on('close', () => held.delete(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await extension.worker.evaluate(async ({ sourceUrl, downloadUrl }) => {
      await loadSessions();
      const [tab] = await chrome.tabs.query({ url: sourceUrl });
      const batch = createSessionFromExtractedLinks(tab, 'Browser controls fixture', [{ url: 'https://fuckingfast.co/controlled', label: 'Controlled text' }], 0);
      const id = await chrome.downloads.download({ url: downloadUrl, filename: 'controlled-text.txt', saveAs: false });
      batch.hasStarted = true; batch.paused = true;
      batch.items[0].downloadId = id; batch.items[0].state = 'downloading';
      sessions[batch.id] = batch;
      await reconcileBatch(batch.id); await saveSessions();
      return { batchId: batch.id, downloadId: id };
    }, { sourceUrl: extension.source.url(), downloadUrl: `http://127.0.0.1:${server.address().port}/tiny.txt` });
    await extension.popup.goto(`chrome-extension://${extension.id}/popup.html`);
    await expect(extension.popup.locator('.file-status')).toHaveText('downloading');
    await extension.worker.evaluate(id => chrome.downloads.pause(id), result.downloadId);
    await expect(extension.popup.locator('.file-status')).toHaveText('paused');
    await extension.worker.evaluate(id => chrome.downloads.resume(id), result.downloadId);
    await expect(extension.popup.locator('.file-status')).toHaveText('downloading');
    await expect(extension.popup.locator('#status')).toContainText('Queue paused');
    await extension.worker.evaluate(id => chrome.downloads.cancel(id), result.downloadId);
    await expect(extension.popup.locator('.file-status')).toHaveText('cancelled');
    await extension.worker.evaluate(id => chrome.downloads.erase({ id }), result.downloadId);
    await expect.poll(() => extension.worker.evaluate(async id => !!(await chrome.storage.local.get('ffBatchState')).ffBatchState.downloadHistory[id], result.downloadId)).toBe(false);
  } finally {
    for (const response of held) response.end();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('popup Cancel aborts a pending resolver through native browser AbortSignals', async ({ extension }) => {
  const batchId = await extension.worker.evaluate(async sourceUrl => {
    await loadSessions();
    const [tab] = await chrome.tabs.query({ url: sourceUrl });
    const batch = createSessionFromExtractedLinks(tab, 'Cancel network fixture', [{ url: 'https://fuckingfast.co/pending', label: 'Pending request' }], 0);
    batch.hasStarted = true; sessions[batch.id] = batch;
    globalThis.fixtureAborted = false; globalThis.fixtureRequested = false;
    fetch = (url, options) => new Promise((resolve, reject) => {
      globalThis.fixtureRequested = true;
      options.signal.addEventListener('abort', () => {
        globalThis.fixtureAborted = true; reject(options.signal.reason);
      }, { once: true });
    });
    await pumpQueueForBatch(batch.id);
    return batch.id;
  }, extension.source.url());
  await expect.poll(() => extension.worker.evaluate(() => globalThis.fixtureRequested)).toBe(true);
  await extension.popup.goto(`chrome-extension://${extension.id}/popup.html`);
  await expect(extension.popup.locator('#cancel-button')).toBeVisible();
  await extension.popup.locator('#cancel-button').click();
  await expect.poll(() => extension.worker.evaluate(() => globalThis.fixtureAborted)).toBe(true);
  expect(await extension.worker.evaluate(id => sessions[id].items[0].state, batchId)).toBe('cancelled');
});

test('failed batch results and Retry remain visible after the popup reopens', async ({ extension }) => {
  const batchId = await extension.worker.evaluate(async sourceUrl => {
    const [tab] = await chrome.tabs.query({ url: sourceUrl });
    sessionsLoaded = true; downloadMapLoaded = true;
    const batch = createSessionFromExtractedLinks(tab, 'Failed fixture', [{ url: 'https://fuckingfast.co/file', label: 'Part 1' }], 0);
    sessions[batch.id] = batch;
    batch.hasStarted = true;
    batch.items[0].state = 'error';
    batch.items[0].error = 'Controlled failure';
    return batch.id;
  }, extension.source.url());
  await extension.popup.goto(`chrome-extension://${extension.id}/popup.html`);
  await expect(extension.popup.locator('#retry-button')).toBeVisible();
  await extension.popup.reload();
  await expect(extension.popup.locator('#retry-button')).toBeVisible();
  await expect(extension.popup.locator('#status')).toContainText('Controlled failure');
  expect(await extension.worker.evaluate(id => sessions[id].items[0].state, batchId)).toBe('error');
  await extension.popup.locator('#rescan-button').click();
  await expect(extension.popup.locator('#select-all-row')).toBeVisible();
  await expect(extension.popup.locator('#files-list input')).toHaveCount(3);
});

test('durable batch IDs distinguish an old detached source from a new scan of the same tab', async ({ extension }) => {
  const result = await extension.worker.evaluate(async sourceUrl => {
    const [tab] = await chrome.tabs.query({ url: sourceUrl });
    await loadSessions();
    const oldBatch = createSessionFromExtractedLinks(tab, 'Old batch', [{ url: 'https://fuckingfast.co/file', label: 'Original file' }], 0);
    oldBatch.hasStarted = true; oldBatch.paused = true;
    oldBatch.sourceAttached = false; oldBatch.sourceClosed = true;
    sessions[oldBatch.id] = oldBatch;
    const fresh = await ensureSessionForTab(tab);
    return { oldId: oldBatch.id, newId: fresh.id, oldState: sessions[oldBatch.id].items[0].state,
      ownerKeys: Object.keys(sessions), sourceTabId: tab.id };
  }, extension.source.url());
  expect(result.oldId).not.toBe(result.newId);
  expect(result.ownerKeys).toContain(result.oldId);
  expect(result.ownerKeys).toContain(result.newId);
  expect(result.ownerKeys).not.toContain(String(result.sourceTabId));
  expect(result.oldState).toBe('queued');
});
