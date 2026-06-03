// Tests that verify the paste-interception gate in onHandsFreePaste.
//
// The functions below are pure copies of the GS1 parsing utilities in
// content.js (no Chrome/DOM deps). They exist here to test the exact logic
// that guards event.preventDefault() in onHandsFreePaste.

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

// ── Simulate the onHandsFreePaste gate logic (mirrors content.js fix) ─────

// Returns true if the paste would be intercepted (preventDefault called), or
// false if the paste is allowed to reach the target element normally.
function wouldInterceptPaste(text) {
  const SCAN_MIN_LENGTH = 8;
  if (!text || text.length < SCAN_MIN_LENGTH) return false;

  // isCandidateGS1Text loose check
  const normalized = (() => {
    const GS = String.fromCharCode(0x1d);
    let s = String(text).trim()
      .replace(/[\t\r\n]/g, GS)
      .replace(/^\]C1/i, '')
      .replace(/\(/g, '')
      .replace(/\)/g, '')
      .replace(/[^\x20-\x7E\x1D]/g, '');
    if (!s.startsWith('01')) {
      const first01 = s.indexOf('01');
      if (first01 > 0) s = s.substring(first01);
    }
    return s;
  })();
  if (!normalized) return false;
  const looseMatch =
    normalized.startsWith('01') ||
    normalized.startsWith('17') ||
    normalized.startsWith('10') ||
    normalized.startsWith('21');
  if (!looseMatch) return false;

  // Strict gate: parse as complete GS1 barcode and verify numeric GTIN
  let parsed;
  try {
    parsed = parseGS1BarcodeFromScanner(text);
  } catch (_) {
    return false;
  }
  if (!parsed) return false;
  // Non-digit GTIN means the parser found "01" inside normal prose
  if (parsed.gtin && !/^\d{14}$/.test(parsed.gtin)) return false;
  return true;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('real GS1 vaccine barcode (GTIN + lot + expiry) is intercepted', () => {
  // AI01 GTIN-14 + AI10 lot + AI17 expiry, no GS separators
  // 0100012345678905 = AI01 + "00012345678905", 10LOT-ABC = AI10 + lot,
  // 17240101 = AI17 + "240101" (Jan 1 2024)
  const barcode = '010001234567890510LOT-ABC17240101';
  assert.ok(wouldInterceptPaste(barcode));
  const result = parseGS1BarcodeFromScanner(barcode);
  assert.equal(result.gtin, '00012345678905');
  assert.equal(result.lot, 'LOT-ABC');
  assert.equal(result.expiry, '01/01/2024');
});

test('GS1 barcode with only GTIN (no lot/expiry) is intercepted', () => {
  const gtinOnly = '0100012345678905';
  assert.ok(wouldInterceptPaste(gtinOnly));
  const result = parseGS1BarcodeFromScanner(gtinOnly);
  assert.equal(result.gtin, '00012345678905');
});

test('GS1 barcode with GS separator before variable AI is intercepted', () => {
  // Standard GS1 encoding: GS goes before variable-length fields
  const GS = String.fromCharCode(0x1d);
  const barcode = `0100012345678905${GS}17251201`;
  assert.ok(wouldInterceptPaste(barcode));
  const result = parseGS1BarcodeFromScanner(barcode);
  assert.equal(result.gtin, '00012345678905');
  assert.ok(result.expiry);
});

test('date string "01/01/2024" is NOT intercepted — too short for GTIN', () => {
  // After normalization "01/01/2024" is 10 chars; GTIN needs at least 16 total
  assert.ok(!wouldInterceptPaste('01/01/2024'));
});

test('natural language containing "01" is NOT intercepted', () => {
  // Pasting clinical notes that happen to contain "01"
  assert.ok(!wouldInterceptPaste('Administered 01 dose of vaccine today'));
  assert.ok(!wouldInterceptPaste('Chart note: visit #0156, dose #01'));
});

test('date of birth with "01" prefix is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('DOB: 01-15-1985, health card 01234'));
});

test('patient ID starting with "01" but too short for GTIN is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('0123456789'));
});

test('phone number starting with "01" is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('Phone: 0123456789012'));
});

test('short text below SCAN_MIN_LENGTH is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('01AB'));
});

test('empty and null paste are NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste(''));
  assert.ok(!wouldInterceptPaste(null));
});
