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
    'reordered notice',
    'overview',
    'notice',
    'untrusted notice',
    'stale notice',
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
      isConnected: true,
      matches: () => false,
      closest: (selector) =>
        selector.includes('immsDetails_dataTable') ? oldTable : button
    };
    const form = {
      isConnected: true,
      querySelectorAll: () => [button],
      contains: (node) =>
        node === button || (outcome !== 'wrong form' && node === overview)
    };
    button.form = form;
    const nonterminal = outcome.startsWith('reordered');
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
      getComputedStyle: () => ({ visibility: 'visible' }),
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
    let missVisible = true;
    const missSlot = {
      querySelector: (selector) =>
        missVisible && selector === '[data-vl-lot-miss]'
          ? {
              remove() {
                missVisible = false;
              }
            }
          : null
    };
    Object.assign(context, { handoff, token, missSlot });
    vm.runInContext(
      `
      gridDetailHandoff = handoff;
      toastRoutineSlot = missSlot;
      activeTrayReservations.add(token);
      toastSkippedDoseSlot = { replaceChildren(child) { this.firstElementChild = child; } };
    `,
      context
    );
    if (nonterminal) {
      rows.push({ index: '2', agent: 'hb', date });
      outgoing.entry = { dose, lot, route, log() {} };
      if (outcome === 'reordered notice') {
        select = {
          value: 'wrong',
          options: [{ text: 'WRONG', value: 'wrong' }]
        };
      }
    } else {
      owner.trayDose = dose;
      owner.unusedDoseDate = outcome === 'stale date' ? '2026/11/26' : date;
      owner.unusedDose = context
        .stopTrayDose(owner, true)
        .then((released) => (released ? records[0] : null));
      assert.equal((await owner.unusedDose)?.id, 'outgoing');
    }

    if (outcome.includes('notice')) {
      const routeCheck = Promise.withResolvers();
      let clicks = 0;
      let listener;
      const deleteAction = context.createDetailLotDelete(
        nonterminal ? { row: outgoing } : { owner }
      );
      const noticeButton = {
        addEventListener(_type, callback) {
          listener = callback;
        }
      };
      const checkRoute = context.checkPanoramaScannerRoute;
      context.checkPanoramaScannerRoute = async (delivery) => {
        await routeCheck.promise;
        return checkRoute(delivery);
      };
      button.click = () => {
        clicks += 1;
        assert.equal(handoff.navigation?.deleting, true);
      };
      if (outcome === 'notice') {
        const findNotice = missSlot.querySelector;
        missSlot.querySelector = (selector) =>
          selector === '[data-delete-detail]'
            ? noticeButton
            : findNotice(selector);
        missSlot.contains = (node) => node === noticeButton;
        context.VaxLinkNvcLotReport = {
          hasCatalogueMatch: () => false,
          makeDraft: () => ''
        };
        context.showVaxlinkToast({
          _vaxlinkOwner: owner,
          _fillFeedback: 'lot_not_matched'
        });
        assert.match(missSlot.innerHTML, /vl-toast info persistent show/);
        assert.match(missSlot.innerHTML, /data-delete-detail>Delete</);
        assert.doesNotMatch(missSlot.innerHTML, /Dismiss/);
      } else {
        context.attachDetailDelete(
          {
            querySelector: () => noticeButton,
            contains: (node) => node === noticeButton
          },
          deleteAction
        );
      }
      const pending = listener({
        currentTarget: noticeButton,
        isTrusted: outcome !== 'untrusted notice'
      });
      await new Promise(setImmediate);
      assert.equal(clicks, 0, 'wait for route verification');
      if (outcome === 'stale notice') select = {};
      routeCheck.resolve();
      await pending;
      if (outcome === 'untrusted notice' || outcome === 'stale notice') {
        assert.equal(clicks, 0, outcome);
        assert.equal(worker.storageData.has(recent), false, outcome);
        continue;
      }
      assert.equal(clicks, 1, outcome);
    } else context.startGridHandoff({ isTrusted: true, target: button });
    await context.advanceGridHandoff();
    assert.equal(
      worker.storageData.has(recent),
      false,
      'wait for a confirmed transition'
    );
    oldTable.isConnected = false;
    assert.equal(missVisible, true);
    select = {};
    position = nonterminal ? '2-of-2' : '';
    await context.advanceGridHandoff();
    await new Promise(setImmediate);
    assert.equal(missVisible, outcome === 'wrong form', outcome);

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
