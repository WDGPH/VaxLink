/**
 * Clinic simulation: scan EVERY vaccine lot in the NVC catalogue.
 *
 * For each of the ~4k lots in the live NVC FHIR bundle this suite synthesizes
 * the GS1 DataMatrix payload a nurse's scanner would emit
 * (01 GTIN / 17 expiry / 10 lot), runs it through the real popup parser
 * (popup-parser.js), then resolves it through the REAL background.js lookup
 * pipeline (evaluated under a mocked chrome API with the bundle cached in
 * storage, exactly like a synced production install).
 *
 * Requires apps/web/nvc-bundle.json (gitignored). Download with:
 *   bash scripts/fetch-nvc.sh
 * The whole file is skipped when the bundle is absent so CI stays green.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseInputData } from '../extension/popup-parser.js';
import {
  buildVialBarcode,
  createBackgroundHarness,
  extractCatalogueLots,
  getAgentOutputs,
  loadNvcBundle,
  makeSyntheticGtin14
} from './helpers/clinic-sim.js';

const bundle = loadNvcBundle();

if (!bundle) {
  test.skip('NVC catalogue clinic sweep (bundle not found — run scripts/fetch-nvc.sh)', () => {});
} else {
  const allLots = extractCatalogueLots(bundle);

  // The lot index in background.js is last-wins per lot number; mirror that so
  // expectations match what a clinic scan can actually resolve.
  const lotByKey = new Map();
  for (const lot of allLots) {
    lotByKey.set(lot.lotNumber.toLowerCase(), lot);
  }
  const uniqueLots = [...lotByKey.values()];

  // A lot number can only confuse the no-GS GS1 heuristic when its own text
  // contains something that looks like a follow-on AI: "21" (serial) or "17"
  // followed by six digits (expiry).
  const isPredictedAmbiguous = (lotNumber) =>
    lotNumber.includes('21') || /17\d{6}/.test(lotNumber);

  const harness = createBackgroundHarness(bundle);

  // Shared sweep results, populated by the first test and asserted on by the
  // rest (node:test runs tests in this file sequentially).
  const sweep = {
    parsedExact: [],     // { lot, parsed, barcode }
    parsedSplit: [],     // { lot, parsed } — lot text misread as lot+serial
    parseErrors: [],     // { lot, error }
    lookupOk: [],        // { lot, info }
    lookupFailures: []   // { lot, response, reason }
  };

  test(`catalogue sweep: bundle exposes the full lot catalogue (${uniqueLots.length} unique lots)`, () => {
    assert.ok(allLots.length > 3000, `Expected >3000 catalogue lots, found ${allLots.length}`);
    assert.ok(uniqueLots.length > 3000, `Expected >3000 unique lot numbers, found ${uniqueLots.length}`);
  });

  test('catalogue sweep: every vial barcode parses, and only AI-lookalike lots split', () => {
    for (const [index, lot] of uniqueLots.entries()) {
      const barcode = buildVialBarcode({
        gtin: makeSyntheticGtin14(index),
        expiryIso: lot.expiryIso,
        lot: lot.lotNumber
      });

      let parsed;
      try {
        parsed = parseInputData(barcode);
      } catch (error) {
        sweep.parseErrors.push({ lot, error: error.message });
        continue;
      }

      if (parsed.lot === lot.lotNumber) {
        sweep.parsedExact.push({ lot, parsed, barcode });
      } else {
        sweep.parsedSplit.push({ lot, parsed });
      }
    }

    console.log(`\n  Parse sweep: ${sweep.parsedExact.length} exact, ` +
      `${sweep.parsedSplit.length} split into lot+serial, ${sweep.parseErrors.length} errors`);

    assert.equal(sweep.parseErrors.length, 0,
      `Parser threw on ${sweep.parseErrors.length} lot(s): ` +
      sweep.parseErrors.slice(0, 5).map((f) => `${f.lot.lotNumber}: ${f.error}`).join('; '));

    // Every split must be explained by AI-lookalike text inside the lot number.
    const unexplained = sweep.parsedSplit.filter(({ lot }) => !isPredictedAmbiguous(lot.lotNumber));
    assert.equal(unexplained.length, 0,
      `${unexplained.length} lot(s) misparsed without containing an AI lookalike: ` +
      unexplained.slice(0, 10).map((f) => f.lot.lotNumber).join(', '));

    // And every lot WITHOUT AI-lookalike text must round-trip exactly.
    const cleanMisses = uniqueLots.filter((lot) => !isPredictedAmbiguous(lot.lotNumber)).length -
      sweep.parsedExact.filter(({ lot }) => !isPredictedAmbiguous(lot.lotNumber)).length;
    assert.equal(cleanMisses, 0, `${cleanMisses} clean lot(s) failed to round-trip`);
  });

  test('catalogue sweep: KNOWN LIMITATION — lots containing "21"/"17…" misparse when AI(10) is last', () => {
    // Real-world impact: a barcode like 01…17…10 042D21A (Moderna-style lot,
    // no trailing serial) is split into lot "042D" + serial "A", so the NVC
    // lookup misses. This documents the current behavior and alerts on growth.
    const splitRate = sweep.parsedSplit.length / uniqueLots.length;
    const notExpired = sweep.parsedSplit.filter(({ lot }) =>
      lot.expiryIso && new Date(lot.expiryIso) >= new Date());

    console.log(`\n  Ambiguous lots: ${sweep.parsedSplit.length}/${uniqueLots.length} ` +
      `(${(splitRate * 100).toFixed(1)}%), ${notExpired.length} not yet expired:`);
    for (const { lot, parsed } of notExpired.slice(0, 20)) {
      console.log(`    ${lot.lotNumber} → lot="${parsed.lot}" serial="${parsed.serial}" ` +
        `(${lot.tradenameRefs[0]?.display || 'unknown product'})`);
    }

    assert.ok(splitRate < 0.10,
      `Ambiguous-lot rate ${(splitRate * 100).toFixed(1)}% exceeds 10% of the catalogue`);

    // When a serial DOES follow the lot after a GS separator, even ambiguous
    // lots parse exactly — verify on every ambiguous lot.
    for (const { lot } of sweep.parsedSplit) {
      const withSerial = buildVialBarcode({
        gtin: makeSyntheticGtin14(7),
        expiryIso: lot.expiryIso,
        lot: lot.lotNumber,
        serial: 'S0001'
      });
      const parsed = parseInputData(withSerial);
      assert.equal(parsed.lot, lot.lotNumber,
        `${lot.lotNumber}: must parse exactly when GS+serial terminates the lot field`);
      assert.equal(parsed.serial, 'S0001');
    }
  });

  test('catalogue sweep: every exactly-parsed lot resolves through the real background pipeline', async () => {
    for (const { lot, parsed } of sweep.parsedExact) {
      const response = await harness.sendMessage({
        action: 'lookupVaccineInfo',
        lot: parsed.lot,
        gtin: parsed.gtin
      });

      if (!response || response.error) {
        sweep.lookupFailures.push({ lot, response, reason: response?.error || 'empty response' });
        continue;
      }
      if (String(response.lot_number || '').toLowerCase() !== lot.lotNumber.toLowerCase()) {
        sweep.lookupFailures.push({ lot, response, reason: `lot_number mismatch: ${response.lot_number}` });
        continue;
      }
      if (lot.expiryIso && response.lot_expiry !== lot.expiryIso) {
        sweep.lookupFailures.push({ lot, response, reason: `expiry mismatch: ${response.lot_expiry} != ${lot.expiryIso}` });
        continue;
      }
      sweep.lookupOk.push({ lot, info: response });
    }

    console.log(`\n  Lookup sweep: ${sweep.lookupOk.length} resolved, ${sweep.lookupFailures.length} failed`);
    if (sweep.lookupFailures.length) {
      for (const f of sweep.lookupFailures.slice(0, 10)) {
        console.log(`    ${f.lot.lotNumber}: ${f.reason}`);
      }
    }
    assert.equal(sweep.lookupFailures.length, 0,
      `${sweep.lookupFailures.length} lot(s) failed NVC lookup after an exact parse`);
  });

  test('catalogue sweep: every resolved lot carries a usable tradename for charting', () => {
    const missingTradename = sweep.lookupOk.filter(({ info }) => !String(info.tradename || '').trim());
    if (missingTradename.length) {
      console.log('\n  Lots without tradename:');
      for (const { lot } of missingTradename.slice(0, 10)) {
        console.log(`    ${lot.lotNumber} (refs: ${lot.tradenameRefs.map((r) => r.display).join(' | ')})`);
      }
    }
    assert.equal(missingTradename.length, 0,
      `${missingTradename.length} resolved lot(s) have no tradename`);
  });

  test('catalogue sweep: Panorama agent classification coverage across the catalogue', () => {
    let classified = 0;
    const unmatchedByProduct = new Map();

    for (const { lot, info } of sweep.lookupOk) {
      const outputs = getAgentOutputs(info);
      if (outputs.size > 0) {
        classified += 1;
      } else {
        const label = info.tradename || lot.tradenameRefs[0]?.display || lot.lotNumber;
        unmatchedByProduct.set(label, (unmatchedByProduct.get(label) || 0) + 1);
      }
    }

    const rate = classified / Math.max(sweep.lookupOk.length, 1);
    console.log(`\n  Agent classification: ${classified}/${sweep.lookupOk.length} ` +
      `(${(rate * 100).toFixed(1)}%) lots map to at least one Panorama agent`);
    if (unmatchedByProduct.size) {
      console.log('  Products with no agent rule match:');
      const sorted = [...unmatchedByProduct.entries()].sort((a, b) => b[1] - a[1]);
      for (const [label, count] of sorted.slice(0, 25)) {
        console.log(`    ${count} lot(s): ${label}`);
      }
    }

    assert.ok(rate >= 0.75,
      `Only ${(rate * 100).toFixed(1)}% of resolved lots map to a Panorama agent (floor 75%)`);
  });

  test('catalogue sweep: core clinic vaccine families always classify to an agent', () => {
    const FAMILY_PATTERNS = [
      [/comirnaty|pfizer.*covid|spikevax|moderna.*covid/i, 'COVID-19'],
      [/engerix|recombivax/i, 'hepatitis B'],
      [/fluzone|flulaval|fluad|flucelvax|afluria|influvac/i, 'influenza'],
      [/gardasil/i, 'HPV'],
      [/shingrix/i, 'zoster'],
      [/prevnar|pneumovax/i, 'pneumococcal']
    ];

    const failures = [];
    for (const { lot, info } of sweep.lookupOk) {
      const label = `${info.tradename || ''} ${info.generic_name || ''}`;
      const family = FAMILY_PATTERNS.find(([pattern]) => pattern.test(label));
      if (!family) continue;
      if (getAgentOutputs(info).size === 0) {
        failures.push({ lot: lot.lotNumber, family: family[1], tradename: info.tradename });
      }
    }

    if (failures.length) {
      console.log('\n  Core-family lots without an agent match:');
      for (const f of failures.slice(0, 15)) {
        console.log(`    ${f.lot}: [${f.family}] ${f.tradename}`);
      }
    }
    assert.equal(failures.length, 0,
      `${failures.length} core-family lot(s) failed Panorama agent classification`);
  });

  test('catalogue sweep: no standalone Hep B lot fires both HB and HB-pediatric (ped/adult never cross-fire)', () => {
    const STANDALONE_HB = /engerix|recombivax|heplisav/i;
    const crossFires = [];
    for (const { lot, info } of sweep.lookupOk) {
      if (!STANDALONE_HB.test(info.tradename || '')) continue;
      const outputs = getAgentOutputs(info);
      const hb = ['HB', 'HB-pediatric', 'HB-dialysis'].filter((o) => outputs.has(o));
      // A standalone Hep B vial must resolve to exactly ONE of adult/ped/dialysis.
      if (hb.length !== 1) {
        crossFires.push({ lot: lot.lotNumber, tradename: info.tradename, strength: info.strength, hb });
      }
    }
    if (crossFires.length) {
      console.log('\n  Standalone HB lots with ambiguous ped/adult/dialysis classification:');
      for (const f of crossFires.slice(0, 15)) {
        console.log(`    ${f.lot}: ${f.tradename} (strength ${f.strength}) → ${f.hb.join('+')}`);
      }
    }
    assert.equal(crossFires.length, 0,
      `${crossFires.length} standalone Hep B lot(s) did not resolve to exactly one HB agent`);
  });

  test('catalogue sweep: combo HB-containing products only emit HB-pediatric as a NON-leading fallback', () => {
    // KNOWN over-match: the loose 3-token rule match (["hepatitis","b","pediatric"]
    // all present) makes pediatric COMBO products that contain Hep B antigen
    // (INFANRIX hexa, Twinrix Junior) also emit the standalone HB-pediatric agent.
    // This is harmless because content.js getPanoramaAgentCandidates() tries the
    // tradename and the CORRECT combo agent BEFORE HB-pediatric, so the live
    // Panorama dropdown selects the right agent. This test guards two invariants:
    //   1. the over-match set stays limited to known combo products, and
    //   2. HB-pediatric is never the first rule output for them.
    const STANDALONE_HB = /engerix|recombivax|heplisav/i;
    const KNOWN_COMBO_OVERMATCH = [/INFANRIX hexa/i, /Twinrix Junior/i];

    const offenders = new Map(); // tradename → first rule output seen
    for (const { info } of sweep.lookupOk) {
      const tradename = info.tradename || '';
      if (STANDALONE_HB.test(tradename)) continue;
      const outputs = [...getAgentOutputs(info)];
      if (!outputs.some((o) => /^HB/.test(o))) continue;
      if (!offenders.has(tradename)) offenders.set(tradename, outputs[0]);
    }

    // Every over-matching product must be a known pediatric combo.
    for (const tradename of offenders.keys()) {
      assert.ok(KNOWN_COMBO_OVERMATCH.some((p) => p.test(tradename)),
        `Unexpected product emits an HB* agent: "${tradename}". ` +
        `If this is a new combo product, add it to KNOWN_COMBO_OVERMATCH; ` +
        `if it is a wrong-agent bug, tighten the HB rules in panorama-agent-rules.js.`);
    }

    // And HB-pediatric must never lead the candidate list for them.
    for (const [tradename, firstOutput] of offenders) {
      assert.notEqual(firstOutput, 'HB-pediatric',
        `${tradename}: HB-pediatric must not be the first agent candidate (got "${firstOutput}")`);
      assert.ok(!/^HB/.test(firstOutput),
        `${tradename}: a standalone HB* agent must not lead (got "${firstOutput}")`);
    }

    console.log(`\n  Combo HB over-match (benign, dropdown-disambiguated): ` +
      [...offenders.entries()].map(([t, o]) => `${t} → leads with ${o}`).join('; '));
  });
}
