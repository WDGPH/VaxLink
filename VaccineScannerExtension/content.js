// Debug: Log immediately when script loads
console.log('===== CONTENT SCRIPT STARTING =====');
console.log('Location:', window.location.href);
console.log('Document ready state:', document.readyState);

console.log('Vaccine Scanner content script loaded:', location.href);

console.log('Setting up message listener...');

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('✓ Auto-fill message received:', request);
    if (request.action === 'autoFill') {
      try {
        console.log('Calling autoFillTelus with data:', request.data);
        const success = autoFillTelus(request.data);
        console.log('autoFillTelus returned:', success);
        sendResponse({ success: success });
      } catch (e) {
        console.error('Error in autoFillTelus:', e);
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }
    console.log('Unknown action:', request.action);
    sendResponse({ success: false, error: 'Unknown action' });
    return true;
  });
  console.log('✓ Message listener registered');
}

// Register listener immediately
setupMessageListener();

// Also re-register when DOM is ready in case of timing issues
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOMContentLoaded fired, listener should already be active');
});

function toIsoDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const mm = mdy[1].padStart(2, '0');
    const dd = mdy[2].padStart(2, '0');
    return `${mdy[3]}-${mm}-${dd}`;
  }
  return null;
}

function getFields(selectors) {
  const seen = new Set();
  const fields = [];
  for (const selector of selectors) {
    const matches = document.querySelectorAll(selector);
    for (const el of matches) {
      if (!seen.has(el)) {
        seen.add(el);
        fields.push(el);
      }
    }
  }
  return fields;
}

function fillField(field, value) {
  if (!field || value === undefined || value === null || value === '') {
    return false;
  }

  if (field.tagName === 'SELECT') {
    return fillSelectField(field, value);
  }

  const role = (field.getAttribute && field.getAttribute('role')) || '';
  const ariaAuto = (field.getAttribute && field.getAttribute('aria-autocomplete')) || '';
  const ariaHasPopup = (field.getAttribute && field.getAttribute('aria-haspopup')) || '';
  const classHint = (field.className || '').toLowerCase();
  const idHint = (field.id || '').toLowerCase();
  if (
    role === 'combobox' ||
    ariaAuto ||
    ariaHasPopup === 'listbox' ||
    classHint.includes('select') ||
    classHint.includes('combo') ||
    idHint.includes('selectbox')
  ) {
    return fillComboTextField(field, value);
  }

  let nextValue = String(value);
  if (field.type === 'date') {
    const iso = toIsoDate(nextValue);
    if (!iso) {
      console.warn('Could not convert date for field:', field.name || field.id, nextValue);
      return false;
    }
    nextValue = iso;
  }

  field.focus();
  field.value = nextValue;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.blur();
  return true;
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[:/,_-]/g, ' ')
    .replace(/\broute\b/g, ' ')
    .replace(/\bqualifier\b/g, ' ')
    .replace(/\bvalue\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getValueAliases(rawValue, contextField) {
  const aliases = [];
  const normalized = normalizeForMatch(rawValue);
  if (!normalized) return aliases;

  aliases.push(rawValue);
  aliases.push(normalized);

  const unitAliases = {
    ml: ['millilitre(s)', 'millilitres', 'milliliter(s)', 'milliliters'],
    mg: ['milligram(s)', 'milligrams'],
    g: ['gram(s)', 'grams'],
    mcg: ['microgram(s)', 'micrograms'],
    ug: ['microgram(s)', 'micrograms'],
    l: ['litre(s)', 'litres', 'liter(s)', 'liters'],
    iu: ['international unit(s)', 'iu'],
    units: ['unit(s)', 'units']
  };

  const compact = normalized.replace(/\s+/g, '');
  if (unitAliases[compact]) {
    aliases.push(...unitAliases[compact]);
  }

  return [...new Set(aliases.map(v => normalizeForMatch(v)).filter(Boolean))];
}

function fillSelectField(field, value) {
  const rawValue = String(value).trim();
  if (!rawValue) return false;
  const candidates = getValueAliases(rawValue, field);
  const options = Array.from(field.options || []).filter(opt => opt && opt.value !== '');
  if (!options.length) return false;

  let matched = options.find(opt => opt.value === rawValue || opt.text.trim() === rawValue);
  if (!matched) {
    matched = options.find(opt => candidates.includes(normalizeForMatch(opt.text)));
  }
  if (!matched && candidates.length > 0) {
    matched = options.find(opt => {
      const optNorm = normalizeForMatch(opt.text);
      return candidates.some(desired => optNorm.includes(desired) || desired.includes(optNorm));
    });
  }
  if (!matched) return false;

  field.focus();
  field.value = matched.value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.blur();
  return true;
}

function fillComboTextField(field, value) {
  const rawValue = String(value).trim();
  if (!rawValue) return false;
  const candidates = getValueAliases(rawValue, field);
  if (!candidates.length) return false;

  const unitTextAliases = {
    ml: 'Millilitre(s)',
    mg: 'Milligram(s)',
    mcg: 'Microgram(s)',
    ug: 'Microgram(s)',
    g: 'Gram(s)',
    l: 'Litre(s)',
    iu: 'International Unit(s)',
    units: 'Unit(s)'
  };
  const compactRaw = normalizeForMatch(rawValue).replace(/\s+/g, '');
  const preferredTypedValue = unitTextAliases[compactRaw] || rawValue;

  field.focus();
  if ('value' in field) {
    field.value = preferredTypedValue;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
  }
  field.click();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

  // Best-effort pick for custom dropdown implementations (ng-select/react-select).
  const optionSelectors = [
    '[role="option"]',
    'li[role="option"]',
    '.ng-option',
    '.mat-option',
    '.select-option',
    '.dropdown-item',
    '.ui-menu-item',
    '.p-dropdown-item'
  ];
  for (const selector of optionSelectors) {
    const options = Array.from(document.querySelectorAll(selector));
    const hit = options.find(opt => {
      const optNorm = normalizeForMatch(opt.textContent || '');
      return candidates.some(desired => optNorm === desired || optNorm.includes(desired) || desired.includes(optNorm));
    });
    if (hit) {
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      hit.click();
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.blur();
      return true;
    }
  }

  // Keyboard fallback for autocomplete controls.
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.blur();
  return String(field.value || '').trim().length > 0;
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getDoseUnitFieldByLayout() {
  const labels = Array.from(document.querySelectorAll('label, span, div'));
  const controlSelector = [
    'select',
    'input',
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
    '.ng-select',
    '.mat-select',
    '.p-dropdown',
    '.ui-dropdown'
  ].join(', ');

  for (const label of labels) {
    const text = normalizeForMatch(label.textContent || '');
    if (!(text === 'dose' || text.startsWith('dose '))) {
      continue;
    }

    const container = label.parentElement;
    if (!container) continue;

    const controls = Array.from(
      container.querySelectorAll(controlSelector)
    ).filter(el => isVisible(el) && el.type !== 'hidden' && !el.disabled);

    if (controls.length >= 2) {
      const unitControl =
        controls.find(el => el.tagName === 'SELECT' || (el.getAttribute && el.getAttribute('role') === 'combobox')) ||
        controls[1];
      if (unitControl) return unitControl;
    }

    const next = container.nextElementSibling;
    if (next) {
      const nextControls = Array.from(
        next.querySelectorAll(controlSelector)
      ).filter(el => isVisible(el) && el.type !== 'hidden' && !el.disabled);
      if (nextControls.length >= 2) {
        const unitControl =
          nextControls.find(el => el.tagName === 'SELECT' || (el.getAttribute && el.getAttribute('role') === 'combobox')) ||
          nextControls[1];
        if (unitControl) return unitControl;
      }
    }
  }
  return null;
}

function autoFillTelus(data) {
  try {
    const mapping = [
      {
        value: data.lot,
        selectors: [
          'input[name="lot_number"]',
          'input[name="parsed_lot"]',
          'input[id="lot_number"]',
          'input[id="parsed_lot"]',
          'input[id*="lot"]',
          'input[placeholder*="Lot"]'
        ]
      },
      {
        value: data.expiry,
        selectors: [
          'input[name="expiry_date"]',
          'input[name="parsed_expiry"]',
          'input[id="expiry_date"]',
          'input[id="parsed_expiry"]',
          'input[id*="expiry"]',
          'input[placeholder*="Expiry"]'
        ]
      },
      {
        value: data.gtin,
        selectors: [
          'input[name="gtin"]',
          'input[name="parsed_gtin"]',
          'input[id="gtin"]',
          'input[id="parsed_gtin"]',
          'input[id*="gtin"]',
          'input[placeholder*="GTIN"]'
        ]
      },
      {
        value: data.serial,
        selectors: [
          'input[name="serial"]',
          'input[name="parsed_serial"]',
          'input[id="serial"]',
          'input[id="parsed_serial"]',
          'input[id*="serial"]',
          'input[placeholder*="Serial"]'
        ]
      },
      {
        value: data.tradename,
        selectors: [
          'input[name="trade_name"]',
          'input[id="trade_name"]',
          'input[name="tradename"]',
          'input[id="tradename"]'
        ]
      },
      {
        value: data.generic_name,
        selectors: [
          'input[name="generic_name"]',
          'input[id="generic_name"]'
        ]
      },
      {
        value: data.name || data.generic_name || data.tradename || data.din,
        selectors: [
          'input[name="name"]',
          'input[id="name"]',
          'input[name*="vaccine_name"]',
          'input[id*="vaccine_name"]',
          'input[name*="medication_name"]',
          'input[id*="medication_name"]',
          'input[name*="name"]:not([name*="trade"]):not([name*="manufacturer"])',
          'input[id*="name"]:not([id*="trade"]):not([id*="manufacturer"])'
        ]
      },
      {
        value: data.disease,
        selectors: [
          'input[name="disease"]',
          'input[id="disease"]'
        ]
      },
      {
        value: data.antigen,
        selectors: [
          'input[name="antigen"]',
          'input[id="antigen"]'
        ]
      },
      {
        value: data.manufacturer,
        selectors: [
          'input[name="manufacturer"]',
          'input[id="manufacturer"]',
          'input[id*="manufacturer"]',
          'input[name*="manufacturer"]'
        ]
      },
      {
        value: data.route,
        selectors: [
          'select[name="route"]',
          'select[id="route"]',
          'select[name*="route"]',
          'select[id*="route"]',
          'input[name="route"]',
          'input[id="route"]',
          'input[name*="route"]',
          'input[id*="route"]'
        ]
      },
      {
        value: data.strength,
        selectors: [
          'input[name="strength"]',
          'input[id="strength"]',
          'input[name*="strength"]',
          'input[id*="strength"]'
        ]
      },
      {
        value: data.dose_value,
        selectors: [
          'input[name="dose"]',
          'input[id="dose"]',
          'input[name*="dose"]',
          'input[id*="dose"]'
        ]
      },
      {
        value: data.dose_unit,
        selectors: [
          '#ih-selectbox-32',
          '[id^="ih-selectbox-"]',
          'input[data-testid="doseUnitSelect"]',
          'select[name="dose_unit"]',
          'select[id="dose_unit"]',
          'select[name*="dose"]',
          'select[id*="dose"]',
          'select[name*="unit"]',
          'select[id*="unit"]',
          'input[name="dose_unit"]',
          'input[id="dose_unit"]',
          'input[name*="unit"]',
          'input[id*="unit"]',
          'input[role="combobox"]'
        ]
      },
      {
        value: data.nvc_lot_expiry,
        selectors: [
          'input[name="nvc_lot_expiry"]',
          'input[id="nvc_lot_expiry"]'
        ]
      },
      {
        value: data.drug_code || data.din,
        selectors: [
          'input[name="drug_code"]',
          'input[id="drug_code"]',
          'input[name*="drug_code"]',
          'input[id*="drug_code"]',
          'input[name*="drugcode"]',
          'input[id*="drugcode"]',
          'input[name*="drug"]',
          'input[id*="drug"]',
          'input[name="din"]',
          'input[id="din"]',
          'input[name*="din"]',
          'input[id*="din"]'
        ]
      }
    ];

    let fillCount = 0;
    for (const entry of mapping) {
      const fields = getFields(entry.selectors);
      for (const field of fields) {
        if (fillField(field, entry.value)) {
          fillCount += 1;
        }
      }
    }

    if (data.dose_unit) {
      const unitField = getDoseUnitFieldByLayout();
      if (unitField && fillField(unitField, data.dose_unit)) {
        fillCount += 1;
      }
    }

    console.log('Auto-fill updated fields:', fillCount);
    return fillCount > 0;
  } catch (e) {
    console.error('Auto-fill error:', e);
    return false;
  }
}
