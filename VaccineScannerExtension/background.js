let nvcBundle = null;
let nvcIndexes = {};
let bundleLoadPromise = null;
const DEFAULT_NVC_SOURCE_URL = 'https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC';
const AUTO_SYNC_INTERVAL_MINUTES = 24 * 60;
const AUTO_SYNC_ALARM_NAME = 'nvc-auto-sync';
const NVC_FETCH_HEADERS = {
  Accept: 'application/json+fhir',
  'x-app-desc': 'PHAC NVC Client'
};
const STORAGE_KEYS = {
  bundle: 'nvc_bundle_override',
  sourceUrl: 'nvc_bundle_source_url',
  updatedAt: 'nvc_bundle_updated_at',
  lastCheckAt: 'nvc_bundle_last_check_at',
  bundleSha256: 'nvc_bundle_sha256',
  metaVersion: 'nvc_bundle_meta_version'
};

// Load NVC bundle on installation/startup
chrome.runtime.onInstalled.addListener(() => {
  console.log('Vaccine Scanner extension installed');
  initializeNVCSync();
});

// Also load on startup
chrome.runtime.onStartup.addListener(() => {
  initializeNVCSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === AUTO_SYNC_ALARM_NAME) {
    maybeAutoRefreshNVCBundle('alarm');
  }
});

// Load immediately when service worker starts
console.log('Service worker started, loading NVC bundle');
initializeNVCSync();

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
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
  console.log('NVC bundle applied from source:', source);
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
        return {
          success: true,
          unchanged: true,
          sourceUrl: effectiveSourceUrl,
          updatedAt: stored[STORAGE_KEYS.updatedAt] || metadata.updatedAt || nowIso
        };
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

    return {
      success: true,
      sourceUrl: effectiveSourceUrl,
      bundleUrl,
      updatedAt,
      checkedAt: nowIso,
      entryCount: bundle.entry.length,
      sha256: computedSha256,
      version: metadata ? (metadata.version || null) : null
    };
  } catch (error) {
    console.error('Failed to refresh NVC bundle:', error);
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
  console.log('buildNVCIndexes called');
  if (!nvcBundle || !nvcBundle.entry) {
    console.error('nvcBundle not loaded or no entries');
    return;
  }
  
  console.log('nvcBundle has', nvcBundle.entry.length, 'entries');
  
  const tradenames = collectTradenameConceptsFromBundle();
  const lots = collectLotConceptsFromBundle();
  
  console.log('Collected', tradenames.length, 'tradename concepts');
  console.log('Collected', lots.length, 'lot concepts');
  
  // Index tradenames by code and by DIN
  const tradenameByCode = {};
  const tradenameByDin = {};
  
  for (const concept of tradenames) {
    const code = concept.code;
    if (code) {
      tradenameByCode[code] = concept;
    }
    const din = extractTradenameDIN(concept);
    if (din && !tradenameByDin[din]) {
      tradenameByDin[din] = concept;
    }
  }
  
  console.log('Indexed', Object.keys(tradenameByCode).length, 'tradenames by code');
  console.log('Indexed', Object.keys(tradenameByDin).length, 'tradenames by DIN');
  
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
  
  console.log('Indexed', Object.keys(lotByLotNumber).length, 'lots by lot number');
  console.log('Indexed', Object.keys(lotByCode).length, 'lots by code');
  
  nvcIndexes = {
    tradenameByCode,
    tradenameByDin,
    tradenameConceptsArray: tradenames,
    lotByLotNumber,
    lotByCode,
    lotByCodePrefix
  };
  
  console.log('NVC Indexes built successfully');
}

function collectTradenameConceptsFromBundle() {
  const concepts = [];
  if (!nvcBundle.entry) return concepts;
  
  for (const entry of nvcBundle.entry) {
    const resource = entry.resource;
    if (resource.resourceType === 'ValueSet' && resource.id === 'Tradename') {
      for (const include of resource.compose?.include || []) {
        concepts.push(...(include.concept || []));
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
        return valueCoding.code;
      }
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

function extractLotTradenameCode(concept) {
  for (const prop of concept.property || []) {
    if (prop.code === 'tradename') {
      const valueCoding = prop.valueCoding;
      if (valueCoding) {
        return valueCoding.code;
      }
    }
  }
  return null;
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
  return null;
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

function extractTradenameStrength(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-strength') {
      return ext.valueString || null;
    }
  }
  return null;
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

function lookupVaccineLot(lotNumber) {
  if (!lotNumber) {
    console.log('lookupVaccineLot: no lot number provided');
    return null;
  }
  
  console.log('lookupVaccineLot: Looking up lot:', lotNumber);
  
  try {
    const lotKey = String(lotNumber).trim().toLowerCase();
    if (!lotKey) {
      return null;
    }
    
    // Try to find by lot number first
    let concept = nvcIndexes.lotByLotNumber[lotKey];
    
    // If not found, try direct code then prefix map (O(1)).
    if (!concept) {
      concept = nvcIndexes.lotByCode[lotKey] || nvcIndexes.lotByCodePrefix[lotKey];
    }
    
    if (!concept) {
      console.log('No matching lot found for:', lotNumber);
      return null;
    }
    
    // Extract vaccine info from lot concept
    const vaccineInfo = {
      lot_number: extractLotNumber(concept) || lotNumber,
      lot_expiry: extractLotExpiry(concept),
      din: extractLotDIN(concept),
      manufacturer: extractLotManufacturer(concept)
    };
    
    console.log('Extracted from lot concept:', vaccineInfo);
    
    // Get tradename info
    const tradenameSnomedCode = extractLotTradenameCode(concept);
    console.log('Tradename SNOMED code:', tradenameSnomedCode);
    
    if (tradenameSnomedCode) {
      const tradenameInfo = lookupTradenameByCode(tradenameSnomedCode);
      console.log('Tradename info from code:', tradenameInfo);
      if (tradenameInfo) {
        Object.assign(vaccineInfo, tradenameInfo);
      }
    } else if (vaccineInfo.din) {
      const tradenameInfo = lookupTradenameByDIN(vaccineInfo.din);
      console.log('Tradename info from DIN:', tradenameInfo);
      if (tradenameInfo) {
        Object.assign(vaccineInfo, tradenameInfo);
      }
    }
    
    console.log('Final vaccine info:', vaccineInfo);
    return vaccineInfo;
  } catch (e) {
    console.error('Error looking up vaccine lot:', e);
    return null;
  }
}

function lookupTradenameByCode(code) {
  const concept = nvcIndexes.tradenameByCode[code];
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
  const concept = nvcIndexes.tradenameByDin[din];
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
  console.log('Background received message:', request);
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
    console.log('Looking up vaccine info for lot:', request.lot);
    
    // Wait for bundle to load if not ready yet
    if (!nvcIndexes.lotByLotNumber || !nvcIndexes.lotByCode) {
      console.log('Indexes not ready, waiting for bundle load...');
      bundleLoadPromise.then(() => {
        const vaccineInfo = lookupVaccineLot(request.lot);
        console.log('Lookup result:', vaccineInfo);
        
        if (vaccineInfo) {
          sendResponse(vaccineInfo);
        } else {
          sendResponse({ error: 'Vaccine not found in NVC database' });
        }
      }).catch(error => {
        console.error('Bundle load failed:', error);
        sendResponse({ error: 'Failed to load NVC database' });
      });
      return true;
    }
    
    // Look up by lot number instead of GTIN
    const vaccineInfo = lookupVaccineLot(request.lot);
    console.log('Lookup result:', vaccineInfo);
    
    if (vaccineInfo) {
      sendResponse(vaccineInfo);
    } else {
      sendResponse({ error: 'Vaccine not found in NVC database' });
    }
    return true;
  }
});
