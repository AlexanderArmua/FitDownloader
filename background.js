// FitGirl FuckingFast Batch Downloader - background service worker (MV3)

// Default maximum number of FuckingFast links we will actively process at once
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;

const DEFAULT_SETTINGS = {
  concurrency: DEFAULT_MAX_CONCURRENT_DOWNLOADS
};

function parseTrustedUrl(value, hosts, upgradeHttp = false) {
  try {
    const url = new URL(value);
    if (upgradeHttp && url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:" || !hosts.includes(url.hostname) ||
        url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

function isSupportedSource(value) {
  return !!parseTrustedUrl(value, ["fitgirl-repacks.site"]);
}

function normalizeLandingUrl(value) {
  const url = parseTrustedUrl(value, ["fuckingfast.co"], true);
  return url ? url.href : null;
}

function validateDirectUrl(value) {
  const url = parseTrustedUrl(value, ["fuckingfast.co", "dl.fuckingfast.co"]);
  if (!url || !url.pathname.startsWith("/dl/")) {
    throw new Error("Rejected an unsafe or unsupported download URL.");
  }
  return url.href;
}

// Durable batch ownership is independent of Chrome tabs and queue positions.
const STATE_KEY = "ffBatchState";
const STATE_VERSION = 2;
let sessions = Object.create(null);
let sessionsLoaded = false;
let downloadMapLoaded = false;
let stateLoadPromise;
let recoveryPromise;
let browserRestart = false;
let downloadIdToKey = new Map();
let downloadHistory = new Map();
let mutationTail = Promise.resolve();
let persistenceTail = Promise.resolve();
// All live state entry points use this queue. Internal *State functions run
// inside it and must not enqueue/await another mutation. Host fetches run outside.
function mutateState(operation) {
  const result = mutationTail.then(async () => { await loadState(); return operation(); });
  mutationTail = result.catch(() => {});
  return result;
}
function persistSnapshot(snapshot) {
  // Capture at call time, not when an older write eventually finishes.
  const value = JSON.parse(JSON.stringify(snapshot));
  const result = persistenceTail.then(() => chrome.storage.local.set(value));
  persistenceTail = result.catch(() => {});
  return result;
}
const ACTIVE_ITEM_STATES = new Set(["queued", "starting", "downloading", "paused"]);
const activeResolvers = new Set();
const resolverRequests = new Map();
const pendingDownloadCreations = new Set();
const earlyDownloadEvents = new Map();
const MAX_EARLY_DOWNLOAD_EVENTS = 256;
function isTerminalDownloadEvent(event) { return event?.state === "complete" || event?.state === "interrupted" || event?.erased === true; }
function captureEarlyDownloadEvent(id, event) {
  if (!pendingDownloadCreations.size || downloadIdToKey.has(id)) return;
  const previous = earlyDownloadEvents.get(id);
  if (previous?.erased || (isTerminalDownloadEvent(previous) && !event.erased && event.state !== "in_progress")) return;
  if (!previous && earlyDownloadEvents.size >= MAX_EARLY_DOWNLOAD_EVENTS) earlyDownloadEvents.delete(earlyDownloadEvents.keys().next().value);
  earlyDownloadEvents.set(id, { ...previous, ...event });
}
function applyTerminalDownloadEvent(batch, item, downloadId, event) {
  rememberBrowserDownload(batch, item, downloadId);
  downloadIdToKey.delete(downloadId);
  item.downloadId = null;
  item.state = event.state === "complete" ? "completed" : event.state === "interrupted"
    ? event.error === "USER_CANCELED" ? "cancelled" : "error"
    : ["completed", "error", "cancelled"].includes(item.state) ? item.state : "cancelled";
  item.error = item.state === "error" ? event.error || item.error || "Chrome interrupted this download." : "";
  item.controlError = ""; item.syncError = "";
  if (event.erased) downloadHistory.delete(downloadId);
  else downloadHistory.get(downloadId).state = item.state;
  refreshControlError(batch);
}
function rememberBrowserDownload(batch, item, id = item.downloadId) {
  if (id == null) return;
  downloadHistory.set(id, { batchId: batch.id, itemId: item.id, generation: batch.generation,
    url: item.url, label: item.label, state: [...ACTIVE_ITEM_STATES, "completed", "error", "cancelled"].includes(item.state) ? item.state : "downloading" });
}
function restoreDownloadHistory(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Saved download history is invalid. Existing data has been preserved.");
  const history = new Map();
  for (const [id, key] of Object.entries(raw)) {
    if (!Number.isInteger(Number(id)) || Number(id) < 0 || !validId(key?.batchId) || !validId(key?.itemId) ||
        !Number.isInteger(key.generation) || !normalizeLandingUrl(key.url) ||
        ![...ACTIVE_ITEM_STATES, "completed", "error", "cancelled"].includes(key.state)) throw new Error("Saved download history is invalid. Existing data has been preserved.");
    history.set(Number(id), { batchId: key.batchId, itemId: key.itemId, generation: key.generation,
      url: normalizeLandingUrl(key.url), label: typeof key.label === "string" ? key.label : key.url, state: key.state });
  }
  return history;
}
function validId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value); }
function durableId(value) { return validId(value) ? value : crypto.randomUUID(); }
function resolverKey(batchId, itemId, generation) { return JSON.stringify([batchId, itemId, generation]); }
function stateSnapshot(batches = sessions, map = downloadIdToKey, history = downloadHistory) {
  return { schemaVersion: STATE_VERSION, batches, downloadMap: Object.fromEntries(map), downloadHistory: Object.fromEntries(history) };
}
function rebuildDownloadMap(batches, rawMap = {}) {
  const map = new Map();
  for (const [id, key] of Object.entries(rawMap)) {
    const downloadId = Number(id);
    const batch = batches[key?.batchId];
    const item = batch?.items.find(item => item.id === key.itemId);
    if (Number.isInteger(downloadId) && downloadId >= 0 && item && key.generation === batch.generation &&
        ACTIVE_ITEM_STATES.has(item.state) && (item.downloadId == null || item.downloadId === downloadId)) {
      item.downloadId = downloadId;
      map.set(downloadId, { batchId: batch.id, itemId: item.id, generation: batch.generation });
    }
  }
  for (const batch of Object.values(batches)) {
    for (const item of batch.items) {
      const existing = item.downloadId != null && map.get(item.downloadId);
      if (existing && (existing.batchId !== batch.id || existing.itemId !== item.id)) {
        throw new Error("Saved download ownership is ambiguous. Existing data has been preserved.");
      }
      if (item.downloadId != null && !map.has(item.downloadId)) {
        map.set(item.downloadId, { batchId: batch.id, itemId: item.id, generation: batch.generation });
      }
    }
  }
  return map;
}
function migrateLegacyState(rawSessions, rawMap) {
  const batches = Object.create(null);
  const ownerIds = new Map();
  for (const [legacyId, raw] of Object.entries(rawSessions || {})) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const batch = normalizeSessionShape({ ...raw, id: crypto.randomUUID(),
      sourceTabId: Number.isInteger(raw.tabId) ? raw.tabId : Number(legacyId) });
    batches[batch.id] = batch;
    ownerIds.set(String(legacyId), batch);
  }
  const mapped = {};
  for (const [downloadId, key] of Object.entries(rawMap || {})) {
    const batch = ownerIds.get(String(key?.tabId));
    const rawItem = rawSessions?.[key?.tabId]?.items?.[key?.index];
    if (!batch || !rawItem || key.generation !== batch.generation) continue;
    const link = normalizeLandingUrl(rawItem.url);
    const item = batch.items.find(item => item.downloadId === Number(downloadId)) ||
      batch.items.find(item => item.url === link && item.downloadId == null);
    if (item) mapped[downloadId] = { batchId: batch.id, itemId: item.id, generation: key.generation };
  }
  return { batches, map: rebuildDownloadMap(batches, mapped) };
}
async function loadState() {
  if (sessionsLoaded && downloadMapLoaded) return;
  if (stateLoadPromise) return stateLoadPromise;
  stateLoadPromise = (async () => {
    const stored = await chrome.storage.local.get([STATE_KEY, "ffSessions", "ffDownloadMap"]);
    const state = stored[STATE_KEY];
    let batches, map, history;
    if (state != null) {
      if (state.schemaVersion !== STATE_VERSION || !state.batches || typeof state.batches !== "object" ||
          Array.isArray(state.batches) || !state.downloadMap || typeof state.downloadMap !== "object" || Array.isArray(state.downloadMap)) {
        throw new Error("Saved batch state is invalid or from an unsupported version. Existing data has been preserved.");
      }
      batches = Object.create(null);
      for (const [id, raw] of Object.entries(state.batches)) {
        if (!validId(id) || !raw || raw.id !== id || !Array.isArray(raw.items)) {
          throw new Error("Saved batch identity is invalid. Existing data has been preserved.");
        }
        batches[id] = normalizeSessionShape(raw);
      }
      map = rebuildDownloadMap(batches, state.downloadMap);
      history = restoreDownloadHistory(state.downloadHistory);
    } else {
      ({ batches, map } = migrateLegacyState(stored.ffSessions, stored.ffDownloadMap));
      history = new Map();
      // Commit the complete migration atomically; keep legacy keys untouched.
      await persistSnapshot({ [STATE_KEY]: stateSnapshot(batches, map, history) });
    }
    sessions = batches; downloadIdToKey = map; downloadHistory = history;
    sessionsLoaded = downloadMapLoaded = true;
  })().catch(error => { stateLoadPromise = null; throw error; });
  return stateLoadPromise;
}
async function loadSessions() { return loadState(); }
async function saveSessions() { await persistSnapshot({ [STATE_KEY]: stateSnapshot() }); }
function recoverSessions() {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = mutateState(async () => {
    for (const batch of Object.values(sessions)) {
      if (browserRestart) {
        batch.sourceAttached = false;
        if (batch.hasStarted) batch.paused = true;
      }
      await reconcileBatchState(batch.id);
    }
    await saveSessions();
    for (const id of Object.keys(sessions)) pumpQueueForBatch(id).catch(console.error);
  }).catch(error => { recoveryPromise = null; throw error; });
  return recoveryPromise;
}
chrome.runtime.onStartup.addListener(() => { browserRestart = true; recoverSessions().catch(console.error); });

function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CONCURRENT_DOWNLOADS;
  // Hard limit between 1 and 20 to avoid abuse
  return Math.max(1, Math.min(20, Math.round(n)));
}

async function getCurrentSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    concurrency: clampConcurrency(stored.concurrency)
  };
}


function normalizeLink(link) {
  if (!link || typeof link.url !== "string" || !link.url.length) return null;
  const url = normalizeLandingUrl(link.url);
  if (!url) return null;
  return {
    id: durableId(link.id),
    url,
    label: typeof link.label === "string" && link.label.length ? link.label : link.url
  };
}

function toQueuedItem(link) {
  return {
    id: durableId(link.id),
    url: link.url,
    label: link.label || link.url,
    state: "queued",
    controlError: "",
    syncError: "",
    downloadId: null
  };
}

function normalizeSessionItem(item) {
  const link = normalizeLink(item);
  if (!link) return null;
  return {
    id: link.id,
    url: link.url,
    label: link.label,
    state: typeof item?.state === "string" ? item.state : "queued",
    error: typeof item?.error === "string" ? item.error : "",
    controlError: typeof item?.controlError === "string" ? item.controlError : "",
    syncError: typeof item?.syncError === "string" ? item.syncError : "",
    downloadId: Number.isInteger(item?.downloadId) && item.downloadId >= 0 ? item.downloadId : null
  };
}

function normalizeSessionShape(session) {
  if (!session || typeof session !== "object") {
    return {
      id: crypto.randomUUID(),
      sourceTabId: null,
      sourceAttached: false,
      sourceUrl: "",
      title: "",
      hasStarted: false,
      paused: false,
      generation: 0,
      pendingControl: "",
      controlError: "",
      allItems: [],
      items: []
    };
  }

  const normalizedItems = Array.isArray(session.items)
    ? session.items.map(normalizeSessionItem).filter(Boolean)
    : [];

  const usedItemIds = new Set();
  for (const item of normalizedItems) {
    if (usedItemIds.has(item.id)) item.id = crypto.randomUUID();
    usedItemIds.add(item.id);
  }
  const rawAllItems = Array.isArray(session.allItems) ? session.allItems : [];
  const normalizedAllItems = rawAllItems.map(link => {
    const existing = normalizedItems.find(item => item.url === normalizeLandingUrl(link?.url));
    return normalizeLink({ ...link, id: link?.id || existing?.id });
  }).filter(Boolean);
  const usedLinkIds = new Set();
  for (const link of normalizedAllItems) {
    if (usedLinkIds.has(link.id)) link.id = crypto.randomUUID();
    usedLinkIds.add(link.id);
  }
  const allItems =
    normalizedAllItems.length > 0
      ? normalizedAllItems
      : normalizedItems.map((item) => ({ id: item.id, url: item.url, label: item.label }));

  return {
    id: durableId(session.id),
    sourceTabId: Number.isInteger(session.sourceTabId) ? session.sourceTabId : null,
    sourceAttached: session.sourceAttached !== false && session.sourceClosed !== true,
    sourceClosed: session.sourceClosed === true,
    sourceUrl: typeof session.sourceUrl === "string" ? session.sourceUrl : "",
    title: typeof session.title === "string" ? session.title : "",
    hasStarted: session.hasStarted === true,
    paused: session.paused === true,
    generation: Number.isInteger(session.generation) ? session.generation : 0,
    pendingControl: ["pause", "resume", "cancel"].includes(session.pendingControl) ? session.pendingControl : "",
    controlError: typeof session.controlError === "string" ? session.controlError : "",
    allItems,
    items: normalizedItems
  };
}

function getSessionGeneration(session) {
  return Number.isInteger(session?.generation) ? session.generation : 0;
}

function hasActiveItems(session) {
  if (!session || session.hasStarted !== true || !Array.isArray(session.items)) {
    return false;
  }
  return session.items.some((item) => ACTIVE_ITEM_STATES.has(item.state));
}

function normalizeSessionUrl(url) {
  if (typeof url !== "string" || !url.length) return "";

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (e) {
    return url.split("#")[0];
  }
}

function isSessionGenerationCurrent(batchId, generation) {
  return !!sessions[batchId] && getSessionGeneration(sessions[batchId]) === generation;
}
function getSessionItemForRun(batchId, itemId, generation) {
  if (!isSessionGenerationCurrent(batchId, generation)) return null;
  return sessions[batchId].items.find(item => item.id === itemId) || null;
}
function createSessionFromExtractedLinks(tab, title, links, generation) {
  const allItems = Array.isArray(links) ? links.map(normalizeLink).filter(Boolean) : [];
  return normalizeSessionShape({ id: crypto.randomUUID(), sourceTabId: tab.id,
    sourceUrl: tab.url, sourceAttached: true, title: title || "", hasStarted: false,
    paused: false, generation, allItems, items: allItems.map(toQueuedItem) });
}

function searchDownloadById(downloadId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search({ id: downloadId }, (results) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!Array.isArray(results)) { reject(new Error("Chrome returned an invalid download search result.")); return; }
      resolve(results[0] || null);
    });
  });
}

async function reconcileBatch(batchId) {
  return mutateState(() => reconcileBatchState(batchId));
}
async function reconcileBatchState(batchId) {
  const existing = sessions[batchId];
  if (!existing) return;

  const session = normalizeSessionShape(existing);
  let sessionsChanged = false;
  let mapChanged = false;

  for (let i = 0; i < session.items.length; i++) {
    const item = session.items[i];

    if (item.downloadId == null) {
      if (item.state === "starting") {
        if (!activeResolvers.has(resolverKey(batchId, item.id, getSessionGeneration(session)))) {
          item.state = "queued";
          sessionsChanged = true;
        }
        continue;
      }
      if (item.state === "downloading" || item.state === "paused") {
        item.state = "error";
        sessionsChanged = true;
      }
      continue;
    }

    const downloadId = item.downloadId;
    if (!downloadHistory.has(downloadId)) mapChanged = true;
    rememberBrowserDownload(session, item);
    let download;
    try {
      download = await searchDownloadById(downloadId);
      if (item.syncError) { item.syncError = ""; sessionsChanged = true; }
    } catch (error) {
      item.syncError = "Could not check download status: " + (error.message || String(error));
      downloadIdToKey.set(downloadId, { batchId, itemId: item.id, generation: session.generation });
      sessionsChanged = mapChanged = true;
      continue;
    }

    if (!download) {
      downloadIdToKey.delete(downloadId);
      mapChanged = true;
      item.downloadId = null;
      item.controlError = "";
      downloadHistory.get(downloadId).state = "cancelled";
      if (ACTIVE_ITEM_STATES.has(item.state)) {
        item.state = "cancelled";
      }
      sessionsChanged = true;
      continue;
    }

    if (download.state === "complete") {
      downloadIdToKey.delete(downloadId);
      mapChanged = true;
      item.downloadId = null;
      item.controlError = "";
      item.state = "completed";
      downloadHistory.get(downloadId).state = item.state;
      sessionsChanged = true;
      continue;
    }

    if (download.state === "interrupted") {
      downloadIdToKey.delete(downloadId);
      mapChanged = true;
      item.downloadId = null;
      item.controlError = "";
      item.state = download.error === "USER_CANCELED" ? "cancelled" : "error";
      downloadHistory.get(downloadId).state = item.state;
      sessionsChanged = true;
      continue;
    }

    const nextState = download.paused ? "paused" : "downloading";
    downloadHistory.get(downloadId).state = nextState;
    if (item.controlError && ((session.pendingControl === "pause" && download.paused) ||
        (session.pendingControl === "resume" && !download.paused))) {
      item.controlError = ""; sessionsChanged = true;
    }
    if (item.state !== nextState) {
      item.state = nextState;
      sessionsChanged = true;
    }

    const existingKey = downloadIdToKey.get(downloadId);
    const generation = getSessionGeneration(session);
    if (
      !existingKey ||
      existingKey.batchId !== batchId ||
      existingKey.itemId !== item.id ||
      existingKey.generation !== generation
    ) {
      downloadIdToKey.set(downloadId, { batchId, itemId: item.id, generation });
      mapChanged = true;
    }
  }

  const beforeControl = JSON.stringify([session.paused, session.hasStarted, session.pendingControl, session.controlError]);
  refreshControlError(session);
  if (beforeControl !== JSON.stringify([session.paused, session.hasStarted, session.pendingControl, session.controlError])) sessionsChanged = true;

  if (sessionsChanged) {
    sessions[batchId] = session;
    broadcastSessionUpdate(batchId);
  }

  if (sessionsChanged || mapChanged) {
    await saveSessions();
  }
  if (existing.paused && !session.paused && session.hasStarted) pumpQueueForBatch(batchId).catch(console.error);
}

function findSessionForTab(tab) {
  return Object.values(sessions).find(batch => batch.sourceAttached && !batch.sourceClosed &&
    batch.sourceTabId === tab?.id && normalizeSessionUrl(batch.sourceUrl) === normalizeSessionUrl(tab.url));
}
async function rebuildSessionState(tab, generation) {
  const { title, items } = await extractFuckingFastLinks(tab.id);
  const rebuilt = createSessionFromExtractedLinks(tab, title, items, generation);
  for (const batch of Object.values(sessions)) {
    if (batch.sourceTabId === tab.id) batch.sourceAttached = false;
  }
  sessions[rebuilt.id] = rebuilt;
  await saveSessions();
  return rebuilt;
}
function broadcastSessionUpdate(batchId) {
  const session = sessions[batchId];
  if (!session) return;
  try {
    chrome.runtime.sendMessage({ type: "session_updated", batchId, session }, () => { void chrome.runtime.lastError; });
  } catch { /* The popup can close before the update arrives. */ }
}

/**
 * Extract all FuckingFast links from the current FitGirl page.
 * Runs in the context of the page via chrome.scripting.executeScript.
 */
async function extractFuckingFastLinks(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      const rawTitle = document.title || "";
      const title = rawTitle.replace(/ - FitGirl Repacks.*/i, "").trim();

      // Try to scope to the main post content if possible
      const containers = [
        document.querySelector(".entry-content"),
        document.querySelector(".post"),
        document.body
      ].filter(Boolean);

      const items = [];

      for (const container of containers) {
        const anchors = container.querySelectorAll(
          'a[href^="https://fuckingfast.co/"], a[href^="http://fuckingfast.co/"]'
        );
        anchors.forEach((a) => {
          if (a.href) {
            const label = a.textContent.trim() || a.href;
            items.push({ url: a.href, label });
          }
        });
        // If we found some inside a more specific container, no need to fall back further
        if (items.length > 0 && container !== document.body) {
          break;
        }
      }

      // De-duplicate by URL while preserving first label
      const seen = new Set();
      const unique = [];
      for (const item of items) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        unique.push(item);
      }

      return { title, items: unique };
    }
  });

  if (result && Array.isArray(result.items)) {
    return { title: result.title || "", items: result.items };
  }

  return { title: "", items: [] };
}

function extractSecureDownloadUrl(text) {
  const decoded = text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const match = decoded.match(/https:\/\/(?:dl\.)?fuckingfast\.co\/dl\/[^\s"'<>\\]+/);
  return match ? validateDirectUrl(match[0]) : null;
}

function hostResponseError(response, html) {
  if (response.status === 403 || /<title[^>]*>\s*Just a moment|cf-chl-|cf-turnstile/i.test(html)) {
    const error = new Error("The file host blocked this request or requires browser verification (HTTP " + response.status + "). Open the original file page, complete any verification yourself, then resume. No ad pages were opened.");
    error.code = "HOST_VERIFICATION";
    return error;
  }
  return new Error(`File host returned HTTP ${response.status}.`);
}

// Follow the host's observed HTMX protocol, never its advertising scripts.
async function getDirectDownloadUrl(fuckingFastUrl, cancellationSignal) {
  cancellationSignal?.throwIfAborted();
  const normalized = normalizeLandingUrl(fuckingFastUrl);
  if (!normalized) throw new Error("Rejected an unsupported file-host URL.");
  const url = new URL(normalized);
  // Fragments contain display filenames, not part of the HTTP resource.
  url.hash = "";
  let res;
  try {
    res = await fetch(url.href, {
      credentials: "include",
      redirect: "error",
      signal: cancellationSignal ? AbortSignal.any([cancellationSignal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    });
  } catch (err) {
    if (cancellationSignal?.aborted) throw cancellationSignal.reason;
    throw new Error("Unable to fetch the HTTPS file page. Reload the extension and allow access to fuckingfast.co in Chrome's extension Site access settings. The host may also be unavailable or redirecting. " + err.message);
  }
  const html = await res.text();
  cancellationSignal?.throwIfAborted();
  if (!res.ok) throw hostResponseError(res, html);
  const legacyLink = extractSecureDownloadUrl(html);
  if (legacyLink) return legacyLink;

  // The current DOWNLOAD control has hx-post="/f/<file-id>/go".
  // Accept only the endpoint belonging to this exact landing page.
  const fileId = url.pathname.slice(1);
  const expectedPath = `/f/${fileId}/go`;
  const postPaths = Array.from(html.matchAll(/\bhx-post\s*=\s*["']([^"']+)["']/gi));
  const endpoint = postPaths.map((match) => {
    try { return new URL(match[1], url); } catch { return null; }
  }).find((candidate) => candidate && candidate.origin === url.origin &&
    candidate.pathname === expectedPath && !candidate.search && !candidate.hash &&
    !candidate.username && !candidate.password);
  if (!/^[A-Za-z0-9_-]+$/.test(fileId) || !endpoint) {
    if (/<title[^>]*>\s*Just a moment|cf-chl-/i.test(html)) throw hostResponseError(res, html);
    throw new Error("No secure direct download link or supported download control found on the file page.");
  }

  let generated;
  try {
    generated = await fetch(endpoint.href, {
      method: "POST",
      headers: {
        "HX-Request": "true",
        "HX-Current-URL": url.href,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "",
      credentials: "include",
      redirect: "error",
      signal: cancellationSignal ? AbortSignal.any([cancellationSignal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    });
  } catch (err) {
    if (cancellationSignal?.aborted) throw cancellationSignal.reason;
    throw new Error("The host's download-link request failed or redirected unexpectedly. No ad pages were opened. " + err.message);
  }
  const body = await generated.text();
  cancellationSignal?.throwIfAborted();
  if (!generated.ok) throw hostResponseError(generated, body);
  // HTMX commonly returns navigation instructions in response headers.
  const redirect = generated.headers.get("HX-Redirect");
  if (redirect) return validateDirectUrl(new URL(redirect, url).href);
  const location = generated.headers.get("HX-Location");
  if (location) {
    let target = location;
    if (location.trim().startsWith("{")) {
      try { target = JSON.parse(location).path; }
      catch { throw new Error("The file host returned an invalid download response."); }
    }
    return validateDirectUrl(new URL(target, url).href);
  }
  const direct = extractSecureDownloadUrl(body);
  if (direct) return direct;
  // Some HTMX integrations deliver the URL as an event payload.
  for (const name of ["HX-Trigger", "HX-Trigger-After-Swap", "HX-Trigger-After-Settle"]) {
    const eventLink = extractSecureDownloadUrl(generated.headers.get(name) || "");
    if (eventLink) return eventLink;
  }
  if (/Just a moment|cf-chl-|cf-turnstile/i.test(body)) throw hostResponseError(generated, body);
  throw new Error("The host's download request succeeded but returned an unsupported response. No ad pages were opened.");
}

/**
 * Start a Chrome download for the given URL and resolve with its downloadId.
 */
function startDownload(dlUrl) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: validateDirectUrl(dlUrl),
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          reject(
            chrome.runtime.lastError ||
              new Error("chrome.downloads.download() failed")
          );
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

/**
 * Ensure we have a session for the given active FitGirl tab.
 */
async function ensureSessionForTab(tab) {
  return mutateState(() => ensureSessionState(tab));
}
async function ensureSessionState(tab) {
  if (!isSupportedSource(tab?.url)) throw new Error("Please open an HTTPS FitGirl repack page first.");
  const existing = findSessionForTab(tab);
  if (existing) { await reconcileBatchState(existing.id); return sessions[existing.id]; }
  return rebuildSessionState(tab, 0);
}

/**
 * Pump a durable batch queue: start new downloads
 * up to the concurrency limit. Called when a batch starts and whenever
 * a download for that URL completes.
 */
async function pumpQueueForBatch(batchId, expectedGeneration) {
  const { concurrency } = await getCurrentSettings();
  const reservations = await mutateState(async () => {
    const session = sessions[batchId];
    if (!session || !session.hasStarted || session.paused) return [];
    const generation = expectedGeneration ?? getSessionGeneration(session);
    if (!isSessionGenerationCurrent(batchId, generation)) return [];
    const active = session.items.filter(item => item.state === "starting" || item.state === "downloading" || item.state === "paused").length;
    let slots = clampConcurrency(concurrency) - active;
    const reserved = [];
    for (const item of session.items) {
      if (slots <= 0) break;
      if (item.state !== "queued") continue;
      slots--;
      item.state = "starting"; item.error = "";
      const ownershipKey = resolverKey(batchId, item.id, generation);
      activeResolvers.add(ownershipKey);
      const controller = new AbortController();
      resolverRequests.set(ownershipKey, { batchId, controller });
      reserved.push({ batchId, itemId: item.id, generation, url: item.url, ownershipKey, controller });
    }
    if (reserved.length) {
      try { await saveSessions(); }
      catch (error) {
        for (const reservation of reserved) {
          activeResolvers.delete(reservation.ownershipKey);
          resolverRequests.get(reservation.ownershipKey)?.controller.abort();
          resolverRequests.delete(reservation.ownershipKey);
          const item = getSessionItemForRun(batchId, reservation.itemId, generation);
          if (item) item.state = "queued";
        }
        throw error;
      }
    }
    return reserved;
  });
  for (const reservation of reservations) resolveReservedItem(reservation).catch(console.error);
}

async function resolveReservedItem({ batchId, itemId, generation, url, ownershipKey, controller }) {
  let ownsReservation = true;
  try {
    // Remote requests never hold the mutation queue. Cancel and other batches
    // remain usable while a host is slow or presents a verification page.
    const dlUrl = await getDirectDownloadUrl(url, controller.signal);
    const mayStart = await mutateState(async () => {
      const item = getSessionItemForRun(batchId, itemId, generation);
      if (!item || item.state !== "starting") return false;
      if (!sessions[batchId].paused) return true;
      item.state = "queued";
      activeResolvers.delete(ownershipKey);
      resolverRequests.delete(ownershipKey);
      ownsReservation = false;
      await saveSessions(); broadcastSessionUpdate(batchId);
      return false;
    });
    if (!mayStart) return;
    pendingDownloadCreations.add(ownershipKey);
    try {
      const downloadId = await startDownload(dlUrl);
      await mutateState(async () => {
        const item = getSessionItemForRun(batchId, itemId, generation);
        if (!item || item.state !== "starting") {
          let finished = isTerminalDownloadEvent(earlyDownloadEvents.get(downloadId));
          if (!finished) {
            try {
              const download = await searchDownloadById(downloadId);
              finished = !download || download.state === "complete" || download.state === "interrupted";
            } catch { /* A failed query cannot establish whether cancellation is needed. */ }
          }
          if (finished) return;
          try { await chrome.downloads.cancel(downloadId); }
          catch (error) {
            await retainLateDownload(batchId, itemId, url, downloadId, error);
            await reconcileBatchState(batchId);
          }
          return;
        }
        item.downloadId = downloadId; item.state = "downloading";
        rememberBrowserDownload(sessions[batchId], item);
        downloadIdToKey.set(downloadId, { batchId, itemId, generation });
        // Persist ownership before querying Chrome. Tiny downloads may already
        // have finished, even if their terminal event was never delivered here.
        await saveSessions();
        await reconcileBatchState(batchId);
        const current = getSessionItemForRun(batchId, itemId, generation);
        const early = earlyDownloadEvents.get(downloadId);
        if (isTerminalDownloadEvent(early)) applyTerminalDownloadEvent(sessions[batchId], current, downloadId, early);
        else if (early && current.downloadId != null && current.syncError) {
          current.state = early.paused === true ? "paused" : "downloading";
          rememberBrowserDownload(sessions[batchId], current);
        }
        earlyDownloadEvents.delete(downloadId);
        if (current.downloadId != null && current.state === "downloading" && sessions[batchId].paused) {
          try { await chrome.downloads.pause(downloadId); current.state = "paused"; }
          catch (error) {
            const batch = sessions[batchId];
            if (batch.pendingControl !== "pause") beginControl(batch, "pause");
            current.controlError = error.message || String(error);
            refreshControlError(batch);
          }
        }
        await saveSessions(); broadcastSessionUpdate(batchId);
        pumpQueueForBatch(batchId, generation).catch(console.error);
      });
    } finally {
      pendingDownloadCreations.delete(ownershipKey);
      if (!pendingDownloadCreations.size) earlyDownloadEvents.clear();
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    await mutateState(async () => {
      const item = getSessionItemForRun(batchId, itemId, generation);
      if (!item || item.state !== "starting") return;
      console.warn("Failed to start FuckingFast URL:", item.url, error);
      item.state = error.code === "HOST_VERIFICATION" ? "queued" : "error";
      if (error.code === "HOST_VERIFICATION") sessions[batchId].paused = true;
      item.error = error.message || String(error);
      item.downloadId = null;
      await saveSessions(); broadcastSessionUpdate(batchId);
      pumpQueueForBatch(batchId, generation).catch(console.error);
    });
  } finally {
    if (ownsReservation) await mutateState(() => {
      activeResolvers.delete(ownershipKey);
      if (resolverRequests.get(ownershipKey)?.controller === controller) resolverRequests.delete(ownershipKey);
    });
  }
}

// Browser events follow durable ownership, including events before creation returns.
function handleDownloadEvent(downloadId, event) {
  captureEarlyDownloadEvent(downloadId, event);
  (async () => {
    const tracked = await mutateState(async () => {
      const key = downloadIdToKey.get(downloadId);
      if (!key) {
        if (event.erased) {
          if (downloadHistory.delete(downloadId)) await saveSessions();
          return false;
        }
        return adoptResumedBrowserDownload(downloadId, event);
      }
      const item = getSessionItemForRun(key.batchId, key.itemId, key.generation);
      if (item && item.downloadId === downloadId) return true;
      downloadIdToKey.delete(downloadId);
      await saveSessions();
      return false;
    });
    if (!tracked) return;
    await recoverSessions();
    const owner = await mutateState(async () => {
      const key = downloadIdToKey.get(downloadId);
      if (!key) return null;
      const item = getSessionItemForRun(key.batchId, key.itemId, key.generation);
      if (!item || item.downloadId !== downloadId) return null;
      const batch = sessions[key.batchId];
      if (isTerminalDownloadEvent(event)) applyTerminalDownloadEvent(batch, item, downloadId, event);
      else {
        item.state = event.paused === true ? "paused" : "downloading";
        if ((batch.pendingControl === "pause" && item.state === "paused") ||
            (batch.pendingControl === "resume" && item.state === "downloading")) item.controlError = "";
        refreshControlError(batch);
        rememberBrowserDownload(batch, item);
      }
      await saveSessions(); broadcastSessionUpdate(key.batchId);
      return key;
    });
    if (owner) await pumpQueueForBatch(owner.batchId, owner.generation);
  })().catch(console.error);
}
chrome.downloads.onChanged.addListener(delta => {
  const state = delta.state?.current;
  const paused = delta.paused?.current;
  if (state !== "complete" && state !== "interrupted" && state !== "in_progress" && typeof paused !== "boolean") return;
  handleDownloadEvent(delta.id, { ...(state ? { state } : {}),
    ...(typeof paused === "boolean" ? { paused } : {}), ...(delta.error ? { error: delta.error.current } : {}) });
});
chrome.downloads.onErased.addListener(downloadId => handleDownloadEvent(downloadId, { erased: true }));
chrome.tabs.onRemoved.addListener(sourceTabId => {
  mutateState(async () => {
    for (const batch of Object.values(sessions)) {
      if (batch.sourceTabId !== sourceTabId || !batch.sourceAttached) continue;
      batch.sourceClosed = true; batch.sourceAttached = false;
      if (!batch.hasStarted) delete sessions[batch.id];
      broadcastSessionUpdate(batch.id);
    }
    await saveSessions();
  }).catch(console.error);
});
function getBatchSummaries() {
  return Object.values(sessions).filter(batch => batch.hasStarted).map(batch => ({
    batchId: batch.id, title: batch.title || batch.sourceUrl || "Saved batch", sourceClosed: batch.sourceClosed
  }));
}
async function activeTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }
function requireBatch(batchId) {
  if (!validId(batchId) || !Object.hasOwn(sessions, batchId)) throw new Error("This batch is no longer available.");
  return sessions[batchId];
}
async function controlBatch(message) {
  if (message.batchId != null) return requireBatch(message.batchId);
  const tab = await activeTab();
  const batch = tab && findSessionForTab(tab);
  if (!batch) throw new Error("No active batch found. Select a saved batch first.");
  return batch;
}
async function sourceTabForBatch(batch) {
  if (!batch.sourceAttached || batch.sourceClosed || !Number.isInteger(batch.sourceTabId)) return null;
  try {
    const tab = await chrome.tabs.get(batch.sourceTabId);
    return normalizeSessionUrl(tab.url) === normalizeSessionUrl(batch.sourceUrl) ? tab : null;
  } catch { return null; }
}
function scanResponse(session) { return { ok: true, session, batchId: session.id, batches: getBatchSummaries() }; }

function beginControl(session, action) {
  session.pendingControl = action;
  session.controlError = "";
  session.paused = true; // Hold queued work until the whole operation succeeds.
  for (const item of session.items) item.controlError = "";
}
function refreshControlError(session) {
  const action = session.pendingControl;
  const failures = session.items.filter(item => item.controlError);
  session.controlError = action && failures.length
    ? `Could not ${action} ${failures.length} download(s). ${failures[0].controlError} Retry ${action} or use Chrome's Downloads.` : "";
  if (session.controlError) return;
  session.pendingControl = "";
  if (action === "resume" || (session.hasStarted && !hasActiveItems(session))) session.paused = false;
  if (action === "cancel" && !session.items.some(item => item.downloadId != null || ACTIVE_ITEM_STATES.has(item.state))) {
    session.hasStarted = false; session.paused = false;
  }
}
function controlResponse(session) {
  return { ...scanResponse(session), ok: !session.controlError, error: session.controlError || undefined };
}

async function adoptResumedBrowserDownload(downloadId, event) {
  const prior = downloadHistory.get(downloadId);
  if (!prior || !["error", "cancelled"].includes(prior.state) || isTerminalDownloadEvent(event)) return false;
  let download, syncError = "";
  try {
    download = await searchDownloadById(downloadId);
    if (!download || download.state !== "in_progress") return false;
  } catch (error) {
    syncError = "Could not check resumed download status: " + (error.message || String(error));
  }
  const batch = sessions[prior.batchId] || normalizeSessionShape({ id: prior.batchId, title: "Recovered browser download", sourceAttached: false });
  sessions[batch.id] = batch;
  let item = batch.items.find(item => item.id === prior.itemId && batch.generation === prior.generation &&
    item.downloadId == null && ["error", "cancelled"].includes(item.state));
  if (!item) { item = toQueuedItem({ id: crypto.randomUUID(), url: prior.url, label: prior.label }); batch.items.push(item); }
  item.downloadId = downloadId;
  item.state = (download?.paused ?? event.paused) === true ? "paused" : "downloading";
  item.error = ""; item.controlError = ""; item.syncError = syncError;
  batch.hasStarted = true; batch.paused = true;
  downloadIdToKey.set(downloadId, { batchId: batch.id, itemId: item.id, generation: batch.generation });
  rememberBrowserDownload(batch, item);
  await saveSessions(); broadcastSessionUpdate(batch.id);
  return true;
}

async function applyBatchControl(session, action) {
  beginControl(session, action);
  if (action === "cancel") {
    session.generation++;
    for (const [key, request] of resolverRequests) {
      if (request.batchId !== session.id) continue;
      request.controller.abort();
      resolverRequests.delete(key); activeResolvers.delete(key);
    }
  }
  for (const item of session.items) {
    const id = item.downloadId;
    if (id == null) {
      if (action === "cancel" && ACTIVE_ITEM_STATES.has(item.state)) item.state = "cancelled";
      continue;
    }
    // Cancellation invalidates resolvers, but failed Chrome operations must
    // retain ownership under the new generation so completion still works.
    downloadIdToKey.set(id, { batchId: session.id, itemId: item.id, generation: session.generation });
    rememberBrowserDownload(session, item);
    if ((action === "pause" && item.state !== "downloading") ||
        (action === "resume" && item.state !== "paused")) continue;
    try {
      await chrome.downloads[action](id);
      item.state = action === "pause" ? "paused" : action === "resume" ? "downloading" : "cancelled";
      downloadHistory.get(id).state = item.state;
      if (action === "cancel") { downloadIdToKey.delete(id); item.downloadId = null; item.syncError = ""; }
    } catch (error) {
      item.controlError = error.message || String(error);
    }
  }
  refreshControlError(session);
  await saveSessions(); broadcastSessionUpdate(session.id);
  return controlResponse(session);
}

async function retainLateDownload(batchId, itemId, url, downloadId, error) {
  const batch = sessions[batchId] || normalizeSessionShape({ id: batchId, title: "Recovered download", sourceAttached: false });
  sessions[batchId] = batch;
  let item = batch.items.find(item => item.id === itemId && item.downloadId == null && item.state === "cancelled");
  // A new run may already have reused the old file; never overwrite it.
  if (!item) { item = toQueuedItem({ id: crypto.randomUUID(), url, label: url }); batch.items.push(item); }
  if (batch.pendingControl !== "cancel") beginControl(batch, "cancel");
  batch.hasStarted = true; batch.paused = true;
  item.downloadId = downloadId; item.state = "downloading";
  item.controlError = error.message || String(error);
  downloadIdToKey.set(downloadId, { batchId, itemId: item.id, generation: batch.generation });
  rememberBrowserDownload(batch, item);
  refreshControlError(batch);
  await saveSessions(); broadcastSessionUpdate(batchId);
}


// Message-based API: opaque batch/file IDs are the only ownership selectors.
const MESSAGE_TYPES = new Set(["scan_current_tab", "start_downloads", "get_settings", "save_settings",
  "get_session", "cancel_downloads", "pause_downloads", "resume_downloads", "retry_failed"]);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !MESSAGE_TYPES.has(message.type)) return;
  (async () => {
    if (["scan_current_tab", "get_settings", "get_session"].includes(message.type)) await recoverSessions();
    return mutateState(async () => {
      if (message.tabId != null) throw new Error("Refresh the extension popup to use durable batch IDs.");
      if (message.type === "scan_current_tab") {
        if (message.refresh === true) {
          const selected = message.batchId != null ? requireBatch(message.batchId) : null;
          const tab = selected ? await sourceTabForBatch(selected) : await activeTab();
          if (!tab || !isSupportedSource(tab.url)) throw new Error("Open the original HTTPS FitGirl page to scan again.");
          const current = selected || findSessionForTab(tab);
          if (hasActiveItems(current)) throw new Error("Finish or cancel the current batch before scanning again.");
          return scanResponse(await rebuildSessionState(tab, getSessionGeneration(current) + 1));
        }
        if (message.batchId != null) {
          const batch = requireBatch(message.batchId);
          await reconcileBatchState(batch.id); return scanResponse(sessions[batch.id]);
        }
        const tab = await activeTab();
        if (isSupportedSource(tab?.url)) return scanResponse(await ensureSessionState(tab));
        const [saved] = getBatchSummaries();
        if (!saved) throw new Error("Please open a FitGirl repack page first.");
        await reconcileBatchState(saved.batchId); return scanResponse(sessions[saved.batchId]);
      }
      if (message.type === "get_settings") {
        return { ok: true, settings: await getCurrentSettings() };
      }
      if (message.type === "get_session") { return { ok: true, sessions }; }
      if (message.type === "save_settings") {
        const concurrency = clampConcurrency(message.settings?.concurrency);
        await new Promise((resolve, reject) => chrome.storage.sync.set({ concurrency }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve();
        }));
        for (const id of Object.keys(sessions)) pumpQueueForBatch(id).catch(console.error);
        return { ok: true, settings: { concurrency } };
      }
      if (message.type === "start_downloads") {
        const session = message.batchId != null ? requireBatch(message.batchId) : await ensureSessionState(await activeTab());
        if (hasActiveItems(session)) throw new Error("A batch is already running. Cancel it before starting another.");
        const selectedIds = new Set(Array.isArray(message.items) ? message.items.map(item => item?.id).filter(validId) : []);
        if (!selectedIds.size) throw new Error("No files selected for download.");
        const selected = session.allItems.filter(item => selectedIds.has(item.id)).map(toQueuedItem);
        if (!selected.length) throw new Error("Selected files were not found in the current page scan.");
        session.generation++;
        session.items = selected; session.hasStarted = true; session.paused = false;
        session.pendingControl = ""; session.controlError = "";
        for (const [id, key] of downloadIdToKey) if (key.batchId === session.id) downloadIdToKey.delete(id);
        await saveSessions(); broadcastSessionUpdate(session.id);
        pumpQueueForBatch(session.id, session.generation).catch(console.error);
        return { ok: true };
      }
      const session = await controlBatch(message);
      if (message.type === "cancel_downloads") {
        const response = await applyBatchControl(session, "cancel");
        if (!response.ok) return response;
        const tab = await sourceTabForBatch(session);
        if (tab && isSupportedSource(tab.url)) return scanResponse(await rebuildSessionState(tab, session.generation));
        return response;
      }
      if (message.type === "pause_downloads" || message.type === "resume_downloads") {
        const action = message.type === "pause_downloads" ? "pause" : "resume";
        const response = await applyBatchControl(session, action);
        if (response.ok && action === "resume") pumpQueueForBatch(session.id).catch(console.error);
        return response;
      }
      if (hasActiveItems(session)) throw new Error("Wait for active work to finish before retrying failed files.");
      const failed = session.items.filter(item => item.state === "error");
      if (failed.length) {
        for (const item of failed) { item.state = "queued"; item.downloadId = null; }
        session.generation++; session.hasStarted = true; session.paused = false;
        await saveSessions(); broadcastSessionUpdate(session.id);
        pumpQueueForBatch(session.id, session.generation).catch(console.error);
      }
      return scanResponse(session);
    });
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
