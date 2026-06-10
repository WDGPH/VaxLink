// Tests that verify the Tab/Enter key interception gate in onHandsFreeKeydown.
//
// getActiveElementScanCandidate() guards whether a focused field's value is
// treated as a scanned barcode when Tab or Enter is pressed. Before this fix,
// it only used the loose isCandidateGS1Text() check — any field value
// containing "01" (dates, patient IDs, lot numbers) would cause Tab to be
// intercepted, blocking nurses from navigating between Panorama fields.
//
// The fix mirrors the paste-interception guard (PR #14): require a full GS1
// parse with a numeric 14-digit GTIN before intercepting.

import assert from 'node:assert/strict';
import test from 'node:test';

// ── Pure GS1 parsing helpers (mirrored from content.js) ───────────────────

function parseScannerDate(yymmdd) {
  if (!yymmdd || yymmdd.length !== 6) return null;
  const yy = yymmdd.substring(0, 2);
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);
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
    if (parseScannerCanParseTailNoGS(s, i, memo)) return i;
  }
  return -1;
}

function parseScannerFindNextAI(s, startIdx, GS, currentVariableAI = null) {
  if (GS && s.includes(GS) && s.substring(startIdx).includes(GS)) {
    const ais = ['17', '10', '21'];
    for (let i = startIdx; i < s.length - 1; i++) {
      const twoChar = s.substring(i, i + 2);
      if (ais.includes(twoChar) && i > 0 && s.charAt(i - 1) === GS) return i;
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
    .replace(/^\]C1/i, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/[^\x20-\x7E\x1D]/g, '');
  if (!s.startsWith('01')) {
    const first01 = s.indexOf('01');
    if (first01 > 0) s = s.substring(first01);
  }
  if (!s) throw new Error('Empty scan payload');
  const data = { gtin: null, expiry: null, lot: null, serial: null };
  let idx = 0;
  if (s.startsWith('01')) {
    if (s.length < 16) throw new Error('AI(01) GTIN incomplete');
    data.gtin = s.substring(2, 16);
    idx = 16;
  } else if (!parseScannerIsLikelyAIStart(s, 0)) {
    throw new Error('Expected a GS1 AI sequence (01/17/10/21)');
  }
  while (idx < s.length) {
    if (s.charAt(idx) === GS) { idx += 1; continue; }
    const currentAI = s.substring(idx, idx + 2);
    if (currentAI === '17') {
      if (s.length < idx + 8) throw new Error('AI(17) expiry date incomplete');
      data.expiry = parseScannerDate(s.substring(idx + 2, idx + 8));
      idx += 8;
    } else if (currentAI === '10') {
      idx += 2;
      let lotEnd = parseScannerFindNextAI(s, idx, GS, '10');
      if (lotEnd === -1) lotEnd = s.length;
      data.lot = s.substring(idx, lotEnd);
      idx = lotEnd;
    } else if (currentAI === '21') {
      idx += 2;
      let serialEnd = parseScannerFindNextAI(s, idx, GS, '21');
      if (serialEnd === -1) serialEnd = s.length;
      data.serial = s.substring(idx, serialEnd);
      idx = serialEnd;
    } else {
      const nextKnownAI = parseScannerFindNextAI(s, idx, GS, null);
      if (nextKnownAI > idx) { idx = nextKnownAI; continue; }
      break;
    }
  }
  if (!data.gtin && !data.expiry && !data.lot && !data.serial) {
    throw new Error('No recognized GS1 fields found');
  }
  return data;
}

// ── Simulate the getActiveElementScanCandidate gate logic ─────────────────

// Returns the value that would be passed to handleHandsFreeScan (non-empty
// means Tab is intercepted), or '' if Tab is allowed through normally.
function wouldInterceptTab(fieldValue) {
  const SCAN_MIN_LENGTH = 8;
  const raw = String(fieldValue || '').trim();
  if (raw.length < SCAN_MIN_LENGTH) return '';

  // isCandidateGS1Text loose check
  const GS = String.fromCharCode(0x1d);
  let normalized = raw
    .replace(/[\t\r\n]/g, GS)
    .replace(/^\]C1/i, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/[^\x20-\x7E\x1D]/g, '');
  if (!normalized.startsWith('01')) {
    const first01 = normalized.indexOf('01');
    if (first01 > 0) normalized = normalized.substring(first01);
  }
  if (!normalized) return '';
  const looseMatch =
    normalized.startsWith('01') || normalized.includes('01') ||
    normalized.startsWith('17') || normalized.startsWith('10') || normalized.startsWith('21');
  if (!looseMatch) return '';

  // Strict gate added by this fix: require full GS1 parse with numeric GTIN
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

// ── Tests ──────────────────────────────────────────────────────────────────

test('real GS1 barcode in focused field IS intercepted on Tab', () => {
  const barcode = '010001234567890510LOT-ABC17240101';
  assert.equal(wouldInterceptTab(barcode), barcode);
});

test('GS1 barcode with only GTIN IS intercepted on Tab', () => {
  const barcode = '0100012345678905';
  assert.equal(wouldInterceptTab(barcode), barcode);
});

test('date "06/01/2026" in a field does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('06/01/2026'), '');
});

test('date "01/15/2025" in a field does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('01/15/2025'), '');
});

test('patient ID containing "01" does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('PTH01234567'), '');
});

test('lot number like "LOT01-2024" does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('LOT01-2024'), '');
});

test('clinical note containing "01" does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('Dose 01 administered today at clinic'), '');
});

test('health card number starting with "01" does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('0123456789012'), '');
});

test('short field value below minimum length does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('01AB'), '');
});

test('empty field does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab(''), '');
});

test('client ID starting with "10" does NOT intercept Tab', () => {
  // "10" is GS1 AI(10) (lot number) — parses with gtin=null, must not intercept
  assert.equal(wouldInterceptTab('1012345678901'), '');
});

test('client ID starting with "10" longer variant does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('10987654321098'), '');
});
