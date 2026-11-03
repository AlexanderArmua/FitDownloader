const { test: base, expect, chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
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
