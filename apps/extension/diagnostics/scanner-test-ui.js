export function mountScannerTest(container) {
  const card = document.createElement('section');
  card.className = 'card wide';
  card.innerHTML = `<h2>Test scanner only</h2>
    <p class="hint">Use a synthetic GS1 barcode, for example AI 10 VAXLINKTEST and AI 17 271231. During this test scans are not sent to a chart, queue, inventory, or clinical usage counters. Testing ends after one minute.</p>
    <div class="actions"><button type="button" data-start>Start scanner test</button><button type="button" class="secondary" data-stop disabled>Stop test</button></div>
    <div class="status" role="status" aria-live="polite" data-status>Scanner test is off.</div>
    <p class="hint" data-result>Bytes: 0. Frames: 0. Catalogue lookup: unavailable.</p>
    <label for="scanner-test-keyboard">Optional keyboard check</label>
    <input id="scanner-test-keyboard" autocomplete="off" spellcheck="false" placeholder="Focus here and scan synthetic barcode" disabled>
    <p class="hint">If text appears, the scanner may also be typing as a keyboard. Input is cleared immediately.</p>`;
  container.append(card);
  const start = card.querySelector('[data-start]');
  const stop = card.querySelector('[data-stop]');
  const status = card.querySelector('[data-status]');
  const result = card.querySelector('[data-result]');
  const input = card.querySelector('input');
  let sessionId = '';
  let expiresAt = 0;
  let bytes = 0;
  let frames = 0;
  let timer = null;
  const command = (action) =>
    new Promise((resolve) =>
      chrome.runtime.sendMessage(
        { target: 'scannerDaemon', action: `diagnostics.test.${action}` },
        (response) =>
          resolve(
            chrome.runtime.lastError
              ? { success: false, error: chrome.runtime.lastError.message }
              : response
          )
      )
    );
  function end(message) {
    clearInterval(timer);
    timer = null;
    sessionId = '';
    input.value = '';
    input.disabled = true;
    start.disabled = false;
    stop.disabled = true;
    status.textContent = message;
  }
  function render(data) {
    bytes = data.bytes || 0;
    frames = data.frames || 0;
    const frame = data.lastFrame;
    result.textContent = `Bytes: ${bytes}. Chunks: ${data.chunks || 0}. Frames: ${frames}. ${frame ? `Last frame: ${frame.completionReason}; parsed: ${frame.parsed ? 'yes' : 'no'}; GTIN: ${frame.hasGtin ? 'yes' : 'no'}; lot: ${frame.hasLot ? 'yes' : 'no'}; expiry: ${frame.hasExpiry ? 'yes' : 'no'}.` : bytes ? 'Waiting for a complete frame.' : 'Waiting for serial bytes.'} Catalogue lookup: unavailable.`;
    if (data.state === 'expired')
      end(
        bytes ? 'Scanner test ended.' : 'No data during the requested interval.'
      );
    if (data.state === 'paused')
      end(
        'Scanner test interrupted. Reconnect the scanner before clinical use.'
      );
  }
  start.addEventListener('click', async () => {
    start.disabled = true;
    status.textContent = 'Starting scanner test. Wait before scanning.';
    const response = await command('start');
    if (!response?.success || response.state !== 'active')
      return end(response?.error || 'Could not start scanner test.');
    sessionId = response.sessionId;
    expiresAt = response.expiresAt;
    stop.disabled = false;
    input.disabled = false;
    render(response);
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      status.textContent = `Scanner test active: ${seconds} seconds remaining.`;
      if (!seconds) {
        clearInterval(timer);
        timer = null;
        status.textContent =
          'Ending scanner test. Waiting for scanner release.';
      }
    };
    tick();
    timer = setInterval(tick, 1000);
  });
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    input.value = '';
    input.disabled = true;
    status.textContent = 'Ending scanner test. Waiting for scanner release.';
    const response = await command('stop');
    end(
      response?.success
        ? bytes
          ? 'Scanner test stopped.'
          : 'No data during the requested interval.'
        : 'Scanner test could not stop safely. Reconnect the scanner before clinical use.'
    );
  });
  input.addEventListener('input', () => {
    input.value = '';
    status.textContent =
      'Keyboard input detected. Check scanner configuration.';
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (
      message?.action === 'diagnostics.test.observation' &&
      sessionId &&
      message.sessionId === sessionId
    )
      render(message);
  });
}
