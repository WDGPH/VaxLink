/**
 * Integration test: run the full HB lookup pipeline against every HB lot in
 * the live NVC FHIR bundle and verify each lot is classified correctly as
 * HB, HB-pediatric, or HB-dialysis.
 *
 * Requires apps/web/nvc-bundle.json (gitignored). Download with:
 *   bash scripts/fetch-nvc.sh
 *
 * The test is automatically skipped when the bundle file is absent so it does
 * not break CI. Run locally after fetching the bundle.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolve relative to the test file itself: tests/ → extension/ → apps/ → VaxLink/
const BUNDLE_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../web/nvc-bundle.json'
);

const bundlePath = existsSync(BUNDLE_PATH) ? BUNDLE_PATH : null;

// Load panorama-agent-rules.js side-effect so globalThis.VAXLINK_PANORAMA_AGENT_RULES is set.
const require = createRequire(import.meta.url);
const rulesPath = path.resolve(fileURLToPath(import.meta.url), '../../panorama-agent-rules.js');
require(rulesPath);
const PANORAMA_AGENT_RULES = globalThis.VAXLINK_PANORAMA_AGENT_RULES;

// ---------------------------------------------------------------------------
// Override tables (mirrored from background.js — keep in sync)
// ---------------------------------------------------------------------------

const GTIN_TRADENAME_CODE_OVERRIDES = Object.freeze({ '00067055046339': '6951000087100' });
const LOT_TRADENAME_CODE_OVERRIDES = Object.freeze({
  'Y016312': '6951000087100',
  'Y020519': '6951000087100'
});

function normalizeGtinKey(v) { return String(v || '').replace(/\D/g, ''); }
function normalizeLotKey(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function normalizeCodeKey(v) { return String(v || '').trim().toLowerCase(); }
function resolveTradenameCodeOverrideByGtin(gtin) {
  const k = normalizeGtinKey(gtin); return k ? normalizeCodeKey(GTIN_TRADENAME_CODE_OVERRIDES[k] || '') : '';
}
function resolveTradenameCodeOverrideByLot(lot) {
  const k = normalizeLotKey(lot); return k ? normalizeCodeKey(LOT_TRADENAME_CODE_OVERRIDES[k] || '') : '';
}

// ---------------------------------------------------------------------------
// Agent matching (mirrored from content.js — keep in sync)
// ---------------------------------------------------------------------------

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[:/,_-]/g, ' ')
    .replace(/\broute\b/g, ' ')
    .replace(/\bqualifier\b/g, ' ')
    .replace(/\bvalue\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPanoramaAgentSourceText(data) {
  return normalizeForMatch([
    data?.name, data?.generic_name, data?.tradename, data?.disease,
    data?.antigen, data?.manufacturer, data?.route, data?.strength
  ].filter(Boolean).join(' '));
}

function getNormalizedSourceTokens(src) {
  return String(src || '').split(' ').map(t => t.trim()).filter(Boolean);
}

function panoramaSourceHasNormalizedTerm(src, tokens, term) {
  const nt = normalizeForMatch(term);
  if (!nt) return false;
  const tt = nt.split(' ').filter(Boolean);
  if (!tt.length) return false;
  if (tt.length === 1) {
    const tok = tt[0];
    return tok.length <= 3 ? tokens.includes(tok) : (tokens.includes(tok) || src.includes(tok));
  }
  if (src.includes(nt)) return true;
  return tt.every(tok => tok.length <= 3 ? tokens.includes(tok) : (tokens.includes(tok) || src.includes(tok)));
}

function clauseMatches(src, clause) {
  const tokens = getNormalizedSourceTokens(src);
  if (clause.any && !clause.any.some(t => panoramaSourceHasNormalizedTerm(src, tokens, t))) return false;
  if (clause.all && !clause.all.every(t => panoramaSourceHasNormalizedTerm(src, tokens, t))) return false;
  if (clause.notAny && clause.notAny.some(t => panoramaSourceHasNormalizedTerm(src, tokens, t))) return false;
  if (clause.notAll && clause.notAll.every(t => panoramaSourceHasNormalizedTerm(src, tokens, t))) return false;
  return true;
}

function ruleMatches(src, rule) {
  return (rule.clauses || []).some(c => clauseMatches(src, c));
}

function getAgentOutputs(vaccineInfo) {
  const src = buildPanoramaAgentSourceText(vaccineInfo);
  const outputs = new Set();
  for (const rule of PANORAMA_AGENT_RULES) {
    if (ruleMatches(src, rule)) {
      for (const o of rule.outputs || []) outputs.add(o);
    }
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// Minimal NVC pipeline simulation (mirrors background.js logic)
// ---------------------------------------------------------------------------

function buildNvcIndexes(bundle) {
  const tradenameByCode = {};
  const lotByLotNumber = {};

  for (const entry of bundle.entry || []) {
    const r = entry.resource;
    if (!r) continue;

    // Index tradenames
    if (r.resourceType === 'ValueSet' && r.id === 'Tradename') {
      for (const inc of r.compose?.include || []) {
        for (const c of inc.concept || []) { if (c.code) tradenameByCode[c.code.toLowerCase()] = c; }
      }
      for (const item of r.expansion?.contains || []) {
        if (item.code) tradenameByCode[item.code.toLowerCase()] = item;
      }
    }
    if (r.resourceType === 'CodeSystem') {
      const idKey = (r.id || '').toLowerCase();
      if (idKey.includes('tradename') || idKey.includes('trade-name') || idKey.includes('trade_name')) {
        for (const c of r.concept || []) { if (c.code) tradenameByCode[c.code.toLowerCase()] = c; }
      }
    }

    // Index lots
    if (r.resourceType === 'CodeSystem' && ((r.id || '').toLowerCase().includes('lot') || (r.id || '').toLowerCase().includes('batch'))) {
      for (const concept of r.concept || []) {
        let lotNumber = null;
        for (const prop of concept.property || []) {
          if (prop.code === 'lotNumber' && prop.valueString) { lotNumber = prop.valueString; break; }
        }
        if (lotNumber) lotByLotNumber[lotNumber.toLowerCase()] = concept;
        // also index by code (code = "LOTNUM_[idx]" or just the lot)
        if (concept.code) lotByLotNumber[concept.code.toLowerCase()] = concept;
      }
    }
  }

  return { tradenameByCode, lotByLotNumber };
}

function extractStrengthFromDisplay(display) {
  const m = String(display || '').match(/(\d+(?:\.\d+)?)\s*(?:microgram|micrograms|mcg)\b/i);
  return m ? m[1] : null;
}

function extractTradenameStrength(concept) {
  const values = [];
  for (const ext of concept.extension || []) {
    if (ext.url && ext.url.includes('nvc-strength') && ext.valueString) values.push(ext.valueString);
  }
  if (!values.length) return extractStrengthFromDisplay(concept.display);
  if (values.length === 1) return values[0];
  const fromDisplay = extractStrengthFromDisplay(concept.display);
  if (fromDisplay) {
    for (const v of values) { if (v === fromDisplay) return v; }
    return fromDisplay;
  }
  return values[0];
}

function extractTradenameGeneric(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url && ext.url.includes('nvc-linked-generic-concept')) {
      const cc = ext.valueCodeableConcept;
      if (cc?.coding?.[0]) return cc.coding[0].display || cc.coding[0].code || null;
    }
  }
  return null;
}

function getPicklistLabel(concept) {
  for (const d of concept.designation || []) {
    if (d.use?.code === 'enPublicPicklist') return d.value;
  }
  return concept.display || null;
}

function getLotTradenameRefs(concept) {
  const refs = [];
  for (const ext of concept.extension || []) {
    if (!ext.url || !ext.url.includes('linked-tradename')) continue;
    const coding = ext.valueCodeableConcept?.coding?.[0] || null;
    if (coding?.code) refs.push({ code: coding.code, display: coding.display || '' });
  }
  return refs;
}

function lookupHbLot(lotNumber, indexes) {
  const lotKey = String(lotNumber).trim().toLowerCase();
  const concept = indexes.lotByLotNumber[lotKey];
  if (!concept) return null;

  const tradenameRefs = getLotTradenameRefs(concept);
  if (!tradenameRefs.length) return null;

  // Build candidates list
  const byCodeCandidates = [];
  for (const ref of tradenameRefs) {
    if (!ref.code) continue;
    const tnConcept = indexes.tradenameByCode[ref.code.toLowerCase()];
    if (tnConcept) byCodeCandidates.push({ ref, concept: tnConcept });
  }
  if (!byCodeCandidates.length) return null;

  // Apply override (GTIN absent in this context, use lot override only)
  const lotOverrideCode = resolveTradenameCodeOverrideByLot(lotNumber);
  const effectiveOverride = lotOverrideCode;

  let resolvedConcept = null;
  if (effectiveOverride) {
    const match = byCodeCandidates.find(({ ref }) => normalizeCodeKey(ref.code) === effectiveOverride);
    if (match) resolvedConcept = match.concept;
  }
  if (!resolvedConcept) resolvedConcept = byCodeCandidates[0].concept;

  return {
    lot_number: lotNumber,
    tradename: getPicklistLabel(resolvedConcept) || '',
    generic_name: extractTradenameGeneric(resolvedConcept) || '',
    strength: extractTradenameStrength(resolvedConcept) || '',
    _resolvedCode: byCodeCandidates.find(c => c.concept === resolvedConcept)?.ref?.code || '',
    _allRefs: tradenameRefs.map(r => r.display),
  };
}

// ---------------------------------------------------------------------------
// Determine expected HB classification from tradename code
// ---------------------------------------------------------------------------

// NVC tradename codes for HB vaccines
const HB_TRADENAME_CODES = {
  '6951000087100': 'HB',           // RECOMBIVAX HB 10 mcg/mL (adult)
  '6941000087103': 'HB-dialysis',  // RECOMBIVAX HB 40 mcg/mL (dialysis)
  '6911000087104': 'HB',           // Engerix B 20 mcg/mL (adult)
  '6921000087107': 'HB-pediatric', // Engerix B 10 mcg/0.5 mL (pediatric)
  '6931000087109': 'HB-pediatric', // RECOMBIVAX HB 5 mcg/0.5 mL (pediatric)
};

function expectedClassification(lot, nvcTnRefs) {
  // With lot override, the override code determines the expected classification
  const lotOverride = resolveTradenameCodeOverrideByLot(lot);
  if (lotOverride && HB_TRADENAME_CODES[lotOverride]) {
    return HB_TRADENAME_CODES[lotOverride];
  }
  // Single-linked lot: the single tradename code is definitive
  if (nvcTnRefs.length === 1) {
    return HB_TRADENAME_CODES[nvcTnRefs[0].toLowerCase()] || null;
  }
  // Dual-linked lot without override: NVC default is first link (pediatric for RECOMBIVAX)
  const firstCode = nvcTnRefs[0]?.toLowerCase();
  return HB_TRADENAME_CODES[firstCode] || null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

if (!bundlePath) {
  test.skip('NVC HB lot integration tests (bundle not found — run scripts/fetch-nvc.sh)', () => {});
} else {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const indexes = buildNvcIndexes(bundle);

  // Collect all HB lots from the bundle
  const hbLots = [];
  for (const entry of bundle.entry || []) {
    const r = entry.resource;
    if (!r || r.resourceType !== 'CodeSystem') continue;
    const idKey = (r.id || '').toLowerCase();
    if (!idKey.includes('lot') && !idKey.includes('batch')) continue;

    for (const concept of r.concept || []) {
      let lotNumber = null;
      for (const prop of concept.property || []) {
        if (prop.code === 'lotNumber' && prop.valueString) { lotNumber = prop.valueString; break; }
      }
      if (!lotNumber) continue;

      const refs = getLotTradenameRefs(concept);
      if (!refs.length) continue;

      const allHb = refs.every(ref => {
        const d = (ref.display || '').toLowerCase();
        return d.includes('hepatitis b') || d.includes('recombivax') || d.includes('engerix') || d.includes('heplisav');
      });
      const anyHb = refs.some(ref => {
        const d = (ref.display || '').toLowerCase();
        return d.includes('hepatitis b') || d.includes('recombivax') || d.includes('engerix') || d.includes('heplisav');
      });
      if (!anyHb) continue;

      hbLots.push({ lotNumber, refs });
    }
  }

  test(`NVC HB lots: found ${hbLots.length} lots to test`, () => {
    assert.ok(hbLots.length > 50, `Expected >50 HB lots, found ${hbLots.length}`);
  });

  // -------------------------------------------------------------------------
  // Test every lot
  // -------------------------------------------------------------------------

  const failures = [];
  const overriddenLots = [];
  const results = { HB: 0, 'HB-pediatric': 0, 'HB-dialysis': 0, ambiguous: 0, unclassified: 0 };

  for (const { lotNumber, refs } of hbLots) {
    const vaccineInfo = lookupHbLot(lotNumber, indexes);
    if (!vaccineInfo) {
      failures.push({ lot: lotNumber, reason: 'lookup returned null' });
      results.unclassified++;
      continue;
    }

    const outputs = getAgentOutputs(vaccineInfo);
    const hbOutputs = ['HB', 'HB-pediatric', 'HB-dialysis'].filter(o => outputs.has(o));

    const refCodes = refs.map(r => r.code);
    const expected = expectedClassification(lotNumber, refCodes);
    const hasOverride = !!resolveTradenameCodeOverrideByLot(lotNumber);
    if (hasOverride) overriddenLots.push(lotNumber);

    if (hbOutputs.length === 0) {
      results.unclassified++;
      failures.push({
        lot: lotNumber,
        expected,
        got: '(none)',
        tradename: vaccineInfo.tradename,
        generic: vaccineInfo.generic_name,
        strength: vaccineInfo.strength,
        refs: vaccineInfo._allRefs,
      });
    } else if (hbOutputs.length > 1) {
      // Multiple HB outputs: only a problem if HB-pediatric and HB both fire
      const hasBoth = hbOutputs.includes('HB') && hbOutputs.includes('HB-pediatric');
      if (hasBoth) {
        results.ambiguous++;
        failures.push({
          lot: lotNumber,
          expected,
          got: hbOutputs.join('+'),
          tradename: vaccineInfo.tradename,
          generic: vaccineInfo.generic_name,
          strength: vaccineInfo.strength,
          refs: vaccineInfo._allRefs,
        });
      } else {
        // e.g. HB-dialysis appearing alongside something else — not a conflict
        const primary = hbOutputs[0];
        results[primary] = (results[primary] || 0) + 1;
      }
    } else {
      const got = hbOutputs[0];
      results[got] = (results[got] || 0) + 1;
      if (expected && got !== expected) {
        failures.push({
          lot: lotNumber,
          expected,
          got,
          tradename: vaccineInfo.tradename,
          generic: vaccineInfo.generic_name,
          strength: vaccineInfo.strength,
          refs: vaccineInfo._allRefs,
          overridden: hasOverride,
        });
      }
    }
  }

  // Print summary
  test('NVC HB lots: classification summary (informational)', () => {
    console.log('\n  Classification results:');
    console.log(`    HB (adult):     ${results['HB']}`);
    console.log(`    HB-pediatric:   ${results['HB-pediatric']}`);
    console.log(`    HB-dialysis:    ${results['HB-dialysis']}`);
    console.log(`    Ambiguous:      ${results.ambiguous}`);
    console.log(`    Unclassified:   ${results.unclassified}`);
    console.log(`    Lot overrides applied: ${overriddenLots.join(', ') || '(none)'}`);
    assert.ok(true); // always passes — informational only
  });

  test('NVC HB lots: overridden adult lots (Y020519, Y016312) classify as HB', () => {
    for (const lot of ['Y020519', 'Y016312']) {
      const info = lookupHbLot(lot, indexes);
      assert.ok(info, `${lot}: lookup must succeed`);
      const outputs = getAgentOutputs(info);
      assert.equal(outputs.has('HB'), true, `${lot}: expected HB adult, got ${[...outputs]}`);
      assert.equal(outputs.has('HB-pediatric'), false, `${lot}: must NOT classify as HB-pediatric`);
    }
  });

  test('NVC HB lots: no lot produces both HB and HB-pediatric simultaneously', () => {
    const conflicts = failures.filter(f => f.got && f.got.includes('+'));
    if (conflicts.length > 0) {
      console.log('\n  Conflicting lots:');
      for (const f of conflicts) {
        console.log(`    ${f.lot}: ${f.tradename} / generic: ${f.generic} / strength: ${f.strength}`);
        console.log(`      NVC refs: ${(f.refs || []).join(' | ')}`);
      }
    }
    assert.equal(
      conflicts.length, 0,
      `${conflicts.length} lot(s) classified as both HB and HB-pediatric simultaneously`
    );
  });

  test('NVC HB lots: all lots produce exactly one HB classification', () => {
    const unclassified = failures.filter(f => f.got === '(none)');
    if (unclassified.length > 0) {
      console.log('\n  Unclassified lots:');
      for (const f of unclassified) {
        console.log(`    ${f.lot}: tradename="${f.tradename}" generic="${f.generic}" strength="${f.strength}"`);
        console.log(`      NVC refs: ${(f.refs || []).join(' | ')}`);
      }
    }
    assert.equal(
      unclassified.length, 0,
      `${unclassified.length} lot(s) produced no HB classification`
    );
  });

  test('NVC HB lots: Engerix B lots classified correctly (pediatric vs adult)', () => {
    const engerixFailures = failures.filter(f => {
      const info = lookupHbLot(f.lot, indexes);
      return info && (info.tradename || '').toLowerCase().includes('engerix');
    });
    if (engerixFailures.length > 0) {
      console.log('\n  Engerix B classification failures:');
      for (const f of engerixFailures) {
        console.log(`    ${f.lot}: expected=${f.expected} got=${f.got} strength=${f.strength}`);
        console.log(`      NVC refs: ${(f.refs || []).join(' | ')}`);
      }
    }
    assert.equal(engerixFailures.length, 0, `${engerixFailures.length} Engerix B lot(s) misclassified`);
  });

  test('NVC HB lots: RECOMBIVAX dialysis lots classified as HB-dialysis', () => {
    const dialysisLots = hbLots.filter(l =>
      l.refs.some(r => (r.display || '').toLowerCase().includes('dialysis'))
    );
    for (const { lotNumber } of dialysisLots) {
      const info = lookupHbLot(lotNumber, indexes);
      assert.ok(info, `${lotNumber}: dialysis lot lookup must succeed`);
      const outputs = getAgentOutputs(info);
      assert.equal(
        outputs.has('HB-dialysis'), true,
        `${lotNumber}: dialysis lot must classify as HB-dialysis, got ${[...outputs]}`
      );
      assert.equal(outputs.has('HB'), false, `${lotNumber}: dialysis must NOT also be HB`);
      assert.equal(outputs.has('HB-pediatric'), false, `${lotNumber}: dialysis must NOT be HB-pediatric`);
    }
  });

  test('NVC HB lots: single-linked Engerix B pediatric lots all classify as HB-pediatric', () => {
    const peds = hbLots.filter(l =>
      l.refs.length === 1 &&
      (l.refs[0].display || '').toLowerCase().includes('engerix') &&
      (l.refs[0].display || '').toLowerCase().includes('pediatric')
    );
    assert.ok(peds.length > 0, 'Expected at least one single-linked Engerix B pediatric lot in NVC');
    for (const { lotNumber } of peds) {
      const info = lookupHbLot(lotNumber, indexes);
      assert.ok(info, `${lotNumber}: lookup must succeed`);
      const outputs = getAgentOutputs(info);
      assert.equal(outputs.has('HB-pediatric'), true,
        `${lotNumber}: single-linked Engerix B pediatric must classify as HB-pediatric, got ${[...outputs]}`);
      assert.equal(outputs.has('HB'), false,
        `${lotNumber}: single-linked Engerix B pediatric must NOT classify as HB`);
    }
  });

  test('NVC HB lots: single-linked Engerix B adult lots all classify as HB', () => {
    const adults = hbLots.filter(l =>
      l.refs.length === 1 &&
      (l.refs[0].display || '').toLowerCase().includes('engerix') &&
      !(l.refs[0].display || '').toLowerCase().includes('pediatric') &&
      !(l.refs[0].display || '').toLowerCase().includes('dialysis')
    );
    assert.ok(adults.length > 0, 'Expected at least one single-linked Engerix B adult lot in NVC');
    for (const { lotNumber } of adults) {
      const info = lookupHbLot(lotNumber, indexes);
      assert.ok(info, `${lotNumber}: lookup must succeed`);
      const outputs = getAgentOutputs(info);
      assert.equal(outputs.has('HB'), true,
        `${lotNumber}: single-linked Engerix B adult must classify as HB, got ${[...outputs]}`);
      assert.equal(outputs.has('HB-pediatric'), false,
        `${lotNumber}: single-linked Engerix B adult must NOT classify as HB-pediatric`);
    }
  });
}
