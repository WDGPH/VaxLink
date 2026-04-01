import { getExpiryStatus, parseInputData } from '../popup-parser.js';
import { buildLegacyQueueRecord } from './model.js';

function isLikelyLotOnlyInput(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/\s/.test(text)) return false;
  if (text.includes('=') || text.startsWith('{') || text.startsWith('01') || text.startsWith('(01)')) {
    return false;
  }
  return /^[A-Za-z0-9._/-]{4,24}$/.test(text);
}

function buildLotOnlyParsedData(lotValue) {
  return {
    lot: String(lotValue || '').trim(),
    gtin: '',
    expiry: '',
    serial: '',
    scanned_at: new Date().toISOString()
  };
}

function isStructuredInventoryLine(value) {
  return /[,\t|]/.test(String(value || ''));
}

function isNumericToken(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function buildStructuredParsedData(line) {
  const parts = String(line || '')
    .split(/[,\t|]/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    throw new Error('Structured inventory line must include at least lot and quantity.');
  }

  let name = '';
  let lot = '';
  let qtyText = '';
  let expiry = '';

  if (parts.length === 2) {
    [lot, qtyText] = parts;
  } else if (parts.length === 3) {
    if (isNumericToken(parts[1])) {
      [lot, qtyText, expiry] = parts;
    } else if (isNumericToken(parts[2])) {
      [name, lot, qtyText] = parts;
    } else {
      throw new Error('Expected formats: LOT,QTY or LOT,QTY,EXPIRY or VACCINE,LOT,QTY.');
    }
  } else {
    if (isNumericToken(parts[2])) {
      [name, lot, qtyText, expiry] = [parts[0], parts[1], parts[2], parts[3]];
    } else if (isNumericToken(parts[3])) {
      [name, lot, expiry, qtyText] = [parts[0], parts[1], parts[2], parts[3]];
    } else {
      throw new Error('Expected formats: VACCINE,LOT,QTY,EXPIRY or VACCINE,LOT,EXPIRY,QTY.');
    }
  }

  const qty = Number.parseInt(String(qtyText || '').trim(), 10);
  if (!lot || !Number.isFinite(qty) || qty <= 0) {
    throw new Error('Structured inventory line must include a lot and positive quantity.');
  }

  return {
    name,
    lot,
    expiry,
    gtin: '',
    serial: '',
    total_doses: qty,
    remaining_doses: qty,
    scanned_at: new Date().toISOString()
  };
}

export async function enrichParsedData(baseData, sendRuntimeMessage) {
  let lookup = null;
  if (baseData.lot) {
    lookup = await sendRuntimeMessage({
      action: 'lookupVaccineInfo',
      lot: baseData.lot,
      gtin: baseData.gtin || ''
    });
  }

  const chosenExpiry = baseData.expiry || lookup?.lot_expiry || '';
  const expiryStatus = getExpiryStatus(chosenExpiry);
  const resolvedName =
    baseData.name ||
    lookup?.generic_name ||
    lookup?.tradename ||
    baseData.lot ||
    '';

  return {
    ...baseData,
    name: resolvedName,
    tradename: lookup?.tradename || baseData.tradename || '',
    generic_name: lookup?.generic_name || baseData.generic_name || '',
    disease: lookup?.disease || baseData.disease || '',
    antigen: lookup?.antigen || baseData.antigen || '',
    manufacturer: lookup?.manufacturer || baseData.manufacturer || '',
    nvc_lot_expiry: lookup?.lot_expiry || '',
    inventory_expiry: chosenExpiry,
    expiry_flag: expiryStatus.flag,
    expiry_days_remaining: expiryStatus.daysRemaining,
    expiry_source: baseData.expiry ? 'barcode' : (lookup?.lot_expiry ? 'nvc' : 'none'),
    route: lookup?.route || '',
    strength: lookup?.strength || '',
    dose_value: lookup?.dose_value || '',
    dose_unit: lookup?.dose_unit || '',
    din: lookup?.din || '',
    drug_code: lookup?.din || '',
    lookup_error: lookup?.error || ''
  };
}

export async function parseInventoryLines(lines, sendRuntimeMessage) {
  const records = [];
  let failed = 0;

  for (const line of lines) {
    try {
      let parsed;
      if (isStructuredInventoryLine(line)) {
        parsed = buildStructuredParsedData(line);
      } else {
        try {
          parsed = parseInputData(line);
        } catch (parseError) {
          if (!isLikelyLotOnlyInput(line)) {
            throw parseError;
          }
          parsed = buildLotOnlyParsedData(line);
        }
      }

      const enriched = await enrichParsedData(
        {
          ...parsed,
          scanned_at: new Date().toISOString()
        },
        sendRuntimeMessage
      );
      records.push(buildLegacyQueueRecord(enriched, line));
    } catch (_) {
      failed += 1;
    }
  }

  return {
    records,
    failed
  };
}

export const parseReceivedLines = parseInventoryLines;
