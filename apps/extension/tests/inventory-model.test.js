import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMonitoringSummary,
  buildShipmentComparisonRows,
  getMonitoringCaseStatus,
  buildReconciliationSnapshot,
  consumeDosesFromItems,
  sortItemsByFefo
} from '../inventory/model.js';
import {
  buildHolidayMonitoringReportFile,
  buildInventoryCsvText,
  buildOpsPackageFiles,
  buildShipmentComparisonFile
} from '../inventory/exports.js';

function buildItem(overrides = {}) {
  return {
    id: overrides.id || `item-${Math.random().toString(36).slice(2, 8)}`,
    scanned_at: overrides.scanned_at || '2026-04-01T10:00:00.000Z',
    received_at: overrides.received_at || overrides.scanned_at || '2026-04-01T10:00:00.000Z',
    updated_at: overrides.updated_at || '2026-04-01T10:00:00.000Z',
    raw_barcode: overrides.raw_barcode || '',
    name: overrides.name || 'Influenza',
    tradename: overrides.tradename || '',
    generic_name: overrides.generic_name || 'Influenza',
    disease: overrides.disease || '',
    antigen: overrides.antigen || '',
    manufacturer: overrides.manufacturer || 'ACME',
    gtin: overrides.gtin || '',
    lot: overrides.lot || 'LOT-1',
    lot_key: String(overrides.lot || 'LOT-1').toLowerCase(),
    serial: overrides.serial || '',
    barcode_expiry: overrides.barcode_expiry || '',
    inventory_expiry: overrides.inventory_expiry ?? '2026-05-01',
    nvc_lot_expiry: overrides.nvc_lot_expiry || '',
    expiry_flag: overrides.expiry_flag || 'valid',
    expiry_days_remaining: overrides.expiry_days_remaining ?? 30,
    expiry_source: overrides.expiry_source || 'barcode',
    route: overrides.route || '',
    strength: overrides.strength || '',
    dose_value: overrides.dose_value || '',
    dose_unit: overrides.dose_unit || '',
    total_doses: overrides.total_doses ?? 1,
    remaining_doses: overrides.remaining_doses ?? overrides.total_doses ?? 1,
    dose_tracking: overrides.dose_tracking || 'manual',
    din: overrides.din || '',
    drug_code: overrides.drug_code || '',
    lookup_error: overrides.lookup_error || '',
    source: overrides.source || 'inventory_manager'
  };
}

test('FEFO ordering prioritizes earliest expiry first', () => {
  const rows = [
    buildItem({ id: 'late', lot: 'B', inventory_expiry: '2026-09-01' }),
    buildItem({ id: 'none', lot: 'C', inventory_expiry: '' }),
    buildItem({ id: 'early', lot: 'A', inventory_expiry: '2026-04-10' })
  ];

  const ordered = sortItemsByFefo(rows);
  assert.deepEqual(ordered.map((item) => item.id), ['early', 'late', 'none']);
});

test('dose consumption depletes earliest-expiry stock first and removes empty rows', () => {
  const rows = [
    buildItem({
      id: 'lot-oldest',
      lot: 'LOT-X',
      inventory_expiry: '2026-04-05',
      total_doses: 2,
      remaining_doses: 2
    }),
    buildItem({
      id: 'lot-newer',
      lot: 'LOT-X',
      inventory_expiry: '2026-06-01',
      total_doses: 3,
      remaining_doses: 3
    }),
    buildItem({
      id: 'other-lot',
      lot: 'LOT-Y',
      inventory_expiry: '2026-04-07',
      total_doses: 4,
      remaining_doses: 4
    })
  ];

  const result = consumeDosesFromItems(rows, 'LOT-X', 4);
  assert.equal(result.consumed, 4);
  assert.deepEqual(
    result.items.map((item) => [item.id, item.remaining_doses]),
    [
      ['lot-newer', 1],
      ['other-lot', 4]
    ]
  );
});

test('reconciliation snapshot groups doses by vaccine and lot with variance', () => {
  const rows = [
    buildItem({ id: 'a1', lot: 'LOT-A', generic_name: 'COVID', remaining_doses: 3 }),
    buildItem({ id: 'a2', lot: 'LOT-A', generic_name: 'COVID', remaining_doses: 2 }),
    buildItem({ id: 'b1', lot: 'LOT-B', generic_name: 'Flu', remaining_doses: 5 })
  ];
  const physicalCounts = new Map([
    ['COVID||LOT-A', 4],
    ['Flu||LOT-B', 7]
  ]);

  const snapshot = buildReconciliationSnapshot(rows, physicalCounts);
  assert.deepEqual(
    snapshot.map((row) => ({
      key: row.key,
      expected: row.expected_doses,
      physical: row.physical_count,
      variance: row.variance
    })),
    [
      { key: 'COVID||LOT-A', expected: 5, physical: 4, variance: -1 },
      { key: 'Flu||LOT-B', expected: 5, physical: 7, variance: 2 }
    ]
  );
});

test('shipment comparison flags missing, extra, qty mismatch, and lot mismatch', () => {
  const expectedEntries = [
    { vaccine: 'COVID', lot: 'LOT-A', qty: 5, expiry: '2026-04-10' },
    { vaccine: 'Flu', lot: 'LOT-B', qty: 2, expiry: '2026-05-01' },
    { vaccine: 'RSV', lot: 'LOT-C', qty: 1, expiry: '2026-06-01' }
  ];
  const actualItems = [
    buildItem({
      id: 'covid-a',
      generic_name: 'COVID',
      lot: 'LOT-A',
      inventory_expiry: '2026-04-10',
      total_doses: 3,
      remaining_doses: 3
    }),
    buildItem({
      id: 'flu-x',
      generic_name: 'Flu',
      lot: 'LOT-X',
      inventory_expiry: '2026-05-01',
      total_doses: 2,
      remaining_doses: 2
    }),
    buildItem({
      id: 'extra',
      generic_name: 'HepB',
      lot: 'LOT-Z',
      inventory_expiry: '2026-07-01',
      total_doses: 1,
      remaining_doses: 1
    })
  ];

  const rows = buildShipmentComparisonRows(expectedEntries, actualItems);
  assert.deepEqual(
    rows.map((row) => ({
      vaccine: row.vaccine,
      flags: row.flags
    })),
    [
      { vaccine: 'RSV', flags: ['missing'] },
      { vaccine: 'Flu', flags: ['lot_mismatch'] },
      { vaccine: 'COVID', flags: ['qty_mismatch'] },
      { vaccine: 'HepB', flags: ['extra'] }
    ]
  );
});

test('holiday monitoring summary and status classify overdue and returned cases', () => {
  const cases = [
    {
      id: 'case-overdue',
      provider_name: 'Provider A',
      dropoff_date: '2025-12-20',
      expected_return_date: '2025-12-27',
      returned_at: '',
      items: [buildItem({ id: 'm1', lot: 'LOT-1' })]
    },
    {
      id: 'case-due-soon',
      provider_name: 'Provider B',
      dropoff_date: '2025-12-24',
      expected_return_date: '2026-01-04',
      returned_at: '',
      items: [buildItem({ id: 'm2', lot: 'LOT-2' })]
    },
    {
      id: 'case-returned',
      provider_name: 'Provider C',
      dropoff_date: '2025-12-24',
      expected_return_date: '2026-01-10',
      returned_at: '2025-12-29T10:00:00.000Z',
      items: [buildItem({ id: 'm3', lot: 'LOT-3' })]
    }
  ];
  const now = new Date('2026-01-02T12:00:00.000Z');

  assert.equal(getMonitoringCaseStatus(cases[0], now), 'overdue');
  assert.equal(getMonitoringCaseStatus(cases[1], now), 'due_soon');
  assert.equal(getMonitoringCaseStatus(cases[2], now), 'returned');

  const summary = buildMonitoringSummary(cases, now);
  assert.deepEqual(summary, {
    total_cases: 3,
    active: 0,
    due_soon: 1,
    overdue: 1,
    returned: 1
  });
});

test('export builders preserve expected column contracts', () => {
  const state = {
    items: [
      buildItem({
        id: 'export-1',
        lot: 'LOT-EXP',
        inventory_expiry: '2026-04-15',
        total_doses: 5,
        remaining_doses: 4,
        din: '1234'
      })
    ],
    ledger: [
      {
        id: 'txn-1',
        ts: '2026-04-01T10:30:00.000Z',
        type: 'receive_stock',
        lot: 'LOT-EXP',
        vaccine: 'Influenza',
        qty: 4,
        note: 'Source=barcode; expiry=2026-04-15'
      }
    ],
    incidents: [],
    reconSignoffs: [],
    lotFlags: [],
    lotFlagsMap: {},
    shipmentComparisons: [
      {
        id: 'cmp-1',
        shipment_label: 'OGB-001',
        receive_session_label: 'Shipment A',
        created_at: '2026-04-01T11:00:00.000Z',
        signed_by: 'Reviewer',
        signed_at: '2026-04-01T11:15:00.000Z',
        comparison_rows: [
          {
            vaccine: 'Influenza',
            expected_lot: 'LOT-EXP',
            received_lot: 'LOT-EXP',
            expected_expiry: '2026-04-15',
            received_expiry: '2026-04-15',
            expected_qty: 4,
            received_qty: 4,
            flags: [],
            note: 'Matched expected shipment.'
          }
        ],
        summary: {
          total_rows: 1,
          matched: 1,
          missing: 0,
          extra: 0,
          qty_mismatch: 0,
          lot_mismatch: 0,
          expiry_mismatch: 0
        }
      }
    ],
    monitoringCases: [
      {
        id: 'monitor-1',
        provider_name: 'Provider A',
        storage_location: 'Fridge 1',
        custody_contact: 'Jane',
        intake_by: 'Nurse A',
        intake_note: 'Holiday intake',
        dropoff_date: '2025-12-24',
        expected_return_date: '2026-01-05',
        returned_at: '',
        returned_by: '',
        return_note: '',
        items: [
          buildItem({
            id: 'monitor-item',
            lot: 'LOT-MON',
            inventory_expiry: '2026-03-01'
          })
        ]
      }
    ]
  };

  const inventoryCsv = buildInventoryCsvText(state.items);
  assert.match(
    inventoryCsv.split('\r\n')[0],
    /^scan_index,scanned_at,name,tradename,generic_name,manufacturer,gtin,lot,inventory_expiry,expiry_flag,remaining_doses,total_doses,din,raw_barcode$/
  );
  assert.match(inventoryCsv, /LOT-EXP/);

  const files = buildOpsPackageFiles(state, new Map(), new Date('2026-04-01T12:00:00.000Z'));
  assert.equal(files.length, 7);
  assert.match(files[0].content.split('\r\n')[0], /^vaccine,lot,expiry,expected_doses,physical_count,variance,do_not_use$/);
  assert.match(files[4].content.split('\r\n')[0], /^comparison_id,shipment_label,receive_session_label,created_at,signed_by,signed_at,vaccine,expected_lot,received_lot,expected_expiry,received_expiry,expected_qty,received_qty,flags,note$/);
  assert.match(files[5].content.split('\r\n')[0], /^case_id,provider_name,status,dropoff_date,expected_return_date,returned_at,returned_by,storage_location,custody_contact,intake_by,intake_note,return_note,vaccine,lot,expiry,qty$/);
  assert.match(files[6].content.split('\r\n')[0], /^generated_at,period_start,period_end,receives,wastage_events,cold_chain_incidents,reconciliations,inventory_rows$/);

  const comparisonFile = buildShipmentComparisonFile(state.shipmentComparisons[0], new Date('2026-04-01T12:00:00.000Z'));
  assert.match(comparisonFile.content.split('\r\n')[0], /^comparison_id,shipment_label,receive_session_label,created_at,signed_by,signed_at,vaccine,expected_lot,received_lot,expected_expiry,received_expiry,expected_qty,received_qty,flags,note$/);
  assert.match(comparisonFile.content, /OGB-001/);

  const monitoringFile = buildHolidayMonitoringReportFile(state.monitoringCases, new Date('2026-01-02T12:00:00.000Z'));
  assert.match(monitoringFile.content.split('\r\n')[0], /^case_id,provider_name,status,dropoff_date,expected_return_date,returned_at,returned_by,storage_location,custody_contact,intake_by,intake_note,return_note,vaccine,lot,expiry,qty$/);
  assert.match(monitoringFile.content, /Provider A/);
});
