import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  createBackgroundHarness,
  createContentHarness,
  deliverScannerScanToChart,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const liveProfile = 'zebra-ds8178-ssi-live';
const scannerHost = {
  id: 'vaxlink-test',
  url: 'chrome-extension://vaxlink-test/scanner-daemon.html'
};

function capture(
  harness,
  rawText,
  profileId = liveProfile,
  sender = scannerHost
) {
  return harness.sendMessage(
    {
      action: 'scannerScanCaptured',
      scan: { rawText, source: 'web-serial', device: { profileId } },
      feedbackToken: `capture-${rawText}`
    },
    sender
  );
}

test('live SSI reports recognition, attention and expiry without a chart or a catalogue download', async () => {
  const bundle = makeTestNvcBundle();
  const lots = bundle.entry[1].resource.concept;
  const addLot = (code, extra = {}) => {
    const { property, ...fields } = extra;
    lots.push({
      ...lots[0],
      code,
      property: [{ code: 'lotNumber', valueString: code }, ...(property || [])],
      ...fields
    });
  };
  addLot('NOIDENTITY', { extension: [] });
  addLot('EXPIREDINCOMPLETE', {
    extension: [],
    property: [{ code: 'expiryDate', valueDateTime: '2001-01-01T00:00:00Z' }]
  });
  addLot('EXPIREDNVC', {
    property: [{ code: 'expiryDate', valueDateTime: '2001-01-01T00:00:00Z' }]
  });
  addLot('BADDATE', {
    property: [{ code: 'expiryDate', valueDateTime: '2099-02-30' }]
  });
  const cases = [
    ['10TESTLOT', 'works'],
    ['10MISSING', 'attention'],
    ['10NOIDENTITY', 'attention'],
    ['10BADDATE', 'attention'],
    ['1799123110EXPIREDNVC', 'expired'],
    ['1799123110EXPIREDINCOMPLETE', 'expired'],
    ['1701010110MISSING', 'expired'],
    ['17991231', 'attention'],
    ['17010101', 'expired'],
    ['not a barcode', 'attention']
  ];
  for (const mode of ['inventory', 'immunization']) {
    const feedback = [];
    const harness = createBackgroundHarness(bundle, {
      storage: { vaxlink_workflow_mode_v1: mode },
      runtimeSendMessage(message, reply) {
        if (message.action === 'scannerDaemon.feedback') feedback.push(message);
        reply({ success: true });
      }
    });
    for (const [rawText] of cases) {
      const captureResult = await capture(harness, rawText);
      if (rawText === 'not a barcode')
        assert.equal(captureResult.response?.status, 'parse_error');
    }
    assert.deepEqual(
      feedback.map(({ target, feedbackToken, result }) => [
        target,
        feedbackToken,
        result
      ]),
      cases.map(([rawText, result]) => [
        'scannerDaemon',
        `capture-${rawText}`,
        result
      ])
    );
    assert.equal(harness.offscreenCreations.length, 0);
    assert.equal(harness.tabMessages.length, 0);
  }

  const feedback = [];
  const offline = createBackgroundHarness(null, {
    storage: { vaxlink_workflow_mode_v1: 'inventory' },
    fetch() {
      assert.fail('Feedback must never wait for a catalogue download');
    },
    runtimeSendMessage(message, reply) {
      if (message.action === 'scannerDaemon.feedback')
        feedback.push(message.result);
      reply({ success: true });
    }
  });
  await capture(offline, '10TESTLOT');
  await capture(offline, 'VAXLINK:INVENTORY');
  await capture(offline, '10TESTLOT', 'generic-usb-cdc');
  await capture(offline, '10TESTLOT', 'zebra-ds8178-usb-cdc');
  await capture(offline, '10TESTLOT', 'zebra-ds8178-cdc-long-range');
  const rejected = await capture(offline, '10TESTLOT', liveProfile, {
    ...scannerHost,
    url: 'chrome-extension://vaxlink-test/popup.html'
  });
  assert.equal(rejected.success, false);
  assert.deepEqual(feedback, ['attention']);
});

test('live SSI feedback finishes while chart routing is waiting, even if the sound fails', async () => {
  let releaseChart;
  let chartStarted;
  let soundResult;
  const chartWaiting = new Promise((resolve) => {
    chartStarted = resolve;
  });
  const feedback = new Promise((resolve) => {
    soundResult = resolve;
  });
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [{ id: 1, active: true }],
    delayTabMessage(_tabId, message, reply) {
      if (message.action !== 'getPanoramaIntegration') return false;
      releaseChart = reply;
      chartStarted();
      return true;
    },
    runtimeSendMessage(message, reply) {
      if (message.action === 'scannerDaemon.feedback')
        soundResult(message.result);
      reply({ success: false });
    }
  });
  const arrival = capture(harness, '10TESTLOT');
  await chartWaiting;
  assert.equal(await feedback, 'works');
  assert.equal(harness.storageData.has('multiple_inject_queue_v1'), false);
  releaseChart();
  const result = await arrival;
  assert.equal(result.queuedToWorkflow, true);
  assert.equal(
    harness.storageData.get('multiple_inject_queue_v1')[0].lot,
    'TESTLOT'
  );
});

test('a fast expiry result cannot sound before the preceding live scan', async () => {
  const feedback = [];
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { vaxlink_workflow_mode_v1: 'inventory' },
    runtimeSendMessage(message, reply) {
      if (message.action === 'scannerDaemon.feedback')
        feedback.push(message.result);
      reply({ success: true });
    }
  });
  await Promise.all([
    capture(harness, '10TESTLOT'),
    capture(harness, '1701010110MISSING')
  ]);
  assert.deepEqual(feedback, ['works', 'expired']);
});

test('failed chart fill still shows the NVC failure and retains barcode fields', async () => {
  for (const error of [
    'NVC catalogue is unavailable',
    'Lot not found in the NVC catalogue'
  ]) {
    const chart = createContentHarness();
    const { context, storageReads } = chart;
    storageReads
      .find(({ keys }) => keys.includes('vaxlink_workflow_mode_v1'))
      .callback({});
    const form = { isConnected: true };
    const notices = [];
    let fillPayload;
    Object.assign(context, {
      getPanoramaAutofillForm: () => form,
      getPanoramaFormContext: () => ({ kind: 'provider_single', ready: true }),
      getPanoramaAgentCandidates: () => ['Training vaccine'],
      getPanoramaMultiStepIndicatorKey: () => '',
      playAudioCue() {},
      showVaxlinkToast: (data) => notices.push(data),
      autoFillPanorama: (data) => {
        fillPayload = data;
        return { status: 'failed' };
      }
    });
    context.chrome.runtime.sendMessage = (request, done) => {
      const response =
        request.action === 'lookupVaccineInfo' ? { error } : { success: true };
      if (done) done(response);
      return Promise.resolve(response);
    };
    const result = await deliverScannerScanToChart(
      chart,
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
  const carry = { innerHTML: '', querySelector: () => null };
  const events = [];
  Object.assign(context, {
    routine,
    warning,
    carry,
    ensureToastHost() {},
    escapeToastHtml: (text) => text,
    setTimeout: () => 0,
    clearTimeout() {},
    playAudioCue() {},
    logAnalyticsEvent: (event) => events.push(event)
  });
  vm.runInContext(
    'toastRoutineSlot = routine; toastWarningSlot = warning; toastCarrySlot = carry;',
    context
  );
  context.showVaxlinkToast({
    _fillFeedback: 'deadline_details',
    _reviewFields: ['time', 'consent']
  });
  assert.match(
    routine.innerHTML,
    /Check the administration time and Consent for Service/
  );
  context.location.hostname = 'trpanoramadhir.prod.ehealthontario.ca';
  context.showVaxlinkToast({
    _fillFeedback: 'lot_not_matched',
    _lotNeedsReview: true,
    lot: 'TRAIN&LOT',
    lookup_error_category: 'not_found'
  });
  assert.match(routine.innerHTML, /Lot not found in Panorama training/);
  assert.match(routine.innerHTML, /Check the Agent and Lot in Vaccine Details/);
  assert.match(
    routine.innerHTML,
    /missing from the National Vaccine Catalogue/
  );
  assert.doesNotMatch(routine.innerHTML, /Resolution Coordinator/);
  const draft = (slot = routine) =>
    new URL(
      slot.innerHTML.match(/href="(mailto:[^"]+)"/)[1].replaceAll('&amp;', '&')
    );
  assert.equal(draft().pathname, 'NVC-CNV@phac-aspc.gc.ca');
  const catalogueMatch = {
    lot: 'TRAIN&LOT',
    tradename: 'Training vaccine',
    nvc_lot_matched: true,
    nvc_catalogue_version: '1.138'
  };
  for (const training of [true, false]) {
    context.location.hostname = training
      ? 'trpanoramadhir.prod.ehealthontario.ca'
      : 'panorama.prod.ehealthontario.ca';
    for (const multiple of [true, false]) {
      const slot = multiple ? carry : routine;
      context.showVaxlinkToast({
        ...catalogueMatch,
        _vaxlinkOwner: {
          kind: multiple ? 'multiple_detail' : 'provider_single'
        },
        _fillFeedback: training ? 'lot_not_matched' : 'funding_exhausted',
        _doseKept: multiple
      });
      assert.match(
        slot.innerHTML,
        /vl-toast-title">Lot not found in (Panorama training|either funding category)/
      );
      assert.equal(slot.innerHTML.includes('Panorama training'), training);
      assert.equal(
        slot.innerHTML.includes('Draft email to Panorama support'),
        !training
      );
      assert.equal(slot.innerHTML.includes('mailto:'), !training);
      assert.equal(
        slot.innerHTML.includes('choose Delete in Panorama'),
        multiple
      );
      assert.equal(
        slot.innerHTML.includes('Dose is still in the Immunization tray.'),
        multiple
      );
      if (!training) {
        assert.equal(draft(slot).pathname, '');
        assert.equal(
          draft(slot).searchParams.get('cc'),
          'innovation@wdgpublichealth.ca'
        );
      }
    }
  }
  context.showVaxlinkToast({
    ...catalogueMatch,
    _fillFeedback: 'deadline_details'
  });
  assert.doesNotMatch(routine.innerHTML, /mailto:/);
  context.showVaxlinkToast({
    lot: 'TRAIN',
    _fillFeedback: 'lot_not_matched',
    lookup_error_category: 'unavailable'
  });
  assert.doesNotMatch(routine.innerHTML, /mailto:/);
  context.showVaxlinkToast({ expiry_flag: 'valid' });
  context.showVaxlinkToast({ expiry_flag: 'expired' });
  context.showVaxlinkToast({ expiry_flag: 'expiring_soon' });
  assert.match(warning.innerHTML, /Expired vaccine/);
  assert.deepEqual(events, ['expiry_notice_shown', 'expiry_notice_shown']);

  const routineBefore = routine.innerHTML;
  const carried = { _vaxlinkOwner: { gridDetail: {} } };
  context.showVaxlinkToast({ ...carried, tradename: 'Carried vaccine' });
  assert.equal(routine.innerHTML, routineBefore);
  context.showVaxlinkToast({
    ...carried,
    lookup_error: 'Catalogue unavailable'
  });
  assert.match(routine.innerHTML, /Catalogue unavailable/);
  context.showVaxlinkToast({ ...carried, expiry_flag: 'expiring_soon' });
  assert.match(routine.innerHTML, /vl-toast expiring/);
});
