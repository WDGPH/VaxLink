// Part of VaxLink content-script bundle. Classic script (no ES imports);
// all content files share one global lexical scope, loaded in manifest order.


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

function isPanoramaAgentControl(field) {
  const hint = `${field?.id || ''} ${field?.name || ''}`.toLowerCase();
  // 'agentiterm'       → single-immunization detail page (immsDetailssection_recordImms_agentiterm)
  // 'recordimms_agent' → legacy selector variant
  // 'agentmenu'        → multi-immunization grid page  (historicalfactoryTable:…:immsAgentMenu)
  //                      NOTE: \bagent\b does NOT fire here because 'immsAgentMenu' lowercases to
  //                      'immsagentmenu' where 'agent' has no word boundaries on either side.
  return hint.includes('agentiterm') || hint.includes('recordimms_agent') || hint.includes('agentmenu') || /\bagent\b/.test(hint);
}

function extractBracketAgentCode(optionText) {
  const m = String(optionText || '').match(/^\s*\[([^\]]+)\]/);
  if (!m) return '';
  return normalizeForMatch(m[1]);
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
    idHint.includes('selectbox') ||
    hasExtComboTrigger(field)
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

function isLooseSelectTextMatch(optionTextNorm, desiredNorm) {
  if (!optionTextNorm || !desiredNorm) return false;
  if (optionTextNorm === desiredNorm) return true;

  const optionTokens = optionTextNorm.split(' ').filter(Boolean);
  const desiredTokens = desiredNorm.split(' ').filter(Boolean);

  // Allow short forms (e.g. "IM") only as full tokens, not fuzzy substring matches.
  if (desiredNorm.length <= 2 || optionTextNorm.length <= 2) {
    return optionTokens.includes(desiredNorm) || desiredTokens.includes(optionTextNorm);
  }

  // Prevent downgrading specific values to broader ones (e.g., "mmr var" -> "mmr").
  if (desiredTokens.length > optionTokens.length) {
    const optionIsSubset = optionTokens.every(token => desiredTokens.includes(token));
    if (optionIsSubset) {
      return false;
    }
  }

  // Single-token desired (e.g. "mmr", "hb") must not match a longer product line via substring
  // (pilot: MMR -> MMRV, HB -> combination agents).
  if (desiredTokens.length === 1 && optionTokens.length > 1) {
    return false;
  }

  return optionTextNorm.includes(desiredNorm) || desiredNorm.includes(optionTextNorm);
}

function fillSelectField(field, value) {
  const rawValue = String(value).trim();
  if (!rawValue) return false;
  const candidates = getValueAliases(rawValue, field);
  const options = Array.from(field.options || []).filter(opt => opt && opt.value !== '');
  if (!options.length) return false;
  const agentStrict = isPanoramaAgentControl(field);

  let matched = options.find(opt => opt.value === rawValue || opt.text.trim() === rawValue);
  if (!matched) {
    matched = options.find(opt => candidates.includes(normalizeForMatch(opt.text)));
  }
  if (!matched && agentStrict && candidates.length > 0) {
    matched = options.find((opt) => {
      const bracket = extractBracketAgentCode(opt.text);
      return bracket && candidates.includes(bracket);
    });
  }
  if (!matched && !agentStrict && candidates.length > 0) {
    matched = options.find(opt => {
      const optNorm = normalizeForMatch(opt.text);
      return candidates.some(desired => isLooseSelectTextMatch(optNorm, desired));
    });
  }
  if (!matched) return false;

  field.focus();
  field.value = matched.value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  if (field.id && field.id.endsWith('_input')) {
    const labelId = `${field.id.slice(0, -6)}_label`;
    const label = document.getElementById(labelId);
    if (label) {
      label.textContent = matched.text;
      label.setAttribute('title', matched.text);
    }
  }
  field.blur();
  return true;
}

function fillComboTextField(field, value) {
  const rawValue = String(value).trim();
  if (!rawValue) return false;
  const candidates = getValueAliases(rawValue, field);
  if (!candidates.length) return false;
  const agentStrict = isPanoramaAgentControl(field);

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
    '.x-combo-list-item',
    '.x-boundlist-item',
    '.ui-selectonemenu-item',
    '.select-option',
    '.dropdown-item',
    '.ui-menu-item',
    '.p-dropdown-item'
  ];
  for (const selector of optionSelectors) {
    const options = Array.from(document.querySelectorAll(selector));
    const hit = options.find(opt => {
      const text = opt.textContent || '';
      const optNorm = normalizeForMatch(text);
      if (agentStrict) {
        if (candidates.includes(optNorm)) return true;
        const bracket = extractBracketAgentCode(text);
        return !!(bracket && candidates.includes(bracket));
      }
      return candidates.some(desired => isLooseSelectTextMatch(optNorm, desired));
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

function hasExtComboTrigger(field) {
  if (!field || field.tagName !== 'INPUT') return false;
  const container = field.closest('.x-form-trigger-wrap, .x-form-field-wrap') || field.parentElement;
  if (!container) return false;
  return !!container.querySelector('.x-form-trigger, .x-form-arrow-trigger');
}

function normalizeLabelText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\*/g, ' ')
    .replace(/[:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFillableControl(el) {
  if (!el) return false;
  const isStandardControl = el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA';
  const isRoleCombobox = (el.getAttribute && el.getAttribute('role') === 'combobox');
  if (!isStandardControl && !isRoleCombobox) return false;
  if (el.disabled) return false;
  if (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'hidden') return false;
  return isVisible(el);
}

function scoreControlNearLabel(labelEl, controlEl) {
  const labelRect = labelEl.getBoundingClientRect();
  const controlRect = controlEl.getBoundingClientRect();
  const labelY = labelRect.top + (labelRect.height / 2);
  const controlY = controlRect.top + (controlRect.height / 2);
  const verticalDistance = Math.abs(labelY - controlY);
  const rightOfLabel = controlRect.left >= (labelRect.left - 8);
  const horizontalDistance = rightOfLabel
    ? Math.max(0, controlRect.left - labelRect.right)
    : 500 + Math.abs(controlRect.left - labelRect.left);
  return verticalDistance * 10 + horizontalDistance;
}

function findNearestControlForLabel(labelEl, scope = document) {
  if (!labelEl) return null;
  const controlSelector = 'input, select, textarea, [role="combobox"]';

  if (labelEl.tagName === 'LABEL') {
    const htmlFor = labelEl.getAttribute('for');
    if (htmlFor) {
      const direct = scope.getElementById ? scope.getElementById(htmlFor) : document.getElementById(htmlFor);
      if (isFillableControl(direct)) {
        return direct;
      }
    }
  }

  const candidates = [];
  const seen = new Set();

  const addCandidates = (container) => {
    if (!container || !container.querySelectorAll) return;
    const controls = container.querySelectorAll(controlSelector);
    for (const control of controls) {
      if (seen.has(control) || !isFillableControl(control)) continue;
      seen.add(control);
      candidates.push(control);
    }
  };

  let current = labelEl;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    addCandidates(current.parentElement);
    if (current.parentElement) {
      addCandidates(current.parentElement.nextElementSibling);
    }
    current = current.parentElement;
  }

  if (!candidates.length) {
    addCandidates(scope);
  }
  if (!candidates.length) return null;

  const ranked = candidates
    .map(control => ({ control, score: scoreControlNearLabel(labelEl, control) }))
    .sort((a, b) => a.score - b.score);

  return ranked.length ? ranked[0].control : null;
}

function findFieldByLabelText(labelTexts, options = {}) {
  const labels = Array.isArray(labelTexts) ? labelTexts : [labelTexts];
  const wanted = labels.map(normalizeLabelText).filter(Boolean);
  if (!wanted.length) return null;

  const scope = options.scope && options.scope.querySelectorAll ? options.scope : document;
  const labelSelector = 'label, span, div, td, th, strong';
  const allLabelNodes = Array.from(scope.querySelectorAll(labelSelector));
  const matchingLabels = allLabelNodes.filter((node) => {
    const text = normalizeLabelText(node.textContent || '');
    if (!text) return false;
    return wanted.some(target => text === target || text.startsWith(`${target} `));
  });

  const labelOrder = options.preferLast ? matchingLabels.slice().reverse() : matchingLabels;
  for (const labelEl of labelOrder) {
    const control = findNearestControlForLabel(labelEl, scope);
    if (control) {
      return control;
    }
  }
  return null;
}

function canFillPanoramaControl(field) {
  if (!field || field.disabled) return false;
  if (field.tagName === 'INPUT' && String(field.type || '').toLowerCase() === 'hidden') {
    return false;
  }
  return true;
}

function fillFirstMatchingField(selectors, value) {
  if (value === undefined || value === null || value === '') return false;
  const fields = getFields(selectors).filter(canFillPanoramaControl);
  for (const field of fields) {
    if (fillField(field, value)) {
      return true;
    }
  }
  return false;
}

function getFieldFilledText(field) {
  if (!field) return '';
  if (field.tagName === 'SELECT') {
    const selected = field.options && field.selectedIndex >= 0 ? field.options[field.selectedIndex] : null;
    return String(selected?.text || field.value || '').trim();
  }
  const id = String(field.id || '');
  if (id.endsWith('_focus')) {
    const label = document.getElementById(id.slice(0, -6) + '_label');
    if (label) {
      const labelText = String(label.textContent || '').trim();
      return labelText;
    }
  }
  if (id.endsWith('_input')) {
    const label = document.getElementById(id.slice(0, -6) + '_label');
    if (label && String(label.textContent || '').trim()) {
      return String(label.textContent || '').trim();
    }
  }
  return String(field.value || field.textContent || '').trim();
}

function isShortAgentCandidate(value) {
  const compact = normalizeForMatch(value).replace(/[^a-z0-9]/g, '');
  return compact.length > 0 && compact.length <= 3;
}

function filledAgentTextMatchesCandidate(filledRawValue, candidate) {
  const candidateNorm = normalizeForMatch(candidate);
  if (!candidateNorm) return false;
  const filledRaw = String(filledRawValue || '').trim();
  const filledNorm = normalizeForMatch(filledRaw);
  if (!filledNorm) return false;
  if (filledNorm === candidateNorm) return true;
  // Reject if the filled text is a compound variant of the candidate (e.g. "HB-pediatric" for "HB").
  // normalizeForMatch converts dashes to spaces, so "HB-pediatric" → "hb pediatric", which would
  // otherwise pass the .includes("hb") check below and falsely accept the pediatric agent for adults.
  const candidateRaw = String(candidate || '').trim();
  if (candidateRaw && filledRaw.trim().toLowerCase().startsWith(candidateRaw.toLowerCase() + '-')) return false;
  if (filledNorm.includes(candidateNorm)) return true;

  const candidateTokens = candidateNorm.split(' ').filter(t => t.length >= 3);
  return candidateTokens.length > 0 && candidateTokens.every(t => filledNorm.includes(t));
}

function isAgentTextAccepted(candidate, filledRawValue) {
  const candidateNorm = normalizeForMatch(candidate);
  const filledRaw = String(filledRawValue || '').trim();
  const filledNorm = normalizeForMatch(filledRaw);
  if (filledAgentTextMatchesCandidate(filledRaw, candidate)) return true;

  if (isShortAgentCandidate(candidate)) {
    const token = candidateNorm.replace(/[^a-z0-9]/g, '');
    // Exact compact match: field shows precisely this code (e.g. "HB").
    const filledCompact = filledNorm.replace(/[^a-z0-9]/g, '');
    if (filledCompact === token) return true;
    // Bracket code match: field shows a display name with code in brackets (e.g. "Hepatitis B [HB]").
    // filledTokens.includes(token) is intentionally NOT used here — it would accept "HB-pediatric"
    // (normalized to "hb pediatric") for the adult "HB" candidate since "hb" appears as a token.
    const bracketMatch = filledNorm.match(/\[([^\]]+)\]/);
    return !!(bracketMatch && normalizeForMatch(bracketMatch[1]).replace(/[^a-z0-9]/g, '') === token);
  }

  const candidateTokens = candidateNorm.split(' ').filter(t => t.length >= 3);
  return candidateTokens.length > 0 && candidateTokens.every(t => filledNorm.includes(t));
}

function fieldFilledTextMatchesCandidate(field, candidate) {
  return filledAgentTextMatchesCandidate(getFieldFilledText(field), candidate);
}

function isAgentCandidateAccepted(candidate, field) {
  return isAgentTextAccepted(candidate, getFieldFilledText(field));
}

function fillPanoramaAgentField(selectors, candidate) {
  if (!candidate) return false;
  const fields = getFields(selectors).filter(canFillPanoramaControl);
  for (const field of fields) {
    if (!fillField(field, candidate)) {
      continue;
    }
    if (isAgentCandidateAccepted(candidate, field)) {
      return true;
    }
  }
  return false;
}

function runPanoramaMappings(entries) {
  let fillCount = 0;
  for (const entry of entries) {
    if (!entry || !entry.value || !entry.selectors) continue;
    if (fillFirstMatchingField(entry.selectors, entry.value)) {
      fillCount += 1;
    }
  }
  return fillCount;
}

function parseAdministeredDateTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const mdyHm = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (mdyHm) {
    const month = Number(mdyHm[1]);
    const day = Number(mdyHm[2]);
    const year = Number(mdyHm[3]);
    const hour = Number(mdyHm[4] || 0);
    const minute = Number(mdyHm[5] || 0);
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  return null;
}

function formatPanoramaDateValue(dateValue) {
  const yyyy = dateValue.getFullYear();
  const mm = String(dateValue.getMonth() + 1).padStart(2, '0');
  const dd = String(dateValue.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

function formatPanoramaTimeValue(dateValue) {
  const hh = String(dateValue.getHours()).padStart(2, '0');
  const mm = String(dateValue.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function getPanoramaAdministeredDateTimeValues(data) {
  const sourceValue = data?.administered_at || (adminDateTimeAutofillEnabled ? data?.scanned_at : '');
  const parsed = parseAdministeredDateTime(sourceValue);
  if (!parsed) {
    return { date: '', time: '' };
  }
  return {
    date: formatPanoramaDateValue(parsed),
    time: formatPanoramaTimeValue(parsed)
  };
}

function getPanoramaTradeCandidates(data) {
  const values = [];
  const seen = new Set();
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    const key = normalizeForMatch(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    values.push(raw);
  };
  add(data?.tradename);
  add(data?.name);
  add(data?.generic_name);
  return values;
}

function getPanoramaTradeSelectors() {
  return [
    'select[id*="immsDetailssection_createImms_tradenameinput:selectOneMenu_input"]',
    'input[id*="immsDetailssection_createImms_tradenameinput:selectOneMenu_focus"]',
    'select[id*="createImms_tradenameinput:selectOneMenu_input"]',
    'input[id*="createImms_tradenameinput:selectOneMenu_focus"]'
  ];
}

function hasPanoramaTradeSelection(data) {
  const candidates = getPanoramaTradeCandidates(data);
  if (!candidates.length) return false;
  const fields = getFields(getPanoramaTradeSelectors()).filter(canFillPanoramaControl);
  if (!fields.length) return false;
  return fields.some((field) => (
    candidates.some((candidate) => fieldFilledTextMatchesCandidate(field, candidate))
  ));
}

function fillPanoramaTradeName(data) {
  const candidates = getPanoramaTradeCandidates(data);
  if (!candidates.length) return false;
  const selectors = getPanoramaTradeSelectors();
  for (const candidate of candidates) {
    if (fillFirstMatchingField(selectors, candidate)) {
      return true;
    }
  }
  return false;
}

function getPanoramaAgentSelectors() {
  return [
    'select[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_input"]',
    'input[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_focus"]'
  ];
}

function getPanoramaCurrentAgentSelectionText() {
  const fields = getFields(getPanoramaAgentSelectors()).filter(canFillPanoramaControl);
  for (const field of fields) {
    const raw = String(getFieldFilledText(field) || '').trim();
    const norm = normalizeForMatch(raw);
    if (norm && norm !== 'select' && norm !== '--') {
      return raw;
    }
  }
  return '';
}

function hasPanoramaAgentSelection(data) {
  const fields = getFields(getPanoramaAgentSelectors()).filter(canFillPanoramaControl);
  if (!fields.length) return false;

  const candidates = getPanoramaAgentCandidates(data);
  if (!candidates.length) {
    return fields.some((field) => normalizeForMatch(getFieldFilledText(field)).length > 0);
  }

  return fields.some((field) => candidates.some((candidate) => isAgentCandidateAccepted(candidate, field)));
}

function queueRecordMatchesPanoramaAgentText(record, agentText) {
  const payload = buildAutofillPayloadFromQueueRecord(record);
  if (!payload) return false;
  const candidates = getPanoramaAgentCandidates(payload);
  return candidates.some((candidate) => isAgentTextAccepted(candidate, agentText));
}

function findMatchingQueueRecordIndexForPanoramaAgent(rows, agentText) {
  const raw = String(agentText || '').trim();
  if (!raw || !Array.isArray(rows) || !rows.length) return -1;
  return rows.findIndex((row) => queueRecordMatchesPanoramaAgentText(row, raw));
}

function tryFillPanoramaAgent(data) {
  const candidates = getPanoramaAgentCandidates(data);
  if (!candidates.length) return false;
  const selectors = getPanoramaAgentSelectors();
  for (const candidate of candidates) {
    if (fillPanoramaAgentField(selectors, candidate)) {
      return true;
    }
  }
  return false;
}

function hasPanoramaDeferredDetailData(data) {
  const administered = getPanoramaAdministeredDateTimeValues(data);
  return !!(administered.date || administered.time);
}

function getPanoramaAdministeredDateTimeFields() {
  return {
    dateField: getFields([
      'input[id*="immsDetailssection_dateAdministedDate:dateInput_input"]',
      'input[id*="dateAdministedDate:dateInput_input"]'
    ]).find(field => canFillPanoramaControl(field) && isVisible(field)),
    timeField: getFields([
      'input[id*="immsDetailssection_dateAdministedDate:timeInput:timeInput"]',
      'input[id*="dateAdministedDate:timeInput:timeInput"]'
    ]).find(field => canFillPanoramaControl(field) && isVisible(field))
  };
}

function hasPanoramaDeferredDetailFieldsFilled(data) {
  const administered = getPanoramaAdministeredDateTimeValues(data);
  if (!administered.date && !administered.time) return true;

  const { dateField, timeField } = getPanoramaAdministeredDateTimeFields();
  const dateMatches = !administered.date || String(dateField?.value || '').trim() === administered.date;
  const timeMatches = !administered.time || String(timeField?.value || '').trim() === administered.time;
  return dateMatches && timeMatches;
}

function fillPanoramaMaskedTextInput(field, nextValue) {
  if (!field || !nextValue) return false;
  const value = String(nextValue).trim();
  if (!value) return false;
  field.focus();
  field.value = '';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || '0', bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.blur();
  return String(field.value || '').trim() === value;
}

function fillPanoramaAdministeredDateTimeFields(data) {
  const administered = getPanoramaAdministeredDateTimeValues(data);
  if (!administered.date && !administered.time) return 0;

  const { dateField, timeField } = getPanoramaAdministeredDateTimeFields();

  let fillCount = 0;
  if (administered.date && fillPanoramaMaskedTextInput(dateField, administered.date)) {
    fillCount += 1;
  }
  if (administered.time && fillPanoramaMaskedTextInput(timeField, administered.time)) {
    fillCount += 1;
  }
  return fillCount;
}

function isPrimeFacesAjaxBusy() {
  try {
    const queue = globalThis.PrimeFaces && globalThis.PrimeFaces.ajax && globalThis.PrimeFaces.ajax.Queue;
    if (!queue) return false;
    if (typeof queue.isEmpty === 'function') {
      return !queue.isEmpty();
    }
    if (Array.isArray(queue.requests)) {
      return queue.requests.length > 0;
    }
  } catch (_) {
    return false;
  }
  return false;
}

function buildPanoramaDeferredDetailMappings(data) {
  void data;
  return [];
}

function fillPanoramaDeferredDetailFields(data) {
  if (!data) return 0;
  return fillPanoramaAdministeredDateTimeFields(data);
}

function normalizePanoramaLotToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// Inventory confirmed these product families can legitimately carry the same
// lot in both Panorama funding buckets. For them, falling back to SHOW_ALL can
// silently select the wrong funding row, so VaxLink must keep funding explicit.
const PANORAMA_SHARED_FUNDING_LOT_PRODUCTS = Object.freeze([
  { label: 'Arexvy', terms: ['arexvy'] },
  { label: 'Bexsero', terms: ['bexsero'] },
  { label: 'Engerix B', terms: ['engerix b'] },
  { label: 'Gardasil 9', terms: ['gardasil 9'] },
  { label: 'Havrix', terms: ['havrix 1440', 'havrix 720', 'havrix'] },
  { label: 'Avaxim', terms: ['avaxim'] },
  { label: 'Nimenrix', terms: ['nimenrix'] },
  { label: 'RabAvert', terms: ['rabavert'] },
  { label: 'Imovax Rabies', terms: ['imovax rabies'] },
  { label: 'Shingrix', terms: ['shingrix'] },
  { label: 'Tubersol', terms: ['tubersol'] }
]);

function buildPanoramaFundingSourceText(data) {
  return normalizeForMatch([
    data?.name,
    data?.tradename,
    data?.generic_name
  ].filter(Boolean).join(' '));
}

function getPanoramaSharedFundingLotProductLabel(data) {
  const source = buildPanoramaFundingSourceText(data);
  if (!source) return '';
  for (const product of PANORAMA_SHARED_FUNDING_LOT_PRODUCTS) {
    if ((product.terms || []).some((term) => source.includes(normalizeForMatch(term)))) {
      return product.label;
    }
  }
  return '';
}

function hasPanoramaFundedRadio() {
  return !!document.querySelector('input[id*="fundedRadio:selectOneRadio"]');
}

function getPanoramaFundedRadioValue() {
  const checked = Array.from(document.querySelectorAll('input[id*="fundedRadio:selectOneRadio"]'))
    .find((radio) => radio && radio.checked);
  return String(checked?.value || '').trim();
}

function isExplicitPanoramaFundingValue(value) {
  return value === 'PUBLICLY_FUNDED' || value === 'NON_PUBLICLY_FUNDED';
}

function getPanoramaFundingLabel(value) {
  if (value === 'PUBLICLY_FUNDED') return 'Publicly Funded';
  if (value === 'NON_PUBLICLY_FUNDED') return 'Non-Publicly Funded';
  if (value === 'SHOW_ALL') return 'Show All';
  return 'funding filter';
}

function optionTextMatchesLotExactly(optionText, lotValue) {
  const lotToken = normalizePanoramaLotToken(lotValue);
  if (!lotToken) return false;
  const rawText = String(optionText || '');
  // Panorama options look like "LOT123 - Exp. 2026-01-31"; the lot is the
  // left-of-dash token. Exact equality avoids "ABC1" selecting "ABC12".
  const leftPart = rawText.split('-')[0] || rawText;
  return normalizePanoramaLotToken(leftPart) === lotToken;
}

function optionTextContainsLot(optionText, lotValue) {
  const lotToken = normalizePanoramaLotToken(lotValue);
  if (!lotToken) return false;
  const rawText = String(optionText || '');
  const fullToken = normalizePanoramaLotToken(rawText);
  if (fullToken.includes(lotToken)) return true;
  const leftPart = rawText.split('-')[0] || rawText;
  const leftToken = normalizePanoramaLotToken(leftPart);
  return leftToken === lotToken || leftToken.includes(lotToken);
}

// Prefer an exact lot match across all candidates before falling back to a
// substring match, so a scanned lot that prefixes a longer lot in the
// dropdown never selects the wrong one.
function findBestLotMatch(candidates, getText, lotValue) {
  return candidates.find(c => optionTextMatchesLotExactly(getText(c), lotValue))
    || candidates.find(c => optionTextContainsLot(getText(c), lotValue))
    || null;
}

function fillPanoramaLotFromSelect(lotValue) {
  const selectors = [
    'select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="LotInfo:lotNumberSelect:selectOneMenu_input"]'
  ];
  const fields = getFields(selectors).filter(canFillPanoramaControl);
  for (const field of fields) {
    const options = Array.from(field.options || []).filter(opt => opt && opt.value !== '');
    const matched = findBestLotMatch(options, opt => opt.text, lotValue);
    if (!matched) continue;

    field.focus();
    field.value = matched.value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();

    if (field.id && field.id.endsWith('_input')) {
      const labelId = `${field.id.slice(0, -6)}_label`;
      const label = document.getElementById(labelId);
      if (label) {
        label.textContent = matched.text;
      }
    }
    return true;
  }
  return false;
}

function setPanoramaFundedRadioValue(value) {
  const desired = String(value || '').trim();
  const radio = document.querySelector(`input[id*="fundedRadio:selectOneRadio"][value="${desired}"]`);
  if (!radio) return 'not_found';
  if (radio.checked) return 'already';
  const box = radio.closest('.ui-radiobutton')?.querySelector('.ui-radiobutton-box');
  if (box) box.click();
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  vlog('VaxLink: funded radio set to', desired);
  return 'clicked';
}

function resetPanoramaFundedRadioToShowAll() {
  return setPanoramaFundedRadioValue('SHOW_ALL');
}

function openPanoramaLotDropdown() {
  const selectors = [
    '[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu"] .ui-selectonemenu-trigger',
    '[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu"] .ui-selectonemenu-trigger',
    '[id*="LotInfo:lotNumberSelect:selectOneMenu"] .ui-selectonemenu-trigger'
  ];
  const triggers = getFields(selectors).filter(isVisible);
  for (const trigger of triggers) {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    trigger.click();
    return true;
  }
  return false;
}

function fillPanoramaLotFromPanelItems(lotValue) {
  const filterSelectors = [
    'input[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_filter"]',
    'input[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_filter"]',
    'input[id*="LotInfo:lotNumberSelect:selectOneMenu_filter"]'
  ];
  const lotText = String(lotValue || '');
  const lotToken = normalizePanoramaLotToken(lotText);
  const filters = getFields(filterSelectors).filter(canFillPanoramaControl);
  for (const filterInput of filters) {
    filterInput.focus();
    filterInput.value = lotText;
    filterInput.dispatchEvent(new Event('input', { bubbles: true }));
    filterInput.dispatchEvent(new KeyboardEvent('keyup', { key: lotText.slice(-1) || 'a', bubbles: true }));
    filterInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const itemSelectors = [
    'li[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_"]',
    'li[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_"]',
    'li[id*="LotInfo:lotNumberSelect:selectOneMenu_"]',
    '.ui-selectonemenu-panel .ui-selectonemenu-item'
  ];
  for (const selector of itemSelectors) {
    const items = Array.from(document.querySelectorAll(selector))
      .filter((item) => {
        if (!item) return false;
        if (item.classList && item.classList.contains('ui-helper-hidden')) return false;
        const text = String(
          item.getAttribute?.('data-label')
          || item.getAttribute?.('title')
          || item.textContent
          || ''
        ).trim();
        return isVisible(item) && text.length > 0;
      });
    const getItemText = (item) => String(
      item.getAttribute?.('data-label')
      || item.getAttribute?.('title')
      || item.textContent
      || ''
    );
    const matched = findBestLotMatch(items, getItemText, lotValue);
    if (!matched) continue;
    matched.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    matched.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    matched.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    matched.click();
    const selectedLotLabels = getFields([
      'label[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_label"]',
      'label[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_label"]',
      'label[id*="LotInfo:lotNumberSelect:selectOneMenu_label"]'
    ]);
    const confirmed = selectedLotLabels.some((label) => (
      normalizePanoramaLotToken(label?.textContent || '').includes(lotToken)
    ));
    if (confirmed) {
      return true;
    }
    return true;
  }
  return false;
}

function tryFillPanoramaLot(lotValue) {
  if (!lotValue) return false;
  if (fillPanoramaLotFromSelect(lotValue)) return true;
  openPanoramaLotDropdown();
  if (fillPanoramaLotFromPanelItems(lotValue)) return true;
  return false;
}

function tryFillPanoramaLotOrTrade(data) {
  if (!data) return false;
  if (data.lot) return tryFillPanoramaLot(data.lot);
  return fillPanoramaTradeName(data);
}

function hasPanoramaLotSelection(lotValue) {
  if (!lotValue) return false;

  const selectFields = getFields([
    'select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="LotInfo:lotNumberSelect:selectOneMenu_input"]'
  ]).filter(canFillPanoramaControl);
  if (selectFields.some((field) => optionTextContainsLot(getFieldFilledText(field), lotValue))) {
    return true;
  }

  const selectedLotLabels = getFields([
    'label[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_label"]',
    'label[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_label"]',
    'label[id*="LotInfo:lotNumberSelect:selectOneMenu_label"]'
  ]);
  return selectedLotLabels.some((label) => optionTextContainsLot(label?.textContent || '', lotValue));
}

function hasPanoramaLotOrTradeSelection(data) {
  if (!data) return false;
  if (data.lot) {
    return hasPanoramaLotSelection(data.lot);
  }
  return hasPanoramaTradeSelection(data);
}

let stopPanoramaLotTradeWatcher = null;

// Issue #26: a real user interaction with the agent/lot/tradename widgets means
// the nurse is taking over — pending VaxLink fill retries must not overwrite
// her choice. PrimeFaces re-dispatches synthetic events (isTrusted === false),
// and so do VaxLink's own fills, so only trusted events count as manual.
const PANORAMA_AGENT_LOT_WIDGET_ID_PATTERN = /agentiterm|tradenameinput|lotnumberselect/i;

function isPanoramaAgentLotWidgetNode(node) {
  if (!node || typeof node.closest !== 'function') return false;
  const widget = node.closest('.ui-selectonemenu, .ui-selectonemenu-panel, select');
  if (!widget) return false;
  return PANORAMA_AGENT_LOT_WIDGET_ID_PATTERN.test(String(widget.id || ''));
}

function cancelPanoramaFillRetriesForManualEdit(event) {
  if (!event.isTrusted) return;
  if (typeof stopPanoramaLotTradeWatcher !== 'function') return;
  if (!isPanoramaAgentLotWidgetNode(event.target)) return;
  stopPanoramaLotTradeWatcher();
  stopPanoramaLotTradeWatcher = null;
  vlog('manual agent/lot interaction — cancelled pending VaxLink fill retries');
}

function schedulePanoramaLotOrTradeSelection(data, initialDelayMs = 0, options = {}) {
  if (!data) return;
  if (typeof stopPanoramaLotTradeWatcher === 'function') {
    stopPanoramaLotTradeWatcher();
    stopPanoramaLotTradeWatcher = null;
  }

  const hasLot = !!String(data?.lot || '').trim();
  const hasTrade = getPanoramaTradeCandidates(data).length > 0;
  const hasAgent = getPanoramaAgentCandidates(data).length > 0;
  const shouldTryLotOrTrade = hasLot || hasTrade;
  const shouldFillDeferredFields = hasPanoramaDeferredDetailData(data);
  if (!shouldTryLotOrTrade && !shouldFillDeferredFields && !hasAgent) {
    return;
  }

  const maxDurationMs = 16000;
  const attemptDelaysMs = [0, 120, 260, 450, 800, 1300, 1900, 2800, 4100, 5600, 8000, 11000, 14000];
  const minAttemptGapMs = 110;
  let observer = null;
  const timers = [];
  let stopped = false;
  let lastAttemptAt = 0;
  let stablePasses = 0;
  let fundedRadioEnsured = !!options.fundedRadioEnsured;
  const preserveFundingFilter = options.preserveFundingFilter === true;
  let sharedFundingMisses = 0;
  let finalizeOnResolved = options.finalizeOnResolved === true;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    while (timers.length > 0) {
      const timer = timers.pop();
      clearTimeout(timer);
    }
    if (stopPanoramaLotTradeWatcher === stop) {
      stopPanoramaLotTradeWatcher = null;
    }
  };
  stopPanoramaLotTradeWatcher = stop;

  const runAttempt = () => {
    if (stopped) return;
    const now = Date.now();
    if ((now - lastAttemptAt) < minAttemptGapMs) return;
    lastAttemptAt = now;
    const busy = isPrimeFacesAjaxBusy();

    let hasResolvedAgent = !hasAgent || hasPanoramaAgentSelection(data);
    if (!hasResolvedAgent && !busy) {
      hasResolvedAgent = tryFillPanoramaAgent(data) || hasPanoramaAgentSelection(data);
    }

    let resolved = !shouldTryLotOrTrade;
    if (!resolved && hasResolvedAgent) {
      resolved = hasPanoramaLotOrTradeSelection(data);
    }
    if (!resolved && hasResolvedAgent && !busy) {
      if (preserveFundingFilter && hasLot && hasPanoramaFundedRadio()) {
        const fundedValue = getPanoramaFundedRadioValue();
        if (!isExplicitPanoramaFundingValue(fundedValue)) {
          showVaxlinkToast({
            ...data,
            _sharedFundingLotFilterRequired: true,
            _sharedFundingLotLabel: getPanoramaSharedFundingLotProductLabel(data),
            _fundedRadioValue: fundedValue
          }, 12000);
          stop();
          return;
        }
      }

      // Try lot fill with the current radio state first — avoids triggering a
      // funded-radio AJAX that can reset the agent and create a re-fill cascade.
      resolved = tryFillPanoramaLotOrTrade(data) || hasPanoramaLotOrTradeSelection(data);
      if (!resolved && preserveFundingFilter && hasLot && hasPanoramaFundedRadio()) {
        sharedFundingMisses += 1;
        if (sharedFundingMisses >= 3) {
          showVaxlinkToast({
            ...data,
            _sharedFundingLotSwitchFilter: true,
            _sharedFundingLotLabel: getPanoramaSharedFundingLotProductLabel(data),
            _fundedRadioValue: getPanoramaFundedRadioValue()
          }, 12000);
          stop();
          return;
        }
      } else if (resolved) {
        sharedFundingMisses = 0;
      }
      if (!resolved && !fundedRadioEnsured && !preserveFundingFilter) {
        fundedRadioEnsured = true;
        const radioResult = resetPanoramaFundedRadioToShowAll();
        if (radioResult === 'clicked') return; // wait for AJAX to refresh lot panel
        // Radio was already at SHOW_ALL or not found — retry immediately
        resolved = tryFillPanoramaLotOrTrade(data) || hasPanoramaLotOrTradeSelection(data);
      }
    }

    if (!resolved && hasLot && hasResolvedAgent && !busy) {
      if (!hasPanoramaLotSelection(data?.lot)) {
        openPanoramaLotDropdown();
      }
      resolved = fillPanoramaLotFromPanelItems(data?.lot) || hasPanoramaLotSelection(data?.lot) || resolved;
    }

    let deferredResolved = !shouldFillDeferredFields || hasPanoramaDeferredDetailFieldsFilled(data);
    if (!deferredResolved && !busy) {
      fillPanoramaDeferredDetailFields(data);
      deferredResolved = hasPanoramaDeferredDetailFieldsFilled(data);
    }

    // Require a stable follow-up pass before stopping so we do not exit while
    // PrimeFaces is still applying dependent field refreshes.
    if (!busy && resolved && deferredResolved) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
    }

    if (stablePasses >= 2) {
      if (finalizeOnResolved) {
        finalizeOnResolved = false;
        void finalizeDeferredPanoramaAutofill(data);
      }
      stop();
    }
  };

  const start = () => {
    if (stopped) return;
    for (const delayMs of attemptDelaysMs) {
      timers.push(setTimeout(runAttempt, delayMs));
    }
    timers.push(setTimeout(stop, maxDurationMs));
    timers.push(setInterval(runAttempt, 500));

    if (typeof MutationObserver === 'function' && document.body) {
      observer = new MutationObserver(() => {
        runAttempt();
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-expanded']
      });
    }
  };

  timers.push(setTimeout(start, Math.max(0, Number(initialDelayMs) || 0)));
}

function isPanoramaRecordImmsPage() {
  try {
    const host = String(window.location.hostname || '').toLowerCase();
    const isPanorama =
      host === 'www.panorama.prod.ehealthontario.ca' ||
      host === 'panorama.prod.ehealthontario.ca';
    if (!isPanorama) return false;
    return window.location.pathname.toLowerCase().includes('/recordimms/');
  } catch {
    return false;
  }
}

function isPanoramaImmunizationPage() {
  const markerSelectors = [
    'select[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_input"]',
    'select[id*="immsDetailssection_createImms_tradenameinput:selectOneMenu_input"]',
    'select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'input[id*="addimmsdetails_vaccDetailssection1_decimal:inputText"]',
    'select[id*="addimmsdetails_vaccDetailssection1createImms_dosageuomsel1:iTermSelectOneMenu_input"]',
    'select[id*="addimmsdetails_vaccDetailssection1createImms_routeSelOne:iTermSelectOneMenu_input"]',
    'input[id*="addimmsdetails_vaccDetailssection1_createImms_manufacturerinput:inputText"]'
  ];
  if (markerSelectors.some(selector => document.querySelector(selector))) {
    return true;
  }

  const hasTitle = Array.from(document.querySelectorAll('h1, h2, h3, legend, div, span, td, th, strong'))
    .some(el => normalizeLabelText(el.textContent || '') === 'immunizations');
  if (!hasTitle) return false;

  const hasDateAdminLabel = Array.from(document.querySelectorAll('label, span, div, td, th, strong'))
    .some(el => normalizeLabelText(el.textContent || '') === 'date administered');
  return hasDateAdminLabel;
}

function fillPanoramaImmunizationFields(data) {
  const sharedFundingProductLabel = getPanoramaSharedFundingLotProductLabel(data);
  const preserveFundingFilter = !!(sharedFundingProductLabel && String(data?.lot || '').trim());
  const fundedValue = getPanoramaFundedRadioValue();
  if (preserveFundingFilter && hasPanoramaFundedRadio() && !isExplicitPanoramaFundingValue(fundedValue)) {
    showVaxlinkToast({
      ...data,
      _sharedFundingLotFilterRequired: true,
      _sharedFundingLotLabel: sharedFundingProductLabel,
      _fundedRadioValue: fundedValue
    }, 12000);
    return createAutofillResult('pending', { reason: 'funding_choice_required' });
  }

  // Switch to SHOW_ALL early, before the agent/lot AJAX settles, so the radio's
  // own AJAX cascade doesn't land mid-fill and reset the agent (issue: lot and
  // expiry not selected after selecting the agent). The scheduler below only
  // falls back to resetting it again if this attempt found no radio at all.
  const radioResult = preserveFundingFilter ? 'preserved' : resetPanoramaFundedRadioToShowAll();

  let agentCount = 0;
  if (hasPanoramaAgentSelection(data) || tryFillPanoramaAgent(data)) {
    agentCount = 1;
  }

  let fillCount = agentCount;
  const lotCount = (data.lot && !isPrimeFacesAjaxBusy()) ? (tryFillPanoramaLot(data.lot) ? 1 : 0) : 0;
  fillCount += lotCount;
  fillCount += fillPanoramaDeferredDetailFields(data);

  // Panorama refreshes lot options and dependent controls asynchronously after selection.
  const finalizeOnResolved = preserveFundingFilter && !!data?.lot && !hasPanoramaLotSelection(data.lot);
  if (agentCount > 0 || data.lot || hasPanoramaDeferredDetailData(data) || getPanoramaTradeCandidates(data).length > 0) {
    schedulePanoramaLotOrTradeSelection(data, agentCount > 0 ? 1200 : 350, {
      fundedRadioEnsured: !preserveFundingFilter && radioResult !== 'not_found',
      preserveFundingFilter,
      finalizeOnResolved
    });
  }

  if (preserveFundingFilter && data?.lot) {
    if (hasPanoramaLotSelection(data.lot)) {
      return createAutofillResult('success', { fillCount });
    }
    return createAutofillResult('pending', {
      reason: 'waiting_for_lot_resolution',
      fillCount
    });
  }

  if (fillCount > 0) {
    return createAutofillResult('success', { fillCount });
  }

  // If agent did not fill, still attempt lot/trade directly.
  if (tryFillPanoramaLotOrTrade(data)) {
    fillCount += 1;
  }
  if (fillCount > 0) {
    return createAutofillResult('success', { fillCount });
  }

  const fallbackMapping = [
    {
      value: getPanoramaAgentCandidates(data)[0] || (data.name || data.generic_name || data.tradename || data.din),
      labels: ['Agent'],
      preferLast: false
    }
  ];

  let fallbackCount = 0;
  const usedFields = new Set();
  for (const entry of fallbackMapping) {
    if (!entry.value) continue;
    const field = findFieldByLabelText(entry.labels, { preferLast: entry.preferLast });
    if (!field || usedFields.has(field)) continue;
    if (!fillField(field, entry.value)) {
      continue;
    }
    if (entry.labels && entry.labels.includes('Agent') && !isAgentCandidateAccepted(entry.value, field)) {
      continue;
    }
    {
      usedFields.add(field);
      fallbackCount += 1;
    }
  }
  return createAutofillResult(fallbackCount > 0 ? 'success' : 'failed', { fillCount: fallbackCount });
}

const PANORAMA_AGENT_RULES = Array.isArray(globalThis.VAXLINK_PANORAMA_AGENT_RULES)
  ? globalThis.VAXLINK_PANORAMA_AGENT_RULES
  : [];

function buildPanoramaAgentSourceText(data) {
  return normalizeForMatch([
    data?.name,
    data?.generic_name,
    data?.tradename,
    data?.disease,
    data?.antigen,
    data?.manufacturer,
    data?.route,
    data?.strength
  ].filter(Boolean).join(' '));
}

function getNormalizedSourceTokens(sourceText) {
  return String(sourceText || '')
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term) {
  const normalizedTerm = normalizeForMatch(term);
  if (!normalizedTerm) return false;

  const termTokens = normalizedTerm.split(' ').filter(Boolean);
  if (!termTokens.length) return false;

  if (termTokens.length === 1) {
    const token = termTokens[0];
    // Keep short rule terms strict (e.g., "tig", "hb", "mmr") so they do not
    // match inside longer words like "antigen".
    if (token.length <= 3) {
      return sourceTokens.includes(token);
    }
    return sourceTokens.includes(token) || sourceText.includes(token);
  }

  if (sourceText.includes(normalizedTerm)) {
    return true;
  }

  return termTokens.every((token) => (
    token.length <= 3
      ? sourceTokens.includes(token)
      : (sourceTokens.includes(token) || sourceText.includes(token))
  ));
}

function panoramaSourceHasAll(sourceText, sourceTokens, terms) {
  return terms.every(term => panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term));
}

function panoramaSourceHasAny(sourceText, sourceTokens, terms) {
  return terms.some(term => panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term));
}

function panoramaAgentRuleClauseMatches(sourceText, clause) {
  const sourceTokens = getNormalizedSourceTokens(sourceText);
  if (clause.any && !panoramaSourceHasAny(sourceText, sourceTokens, clause.any)) return false;
  if (clause.all && !panoramaSourceHasAll(sourceText, sourceTokens, clause.all)) return false;
  if (clause.notAny && panoramaSourceHasAny(sourceText, sourceTokens, clause.notAny)) return false;
  if (clause.notAll && panoramaSourceHasAll(sourceText, sourceTokens, clause.notAll)) return false;
  return true;
}

function panoramaAgentRuleMatches(sourceText, rule) {
  return (rule.clauses || []).some(clause => panoramaAgentRuleClauseMatches(sourceText, clause));
}

function getPanoramaAgentCandidates(data) {
  const values = [];
  const seen = new Set();
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    const key = normalizeForMatch(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    values.push(raw);
  };

  add(data?.tradename);
  add(data?.generic_name);
  add(data?.name);

  const sourceText = buildPanoramaAgentSourceText(data);
  for (const rule of PANORAMA_AGENT_RULES) {
    if (!panoramaAgentRuleMatches(sourceText, rule)) continue;
    for (const output of rule.outputs || []) {
      add(output);
    }
  }

  add(data?.din);
  return values;
}

function getDoseUnitFieldByLayout() {
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

  function doseUnitFromCaptionNodes(nodes) {
    for (const label of nodes) {
      const text = normalizeForMatch(label.textContent || '');
      if (!(text === 'dose' || text.startsWith('dose '))) continue;

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

  // Labels first (cheap). Table layouts second — still tiny vs all span/div on SPAs.
  return (
    doseUnitFromCaptionNodes(document.querySelectorAll('label')) ||
    doseUnitFromCaptionNodes(document.querySelectorAll('th, td'))
  );
}

function buildAutofillPayloadFromQueueRecord(record) {
  if (!record) return null;
  const payload = {
    scanned_at: record.scanned_at || '',
    gtin: record.gtin || '',
    lot: record.lot || '',
    serial: record.serial || '',
    expiry: record.barcode_expiry || record.inventory_expiry || '',
    inventory_expiry: record.inventory_expiry || record.barcode_expiry || '',
    nvc_lot_expiry: record.nvc_lot_expiry || '',
    expiry_flag: record.expiry_flag || '',
    expiry_days_remaining: record.expiry_days_remaining ?? '',
    expiry_source: record.expiry_source || (record.barcode_expiry ? 'barcode' : 'none'),
    tradename: record.tradename || '',
    generic_name: record.generic_name || '',
    disease: record.disease || '',
    antigen: record.antigen || '',
    manufacturer: record.manufacturer || '',
    route: record.route || '',
    strength: record.strength || '',
    dose_value: record.dose_value || '',
    dose_unit: record.dose_unit || '',
    din: record.din || '',
    drug_code: record.drug_code || record.din || '',
    lookup_error: record.lookup_error || '',
    name: record.name || record.generic_name || record.tradename || record.din || ''
  };
  if (adminDateTimeAutofillEnabled) {
    payload.administered_at = record.scanned_at || new Date().toISOString();
  }
  return payload;
}

function createAutofillResult(status, extra = {}) {
  return { status, ...extra };
}

function isAutofillSuccess(result) {
  return !!result && result.status === 'success';
}

function isAutofillPending(result) {
  return !!result && result.status === 'pending';
}

async function consumeQueueRecordAfterDeferredAutofill(queueContext) {
  const storageKey = String(queueContext?.storageKey || '').trim();
  const recordId = String(queueContext?.recordId || '').trim();
  if (!storageKey || !recordId) {
    return null;
  }

  const stored = await getLocalStorage([storageKey]);
  const rows = (stored && Array.isArray(stored[storageKey])) ? stored[storageKey] : [];
  const recordIndex = rows.findIndex((row) => row && String(row.id || '') === recordId);
  if (recordIndex < 0) {
    return null;
  }

  const record = rows[recordIndex];
  const nextRows = buildQueueRowsAfterRecordUse(rows, record, recordIndex);
  await setLocalStorage({ [storageKey]: nextRows });

  const workflow = queueContext.workflow || 'multiple';
  const source = queueContext.source || 'queue';
  const expiryFlag = record.expiry_flag || getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag;
  logAnalyticsEvent('queue_used', {
    workflow,
    queue: queueContext.queue || workflow,
    source,
    count: 1,
    queueSizeAfter: nextRows.length,
    vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
    manufacturer: record.manufacturer || '',
    expiryFlag
  });
  logAnalyticsEvent('autofill_result', {
    workflow,
    source,
    success: true,
    deferred: true,
    vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
    manufacturer: record.manufacturer || '',
    expiryFlag
  });

  return { record, queueSizeAfter: nextRows.length };
}

async function finalizeDeferredPanoramaAutofill(data) {
  if (!data || data._vaxlinkDeferredFinalized) {
    return;
  }
  data._vaxlinkDeferredFinalized = true;

  try {
    await consumeQueueRecordAfterDeferredAutofill(data._vaxlinkQueueContext);
  } catch (error) {
    console.warn('VaxLink deferred queue finalize failed:', error);
  }

  showVaxlinkToast(data);
}

