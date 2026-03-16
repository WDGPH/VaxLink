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

export function parseGS1Barcode(barcode) {
  const GS = String.fromCharCode(0x1d);
  let scan = String(barcode || '')
    .trim()
    .replace(/[\t\r\n]/g, GS)
    .replace(/^\]C1/i, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/[^\x20-\x7E\x1D]/g, '');

  if (!scan.startsWith('01')) {
    const first01 = scan.indexOf('01');
    if (first01 > 0) {
      scan = scan.substring(first01);
    }
  }

  const data = { gtin: null, expiry: null, lot: null, serial: null };
  if (!scan.startsWith('01')) {
    throw new Error('Expected AI(01) at start');
  }

  data.gtin = scan.substring(2, 16);
  let idx = 16;

  while (idx < scan.length) {
    if (scan.charAt(idx) === GS) {
      idx += 1;
      continue;
    }

    const currentAI = scan.substring(idx, idx + 2);
    if (currentAI === '17') {
      if (scan.length < idx + 8) {
        throw new Error('AI(17) expiry date incomplete');
      }
      data.expiry = formatDate(scan.substring(idx + 2, idx + 8));
      idx += 8;
    } else if (currentAI === '10') {
      idx += 2;
      let lotEnd = findNextAI(scan, idx, GS, '10');
      if (lotEnd === -1) {
        lotEnd = scan.length;
      }
      data.lot = scan.substring(idx, lotEnd);
      idx = lotEnd;
    } else if (currentAI === '21') {
      idx += 2;
      let serialEnd = findNextAI(scan, idx, GS, '21');
      if (serialEnd === -1) {
        serialEnd = scan.length;
      }
      data.serial = scan.substring(idx, serialEnd);
      idx = serialEnd;
    } else {
      const nextKnownAI = findNextAI(scan, idx, GS, null);
      if (nextKnownAI > idx) {
        idx = nextKnownAI;
        continue;
      }
      break;
    }
  }

  return data;
}

export function findNextAI(scan, startIdx, separator, currentVariableAI = null) {
  if (separator && scan.includes(separator) && scan.substring(startIdx).includes(separator)) {
    const ais = ['17', '10', '21'];
    for (let i = startIdx; i < scan.length - 1; i += 1) {
      const twoChar = scan.substring(i, i + 2);
      if (ais.includes(twoChar) && i > 0 && scan.charAt(i - 1) === separator) {
        return i;
      }
    }
  }

  const memo = new Map();
  return findNextAINoGS(scan, startIdx, memo, currentVariableAI);
}

export function isLikelyAIStart(scan, idx) {
  if (idx < 0 || idx > scan.length - 2) return false;
  const ai = scan.substring(idx, idx + 2);
  if (ai === '17') {
    if (idx + 8 > scan.length) return false;
    return /^\d{6}$/.test(scan.substring(idx + 2, idx + 8));
  }
  return ai === '10' || ai === '21';
}

export function canParseTailNoGS(scan, idx, memo) {
  if (idx >= scan.length) return true;
  if (memo.has(idx)) return memo.get(idx);

  let ok = false;
  const ai = scan.substring(idx, idx + 2);
  if (ai === '17') {
    ok = idx + 8 <= scan.length
      && /^\d{6}$/.test(scan.substring(idx + 2, idx + 8))
      && canParseTailNoGS(scan, idx + 8, memo);
  } else if (ai === '10' || ai === '21') {
    const valueStart = idx + 2;
    if (valueStart < scan.length) {
      const next = findNextAINoGS(scan, valueStart, memo, ai);
      ok = next === -1 ? true : (next > valueStart && canParseTailNoGS(scan, next, memo));
    }
  }

  memo.set(idx, ok);
  return ok;
}

export function findNextAINoGS(scan, startIdx, memo, currentVariableAI = null) {
  for (let i = startIdx + 1; i < scan.length - 1; i += 1) {
    if (!isLikelyAIStart(scan, i)) continue;
    const candidateAI = scan.substring(i, i + 2);
    if (currentVariableAI && candidateAI === currentVariableAI) continue;
    if (canParseTailNoGS(scan, i, memo)) {
      return i;
    }
  }
  return -1;
}

export function formatDate(yymmdd) {
  if (!yymmdd || yymmdd.length !== 6) {
    return null;
  }
  const yy = yymmdd.substring(0, 2);
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);
  return `${mm}/${dd}/20${yy}`;
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
