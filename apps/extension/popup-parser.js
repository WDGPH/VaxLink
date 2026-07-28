import './shared/gs1-parser.js';

const GS1Parser = globalThis.VaxLinkGS1Parser;

export const parseGS1Barcode = GS1Parser.parseGS1Barcode;
export const findNextAI = GS1Parser.findNextAI;
export const isLikelyAIStart = GS1Parser.isLikelyAIStart;
export const canParseTailNoGS = GS1Parser.canParseTailNoGS;
export const findNextAINoGS = GS1Parser.findNextAINoGS;
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
      throw new Error('Manual JSON must include at least one of: name/agent, tradename, lot');
    }
    return data;
  }

  if (/[=]/.test(normalized)) {
    const pairs = normalized.split(/[;\n]+/).map((part) => part.trim()).filter(Boolean);
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
        name: map.name || map.agent || map.generic_name || map.tradename || null,
        tradename: map.tradename || null,
        generic_name: map.generic_name || null
      };
      if (!data.name && !data.lot && !data.tradename) {
        throw new Error('Manual key-value input must include name/agent, tradename, or lot');
      }
      return data;
    }
  }

  return null;
}

export function parseDateToLocal(dateValue) {
  if (!dateValue) return null;
  const raw = String(dateValue).trim();
  if (!raw) return null;

  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const mm = Number(mdy[1]);
    const dd = Number(mdy[2]);
    const yyyy = Number(mdy[3]);
    return new Date(yyyy, mm - 1, dd);
  }

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    const yyyy = Number(ymd[1]);
    const mm = Number(ymd[2]);
    const dd = Number(ymd[3]);
    return new Date(yyyy, mm - 1, dd);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

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

  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.floor((expiry.getTime() - todayMidnight.getTime()) / msPerDay);

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

export function buildExpiryBanner(status) {
  if (!status) return '';
  if (status.flag === 'expired') {
    return `<div class="expiry-banner expired">WARNING: Vaccine is expired. ${status.label}</div>`;
  }
  if (status.flag === 'expiring_soon') {
    return `<div class="expiry-banner expiring">ATTENTION: Vaccine expiry is near. ${status.label}</div>`;
  }
  return '';
}

export function outputTypeForExpiry(status) {
  if (!status) return 'info';
  if (status.flag === 'expired') return 'error';
  if (status.flag === 'expiring_soon') return 'warning';
  return 'info';
}
