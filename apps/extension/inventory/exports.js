import { INVENTORY_EXPORT_COLUMNS } from './constants.js';
import {
  buildClinicalSummaryRows,
  buildHandoffData,
  buildLegacyInventoryRows,
  buildMonitoringReportRows
} from './model.js';
import { csvEscape, nowIso } from './utils.js';

export function buildCsv(columns, sourceRows) {
  const lines = [columns.join(',')];
  (sourceRows || []).forEach((row) => {
    lines.push(columns.map((column) => csvEscape(row?.[column])).join(','));
  });
  return lines.join('\r\n');
}

export function buildInventoryCsvText(items = []) {
  const legacyRows = buildLegacyInventoryRows(items);
  const lines = [INVENTORY_EXPORT_COLUMNS.join(',')];

  legacyRows.forEach((row, index) => {
    lines.push(
      INVENTORY_EXPORT_COLUMNS.map((column) => {
        if (column === 'scan_index') {
          return csvEscape(index + 1);
        }
        return csvEscape(row[column]);
      }).join(',')
    );
  });

  return lines.join('\r\n');
}

export function buildAdvancedJsonPayload(state) {
  return {
    exported_at: nowIso(),
    inventory_rows: buildLegacyInventoryRows(state.items),
    ledger: state.ledger,
    cold_chain_incidents: state.incidents,
    reconciliation_signoffs: state.reconSignoffs,
    do_not_use_lots: state.lotFlagsMap,
    shipment_comparisons: state.shipmentComparisons || [],
    holiday_monitoring_cases: state.monitoringCases || []
  };
}

function buildShipmentComparisonRowsForExport(comparisons = []) {
  return (comparisons || []).flatMap((comparison) =>
    (comparison.comparison_rows || []).map((row) => ({
      comparison_id: comparison.id,
      shipment_label: comparison.shipment_label,
      receive_session_label: comparison.receive_session_label || '',
      created_at: comparison.created_at || '',
      signed_by: comparison.signed_by || '',
      signed_at: comparison.signed_at || '',
      vaccine: row.vaccine || '',
      expected_lot: row.expected_lot || '',
      received_lot: row.received_lot || '',
      expected_expiry: row.expected_expiry || '',
      received_expiry: row.received_expiry || '',
      expected_qty: row.expected_qty ?? '',
      received_qty: row.received_qty ?? '',
      flags: Array.isArray(row.flags) ? row.flags.join('|') : '',
      note: row.note || ''
    }))
  );
}

export function buildOpsPackageFiles(state, physicalCounts, now = new Date()) {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const clinicalSummaryRows = buildClinicalSummaryRows(
    state.items,
    physicalCounts,
    state.lotFlagsMap
  );
  const handoff = buildHandoffData(state.ledger, state.items.length, now);

  return [
    {
      filename: `vaxlink-clinical-summary-${ts}.csv`,
      content: buildCsv(
        ['vaccine', 'lot', 'expiry', 'expected_doses', 'physical_count', 'variance', 'do_not_use'],
        clinicalSummaryRows
      ),
      mimeType: 'text/csv;charset=utf-8'
    },
    {
      filename: `vaxlink-wastage-${ts}.csv`,
      content: buildCsv(
        ['ts', 'lot', 'qty', 'note'],
        state.ledger.filter((entry) => entry.type === 'wastage')
      ),
      mimeType: 'text/csv;charset=utf-8'
    },
    {
      filename: `vaxlink-cold-chain-${ts}.csv`,
      content: buildCsv(
        ['ts', 'lot', 'minTemp', 'maxTemp', 'startedAt', 'endedAt', 'outcome', 'note'],
        state.incidents
      ),
      mimeType: 'text/csv;charset=utf-8'
    },
    {
      filename: `vaxlink-reconciliation-signoffs-${ts}.csv`,
      content: buildCsv(
        ['ts', 'total_groups', 'matched_groups', 'unresolved_groups', 'pending_groups'],
        state.reconSignoffs.map((entry) => ({ ts: entry.ts, ...entry.summary }))
      ),
      mimeType: 'text/csv;charset=utf-8'
    },
    {
      filename: `vaxlink-shipment-comparisons-${ts}.csv`,
      content: buildCsv(
        [
          'comparison_id',
          'shipment_label',
          'receive_session_label',
          'created_at',
          'signed_by',
          'signed_at',
          'vaccine',
          'expected_lot',
          'received_lot',
          'expected_expiry',
          'received_expiry',
          'expected_qty',
          'received_qty',
          'flags',
          'note'
        ],
        buildShipmentComparisonRowsForExport(state.shipmentComparisons || [])
      ),
      mimeType: 'text/csv;charset=utf-8'
    },
    {
      filename: `vaxlink-holiday-monitoring-${ts}.csv`,
      content: buildCsv(
        [
          'case_id',
          'provider_name',
          'status',
          'dropoff_date',
          'expected_return_date',
          'returned_at',
          'returned_by',
          'storage_location',
          'custody_contact',
          'intake_by',
          'intake_note',
          'return_note',
          'vaccine',
          'lot',
          'expiry',
          'qty'
        ],
        buildMonitoringReportRows(state.monitoringCases || [], now)
      ),
      mimeType: 'text/csv;charset=utf-8'
    },
    {
      filename: `vaxlink-shift-handoff-${ts}.csv`,
      content: buildCsv(
        [
          'generated_at',
          'period_start',
          'period_end',
          'receives',
          'wastage_events',
          'cold_chain_incidents',
          'reconciliations',
          'inventory_rows'
        ],
        [handoff]
      ),
      mimeType: 'text/csv;charset=utf-8'
    }
  ];
}

export function buildShipmentComparisonFile(comparison, now = new Date()) {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return {
    filename: `vaxlink-shipment-comparison-${ts}.csv`,
    content: buildCsv(
      [
        'comparison_id',
        'shipment_label',
        'receive_session_label',
        'created_at',
        'signed_by',
        'signed_at',
        'vaccine',
        'expected_lot',
        'received_lot',
        'expected_expiry',
        'received_expiry',
        'expected_qty',
        'received_qty',
        'flags',
        'note'
      ],
      buildShipmentComparisonRowsForExport(comparison ? [comparison] : [])
    ),
    mimeType: 'text/csv;charset=utf-8'
  };
}

export function buildHolidayMonitoringReportFile(cases, now = new Date()) {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return {
    filename: `vaxlink-holiday-monitoring-${ts}.csv`,
    content: buildCsv(
      [
        'case_id',
        'provider_name',
        'status',
        'dropoff_date',
        'expected_return_date',
        'returned_at',
        'returned_by',
        'storage_location',
        'custody_contact',
        'intake_by',
        'intake_note',
        'return_note',
        'vaccine',
        'lot',
        'expiry',
        'qty'
      ],
      buildMonitoringReportRows(cases || [], now)
    ),
    mimeType: 'text/csv;charset=utf-8'
  };
}

export function buildShiftHandoffFile(state, now = new Date()) {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const handoff = buildHandoffData(state.ledger, state.items.length, now);
  return {
    filename: `vaxlink-shift-handoff-${ts}.csv`,
    content: buildCsv(
      [
        'generated_at',
        'period_start',
        'period_end',
        'receives',
        'wastage_events',
        'cold_chain_incidents',
        'reconciliations',
        'inventory_rows'
      ],
      [handoff]
    ),
    mimeType: 'text/csv;charset=utf-8'
  };
}

export function downloadTextFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
