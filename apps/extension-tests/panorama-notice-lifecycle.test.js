import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createContentHarness } from './helpers/clinic-sim.js';

test('a detail Lot notice follows equivalent controls on the same detail', async () => {
  for (const change of [
    'equivalent',
    'changed lot',
    'changed agent',
    'takeover'
  ]) {
    const { context } = createContentHarness();
    const form = { isConnected: true };
    let position = '1-of-2';
    let agent = 'MMR';
    let select = { value: 'original' };
    const clicks = [];
    let native = { click: () => clicks.push('original') };
    let refresh;
    let listener;
    let noticeButton;
    const slot = {
      get innerHTML() {
        return this.html;
      },
      set innerHTML(html) {
        this.html = html;
        noticeButton = {
          addEventListener(_event, callback) {
            listener = callback;
          }
        };
      },
      querySelector(selector) {
        if (
          selector === '[data-delete-detail]' &&
          this.html?.includes('data-delete-detail')
        )
          return noticeButton;
        if (
          selector === '[data-vl-lot-miss]' &&
          this.html?.includes('data-vl-lot-miss')
        )
          return {};
        return null;
      },
      contains: (node) => node === noticeButton,
      replaceChildren() {
        this.innerHTML = '';
      }
    };
    const owner = {
      kind: 'multiple_detail',
      form,
      url: context.location.href,
      step: position,
      detailAgent: 'mmr',
      scannerRoute: {},
      cancelled: true
    };
    context.document.body = {};
    Object.assign(context, {
      owner,
      slot,
      ensureToastHost() {},
      escapeToastHtml: (text) => text,
      getPanoramaFormContext: () => ({ kind: 'multiple_detail', ready: true }),
      getPanoramaAutofillForm: () => form,
      getPanoramaMultiStepIndicatorKey: () => position,
      readGridDetailIdentity: () => ({ agent, date: '2026/11/27' }),
      getPanoramaLotWidget: () => ({ select }),
      getPanoramaDisplayedLot: ({ select }) => select.value,
      getNativeDetailDelete: () => native,
      checkPanoramaScannerRoute: async () => true,
      MutationObserver: class {
        constructor(callback) {
          refresh = callback;
        }
        observe() {}
        disconnect() {
          refresh = null;
        }
      }
    });
    vm.runInContext(
      'toastCarrySlot = slot; panoramaAutofillOwner = owner;',
      context
    );
    context.showVaxlinkToast({
      _vaxlinkOwner: owner,
      _fillFeedback: 'lot_not_matched'
    });
    const original = noticeButton;
    const oldListener = listener;
    assert.doesNotMatch(slot.innerHTML, /choose Delete in Panorama/);
    if (change === 'equivalent') {
      native = { click: () => clicks.push('replacement') };
      select = { value: 'original' };
    }
    if (change === 'changed lot') select.value = 'different';
    if (change === 'changed agent') agent = 'HPV';
    if (change === 'takeover')
      vm.runInContext('panoramaContextGeneration += 1', context);
    refresh();
    assert.notEqual(noticeButton, original, change);
    assert.equal(
      !!slot.querySelector('[data-delete-detail]'),
      change === 'equivalent',
      change
    );
    await oldListener({ currentTarget: original, isTrusted: true });
    if (change === 'equivalent')
      await listener({ currentTarget: noticeButton, isTrusted: true });
    else assert.match(slot.innerHTML, /choose Delete in Panorama/);
    assert.deepEqual(
      clicks,
      change === 'equivalent' ? ['replacement'] : [],
      change
    );
    position = '2-of-2';
    refresh();
    assert.equal(slot.innerHTML, '');
    assert.equal(refresh, null);
  }
});

test('dismissing a notice cannot clear a newer notice in the same slot', () => {
  const { context } = createContentHarness();
  let finishDismissal;
  const original = {
    classList: { remove() {} },
    remove() {
      toast = null;
    }
  };
  const replacement = {};
  let toast = original;
  context.setTimeout = (callback) => {
    finishDismissal = callback;
  };
  context.dismissToast({ querySelector: () => toast });
  toast = replacement;
  finishDismissal();
  assert.equal(toast, replacement);
});
