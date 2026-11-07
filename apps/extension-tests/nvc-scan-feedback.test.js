import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../extension/shared/gs1-parser.js';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const productionFunction = (name) => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `Missing production function: ${name}`);
  return match[0];
};

test('failed chart fill still shows the NVC failure and retains barcode fields', async () => {
  for (const error of ['NVC catalogue is unavailable', 'Lot not found in the NVC catalogue']) {
    const slot = { innerHTML: '' };
    let fillPayload;
    const context = vm.createContext({
      console,
      chrome: { runtime: { lastError: null, sendMessage: (_request, done) => done({ error }) } },
      isHandsFreeSupportedPage: () => true,
      handleVaxlinkCommand: () => false,
      lastHandledScanValue: '', lastHandledScanAt: 0,
      activeWorkflowMode: 'single', adminDateTimeAutofillEnabled: false,
      vlog() {}, logAnalyticsEvent() {}, playAudioCue() {}, ensureToastHost() {},
      parseGS1BarcodeFromScanner: globalThis.VaxLinkGS1Parser.parseGS1Barcode,
      getExpiryStatus: () => ({ flag: 'valid' }),
      getQueueStorageKeyForWorkflow: () => null,
      autoFillTelus: (data) => { fillPayload = data; return { status: 'failed' }; },
      isAutofillSuccess: () => false, isAutofillPending: () => false,
      toastRoutineSlot: slot, toastDismissTimer: null,
      setTimeout: () => 0, clearTimeout() {},
      escapeToastHtml: (text) => text
    });
    vm.runInContext([
      productionFunction('lookupVaccineInfoByLot'),
      productionFunction('showVaxlinkToast'),
      productionFunction('handleHandsFreeScan')
    ].join('\n'), context);
    const result = await context.handleHandsFreeScan('01001234567890121727123110TRAININGLOT');
    assert.equal(result.success, false);
    assert.equal(fillPayload.lot, 'TRAININGLOT');
    assert.equal(fillPayload.gtin, '00123456789012');
    assert.ok(fillPayload.expiry);
    assert.ok(slot.innerHTML.includes(error));
    assert.match(slot.innerHTML, /Vaccine details are incomplete/);
  }
});
