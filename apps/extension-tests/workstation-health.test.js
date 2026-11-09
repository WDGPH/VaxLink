import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeWorkstationHealth,
  loadWorkstationHealth
} from '../extension/workstation-health.js';

test('health descriptions distinguish cached capture, degraded NVC and stale chart', () => {
  const result = describeWorkstationHealth({
    scanner: {
      state: 'connected',
      captureSource: 'cached',
      lastCaptureAt: '2026-11-07T12:00:00Z'
    },
    nvc: { state: 'degraded' },
    chart: { state: 'stale' }
  });
  assert.match(result.scanner, /does not confirm/);
  assert.match(result.capture, /Cached observation/);
  assert.match(result.nvc, /previous download/);
  assert.match(result.chart, /Reload it when safe/);
});

test('unknown or unexpected values do not appear in the health view', () => {
  const secret = '<patient value>';
  const result = describeWorkstationHealth({
    scanner: { state: secret, captureSource: secret },
    nvc: { state: secret },
    chart: { state: secret }
  });
  assert.ok(Object.values(result).every((value) => !value.includes(secret)));
  assert.match(result.chart, /could not be checked/);
});

test('health request uses only the selected tab and fails safely', async () => {
  let request;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        request = message;
        throw new Error('unavailable');
      }
    }
  };
  try {
    const result = await loadWorkstationHealth(7);
    assert.deepEqual(request, { action: 'getWorkstationHealth', tabId: 7 });
    assert.match(result.scanner, /unknown/);
    request = null;
    await loadWorkstationHealth(NaN);
    assert.equal(request, null);
  } finally {
    delete globalThis.chrome;
  }
});
