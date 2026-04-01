import { getExpiryStatus } from '../popup-parser.js';
import {
  createId,
  normalizeLotKey,
  normalizeNonNegativeInt,
  normalizePositiveInt,
  nowIso
} from './utils.js';

const MONITORING_DUE_SOON_DAYS = 7;

function getItemTime(item) {
  const value = item?.received_at || item?.scanned_at || '';
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveItemName(data) {
  return data?.name || data?.generic_name || data?.tradename || data?.lot || '';
}

function normalizeTextKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeDateValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const directIso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (directIso) {
    return text;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return text;
  }
  return parsed.toISOString().slice(0, 10);
}

function buildExpiryFields(data, inventoryExpiry) {
  const status = data?.expiry_flag
    ? {
        flag: data.expiry_flag,
        daysRemaining: data.expiry_days_remaining ?? null
      }
    : getExpiryStatus(inventoryExpiry);

  return {
    barcode_expiry: data?.barcode_expiry || data?.expiry || '',
    inventory_expiry: inventoryExpiry,
    nvc_lot_expiry: data?.nvc_lot_expiry || '',
    expiry_flag: status.flag || '',
    expiry_days_remaining: status.daysRemaining ?? '',
    expiry_source:
      data?.expiry_source ||
      (data?.expiry ? 'barcode' : (data?.nvc_lot_expiry ? 'nvc' : 'none'))
  };
}

function getInventoryQuantity(data = {}, fallback = 1) {
  return normalizeNonNegativeInt(
    data.remaining_doses,
    normalizePositiveInt(data.total_doses, fallback)
  );
}

function getComparisonVaccineName(data = {}) {
  return data.tradename || data.generic_name || data.name || data.vaccine || 'Unknown';
}

function buildComparisonKey(vaccine, lot) {
  return `${normalizeTextKey(vaccine)}||${normalizeLotKey(lot)}`;
}

function normalizeShipmentComparisonRow(data = {}) {
  const flags = Array.isArray(data.flags) ? data.flags.filter(Boolean) : [];
  return {
    id: String(data.id || createId()),
    vaccine: data.vaccine || 'Unknown',
    expected_lot: data.expected_lot || '',
    received_lot: data.received_lot || '',
    expected_expiry: data.expected_expiry || '',
    received_expiry: data.received_expiry || '',
    expected_qty: data.expected_qty ?? '',
    received_qty: data.received_qty ?? '',
    flags,
    status: data.status || (flags.length ? 'mismatch' : 'match'),
    note: data.note || ''
  };
}

function comparisonRowPriority(row) {
  const flags = row.flags || [];
  if (flags.includes('missing')) return 0;
  if (flags.includes('lot_mismatch')) return 1;
  if (flags.includes('qty_mismatch')) return 2;
  if (flags.includes('expiry_mismatch')) return 3;
  if (flags.includes('extra')) return 4;
  return 5;
}

function buildExpectedComparisonGroups(entries = []) {
  const groups = new Map();
  entries.map((entry) => normalizeShipmentExpectedEntry(entry)).forEach((entry) => {
    const key = buildComparisonKey(entry.vaccine, entry.lot);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        vaccine: entry.vaccine,
        vaccine_key: entry.vaccine_key,
        lot: entry.lot,
        lot_key: entry.lot_key,
        expiry: entry.expiry || '',
        qty: 0
      });
    }
    const group = groups.get(key);
    group.qty += entry.qty;
    if (!group.expiry && entry.expiry) {
      group.expiry = entry.expiry;
    }
  });
  return [...groups.values()];
}

function buildActualComparisonGroups(items = []) {
  const groups = new Map();
  items.map((item) => normalizeInventoryItem(item)).forEach((item) => {
    const vaccine = getComparisonVaccineName(item);
    const lot = item.lot || 'N/A';
    const key = buildComparisonKey(vaccine, lot);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        vaccine,
        vaccine_key: normalizeTextKey(vaccine),
        lot,
        lot_key: normalizeLotKey(lot),
        expiry: item.inventory_expiry || item.barcode_expiry || '',
        qty: 0
      });
    }
    const group = groups.get(key);
    group.qty += getInventoryQuantity(item, 1);
    if (!group.expiry && (item.inventory_expiry || item.barcode_expiry)) {
      group.expiry = item.inventory_expiry || item.barcode_expiry || '';
    }
  });
  return [...groups.values()];
}

export function normalizeInventoryItem(data = {}) {
  const totalDoses = normalizePositiveInt(data.total_doses, null);
  const remainingDoses = normalizeNonNegativeInt(
    data.remaining_doses,
    totalDoses ?? 1
  );
  const inventoryExpiry =
    data.inventory_expiry ||
    data.barcode_expiry ||
    data.expiry ||
    data.nvc_lot_expiry ||
    '';

  return {
    id: String(data.id || createId()),
    scanned_at: data.scanned_at || data.received_at || nowIso(),
    received_at: data.received_at || data.scanned_at || nowIso(),
    updated_at: data.updated_at || nowIso(),
    raw_barcode: data.raw_barcode || '',
    name: resolveItemName(data),
    tradename: data.tradename || '',
    generic_name: data.generic_name || '',
    disease: data.disease || '',
    antigen: data.antigen || '',
    manufacturer: data.manufacturer || '',
    gtin: data.gtin || '',
    lot: data.lot || '',
    lot_key: normalizeLotKey(data.lot),
    serial: data.serial || '',
    ...buildExpiryFields(data, inventoryExpiry),
    route: data.route || '',
    strength: data.strength || '',
    dose_value: data.dose_value || '',
    dose_unit: data.dose_unit || '',
    total_doses: totalDoses,
    remaining_doses: remainingDoses,
    dose_tracking: data.dose_tracking || 'manual',
    din: data.din || '',
    drug_code: data.drug_code || data.din || '',
    lookup_error: data.lookup_error || '',
    source: data.source || 'inventory_manager',
    receive_session_id: data.receive_session_id || '',
    receive_session_label: data.receive_session_label || '',
    inventory_kind: data.inventory_kind || 'clinic_inventory',
    monitoring_case_id: data.monitoring_case_id || '',
    monitoring_provider_name: data.monitoring_provider_name || '',
    monitoring_storage_location: data.monitoring_storage_location || '',
    monitoring_dropoff_date: data.monitoring_dropoff_date || '',
    monitoring_return_due_date: data.monitoring_return_due_date || ''
  };
}

export function buildLegacyQueueRecord(data, rawBarcode = '') {
  const item = normalizeInventoryItem({
    ...data,
    raw_barcode: rawBarcode || data?.raw_barcode || '',
    source: data?.source || 'legacy_queue'
  });

  return {
    id: item.id,
    scanned_at: item.scanned_at,
    raw_barcode: item.raw_barcode,
    name: item.name,
    tradename: item.tradename,
    generic_name: item.generic_name,
    disease: item.disease,
    antigen: item.antigen,
    manufacturer: item.manufacturer,
    gtin: item.gtin,
    lot: item.lot,
    serial: item.serial,
    barcode_expiry: item.barcode_expiry,
    inventory_expiry: item.inventory_expiry,
    nvc_lot_expiry: item.nvc_lot_expiry,
    expiry_flag: item.expiry_flag,
    expiry_days_remaining: item.expiry_days_remaining,
    expiry_source: item.expiry_source,
    route: item.route,
    strength: item.strength,
    dose_value: item.dose_value,
    dose_unit: item.dose_unit,
    total_doses: item.total_doses,
    remaining_doses: item.remaining_doses,
    dose_tracking: item.dose_tracking,
    din: item.din,
    drug_code: item.drug_code,
    lookup_error: item.lookup_error,
    receive_session_id: item.receive_session_id,
    receive_session_label: item.receive_session_label,
    inventory_kind: item.inventory_kind,
    monitoring_case_id: item.monitoring_case_id,
    monitoring_provider_name: item.monitoring_provider_name,
    monitoring_storage_location: item.monitoring_storage_location,
    monitoring_dropoff_date: item.monitoring_dropoff_date,
    monitoring_return_due_date: item.monitoring_return_due_date
  };
}

export function buildLegacyInventoryRows(items = []) {
  return sortItemsByReceived(items).map((item) => buildLegacyQueueRecord(item));
}

export function buildLegacyRowSignature(rows = []) {
  return JSON.stringify(
    rows.map((row) => [
      row?.id || '',
      row?.lot || '',
      row?.remaining_doses ?? '',
      row?.total_doses ?? '',
      row?.inventory_expiry || '',
      row?.scanned_at || ''
    ])
  );
}

export function sortItemsByReceived(items = []) {
  return [...items]
    .map((item) => normalizeInventoryItem(item))
    .sort((left, right) => {
      const timeDiff = getItemTime(left) - getItemTime(right);
      if (timeDiff !== 0) return timeDiff;
      return String(left.id || '').localeCompare(String(right.id || ''));
    });
}

export function sortItemsByFefo(items = []) {
  return [...items]
    .map((item) => normalizeInventoryItem(item))
    .sort((left, right) => {
      const leftExpiry = String(
        left.inventory_expiry || left.barcode_expiry || '9999-12-31'
      );
      const rightExpiry = String(
        right.inventory_expiry || right.barcode_expiry || '9999-12-31'
      );
      const expiryDiff = leftExpiry.localeCompare(rightExpiry);
      if (expiryDiff !== 0) return expiryDiff;
      const timeDiff = getItemTime(left) - getItemTime(right);
      if (timeDiff !== 0) return timeDiff;
      return String(left.id || '').localeCompare(String(right.id || ''));
    });
}

export function buildInventorySummary(items = [], lotFlagsMap = {}) {
  const expired = items.filter((item) => item.expiry_flag === 'expired').length;
  const expiring = items.filter((item) => item.expiry_flag === 'expiring_soon').length;
  const flagged = items.filter((item) => lotFlagsMap[normalizeLotKey(item.lot)]).length;
  return `${items.length} item(s) in local inventory. ${expired} expired, ${expiring} expiring soon, ${flagged} do-not-use flagged.`;
}

export function getInventoryGroups(items = []) {
  const groups = new Map();
  sortItemsByReceived(items).forEach((item) => {
    const vaccine = item.tradename || item.generic_name || item.name || 'Unknown';
    const lot = item.lot || 'N/A';
    const key = `${vaccine}||${lot}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        vaccine,
        lot,
        expected: 0,
        rows: 0,
        expiry: item.inventory_expiry || item.barcode_expiry || ''
      });
    }
    const group = groups.get(key);
    group.expected += normalizeNonNegativeInt(
      item.remaining_doses,
      normalizePositiveInt(item.total_doses, 1)
    );
    group.rows += 1;
  });
  return [...groups.values()];
}

export function buildReconciliationSnapshot(items = [], physicalCounts = new Map()) {
  return getInventoryGroups(items).map((group) => {
    const physical = Number.parseInt(String(physicalCounts.get(group.key) ?? ''), 10);
    const variance = Number.isFinite(physical) ? physical - group.expected : null;
    return {
      key: group.key,
      vaccine: group.vaccine,
      lot: group.lot,
      entries: group.rows,
      expected_doses: group.expected,
      physical_count: Number.isFinite(physical) ? physical : null,
      variance,
      expiry: group.expiry || ''
    };
  });
}

export function buildClinicalSummaryRows(
  items = [],
  physicalCounts = new Map(),
  lotFlagsMap = {}
) {
  return buildReconciliationSnapshot(items, physicalCounts).map((row) => ({
    vaccine: row.vaccine,
    lot: row.lot,
    expiry: row.expiry,
    expected_doses: row.expected_doses,
    physical_count: row.physical_count ?? '',
    variance: row.variance ?? '',
    do_not_use: lotFlagsMap[normalizeLotKey(row.lot)] ? 'Y' : ''
  }));
}

export function buildLotFlagsMap(flags = []) {
  return flags.reduce((acc, flag) => {
    const lotKey = normalizeLotKey(flag?.lot || flag?.lot_key);
    if (!lotKey) return acc;
    acc[lotKey] = {
      lot: flag.lot || lotKey.toUpperCase(),
      reason: flag.reason || '',
      ts: flag.ts || ''
    };
    return acc;
  }, {});
}

export function createTransaction(type, data = {}) {
  return {
    id: String(data.id || createId()),
    ts: data.ts || nowIso(),
    type,
    lot: data.lot || '',
    lot_key: normalizeLotKey(data.lot || data.lot_key),
    vaccine: data.vaccine || '',
    qty: data.qty ?? '',
    note: data.note || ''
  };
}

export function normalizeLotFlag(data = {}) {
  const lot = String(data.lot || '').trim();
  const lotKey = normalizeLotKey(lot || data.lot_key);
  return {
    lot_key: lotKey,
    lot: lot || String(data.lot || '').trim() || lotKey.toUpperCase(),
    reason: data.reason || '',
    ts: data.ts || nowIso()
  };
}

export function normalizeIncident(data = {}) {
  return {
    id: String(data.id || createId()),
    ts: data.ts || nowIso(),
    lot: String(data.lot || '').trim(),
    lot_key: normalizeLotKey(data.lot || data.lot_key),
    minTemp: data.minTemp || '',
    maxTemp: data.maxTemp || '',
    startedAt: data.startedAt || '',
    endedAt: data.endedAt || '',
    outcome: data.outcome || 'quarantine',
    note: data.note || ''
  };
}

export function normalizeReconciliationSignoff(data = {}) {
  return {
    id: String(data.id || createId()),
    ts: data.ts || nowIso(),
    summary: data.summary || {
      total_groups: 0,
      matched_groups: 0,
      unresolved_groups: 0,
      pending_groups: 0
    },
    rows: Array.isArray(data.rows) ? data.rows : []
  };
}

export function getReceiveSessions(items = []) {
  const sessions = new Map();
  sortItemsByReceived(items).forEach((item) => {
    if (!item.receive_session_id) return;
    const id = item.receive_session_id;
    if (!sessions.has(id)) {
      sessions.set(id, {
        id,
        label: item.receive_session_label || 'Unnamed receive batch',
        item_count: 0,
        total_doses: 0,
        latest_received_at: item.received_at || item.scanned_at || '',
        created_at: item.received_at || item.scanned_at || ''
      });
    }
    const session = sessions.get(id);
    session.item_count += 1;
    session.total_doses += getInventoryQuantity(item, 1);
    const candidateTime = new Date(item.received_at || item.scanned_at || 0).getTime();
    const currentTime = new Date(session.latest_received_at || 0).getTime();
    if (candidateTime >= currentTime) {
      session.latest_received_at = item.received_at || item.scanned_at || session.latest_received_at;
    }
  });
  return [...sessions.values()].sort((left, right) => {
    const leftTime = new Date(left.latest_received_at || 0).getTime();
    const rightTime = new Date(right.latest_received_at || 0).getTime();
    return rightTime - leftTime;
  });
}

export function getLatestReceiveSession(items = []) {
  return getReceiveSessions(items)[0] || null;
}

export function normalizeShipmentExpectedEntry(data = {}) {
  const vaccine = getComparisonVaccineName(data);
  const lot = String(data.lot || '').trim();
  const qty = normalizePositiveInt(
    data.qty,
    normalizeNonNegativeInt(data.remaining_doses, normalizePositiveInt(data.total_doses, 1))
  ) || 1;
  return {
    id: String(data.id || createId()),
    vaccine,
    vaccine_key: normalizeTextKey(vaccine),
    lot,
    lot_key: normalizeLotKey(lot),
    expiry:
      normalizeDateValue(data.expiry || data.inventory_expiry || data.barcode_expiry || data.nvc_lot_expiry) || '',
    qty,
    raw_line: data.raw_line || data.raw_barcode || ''
  };
}

export function buildShipmentComparisonRows(expectedEntries = [], actualItems = []) {
  const expectedGroups = buildExpectedComparisonGroups(expectedEntries);
  const actualGroups = buildActualComparisonGroups(actualItems);
  const actualByKey = new Map(actualGroups.map((group) => [group.key, group]));
  const actualByVaccine = new Map();
  const usedExactKeys = new Set();
  const usedAlternateKeys = new Set();

  actualGroups.forEach((group) => {
    if (!actualByVaccine.has(group.vaccine_key)) {
      actualByVaccine.set(group.vaccine_key, []);
    }
    actualByVaccine.get(group.vaccine_key).push(group);
  });

  const rows = [];

  expectedGroups.forEach((expected) => {
    const exact = actualByKey.get(expected.key);
    if (exact) {
      usedExactKeys.add(exact.key);
      const flags = [];
      if (expected.qty !== exact.qty) {
        flags.push('qty_mismatch');
      }
      const expectedExpiry = normalizeDateValue(expected.expiry);
      const actualExpiry = normalizeDateValue(exact.expiry);
      if (expectedExpiry && actualExpiry && expectedExpiry !== actualExpiry) {
        flags.push('expiry_mismatch');
      }
      rows.push(normalizeShipmentComparisonRow({
        vaccine: expected.vaccine,
        expected_lot: expected.lot,
        received_lot: exact.lot,
        expected_expiry: expected.expiry,
        received_expiry: exact.expiry,
        expected_qty: expected.qty,
        received_qty: exact.qty,
        flags,
        note: flags.length ? 'Expected and received values differ.' : 'Matched expected shipment.'
      }));
      return;
    }

    const alternateGroups = (actualByVaccine.get(expected.vaccine_key) || []).filter(
      (group) => !usedExactKeys.has(group.key) && !usedAlternateKeys.has(group.key)
    );

    if (alternateGroups.length) {
      alternateGroups.forEach((group) => usedAlternateKeys.add(group.key));
      rows.push(normalizeShipmentComparisonRow({
        vaccine: expected.vaccine,
        expected_lot: expected.lot,
        received_lot: alternateGroups.map((group) => group.lot).join(' | '),
        expected_expiry: expected.expiry,
        received_expiry: alternateGroups.map((group) => group.expiry).filter(Boolean).join(' | '),
        expected_qty: expected.qty,
        received_qty: alternateGroups.reduce((total, group) => total + group.qty, 0),
        flags: ['lot_mismatch'],
        note: 'Received stock for this vaccine, but lot numbers did not match the expected shipment.'
      }));
      return;
    }

    rows.push(normalizeShipmentComparisonRow({
      vaccine: expected.vaccine,
      expected_lot: expected.lot,
      received_lot: '',
      expected_expiry: expected.expiry,
      received_expiry: '',
      expected_qty: expected.qty,
      received_qty: 0,
      flags: ['missing'],
      note: 'Expected shipment entry was not found in the received batch.'
    }));
  });

  actualGroups.forEach((actual) => {
    if (usedExactKeys.has(actual.key) || usedAlternateKeys.has(actual.key)) {
      return;
    }
    rows.push(normalizeShipmentComparisonRow({
      vaccine: actual.vaccine,
      expected_lot: '',
      received_lot: actual.lot,
      expected_expiry: '',
      received_expiry: actual.expiry,
      expected_qty: 0,
      received_qty: actual.qty,
      flags: ['extra'],
      note: 'Received stock was present in inventory but not in the expected shipment list.'
    }));
  });

  return rows.sort((left, right) => {
    const priorityDiff = comparisonRowPriority(left) - comparisonRowPriority(right);
    if (priorityDiff !== 0) return priorityDiff;
    const vaccineDiff = String(left.vaccine || '').localeCompare(String(right.vaccine || ''));
    if (vaccineDiff !== 0) return vaccineDiff;
    return String(left.expected_lot || left.received_lot || '').localeCompare(
      String(right.expected_lot || right.received_lot || '')
    );
  });
}

export function buildShipmentComparisonSummary(rows = []) {
  const summary = {
    total_rows: rows.length,
    matched: 0,
    missing: 0,
    extra: 0,
    qty_mismatch: 0,
    lot_mismatch: 0,
    expiry_mismatch: 0
  };

  rows.forEach((row) => {
    const flags = Array.isArray(row.flags) ? row.flags : [];
    if (!flags.length) {
      summary.matched += 1;
    }
    flags.forEach((flag) => {
      if (flag in summary) {
        summary[flag] += 1;
      }
    });
  });

  return summary;
}

export function normalizeShipmentComparison(data = {}, actualItems = []) {
  const expectedEntries = Array.isArray(data.expected_entries)
    ? data.expected_entries.map((entry) => normalizeShipmentExpectedEntry(entry))
    : [];
  const comparisonRows = Array.isArray(data.comparison_rows) && data.comparison_rows.length
    ? data.comparison_rows.map((row) => normalizeShipmentComparisonRow(row))
    : buildShipmentComparisonRows(expectedEntries, actualItems);
  const summary = data.summary || buildShipmentComparisonSummary(comparisonRows);

  return {
    id: String(data.id || createId()),
    created_at: data.created_at || nowIso(),
    shipment_label: data.shipment_label || 'Shipment comparison',
    receive_session_id: data.receive_session_id || '',
    receive_session_label: data.receive_session_label || '',
    expected_entries: expectedEntries,
    comparison_rows: comparisonRows,
    summary,
    signed_by: data.signed_by || '',
    signed_at: data.signed_at || '',
    note: data.note || ''
  };
}

export function getMonitoringCaseStatus(caseRecord, now = new Date()) {
  if (!caseRecord) return 'active';
  if (caseRecord.returned_at) return 'returned';

  const expected = normalizeDateValue(caseRecord.expected_return_date);
  if (!expected) return 'active';

  const dueDate = new Date(`${expected}T23:59:59`);
  if (Number.isNaN(dueDate.getTime())) return 'active';

  const msPerDay = 24 * 60 * 60 * 1000;
  const today = new Date(now);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysRemaining = Math.floor((dueDate.getTime() - todayStart.getTime()) / msPerDay);

  if (daysRemaining < 0) return 'overdue';
  if (daysRemaining <= MONITORING_DUE_SOON_DAYS) return 'due_soon';
  return 'active';
}

export function normalizeMonitoringCase(data = {}) {
  const id = String(data.id || createId());
  const providerName = String(data.provider_name || data.providerName || '').trim();
  const storageLocation = String(data.storage_location || data.storageLocation || '').trim();
  const custodyContact = String(data.custody_contact || data.custodyContact || '').trim();
  const dropoffDate = normalizeDateValue(data.dropoff_date || data.dropoffDate) || nowIso().slice(0, 10);
  const expectedReturnDate = normalizeDateValue(data.expected_return_date || data.expectedReturnDate || data.return_due_date || data.returnDueDate);

  const items = Array.isArray(data.items)
    ? data.items.map((item) => normalizeInventoryItem({
        ...item,
        inventory_kind: 'holiday_monitoring',
        monitoring_case_id: id,
        monitoring_provider_name: providerName,
        monitoring_storage_location: storageLocation,
        monitoring_dropoff_date: dropoffDate,
        monitoring_return_due_date: expectedReturnDate
      }))
    : [];

  return {
    id,
    created_at: data.created_at || nowIso(),
    provider_name: providerName,
    storage_location: storageLocation,
    custody_contact: custodyContact,
    dropoff_date: dropoffDate,
    expected_return_date: expectedReturnDate,
    intake_by: String(data.intake_by || data.intakeBy || '').trim(),
    intake_note: String(data.intake_note || data.intakeNote || '').trim(),
    returned_at: data.returned_at || '',
    returned_by: String(data.returned_by || data.returnedBy || '').trim(),
    return_note: String(data.return_note || data.returnNote || '').trim(),
    items
  };
}

export function buildMonitoringSummary(cases = [], now = new Date()) {
  const summary = {
    total_cases: cases.length,
    active: 0,
    due_soon: 0,
    overdue: 0,
    returned: 0
  };

  cases.forEach((caseRecord) => {
    const status = getMonitoringCaseStatus(caseRecord, now);
    if (status in summary) {
      summary[status] += 1;
    }
  });

  return summary;
}

export function buildMonitoringReportRows(cases = [], now = new Date()) {
  return cases.flatMap((caseRecord) => {
    const status = getMonitoringCaseStatus(caseRecord, now);
    const base = {
      case_id: caseRecord.id,
      provider_name: caseRecord.provider_name,
      status,
      dropoff_date: caseRecord.dropoff_date || '',
      expected_return_date: caseRecord.expected_return_date || '',
      returned_at: caseRecord.returned_at || '',
      returned_by: caseRecord.returned_by || '',
      storage_location: caseRecord.storage_location || '',
      custody_contact: caseRecord.custody_contact || '',
      intake_by: caseRecord.intake_by || '',
      intake_note: caseRecord.intake_note || '',
      return_note: caseRecord.return_note || ''
    };

    if (!Array.isArray(caseRecord.items) || !caseRecord.items.length) {
      return [{
        ...base,
        vaccine: '',
        lot: '',
        expiry: '',
        qty: ''
      }];
    }

    return caseRecord.items.map((item) => ({
      ...base,
      vaccine: item.tradename || item.generic_name || item.name || '',
      lot: item.lot || '',
      expiry: item.inventory_expiry || item.barcode_expiry || '',
      qty: item.remaining_doses ?? item.total_doses ?? ''
    }));
  });
}

export function consumeDosesFromItems(items = [], lot, qty) {
  const targetLotKey = normalizeLotKey(lot);
  const requestedQty = normalizePositiveInt(qty, 0) || 0;
  if (!targetLotKey || requestedQty <= 0) {
    return {
      items: sortItemsByReceived(items),
      consumed: 0
    };
  }

  let remainingToConsume = requestedQty;
  const mutated = sortItemsByFefo(items).map((item) => ({ ...normalizeInventoryItem(item) }));
  const updatedAt = nowIso();

  const nextItems = [];
  mutated.forEach((item) => {
    if (remainingToConsume <= 0 || item.lot_key !== targetLotKey) {
      nextItems.push(item);
      return;
    }

    const available = normalizeNonNegativeInt(
      item.remaining_doses,
      normalizePositiveInt(item.total_doses, 1)
    );
    const used = Math.min(available, remainingToConsume);
    const remaining = available - used;
    remainingToConsume -= used;

    if (remaining > 0) {
      nextItems.push({
        ...item,
        remaining_doses: remaining,
        updated_at: updatedAt
      });
    }
  });

  return {
    items: sortItemsByReceived(nextItems),
    consumed: requestedQty - remainingToConsume
  };
}

export function buildHandoffData(transactions = [], itemCount = 0, now = new Date()) {
  const periodEnd = new Date(now);
  const periodStart = new Date(periodEnd.getTime() - 12 * 60 * 60 * 1000);
  const recent = (transactions || []).filter((entry) => {
    const ts = new Date(entry?.ts || 0).getTime();
    return ts >= periodStart.getTime();
  });

  return {
    generated_at: periodEnd.toISOString(),
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    receives: recent.filter((entry) => entry.type === 'receive_stock').length,
    wastage_events: recent.filter((entry) => entry.type === 'wastage').length,
    cold_chain_incidents: recent.filter((entry) => entry.type === 'cold_chain_incident').length,
    reconciliations: recent.filter((entry) => entry.type === 'reconciliation_signoff').length,
    inventory_rows: itemCount
  };
}
