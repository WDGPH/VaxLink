import { getExpiryStatus } from './popup-parser.js';

function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePositiveInt(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeNonNegativeInt(value, fallback = 0) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function resolveItemName(data) {
  return data?.name || data?.generic_name || data?.tradename || data?.lot || '';
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

function normalizeQueueRecord(data = {}) {
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
    scanned_at: data.scanned_at || nowIso(),
    raw_barcode: data.raw_barcode || '',
    name: resolveItemName(data),
    tradename: data.tradename || '',
    generic_name: data.generic_name || '',
    disease: data.disease || '',
    antigen: data.antigen || '',
    manufacturer: data.manufacturer || '',
    gtin: data.gtin || '',
    lot: data.lot || '',
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
    lookup_error: data.lookup_error || ''
  };
}

export function buildLegacyQueueRecord(data = {}, rawBarcode = '') {
  return normalizeQueueRecord({
    ...data,
    raw_barcode: rawBarcode || data?.raw_barcode || ''
  });
}
