import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentHarness } from './helpers/clinic-sim.js';

function element() {
  const listeners = new Map();
  return {
    classList: { toggle() {} },
    appendChild() {},
    setAttribute() {},
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    click(isTrusted) {
      listeners.get('click')?.({ isTrusted });
    }
  };
}

function clinic(kind = 'multiple_grid') {
  const elements = [];
  const requests = [];
  const route = {
    epoch: 'sample-epoch',
    generation: 1,
    startBy: Date.now() + 10000
  };
  const fills = [];
  const newRow = (index) => ({
    ...element(),
    isConnected: true,
    contains: () => true,
    getAttribute: () => String(index),
    querySelectorAll: () => []
  });
  const rows = Array.from({ length: 3 }, (_, index) => newRow(index));
  const newForm = () => ({
    isConnected: true,
    contains: () => true,
    querySelectorAll: () => []
  });
  let form = newForm();
  let control = { isConnected: true };
  let dateField = { isConnected: true };
  const remaining =
    kind === 'multiple_grid' ? ['first', 'second', 'third'] : ['first'];
  let nextOfferSession;
  let freeRows = rows.length;
  let receiveGrant;
  let focused = true;
  let pendingFill;
  const tokens = new Map();
  const grant = () => {
    const arrived = Promise.withResolvers();
    const response = Promise.withResolvers();
    receiveGrant = (request) => {
      tokens.set(request.captureId, request.token);
      arrived.resolve(request);
      return response.promise;
    };
    return {
      request: arrived.promise,
      approve(recordId, scannerRoute = route) {
        response.resolve({
          success: true,
          recordId,
          token: tokens.get(recordId),
          scannerRoute
        });
      },
      deny() {
        response.resolve({ success: false });
      }
    };
  };
  const {
    context,
    documentListeners,
    messageListeners,
    storageListeners,
    storageReads,
    windowListeners
  } = createContentHarness({
    MutationObserver: class {
      observe() {}
    },
    document: {
      body: element(),
      hasFocus: () => focused,
      createElement() {
        const node = { ...element(), attachShadow: element };
        elements.push(node);
        return node;
      }
    }
  });
  Object.assign(context, {
    getPanoramaAutofillForm: () => form,
    getPanoramaFormContext: () => ({ kind, ready: true }),
    getPanoramaMultiStepIndicatorKey: () => '',
    getPanoramaMultipleGridRows: () => rows,
    getPanoramaMultipleGridAgentField: () => control,
    getPanoramaDetailAgentFields: () => [control],
    getPanoramaMultipleGridRowState: (index) => ({
      agentField: control,
      dateField,
      agentText: Number(index) < rows.length - freeRows ? 'Assigned agent' : ''
    }),
    async fillReservedTrayRecord(
      recordId,
      data,
      source,
      requiredKind,
      reservation
    ) {
      assert.equal(data._vaxlinkOwner.form, form);
      assert.equal(data._vaxlinkOwner.automatic, true);
      assert.equal(data._vaxlinkOwner.scannerRoute, route);
      assert.equal(source, 'locked-resume');
      assert.equal(requiredKind, kind);
      assert.equal(reservation.recordId, recordId);
      assert.equal(reservation.token, tokens.get(recordId));
      assert.equal(reservation.reserved, true);
      if (pendingFill) {
        pendingFill.arrived.resolve();
        await pendingFill.proceed.promise;
      }
      if (!context.isPanoramaAutofillCurrent(data)) return { status: 'failed' };
      fills.push(recordId);
      assert.equal(recordId, remaining.shift());
      freeRows--;
      return kind === 'multiple_grid'
        ? { status: 'grid_added', carryToDetails: true }
        : { status: 'pending' };
    }
  });
  context.chrome.runtime.sendMessage = async (request, callback) => {
    if (request.action === 'getLockedScanResume') {
      requests.push(request);
      const sessionId = nextOfferSession || 'lock-session';
      nextOfferSession = null;
      return {
        success: true,
        sessionId,
        captureId: remaining[0],
        count: Math.min(remaining.length, request.capacity)
      };
    }
    if (request.action === 'resumeLockedScan') {
      requests.push(request);
      return receiveGrant(request);
    }
    if (request.action === 'mutateQueue') {
      requests.push(request);
      callback({ success: true });
    }
    return { success: true };
  };
  storageReads[0].callback({});
  context.initHud();
  for (const { callback } of storageReads.slice(1)) callback({});

  return {
    fills,
    grant,
    button: () =>
      elements.find(({ textContent }) => /^Resume /.test(textContent)),
    status: () =>
      elements.find(({ className }) => className === 'vl-hud-resume-status'),
    called: (action) => requests.filter((request) => request.action === action),
    active(token) {
      let reply;
      messageListeners[0](
        { action: 'isDoseReservationActive', token },
        { id: context.chrome.runtime.id },
        (result) => (reply = result)
      );
      return reply.active;
    },
    anchor() {
      let reply;
      messageListeners[0](
        { action: 'getLockedScanAnchor' },
        { id: context.chrome.runtime.id },
        (result) => {
          reply = result;
        }
      );
      return reply.anchor;
    },
    blur() {
      focused = false;
      for (const listener of windowListeners.get('blur')) listener();
    },
    focus() {
      focused = true;
      for (const listener of windowListeners.get('focus')) listener();
    },
    replaceForm() {
      form = newForm();
    },
    replaceControl() {
      control = { isConnected: true };
    },
    changeCohort() {
      nextOfferSession = 'new-lock-session';
    },
    replaceRow() {
      rows[0] = newRow(0);
    },
    edit() {
      const target = {
        closest: (selector) => (selector.startsWith('input') ? target : null)
      };
      for (const listener of documentListeners.get('input'))
        listener({ type: 'input', isTrusted: true, target });
    },
    manualUse() {
      context.beginPanoramaAutofill({}, true);
    },
    scannerState(state) {
      for (const listener of storageListeners)
        listener(
          {
            vaxlink_scanner_lock_session_v1: { newValue: { state } }
          },
          'local'
        );
    },
    pauseFill() {
      const arrived = Promise.withResolvers();
      const proceed = Promise.withResolvers();
      pendingFill = { arrived, proceed };
      return { arrived: arrived.promise, continue: () => proceed.resolve() };
    },
    assignGridRowDuring(replacement) {
      const writes = [];
      const newDate = () => ({
        isConnected: true,
        get value() {
          return writes.at(-1) || '';
        },
        set value(value) {
          writes.push(value);
        },
        focus() {
          if (replacement === 'date focus') dateField = newDate();
        },
        blur() {},
        dispatchEvent() {}
      });
      dateField = newDate();
      Object.assign(context, {
        Event,
        KeyboardEvent: Event,
        canFillPanoramaControl: () => true,
        getPanoramaAgentCandidates: () => ['MMR'],
        getPanoramaMultipleGridAgentFocusField: () => null,
        getPanoramaMultipleGridDate1Field: () => dateField,
        getPanoramaAdministeredDateTimeValues: () => ({ date: '2026/06/12' }),
        getPanoramaMultipleGridRowState: () => ({
          agentField: control,
          agentText: control.value,
          dateField,
          dateText: dateField.value
        }),
        fillField(field, value) {
          field.value = value;
          if (replacement === 'row') rows[0] = newRow(0);
          if (replacement === 'date control') dateField = newDate();
          return true;
        }
      });
      const data = context.beginPanoramaAutofill({}, true, { automatic: true });
      data._vaxlinkOwner.lockedResumeGridTarget =
        context.getLockedResumeGridTarget();
      const assign = () =>
        context.runPanoramaAutofill(data, () =>
          context.assignTrayVaccineToGrid(data)
        );
      return { assign, writes };
    },
    occupyRemainingRows() {
      freeRows = 1;
    }
  };
}

const settle = () => new Promise(setImmediate);

test('an eligible Multiple grid assigns three scans of the same lock without a click', async () => {
  const chart = clinic();
  const anchor = chart.anchor();
  let grant = chart.grant();
  for (const [index, captureId] of ['first', 'second', 'third'].entries()) {
    await settle();
    chart.focus();
    chart.focus();
    assert.equal(chart.called('resumeLockedScan').length, index + 1, captureId);
    const request = await grant.request;
    assert.equal(request.anchor, anchor);
    assert.equal(request.kind, 'multiple_grid');
    assert.equal(request.sessionId, 'lock-session');
    assert.equal(request.captureId, captureId);
    assert.equal(chart.active(request.token), true);
    const next = chart.grant();
    grant.approve(captureId);
    grant = next;
  }

  await settle();
  assert.deepEqual(chart.fills, ['first', 'second', 'third']);
  assert.equal(chart.called('resumeLockedScan').length, 3);
  assert.deepEqual(
    chart.called('getLockedScanResume').map(({ capacity }) => capacity),
    [3, 2, 1, 0]
  );
  assert.equal(chart.button(), undefined);
});

for (const failure of [
  'grant denied',
  'form replaced',
  'row replaced',
  'staff edited the chart',
  'staff started using the tray',
  'scanner relocked',
  'cohort changed',
  'rows filled'
]) {
  test(`automatic resume makes no second grant request when ${failure}`, async () => {
    const chart = clinic();
    const grant = chart.grant();
    const { token } = await grant.request;
    if (failure === 'form replaced') chart.replaceForm();
    if (failure === 'row replaced') chart.replaceRow();
    if (failure === 'staff edited the chart') chart.edit();
    if (failure === 'staff started using the tray') chart.manualUse();
    if (failure === 'scanner relocked') chart.scannerState('locked');
    if (failure === 'cohort changed') chart.changeCohort();
    if (failure === 'rows filled') chart.occupyRemainingRows();
    if (failure === 'grant denied') grant.deny();
    else grant.approve('first');
    await settle();
    chart.focus();
    await settle();

    assert.deepEqual(
      chart.fills,
      failure === 'cohort changed' ? ['first'] : []
    );
    assert.equal(chart.called('resumeLockedScan').length, 1);
    assert.deepEqual(
      chart
        .called('mutateQueue')
        .map(({ operation, payload }) => [
          operation,
          payload.id,
          payload.token,
          payload.written
        ]),
      ['grant denied', 'cohort changed'].includes(failure)
        ? []
        : [['stop_dose', 'first', token, false]]
    );
    if (
      [
        'grant denied',
        'row replaced',
        'cohort changed',
        'rows filled'
      ].includes(failure)
    ) {
      assert.equal(chart.status().hidden, false);
      assert.match(chart.status().textContent, /Immunization tray/);
    }
  });
}

test('lock state prevents a pending offer from filling until unlock', async () => {
  const chart = clinic();
  const grant = chart.grant();
  chart.scannerState('locked');
  await settle();
  assert.equal(chart.called('resumeLockedScan').length, 0);

  chart.scannerState('active');
  const request = await grant.request;
  assert.equal(request.captureId, 'first');
  grant.deny();
  await settle();
  assert.equal(chart.called('resumeLockedScan').length, 1);
});

test('a changed scanner route releases the next reserved dose without filling it', async () => {
  const chart = clinic();
  const first = chart.grant();
  await first.request;
  const second = chart.grant();
  first.approve('first');
  const request = await second.request;
  second.approve('second', { epoch: 'new-route', generation: 2 });
  await settle();

  assert.deepEqual(chart.fills, ['first']);
  assert.equal(chart.called('resumeLockedScan').length, 2);
  const [release] = chart.called('mutateQueue');
  assert.equal(release.operation, 'stop_dose');
  assert.equal(release.payload.id, 'second');
  assert.equal(release.payload.token, request.token);
});

test('a replaced row cannot receive a fill while the tray pipeline is waiting', async () => {
  const chart = clinic();
  const grant = chart.grant();
  const fill = chart.pauseFill();
  await grant.request;
  grant.approve('first');
  await fill.arrived;
  chart.replaceRow();
  fill.continue();
  await settle();
  assert.deepEqual(chart.fills, []);
  assert.equal(chart.called('resumeLockedScan').length, 1);
});

test('locked grid Date fill stays on the original controls through Panorama events', () => {
  const unchanged = clinic().assignGridRowDuring();
  assert.equal(unchanged.assign().date, '2026/06/12');
  assert.deepEqual(unchanged.writes, ['', '2026/06/12']);

  for (const replacement of ['row', 'date control']) {
    const chart = clinic().assignGridRowDuring(replacement);
    assert.equal(chart.assign(), null, replacement);
    assert.deepEqual(chart.writes, []);
  }

  const duringDateWrite = clinic().assignGridRowDuring('date focus');
  assert.throws(duringDateWrite.assign, /form changed/);
  assert.deepEqual(duringDateWrite.writes, []);
});

test('Single Immunization still waits for a trusted Resume click', async () => {
  const chart = clinic('provider_single');
  await settle();
  const button = chart.button();
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Resume 1 scan');
  button.click(false);
  assert.equal(chart.called('resumeLockedScan').length, 0);

  const grant = chart.grant();
  button.click(true);
  const request = await grant.request;
  assert.equal(request.kind, 'provider_single');
  grant.approve('first');
  await settle();
  assert.deepEqual(chart.fills, ['first']);
});

test('the locked chart stamp survives blur but changes for replaced controls or forms', () => {
  const chart = clinic();
  const original = chart.anchor();
  assert.ok(original);
  chart.blur();
  assert.equal(chart.anchor(), original);
  chart.focus();
  assert.equal(chart.anchor(), original);

  chart.replaceControl();
  const replacement = chart.anchor();
  assert.ok(replacement);
  assert.notEqual(replacement, original);

  chart.replaceForm();
  assert.notEqual(chart.anchor(), replacement);
});
