// Uses the maintained content-script helpers in the same isolated world.
// Production packages omit this implementation and retain only inert calls.
(() => {
  function diagnosticPrimeFacesState() {
    try {
      const queue = globalThis.PrimeFaces?.ajax?.Queue;
      if (typeof queue?.isEmpty === 'function')
        return queue.isEmpty() ? 'idle' : 'busy';
      if (Array.isArray(queue?.requests))
        return queue.requests.length ? 'busy' : 'idle';
    } catch (_) {
      /* Page-world state may be inaccessible. */
    }
    return 'unknown';
  }

  function diagnosticPanoramaSnapshot(data, phase) {
    if (!data?._diagnostic || !contentDiagnostics?.active()) return;
    try {
      const administered = getPanoramaAdministeredDateTimeValues(data);
      const agentCandidates = getPanoramaAgentCandidates(data);
      const explicitFunding =
        !!getPanoramaSharedFundingLotProductLabel(data) && !!data.lot;
      const funding =
        data._fundedRadioChoice ||
        (explicitFunding ? getPanoramaFundedRadioValue() : 'SHOW_ALL');
      const specs = [
        {
          field: 'agent',
          selectors: getPanoramaAgentSelectors(),
          requested: !!agentCandidates.length,
          match: (text) =>
            agentCandidates.some((candidate) =>
              isAgentTextAccepted(candidate, text)
            )
        },
        {
          field: 'lot',
          selectors: getPanoramaLotSelectors(),
          requested: !!data.lot,
          match: (text) => !!data.lot && optionTextContainsLot(text, data.lot)
        },
        {
          field: 'funding',
          selectors: ['input[id*="fundedRadio:selectOneRadio"]'],
          requested: hasPanoramaFundedRadio(),
          match: (text) => !!funding && text === funding
        },
        {
          field: 'date',
          selectors: ['input[id*="dateAdministedDate:dateInput_input"]'],
          requested: !!administered.date,
          match: (text) => !!administered.date && text === administered.date
        },
        {
          field: 'time',
          selectors: ['input[id*="dateAdministedDate:timeInput:timeInput"]'],
          requested: !!administered.time,
          match: (text) => !!administered.time && text === administered.time
        },
        {
          field: 'reason',
          selectors: getPanoramaReasonForImmunizationSelectors(),
          requested: reasonConsentAutofillEnabled,
          match: (text) =>
            normalizeForMatch(text) ===
            normalizeForMatch(getPanoramaReasonForImmunizationValue(data))
        },
        {
          field: 'consent',
          selectors: getPanoramaConsentReasonSelectors(),
          requested: reasonConsentAutofillEnabled,
          match: (text) =>
            normalizeForMatch(text) ===
            normalizeForMatch(getPanoramaConsentReasonValue(data))
        }
      ];
      const groups = [];
      for (const spec of specs) {
        const nodes = getFields(spec.selectors);
        const native = nodes.filter(
          (node) =>
            node.tagName === 'SELECT' ||
            !['agent', 'lot', 'reason', 'consent'].includes(spec.field)
        );
        groups.push({
          field: spec.field,
          native: true,
          nodes: native,
          requested: spec.requested,
          enabled: canFillPanoramaControl,
          matches: (node) =>
            (spec.field !== 'funding' || node.checked) &&
            spec.match(getFieldFilledText(node)),
          desiredMatches: (node) =>
            Array.from(node?.options || []).filter((option) =>
              spec.match(option.text || '')
            ).length
        });
        if (['agent', 'lot', 'reason', 'consent'].includes(spec.field)) {
          const widgets = new Set(
            nodes.filter((node) => node.tagName !== 'SELECT')
          );
          for (const node of nodes) {
            const label = document.getElementById(
              String(node.id || '').replace(/_(input|focus)$/, '_label')
            );
            if (label) widgets.add(label);
          }
          groups.push({
            field: spec.field,
            native: false,
            nodes: [...widgets],
            requested: spec.requested,
            matches: (node) => spec.match(getFieldFilledText(node)),
            desiredMatches: () => 0
          });
        }
      }
      contentDiagnostics.snapshot(data._diagnostic, phase, groups);
    } catch (_) {
      /* Snapshot failures must not affect a fill. */
    }
  }

  function diagnosticPanoramaVerified(data) {
    const administered = getPanoramaAdministeredDateTimeValues(data);
    const { dateField, timeField } = getPanoramaAdministeredDateTimeFields();
    const fundingControls = getFields([
      'input[id*="fundedRadio:selectOneRadio"]'
    ]);
    const funding =
      data._fundedRadioChoice ||
      (getPanoramaSharedFundingLotProductLabel(data) && data.lot
        ? getPanoramaFundedRadioValue()
        : 'SHOW_ALL');
    return (
      (!fundingControls.length ||
        fundingControls.some(
          (node) => node.checked && node.value === funding
        )) &&
      (!getPanoramaAgentCandidates(data).length ||
        hasPanoramaAgentSelection(data)) &&
      (!data.lot || hasPanoramaLotSelection(data.lot)) &&
      (!administered.date ||
        (!!dateField &&
          String(dateField.value || '').trim() === administered.date)) &&
      (!administered.time ||
        (!!timeField &&
          String(timeField.value || '').trim() === administered.time)) &&
      (!reasonConsentAutofillEnabled ||
        (getFields(getPanoramaReasonForImmunizationSelectors()).some(
          canFillPanoramaControl
        ) &&
          getFields(getPanoramaConsentReasonSelectors()).some(
            canFillPanoramaControl
          ) &&
          panoramaSelectHasDesiredSelection(
            getPanoramaReasonForImmunizationSelectors(),
            getPanoramaReasonForImmunizationValue(data)
          ) &&
          panoramaSelectHasDesiredSelection(
            getPanoramaConsentReasonSelectors(),
            getPanoramaConsentReasonValue(data)
          )))
    );
  }

  globalThis.VaxLinkPanoramaDiagnostics = Object.freeze({
    queueState: diagnosticPrimeFacesState,
    snapshot: diagnosticPanoramaSnapshot,
    verified: diagnosticPanoramaVerified
  });
})();
