// Part of VaxLink content-script bundle. Classic script (no ES imports);
// all content files share one global lexical scope, loaded in manifest order.

let applyQueueInFlight = false;

async function applyNextQueueItem(options = {}) {
  if (applyQueueInFlight) return;
  applyQueueInFlight = true;
  if (hudApplyBtn) hudApplyBtn.disabled = true;
  try {
    const matchCurrentAgent = options.matchCurrentAgent === true;
    const suppressQueueEmptyToast = options.suppressQueueEmptyToast === true;
    const stored = await getLocalStorage([MULTIPLE_INJECT_QUEUE_KEY]);
    const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
      ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
    if (!rows.length) {
      if (!suppressQueueEmptyToast) {
        showVaxlinkToast({ _queueEmpty: true });
      }
      updateHudState();
      return 'queue_empty';
    }

    const currentAgentText = getPanoramaCurrentAgentSelectionText();
    const shouldRespectPanoramaAgent = !!currentAgentText && isPanoramaImmunizationPage();

    let recordIndex = 0;
    if (matchCurrentAgent || shouldRespectPanoramaAgent) {
      recordIndex = findMatchingQueueRecordIndexForPanoramaAgent(rows, currentAgentText);
      if (recordIndex < 0) {
        vlog('auto-fill skipped: no queued vaccine matches current Panorama agent', currentAgentText);
        showVaxlinkToast({ _stepMatchMissing: true });
        updateHudState();
        return 'no_match';
      }
    }

    const record = rows[recordIndex];
    const data = buildAutofillPayloadFromQueueRecord(record);
    if (!data) return 'no_data';
    data._vaxlinkQueueContext = {
      storageKey: MULTIPLE_INJECT_QUEUE_KEY,
      recordId: record.id,
      workflow: 'multiple',
      queue: 'multiple',
      source: 'hud'
    };

    const nextRows = buildQueueRowsAfterRecordUse(rows, record, recordIndex);

    logAnalyticsEvent('autofill_attempt', {
      workflow: 'multiple',
      source: 'hud',
      vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
      manufacturer: record.manufacturer || '',
      expiryFlag: record.expiry_flag || ''
    });

    const autofillResult = autoFillTelus(data);
    const success = isAutofillSuccess(autofillResult);
    const pending = isAutofillPending(autofillResult);
    if (success) {
      await setLocalStorage({ [MULTIPLE_INJECT_QUEUE_KEY]: nextRows });
    }
    logAnalyticsEvent('autofill_result', {
      workflow: 'multiple',
      source: 'hud',
      success,
      pending,
      vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
      manufacturer: record.manufacturer || '',
      expiryFlag: record.expiry_flag || ''
    });
    if (success) {
      logAnalyticsEvent('queue_used', {
        workflow: 'multiple',
        queue: 'multiple',
        source: 'hud',
        count: 1,
        queueSizeAfter: nextRows.length
      });
    }

    if (success) {
      showVaxlinkToast(data);
      updateHudState();
      return 'success';
    }
    if (pending) {
      updateHudState();
      return 'pending';
    }
    updateHudState();
    return 'fill_failed';
  } catch (error) {
    console.warn('VaxLink HUD apply error:', error);
    if (hudApplyBtn) hudApplyBtn.disabled = false;
    return 'error';
  } finally {
    applyQueueInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Auto-drain: auto-apply queue head when an empty immunization form is detected
// ---------------------------------------------------------------------------

function isImmunizationFormEmpty() {
  const agentSelectors = getPanoramaAgentSelectors();
  const fields = getFields(agentSelectors).filter(canFillPanoramaControl);
  for (const field of fields) {
    const filled = getFieldFilledText(field);
    if (filled && filled !== '--' && filled.toLowerCase() !== 'select' && filled.length > 1) {
      return false;
    }
  }
  return true;
}

async function tryAutoDrain() {
  if (activeWorkflowMode !== 'multiple') return;
  if (!isPanoramaImmunizationPage()) return;
  // Never pop queue items while the multi-immunization grid page is active.
  // That page uses maybeAutoFillPanoramaMultipleGrid to read queue items by
  // index WITHOUT consuming them.  Popping here shifts all entries down by one,
  // so the next grid repaint (triggered by any PrimeFaces DOM mutation) fills
  // every row with the vaccine that belongs one position later → wrong agents.
  if (isPanoramaMultipleImmunizationGridPage()) return;
  if (isPrimeFacesAjaxBusy()) return;

  const now = Date.now();
  if ((now - lastAutoDrainAt) < 3000) return;
  if ((now - lastVaxlinkFillAt) < 2000) return;

  if (!isImmunizationFormEmpty()) return;

  lastAutoDrainAt = now;
  vlog('auto-drain: empty form detected, applying queue head');
  await applyNextQueueItem();
}

// ---------------------------------------------------------------------------
// Post-save auto-advance: watch for agent field reset after Panorama save
// ---------------------------------------------------------------------------

let postSaveObserver = null;
let lastAgentFilledState = false;
let multiGridObserver = null;
let multiGridFillPending = false;
let multiStepObserver = null;
let lastObservedPanoramaStepKey = '';
let lastAutoFilledPanoramaStepKey = '';
let lastSkippedPanoramaAgentKey = '';
let multiStepAutoFillPending = false;

function isPanoramaMultipleImmunizationGridPage() {
  if (!isHandsFreeSupportedPage()) return false;
  const tableBody = document.querySelector('tbody[id*="historicalfactoryTable:dataTable_data"]');
  if (!tableBody) return false;
  const hasAddRowsButton = !!document.querySelector('button[id*="historicalfactoryTable:addButtonId:commandButtonId"]');
  if (!hasAddRowsButton) return false;
  const hasAgentField = !!document.querySelector('select[id*="historicalfactoryTable:dataTable:0:immsAgentMenu:selectOneMenu_input"]');
  const hasDateField = !!document.querySelector('input[id*="historicalfactoryTable:dataTable:0:dateIn1:dateInput_input"]');
  return hasAgentField && hasDateField;
}

function getPanoramaMultipleGridRows() {
  const body = document.querySelector('tbody[id*="historicalfactoryTable:dataTable_data"]');
  if (!body) return [];
  return Array.from(body.querySelectorAll('tr[data-ri]'));
}

function getPanoramaMultipleGridAgentField(rowIndex) {
  return document.querySelector(`select[id*="historicalfactoryTable:dataTable:${rowIndex}:immsAgentMenu:selectOneMenu_input"]`);
}

function getPanoramaMultipleGridAgentFocusField(rowIndex) {
  return document.querySelector(`input[id*="historicalfactoryTable:dataTable:${rowIndex}:immsAgentMenu:selectOneMenu_focus"]`);
}

function getPanoramaMultipleGridAgentLabel(rowIndex) {
  return document.querySelector(`label[id*="historicalfactoryTable:dataTable:${rowIndex}:immsAgentMenu:selectOneMenu_label"]`);
}

function getPanoramaMultipleGridDate1Field(rowIndex) {
  return document.querySelector(`input[id*="historicalfactoryTable:dataTable:${rowIndex}:dateIn1:dateInput_input"]`);
}

function gridAgentLabelMatchesCandidate(rowIndex, candidate) {
  const labelRaw = getPanoramaMultipleGridAgentLabel(rowIndex)?.textContent || '';
  const labelText = normalizeForMatch(labelRaw);
  const candidateNorm = normalizeForMatch(candidate);
  if (!labelText || !candidateNorm) return false;
  if (labelText === candidateNorm) return true;
  // Reject if label is a compound variant of the candidate (e.g. "HB-pediatric" label for "HB").
  const candidateRaw = String(candidate || '').trim();
  if (candidateRaw && labelRaw.trim().toLowerCase().startsWith(candidateRaw.toLowerCase() + '-')) return false;
  if (labelText.includes(candidateNorm)) return true;
  const candidateTokens = candidateNorm.split(' ').filter(t => t.length >= 3);
  return candidateTokens.length > 0 && candidateTokens.every(t => labelText.includes(t));
}

function getPanoramaMultipleGridRowState(rowIndex) {
  const agentField = getPanoramaMultipleGridAgentField(rowIndex);
  const agentFocusField = getPanoramaMultipleGridAgentFocusField(rowIndex);
  const agentLabel = getPanoramaMultipleGridAgentLabel(rowIndex);
  const dateField = getPanoramaMultipleGridDate1Field(rowIndex);
  const labelText = normalizeForMatch(agentLabel?.textContent || '');
  const selectText = normalizeForMatch(getFieldFilledText(agentField));
  const focusText = normalizeForMatch(getFieldFilledText(agentFocusField));
  return {
    agentField,
    agentFocusField,
    agentLabel,
    dateField,
    agentText: labelText || selectText || focusText,
    dateText: String(dateField?.value || '').trim()
  };
}

function fillPanoramaMultipleGridAgent(rowIndex, data) {
  const agentField = getPanoramaMultipleGridAgentField(rowIndex);
  const agentFocusField = getPanoramaMultipleGridAgentFocusField(rowIndex);
  const agentLabel = getPanoramaMultipleGridAgentLabel(rowIndex);
  if (!agentField || !canFillPanoramaControl(agentField)) return false;
  const candidates = getPanoramaAgentCandidates(data);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fillField(agentField, candidate) && isAgentCandidateAccepted(candidate, agentField)) {
      return true;
    }
    if (agentLabel && gridAgentLabelMatchesCandidate(rowIndex, candidate)) {
      return true;
    }
    if (agentFocusField && fillField(agentFocusField, candidate) && isAgentCandidateAccepted(candidate, agentFocusField)) {
      return true;
    }
  }
  return false;
}

function fillPanoramaMultipleGridDate1(rowIndex, data) {
  const dateField = getPanoramaMultipleGridDate1Field(rowIndex);
  if (!dateField || !canFillPanoramaControl(dateField)) return false;
  const administered = getPanoramaAdministeredDateTimeValues(data);
  if (!administered.date) return false;
  return fillPanoramaMaskedTextInput(dateField, administered.date);
}

function fillPanoramaMultipleGridRow(rowIndex, data) {
  if (!data) return false;
  const rowState = getPanoramaMultipleGridRowState(rowIndex);
  const agentNeeded = !rowState.agentText;
  const dateNeeded = !rowState.dateText;
  let changed = false;

  if (agentNeeded) {
    changed = fillPanoramaMultipleGridAgent(rowIndex, data) || changed;
  }
  if (dateNeeded) {
    changed = fillPanoramaMultipleGridDate1(rowIndex, data) || changed;
  }
  return changed;
}

async function maybeAutoFillPanoramaMultipleGrid() {
  if (multiGridFillPending) return;
  if (activeWorkflowMode !== 'multiple') return;
  if (!isPanoramaMultipleImmunizationGridPage()) return;
  if (isPrimeFacesAjaxBusy()) return;

  multiGridFillPending = true;
  try {
    const stored = await getLocalStorage([MULTIPLE_INJECT_QUEUE_KEY]);
    const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
      ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
    if (!rows.length) return;
    if (!isPanoramaMultipleImmunizationGridPage()) return;

    const gridRows = getPanoramaMultipleGridRows();
    if (!gridRows.length) return;

    const limit = Math.min(rows.length, gridRows.length);
    for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
      const payload = buildAutofillPayloadFromQueueRecord(rows[rowIndex]);
      if (!payload) continue;
      fillPanoramaMultipleGridRow(rowIndex, payload);
    }
  } catch (error) {
    console.warn('VaxLink multi-grid autofill error:', error);
  } finally {
    multiGridFillPending = false;
  }
}

function getPanoramaCurrentTradeSelectionText() {
  const fields = getFields(getPanoramaTradeSelectors()).filter(canFillPanoramaControl);
  for (const field of fields) {
    const text = normalizeForMatch(getFieldFilledText(field));
    if (text && text !== 'select') {
      return text;
    }
  }
  return '';
}

function getPanoramaCurrentLotSelectionText() {
  const selectFields = getFields([
    'select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="LotInfo:lotNumberSelect:selectOneMenu_input"]'
  ]).filter(canFillPanoramaControl);
  for (const field of selectFields) {
    const text = normalizeForMatch(getFieldFilledText(field));
    if (text && text !== 'select') {
      return text;
    }
  }

  const selectedLotLabels = getFields([
    'label[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_label"]',
    'label[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_label"]',
    'label[id*="LotInfo:lotNumberSelect:selectOneMenu_label"]'
  ]);
  for (const label of selectedLotLabels) {
    const text = normalizeForMatch(label?.textContent || '');
    if (text && text !== 'select') {
      return text;
    }
  }
  return '';
}

function getPanoramaMultiStepIndicatorKey() {
  const nodes = Array.from(document.querySelectorAll('div, span, td, th, strong, label'));
  for (const node of nodes) {
    const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/\b(\d+)\s+of\s+(\d+)\s+immunizations?\b/i);
    if (match) {
      return `${match[1]}-of-${match[2]}`;
    }
  }
  return '';
}

function isPanoramaMultiStepDetailPageReadyForAutofill() {
  if (activeWorkflowMode !== 'multiple') return false;
  if (!isPanoramaImmunizationPage()) return false;
  if (isPrimeFacesAjaxBusy()) return false;
  if (!getPanoramaMultiStepIndicatorKey()) return false;
  if (!hasPanoramaAgentSelection(null)) return false;

  const { dateField, timeField } = getPanoramaAdministeredDateTimeFields();
  const hasDateTime = !!String(dateField?.value || '').trim() || !!String(timeField?.value || '').trim();
  if (!hasDateTime) return false;

  const hasTrade = !!getPanoramaCurrentTradeSelectionText();
  const hasLot = !!getPanoramaCurrentLotSelectionText();
  return !hasTrade && !hasLot;
}

async function maybeAutoFillPanoramaMultiStepDetailPage() {
  if (multiStepAutoFillPending) return;
  if (!isPanoramaMultiStepDetailPageReadyForAutofill()) return;

  const stepKey = getPanoramaMultiStepIndicatorKey();
  const currentAgentKey = normalizeForMatch(getPanoramaCurrentAgentSelectionText());
  const attemptKey = currentAgentKey ? `${stepKey}|${currentAgentKey}` : stepKey;
  if (!stepKey || stepKey === lastAutoFilledPanoramaStepKey || attemptKey === lastSkippedPanoramaAgentKey) return;
  if ((Date.now() - lastVaxlinkFillAt) < 1200) return;

  multiStepAutoFillPending = true;
  try {
    const stored = await getLocalStorage([MULTIPLE_INJECT_QUEUE_KEY]);
    const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
      ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
    if (!rows.length) return;
    if (!isPanoramaMultiStepDetailPageReadyForAutofill()) return;

    const result = await applyNextQueueItem({
      matchCurrentAgent: true,
      suppressQueueEmptyToast: true
    });
    if (result === 'success') {
      lastAutoFilledPanoramaStepKey = stepKey;
      lastSkippedPanoramaAgentKey = '';
    } else if (result === 'no_match') {
      lastSkippedPanoramaAgentKey = attemptKey;
    }
  } catch (error) {
    console.warn('VaxLink multi-step autofill error:', error);
  } finally {
    multiStepAutoFillPending = false;
  }
}

function initPostSaveWatcher() {
  if (!isHandsFreeSupportedPage()) return;
  if (postSaveObserver) return;

  const checkAgentTransition = () => {
    if (activeWorkflowMode !== 'multiple') return;
    if (!isPanoramaImmunizationPage()) return;

    const wasFilledBefore = lastAgentFilledState;
    const isEmptyNow = isImmunizationFormEmpty();
    lastAgentFilledState = !isEmptyNow;

    // Detect filled -> empty transition (Panorama form reset after save)
    if (wasFilledBefore && isEmptyNow) {
      const now = Date.now();
      if ((now - lastVaxlinkFillAt) < 2000) return;
      vlog('post-save: agent field reset detected, auto-advancing');
      setTimeout(() => tryAutoDrain(), 800);
    }
  };

  const targetNode = document.body;
  if (!targetNode) return;

  postSaveObserver = new MutationObserver(() => {
    checkAgentTransition();
  });
  postSaveObserver.observe(targetNode, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'value', 'aria-expanded']
  });
}

function initPanoramaMultipleGridWatcher() {
  if (!isHandsFreeSupportedPage()) return;
  if (multiGridObserver) return;

  const checkGrid = () => {
    if (activeWorkflowMode !== 'multiple') return;
    if (!isPanoramaMultipleImmunizationGridPage()) return;
    setTimeout(() => {
      void maybeAutoFillPanoramaMultipleGrid();
    }, 250);
  };

  const targetNode = document.body;
  if (!targetNode) return;

  multiGridObserver = new MutationObserver(() => {
    checkGrid();
  });
  multiGridObserver.observe(targetNode, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'value', 'aria-expanded']
  });

  checkGrid();
}

function initPanoramaMultiStepWatcher() {
  if (!isHandsFreeSupportedPage()) return;
  if (multiStepObserver) return;

  const checkForStepTransition = () => {
    if (activeWorkflowMode !== 'multiple') return;

    const stepKey = getPanoramaMultiStepIndicatorKey();
    if (!stepKey) {
      lastObservedPanoramaStepKey = '';
      return;
    }

    if (stepKey !== lastObservedPanoramaStepKey) {
      lastObservedPanoramaStepKey = stepKey;
      setTimeout(() => {
        void maybeAutoFillPanoramaMultiStepDetailPage();
      }, 350);
      return;
    }

    if (stepKey !== lastAutoFilledPanoramaStepKey && isPanoramaMultiStepDetailPageReadyForAutofill()) {
      setTimeout(() => {
        void maybeAutoFillPanoramaMultiStepDetailPage();
      }, 200);
    }
  };

  const targetNode = document.body;
  if (!targetNode) return;

  multiStepObserver = new MutationObserver(() => {
    checkForStepTransition();
  });
  multiStepObserver.observe(targetNode, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'value', 'aria-expanded']
  });

  checkForStepTransition();
}

// ---------------------------------------------------------------------------
// Initialize new features after DOM is ready
// ---------------------------------------------------------------------------

