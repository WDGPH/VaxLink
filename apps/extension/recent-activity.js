(() => {
  const preferenceKey = 'vaxlink_recent_activity_enabled';
  const debugEnabled = (value) =>
    value ?? chrome.runtime.getManifest().name === 'VaxLink Alpha';
  const sessionKey = 'vaxlink_recent_activity_v1';
  const operationRange = 1000000;
  const maxRows = 3000;
  const maxBytes = 1024 * 1024;
  const maxBatch = 32;
  const choices =
    (...values) =>
    (value) =>
      values.includes(value);
  const integer = (min, max) => (value) =>
    Number.isSafeInteger(value) && value >= min && value <= max;
  const outcome = choices('match', 'mismatch', 'not_requested', 'not_checked');
  const deferredFieldNames = ['date', 'time', 'reason', 'consent'];
  const deferredOutcome = choices(
    'match',
    'mismatch',
    'not_requested',
    'missing',
    'disabled'
  );
  const deferredFields = (fields) =>
    fields &&
    Object.keys(fields).length === deferredFieldNames.length &&
    deferredFieldNames.every(
      (key) => Object.hasOwn(fields, key) && deferredOutcome(fields[key])
    );
  const funding = choices(
    '',
    'SHOW_ALL',
    'PUBLICLY_FUNDED',
    'NON_PUBLICLY_FUNDED'
  );
  const validBarcode = (value) =>
    typeof value === 'string' &&
    value.length <= 128 &&
    (/^(?:01\d{14}|17\d{6}|10[!-~]|21[!-~])[!-~\x1d]*$/.test(value) ||
      globalThis.VaxLinkGS1Parser.isRetailBarcode(value));
  const catalogueVersion = (value) =>
    value === null ||
    (typeof value === 'string' &&
      /^\d+(?:\.\d+)*$/.test(value) &&
      value.length <= 32);
  const wake = choices(
    'initial',
    'timer',
    'fallback',
    'dom',
    'stability',
    'late'
  );
  const details = {
    scan: { decision: choices('accepted', 'held', 'workflow_mismatch') },
    barcode: {
      result: choices('parsed', 'malformed', 'missing_lot'),
      barcode: (value) => value === '' || validBarcode(value)
    },
    nvc_lookup: {
      result: choices(
        'found',
        'not_found',
        'incomplete',
        'initializing',
        'unavailable',
        'no_lot'
      ),
      catalogueVersion
    },
    options: {
      target: choices(true, false),
      count: integer(0, 100000),
      funding,
      control: choices('select', 'panel', 'missing'),
      site: choices('training', 'production')
    },
    lot_miss: { funding: choices('PUBLICLY_FUNDED', 'NON_PUBLICLY_FUNDED') },
    lot_cleanup: { result: choices('empty', 'cleared', 'review') },
    funding_comparison: { outcome: choices('single', 'both', 'unmatched') },
    funding_prompt: { reason: choices('manual', 'both', 'other') },
    funding_choice: {
      funding: choices('PUBLICLY_FUNDED', 'NON_PUBLICLY_FUNDED')
    },
    grid_handoff: {
      row: integer(1, 100000),
      step: integer(0, 100000),
      result: choices(
        'date_missing',
        'detail_disabled',
        'assigned',
        'superseded',
        'route_changed',
        'context_changed',
        'row_replaced',
        'row_changed',
        'duplicate_agent',
        'enter_details',
        'row_missing',
        'detail_timeout',
        'manual_use',
        'skipped',
        'detail_identity_unmatched',
        'detail_fields_loading',
        'detail_agent_unmatched',
        'detail_unassigned',
        'detail_date_unmatched',
        'detail_lot_unconfirmed',
        'detail_not_ready',
        'detail_matched',
        'grid_blurred',
        'window_blur',
        'tab_hidden',
        'pagehide',
        'popstate',
        'hashchange',
        'workflow_changed',
        'grid_cancel',
        'grid_close',
        'grid_reset',
        'chart_inactive',
        'chart_url_changed',
        'grid_form_changed',
        'grid_returned',
        'single_form_opened',
        'detail_step_reversed',
        'unexpected_step_total',
        'detail_form_changed'
      )
    },
    grid_click: {
      result: choices(
        'accepted',
        'no_assignments',
        'button_outside_form',
        'chart_inactive',
        'grid_not_open',
        'no_matching_rows'
      )
    },
    grid_detail_decision: {
      row: integer(0, 100000),
      step: integer(1, 100000),
      total: integer(1, 100000),
      reason: choices(
        'candidate_ready',
        'detail_not_ready',
        'detail_fields_loading',
        'detail_agent_unmatched',
        'duplicate_agent',
        'detail_unassigned',
        'detail_date_unmatched',
        'detail_lot_unconfirmed'
      ),
      waitExpired: choices(true, false),
      alias: choices(true, false),
      reordered: choices(true, false),
      lotEvidence: choices(
        'not_checked',
        'not_required',
        'selected',
        'native_option',
        'panel_option',
        'blank_final',
        'missing',
        'conflicting_selection',
        'disabled',
        'refreshing',
        'native_no_match',
        'panel_unlinked',
        'panel_hidden',
        'panel_unavailable',
        'panel_no_match'
      ),
      funding
    },
    grid_takeover: {
      row: integer(0, 100000),
      step: integer(1, 100000),
      total: integer(1, 100000),
      trigger: choices('staff_input', 'tray_use'),
      reservation: choices(
        'no_matching_assignment',
        'not_reserved',
        'released',
        'unconfirmed'
      )
    },
    detail_position: { step: integer(1, 9999), total: integer(1, 9999) },
    detail_readback: {
      funding,
      native: choices('missing', 'blank', 'requested', 'other'),
      visible: choices('missing', 'blank', 'requested', 'other'),
      time: choices('missing', 'blank', 'partial', 'complete'),
      changed: (names) =>
        Array.isArray(names) &&
        names.length <= 6 &&
        new Set(names).size === names.length &&
        names.every(
          choices('lot', 'reason', 'label', 'time', 'date', 'consent')
        )
    },
    ajax_complete: { source: choices('funding', 'lot', 'consent', 'unknown') },
    late_readback: {
      delay: choices(1500, 3500),
      result: choices(
        'still_populated',
        'restored',
        'needs_review',
        'detail_changed',
        'product_changed',
        'route_unavailable',
        'expired',
        'busy',
        'error'
      )
    },
    check: {
      wake,
      agent: outcome,
      lot: outcome,
      trade: outcome,
      deferred: outcome
    },
    stop: {
      reason: choices(
        'settled',
        'deadline',
        'takeover',
        'context',
        'replaced',
        'route_unavailable',
        'funding',
        'funding_exhausted',
        'lot_not_matched',
        'different_lot_selected',
        'expired',
        'error'
      )
    }
  };
  const common = {
    operation: integer(1, operationRange - 1),
    ms: integer(0, 24 * 60 * 60 * 1000),
    mode: choices('single', 'multiple', 'inventory'),
    stage: choices('grid', 'detail', 'none')
  };
  const scanRouting = {
    workflow: choices('immunization', 'inventory'),
    form: choices(
      null,
      'unknown',
      'provider_single',
      'non_provider_single',
      'multiple_grid',
      'multiple_detail'
    ),
    formBlockedBy: choices(
      null,
      'form_missing_or_ambiguous',
      'conflicting_controls',
      'detail_controls_not_visible',
      'conflicting_titles',
      'unrecognized_title',
      'controls_unavailable',
      'panorama_busy',
      'no_grid_rows',
      'already_has_vaccine'
    ),
    chartReady: choices(true, false),
    formReady: choices(true, false),
    singleAutofill: choices(true, false),
    gridAutofill: choices(true, false)
  };

  function validEvent(row) {
    if (
      !row ||
      typeof row.event !== 'string' ||
      !Object.hasOwn(details, row.event)
    )
      return false;
    if (
      row.event === 'barcode' &&
      row.result === 'malformed' &&
      row.barcode !== ''
    )
      return false;
    const fields = { ...common, ...details[row.event] };
    if (row.event === 'scan' && Object.hasOwn(row, 'routing')) {
      fields.routing = (routing) =>
        routing &&
        Object.keys(routing).length === Object.keys(scanRouting).length &&
        Object.entries(scanRouting).every(
          ([key, valid]) => Object.hasOwn(routing, key) && valid(routing[key])
        );
    }
    if (
      row.event === 'check' &&
      row.stage === 'detail' &&
      Object.hasOwn(row, 'deferredCheck')
    )
      fields.deferredCheck = (check) =>
        check &&
        Object.keys(check).length === 2 &&
        Object.hasOwn(check, 'before') &&
        deferredFields(check.before) &&
        Object.hasOwn(check, 'after') &&
        deferredFields(check.after);
    if (row.event === 'stop' && Object.hasOwn(row, 'repeatedChecks'))
      fields.repeatedChecks = integer(1, 100000);
    if (
      row.event === 'stop' &&
      row.reason === 'deadline' &&
      Object.hasOwn(row, 'lastDeferredFields')
    ) {
      fields.lastDeferredFields = (names) =>
        Array.isArray(names) &&
        names.length > 0 &&
        names.length <= deferredFieldNames.length &&
        new Set(names).size === names.length &&
        names.every((name) => deferredFieldNames.includes(name));
    }
    return (
      Object.keys(row).length === Object.keys(fields).length + 1 &&
      Object.entries(fields).every(
        ([key, valid]) => Object.hasOwn(row, key) && valid(row[key])
      )
    );
  }

  function scannedBarcode(value) {
    const barcode = globalThis.VaxLinkGS1Parser.normalizeGS1BarcodeText(value);
    return validBarcode(barcode) ? barcode : '';
  }

  function lookupResult(lookup) {
    if (lookup && !lookup.error) return 'found';
    if (
      ['not_found', 'incomplete', 'initializing'].includes(
        lookup?.errorCategory
      )
    )
      return lookup.errorCategory;
    return 'unavailable';
  }

  function buildDetails() {
    const manifest = chrome.runtime.getManifest();
    return {
      name: manifest.name,
      version: manifest.version,
      versionName: manifest.version_name || null,
      fingerprint: globalThis.VAXLINK_BUILD_ID || null
    };
  }

  function createRecorder(
    getLocal,
    setLocal,
    getSettingsAtExport = async () => null
  ) {
    const session = chrome.storage.session;
    let queue = Promise.resolve();
    const empty = () => ({
      token: crypto.randomUUID(),
      nextSource: 1,
      rows: [],
      overwritten: 0
    });
    const enabled = async () =>
      debugEnabled((await getLocal([preferenceKey]))[preferenceKey]) === true;
    const load = async () => (await session.get(sessionKey))[sessionKey];
    const save = (state) => session.set({ [sessionKey]: state });
    const summary = (isEnabled, state) => ({
      enabled: isEnabled,
      retained: state?.rows.length ?? 0,
      overwritten: state?.overwritten ?? 0
    });

    // Sharing one writer with clear and disable prevents an in-flight append
    // from restoring rows after either command completes.
    function serialize(work) {
      const result = queue.then(work);
      queue = result.catch(() => {});
      return result;
    }

    function open() {
      return serialize(async () => {
        if (!(await enabled())) return {};
        const state = (await load()) ?? empty();
        const source = state.nextSource++;
        await save(state);
        return { token: state.token, source };
      });
    }

    function append(token, source, rows) {
      if (
        typeof token !== 'string' ||
        token.length !== 36 ||
        !integer(
          1,
          Math.floor(Number.MAX_SAFE_INTEGER / operationRange) - 1
        )(source) ||
        !Array.isArray(rows) ||
        rows.length === 0 ||
        rows.length > maxBatch ||
        !rows.every(validEvent)
      )
        return Promise.resolve({ success: false });

      return serialize(async () => {
        const state = (await enabled()) ? await load() : null;
        if (token !== state?.token || source >= state.nextSource)
          return { success: false, stale: true };
        const appended = rows.map((row) => ({
          ...row,
          operation: source * operationRange + row.operation
        }));
        state.rows.push(...appended);
        const excess = Math.max(0, state.rows.length - maxRows);
        state.rows.splice(0, excess);
        state.overwritten += excess;
        while (
          new TextEncoder().encode(JSON.stringify(state)).length > maxBytes
        ) {
          state.rows.shift();
          state.overwritten += 1;
        }
        await save(state);
        return { success: true };
      });
    }

    function manage(action, nextEnabled) {
      return serialize(async () => {
        const wasEnabled = await enabled();
        if (action === 'setRecentActivity' && nextEnabled !== wasEnabled) {
          if (nextEnabled) await save(empty());
          else await session.remove(sessionKey);
          await setLocal({ [preferenceKey]: nextEnabled });
          return summary(nextEnabled);
        }
        if (action === 'setRecentActivity' && !nextEnabled)
          await session.remove(sessionKey);
        if (!wasEnabled) {
          return action === 'exportRecentActivity'
            ? { success: false }
            : summary(false);
        }
        const state = await load();
        const status = summary(true, state);
        return action === 'exportRecentActivity'
          ? {
              ...status,
              format: 3,
              build: buildDetails(),
              settingsAtExport: await getSettingsAtExport().catch(() => null),
              rows: state?.rows ?? []
            }
          : status;
      });
    }

    return { open, append, manage };
  }

  function createChartRecorder() {
    let recording = null;
    let preferenceObserved = false;
    let pending = [];
    let timer = null;

    async function send(message) {
      return chrome.runtime.sendMessage(message);
    }

    function open() {
      const current = recording;
      if (!current || current.ticket || current.opening) return;
      current.opening = true;
      void send({ action: 'openRecentActivity' })
        .then((reply) => {
          if (current === recording && reply?.token) {
            current.ticket = { token: reply.token, source: reply.source };
            flush();
          }
        })
        .catch(() => {})
        .finally(() => {
          current.opening = false;
        });
    }

    function reset(enabled = !!recording) {
      recording = enabled
        ? { operation: 0, ticket: null, opening: false }
        : null;
      pending = [];
      clearTimeout(timer);
      timer = null;
      open();
    }

    function flush() {
      clearTimeout(timer);
      timer = null;
      const current = recording;
      if (!current?.ticket || !pending.length) return;
      const rows = pending;
      pending = [];
      void send({ action: 'appendRecentActivity', ...current.ticket, rows })
        .then((reply) => {
          if (reply?.stale && recording === current) reset();
        })
        .catch(() => {});
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && Object.hasOwn(changes, preferenceKey)) {
        preferenceObserved = true;
        reset(debugEnabled(changes[preferenceKey].newValue) === true);
      }
    });
    void Promise.resolve()
      .then(() => chrome.storage.local.get(preferenceKey))
      .then((stored) => {
        if (!preferenceObserved)
          reset(debugEnabled(stored[preferenceKey]) === true);
      })
      .catch(() => {});

    return {
      flush,
      begin(mode, stage) {
        if (!recording || recording.operation >= operationRange - 1)
          return null;
        open();
        return {
          recording,
          operation: ++recording.operation,
          started: performance.now(),
          mode,
          stage
        };
      },
      isCurrent(trace) {
        return !!trace && trace.recording === recording;
      },
      record(trace, event, fields) {
        if (!trace || trace.recording !== recording) return;
        if (event === 'check' && fields.wake !== 'late') {
          const { wake, ...fieldResults } = fields;
          const signature = JSON.stringify(fieldResults);
          if (signature === trace.lastCheck) {
            trace.repeatedChecks = Math.min(
              (trace.repeatedChecks || 0) + 1,
              100000
            );
            return;
          }
          trace.lastCheck = signature;
        }
        if (event === 'options') {
          const signature = JSON.stringify(fields);
          if (signature === trace.lastOptions) return;
          trace.lastOptions = signature;
        }
        if (event === 'stop' && trace.repeatedChecks) {
          fields = { ...fields, repeatedChecks: trace.repeatedChecks };
          trace.repeatedChecks = 0;
          trace.lastCheck = undefined;
          trace.lastOptions = undefined;
        }
        if (pending.length === maxBatch) pending.shift();
        pending.push({
          event,
          operation: trace.operation,
          ms: Math.max(0, Math.round(performance.now() - trace.started)),
          mode: trace.mode,
          stage: trace.stage,
          ...fields
        });
        if (!recording.ticket) open();
        else if (pending.length >= maxBatch) flush();
        else if (timer === null) timer = setTimeout(flush, 50);
      }
    };
  }

  globalThis.VaxLinkRecentActivity = {
    preferenceKey,
    sessionKey,
    scannedBarcode,
    lookupResult,
    catalogueVersion,
    createRecorder,
    createChartRecorder
  };
})();
