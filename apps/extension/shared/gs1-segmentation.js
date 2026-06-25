/**
 * Bundle-anchored GS1 segmentation search.
 *
 * Hardware HID (keyboard-wedge) scanners type the barcode payload as plain
 * keystrokes, which drops the non-printable FNC1/<GS> separator that normally
 * terminates a variable-length AI value. Without it, a lot value whose text
 * contains digits that look like another AI is ambiguous — e.g. the "21" inside
 * lot "AHAVC219AC" makes a greedy left-to-right parser split the lot early and
 * mistake the tail for an AI(21) serial, truncating the lot to "AHAVC".
 *
 * Instead of committing to the first plausible boundary, this module enumerates
 * EVERY valid GS1 segmentation of the scan, then lets the caller score them
 * against ground truth (a `knownLot` predicate backed by the NVC bundle). The
 * candidate whose lot the bundle actually knows wins decisively; when no bundle
 * is available the structural tiebreaks (valid expiry present, maximal-munch
 * lot, serial penalty) still prefer the correct parse.
 *
 * Pure and side-effect free except for attaching itself to the global object so
 * the same source loads in the MV3 service worker (`importScripts`) and in the
 * Node test runner (`require`). The recognized AI set is kept identical to the
 * greedy parser in popup-parser.js / content.js (01, 17, 10, 21) so this never
 * recognizes a field the rest of the extension wouldn't.
 */
(function attachVaxLinkGS1Segmentation(root) {
  'use strict';

  const GS = String.fromCharCode(0x1d);

  // Fixed-length value AIs (AI -> value length) and variable-length value AIs.
  const FIXED = { '01': 14, '17': 6 };
  const VARIABLE = new Set(['10', '21']);
  const FIELD_KEY = { '01': 'gtin', '17': 'expiry', '10': 'lot', '21': 'serial' };

  // Cap the parse forest so a pathological scan packed with AI-like substrings
  // can't blow up enumeration. Real GS1 vaccine scans yield a handful of parses.
  const MAX_PARSES = 512;

  function isValidDate6(s) {
    if (!/^\d{6}$/.test(s)) return false;
    const mm = Number(s.slice(2, 4));
    const dd = Number(s.slice(4, 6));
    if (mm < 1 || mm > 12) return false;
    // GS1 permits dd "00" meaning "last day of the month".
    return dd >= 0 && dd <= 31;
  }

  function formatDate(yymmdd) {
    if (!yymmdd || yymmdd.length !== 6) return null;
    const yy = yymmdd.substring(0, 2);
    const mm = yymmdd.substring(2, 4);
    let dd = yymmdd.substring(4, 6);
    if (dd === '00') {
      const lastDay = new Date(Number(`20${yy}`), Number(mm), 0).getDate();
      dd = String(lastDay).padStart(2, '0');
    }
    return `${mm}/${dd}/20${yy}`;
  }

  // Mirror of the normalization in popup-parser.js / content.js so the search
  // operates on exactly the string the greedy parser would have seen.
  function normalizeScan(raw) {
    let scan = String(raw || '')
      .trim()
      .replace(/[\t\r\n]/g, GS)
      .replace(/^\][A-Za-z]\d/, '')
      .replace(/\(/g, '')
      .replace(/\)/g, '')
      .replace(/[^\x20-\x7E\x1D]/g, '');

    if (!scan.startsWith('01')) {
      const first01 = scan.indexOf('01');
      if (first01 > 0 && /^\d{14}/.test(scan.substring(first01 + 2))) {
        scan = scan.substring(first01);
      }
    }
    return scan;
  }

  // A position is a plausible AI start mid-stream (used to bound a variable
  // field). Mirrors popup-parser.isLikelyAIStart: only 17 (with a valid date),
  // 10, and 21 — never an embedded 01, which would fire inside lot values.
  function isLikelyAIStart(scan, idx) {
    if (idx < 0 || idx > scan.length - 2) return false;
    const ai = scan.substring(idx, idx + 2);
    if (ai === '17') return isValidDate6(scan.substring(idx + 2, idx + 8));
    return ai === '10' || ai === '21';
  }

  // Enumerate every complete GS1 segmentation of an already-normalized scan.
  // A "complete" parse is one whose AI walk consumes the entire string; dead
  // branches (a dangling byte, an unrecognized AI) simply produce nothing.
  function enumerateNormalized(scan) {
    const out = [];
    if (!scan) return out;

    function walk(start, acc) {
      let idx = start;
      // Skip explicit separators where present.
      while (idx < scan.length && scan.charAt(idx) === GS) idx += 1;
      if (idx === scan.length) {
        out.push({ ...acc });
        return;
      }
      if (out.length >= MAX_PARSES) return;
      if (idx > scan.length - 2) return; // dangling byte: not a valid AI

      const ai = scan.substring(idx, idx + 2);

      if (FIXED[ai] != null) {
        const valueStart = idx + 2;
        const valueEnd = valueStart + FIXED[ai];
        if (valueEnd > scan.length) return;
        const val = scan.substring(valueStart, valueEnd);
        if (ai === '01' && !/^\d{14}$/.test(val)) return;
        if (ai === '17' && !isValidDate6(val)) return;
        const next = { ...acc };
        next[FIELD_KEY[ai]] = ai === '17' ? formatDate(val) : val;
        walk(valueEnd, next);
        return;
      }

      if (VARIABLE.has(ai)) {
        const valueStart = idx + 2;
        if (valueStart >= scan.length) return; // empty variable value
        // A <GS> at/after valueStart terminates this field unambiguously.
        const gsPos = scan.indexOf(GS, valueStart);
        const ends = [];
        if (gsPos !== -1) {
          ends.push(gsPos);
        } else {
          for (let j = valueStart + 1; j <= scan.length - 2; j += 1) {
            if (isLikelyAIStart(scan, j)) ends.push(j);
          }
          ends.push(scan.length); // value runs to the end
        }
        for (const end of ends) {
          if (end <= valueStart) continue;
          const next = { ...acc };
          next[FIELD_KEY[ai]] = scan.substring(valueStart, end).replace(/\x1d/g, '');
          walk(end, next);
          if (out.length >= MAX_PARSES) return;
        }
        return;
      }

      // Unrecognized AI start: dead branch.
    }

    const empty = { gtin: null, expiry: null, lot: null, serial: null };
    if (scan.startsWith('01') || isLikelyAIStart(scan, 0)) {
      walk(0, empty);
    }
    return out;
  }

  function enumerateGS1Segmentations(rawScan) {
    return enumerateNormalized(normalizeScan(rawScan));
  }

  // Score a candidate parse. Ground-truth lot match dominates; the rest are
  // structural tiebreaks that keep the search sensible when offline.
  function scoreParse(parse, knownLot) {
    const lotKnown = !!(parse.lot && typeof knownLot === 'function' && knownLot(parse.lot));
    let score = 0;
    if (lotKnown) score += 1000;                 // NVC bundle confirms the lot: decisive
    if (parse.expiry) score += 50;               // a coherent expiry field is present
    if (parse.gtin) score += 20;                 // GTIN present
    if (parse.lot) score += parse.lot.length;    // maximal-munch tiebreak
    if (parse.serial) score -= 5;                // vaccine barcodes rarely carry a serial
    if (!parse.lot) score -= 100;                // a vaccine scan should resolve to a lot
    return { score, lotKnown };
  }

  // Return the highest-scoring segmentation, annotated with its score and
  // whether its lot is bundle-confirmed. Returns null when nothing parses.
  function resolveBestSegmentation(rawScan, knownLot) {
    const parses = enumerateGS1Segmentations(rawScan);
    if (!parses.length) return null;

    const seen = new Set();
    let best = null;
    for (const parse of parses) {
      const dedupeKey = JSON.stringify(parse);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const { score, lotKnown } = scoreParse(parse, knownLot);
      if (!best || score > best.score) {
        best = { ...parse, score, lotKnown };
      }
    }
    return best;
  }

  root.VaxLinkGS1Segmentation = Object.freeze({
    GS,
    normalizeScan,
    enumerateGS1Segmentations,
    resolveBestSegmentation
  });
})(typeof self !== 'undefined' ? self : globalThis);
