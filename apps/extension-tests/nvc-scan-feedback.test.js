import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentHarness } from './helpers/clinic-sim.js';

test('failed chart fill still shows the NVC failure and retains barcode fields', async () => {
  for (const error of [
    'NVC catalogue is unavailable',
    'Lot not found in the NVC catalogue'
  ]) {
    const { context } = createContentHarness();
    const form = { isConnected: true };
    const notices = [];
    let fillPayload;
    Object.assign(context, {
      getPanoramaAutofillForm: () => form,
      getPanoramaMultiStepIndicatorKey: () => '',
      playAudioCue() {},
      showVaxlinkToast: (data) => notices.push(data),
      autoFillPanorama: (data) => {
        fillPayload = data;
        return { status: 'failed' };
      }
    });
    context.chrome.runtime.sendMessage = (request, done) => {
      done(request.action === 'lookupVaccineInfo' ? { error } : {});
    };
    const result = await context.handleHandsFreeScan(
      '01001234567890121799123110TRAININGLOT'
    );
    assert.equal(result.success, false);
    assert.equal(fillPayload.lot, 'TRAININGLOT');
    assert.equal(fillPayload.gtin, '00123456789012');
    assert.ok(fillPayload.expiry);
    assert.equal(notices[0].lookup_error, error);
  }
});
