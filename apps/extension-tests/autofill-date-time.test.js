process.env.TZ = 'America/Toronto';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  createContentHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const legacyKey = 'vaxlink_administered_datetime_autofill_v1';
const dateKey = 'vaxlink_administered_date_autofill_v1';
const timeKey = 'vaxlink_administered_time_autofill_v1';

function fixture(settings = {}, bounded = false) {
  const clock = { now: '2026-06-12T03:58:00Z', elapsed: 0 };
  const timers = [];
  const runTimer = () => {
    timers.sort((a, b) => a.time - b.time);
    const timer = timers.shift();
    assert.ok(timer, 'a pending check is required');
    clock.elapsed = timer.time;
    timer.callback();
  };
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock.now]));
    }
    static now() {
      return Date.parse(clock.now);
    }
  }
  const { context, storageReads, storageListeners, windowListeners } =
    createContentHarness({
      Date: ClockDate,
      ...(bounded && {
        performance: { now: () => clock.elapsed },
        setTimeout(callback, delay) {
          const timer = { time: clock.elapsed + delay, callback };
          timers.push(timer);
          return timer;
        },
        clearTimeout(timer) {
          if (timers.includes(timer)) timers.splice(timers.indexOf(timer), 1);
        }
      })
    });
  const fields = {
    date: { value: 'staff date' },
    time: { value: 'staff time' }
  };
  const form = { isConnected: true, querySelectorAll: () => [] };
  const writes = [];
  let selectedLot;
  // Use the production fill entry point, settings, timestamp and date/time
  // writers. Replace only Panorama's widgets and asynchronous lot scheduler.
  Object.assign(context, {
    getPanoramaAutofillForm: () => form,
    getPanoramaFormContext: () => ({ kind: 'provider_single' }),
    getPanoramaMultiStepIndicatorKey: () => '',
    isPanoramaImmunizationPage: () => true,
    getPanoramaFundedRadioValue: () => 'SHOW_ALL',
    getPanoramaLotWidget: () => null,
    getPanoramaCurrentAgentSelectionText: () => '',
    hasPanoramaAgentSelection: () => false,
    tryFillPanoramaAgent: () => true,
    tryFillPanoramaLot(lot) {
      selectedLot = lot;
      return true;
    },
    hasPanoramaLotSelection: (lot) => lot === selectedLot,
    ...(!bounded && {
      schedulePanoramaLotOrTradeSelection(data) {
        context.runPanoramaAutofill(data, () => {
          context.tryFillPanoramaLot(data.lot);
          context.fillPanoramaDeferredDetailFields(data);
        });
      }
    }),
    canFillPanoramaControl: () => true,
    isVisible: () => true,
    getFields: (selectors) =>
      selectors.some((s) => s.includes('dateInput_input'))
        ? [fields.date]
        : selectors.some((s) => s.includes('timeInput:timeInput'))
          ? [fields.time]
          : [],
    fillPanoramaMaskedTextInput(field, value) {
      field.value = value;
      writes.push(value);
      return true;
    }
  });
  storageReads[0].callback({
    vaxlink_reason_consent_autofill_v1: false,
    ...settings
  });
  return {
    context,
    clock,
    fields,
    writes,
    runTimer,
    windowListeners,
    change(key, value) {
      storageListeners.forEach((listener) =>
        listener({ [key]: { newValue: value } }, 'local')
      );
    },
    fill(data) {
      const owned = context.beginPanoramaAutofill(data);
      assert.equal(context.autoFillPanorama(owned).status, 'pending');
      return owned;
    }
  };
}

test('date and time switches preserve legacy choices and leave disabled fields untouched', () => {
  for (const [settings, date, time] of [
    [{}, true, true],
    [{ [legacyKey]: false }, false, false],
    [{ [legacyKey]: true }, true, true],
    [{ [legacyKey]: false, [dateKey]: true }, true, false],
    [{ [legacyKey]: false, [timeKey]: true }, false, true],
    [{ [dateKey]: true, [timeKey]: false }, true, false],
    [{ [dateKey]: false, [timeKey]: true }, false, true]
  ]) {
    const f = fixture(settings);
    if (date) f.fields.date.value = '';
    if (time) f.fields.time.value = '';
    const data = f.fill({ lot: 'LOT' });
    assert.equal(f.fields.date.value, date ? '2026/06/11' : 'staff date');
    assert.equal(f.fields.time.value, time ? '23:58' : 'staff time');
    assert.equal(f.context.hasPanoramaDeferredDetailFieldsFilled(data), true);
    assert.equal(f.writes.length, Number(date) + Number(time));
  }
  const f = fixture({ [legacyKey]: false });
  for (const [key, value, date, time] of [
    [timeKey, true, false, true],
    [dateKey, true, true, true],
    [timeKey, false, true, false],
    [legacyKey, true, true, false]
  ]) {
    f.change(key, value);
    const values = f.context.getPanoramaAdministeredDateTimeValues(
      f.fill({ lot: 'LOT' })
    );
    assert.equal(!!values.date, date);
    assert.equal(!!values.time, time);
  }
});

test('live and old tray fills use fill time, keep it through retries, and renew it for each use', () => {
  for (const fromTray of [false, true]) {
    const f = fixture();
    const record = Object.freeze({
      lot: 'LOT',
      scanned_at: '2020-01-01T12:00:00Z',
      administered_at: '2020-01-01T12:00:00Z'
    });
    const payload = fromTray
      ? f.context.buildAutofillPayloadFromQueueRecord(record)
      : { ...record };
    // Ownership can begin before an awaited lookup. Capture time only when
    // vaccine fields start filling, after that lookup and local midnight.
    f.fields.date.value = f.fields.time.value = '';
    const owned = f.context.beginPanoramaAutofill(payload);
    f.clock.now = '2026-06-12T04:01:00Z';
    assert.equal(f.context.autoFillPanorama(owned).status, 'pending');
    assert.equal(f.fields.date.value, '2026/06/12');
    assert.equal(f.fields.time.value, '00:01');
    f.clock.now = '2026-06-13T04:04:00Z';
    f.fields.date.value = f.fields.time.value = '';
    f.context.runPanoramaAutofill(owned, () =>
      f.context.fillPanoramaDeferredDetailFields(owned)
    );
    assert.equal(f.fields.date.value, '2026/06/12');
    assert.equal(f.fields.time.value, '00:01');
    const writes = f.writes.length;
    f.context.runPanoramaAutofill(owned, () =>
      f.context.fillPanoramaDeferredDetailFields(owned)
    );
    assert.equal(f.writes.length, writes, 'correct values are not rewritten');
    f.fields.date.value = f.fields.time.value = '';
    f.fill(
      fromTray
        ? f.context.buildAutofillPayloadFromQueueRecord(record)
        : { ...record }
    );
    assert.equal(f.fields.date.value, '2026/06/13');
    assert.equal(f.fields.time.value, '00:04');
    assert.equal(record.scanned_at, '2020-01-01T12:00:00Z');
  }
});

test('multiple grid uses the current date only when date autofill is enabled and the cell is empty', () => {
  for (const date of [true, false]) {
    for (const existing of ['', 'staff date']) {
      const f = fixture({ [dateKey]: date, [timeKey]: true });
      Object.assign(f.context, {
        getPanoramaMultipleGridRowState: () => ({
          agentText: 'chosen',
          dateText: existing
        }),
        getPanoramaMultipleGridDate1Field: () => f.fields.date
      });
      f.fields.date.value = existing;
      const payload = f.context.buildAutofillPayloadFromQueueRecord({
        scanned_at: '2020-01-01T12:00:00Z'
      });
      f.context.fillPanoramaMultipleGridRow(0, payload);
      assert.equal(f.fields.date.value, existing || (date ? '2026/06/11' : ''));
      assert.equal(f.fields.time.value, 'staff time');
    }
  }
});

test('prefilled Date and Time satisfy the watcher and remain untouched', () => {
  const f = fixture();
  f.fields.date.value = '2026/05/01';
  f.fields.time.value = '09:10';
  const data = f.fill({ lot: 'LOT' });
  assert.equal(f.context.hasPanoramaDeferredDetailFieldsFilled(data), true);
  assert.deepEqual(f.writes, []);
  f.fields.time.value = '';
  f.context.runPanoramaAutofill(data, () =>
    f.context.fillPanoramaDeferredDetailFields(data)
  );
  assert.equal(f.fields.date.value, '2026/05/01');
  assert.equal(f.fields.time.value, '23:58');
});

test('date already set by Panorama during the Agent event survives grid entry', () => {
  const f = fixture();
  let agentText = '';
  f.fields.date.value = '';
  Object.assign(f.context, {
    getPanoramaMultipleGridRowState: () => ({
      agentText,
      dateText: f.fields.date.value
    }),
    fillPanoramaMultipleGridAgent() {
      agentText = 'MMR';
      f.fields.date.value = '2026/05/01';
      return true;
    },
    getPanoramaMultipleGridDate1Field: () => f.fields.date
  });
  assert.equal(f.context.fillPanoramaMultipleGridRow(0, { name: 'MMR' }), true);
  assert.equal(f.fields.date.value, '2026/05/01');
  assert.deepEqual(f.writes, []);
});

test('an explicit reserved dose survives popup focus and a late Time repair uses it just once', async () => {
  const f = fixture({}, true);
  const key = 'multiple_inject_queue_v1';
  const received = [];
  let start;
  let release;
  const reservationStarted = new Promise((resolve) => {
    start = resolve;
  });
  const worker = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { [key]: [{ id: 'counted', lot: 'LOT', remaining_doses: 2 }] },
    delayStorageSet(values, resume) {
      if (!(key in values) || release) return false;
      release = resume;
      start();
      return true;
    }
  });
  const url = f.context.location.href;
  f.context.chrome.runtime.sendMessage = (message, reply) => {
    if (!reply) return;
    if (message.action === 'mutateQueue') received.push(message);
    void worker
      .sendMessage(message, {
        id: 'vaxlink-test',
        frameId: 0,
        documentId: 'owned-chart',
        url,
        tab: { id: 44, url }
      })
      .then(reply);
  };
  f.context.getPanoramaFundedRadioValue = () => 'PUBLICLY_FUNDED';
  f.context.getPanoramaFormContext = () => ({
    kind: 'provider_single',
    ready: true
  });
  f.context.showVaxlinkToast = () => {};
  f.fields.time.value = '';
  const contextToken = f.context.getScannerDeliveryContext(
    'provider_single',
    true
  );
  const use = f.context.useTrayVaccine('counted', contextToken);
  await reservationStarted;
  f.context.document.hasFocus = () => false;
  f.windowListeners.get('blur').forEach((listener) => listener());
  release();

  const outcome = await use;
  assert.equal(outcome.status, 'pending');
  assert.equal(outcome.reason, 'waiting_for_required_selection');
  const row = () => worker.storageData.get(key)[0];
  const token = received[0].payload.token;
  assert.equal(row().dose_reservations[0].token, token);
  assert.equal(row().remaining_doses, 2);
  for (let attempt = 0; attempt < 8 && row().remaining_doses === 2; attempt++) {
    f.runTimer();
    await new Promise(setImmediate);
  }
  assert.equal(row().remaining_doses, 1);
  assert.equal(row().dose_reservations, undefined);

  f.fields.time.value = '';
  f.runTimer();
  assert.equal(f.fields.time.value, '23:58');
  assert.equal(row().remaining_doses, 1);
  assert.deepEqual(
    received
      .filter(({ operation }) => operation === 'consume')
      .map(({ payload }) => payload.token),
    [token]
  );
});
