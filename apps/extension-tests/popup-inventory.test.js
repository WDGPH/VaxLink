import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ScanQueueManager,
  buildInventorySummary,
  buildMultipleInjectSummary,
  buildQueueRecord
} from '../extension/popup-inventory.js';

test('buildQueueRecord preserves popup inventory export fields', () => {
  const row = buildQueueRecord(
    {
      scanned_at: '2026-04-01T12:00:00.000Z',
      name: 'Comirnaty',
      tradename: 'Comirnaty',
      generic_name: 'COVID-19 mRNA',
      manufacturer: 'Pfizer',
      gtin: '00012345678901',
      lot: 'LOT-123',
      serial: 'SER-1',
      barcode_expiry: '2099-12-31',
      inventory_expiry: '2099-12-31',
      total_doses: '5',
      din: 'DIN-001',
      dose_value: '0.3',
      dose_unit: 'mL'
    },
    '01000123456789011799123110LOT-12321SER-1'
  );

  assert.equal(row.raw_barcode, '01000123456789011799123110LOT-12321SER-1');
  assert.equal(row.name, 'Comirnaty');
  assert.equal(row.total_doses, 5);
  assert.equal(row.remaining_doses, 5);
  assert.equal(row.drug_code, 'DIN-001');
  assert.equal(row.expiry_flag, 'valid');
  assert.equal(row.expiry_days_remaining > 0, true);
});

test('build summary helpers report counts, doses, and expiry flags', () => {
  const rows = [
    { remaining_doses: 2, expiry_flag: 'expired' },
    { remaining_doses: 1, expiry_flag: 'expiring_soon' }
  ];

  assert.equal(
    buildMultipleInjectSummary(rows),
    '2 vaccine(s) saved for later chart fill. 3 dose(s) remaining across all vials. 1 expired, 1 expiring soon.'
  );
  assert.equal(
    buildInventorySummary(rows),
    '2 scan(s) ready for inventory export. 3 dose(s) remaining across all vials. 1 expired, 1 expiring soon.'
  );
});

test('multiple summary identifies scans captured while the workstation was locked', () => {
  const summary = buildMultipleInjectSummary([
    { captured_while_locked: true },
    { captured_while_locked: true },
    {}
  ]);
  assert.match(summary, /3 vaccine\(s\) saved/);
  assert.match(summary, /2 captured while the workstation was locked/);
});

test('saved rows offer an NVC draft only for a confirmed catalogue miss', () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { storage: { onChanged: { addListener() {} } } };
  try {
    const list = { querySelectorAll: () => [] };
    const manager = new ScanQueueManager({
      storageKey: 'inventory_scan_batch_v1',
      listEl: list,
      summaryEl: {}
    });
    const sample = {
      lot: 'TRAINING&LOT',
      gtin: '00012345678901',
      barcode_expiry: '2099-01-31',
      serial: 'OMIT-SERIAL',
      nvc_catalogue_version: '1.138'
    };
    manager.rows = [
      'initializing',
      'unavailable',
      'incomplete',
      'not_found'
    ].map((category) =>
      buildQueueRecord(
        {
          ...sample,
          lookup_error_category: category,
          lookup_error: category
        },
        'OMIT-RAW-BARCODE'
      )
    );
    manager.render();
    const links = Array.from(list.innerHTML.matchAll(/href="(mailto:[^"]+)"/g));
    assert.equal(links.length, 1);
    const draft = new URL(links[0][1].replaceAll('&amp;', '&'));
    assert.equal(draft.pathname, 'NVC-CNV@phac-aspc.gc.ca');
    assert.equal(draft.searchParams.get('cc'), 'innovation@wdgpublichealth.ca');
    assert.equal(
      draft.searchParams.get('subject'),
      'Missing vaccine lot in the National Vaccine Catalogue — TRAINING&LOT'
    );
    const body = draft.searchParams.get('body');
    assert.match(body, /Expiry date on barcode: 2099-01-31/);
    assert.match(body, /Catalogue version checked: 1\.138/);
    assert.doesNotMatch(body, /OMIT-SERIAL|OMIT-RAW-BARCODE/);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('a verified Panorama miss prepares a staff-addressed draft with explicit environment and expiry sources', () => {
  const makeDraft = globalThis.VaxLinkNvcLotReport.makeDraft;
  const row = {
    nvc_lot_matched: true,
    tradename: 'Training vaccine',
    manufacturer: 'Training manufacturer',
    lot: 'TRAINING&LOT',
    gtin: '00012345678901',
    din: '01234567',
    barcode_expiry: '',
    nvc_lot_expiry: '2099-01-31T00:00:00Z',
    nvc_catalogue_version: '1.138',
    expiry: '2099-01-31',
    expiry_source: 'nvc',
    raw_barcode: 'OMIT-RAW-BARCODE',
    serial: 'OMIT-SERIAL'
  };
  for (const training of [false, true]) {
    const draft = new URL(
      makeDraft(row, { panorama: true, training, bothFundingCategories: true })
    );
    assert.equal(draft.pathname, '', 'staff choose the recipient');
    assert.equal(draft.searchParams.get('cc'), 'innovation@wdgpublichealth.ca');
    assert.equal(
      draft.searchParams.get('subject'),
      `Vaccine lot not found in Panorama${training ? ' training' : ''} — TRAINING&LOT`
    );
    const body = draft.searchParams.get('body');
    assert.match(body, /under either funding category/);
    assert.match(body, /Vaccine name: Training vaccine/);
    assert.match(body, /DIN: 01234567/);
    assert.match(body, /Expiry date in catalogue: 2099-01-31/);
    assert.doesNotMatch(
      body,
      /Expiry date on barcode|OMIT-SERIAL|OMIT-RAW-BARCODE/
    );
  }
  assert.equal(
    makeDraft(
      { ...row, lookup_error_category: 'incomplete' },
      { panorama: true }
    ),
    ''
  );
});
