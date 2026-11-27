import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  createBackgroundHarness,
  createContentHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const tray = 'multiple_inject_queue_v1';
const recent = 'vaxlink_skipped_dose_history_v1';
const lot = 'SIM-DELETE';
const date = '2026/11/27';

test('confirmed Delete archives only the exact unused scan', async () => {
  for (const outcome of [
    'reordered',
    'overview',
    'one detail',
    'wrong form',
    'stale date'
  ]) {
    const { context } = createContentHarness();
    const tab = { id: 42, url: context.location.href, active: true };
    const sender = {
      id: 'vaxlink-test',
      frameId: 0,
      documentId: 'synthetic-chart',
      url: tab.url,
      tab
    };
    const records = ['outgoing', 'keep'].map((id) => ({
      id,
      lot,
      dose_tracking: 'single_use',
      remaining_doses: 1
    }));
    const worker = createBackgroundHarness(makeTestNvcBundle(), {
      tabs: [tab],
      storage: { [tray]: records }
    });
    const token = context.crypto.randomUUID();
    const reserved = await worker.sendMessage(
      {
        action: 'mutateQueue',
        storageKey: tray,
        operation: 'reserve_dose',
        payload: { id: 'outgoing', token }
      },
      sender
    );
    assert.equal(reserved.reserved, true);
    const route = (
      await worker.sendMessage({ action: 'checkScannerChart' }, sender)
    ).scannerRoute;
    context.chrome.runtime.sendMessage = (message, reply) => {
      const result = worker.sendMessage(message, sender);
      if (reply) void result.then(reply);
      return result;
    };

    const oldTable = { id: 'form:immsDetails_dataTable', isConnected: true };
    const overview = {
      isConnected: true,
      querySelector: (selector) =>
        selector.includes('btnAddMultiple') || selector.startsWith('tbody')
          ? {}
          : null
    };
    const button = {
      id: 'form:_btnRemoveNext',
      closest: (selector) =>
        selector.includes('immsDetails_dataTable') ? oldTable : button
    };
    const form = {
      isConnected: true,
      contains: (node) =>
        node === button || (outcome !== 'wrong form' && node === overview)
    };
    const nonterminal = outcome === 'reordered';
    const initialStep =
      outcome === 'one detail' ? '1-of-1' : nonterminal ? '2-of-3' : '2-of-2';
    let position = initialStep;
    let select = {};
    const notices = [];
    Object.assign(context, {
      getPanoramaAutofillForm: () => (position ? form : null),
      getPanoramaFormContext: () =>
        position
          ? { kind: 'multiple_detail', ready: true }
          : { kind: 'unknown' },
      getPanoramaMultiStepIndicatorKey: () => position,
      getPanoramaCurrentAgentSelectionText: () =>
        position === initialStep ? 'MMR' : 'HPV',
      getPanoramaAdministeredDateTimeFields: () => ({
        dateField: { value: date }
      }),
      getPanoramaLotWidget: () => ({ select }),
      isVisible: () => true,
      setTimeout: () => 1,
      clearTimeout() {},
      ensureToastHost() {}
    });
    context.document.getElementById = (id) =>
      id === oldTable.id ? overview : null;
    context.document.createElement = () => ({
      setAttribute() {},
      querySelector: () => null,
      set innerHTML(value) {
        notices.push(value);
      }
    });
    const owner = context.beginPanoramaAutofill({})._vaxlinkOwner;
    const dose = {
      recordId: 'outgoing',
      token,
      record: records[0],
      owner,
      reserved: true
    };
    const outgoing = { index: '0', agent: 'mmr', date };
    const kept = { index: '1', agent: 'hpv', date };
    const rows = outcome === 'one detail' ? [outgoing] : [outgoing, kept];
    const handoff = {
      rows,
      deletedRows: [],
      form,
      url: tab.url,
      step: 1,
      observer: { disconnect() {} }
    };
    Object.assign(context, { handoff, token });
    vm.runInContext(
      `
      gridDetailHandoff = handoff;
      activeTrayReservations.add(token);
      toastSkippedDoseSlot = { replaceChildren(child) { this.firstElementChild = child; } };
    `,
      context
    );
    if (nonterminal) {
      rows.push({ index: '2', agent: 'hb', date });
      outgoing.entry = { dose, lot, route, log() {} };
    } else {
      owner.trayDose = dose;
      owner.unusedDoseDate = outcome === 'stale date' ? '2026/11/26' : date;
      owner.unusedDose = context
        .stopTrayDose(owner, true)
        .then((released) => (released ? records[0] : null));
      assert.equal((await owner.unusedDose)?.id, 'outgoing');
    }

    context.startGridHandoff({ isTrusted: true, target: button });
    await context.advanceGridHandoff();
    assert.equal(
      worker.storageData.has(recent),
      false,
      'wait for a confirmed transition'
    );
    oldTable.isConnected = false;
    select = {};
    position = nonterminal ? '2-of-2' : '';
    await context.advanceGridHandoff();
    await new Promise(setImmediate);

    const removed = outcome !== 'wrong form' && outcome !== 'stale date';
    assert.deepEqual(
      Array.from(worker.storageData.get(tray), ({ id }) => id),
      removed ? ['keep'] : ['outgoing', 'keep'],
      outcome
    );
    assert.deepEqual(
      Array.from(worker.storageData.get(recent) || [], ({ id }) => id),
      removed ? ['outgoing'] : [],
      outcome
    );
    if (removed) assert.match(notices.at(-1), /Unused scan removed from tray/);
  }
});
