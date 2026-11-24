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
  const common = {
    operation: integer(1, operationRange - 1),
    ms: integer(0, 24 * 60 * 60 * 1000),
    mode: choices('single', 'multiple', 'inventory'),
    stage: choices('grid', 'detail', 'none')
  };
  const details = {
    scan: { decision: choices('accepted', 'held', 'workflow_mismatch') }
  };

  function validEvent(row) {
    if (!row || !Object.hasOwn(details, row.event)) return false;
    const fields = { ...common, ...details[row.event] };
    return (
      Object.keys(row).length === Object.keys(fields).length + 1 &&
      Object.entries(fields).every(
        ([key, valid]) => Object.hasOwn(row, key) && valid(row[key])
      )
    );
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

  globalThis.VaxLinkRecentActivity = {
    preferenceKey,
    sessionKey,
    createRecorder
  };
})();
