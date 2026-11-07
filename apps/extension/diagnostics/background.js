// The background owns control authorization and session-local correlation.
(() => {
  const MAP_KEY = 'vaxlink_diagnostic_queue_links_v1';
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const actions = new Set([
    'start',
    'stop',
    'clear',
    'read',
    'export',
    'health',
    'join',
    'events',
    'queueParent'
  ]);
  function create({ chrome, health }) {
    const { createCollector, validateEvent, validateLink } =
      globalThis.VaxLinkDiagnosticCollector;
    const collector = createCollector({ storage: chrome.storage.session });
    const producer = globalThis.VaxLinkDiagnosticEvents.createProducer({
      context: 'background',
      deliver: ({ events, dropped }) => collector.recordBatch(events, dropped)
    });
    let current = null;
    let links = new Map();
    let mapWrites = Promise.resolve();
    let controls = Promise.resolve();
    const bindings = new Map();
    const tabAliases = new Map();
    const safe = (promise) => Promise.resolve(promise).catch(() => undefined);
    const summary = () => {
      if (
        !current ||
        current.state !== 'recording' ||
        Date.now() >= current.recordingUntil
      )
        return null;
      return { id: current.id, recordingUntil: current.recordingUntil };
    };
    function setCurrent(next) {
      const previous = summary();
      current = next;
      const active = summary();
      if (
        previous?.id !== active?.id ||
        previous?.recordingUntil !== active?.recordingUntil
      ) {
        bindings.clear();
        tabAliases.clear();
        producer.setSession(active);
      }
    }
    function persistLinks() {
      const sessionId = summary()?.id;
      const entries = [...links.entries()];
      mapWrites = mapWrites
        .catch(() => undefined)
        .then(() =>
          chrome.storage.session.set({ [MAP_KEY]: { sessionId, entries } })
        );
      safe(mapWrites);
    }
    function clearLinks() {
      links.clear();
      bindings.clear();
      tabAliases.clear();
      mapWrites = mapWrites
        .catch(() => undefined)
        .then(() => chrome.storage.session.remove(MAP_KEY));
      return mapWrites;
    }
    const ready = (async () => {
      const restored = await collector.read();
      setCurrent(restored);
      const saved = (await chrome.storage.session.get(MAP_KEY))[MAP_KEY];
      if (
        summary() &&
        saved?.sessionId === summary().id &&
        Array.isArray(saved.entries)
      ) {
        links = new Map(
          saved.entries
            .filter(
              (entry) =>
                Array.isArray(entry) &&
                typeof entry[0] === 'string' &&
                entry[0].length <= 128 &&
                (entry[1] === null || UUID.test(entry[1]))
            )
            .slice(-1000)
        );
      }
      if (summary()) {
        const link = producer.newOperation();
        producer.record(link, 'lifecycle', 'interrupted', {
          reason: 'unknown'
        });
        await producer.flush();
      } else {
        await clearLinks();
      }
    })().catch(() => {
      setCurrent(null);
      links.clear();
    });
    function owner(sender) {
      if (sender?.id !== chrome.runtime.id || typeof sender.url !== 'string')
        return null;
      let url;
      try {
        url = new URL(sender.url);
      } catch (_) {
        return null;
      }
      const extension = new URL(chrome.runtime.getURL('/'));
      const owned =
        url.protocol === extension.protocol && url.host === extension.host;
      if (owned) {
        const viewer =
          url.pathname === '/diagnostics.html' &&
          (!url.search || /^\?origin=\d+$/.test(url.search));
        const popup = url.pathname === '/popup.html' && !url.search;
        const offscreen =
          url.pathname === '/scanner-daemon.html' && !url.search;
        if (url.hash || (!viewer && !popup && !offscreen)) return null;
        if (sender.tab && sender.tab.url !== sender.url) return null;
        return {
          type: viewer ? 'viewer' : popup ? 'popup' : 'offscreen',
          key:
            sender.documentId ||
            (sender.tab?.id != null ? `tab:${sender.tab.id}` : sender.url)
        };
      }
      if (
        url.protocol !== 'https:' ||
        sender.frameId !== 0 ||
        !Number.isInteger(sender.tab?.id) ||
        !sender.documentId
      )
        return null;
      const host = url.hostname.toLowerCase();
      const panorama = [
        'www.panorama.prod.ehealthontario.ca',
        'panorama.prod.ehealthontario.ca',
        'trpanoramadhir.prod.ehealthontario.ca'
      ].includes(host);
      if (!(
        (panorama && url.pathname.toLowerCase().includes('/recordimms/')) ||
        host === 'inputhealth.com' ||
        host.endsWith('.inputhealth.com')
      ))
        return null;
      return {
        type: 'content',
        key: `tab:${sender.tab.id}:document:${sender.documentId}`
      };
    }
    function broadcast() {
      const message = { action: 'diagnostics.session', session: summary() };
      try {
        safe(chrome.runtime.sendMessage(message));
        safe(
          chrome.tabs
            .query({})
            .then((tabs) =>
              Promise.all(
                tabs
                  .filter((tab) => Number.isInteger(tab.id))
                  .map((tab) =>
                    safe(
                      chrome.tabs.sendMessage(tab.id, message, { frameId: 0 })
                    )
                  )
              )
            )
        );
      } catch (_) {
        // Messaging is best effort.
      }
    }
    async function run(request, sender) {
      await ready;
      const who = owner(sender);
      if (!who) return { success: false, error: 'Diagnostic access denied.' };
      const action = request.action.slice('diagnostics.'.length);
      const control = who.type === 'viewer' || who.type === 'popup';
      if (
        ['start', 'stop', 'clear', 'read', 'export', 'health'].includes(
          action
        ) &&
        !control
      )
        return { success: false, error: 'Diagnostic access denied.' };
      if (!summary() && current) {
        setCurrent(await collector.read());
        producer.setSession(null);
        await clearLinks();
      }
      if (action === 'start') {
        if (summary())
          return {
            success: false,
            error: 'A diagnostic recording is already active.'
          };
        const next = await collector.start();
        links.clear();
        setCurrent(next);
        persistLinks();
        broadcast();
        return { success: true, session: summary() };
      }
      if (action === 'read') {
        const next = await collector.read();
        setCurrent(next);
        return { success: true, session: next };
      }
      if (action === 'health')
        return {
          success: true,
          health: await health(
            Number.isInteger(request.originTabId) && request.originTabId >= 0
              ? request.originTabId
              : null
          )
        };
      if (action === 'stop' || action === 'clear') {
        if (!current || request.sessionId !== current.id)
          return { success: false, error: 'Diagnostic session changed.' };
        if (action === 'stop') {
          await producer.flush();
          const pending = producer.pendingCount();
          if (pending) await collector.recordBatch([], pending);
          setCurrent(await collector.stop());
        } else {
          await collector.clear();
          setCurrent(null);
        }
        await clearLinks();
        broadcast();
        return { success: true, session: summary() };
      }
      if (action === 'export') {
        const data = await collector.read();
        setCurrent(data);
        if (!data || request.sessionId !== data.id)
          return { success: false, error: 'Diagnostic session changed.' };
        return {
          success: true,
          data: {
            version: 1,
            build: globalThis.VaxLinkBuildIdentity || null,
            session: data
          }
        };
      }
      const active = summary();
      if (action === 'join') {
        if (!active) return { success: true, session: null };
        const allowed =
          who.type === 'content'
            ? ['content']
            : who.type === 'popup'
              ? ['popup']
              : who.type === 'offscreen'
                ? ['offscreen', 'worker']
                : [];
        if (
          !allowed.includes(request.context) ||
          !UUID.test(String(request.contextId || ''))
        )
          return { success: false, error: 'Invalid diagnostic context.' };
        const key = `${who.key}:${request.context}`;
        if (!bindings.has(key) && bindings.size >= 128)
          return { success: false, error: 'Too many diagnostic contexts.' };
        bindings.set(key, {
          id: request.contextId,
          sessionId: active.id
        });
        return { success: true, session: active };
      }
      const binding = bindings.get(`${who.key}:${request.context}`);
      if (
        !active ||
        request.sessionId !== active.id ||
        !binding ||
        binding.sessionId !== active.id ||
        binding.id !== request.contextId
      )
        return {
          success: false,
          error: 'Diagnostic session or context is unavailable.'
        };
      if (action === 'queueParent') {
        if (
          typeof request.recordId !== 'string' ||
          !request.recordId ||
          request.recordId.length > 128
        )
          return { success: false, error: 'Invalid queue identifier.' };
        return {
          success: true,
          parentOperationId: links.get(request.recordId) || null
        };
      }
      if (
        !Array.isArray(request.events) ||
        request.events.length > 25 ||
        !Number.isSafeInteger(request.dropped) ||
        request.dropped < 0 ||
        request.dropped > 1000000 ||
        request.events.some(
          (event) =>
            event.context !== request.context ||
            event.contextId !== request.contextId ||
            !validateEvent(event, active.id)
        )
      )
        return { success: false, error: 'Invalid diagnostic batch.' };
      return {
        success: true,
        ...(await collector.recordBatch(request.events, request.dropped))
      };
    }
    return {
      ready,
      session: summary,
      newOperation(parentId) {
        try {
          return producer.newOperation(parentId);
        } catch (_) {
          return null;
        }
      },
      adopt(link) {
        const active = summary();
        return active && validateLink(link, active.id) ? { ...link } : null;
      },
      record(link, code, outcome, details) {
        try {
          return producer.record(link, code, outcome, details);
        } catch (_) {
          return false;
        }
      },
      rememberQueue(recordId, link) {
        if (
          typeof recordId !== 'string' ||
          !recordId ||
          recordId.length > 128 ||
          !this.adopt(link)
        )
          return;
        const existing = links.get(recordId);
        const operationId =
          links.has(recordId) && existing !== link.operationId
            ? null
            : link.operationId;
        links.delete(recordId);
        links.set(recordId, operationId);
        if (links.size > 1000) links.delete(links.keys().next().value);
        persistLinks();
      },
      tabAlias(tabId, link) {
        if (!Number.isInteger(tabId) || tabId < 0 || !this.adopt(link))
          return undefined;
        if (!tabAliases.has(tabId)) tabAliases.set(tabId, crypto.randomUUID());
        if (tabAliases.size > 128)
          tabAliases.delete(tabAliases.keys().next().value);
        return tabAliases.get(tabId);
      },
      pendingKey(timestamp) {
        return summary() &&
          typeof timestamp === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) &&
          Number.isFinite(Date.parse(timestamp))
          ? `pending:${timestamp}`
          : null;
      },
      parentForQueue(recordId) {
        return summary() &&
          typeof recordId === 'string' &&
          recordId.length <= 128
          ? links.get(recordId) || null
          : null;
      },
      handleMessage(request, sender, reply) {
        if (
          typeof request?.action !== 'string' ||
          !request.action.startsWith('diagnostics.') ||
          !actions.has(request.action.slice(12))
        )
          return undefined;
        const action = request.action.slice(12);
        const control = ['start', 'stop', 'clear', 'read', 'export'].includes(
          action
        );
        const operation = control
          ? (controls = controls
              .catch(() => undefined)
              .then(() => run(request, sender)))
          : run(request, sender);
        void operation.then(reply).catch(() =>
          reply({
            success: false,
            error: 'Diagnostic operation unavailable.'
          })
        );
        return true;
      }
    };
  }
  globalThis.VaxLinkDiagnosticBackground = Object.freeze({ create });
})();
