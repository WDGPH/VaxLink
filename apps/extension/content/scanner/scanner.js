// Part of VaxLink content-script bundle. Classic script (no ES imports);
// all content files share one global lexical scope, loaded in manifest order.


function resetScannerBuffer() {
  if (scannerIdleTimer) {
    clearTimeout(scannerIdleTimer);
    scannerIdleTimer = null;
  }
  if (scannerInputTimer) {
    clearTimeout(scannerInputTimer);
    scannerInputTimer = null;
  }
  scannerBuffer = '';
  scannerStartedAt = 0;
  scannerLastAt = 0;
}

function isTextEntryElement(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = String(el.type || '').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file'].includes(type);
  }
  return !!el.isContentEditable;
}

function isLikelyScannerSequence() {
  const value = String(scannerBuffer || '');
  if (value.length < SCAN_MIN_LENGTH) return false;
  if (!scannerStartedAt || !scannerLastAt) return false;
  const duration = scannerLastAt - scannerStartedAt;
  if (duration < 0 || duration > SCAN_MAX_DURATION_MS) return false;
  const avgInterval = duration / Math.max(value.length - 1, 1);
  return avgInterval <= SCAN_MAX_AVG_INTERVAL_MS;
}

function parseScannerDate(yymmdd) {
  if (!yymmdd || yymmdd.length !== 6) return null;
  const yy = yymmdd.substring(0, 2);
  const mm = yymmdd.substring(2, 4);
  let dd = yymmdd.substring(4, 6);
  // GS1 allows day "00" meaning "last day of the month" — resolve it here so
  // downstream date math doesn't roll back into the previous month.
  if (dd === '00') {
    const lastDay = new Date(Number(`20${yy}`), Number(mm), 0).getDate();
    dd = String(lastDay).padStart(2, '0');
  }
  return `${mm}/${dd}/20${yy}`;
}

function parseScannerIsLikelyAIStart(s, idx) {
  if (idx < 0 || idx > s.length - 2) return false;
  const ai = s.substring(idx, idx + 2);
  if (ai === '17') {
    if (idx + 8 > s.length) return false;
    return /^\d{6}$/.test(s.substring(idx + 2, idx + 8));
  }
  return ai === '10' || ai === '21';
}

function parseScannerCanParseTailNoGS(s, idx, memo) {
  if (idx >= s.length) return true;
  if (memo.has(idx)) return memo.get(idx);

  let ok = false;
  const ai = s.substring(idx, idx + 2);
  if (ai === '17') {
    ok = idx + 8 <= s.length &&
      /^\d{6}$/.test(s.substring(idx + 2, idx + 8)) &&
      parseScannerCanParseTailNoGS(s, idx + 8, memo);
  } else if (ai === '10' || ai === '21') {
    const valueStart = idx + 2;
    if (valueStart < s.length) {
      const next = parseScannerFindNextAINoGS(s, valueStart, memo, ai);
      ok = next === -1 ? true : (next > valueStart && parseScannerCanParseTailNoGS(s, next, memo));
    }
  } else {
    ok = false;
  }

  memo.set(idx, ok);
  return ok;
}

function parseScannerFindNextAINoGS(s, startIdx, memo, currentVariableAI = null) {
  for (let i = startIdx + 1; i < s.length - 1; i++) {
    if (!parseScannerIsLikelyAIStart(s, i)) continue;
    const candidateAI = s.substring(i, i + 2);
    if (currentVariableAI && candidateAI === currentVariableAI) continue;
    if (parseScannerCanParseTailNoGS(s, i, memo)) {
      return i;
    }
  }
  return -1;
}

function parseScannerFindNextAI(s, startIdx, GS, currentVariableAI = null) {
  if (GS && s.includes(GS) && s.substring(startIdx).includes(GS)) {
    const ais = ['17', '10', '21'];
    for (let i = startIdx; i < s.length - 1; i++) {
      const twoChar = s.substring(i, i + 2);
      if (ais.includes(twoChar) && i > 0 && s.charAt(i - 1) === GS) {
        return i;
      }
    }
  }

  const memo = new Map();
  return parseScannerFindNextAINoGS(s, startIdx, memo, currentVariableAI);
}

function parseGS1BarcodeFromScanner(rawScan) {
  const GS = String.fromCharCode(0x1d);
  let s = String(rawScan || '')
    .trim()
    .replace(/[\t\r\n]/g, GS)
    // AIM symbology identifier: "]" + letter + digit — ]C1 (GS1-128),
    // ]d2 (GS1 DataMatrix), ]Q3 (GS1 QR), ]e0 (GS1 DataBar). Lot-only
    // barcodes have no "01" to re-anchor on, so strip generically.
    .replace(/^\][A-Za-z]\d/, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/[^\x20-\x7E\x1D]/g, '');

  if (!s.startsWith('01')) {
    // Re-anchor on an embedded AI(01) only when a full 14-digit GTIN follows.
    // A bare indexOf would fire on "01" inside a lot value (e.g. lot-only scan
    // "10Y016312") and truncate the payload to garbage.
    const first01 = s.indexOf('01');
    if (first01 > 0 && /^\d{14}/.test(s.substring(first01 + 2))) {
      s = s.substring(first01);
    }
  }

  if (!s) {
    throw new Error('Empty scan payload');
  }

  const data = { gtin: null, expiry: null, lot: null, serial: null };
  let idx = 0;
  if (s.startsWith('01')) {
    if (s.length < 16) {
      throw new Error('AI(01) GTIN incomplete');
    }
    data.gtin = s.substring(2, 16);
    idx = 16;
  } else if (!parseScannerIsLikelyAIStart(s, 0)) {
    throw new Error('Expected a GS1 AI sequence (01/17/10/21)');
  }

  while (idx < s.length) {
    // Skip explicit separators.
    if (s.charAt(idx) === GS) {
      idx += 1;
      continue;
    }

    const currentAI = s.substring(idx, idx + 2);
    if (currentAI === '17') {
      if (s.length < idx + 8) {
        throw new Error('AI(17) expiry date incomplete');
      }
      const yymmdd = s.substring(idx + 2, idx + 8);
      data.expiry = parseScannerDate(yymmdd);
      idx += 8;
    } else if (currentAI === '10') {
      idx += 2;
      let lotEnd = parseScannerFindNextAI(s, idx, GS, '10');
      if (lotEnd === -1) {
        lotEnd = s.length;
      }
      data.lot = s.substring(idx, lotEnd).replace(/\x1d/g, '');
      idx = lotEnd;
    } else if (currentAI === '21') {
      idx += 2;
      let serialEnd = parseScannerFindNextAI(s, idx, GS, '21');
      if (serialEnd === -1) {
        serialEnd = s.length;
      }
      data.serial = s.substring(idx, serialEnd).replace(/\x1d/g, '');
      idx = serialEnd;
    } else {
      // Recover from unknown/intermediate AIs by finding the next recognized AI.
      const nextKnownAI = parseScannerFindNextAI(s, idx, GS, null);
      if (nextKnownAI > idx) {
        idx = nextKnownAI;
        continue;
      }
      break;
    }
  }

  if (!data.gtin && !data.expiry && !data.lot && !data.serial) {
    throw new Error('No recognized GS1 fields found');
  }

  return data;
}

function lookupVaccineInfoByLot(lot, gtin) {
  return new Promise((resolve) => {
    if (!lot) {
      resolve(null);
      return;
    }
    const request = { action: 'lookupVaccineInfo', lot };
    if (gtin) {
      request.gtin = gtin;
    }
    chrome.runtime.sendMessage(request, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('Hands-free lot lookup failed:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      if (!response || response.error) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function getLocalStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function setLocalStorage(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function appendQueueRecordViaBackground(storageKey, record) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'appendQueueRecord', storageKey, record }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.success) {
        reject(new Error(response?.error || 'Queue append failed'));
        return;
      }
      resolve(response.record || null);
    });
  });
}

function parseDateToLocal(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getExpiryStatus(value) {
  const expiry = parseDateToLocal(value);
  if (!expiry) {
    return {
      flag: 'unknown',
      daysRemaining: null
    };
  }

  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.floor((expiry.getTime() - todayMidnight.getTime()) / msPerDay);

  if (daysRemaining < 0) {
    return { flag: 'expired', daysRemaining };
  }
  if (daysRemaining <= 30) {
    return { flag: 'expiring_soon', daysRemaining };
  }
  return { flag: 'valid', daysRemaining };
}

function buildInventoryRecordFromParsed(data, rawBarcode) {
  const totalDoses = getPositiveInt(data.total_doses, null);
  const fallbackDose = getPositiveInt(totalDoses, null);
  const inventoryExpiry = data.inventory_expiry || data.expiry || data.nvc_lot_expiry || '';
  const expiryStatus = getExpiryStatus(inventoryExpiry);
  const expirySource = data.expiry
    ? 'barcode'
    : (data.nvc_lot_expiry ? 'nvc' : (data.expiry_source || 'none'));

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scanned_at: data.scanned_at || new Date().toISOString(),
    raw_barcode: rawBarcode || '',
    name: data.name || data.generic_name || data.tradename || data.din || '',
    tradename: data.tradename || '',
    generic_name: data.generic_name || '',
    disease: data.disease || '',
    antigen: data.antigen || '',
    manufacturer: data.manufacturer || '',
    gtin: data.gtin || '',
    lot: data.lot || '',
    serial: data.serial || '',
    barcode_expiry: data.expiry || '',
    inventory_expiry: inventoryExpiry,
    nvc_lot_expiry: data.nvc_lot_expiry || '',
    expiry_flag: expiryStatus.flag || '',
    expiry_days_remaining: expiryStatus.daysRemaining ?? '',
    expiry_source: expirySource,
    route: data.route || '',
    strength: data.strength || '',
    dose_value: data.dose_value || '',
    dose_unit: data.dose_unit || '',
    total_doses: totalDoses,
    remaining_doses: getPositiveInt(data.remaining_doses, fallbackDose),
    dose_tracking: data.dose_tracking || 'manual',
    din: data.din || '',
    drug_code: data.drug_code || data.din || '',
    lookup_error: data.lookup_error || ''
  };
}

function getPositiveInt(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getQueueRemainingDoses(row, fallback = 1) {
  const remaining = getPositiveInt(row && row.remaining_doses, null);
  if (remaining !== null) {
    return remaining;
  }
  const total = getPositiveInt(row && row.total_doses, null);
  return total !== null ? total : fallback;
}

function buildQueueRowsAfterRecordUse(rows, record, recordIndex) {
  const nextRows = Array.isArray(rows) ? rows.slice() : [];
  nextRows.splice(recordIndex, 1);

  const remaining = getQueueRemainingDoses(record, null);
  if (remaining === null) {
    nextRows.splice(recordIndex, 0, record);
  } else if (remaining > 1) {
    nextRows.splice(recordIndex, 0, { ...record, remaining_doses: remaining - 1 });
  }

  return nextRows;
}

async function saveScanToQueue(data, rawBarcode, storageKey) {
  if (!storageKey) {
    throw new Error('No storage key configured for queued scan mode');
  }
  const record = buildInventoryRecordFromParsed(data, rawBarcode);
  const appended = await appendQueueRecordViaBackground(storageKey, record);
  return appended || record;
}

function mergeVaccineInfoIntoParsed(parsed, vaccineInfo) {
  if (!parsed || !vaccineInfo) return;
  parsed.tradename = vaccineInfo.tradename;
  parsed.generic_name = vaccineInfo.generic_name;
  parsed.disease = vaccineInfo.disease;
  parsed.antigen = vaccineInfo.antigen;
  parsed.manufacturer = vaccineInfo.manufacturer;
  parsed.nvc_lot_expiry = vaccineInfo.lot_expiry;
  parsed.din = vaccineInfo.din;
  parsed.route = vaccineInfo.route;
  parsed.strength = vaccineInfo.strength;
  parsed.dose_value = vaccineInfo.dose_value;
  parsed.dose_unit = vaccineInfo.dose_unit;
  parsed.drug_code = vaccineInfo.din;
  parsed.nvc_override = vaccineInfo.nvc_override || null;
  parsed.name = vaccineInfo.generic_name || vaccineInfo.tradename || vaccineInfo.din;

  if (!parsed.lot && vaccineInfo.lot_number) {
    parsed.lot = vaccineInfo.lot_number;
  }
  if (!parsed.expiry && vaccineInfo.lot_expiry) {
    parsed.expiry = toIsoDate(vaccineInfo.lot_expiry) || vaccineInfo.lot_expiry || parsed.expiry;
  }
}

function mergeParsedScanFields(base, extra) {
  if (!extra) return base;
  return {
    scanned_at: base.scanned_at || extra.scanned_at || null,
    administered_at: base.administered_at || extra.administered_at || null,
    gtin: base.gtin || extra.gtin || null,
    expiry: base.expiry || extra.expiry || null,
    lot: base.lot || extra.lot || null,
    serial: base.serial || extra.serial || null,
    tradename: base.tradename || extra.tradename,
    generic_name: base.generic_name || extra.generic_name,
    disease: base.disease || extra.disease,
    antigen: base.antigen || extra.antigen,
    manufacturer: base.manufacturer || extra.manufacturer,
    nvc_lot_expiry: base.nvc_lot_expiry || extra.nvc_lot_expiry,
    din: base.din || extra.din,
    route: base.route || extra.route,
    strength: base.strength || extra.strength,
    dose_value: base.dose_value || extra.dose_value,
    dose_unit: base.dose_unit || extra.dose_unit,
    drug_code: base.drug_code || extra.drug_code,
    name: base.name || extra.name
  };
}

function rememberRecentInputCandidate(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value || !isCandidateGS1Text(value)) return;
  lastInputCandidate = value;
  lastInputCandidateAt = Date.now();
}

function getRecentRichScanCandidate(expectedGtin) {
  const now = Date.now();
  const candidates = [];
  if (lastInputCandidate && (now - lastInputCandidateAt) <= INPUT_CANDIDATE_TTL_MS) {
    candidates.push(lastInputCandidate);
  }

  const activeValue = getActiveElementScanCandidate();
  if (activeValue) {
    candidates.push(activeValue);
  }

  for (const raw of candidates) {
    try {
      const parsed = parseGS1BarcodeFromScanner(raw);
      if (expectedGtin && parsed.gtin && parsed.gtin !== expectedGtin) {
        continue;
      }
      if (parsed.lot || parsed.expiry || parsed.serial) {
        return { raw, parsed };
      }
    } catch (_) {
      // Ignore non-GS1 candidates.
    }
  }
  return null;
}

async function handleHandsFreeScan(scanValue, source = 'unknown') {
  if (!isHandsFreeSupportedPage()) {
    return;
  }

  const trimmed = String(scanValue || '').trim();
  if (!trimmed) return;

  if (handleVaxlinkCommand(trimmed)) return;

  const scanCapturedAt = new Date().toISOString();
  vlog('hands-free candidate', { source, length: trimmed.length, preview: trimmed.slice(0, 80) });

  const now = Date.now();
  if (trimmed === lastHandledScanValue && (now - lastHandledScanAt) < 1500) {
    return;
  }
  lastHandledScanValue = trimmed;
  lastHandledScanAt = now;

  let parsed;
  try {
    parsed = parseGS1BarcodeFromScanner(trimmed);
    logAnalyticsEvent('parse_success', {
      workflow: activeWorkflowMode,
      source,
      vaccineLabel: parsed.lot || parsed.gtin || '',
      expiryFlag: getExpiryStatus(parsed.expiry).flag
    });
  } catch (error) {
    console.warn('Hands-free scan ignored (not valid GS1):', error.message);
    playAudioCue('error');
    logAnalyticsEvent('parse_error', {
      workflow: activeWorkflowMode,
      source,
      note: error.message
    });
    return;
  }
  parsed.scanned_at = parsed.scanned_at || scanCapturedAt;

  if (!parsed.lot && !parsed.expiry && !parsed.serial) {
    const recovered = getRecentRichScanCandidate(parsed.gtin);
    if (recovered) {
      parsed = mergeParsedScanFields(parsed, recovered.parsed);
      vlog('hands-free recovered from input candidate', {
        source,
        candidatePreview: recovered.raw.slice(0, 80),
        parsed
      });
    }
  }

  try {
    let vaccineInfo = null;
    let lookupAttempted = false;
    if (parsed.lot) {
      lookupAttempted = true;
      vaccineInfo = await lookupVaccineInfoByLot(parsed.lot, parsed.gtin);
    }

    // Do not treat GTIN as a lot lookup key (pilot: wrong agent / e.g. TI vs HB).
    if (!vaccineInfo && parsed.gtin) {
      vlog('skip GTIN lot lookup (hands-free)');
    }

    if (vaccineInfo) {
      mergeVaccineInfoIntoParsed(parsed, vaccineInfo);
    }

    if (lookupAttempted) {
      const lookupExpiryFlag = getExpiryStatus(parsed.expiry || parsed.nvc_lot_expiry).flag;
      if (!vaccineInfo) {
        playAudioCue('error');
      }
      logAnalyticsEvent(vaccineInfo ? 'lookup_success' : 'lookup_error', {
        workflow: activeWorkflowMode,
        source,
        vaccineLabel: parsed.tradename || parsed.generic_name || parsed.lot || parsed.gtin || '',
        manufacturer: parsed.manufacturer || '',
        expiryFlag: lookupExpiryFlag
      });
    }
  } catch (error) {
    console.warn('Hands-free lookup error:', error);
    logAnalyticsEvent('lookup_error', {
      workflow: activeWorkflowMode,
      source,
      note: error?.message || 'Lookup failed'
    });
  }

  if (!parsed.lot && !parsed.expiry && !parsed.serial) {
    console.warn(
      'Hands-free scan parsed GTIN only (no AI10 lot / AI17 expiry / AI21 serial). Configure scanner for full GS1 payload.',
      parsed
    );
  }

  const finalExpiryFlag = getExpiryStatus(parsed.expiry || parsed.nvc_lot_expiry).flag;
  logAnalyticsEvent('scan_captured', {
    workflow: activeWorkflowMode,
    source,
    vaccineLabel: parsed.tradename || parsed.generic_name || parsed.lot || parsed.gtin || '',
    manufacturer: parsed.manufacturer || '',
    expiryFlag: finalExpiryFlag
  });

  const queueStorageKey = getQueueStorageKeyForWorkflow(activeWorkflowMode);
  if (queueStorageKey) {
    try {
      const record = await saveScanToQueue(parsed, trimmed, queueStorageKey);
      const queueKey = activeWorkflowMode === 'inventory' ? 'inventory' : 'multiple';
      if (record.duplicate_ignored) {
        playAudioCue('duplicate');
        showVaxlinkToast({ ...parsed, _duplicateIgnored: true });
        vlog('duplicate scan ignored', { mode: activeWorkflowMode, source, lot: record.lot });
        logAnalyticsEvent('queue_duplicate_ignored', {
          workflow: activeWorkflowMode,
          queue: queueKey,
          source,
          vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
          manufacturer: record.manufacturer || '',
          expiryFlag: record.expiry_flag || finalExpiryFlag
        });
        return;
      }
      // Expired records get the expiry_warning cue from the persistent toast.
      if (record.expiry_flag !== 'expired') {
        playAudioCue('success');
      }
      showVaxlinkToast({ ...parsed, _queuedCount: record.queueSizeAfter || 0 });
      vlog('workflow scan saved to queue', {
        mode: activeWorkflowMode,
        source,
        id: record.id,
        lot: record.lot,
        tradename: record.tradename
      });
      logAnalyticsEvent('queue_saved', {
        workflow: activeWorkflowMode,
        queue: queueKey,
        source,
        count: 1,
        queueSizeAfter: record.queueSizeAfter || 0,
        vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
        manufacturer: record.manufacturer || '',
        expiryFlag: record.expiry_flag || finalExpiryFlag
      });
    } catch (error) {
      console.warn('Workflow queue save failed:', error);
    }
    return;
  }

  logAnalyticsEvent('autofill_attempt', {
    workflow: activeWorkflowMode,
    source,
    vaccineLabel: parsed.tradename || parsed.generic_name || parsed.lot || parsed.gtin || '',
    manufacturer: parsed.manufacturer || '',
    expiryFlag: finalExpiryFlag
  });
  if (adminDateTimeAutofillEnabled) {
    parsed.administered_at = parsed.administered_at || parsed.scanned_at || scanCapturedAt;
  } else {
    delete parsed.administered_at;
  }
  const autofillResult = autoFillTelus(parsed);
  const success = isAutofillSuccess(autofillResult);
  const pending = isAutofillPending(autofillResult);
  logAnalyticsEvent('autofill_result', {
    workflow: activeWorkflowMode,
    source,
    success,
    pending,
    vaccineLabel: parsed.tradename || parsed.generic_name || parsed.lot || parsed.gtin || '',
    manufacturer: parsed.manufacturer || '',
    expiryFlag: finalExpiryFlag
  });
  if (success) {
    showVaxlinkToast(parsed);
  }
  vlog('hands-free autofill', autofillResult?.status, { source, parsed });
}

function flushHandsFreeBuffer(event) {
  if (!scannerBuffer) return;
  const captured = scannerBuffer;
  const likelyScanner = isLikelyScannerSequence() || isCandidateGS1Text(captured);
  resetScannerBuffer();

  if (!likelyScanner) return;

  if (event) {
    event.preventDefault();
  }
  handleHandsFreeScan(captured, 'keyboard-buffer');
}

function scheduleScannerFlush() {
  if (scannerIdleTimer) {
    clearTimeout(scannerIdleTimer);
  }
  scannerIdleTimer = setTimeout(() => {
    flushHandsFreeBuffer();
  }, SCAN_IDLE_COMMIT_MS);
}

function getActiveElementScanCandidate() {
  const el = document.activeElement;
  if (!isTextEntryElement(el)) return '';
  if (!el || !('value' in el)) return '';
  const raw = String(el.value || '').trim();
  // Field values on app forms can be truncated by maxlength/masks.
  // Accept short AI-only GS1 payloads too (e.g., 17+10 without AI01).
  if (raw.length < 8) return '';
  if (!isCandidateGS1Text(raw)) return '';

  // isCandidateGS1Text is too loose for Tab/Enter interception — it matches any
  // text containing "01" (dates, patient IDs, lot numbers). Require a full parse
  // just like onHandsFreePaste does, so nurses can Tab through fields normally.
  let parsed;
  try {
    parsed = parseGS1BarcodeFromScanner(raw);
  } catch (_) {
    return '';
  }
  if (!parsed) return '';
  // Require a numeric 14-digit GTIN. IDs starting with "10" parse as AI(10)
  // lot barcodes (gtin=null) — null also fails this check, so they pass through.
  if (!parsed.gtin || !/^\d{14}$/.test(parsed.gtin)) return '';

  return raw;
}

function clearActiveElementValue() {
  const el = document.activeElement;
  if (!el || !('value' in el)) return;
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function onHandsFreePaste(event) {
  if (!isHandsFreeSupportedPage()) return;

  const text = String((event.clipboardData && event.clipboardData.getData('text')) || '').trim();
  if (!text || text.length < SCAN_MIN_LENGTH) return;
  if (!isCandidateGS1Text(text)) return;

  // isCandidateGS1Text is too loose for paste — it matches dates, patient IDs,
  // and any text containing "01" or starting with "10"/"17"/"21". IDs starting
  // with "10" parse as AI(10) lot barcodes (gtin=null) which must also be
  // rejected. Require a full parse with a numeric 14-digit GTIN.
  let parsed;
  try {
    parsed = parseGS1BarcodeFromScanner(text);
  } catch (_) {
    return;
  }
  if (!parsed) return;
  if (!parsed.gtin || !/^\d{14}$/.test(parsed.gtin)) return;

  event.preventDefault();
  rememberRecentInputCandidate(text);
  vlog('hands-free paste');
  handleHandsFreeScan(text, 'paste');
}

function isCandidateGS1Text(value) {
  const text = String(value || '').trim();
  if (text.length < SCAN_MIN_LENGTH) return false;
  const normalized = normalizeScannerCandidate(text);
  if (!normalized) return false;
  if (normalized.startsWith('01') || normalized.includes('01')) return true;
  if (normalized.startsWith('17')) {
    return normalized.length >= 8 && /^\d{6}$/.test(normalized.substring(2, 8));
  }
  if (normalized.startsWith('10') || normalized.startsWith('21')) {
    return normalized.length > 2;
  }
  return parseScannerIsLikelyAIStart(normalized, 0);
}

function normalizeScannerCandidate(value) {
  const GS = String.fromCharCode(0x1d);
  let s = String(value || '')
    .trim()
    .replace(/[\t\r\n]/g, GS)
    .replace(/^\][A-Za-z]\d/, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/[^\x20-\x7E\x1D]/g, '');
  if (!s.startsWith('01')) {
    // Same guarded re-anchor as parseGS1BarcodeFromScanner: only jump to an
    // embedded "01" when a full 14-digit GTIN follows it.
    const first01 = s.indexOf('01');
    if (first01 > 0 && /^\d{14}/.test(s.substring(first01 + 2))) {
      s = s.substring(first01);
    }
  }
  return s;
}

function hasPostGTINAI(value) {
  const s = normalizeScannerCandidate(value);
  if (!s.startsWith('01') || s.length <= 16) return false;
  const tail = s.substring(16);
  return tail.includes('10') || tail.includes('17') || tail.includes('21') || tail.includes(String.fromCharCode(0x1d));
}

function onHandsFreeInput(event) {
  if (!isHandsFreeSupportedPage()) return;

  const target = event && event.target;
  if (!target || !isTextEntryElement(target) || !('value' in target)) return;
  const value = String(target.value || '').trim();
  if (value.length >= 16 && isCandidateGS1Text(value)) {
    rememberRecentInputCandidate(value);
  }
  if (scannerBuffer && scannerBuffer.length > 0) return;
  if (value.length < SCAN_MIN_LENGTH || !isCandidateGS1Text(value)) return;

  if (scannerInputTimer) {
    clearTimeout(scannerInputTimer);
  }
  scannerInputTimer = setTimeout(() => {
    const latest = String(target.value || '').trim();
    if (!isCandidateGS1Text(latest)) return;
    // isCandidateGS1Text is too loose to justify wiping the field — it matches
    // dates, patient IDs, and any text containing "01". Mirror the paste path:
    // require a full parse with a numeric 14-digit GTIN before clearing, so
    // manually typed values are never destroyed.
    let parsed;
    try {
      parsed = parseGS1BarcodeFromScanner(latest);
    } catch (_) {
      return;
    }
    if (!parsed || !parsed.gtin || !/^\d{14}$/.test(parsed.gtin)) return;
    target.value = '';
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    vlog('hands-free input event');
    handleHandsFreeScan(latest, 'input-event');
  }, SCAN_IDLE_COMMIT_MS + 120);
}

function isHandsFreeSupportedPage() {
  try {
    if (window.top !== window.self) {
      return false;
    }

    const host = String(window.location.hostname || '').toLowerCase();
    if (!host) return false;

    // Exclude known third-party iframes that may include the app URL in hash/query.
    if (host.includes('stripe.network') || host.includes('stripe.com')) {
      return false;
    }

    const isPanorama =
      (host === 'www.panorama.prod.ehealthontario.ca' ||
       host === 'panorama.prod.ehealthontario.ca') &&
      window.location.pathname === '/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml';
    const isInputHealth = host === 'inputhealth.com' || host.endsWith('.inputhealth.com');

    return isPanorama || isInputHealth;
  } catch (error) {
    return false;
  }
}

function onHandsFreeKeydown(event) {
  if (!isHandsFreeSupportedPage()) return;
  if (event.defaultPrevented) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const key = event.key;
  const now = Date.now();
  if (scannerLastAt && (now - scannerLastAt) > SCAN_CHAR_GAP_RESET_MS) {
    resetScannerBuffer();
  }

  if (key === 'Tab' || key === 'Enter' || key === 'NumpadEnter') {
    // Many scanner profiles use Tab/Enter as separators between AIs, not only as suffix.
    // Treat them as GS markers and flush only after idle timeout.
    if (scannerBuffer) {
      // Only swallow the key when the buffer was typed at scanner speed
      // (>= SCAN_MIN_LENGTH chars, machine-fast). Nurses type short values
      // and Tab/Enter within the 1.5s gap window — unconditionally eating
      // their navigation key breaks Panorama form entry.
      if (isLikelyScannerSequence()) {
        scannerLastAt = now;
        scannerBuffer += String.fromCharCode(0x1d);
        event.preventDefault();
        event.stopPropagation();
        scheduleScannerFlush();
        return;
      }
      // Manual typing: drop the stale buffer and let the key act normally.
      resetScannerBuffer();
    }

    const activeScan = getActiveElementScanCandidate();
    if (activeScan) {
      event.preventDefault();
      clearActiveElementValue();
      vlog('hands-free focused input');
      handleHandsFreeScan(activeScan, 'focused-input');
      return;
    }

    return;
  }

  if ((key === 'Unidentified' || key === 'Process') && scannerBuffer) {
    scannerLastAt = now;
    scannerBuffer += String.fromCharCode(0x1d);
    scheduleScannerFlush();
    return;
  }

  if (key.length !== 1) {
    return;
  }

  if (!scannerStartedAt) scannerStartedAt = now;
  scannerLastAt = now;
  scannerBuffer += key;

  scheduleScannerFlush();
}

function initHandsFreeScanner() {
  if (window.__vaxlinkHandsFreeInitialized) {
    return;
  }
  if (!isHandsFreeSupportedPage()) {
    return;
  }
  window.__vaxlinkHandsFreeInitialized = true;

  chrome.storage.local.get([
    WORKFLOW_MODE_KEY,
    LEGACY_POPUP_MODE_KEY,
    LEGACY_REMOTE_MODE_KEY,
    LEGACY_HANDS_FREE_KEY,
    ADMIN_DATETIME_AUTOFILL_KEY,
    AUDIO_FEEDBACK_KEY
  ], (stored) => {
    activeWorkflowMode = normalizeWorkflowMode(stored);
    adminDateTimeAutofillEnabled = normalizeAdminDateTimeAutofillSetting(stored);
    audioFeedbackEnabled = normalizeAudioFeedbackSetting(stored);
    vlog('active workflow mode', activeWorkflowMode);

    // On Panorama SPA navigations the page is already fully loaded when this
    // content script injects, so document.readyState is NOT 'loading'.
    // initClickReductionFeatures() therefore ran synchronously — BEFORE this
    // callback fired.  At that point activeWorkflowMode was still the default
    // 'single', so every mode guard in checkGrid() and the tryAutoDrain
    // setTimeout evaluated false and bailed.
    //
    // Now that the real mode is known, re-kick both paths:
    //  • maybeAutoFillPanoramaMultipleGrid – fills the agent+date grid
    //  • tryAutoDrain – fills the single-immunization form after save
    //
    // A 250 ms head-start lets PrimeFaces settle; both functions guard
    // internally (isPrimeFacesAjaxBusy, multiGridFillPending, etc.) and
    // the MutationObserver catches any subsequent retry-worthy mutations.
    if (activeWorkflowMode === 'multiple') {
      setTimeout(() => void maybeAutoFillPanoramaMultipleGrid(), 250);
      setTimeout(() => tryAutoDrain(), 1200);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      !(WORKFLOW_MODE_KEY in changes) &&
      !(LEGACY_POPUP_MODE_KEY in changes) &&
      !(LEGACY_REMOTE_MODE_KEY in changes) &&
      !(LEGACY_HANDS_FREE_KEY in changes) &&
      !(ADMIN_DATETIME_AUTOFILL_KEY in changes) &&
      !(AUDIO_FEEDBACK_KEY in changes)
    ) {
      return;
    }
    const nextState = {
      [WORKFLOW_MODE_KEY]: WORKFLOW_MODE_KEY in changes ? changes[WORKFLOW_MODE_KEY].newValue : activeWorkflowMode,
      [LEGACY_POPUP_MODE_KEY]: LEGACY_POPUP_MODE_KEY in changes ? changes[LEGACY_POPUP_MODE_KEY].newValue : undefined,
      [LEGACY_REMOTE_MODE_KEY]: LEGACY_REMOTE_MODE_KEY in changes ? changes[LEGACY_REMOTE_MODE_KEY].newValue : undefined,
      [LEGACY_HANDS_FREE_KEY]: LEGACY_HANDS_FREE_KEY in changes ? changes[LEGACY_HANDS_FREE_KEY].newValue : undefined,
      [ADMIN_DATETIME_AUTOFILL_KEY]: ADMIN_DATETIME_AUTOFILL_KEY in changes
        ? changes[ADMIN_DATETIME_AUTOFILL_KEY].newValue
        : adminDateTimeAutofillEnabled,
      [AUDIO_FEEDBACK_KEY]: AUDIO_FEEDBACK_KEY in changes
        ? changes[AUDIO_FEEDBACK_KEY].newValue
        : audioFeedbackEnabled
    };
    activeWorkflowMode = normalizeWorkflowMode(nextState);
    adminDateTimeAutofillEnabled = normalizeAdminDateTimeAutofillSetting(nextState);
    audioFeedbackEnabled = normalizeAudioFeedbackSetting(nextState);
    resetScannerBuffer();
    vlog('workflow mode changed', activeWorkflowMode);
  });

  window.addEventListener('keydown', onHandsFreeKeydown, true);
  window.addEventListener('paste', onHandsFreePaste, true);
  window.addEventListener('input', onHandsFreeInput, true);
  document.addEventListener('pointerdown', cancelPanoramaFillRetriesForManualEdit, true);
  document.addEventListener('change', cancelPanoramaFillRetriesForManualEdit, true);
}
