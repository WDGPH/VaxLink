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

function clinic() {
  const elements = [];
  const requests = [];
  const route = { epoch: 'sample-epoch', startBy: Date.now() + 10000 };
  const fills = [];
  const rows = Array.from({ length: 3 }, (_, index) => ({
    ...element(),
    getAttribute: () => String(index)
  }));
  let form = { isConnected: true };
  let control = {};
  let remaining = ['first', 'second', 'third'];
  let sessionId = 'lock-session';
  let freeRows = rows.length;
  let receiveGrant;
  let focused = true;
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
      approve(recordId) {
        response.resolve({
          success: true,
          recordId,
          token: tokens.get(recordId),
          scannerRoute: route
        });
      },
      deny() {
        response.resolve({ success: false });
      }
    };
  };
  const { context, messageListeners, storageReads, windowListeners } =
    createContentHarness({
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
    getPanoramaFormContext: () => ({ kind: 'multiple_grid', ready: true }),
    getPanoramaMultiStepIndicatorKey: () => '',
    getPanoramaMultipleGridRows: () => rows,
    getPanoramaMultipleGridAgentField: () => control,
    getPanoramaMultipleGridRowState: (index) => ({
      agentText: Number(index) < rows.length - freeRows ? 'Assigned agent' : ''
    }),
    fillReservedTrayRecord(recordId, data, source, kind, reservation) {
      assert.equal(data._vaxlinkOwner.form, form);
      assert.equal(data._vaxlinkOwner.automatic, true);
      assert.equal(data._vaxlinkOwner.scannerRoute, route);
      assert.equal(source, 'locked-resume');
      assert.equal(kind, 'multiple_grid');
      assert.equal(reservation.recordId, recordId);
      assert.equal(reservation.token, tokens.get(recordId));
      assert.equal(reservation.reserved, true);
      fills.push(recordId);
      assert.equal(recordId, remaining.shift());
      freeRows--;
      return { status: 'grid_added', carryToDetails: true };
    }
  });
  context.chrome.runtime.sendMessage = async (request, callback) => {
    if (request.action === 'getLockedScanResume') {
      requests.push(request);
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
    },
    replaceForm() {
      form = { isConnected: true };
    },
    replaceControl() {
      control = {};
    },
    changeCohort() {
      sessionId = 'new-lock-session';
    },
    occupyRemainingRows() {
      freeRows = 1;
    }
  };
}

const settle = () => new Promise(setImmediate);

test('one trusted Resume click assigns three scans of the same lock to the available rows', async () => {
  const chart = clinic();
  await settle();
  const button = chart.button();
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Resume 3 scans');
  button.click(false);
  assert.equal(chart.called('resumeLockedScan').length, 0);

  const anchor = chart.anchor();
  let grant = chart.grant();
  button.click(true);
  assert.equal(button.disabled, true);
  for (const [index, captureId] of ['first', 'second', 'third'].entries()) {
    await settle();
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
  assert.equal(button.disabled, false);
  assert.equal(button.hidden, true);
});

for (const failure of [
  'grant denied',
  'form replaced',
  'cohort changed',
  'rows filled'
]) {
  test(`Resume makes no second grant request when ${failure}`, async () => {
    const chart = clinic();
    await settle();
    const grant = chart.grant();
    chart.button().click(true);
    const { token } = await grant.request;
    if (failure === 'form replaced') chart.replaceForm();
    if (failure === 'cohort changed') chart.changeCohort();
    if (failure === 'rows filled') chart.occupyRemainingRows();
    if (failure === 'grant denied') grant.deny();
    else grant.approve('first');
    await settle();

    assert.deepEqual(
      chart.fills,
      ['cohort changed', 'rows filled'].includes(failure) ? ['first'] : []
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
      failure === 'form replaced' ? [['stop_dose', 'first', token, false]] : []
    );
    assert.equal(chart.button().disabled, false);
    if (failure !== 'form replaced') {
      assert.equal(chart.status().hidden, false);
      assert.match(chart.status().textContent, /Immunization tray/);
    }
  });
}

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
