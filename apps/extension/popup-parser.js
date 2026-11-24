import './shared/gs1-parser.js';
import './shared/expiry-date.js';

const GS1Parser = globalThis.VaxLinkGS1Parser;

export const parseGS1Barcode = GS1Parser.parseGS1Barcode;
export const formatDate = GS1Parser.formatDate;

export function parseInputData(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) {
    throw new Error('No input provided');
  }

  if (input.startsWith('01') || input.startsWith('(01)')) {
    return parseGS1Barcode(input);
  }

  const manual = parseManualTestInput(input);
  if (manual) {
    return manual;
  }

  return parseGS1Barcode(input);
}

export function parseManualTestInput(input) {
  const normalized = String(input || '').trim();
  if (!normalized) return null;

  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    const obj = JSON.parse(normalized);
    if (!obj || typeof obj !== 'object') {
      throw new Error('Manual JSON input must be an object');
    }
    const data = {
      gtin: obj.gtin || null,
      expiry: obj.expiry || null,
      lot: obj.lot || obj.lot_number || null,
      serial: obj.serial || null,
      name: obj.name || obj.agent || obj.generic_name || obj.tradename || null,
      tradename: obj.tradename || null,
      generic_name: obj.generic_name || null
    };
    if (!data.name && !data.lot && !data.tradename) {
      throw new Error(
        'Manual JSON must include at least one of: name/agent, tradename, lot'
      );
    }
    return data;
  }

  if (/[=]/.test(normalized)) {
    const pairs = normalized
      .split(/[;\n]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const map = {};
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = pair.slice(0, eqIdx).trim().toLowerCase();
      const value = pair.slice(eqIdx + 1).trim();
      if (key) map[key] = value;
    }

    if (Object.keys(map).length > 0) {
      const data = {
        gtin: map.gtin || null,
        expiry: map.expiry || null,
        lot: map.lot || map.lot_number || null,
        serial: map.serial || null,
        name:
          map.name || map.agent || map.generic_name || map.tradename || null,
        tradename: map.tradename || null,
        generic_name: map.generic_name || null
      };
      if (!data.name && !data.lot && !data.tradename) {
        throw new Error(
          'Manual key-value input must include name/agent, tradename, or lot'
        );
      }
      return data;
    }
  }

  return null;
}

export const parseDateToLocal = globalThis.VaxLinkExpiryDate.parseDateToLocal;

export function getExpiryStatus(dateValue) {
  const expiry = parseDateToLocal(dateValue);
  if (!expiry) {
    return {
      flag: 'unknown',
      label: 'Unknown',
      color: '#6b7280',
      daysRemaining: null
    };
  }

  const daysRemaining = globalThis.VaxLinkExpiryDate.daysUntil(expiry);

  if (daysRemaining < 0) {
    return {
      flag: 'expired',
      label: `Expired (${Math.abs(daysRemaining)} day(s) ago)`,
      color: '#b91c1c',
      daysRemaining
    };
  }

  if (daysRemaining <= 30) {
    return {
      flag: 'expiring_soon',
      label: `Expiring soon (${daysRemaining} day(s) left)`,
      color: '#b45309',
      daysRemaining
    };
  }

  return {
    flag: 'valid',
    label: `Valid (${daysRemaining} day(s) left)`,
    color: '#166534',
    daysRemaining
  };
}
