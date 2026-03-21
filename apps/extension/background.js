const VAXLINK_BG_DEBUG = false;
function bgLog(...args) {
  if (VAXLINK_BG_DEBUG) console.log('[VaxLink]', ...args);
}

let nvcBundle = null;
let nvcIndexes = {};
let bundleLoadPromise = null;
const DEFAULT_NVC_SOURCE_URL = 'https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC';
const AUTO_SYNC_INTERVAL_MINUTES = 24 * 60;
const AUTO_SYNC_ALARM_NAME = 'nvc-auto-sync';
const ACTION_ICON_SIZES = [16, 32, 48, 128];
const ACTION_ICON_PATH = 'assets/vaxlink-icon.svg';
const NVC_FETCH_HEADERS = {
  Accept: 'application/json+fhir',
  'x-app-desc': 'PHAC NVC Client'
};
const GTIN_TRADENAME_CODE_OVERRIDES = Object.freeze({
  // RECOMBIVAX HB lot Y016312 is ambiguous in NVC lot->tradename links.
  // This GTIN is treated as regular/adult RECOMBIVAX HB in pilot workflows.
  '00067055046339': '6951000087100'
});
const STORAGE_KEYS = {
  bundle: 'nvc_bundle_override',
  sourceUrl: 'nvc_bundle_source_url',
  updatedAt: 'nvc_bundle_updated_at',
  lastCheckAt: 'nvc_bundle_last_check_at',
  bundleSha256: 'nvc_bundle_sha256',
  metaVersion: 'nvc_bundle_meta_version'
};
const ANALYTICS_STORAGE_KEY = 'vaxlink_analytics_v1';
const ANALYTICS_MAX_RECENT_EVENTS = 2000;
const ANALYTICS_TOP_LIMIT = 12;
let analyticsWriteQueue = Promise.resolve();
let iconInitPromise = null;

// Load NVC bundle on installation/startup
chrome.runtime.onInstalled.addListener(() => {
  bgLog('Vaccine Scanner extension installed');
  ensureActionIcon();
  initializeNVCSync();
});

// Also load on startup
chrome.runtime.onStartup.addListener(() => {
  ensureActionIcon();
  initializeNVCSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === AUTO_SYNC_ALARM_NAME) {
    maybeAutoRefreshNVCBundle('alarm');
  }
});

// Load immediately when service worker starts
bgLog('Service worker started, loading NVC bundle');
ensureActionIcon();
initializeNVCSync();
initQueueBadge();

function ensureActionIcon() {
  if (iconInitPromise) {
    return iconInitPromise;
  }

  iconInitPromise = (async () => {
    try {
      const iconUrl = chrome.runtime.getURL(ACTION_ICON_PATH);
      const response = await fetch(iconUrl, { cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`Icon fetch failed: HTTP ${response.status}`);
      }

      const svgText = await response.text();
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml' });
      const bitmap = await createImageBitmap(svgBlob);
      const imageData = {};

      for (const size of ACTION_ICON_SIZES) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('OffscreenCanvas 2D context unavailable');
        }
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(bitmap, 0, 0, size, size);
        imageData[size] = ctx.getImageData(0, 0, size, size);
      }

      chrome.action.setIcon({ imageData });
      bgLog('Action icon updated from VaxLink SVG');
    } catch (error) {
      console.warn('Failed to set custom action icon from SVG:', error);
    }
  })();

  return iconInitPromise;
}

const MULTIPLE_INJECT_QUEUE_KEY = 'multiple_inject_queue_v1';
const BADGE_COLOR = '#0891b2';

function updateQueueBadge(rows) {
  const count = Array.isArray(rows) ? rows.length : 0;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

function initQueueBadge() {
  chrome.storage.local.get([MULTIPLE_INJECT_QUEUE_KEY], (stored) => {
    updateQueueBadge(stored && stored[MULTIPLE_INJECT_QUEUE_KEY]);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (MULTIPLE_INJECT_QUEUE_KEY in changes) {
      updateQueueBadge(changes[MULTIPLE_INJECT_QUEUE_KEY].newValue);
    }
  });
}

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

async function appendQueueRecord(storageKey, record) {
  if (!storageKey) {
    throw new Error('Missing queue storage key');
  }
  if (!record || typeof record !== 'object') {
    throw new Error('Missing queue record');
  }
  const stored = await getStorage([storageKey]);
  const rows = stored && Array.isArray(stored[storageKey]) ? stored[storageKey] : [];
  rows.push(record);
  await setStorage({ [storageKey]: rows });
  return {
    ...record,
    queueSizeAfter: rows.length
  };
}

function buildAnalyticsId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function analyticsDayKey(value = Date.now()) {
  return new Date(value).toISOString().slice(0, 10);
}

function safeAnalyticsCount(value, fallback = 1) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function createAnalyticsWorkflowStats() {
  return {
    liveScans: 0,
    popupParses: 0,
    queueSaved: 0,
    queueUsed: 0,
    autofillSuccess: 0,
    autofillFailure: 0
  };
}

function createAnalyticsDay(dayKey) {
  return {
    day: dayKey,
    eventCount: 0,
    popupOpens: 0,
    modeSwitches: { single: 0, multiple: 0, inventory: 0 },
    workflows: {
      single: createAnalyticsWorkflowStats(),
      multiple: createAnalyticsWorkflowStats(),
      inventory: createAnalyticsWorkflowStats()
    },
    parsing: { success: 0, error: 0 },
    lookup: { success: 0, error: 0 },
    autofill: { attempts: 0, success: 0, failure: 0, fromQueueSuccess: 0 },
    queues: {
      multipleSaved: 0,
      multipleUsed: 0,
      multipleCleared: 0,
      inventorySaved: 0,
      inventoryCleared: 0,
      maxMultipleDepth: 0,
      maxInventoryDepth: 0
    },
    exports: { inventoryCount: 0, inventoryRows: 0 },
    nvc: { manualSuccess: 0, manualFailure: 0, autoSuccess: 0, autoFailure: 0 },
    expiry: { expired: 0, expiringSoon: 0, valid: 0, unknown: 0 },
    sources: {},
    vaccines: {},
    manufacturers: {}
  };
}

function createAnalyticsStore() {
  const now = new Date().toISOString();
  return {
    version: 1,
    deviceId: buildAnalyticsId(),
    deviceLabel: '',
    firstSeenAt: now,
    lastEventAt: null,
    lastExportAt: null,
    days: {},
    recentEvents: []
  };
}

async function getAnalyticsStore() {
  const stored = await getStorage([ANALYTICS_STORAGE_KEY]);
  const existing = stored[ANALYTICS_STORAGE_KEY];
  if (!existing || typeof existing !== 'object') {
    const created = createAnalyticsStore();
    await setStorage({ [ANALYTICS_STORAGE_KEY]: created });
    return created;
  }
  if (!existing.deviceId) {
    existing.deviceId = buildAnalyticsId();
  }
  if (!existing.firstSeenAt) {
    existing.firstSeenAt = new Date().toISOString();
  }
  if (!existing.days || typeof existing.days !== 'object') {
    existing.days = {};
  }
  if (!Array.isArray(existing.recentEvents)) {
    existing.recentEvents = [];
  }
  if (typeof existing.deviceLabel !== 'string') {
    existing.deviceLabel = '';
  }
  return existing;
}

function ensureAnalyticsDay(store, dayKey) {
  if (!store.days[dayKey]) {
    store.days[dayKey] = createAnalyticsDay(dayKey);
  }
  return store.days[dayKey];
}

function incrementMap(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function normalizeWorkflowKey(value) {
  return value === 'multiple' || value === 'inventory' ? value : 'single';
}

function normalizeQueueKey(value) {
  return value === 'inventory' ? 'inventory' : 'multiple';
}

function normalizeExpiryKey(value) {
  if (value === 'expired') return 'expired';
  if (value === 'expiring_soon') return 'expiringSoon';
  if (value === 'valid') return 'valid';
  return 'unknown';
}

function trimAnalyticsLabel(value, maxLength = 80) {
  return String(value || '').trim().slice(0, maxLength);
}

function applyTopCounter(map, rawKey, amount = 1) {
  const key = trimAnalyticsLabel(rawKey, 60);
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (entries.length <= ANALYTICS_TOP_LIMIT) {
    return;
  }
  const trimmed = Object.fromEntries(entries.slice(0, ANALYTICS_TOP_LIMIT));
  Object.keys(map).forEach((existingKey) => {
    if (!(existingKey in trimmed)) {
      delete map[existingKey];
    }
  });
}

function appendRecentAnalyticsEvent(store, event) {
  store.recentEvents.push(event);
  if (store.recentEvents.length > ANALYTICS_MAX_RECENT_EVENTS) {
    store.recentEvents = store.recentEvents.slice(-ANALYTICS_MAX_RECENT_EVENTS);
  }
}

function applyAnalyticsEvent(day, event) {
  const workflow = normalizeWorkflowKey(event.workflow);
  const count = safeAnalyticsCount(event.count, 1);
  day.eventCount += 1;

  if (event.source) {
    incrementMap(day.sources, trimAnalyticsLabel(event.source, 40), count);
  }
  if (event.vaccineLabel) {
    applyTopCounter(day.vaccines, event.vaccineLabel, count);
  }
  if (event.manufacturer) {
    applyTopCounter(day.manufacturers, event.manufacturer, count);
  }
  if (event.expiryFlag) {
    day.expiry[normalizeExpiryKey(event.expiryFlag)] += count;
  }

  switch (event.eventType) {
    case 'popup_open':
      day.popupOpens += 1;
      break;
    case 'workflow_mode_set':
      day.modeSwitches[workflow] += 1;
      break;
    case 'parse_success':
      day.parsing.success += count;
      if (event.source && String(event.source).startsWith('popup')) {
        day.workflows[workflow].popupParses += count;
      }
      break;
    case 'parse_error':
      day.parsing.error += count;
      break;
    case 'lookup_success':
      day.lookup.success += count;
      break;
    case 'lookup_error':
      day.lookup.error += count;
      break;
    case 'scan_captured':
      day.workflows[workflow].liveScans += count;
      break;
    case 'queue_saved': {
      const queue = normalizeQueueKey(event.queue);
      if (queue === 'multiple') {
        day.queues.multipleSaved += count;
        day.queues.maxMultipleDepth = Math.max(day.queues.maxMultipleDepth, Number(event.queueSizeAfter) || 0);
      } else {
        day.queues.inventorySaved += count;
        day.queues.maxInventoryDepth = Math.max(day.queues.maxInventoryDepth, Number(event.queueSizeAfter) || 0);
      }
      day.workflows[queue].queueSaved += count;
      break;
    }
    case 'queue_used':
      day.queues.multipleUsed += count;
      day.workflows.multiple.queueUsed += count;
      break;
    case 'queue_cleared': {
      const queue = normalizeQueueKey(event.queue);
      if (queue === 'multiple') {
        day.queues.multipleCleared += count;
      } else {
        day.queues.inventoryCleared += count;
      }
      break;
    }
    case 'autofill_attempt':
      day.autofill.attempts += count;
      break;
    case 'autofill_result':
      if (event.success) {
        day.autofill.success += count;
        day.workflows[workflow].autofillSuccess += count;
        if (event.source === 'queue') {
          day.autofill.fromQueueSuccess += count;
        }
      } else {
        day.autofill.failure += count;
        day.workflows[workflow].autofillFailure += count;
      }
      break;
    case 'inventory_export':
      day.exports.inventoryCount += count;
      day.exports.inventoryRows += safeAnalyticsCount(event.rows, 0);
      break;
    case 'nvc_refresh_result': {
      const trigger = event.trigger === 'manual' ? 'manual' : 'auto';
      const key = event.success ? `${trigger}Success` : `${trigger}Failure`;
      day.nvc[key] += count;
      break;
    }
    default:
      break;
  }
}

function makeAnalyticsEvent(eventType, payload = {}) {
  const ts = payload.ts || new Date().toISOString();
  return {
    id: buildAnalyticsId(),
    ts,
    day: analyticsDayKey(ts),
    eventType,
    workflow: normalizeWorkflowKey(payload.workflow),
    queue: payload.queue ? normalizeQueueKey(payload.queue) : '',
    source: trimAnalyticsLabel(payload.source, 40),
    success: !!payload.success,
    count: safeAnalyticsCount(payload.count, 1),
    rows: safeAnalyticsCount(payload.rows, 0),
    queueSizeAfter: safeAnalyticsCount(payload.queueSizeAfter, 0),
    expiryFlag: payload.expiryFlag || '',
    vaccineLabel: trimAnalyticsLabel(payload.vaccineLabel, 60),
    manufacturer: trimAnalyticsLabel(payload.manufacturer, 60),
    trigger: payload.trigger || '',
    note: trimAnalyticsLabel(payload.note, 120)
  };
}

function mutateAnalyticsStore(mutator) {
  analyticsWriteQueue = analyticsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const store = await getAnalyticsStore();
      await mutator(store);
      await setStorage({ [ANALYTICS_STORAGE_KEY]: store });
      return store;
    });
  return analyticsWriteQueue;
}

async function logAnalyticsEvent(eventType, payload = {}) {
  return mutateAnalyticsStore((store) => {
    const event = makeAnalyticsEvent(eventType, payload);
    const day = ensureAnalyticsDay(store, event.day);
    applyAnalyticsEvent(day, event);
    appendRecentAnalyticsEvent(store, event);
    store.lastEventAt = event.ts;
  });
}

function sumObjectCounters(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + Number(value || 0);
  }
}

function aggregateAnalyticsDays(days) {
  const rollup = createAnalyticsDay('rollup');
  for (const day of days) {
    rollup.eventCount += day.eventCount || 0;
    rollup.popupOpens += day.popupOpens || 0;
    sumObjectCounters(rollup.modeSwitches, day.modeSwitches);
    ['single', 'multiple', 'inventory'].forEach((workflow) => {
      const target = rollup.workflows[workflow];
      const source = (day.workflows && day.workflows[workflow]) || {};
      target.liveScans += source.liveScans || 0;
      target.popupParses += source.popupParses || 0;
      target.queueSaved += source.queueSaved || 0;
      target.queueUsed += source.queueUsed || 0;
      target.autofillSuccess += source.autofillSuccess || 0;
      target.autofillFailure += source.autofillFailure || 0;
    });
    ['success', 'error'].forEach((key) => {
      rollup.parsing[key] += day.parsing?.[key] || 0;
      rollup.lookup[key] += day.lookup?.[key] || 0;
    });
    ['attempts', 'success', 'failure', 'fromQueueSuccess'].forEach((key) => {
      rollup.autofill[key] += day.autofill?.[key] || 0;
    });
    ['multipleSaved', 'multipleUsed', 'multipleCleared', 'inventorySaved', 'inventoryCleared'].forEach((key) => {
      rollup.queues[key] += day.queues?.[key] || 0;
    });
    rollup.queues.maxMultipleDepth = Math.max(rollup.queues.maxMultipleDepth, day.queues?.maxMultipleDepth || 0);
    rollup.queues.maxInventoryDepth = Math.max(rollup.queues.maxInventoryDepth, day.queues?.maxInventoryDepth || 0);
    ['inventoryCount', 'inventoryRows'].forEach((key) => {
      rollup.exports[key] += day.exports?.[key] || 0;
    });
    ['manualSuccess', 'manualFailure', 'autoSuccess', 'autoFailure'].forEach((key) => {
      rollup.nvc[key] += day.nvc?.[key] || 0;
    });
    ['expired', 'expiringSoon', 'valid', 'unknown'].forEach((key) => {
      rollup.expiry[key] += day.expiry?.[key] || 0;
    });
    sumObjectCounters(rollup.sources, day.sources);
    sumObjectCounters(rollup.vaccines, day.vaccines);
    sumObjectCounters(rollup.manufacturers, day.manufacturers);
  }
  return rollup;
}

async function getAnalyticsSummary() {
  const store = await getAnalyticsStore();
  const dayKeys = Object.keys(store.days).sort();
  const todayKey = analyticsDayKey();
  const today = store.days[todayKey] || createAnalyticsDay(todayKey);
  const rollup = aggregateAnalyticsDays(dayKeys.map((key) => store.days[key]));
  return {
    deviceId: store.deviceId,
    deviceLabel: store.deviceLabel || '',
    firstSeenAt: store.firstSeenAt || null,
    lastEventAt: store.lastEventAt || null,
    lastExportAt: store.lastExportAt || null,
    daysTracked: dayKeys.length,
    todayKey,
    today,
    rollup
  };
}

async function getAnalyticsExport(scope = 'pilot') {
  const store = await getAnalyticsStore();
  const dayKeys = Object.keys(store.days).sort();
  const todayKey = analyticsDayKey();
  const selectedKeys = scope === 'today'
    ? dayKeys.filter((key) => key === todayKey)
    : dayKeys;
  const selectedDays = Object.fromEntries(selectedKeys.map((key) => [key, store.days[key]]));
  return {
    exportedAt: new Date().toISOString(),
    scope,
    deviceId: store.deviceId,
    deviceLabel: store.deviceLabel || '',
    firstSeenAt: store.firstSeenAt || null,
    lastEventAt: store.lastEventAt || null,
    daysTracked: selectedKeys.length,
    days: selectedDays,
    rollup: aggregateAnalyticsDays(selectedKeys.map((key) => store.days[key]))
  };
}

async function setAnalyticsDeviceLabel(label) {
  return mutateAnalyticsStore((store) => {
    store.deviceLabel = trimAnalyticsLabel(label, 80);
  });
}

async function markAnalyticsExported() {
  return mutateAnalyticsStore((store) => {
    store.lastExportAt = new Date().toISOString();
  });
}

async function resetAnalyticsStore() {
  const fresh = createAnalyticsStore();
  await setStorage({ [ANALYTICS_STORAGE_KEY]: fresh });
  return fresh;
}

function normalizeSourceUrl(url) {
  const value = String(url || '').trim();
  if (!value) return DEFAULT_NVC_SOURCE_URL;
  const lower = value.toLowerCase();
  if (lower.includes('localhost') || lower.includes('127.0.0.1')) {
    return DEFAULT_NVC_SOURCE_URL;
  }
  return value;
}

async function sha256Hex(text) {
  const encoded = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setupAutoSyncAlarm() {
  chrome.alarms.create(AUTO_SYNC_ALARM_NAME, { periodInMinutes: AUTO_SYNC_INTERVAL_MINUTES });
}

async function ensureDefaultSourceUrl() {
  const stored = await getStorage([STORAGE_KEYS.sourceUrl]);
  const normalized = normalizeSourceUrl(stored[STORAGE_KEYS.sourceUrl]);
  if (stored[STORAGE_KEYS.sourceUrl] !== normalized) {
    await setStorage({ [STORAGE_KEYS.sourceUrl]: normalized });
  }
}

async function initializeNVCSync() {
  setupAutoSyncAlarm();
  await ensureDefaultSourceUrl();
  await loadNVCBundle();
  maybeAutoRefreshNVCBundle('startup');
}

function validateBundleShape(data) {
  return !!(data && typeof data === 'object' && Array.isArray(data.entry));
}

function applyBundleData(data, source) {
  if (!validateBundleShape(data)) {
    throw new Error('Bundle JSON is invalid: expected object with entry[]');
  }
  nvcBundle = data;
  buildNVCIndexes();
  bgLog('NVC bundle applied from source:', source);
}

function loadNVCBundle(forceReload = false) {
  if (bundleLoadPromise && !forceReload) {
    return bundleLoadPromise;
  }

  bundleLoadPromise = getStorage([STORAGE_KEYS.bundle, STORAGE_KEYS.sourceUrl])
    .then((stored) => {
      if (stored[STORAGE_KEYS.bundle]) {
        applyBundleData(stored[STORAGE_KEYS.bundle], stored[STORAGE_KEYS.sourceUrl] || 'storage');
        return true;
      }
      return fetch(chrome.runtime.getURL('nvc_bundle.json'))
        .then(response => response.json())
        .then(data => {
          applyBundleData(data, 'packaged');
          return true;
        });
    })
    .catch(error => {
      console.error('Failed to load NVC bundle:', error);
      return false;
    });

  return bundleLoadPromise;
}

async function fetchJsonWithHeaders(url) {
  const response = await fetch(url, { cache: 'no-store', headers: NVC_FETCH_HEADERS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function refreshNVCBundleFromUrl(sourceUrl, options = {}) {
  const effectiveSourceUrl = normalizeSourceUrl(sourceUrl || DEFAULT_NVC_SOURCE_URL);
  if (!effectiveSourceUrl) {
    return { success: false, error: 'No valid NVC source URL available' };
  }

  const force = !!options.force;
  const trigger = options.trigger === 'manual' ? 'manual' : 'auto';
  try {
    const nowIso = new Date().toISOString();
    const stored = await getStorage([STORAGE_KEYS.bundleSha256, STORAGE_KEYS.updatedAt]);
    const previousHash = stored[STORAGE_KEYS.bundleSha256];

    const firstPayload = await fetchJsonWithHeaders(effectiveSourceUrl);
    let metadata = null;
    let bundle = null;
    let bundleUrl = effectiveSourceUrl;

    if (validateBundleShape(firstPayload)) {
      bundle = firstPayload;
    } else if (firstPayload && typeof firstPayload === 'object' && firstPayload.bundleUrl) {
      metadata = firstPayload;
      bundleUrl = String(metadata.bundleUrl).trim();
      if (!bundleUrl) {
        throw new Error('Metadata is missing a valid bundleUrl');
      }

      if (!force && metadata.sha256 && previousHash && String(metadata.sha256).toLowerCase() === String(previousHash).toLowerCase()) {
        await setStorage({ [STORAGE_KEYS.lastCheckAt]: nowIso });
        const result = {
          success: true,
          unchanged: true,
          sourceUrl: effectiveSourceUrl,
          updatedAt: stored[STORAGE_KEYS.updatedAt] || metadata.updatedAt || nowIso
        };
        await logAnalyticsEvent('nvc_refresh_result', { trigger, success: true, note: 'unchanged' });
        return result;
      }

      bundle = await fetchJsonWithHeaders(bundleUrl);
    } else {
      throw new Error('Expected either an NVC bundle or metadata with bundleUrl');
    }

    if (!validateBundleShape(bundle)) {
      throw new Error('Bundle JSON is invalid: expected object with entry[]');
    }

    const bundleText = JSON.stringify(bundle);
    const computedSha256 = await sha256Hex(bundleText);
    if (metadata && metadata.sha256 && String(metadata.sha256).toLowerCase() !== computedSha256.toLowerCase()) {
      throw new Error('Bundle checksum verification failed');
    }

    applyBundleData(bundle, bundleUrl);
    const updatedAt = (metadata && metadata.updatedAt) ? metadata.updatedAt : nowIso;
    await setStorage({
      [STORAGE_KEYS.bundle]: bundle,
      [STORAGE_KEYS.sourceUrl]: effectiveSourceUrl,
      [STORAGE_KEYS.bundleSha256]: computedSha256,
      [STORAGE_KEYS.lastCheckAt]: nowIso,
      [STORAGE_KEYS.metaVersion]: metadata ? (metadata.version || null) : null,
      [STORAGE_KEYS.updatedAt]: updatedAt
    });

    const result = {
      success: true,
      sourceUrl: effectiveSourceUrl,
      bundleUrl,
      updatedAt,
      checkedAt: nowIso,
      entryCount: bundle.entry.length,
      sha256: computedSha256,
      version: metadata ? (metadata.version || null) : null
    };
    await logAnalyticsEvent('nvc_refresh_result', { trigger, success: true });
    return result;
  } catch (error) {
    console.error('Failed to refresh NVC bundle:', error);
    await logAnalyticsEvent('nvc_refresh_result', { trigger, success: false, note: error.message });
    return { success: false, error: error.message };
  }
}

async function maybeAutoRefreshNVCBundle(trigger) {
  try {
    const stored = await getStorage([STORAGE_KEYS.sourceUrl, STORAGE_KEYS.lastCheckAt]);
    const sourceUrl = normalizeSourceUrl(stored[STORAGE_KEYS.sourceUrl]);
    const lastCheckAt = stored[STORAGE_KEYS.lastCheckAt];
    const now = Date.now();
    const last = lastCheckAt ? Date.parse(lastCheckAt) : 0;
    const intervalMs = AUTO_SYNC_INTERVAL_MINUTES * 60 * 1000;

    if (last && (now - last) < intervalMs) {
      return { success: true, skipped: true, reason: 'interval_not_elapsed' };
    }

    const result = await refreshNVCBundleFromUrl(sourceUrl, { force: false, trigger });
    if (!result.success) {
      console.warn('Auto NVC refresh failed; using existing bundle:', result.error);
    }
    return result;
  } catch (error) {
    console.error('Auto refresh process failed:', error);
    return { success: false, error: error.message };
  }
}

async function getNVCUpdateStatus() {
  const stored = await getStorage([
    STORAGE_KEYS.sourceUrl,
    STORAGE_KEYS.updatedAt,
    STORAGE_KEYS.lastCheckAt,
    STORAGE_KEYS.bundleSha256,
    STORAGE_KEYS.metaVersion
  ]);

  return {
    sourceUrl: normalizeSourceUrl(stored[STORAGE_KEYS.sourceUrl]),
    updatedAt: stored[STORAGE_KEYS.updatedAt] || null,
    lastCheckAt: stored[STORAGE_KEYS.lastCheckAt] || null,
    sha256: stored[STORAGE_KEYS.bundleSha256] || null,
    version: stored[STORAGE_KEYS.metaVersion] || null,
    autoSyncIntervalMinutes: AUTO_SYNC_INTERVAL_MINUTES
  };
}

function buildNVCIndexes() {
  bgLog('buildNVCIndexes called');
  if (!nvcBundle || !nvcBundle.entry) {
    console.error('nvcBundle not loaded or no entries');
    return;
  }
  
  bgLog('nvcBundle has', nvcBundle.entry.length, 'entries');
  
  const tradenames = collectTradenameConceptsFromBundle();
  const lots = collectLotConceptsFromBundle();
  const lotAgentRows = collectLotAgentMappingRowsFromBundle();
  
  bgLog('Collected', tradenames.length, 'tradename concepts');
  bgLog('Collected', lots.length, 'lot concepts');
  bgLog('Collected', lotAgentRows.length, 'lot-agent mapping rows');
  
  // Index tradenames by code and by DIN
  const tradenameByCode = {};
  const tradenameByDin = {};
  const tradenameByName = {};
  
  for (const concept of tradenames) {
    const codeKey = normalizeCodeKey(concept.code);
    if (codeKey) {
      const existingByCode = tradenameByCode[codeKey];
      if (!existingByCode || conceptRichness(concept) >= conceptRichness(existingByCode)) {
        tradenameByCode[codeKey] = concept;
      }
    }
    const din = extractTradenameDIN(concept);
    const dinKey = normalizeDinKey(din);
    if (dinKey) {
      const existingByDin = tradenameByDin[dinKey];
      if (!existingByDin || conceptRichness(concept) >= conceptRichness(existingByDin)) {
        tradenameByDin[dinKey] = concept;
      }
    }
    indexTradenameNames(tradenameByName, concept);
  }
  
  bgLog('Indexed', Object.keys(tradenameByCode).length, 'tradenames by code');
  bgLog('Indexed', Object.keys(tradenameByDin).length, 'tradenames by DIN');
  bgLog('Indexed', Object.keys(tradenameByName).length, 'tradenames by name');
  
  // Index lots by lot number and by code
  const lotByLotNumber = {};
  const lotByCode = {};
  const lotByCodePrefix = {};
  
  for (const concept of lots) {
    const code = concept.code;
    if (code) {
      const codeKey = code.toLowerCase();
      lotByCode[codeKey] = concept;
      const underscoreIdx = codeKey.indexOf('_');
      const prefix = underscoreIdx > 0 ? codeKey.substring(0, underscoreIdx) : codeKey;
      if (prefix && !lotByCodePrefix[prefix]) {
        lotByCodePrefix[prefix] = concept;
      }
    }
    const lotNumber = extractLotNumber(concept);
    if (lotNumber) {
      lotByLotNumber[lotNumber.toLowerCase()] = concept;
    }
  }
  
  bgLog('Indexed', Object.keys(lotByLotNumber).length, 'lots by lot number');
  bgLog('Indexed', Object.keys(lotByCode).length, 'lots by code');
  const lotAgentMappingByLot = buildLotAgentMappingIndex(lotAgentRows);
  bgLog('Indexed', Object.keys(lotAgentMappingByLot).length, 'lot-agent mappings by lot key');
  
  nvcIndexes = {
    tradenameByCode,
    tradenameByDin,
    tradenameByName,
    tradenameConceptsArray: tradenames,
    lotByLotNumber,
    lotByCode,
    lotByCodePrefix,
    lotAgentMappingByLot
  };
  
  bgLog('NVC Indexes built successfully');
}

function collectTradenameConceptsFromBundle() {
  const concepts = [];
  if (!nvcBundle.entry) return concepts;
  
  for (const entry of nvcBundle.entry) {
    const resource = entry.resource;
    if (!resource || !resource.resourceType) continue;
    if (resource.resourceType === 'ValueSet' && resource.id === 'Tradename') {
      for (const include of resource.compose?.include || []) {
        concepts.push(...(include.concept || []));
      }
      for (const item of resource.expansion?.contains || []) {
        concepts.push(item);
      }
    } else if (resource.resourceType === 'CodeSystem') {
      const idKey = normalizeCodeKey(resource.id);
      const titleKey = normalizeCodeKey(resource.title);
      const nameKey = normalizeCodeKey(resource.name);
      const urlKey = normalizeCodeKey(resource.url);
      const looksLikeTradename =
        idKey.includes('tradename') ||
        titleKey.includes('tradename') ||
        nameKey.includes('tradename') ||
        urlKey.includes('tradename');
      if (looksLikeTradename) {
        concepts.push(...(resource.concept || []));
      }
    }
  }
  return concepts;
}

function collectLotConceptsFromBundle() {
  const concepts = [];
  if (!nvcBundle.entry) return concepts;
  
  for (const entry of nvcBundle.entry) {
    const resource = entry.resource;
    if (resource.resourceType === 'CodeSystem' && resource.id === 'nvc-vaccine-lot-id') {
      concepts.push(...(resource.concept || []));
    }
  }
  return concepts;
}

function collectLotAgentMappingRowsFromBundle() {
  const rows = [];
  if (!nvcBundle.entry) return rows;

  for (const entry of nvcBundle.entry) {
    const resource = entry.resource;
    if (!resource || !resource.resourceType) continue;
    const identity = normalizeCodeKey([
      resource.id,
      resource.name,
      resource.title,
      resource.url
    ].filter(Boolean).join(' '));
    if (!identity.includes('lotagentmapping')) {
      continue;
    }

    if (resource.resourceType === 'CodeSystem') {
      for (const concept of resource.concept || []) {
        rows.push({ concept, sourceType: 'codesystem' });
      }
      continue;
    }

    if (resource.resourceType === 'ValueSet') {
      for (const include of resource.compose?.include || []) {
        for (const concept of include.concept || []) {
          rows.push({ concept, sourceType: 'valueset-compose' });
        }
      }
      for (const concept of resource.expansion?.contains || []) {
        rows.push({ concept, sourceType: 'valueset-expansion' });
      }
    }
  }
  return rows;
}

function normalizeLotMapKey(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function readPropertyScalar(prop) {
  if (!prop || typeof prop !== 'object') return '';
  if (prop.valueString !== undefined) return String(prop.valueString);
  if (prop.valueCode !== undefined) return String(prop.valueCode);
  if (prop.valueDateTime !== undefined) return String(prop.valueDateTime);
  if (prop.valueInteger !== undefined) return String(prop.valueInteger);
  if (prop.valueDecimal !== undefined) return String(prop.valueDecimal);
  if (prop.valueBoolean !== undefined) return String(prop.valueBoolean);
  if (prop.valueCoding) return prop.valueCoding.display || prop.valueCoding.code || '';
  if (prop.valueCodeableConcept) return extractCodeableConceptDisplay(prop.valueCodeableConcept) || '';
  return '';
}

function normalizeMappingPropKey(value) {
  return normalizeCodeKey(value).replace(/[^a-z0-9]/g, '');
}

function parseLotAgentMappingConcept(concept) {
  if (!concept || typeof concept !== 'object') {
    return null;
  }

  const lotKeys = [];
  const addLotKey = (value) => {
    const key = normalizeLotMapKey(value);
    if (!key) return;
    if (!lotKeys.includes(key)) lotKeys.push(key);
  };

  const mapped = {
    tradename: '',
    generic_name: '',
    disease: '',
    antigen: '',
    manufacturer: '',
    route: '',
    strength: '',
    dose_value: '',
    dose_unit: '',
    din: ''
  };

  addLotKey(concept.code || '');
  if (!mapped.tradename && concept.display) {
    mapped.tradename = concept.display;
  }

  for (const prop of concept.property || []) {
    const key = normalizeMappingPropKey(prop.code);
    const value = readPropertyScalar(prop);
    if (!key || !value) continue;

    if ((key.includes('source') || key.includes('lot')) && key.includes('lot')) {
      addLotKey(value);
    }

    if (key.includes('target') && key.includes('tradename')) mapped.tradename = value;
    else if (key.includes('tradename') && !mapped.tradename) mapped.tradename = value;
    else if (key.includes('generic')) mapped.generic_name = value;
    else if (key.includes('disease')) mapped.disease = value;
    else if (key.includes('antigen')) mapped.antigen = value;
    else if (key.includes('manufacturer')) mapped.manufacturer = value;
    else if (key.includes('route')) mapped.route = value;
    else if (key.includes('strength')) mapped.strength = value;
    else if (key.includes('dose') && (key.includes('unit') || key.includes('uom'))) mapped.dose_unit = value;
    else if (key.includes('dose')) mapped.dose_value = value;
    else if (key === 'din' || key.includes('drugidentificationnumber')) mapped.din = value;
  }

  if (!lotKeys.length) {
    return null;
  }

  return { lotKeys, mapped };
}

function buildLotAgentMappingIndex(rows) {
  const index = {};
  for (const row of rows || []) {
    const parsed = parseLotAgentMappingConcept(row?.concept);
    if (!parsed) continue;
    for (const lotKey of parsed.lotKeys) {
      if (!index[lotKey]) {
        index[lotKey] = { ...parsed.mapped };
        continue;
      }
      mergeDefinedVaccineFields(index[lotKey], parsed.mapped);
      if (parsed.mapped.din && !index[lotKey].din) {
        index[lotKey].din = parsed.mapped.din;
      }
    }
  }
  return index;
}

function extractLotNumber(concept) {
  for (const prop of concept.property || []) {
    if (prop.code === 'lotNumber') {
      return prop.valueString;
    }
  }
  return null;
}

function extractLotDIN(concept) {
  for (const prop of concept.property || []) {
    if (prop.code === 'drugIdentificationNumber') {
      const valueCoding = prop.valueCoding;
      if (valueCoding) {
        return valueCoding.code || valueCoding.display || null;
      }
      if (prop.valueString) return prop.valueString;
      if (prop.valueCodeableConcept) return extractCodeableConceptDisplay(prop.valueCodeableConcept);
    }
  }
  return null;
}

function extractLotExpiry(concept) {
  for (const prop of concept.property || []) {
    if (prop.code === 'expiryDate' || prop.code === 'originalExpiryDate') {
      return prop.valueDateTime;
    }
  }
  return null;
}

function extractLotManufacturer(concept) {
  // First try extensions (market authorization holder)
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-linked-to-market-authorization-holder') {
      return extractCodeableConceptDisplay(ext.valueCodeableConcept);
    }
  }
  // Then try properties
  for (const prop of concept.property || []) {
    if (prop.code === 'manufacturer') {
      const valueCoding = prop.valueCoding;
      if (valueCoding) {
        return valueCoding.display || valueCoding.code;
      }
    }
  }
  return null;
}

function getLotTradenameReferences(concept) {
  const refs = [];
  for (const ext of concept.extension || []) {
    const url = normalizeCodeKey(ext.url);
    if (!url.includes('linked-tradename-concept') && !url.endsWith('/tradename')) {
      continue;
    }
    const cc = ext.valueCodeableConcept || null;
    const coding = cc?.coding?.[0] || null;
    refs.push({
      code: coding?.code || '',
      display: coding?.display || cc?.text || '',
      raw: cc?.text || ''
    });
  }

  for (const prop of concept.property || []) {
    const code = normalizeCodeKey(prop.code);
    if (code !== 'tradename' && code !== 'trade name' && code !== 'tradenamecode') {
      continue;
    }
    const coding = prop.valueCoding || prop.valueCodeableConcept?.coding?.[0] || null;
    refs.push({
      code: coding?.code || '',
      display: coding?.display || prop.valueCodeableConcept?.text || '',
      raw: prop.valueString || ''
    });
  }

  const seen = new Set();
  return refs.filter((ref) => {
    const key = [normalizeCodeKey(ref.code), normalizeNameKey(ref.display), normalizeNameKey(ref.raw)].join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractLotTradenameCode(concept) {
  const refs = getLotTradenameReferences(concept);
  const first = refs[0];
  return first ? (first.code || first.display || first.raw || null) : null;
}

function extractTradenameDIN(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-din') {
      const cc = ext.valueCodeableConcept;
      if (cc && cc.coding && cc.coding[0]) {
        return cc.coding[0].code || cc.coding[0].display;
      }
    }
  }
  for (const prop of concept.property || []) {
    const code = normalizeCodeKey(prop.code);
    if (code === 'drugidentificationnumber' || code === 'din') {
      if (prop.valueCoding) return prop.valueCoding.code || prop.valueCoding.display || null;
      if (prop.valueString) return prop.valueString;
      if (prop.valueCodeableConcept) return extractCodeableConceptDisplay(prop.valueCodeableConcept);
    }
  }
  return null;
}

function normalizeCodeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function conceptRichness(concept) {
  if (!concept || typeof concept !== 'object') return 0;
  const extCount = Array.isArray(concept.extension) ? concept.extension.length : 0;
  const propCount = Array.isArray(concept.property) ? concept.property.length : 0;
  const desigCount = Array.isArray(concept.designation) ? concept.designation.length : 0;
  const hasDisplay = concept.display ? 1 : 0;
  return (extCount * 4) + (propCount * 3) + (desigCount * 2) + hasDisplay;
}

function normalizeDinKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digitsOnly = raw.replace(/\D/g, '');
  if (digitsOnly) {
    return digitsOnly.replace(/^0+/, '') || '0';
  }
  return raw.toLowerCase();
}

function normalizeGtinKey(value) {
  const digitsOnly = String(value || '').replace(/\D/g, '');
  return digitsOnly || '';
}

function resolveTradenameCodeOverrideByGtin(gtin) {
  const gtinKey = normalizeGtinKey(gtin);
  if (!gtinKey) return '';
  return normalizeCodeKey(GTIN_TRADENAME_CODE_OVERRIDES[gtinKey] || '');
}

function normalizeNameKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function indexTradenameNames(map, concept) {
  const candidates = [];
  if (concept && concept.display) {
    candidates.push(concept.display);
  }
  for (const designation of (concept && concept.designation) || []) {
    if (designation && designation.value) {
      candidates.push(designation.value);
    }
  }
  for (const value of candidates) {
    const key = normalizeNameKey(value);
    if (!key) continue;
    const existing = map[key];
    if (!existing || conceptRichness(concept) >= conceptRichness(existing)) {
      map[key] = concept;
    }
  }
}

function mergeDefinedVaccineFields(target, source) {
  if (!source || typeof source !== 'object') return;
  const keys = ['tradename', 'generic_name', 'disease', 'antigen', 'manufacturer', 'route', 'strength', 'dose_value', 'dose_unit'];
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (!String(value).trim()) continue;
    target[key] = value;
  }
}

function extractLotDirectVaccineInfo(concept) {
  const refs = getLotTradenameReferences(concept);
  return {
    tradename: refs[0]?.display || refs[0]?.raw || '',
    generic_name: extractTradenameGeneric(concept) || '',
    disease: extractTradenameDisease(concept) || '',
    antigen: extractTradenameAntigen(concept) || '',
    route: extractTradenameRoute(concept) || '',
    strength: extractTradenameStrength(concept) || '',
    dose_value: extractTradenameDoseValue(concept) || '',
    dose_unit: extractTradenameDoseUnit(concept) || ''
  };
}

function extractTrademenameDisplay(concept) {
  // Look for enPublicPicklist designation
  for (const designation of concept.designation || []) {
    const use = designation.use || {};
    if (use.code === 'enPublicPicklist') {
      return designation.value;
    }
  }
  return concept.display;
}

function extractTradenameGeneric(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-linked-generic-concept') {
      const cc = ext.valueCodeableConcept;
      if (cc && cc.coding && cc.coding[0]) {
        return cc.coding[0].display || cc.coding[0].code;
      }
    }
  }
  return null;
}

function extractTradenameDisease(concept) {
  const diseases = [];
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-protects-against-disease') {
      const cc = ext.valueCodeableConcept;
      if (cc && cc.coding && cc.coding[0]) {
        const display = cc.coding[0].display || cc.coding[0].code;
        if (!diseases.includes(display)) {
          diseases.push(display);
        }
      }
    }
  }
  return diseases.length > 0 ? diseases.join(', ') : null;
}

function extractTradenameAntigen(concept) {
  const values = [];
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-contains-antigen') {
      const display = extractCodeableConceptDisplay(ext.valueCodeableConcept);
      if (display) {
        values.push(display);
      }
    }
  }
  // Remove duplicates and join
  const uniqueValues = [...new Set(values)];
  return uniqueValues.length > 0 ? uniqueValues.join(', ') : null;
}

function extractTradenameManufacturer(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-linked-to-market-authorization-holder') {
      return extractCodeableConceptDisplay(ext.valueCodeableConcept);
    }
  }
  return null;
}

function extractTradenameRoute(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-route-of-admin') {
      return extractCodeableConceptDisplay(ext.valueCodeableConcept);
    }
  }
  return null;
}

function collectTradenameStringValues(concept, extensionUrl) {
  const values = [];
  for (const ext of concept.extension || []) {
    if (ext.url !== extensionUrl) continue;
    const raw = String(ext.valueString || '').trim();
    if (!raw) continue;
    if (!values.includes(raw)) {
      values.push(raw);
    }
  }
  return values;
}

function extractStrengthFromTradenameDisplay(concept) {
  const display = String(concept?.display || '').trim();
  if (!display) return null;
  const match = display.match(/(\d+(?:\.\d+)?)\s*(?:microgram|micrograms|mcg)\b/i);
  return match ? match[1] : null;
}

function extractTradenameStrength(concept) {
  const values = collectTradenameStringValues(
    concept,
    'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-strength'
  );
  if (!values.length) {
    return extractStrengthFromTradenameDisplay(concept);
  }
  if (values.length === 1) {
    return values[0];
  }

  const fromDisplay = extractStrengthFromTradenameDisplay(concept);
  if (fromDisplay) {
    for (const value of values) {
      if (value === fromDisplay) {
        return value;
      }
    }
    return fromDisplay;
  }
  return values[0];
}

function extractTradenameDoseValue(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-typical-dose-size') {
      return ext.valueString || null;
    }
  }
  return null;
}

function extractTradenameDoseUnit(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-typical-dose-size-uom') {
      return ext.valueString || null;
    }
  }
  return null;
}

function extractCodeableConceptDisplay(cc) {
  if (!cc) return null;
  const coding = cc.coding || [];
  if (coding.length > 0 && coding[0].display) {
    return coding[0].display;
  }
  if (coding.length > 0 && coding[0].code) {
    return coding[0].code;
  }
  return cc.text || null;
}

function looksLikeGtinOrNumericId(key) {
  const k = String(key || '').trim();
  return /^\d{8,14}$/.test(k);
}

function lookupVaccineLot(lotNumber, options = {}) {
  if (!lotNumber) {
    bgLog('lookupVaccineLot: no lot number provided');
    return null;
  }
  
  bgLog('lookupVaccineLot: Looking up lot:', lotNumber);
  
  try {
    const lotKey = String(lotNumber).trim().toLowerCase();
    if (!lotKey) {
      return null;
    }
    
    // Try to find by lot number first
    let concept = nvcIndexes.lotByLotNumber[lotKey];
    
    // If not found, try direct code then prefix map (O(1)).
    // Skip code/prefix for all-numeric keys (GTIN mistaken for lot -> wrong hit).
    if (!concept && !looksLikeGtinOrNumericId(lotKey)) {
      concept = nvcIndexes.lotByCode[lotKey] || nvcIndexes.lotByCodePrefix[lotKey];
    }
    
    if (!concept) {
      bgLog('No matching lot found for:', lotNumber);
      return null;
    }
    
    // Extract vaccine info from lot concept
    const vaccineInfo = {
      lot_number: extractLotNumber(concept) || lotNumber,
      lot_expiry: extractLotExpiry(concept),
      din: extractLotDIN(concept),
      manufacturer: extractLotManufacturer(concept)
    };

    const lotMapKey = normalizeLotMapKey(vaccineInfo.lot_number || lotNumber);
    const lotCodeMapKey = normalizeLotMapKey(concept.code || '');
    const lotAgentMappedInfo =
      nvcIndexes.lotAgentMappingByLot?.[lotMapKey] ||
      nvcIndexes.lotAgentMappingByLot?.[lotCodeMapKey] ||
      null;
    if (lotAgentMappedInfo) {
      bgLog('Lot-agent mapping matched:', { lotMapKey, lotCodeMapKey, lotAgentMappedInfo });
      mergeDefinedVaccineFields(vaccineInfo, lotAgentMappedInfo);
      if (!vaccineInfo.din && lotAgentMappedInfo.din) {
        vaccineInfo.din = lotAgentMappedInfo.din;
      }
    }

    mergeDefinedVaccineFields(vaccineInfo, extractLotDirectVaccineInfo(concept));
    
    bgLog('Extracted from lot concept:', vaccineInfo);
    
    // Get tradename info
    const tradenameRefs = getLotTradenameReferences(concept);
    bgLog('Lot tradename references:', tradenameRefs);
    const gtinOverrideCode = resolveTradenameCodeOverrideByGtin(options.gtin);
    const byCodeCandidates = [];
    let resolvedTradename = null;
    for (const ref of tradenameRefs) {
      if (!ref.code) continue;
      const info = lookupTradenameByCode(ref.code);
      if (info) {
        byCodeCandidates.push({ ref, info });
      }
    }

    if (gtinOverrideCode && byCodeCandidates.length > 0) {
      const overrideMatch = byCodeCandidates.find(({ ref }) => normalizeCodeKey(ref.code) === gtinOverrideCode);
      if (overrideMatch) {
        resolvedTradename = overrideMatch.info;
        bgLog('Tradename resolved from GTIN override:', options.gtin, '->', overrideMatch.ref.code);
      }
    }

    if (!resolvedTradename && byCodeCandidates.length > 0) {
      resolvedTradename = byCodeCandidates[0].info;
      bgLog('Tradename resolved from first code reference:', byCodeCandidates[0].ref.code);
    }

    if (!resolvedTradename) {
      for (const ref of tradenameRefs) {
        const label = ref.display || ref.raw || '';
        if (!label) continue;
        resolvedTradename = lookupTradenameByName(label);
        if (resolvedTradename) {
          bgLog('Tradename resolved from name reference:', label);
          break;
        }
      }
    }

    if (resolvedTradename) {
      mergeDefinedVaccineFields(vaccineInfo, resolvedTradename);
    } else if (vaccineInfo.din) {
      const tradenameInfo = lookupTradenameByDIN(vaccineInfo.din);
      bgLog('Tradename info from DIN:', tradenameInfo);
      if (tradenameInfo) {
        mergeDefinedVaccineFields(vaccineInfo, tradenameInfo);
      }
    }
    
    bgLog('Final vaccine info:', vaccineInfo);
    return vaccineInfo;
  } catch (e) {
    console.error('Error looking up vaccine lot:', e);
    return null;
  }
}

function lookupTradenameByCode(code) {
  const codeKey = normalizeCodeKey(code);
  const concept = nvcIndexes.tradenameByCode[codeKey];
  if (!concept) return null;
  
  return {
    tradename: extractTrademenameDisplay(concept),
    generic_name: extractTradenameGeneric(concept),
    disease: extractTradenameDisease(concept),
    antigen: extractTradenameAntigen(concept),
    manufacturer: extractTradenameManufacturer(concept),
    route: extractTradenameRoute(concept),
    strength: extractTradenameStrength(concept),
    dose_value: extractTradenameDoseValue(concept),
    dose_unit: extractTradenameDoseUnit(concept)
  };
}

function lookupTradenameByName(name) {
  const nameKey = normalizeNameKey(name);
  const concept = nvcIndexes.tradenameByName[nameKey];
  if (!concept) return null;
  return {
    tradename: extractTrademenameDisplay(concept),
    generic_name: extractTradenameGeneric(concept),
    disease: extractTradenameDisease(concept),
    antigen: extractTradenameAntigen(concept),
    manufacturer: extractTradenameManufacturer(concept),
    route: extractTradenameRoute(concept),
    strength: extractTradenameStrength(concept),
    dose_value: extractTradenameDoseValue(concept),
    dose_unit: extractTradenameDoseUnit(concept)
  };
}

function lookupTradenameByDIN(din) {
  const dinKey = normalizeDinKey(din);
  const concept = nvcIndexes.tradenameByDin[dinKey];
  if (!concept) return null;
  
  return {
    tradename: extractTrademenameDisplay(concept),
    generic_name: extractTradenameGeneric(concept),
    disease: extractTradenameDisease(concept),
    antigen: extractTradenameAntigen(concept),
    manufacturer: extractTradenameManufacturer(concept),
    route: extractTradenameRoute(concept),
    strength: extractTradenameStrength(concept),
    dose_value: extractTradenameDoseValue(concept),
    dose_unit: extractTradenameDoseUnit(concept)
  };
}

// Listen for requests from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  bgLog('Background received message:', request);
  if (request.action === 'refreshNVCBundle') {
    const requestedSource = (request.sourceUrl || '').trim();
    const sourceUrl = normalizeSourceUrl(requestedSource || DEFAULT_NVC_SOURCE_URL);
    refreshNVCBundleFromUrl(sourceUrl, { force: true, trigger: 'manual' }).then(sendResponse);
    return true;
  }

  if (request.action === 'getNVCUpdateStatus') {
    getNVCUpdateStatus().then(sendResponse);
    return true;
  }

  if (request.action === 'checkNVCBundleUpdates') {
    maybeAutoRefreshNVCBundle('manual_check').then(sendResponse);
    return true;
  }

  if (request.action === 'lookupVaccineInfo') {
    bgLog('Looking up vaccine info for lot:', request.lot, 'gtin:', request.gtin || '');

    Promise.resolve(bundleLoadPromise || loadNVCBundle())
      .then((loaded) => {
        if (loaded === false) {
          return { error: 'Failed to load NVC database' };
        }

        const vaccineInfo = lookupVaccineLot(request.lot, { gtin: request.gtin });
        bgLog('Lookup result:', vaccineInfo);

        if (vaccineInfo) {
          return vaccineInfo;
        }

        return { error: 'Vaccine not found in NVC database' };
      })
      .catch((error) => {
        console.error('Lookup pipeline failed:', error);
        return { error: error?.message || 'Failed to load NVC database' };
      })
      .then((response) => {
        sendResponse(response);
      });

    return true;
  }

  if (request.action === 'logAnalyticsEvent') {
    logAnalyticsEvent(request.eventType, request.payload || {})
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics log failed' }));
    return true;
  }

  if (request.action === 'appendQueueRecord') {
    appendQueueRecord(request.storageKey || '', request.record || null)
      .then((record) => sendResponse({ success: true, record }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Queue append failed' }));
    return true;
  }

  if (request.action === 'getAnalyticsSummary') {
    getAnalyticsSummary()
      .then((summary) => sendResponse({ success: true, summary }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics summary failed' }));
    return true;
  }

  if (request.action === 'getAnalyticsExport') {
    getAnalyticsExport(request.scope === 'today' ? 'today' : 'pilot')
      .then((data) => markAnalyticsExported().then(() => sendResponse({ success: true, data })))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics export failed' }));
    return true;
  }

  if (request.action === 'setAnalyticsDeviceLabel') {
    setAnalyticsDeviceLabel(request.label || '')
      .then(() => getAnalyticsSummary())
      .then((summary) => sendResponse({ success: true, summary }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics label update failed' }));
    return true;
  }

  if (request.action === 'resetAnalyticsStore') {
    resetAnalyticsStore()
      .then(() => getAnalyticsSummary())
      .then((summary) => sendResponse({ success: true, summary }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics reset failed' }));
    return true;
  }

  sendResponse({ success: false, error: `Unknown background action: ${request?.action || 'missing'}` });
  return false;
});
