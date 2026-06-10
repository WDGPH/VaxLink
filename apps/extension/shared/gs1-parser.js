(function attachVaxLinkGS1Parser(root) {
  const GS = String.fromCharCode(0x1d);

  function formatDate(yymmdd) {
    if (!yymmdd || yymmdd.length !== 6) return null;
    const yy = yymmdd.substring(0, 2);
    const mm = yymmdd.substring(2, 4);
    let dd = yymmdd.substring(4, 6);
    // GS1 allows day "00" meaning "last day of the month"; resolve it here so
    // downstream date math doesn't roll back into the previous month.
    if (dd === '00') {
      const lastDay = new Date(Number(`20${yy}`), Number(mm), 0).getDate();
      dd = String(lastDay).padStart(2, '0');
    }
    return `${mm}/${dd}/20${yy}`;
  }

  function normalizeGS1BarcodeText(value) {
    let scan = String(value || '')
      .trim()
      .replace(/[\t\r\n]/g, GS)
      // AIM symbology identifier: "]" + letter + digit, such as ]C1, ]d2,
      // ]Q3, or ]e0. Lot-only barcodes have no "01" to re-anchor on, so strip
      // the prefix generically.
      .replace(/^\][A-Za-z]\d/, '')
      .replace(/\(/g, '')
      .replace(/\)/g, '')
      .replace(/[^\x20-\x7E\x1D]/g, '');

    if (!scan.startsWith('01')) {
      // Re-anchor on embedded AI(01) only when a full 14-digit GTIN follows.
      // Otherwise lot-only values containing "01" can be truncated to garbage.
      const first01 = scan.indexOf('01');
      if (first01 > 0 && /^\d{14}/.test(scan.substring(first01 + 2))) {
        scan = scan.substring(first01);
      }
    }
    return scan;
  }

  function isLikelyAIStart(scan, idx) {
    if (idx < 0 || idx > scan.length - 2) return false;
    const ai = scan.substring(idx, idx + 2);
    if (ai === '17') {
      if (idx + 8 > scan.length) return false;
      return /^\d{6}$/.test(scan.substring(idx + 2, idx + 8));
    }
    return ai === '10' || ai === '21';
  }

  function canParseTailNoGS(scan, idx, memo) {
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

  function findNextAINoGS(scan, startIdx, memo, currentVariableAI = null) {
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

  function findNextAI(scan, startIdx, separator, currentVariableAI = null) {
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

  function parseGS1Barcode(rawScan) {
    const scan = normalizeGS1BarcodeText(rawScan);
    if (!scan) {
      throw new Error('Empty scan payload');
    }

    const data = { gtin: null, expiry: null, lot: null, serial: null };
    let idx = 0;
    if (scan.startsWith('01')) {
      if (scan.length < 16) {
        throw new Error('AI(01) GTIN incomplete');
      }
      data.gtin = scan.substring(2, 16);
      idx = 16;
    } else if (!isLikelyAIStart(scan, 0)) {
      throw new Error('Expected a GS1 AI sequence (01/17/10/21)');
    }

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
        data.lot = scan.substring(idx, lotEnd).replace(/\x1d/g, '');
        idx = lotEnd;
      } else if (currentAI === '21') {
        idx += 2;
        let serialEnd = findNextAI(scan, idx, GS, '21');
        if (serialEnd === -1) {
          serialEnd = scan.length;
        }
        data.serial = scan.substring(idx, serialEnd).replace(/\x1d/g, '');
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

    if (!data.gtin && !data.expiry && !data.lot && !data.serial) {
      throw new Error('No recognized GS1 fields found');
    }

    return data;
  }

  function isCandidateGS1Text(value) {
    const text = String(value || '').trim();
    if (text.length < 8) return false;
    const normalized = normalizeGS1BarcodeText(text);
    if (!normalized) return false;
    if (normalized.startsWith('01') || normalized.includes('01')) return true;
    if (normalized.startsWith('17')) {
      return normalized.length >= 8 && /^\d{6}$/.test(normalized.substring(2, 8));
    }
    if (normalized.startsWith('10') || normalized.startsWith('21')) {
      return normalized.length > 2;
    }
    return isLikelyAIStart(normalized, 0);
  }

  function hasNumericGtin(rawScan) {
    try {
      const parsed = parseGS1Barcode(rawScan);
      return !!(parsed.gtin && /^\d{14}$/.test(parsed.gtin));
    } catch (_) {
      return false;
    }
  }

  root.VaxLinkGS1Parser = Object.freeze({
    GS,
    formatDate,
    normalizeGS1BarcodeText,
    isLikelyAIStart,
    canParseTailNoGS,
    findNextAINoGS,
    findNextAI,
    parseGS1Barcode,
    isCandidateGS1Text,
    hasNumericGtin
  });
})(globalThis);
