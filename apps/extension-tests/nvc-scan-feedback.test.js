import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
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
      getPanoramaFormContext: () => ({ kind: 'provider_single', ready: true }),
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

test('terminal feedback names the fields or catalogue to review and counts rendered expiry notices', () => {
  const { context } = createContentHarness();
  const routine = { innerHTML: '' };
  const warning = { innerHTML: '', querySelector: () => null };
  const events = [];
  Object.assign(context, {
    routine,
    warning,
    ensureToastHost() {},
    escapeToastHtml: (text) => text,
    setTimeout: () => 0,
    clearTimeout() {},
    playAudioCue() {},
    logAnalyticsEvent: (event) => events.push(event)
  });
  vm.runInContext(
    'toastRoutineSlot = routine; toastWarningSlot = warning;',
    context
  );
  context.showVaxlinkToast({
    _fillFeedback: 'deadline_details',
    _reviewFields: ['administration time', 'Consent for Service']
  });
  assert.match(
    routine.innerHTML,
    /Check the administration time and Consent for Service/
  );
  context.location.hostname = 'trpanoramadhir.prod.ehealthontario.ca';
  context.showVaxlinkToast({
    _fillFeedback: 'lot_not_matched',
    _lotNeedsReview: true,
    lookup_error_category: 'not_found'
  });
  assert.match(routine.innerHTML, /Lot not found in Panorama training/);
  assert.match(routine.innerHTML, /The Lot field still needs review/);
  assert.match(
    routine.innerHTML,
    /missing from the National Vaccine Catalogue/
  );
  assert.doesNotMatch(routine.innerHTML, /Resolution Coordinator/);
  context.showVaxlinkToast({ expiry_flag: 'valid' });
  context.showVaxlinkToast({ expiry_flag: 'expired' });
  context.showVaxlinkToast({ expiry_flag: 'expiring_soon' });
  assert.match(warning.innerHTML, /Expired vaccine/);
  assert.deepEqual(events, ['expiry_notice_shown', 'expiry_notice_shown']);
});
