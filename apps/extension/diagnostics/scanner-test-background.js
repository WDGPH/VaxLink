(() => {
  const key = 'vaxlink_scanner_test_lease_v1';
  const page = 'diagnostics/scanner-test.html';

  function authorized(sender) {
    return (
      sender?.id === chrome.runtime.id &&
      sender?.frameId === 0 &&
      Number.isInteger(sender?.tab?.id) &&
      sender.url === chrome.runtime.getURL(page)
    );
  }

  function ownerIsGone(tabId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.get(tabId, (tab) => {
        const error = chrome.runtime.lastError;
        if (error) {
          if (/^No tab with id:/i.test(error.message || '')) resolve(true);
          else reject(new Error('Cannot verify scanner test ownership.'));
          return;
        }
        resolve(!tab);
      });
    });
  }

  function create({
    getStorage,
    setStorage,
    hasDaemon,
    sendDaemon,
    enabledKey
  }) {
    async function getLease() {
      return (await getStorage([key]))[key] || null;
    }
    async function checkConnect(explicit = false) {
      const lease = await getLease();
      if (!lease) return;
      if (!explicit || !(await ownerIsGone(lease.tabId))) {
        throw new Error(
          'Scanner test owns the scanner. Stop the test and close its page before reconnecting.'
        );
      }
      await setStorage({ [key]: null });
    }
    async function acquire(sender) {
      if (!authorized(sender)) throw new Error('Scanner test page required.');
      if (await getLease())
        throw new Error('Scanner test is already active or paused.');
      const lease = { token: crypto.randomUUID(), tabId: sender.tab.id };
      await setStorage({ [key]: lease, [enabledKey]: false });
      if (await hasDaemon()) {
        let timer;
        const response = await Promise.race([
          sendDaemon(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    'Scanner release was not confirmed. Close the test page before reconnecting.'
                  )
                ),
              6000
            );
          })
        ]).finally(() => clearTimeout(timer));
        if (response?.success !== true || response.released !== true) {
          throw new Error(
            'Scanner release was not confirmed. Close the test page before reconnecting.'
          );
        }
      }
      return { success: true, released: true, lease: lease.token };
    }
    async function release(sender, token) {
      if (!authorized(sender)) throw new Error('Scanner test page required.');
      const lease = await getLease();
      if (!lease || lease.tabId !== sender.tab.id || lease.token !== token) {
        throw new Error('Scanner test ownership does not match.');
      }
      await setStorage({ [key]: null });
      return { success: true };
    }
    return { checkConnect, acquire, release };
  }
  globalThis.VaxLinkScannerTestLease = { create };
})();
