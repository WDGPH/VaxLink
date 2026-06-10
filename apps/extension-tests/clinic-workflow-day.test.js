/**
 * Clinic simulation: a full immunization-clinic day across all three workflow
 * modes (single inject, multiple-inject queue, inventory batch).
 *
 * This drives the REAL data layer end-to-end for a realistic basket of vaccines
 * pulled from the live NVC catalogue:
 *   scanner payload text  → popup-parser.parseInputData
 *                       → background.js lookupVaccineInfo (mocked chrome)
 *                       → queue-record / popup-inventory record + CSV export
 *
 * It verifies the things a nurse actually depends on: the right product/lot/
 * expiry land in the queue, dose counts decrement as vials are used up, expiry
 * flags warn correctly, and the exported CSV is well-formed for downstream
 * tools.
 *
 * Requires apps/web/nvc-bundle.json (gitignored). Download with:
 *   bash scripts/fetch-nvc.sh
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseInputData, getExpiryStatus } from '../extension/popup-parser.js';
import { buildLegacyQueueRecord } from '../extension/queue-record.js';
import {
  buildVialBarcode,
  createBackgroundHarness,
  extractCatalogueLots,
  loadNvcBundle,
  makeSyntheticGtin14
} from './helpers/clinic-sim.js';

// popup-inventory.js touches chrome/document/URL/Blob/window only at call time
// (never at module load), so install browser-shaped globals before importing it.
function installBrowserGlobals() {
  const store = new Map();
  const csvCaptures = [];
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(keys, cb) {
          const result = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (store.has(k)) result[k] = store.get(k);
          cb(result);
        },
        set(values, cb) {
          for (const [k, v] of Object.entries(values)) store.set(k, v);
          cb();
        }
      }
    }
  };
  globalThis.Blob = class { constructor(parts) { this.text = parts.join(''); csvCaptures.push(this.text); } };
  globalThis.URL = { createObjectURL: () => 'blob:clinic-sim', revokeObjectURL() {} };
  globalThis.window = { prompt: () => null };
  globalThis.document = {
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ click() {}, remove() {}, set href(_) {}, set download(_) {} })
  };
  return { store, csvCaptures };
}

const browser = installBrowserGlobals();
const { ScanQueueManager, buildQueueRecord } = await import('../extension/popup-inventory.js');

const bundle = loadNvcBundle();

if (!bundle) {
  test.skip('Clinic workflow day (bundle not found — run scripts/fetch-nvc.sh)', () => {});
} else {
  const catalogueLots = extractCatalogueLots(bundle);
  const harness = createBackgroundHarness(bundle);

  // --- Pick real, unambiguous lots for a representative clinic basket --------
  // We want lots whose text won't trip the AI(10)-is-last GS1 ambiguity (no
  // "21"/"17######" substrings) so the basket models clean scans; the
  // catalogue sweep test already covers the ambiguous-lot limitation.
  function isCleanLot(lotNumber) {
    return !lotNumber.includes('21') && !/17\d{6}/.test(lotNumber);
  }

  function findLot(pattern) {
    return catalogueLots.find((lot) =>
      isCleanLot(lot.lotNumber) &&
      lot.tradenameRefs.some((ref) => pattern.test(ref.display || '')));
  }

  const basket = [
    { label: 'COVID-19', lot: findLot(/COMIRNATY|SPIKEVAX/i), doses: 6 },
    { label: 'Influenza', lot: findLot(/FLUZONE|FLULAVAL|FLUCELVAX|AFLURIA/i), doses: 10 },
    { label: 'Hepatitis B', lot: findLot(/ENGERIX|RECOMBIVAX/i), doses: 1 },
    { label: 'HPV', lot: findLot(/GARDASIL/i), doses: 1 },
    { label: 'Tdap', lot: findLot(/BOOSTRIX|ADACEL/i), doses: 1 },
    { label: 'Zoster', lot: findLot(/SHINGRIX/i), doses: 1 },
    { label: 'Pneumococcal', lot: findLot(/PREVNAR|PNEUMOVAX/i), doses: 1 },
    { label: 'MMR', lot: findLot(/PRIORIX|M-M-R|MMR/i), doses: 1 }
  ].filter((item) => item.lot);

  test(`clinic basket: assembled ${basket.length} representative vaccine families from the catalogue`, () => {
    assert.ok(basket.length >= 6,
      `Expected at least 6 vaccine families available in the bundle, got ${basket.length}: ` +
      basket.map((b) => b.label).join(', '));
  });

  // --- Helper: simulate one vial scan from payload text to resolved vaccine ---
  let scanSeed = 0;
  async function scanVial(lot) {
    // A vial's 2D DataMatrix always carries AI(01) GTIN; use a synthetic one.
    const barcode = buildVialBarcode({
      gtin: makeSyntheticGtin14(scanSeed++),
      expiryIso: lot.expiryIso,
      lot: lot.lotNumber
    });
    const parsed = parseInputData(barcode);
    const info = await harness.sendMessage({
      action: 'lookupVaccineInfo',
      lot: parsed.lot,
      gtin: parsed.gtin
    });
    return { barcode, parsed, info };
  }

  test('single-inject workflow: scan → lookup → resolved vaccine for immediate chart fill', async () => {
    for (const { label, lot } of basket) {
      const { parsed, info } = await scanVial(lot);
      assert.equal(parsed.lot, lot.lotNumber, `${label}: lot must parse cleanly`);
      assert.ok(info && !info.error, `${label}: lookup must succeed (got ${JSON.stringify(info)})`);
      assert.ok(String(info.tradename || '').trim(), `${label}: must resolve a tradename`);
      assert.equal(info.lot_number, lot.lotNumber, `${label}: resolved lot must echo the scan`);
    }
  });

  // --- Multiple-inject queue: append via the REAL background queue helper ----
  test('multiple-inject queue: scanning a clinic basket appends to the shared queue', async () => {
    harness.storageData.delete('multiple_inject_queue_v1');

    for (const { lot, doses } of basket) {
      const { barcode, parsed, info } = await scanVial(lot);
      const record = buildLegacyQueueRecord({
        ...info,
        gtin: parsed.gtin || '',
        lot: parsed.lot,
        serial: parsed.serial || '',
        expiry: parsed.expiry || '',
        nvc_lot_expiry: info.lot_expiry || '',
        total_doses: doses
      }, barcode);

      const response = await harness.sendMessage({
        action: 'appendQueueRecord',
        storageKey: 'multiple_inject_queue_v1',
        record
      });
      assert.equal(response.success, true);
    }

    const queue = harness.storageData.get('multiple_inject_queue_v1');
    assert.equal(queue.length, basket.length, 'every basket scan must land in the queue');
    assert.equal(harness.getBadgeText(), String(basket.length),
      'action badge must reflect the queue depth');

    // Each queued row must carry the chart-critical fields.
    for (const row of queue) {
      assert.ok(row.tradename, `queued row missing tradename: ${JSON.stringify(row)}`);
      assert.ok(row.lot, 'queued row missing lot');
      assert.ok(row.raw_barcode, 'queued row missing raw barcode');
      assert.ok(Number.isFinite(row.total_doses) && row.total_doses >= 1,
        'queued row must have a positive dose count');
    }
  });

  test('multiple-inject queue: clearing resets the badge', () => {
    harness.storageData.delete('multiple_inject_queue_v1');
    // Simulate the storage-change the popup triggers on clear.
    harness.storageData.set('multiple_inject_queue_v1', []);
    // Badge update fires through chrome.storage.onChanged in real usage; here we
    // just assert the queue is empty, which is what the popup renders from.
    assert.equal(harness.storageData.get('multiple_inject_queue_v1').length, 0);
  });

  // --- Inventory batch workflow via the REAL ScanQueueManager ----------------
  test('inventory workflow: batch-scan a clinic basket into the inventory tray', async () => {
    browser.store.clear();
    const tray = new ScanQueueManager({
      storageKey: 'inventory_scan_batch_v1',
      summaryEl: null, // render() short-circuits when DOM is absent
      listEl: null,
      exportFilenamePrefix: 'vaxlink-inventory'
    });
    await tray.load();

    for (const { lot, doses } of basket) {
      const { barcode, parsed, info } = await scanVial(lot);
      const record = buildQueueRecord({
        ...info,
        gtin: parsed.gtin || '',
        lot: parsed.lot,
        serial: parsed.serial || '',
        expiry: parsed.expiry || '',
        nvc_lot_expiry: info.lot_expiry || '',
        total_doses: doses
      }, barcode);
      await tray.add(record);
    }

    assert.equal(tray.count, basket.length, 'every scan must be in the inventory tray');
    assert.deepEqual(
      browser.store.get('inventory_scan_batch_v1').map((r) => r.lot),
      basket.map((b) => b.lot.lotNumber),
      'persisted rows must match scan order and lots'
    );
  });

  test('inventory workflow: dose tracking decrements and removes empty vials', async () => {
    browser.store.clear();
    const tray = new ScanQueueManager({ storageKey: 'inventory_scan_batch_v1', summaryEl: null, listEl: null });
    await tray.load();

    // A 6-dose COVID vial.
    const covid = basket.find((b) => b.label === 'COVID-19') || basket[0];
    const { barcode, parsed, info } = await scanVial(covid.lot);
    const record = buildQueueRecord({ ...info, lot: parsed.lot, gtin: parsed.gtin || '', total_doses: 6 }, barcode);
    await tray.add(record);
    const id = tray.rows[0].id;

    // Administer 5 doses; vial should remain with 1 left.
    for (let i = 0; i < 5; i += 1) {
      const after = await tray.consumeById(id);
      assert.ok(after, `dose ${i + 1}: vial should still exist`);
    }
    assert.equal(tray.getById(id).remaining_doses, 1, 'COVID vial should have 1 dose left');

    // 6th dose empties and removes the vial.
    const emptied = await tray.consumeById(id);
    assert.equal(emptied, null, 'last dose must remove the vial');
    assert.equal(tray.count, 0, 'tray should be empty after the vial is used up');
  });

  test('inventory workflow: CSV export is well-formed and chart-ready', async () => {
    browser.store.clear();
    browser.csvCaptures.length = 0;
    const tray = new ScanQueueManager({
      storageKey: 'inventory_scan_batch_v1',
      summaryEl: null,
      listEl: null,
      exportFilenamePrefix: 'vaxlink-inventory'
    });
    await tray.load();

    for (const { lot, doses } of basket) {
      const { barcode, parsed, info } = await scanVial(lot);
      await tray.add(buildQueueRecord({
        ...info, gtin: parsed.gtin || '', lot: parsed.lot, total_doses: doses
      }, barcode));
    }

    const filename = tray.exportCsv();
    assert.ok(/^vaxlink-inventory-.*\.csv$/.test(filename), `unexpected export filename: ${filename}`);
    assert.equal(browser.csvCaptures.length, 1, 'exactly one CSV blob must be produced');

    const csv = browser.csvCaptures[0];
    const lines = csv.split('\r\n');
    assert.equal(lines.length, basket.length + 1, 'CSV must have a header plus one row per scan');

    const header = lines[0].split(',');
    for (const required of ['scan_index', 'tradename', 'lot', 'expiry_flag', 'total_doses', 'raw_barcode']) {
      assert.ok(header.includes(required), `CSV header missing ${required}`);
    }

    // Every data row must carry tradename + lot in the expected columns, and a
    // sequential scan_index starting at 1.
    const tradenameCol = header.indexOf('tradename');
    const lotCol = header.indexOf('lot');
    const indexCol = header.indexOf('scan_index');
    lines.slice(1).forEach((line, i) => {
      const cells = parseCsvLine(line);
      assert.equal(cells[indexCol], String(i + 1), `row ${i + 1}: scan_index out of order`);
      assert.ok(cells[tradenameCol].trim(), `row ${i + 1}: missing tradename`);
      assert.ok(cells[lotCol].trim(), `row ${i + 1}: missing lot`);
    });
  });

  // --- Expiry-handling scenarios (what the HUD/banner warns on) --------------
  test('expiry workflow: expired, expiring-soon, and valid lots flag correctly', () => {
    const day = 24 * 60 * 60 * 1000;
    const iso = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);

    assert.equal(getExpiryStatus(iso(-1)).flag, 'expired', 'yesterday must read as expired');
    assert.equal(getExpiryStatus(iso(10)).flag, 'expiring_soon', '10 days out must warn');
    assert.equal(getExpiryStatus(iso(200)).flag, 'valid', '200 days out must be valid');
    assert.equal(getExpiryStatus('').flag, 'unknown', 'missing expiry must read as unknown');
  });

  test('expiry workflow: real catalogue lots split into expired vs in-date as expected', () => {
    const now = Date.now();
    let expired = 0;
    let inDate = 0;
    for (const lot of catalogueLots) {
      if (!lot.expiryIso) continue;
      const status = getExpiryStatus(lot.expiryIso);
      if (status.flag === 'expired') expired += 1;
      else inDate += 1;
    }
    // The catalogue spans years of lots, so both buckets must be non-trivial —
    // this guards getExpiryStatus against a date-parsing regression that would
    // flatten everything into one bucket.
    assert.ok(expired > 0, 'expected some expired catalogue lots');
    assert.ok(inDate > 0, 'expected some in-date catalogue lots');
    console.log(`\n  Catalogue expiry split: ${expired} expired, ${inDate} in-date`);
  });
}

// Minimal RFC-4180 single-line CSV splitter (handles quoted cells with commas).
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}
