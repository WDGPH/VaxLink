import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInventorySummary,
  buildMultipleInjectSummary,
  buildQueueRecord
} from '../popup-inventory.js';

test('buildQueueRecord preserves popup inventory export fields', () => {
  const row = buildQueueRecord({
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
  }, '01000123456789011799123110LOT-12321SER-1');

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
