let parseBtn;
let autoFillBtn;
let refreshNvcBtn;
let scannedInput;
let nvcStatusDiv;
let outputDiv;
let parsedData = null;
let activeParseRequestId = 0;
const lotLookupCache = new Map();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  parseBtn = document.getElementById('parseBtn');
  autoFillBtn = document.getElementById('autoFillBtn');
  refreshNvcBtn = document.getElementById('refreshNvcBtn');
  scannedInput = document.getElementById('scannedData');
  nvcStatusDiv = document.getElementById('nvcStatus');
  outputDiv = document.getElementById('output');
  
  if (parseBtn) {
    parseBtn.addEventListener('click', async () => {
      const barcode = scannedInput.value.trim();
      if (!barcode) {
        showOutput('Enter or scan a barcode', 'error');
        return;
      }

      const parseRequestId = ++activeParseRequestId;
      setButtonBusy(parseBtn, true, 'Parsing...');
      setButtonBusy(autoFillBtn, true);
      try {
        parsedData = parseGS1Barcode(barcode);
        await displayParsedData(parsedData, parseRequestId);
      } catch (e) {
        showOutput(`Error parsing barcode: ${e.message}`, 'error');
      } finally {
        if (parseRequestId === activeParseRequestId) {
          setButtonBusy(parseBtn, false);
          setButtonBusy(autoFillBtn, false);
        }
      }
    });
  }
  
  if (autoFillBtn) {
    autoFillBtn.addEventListener('click', () => {
      if (!parsedData) {
        showOutput('Parse barcode first', 'error');
        return;
      }
      
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        console.log('tabs.query returned:', tabs);
        if (!tabs.length) {
          showOutput('No active tab found', 'error');
          return;
        }
        const tabId = tabs[0].id;
        const tabUrl = tabs[0].url;
        console.log('Sending to tab - ID:', tabId, 'URL:', tabUrl);
        sendAutoFillMessage(tabId, parsedData);
      });
    });
  }

  if (refreshNvcBtn) {
    refreshNvcBtn.addEventListener('click', () => {
      refreshNvcBtn.disabled = true;
      showOutput('Refreshing NVC bundle...', 'info');

      chrome.runtime.sendMessage({ action: 'refreshNVCBundle' }, (response) => {
        refreshNvcBtn.disabled = false;
        if (chrome.runtime.lastError) {
          showOutput('NVC refresh failed: ' + chrome.runtime.lastError.message, 'error');
          return;
        }

        if (!response || !response.success) {
          showOutput('NVC refresh failed: ' + (response?.error || 'Unknown error'), 'error');
          return;
        }

        const count = response.entryCount ?? 'unknown';
        showOutput(`NVC update successful (${count} entries).`, 'success');
        loadNVCStatus();
      });
    });
  }

  loadNVCStatus();
});

function formatDateTime(value) {
  if (!value) return 'Never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function renderNVCStatus(status) {
  if (!nvcStatusDiv || !status) return;
  const updated = formatDateTime(status.updatedAt);
  const checked = formatDateTime(status.lastCheckAt);
  const intervalHours = Math.round((status.autoSyncIntervalMinutes || 0) / 60);
  nvcStatusDiv.textContent = `Last bundle update: ${updated} | Last check: ${checked} | Auto-check: every ${intervalHours}h`;
}

function loadNVCStatus() {
  chrome.runtime.sendMessage({ action: 'getNVCUpdateStatus' }, (status) => {
    if (chrome.runtime.lastError || !status) {
      return;
    }
    renderNVCStatus(status);
  });
}

function setButtonBusy(button, busy, busyText) {
  if (!button) return;
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent;
  }
  button.disabled = busy;
  button.classList.toggle('button-busy', busy);
  button.textContent = busy && busyText ? busyText : button.dataset.defaultLabel;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function getLoadingMarkup(text) {
  return `<div class="lookup-loading"><span class="inline-spinner" aria-hidden="true"></span><span>${text}</span></div>`;
}

async function lookupVaccineInfo(lot) {
  const lotKey = String(lot || '').trim().toLowerCase();
  if (!lotKey) {
    return { error: 'No lot number provided' };
  }
  if (lotLookupCache.has(lotKey)) {
    return lotLookupCache.get(lotKey);
  }
  const response = await sendRuntimeMessage({ action: 'lookupVaccineInfo', lot });
  lotLookupCache.set(lotKey, response);
  return response;
}

function sendAutoFillMessage(tabId, data) {
  chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, (response) => {
    console.log('sendMessage callback fired');
    console.log('response:', response);
    console.log('lastError:', chrome.runtime.lastError);

    if (chrome.runtime.lastError) {
      const message = chrome.runtime.lastError.message || '';
      console.error('chrome.runtime.lastError:', message);

      if (message.includes('Receiving end does not exist')) {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['content.js'] },
          () => {
            if (chrome.runtime.lastError) {
              showOutput('Message failed and script injection failed: ' + chrome.runtime.lastError.message, 'error');
              return;
            }
            chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, handleAutoFillResponse);
          }
        );
        return;
      }

      showOutput('Message send failed: ' + message, 'error');
      return;
    }

    handleAutoFillResponse(response);
  });
}

function handleAutoFillResponse(response) {
  if (chrome.runtime.lastError) {
    showOutput('Auto-fill failed: ' + chrome.runtime.lastError.message, 'error');
    return;
  }

  if (response && response.success) {
    showOutput('Telus chart auto-filled', 'success');
  } else if (response && response.error) {
    showOutput(response.error, 'error');
  } else {
    showOutput('Could not auto-fill Telus fields', 'error');
  }
}

function parseGS1Barcode(barcode) {
  const GS = String.fromCharCode(0x1d); // Group separator character
  let s = barcode.trim().replace(/\(/g, '').replace(/\)/g, '');
  
  console.log('Parsing barcode:', s, 'length:', s.length);
  
  const data = { gtin: null, expiry: null, lot: null, serial: null };
  
  // Parse GTIN (always first, 14 digits fixed after AI 01)
  if (!s.startsWith('01')) {
    throw new Error('Expected AI(01) at start');
  }
  
  data.gtin = s.substring(2, 16);
  let idx = 16;
  console.log('Parsed GTIN:', data.gtin, 'next idx:', idx);
  
  // Parse remaining AIs in order
  while (idx < s.length) {
    const currentAI = s.substring(idx, idx + 2);
    console.log('At idx', idx, 'found AI:', currentAI);
    
    if (currentAI === '17') {
      // Fixed length: 6 digits (YYMMDD)
      if (s.length < idx + 8) {
        throw new Error('AI(17) expiry date incomplete');
      }
      const yymmdd = s.substring(idx + 2, idx + 8);
      data.expiry = formatDate(yymmdd);
      console.log('Parsed expiry:', yymmdd, 'formatted:', data.expiry);
      idx += 8;
      
    } else if (currentAI === '10') {
      // Variable length: lot number
      idx += 2;
      let lotEnd = findNextAI(s, idx, GS);
      if (lotEnd === -1) {
        lotEnd = s.length;
      }
      data.lot = s.substring(idx, lotEnd);
      console.log('Parsed lot from', idx, 'to', lotEnd, ':', data.lot);
      idx = lotEnd;
      
    } else if (currentAI === '21') {
      // Variable length: serial number
      idx += 2;
      let serialEnd = findNextAI(s, idx, GS);
      if (serialEnd === -1) {
        serialEnd = s.length;
      }
      data.serial = s.substring(idx, serialEnd);
      console.log('Parsed serial from', idx, 'to', serialEnd, ':', data.serial);
      idx = serialEnd;
      
    } else {
      // Unknown AI or end of valid data
      console.log('Unknown AI, breaking. idx:', idx, 'char:', currentAI);
      break;
    }
  }
  
  console.log('Final parsed data:', data);
  return data;
}

function findNextAI(s, startIdx, GS) {
  // Prefer GS-based boundaries when separators are present.
  if (GS && s.includes(GS) && s.substring(startIdx).includes(GS)) {
    const ais = ['17', '10', '21'];
    for (let i = startIdx; i < s.length - 1; i++) {
      const twoChar = s.substring(i, i + 2);
      if (ais.includes(twoChar) && i > 0 && s.charAt(i - 1) === GS) {
        return i;
      }
    }
  }

  // Fallback for scans without GS: detect likely AI boundaries by validating
  // that the remaining tail can still be parsed.
  const memo = new Map();
  return findNextAINoGS(s, startIdx, memo);
}

function isLikelyAIStart(s, idx) {
  if (idx < 0 || idx > s.length - 2) return false;
  const ai = s.substring(idx, idx + 2);
  if (ai === '17') {
    if (idx + 8 > s.length) return false;
    return /^\d{6}$/.test(s.substring(idx + 2, idx + 8));
  }
  return ai === '10' || ai === '21';
}

function canParseTailNoGS(s, idx, memo) {
  if (idx >= s.length) return true;
  if (memo.has(idx)) return memo.get(idx);

  let ok = false;
  const ai = s.substring(idx, idx + 2);
  if (ai === '17') {
    ok = idx + 8 <= s.length &&
      /^\d{6}$/.test(s.substring(idx + 2, idx + 8)) &&
      canParseTailNoGS(s, idx + 8, memo);
  } else if (ai === '10' || ai === '21') {
    const valueStart = idx + 2;
    if (valueStart < s.length) {
      const next = findNextAINoGS(s, valueStart, memo);
      ok = next === -1 ? true : (next > valueStart && canParseTailNoGS(s, next, memo));
    }
  } else {
    ok = false;
  }

  memo.set(idx, ok);
  return ok;
}

function findNextAINoGS(s, startIdx, memo) {
  for (let i = startIdx + 1; i < s.length - 1; i++) {
    if (!isLikelyAIStart(s, i)) continue;
    if (canParseTailNoGS(s, i, memo)) {
      return i;
    }
  }
  return -1;
}

function formatDate(yymmdd) {
  if (!yymmdd || yymmdd.length !== 6) {
    return null;
  }
  const yy = yymmdd.substring(0, 2);
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);
  return `${mm}/${dd}/20${yy}`;
}

function parseDateToLocal(dateValue) {
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

function getExpiryStatus(dateValue) {
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

function buildExpiryBanner(status) {
  if (!status) return '';
  if (status.flag === 'expired') {
    return `<div class="expiry-banner expired">WARNING: Vaccine is expired. ${status.label}</div>`;
  }
  if (status.flag === 'expiring_soon') {
    return `<div class="expiry-banner expiring">ATTENTION: Vaccine expiry is near. ${status.label}</div>`;
  }
  return '';
}

function outputTypeForExpiry(status) {
  if (!status) return 'info';
  if (status.flag === 'expired') return 'error';
  if (status.flag === 'expiring_soon') return 'warning';
  return 'info';
}

async function displayParsedData(data, parseRequestId) {
  console.log('displayParsedData called with:', data);
  const expiryStatus = getExpiryStatus(data.expiry);
  const warningBanner = buildExpiryBanner(expiryStatus);
  const outputType = outputTypeForExpiry(expiryStatus);
  
  let html = `${warningBanner}<strong>Parsed Barcode Data:</strong><br>`;
  html += `<span style="color: #333;">GTIN: </span>${data.gtin || 'N/A'}<br>`;
  html += `<span style="color: #333;">Expiry: </span>${data.expiry || 'N/A'}<br>`;
  html += `<span style="color: #333;">Expiry Flag: </span><strong style="color:${expiryStatus.color};">${expiryStatus.label}</strong><br>`;
  html += `<span style="color: #333;">Lot: </span>${data.lot || 'N/A'}<br>`;
  html += `<span style="color: #333;">Serial: </span>${data.serial || 'N/A'}<br>`;
  
  // Show loading message while looking up vaccine info
  if (data.lot) {
    html += '<br><strong>Vaccine Information:</strong><br>';
    html += getLoadingMarkup('Looking up lot in NVC...');
    showOutput(html, outputType);

    console.log('Sending lookup request for lot:', data.lot);
    try {
      const response = await lookupVaccineInfo(data.lot);
      if (parseRequestId !== activeParseRequestId) {
        return;
      }
      console.log('Received lookup response:', response);
      displayVaccineInfo(data, response);
    } catch (error) {
      if (parseRequestId !== activeParseRequestId) {
        return;
      }
      console.error('Lookup error:', error);
      displayVaccineInfo(data, { error: error.message || 'Lookup failed' });
    }
  } else {
    console.log('No lot found, only showing barcode data');
    showOutput(html, outputType);
  }
}

function displayVaccineInfo(barcodeData, vaccineInfo) {
  const chosenExpiry = barcodeData.expiry || vaccineInfo?.lot_expiry || null;
  const expiryStatus = getExpiryStatus(chosenExpiry);
  const expirySource = barcodeData.expiry ? 'barcode' : (vaccineInfo?.lot_expiry ? 'nvc' : 'none');
  const warningBanner = buildExpiryBanner(expiryStatus);
  const outputType = outputTypeForExpiry(expiryStatus);

  let html = `${warningBanner}<strong>Parsed Barcode Data:</strong><br>`;
  html += `<span style="color: #333;">GTIN: </span>${barcodeData.gtin || 'N/A'}<br>`;
  html += `<span style="color: #333;">Expiry: </span>${barcodeData.expiry || 'N/A'}<br>`;
  html += `<span style="color: #333;">Expiry Flag: </span><strong style="color:${expiryStatus.color};">${expiryStatus.label}</strong> <span style="color:#64748b;">(${expirySource})</span><br>`;
  html += `<span style="color: #333;">Lot: </span>${barcodeData.lot || 'N/A'}<br>`;
  html += `<span style="color: #333;">Serial: </span>${barcodeData.serial || 'N/A'}<br>`;
  
  html += '<br><strong>Vaccine Information from NVC:</strong><br>';
  
  if (vaccineInfo && !vaccineInfo.error) {
    // Merge vaccine info into parsedData for auto-fill
    parsedData.tradename = vaccineInfo.tradename;
    parsedData.generic_name = vaccineInfo.generic_name;
    parsedData.disease = vaccineInfo.disease;
    parsedData.antigen = vaccineInfo.antigen;
    parsedData.manufacturer = vaccineInfo.manufacturer;
    parsedData.nvc_lot_expiry = vaccineInfo.lot_expiry;
    parsedData.din = vaccineInfo.din;
    parsedData.route = vaccineInfo.route;
    parsedData.strength = vaccineInfo.strength;
    parsedData.dose_value = vaccineInfo.dose_value;
    parsedData.dose_unit = vaccineInfo.dose_unit;
    parsedData.drug_code = vaccineInfo.din;
    parsedData.name = vaccineInfo.generic_name || vaccineInfo.tradename || vaccineInfo.din;
    parsedData.expiry_flag = expiryStatus.flag;
    parsedData.expiry_days_remaining = expiryStatus.daysRemaining;
    parsedData.expiry_source = expirySource;
    
    html += `<span style="color: #333;">Trade Name: </span>${vaccineInfo.tradename || 'N/A'}<br>`;
    html += `<span style="color: #333;">Generic Name: </span>${vaccineInfo.generic_name || 'N/A'}<br>`;
    html += `<span style="color: #333;">Disease(s): </span>${vaccineInfo.disease || 'N/A'}<br>`;
    html += `<span style="color: #333;">Antigen: </span>${vaccineInfo.antigen || 'N/A'}<br>`;
    html += `<span style="color: #333;">Manufacturer: </span>${vaccineInfo.manufacturer || 'N/A'}<br>`;
    html += `<span style="color: #333;">Route: </span>${vaccineInfo.route || 'N/A'}<br>`;
    html += `<span style="color: #333;">Strength: </span>${vaccineInfo.strength || 'N/A'}<br>`;
    html += `<span style="color: #333;">Dose: </span>${vaccineInfo.dose_value || 'N/A'} ${vaccineInfo.dose_unit || ''}<br>`;
    if (vaccineInfo.lot_expiry) {
      html += `<span style="color: #333;">NVC Lot Expiry: </span>${vaccineInfo.lot_expiry}<br>`;
    }
    if (vaccineInfo.din) {
      html += `<span style="color: #333;">DIN: </span>${vaccineInfo.din}<br>`;
    }
  } else {
    html += `<span style="color: #d9534f;">${vaccineInfo?.error || 'No vaccine information found'}</span>`;
  }
  
  showOutput(html, outputType);
}

function showOutput(message, type = 'info') {
  outputDiv.innerHTML = message;
  outputDiv.style.display = 'block';
  outputDiv.className = 'output ' + type;
}
