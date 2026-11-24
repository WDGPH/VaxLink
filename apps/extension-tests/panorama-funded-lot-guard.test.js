import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentHarness } from './helpers/clinic-sim.js';

test('a funding choice triggers the widget or its fallback once', () => {
  for (const widgetHandlesClick of [true, false]) {
    const actions = [];
    const box = {
      click() {
        if (widgetHandlesClick) {
          radio.checked = true;
          actions.push('widget');
        }
      },
      querySelector: () => null,
      classList: { add() {} }
    };
    const radio = {
      value: 'PUBLICLY_FUNDED',
      checked: false,
      closest: (selector) =>
        selector === '.ui-radiobutton' ? { querySelector: () => box } : null,
      dispatchEvent: (event) => actions.push(event.type)
    };
    const form = {
      isConnected: true,
      querySelectorAll: () => [radio]
    };
    const { context } = createContentHarness({ Event });
    Object.assign(context, {
      getPanoramaAutofillForm: () => form,
      getPanoramaFormContext: () => ({ kind: 'provider_single' }),
      getPanoramaMultiStepIndicatorKey: () => ''
    });
    const data = context.beginPanoramaAutofill({});
    const setFunding = () =>
      context.runPanoramaAutofill(data, () =>
        context.setPanoramaFundedRadioValue(radio.value)
      );
    assert.equal(setFunding(), 'clicked');
    assert.equal(setFunding(), 'already');
    assert.deepEqual(actions, [widgetHandlesClick ? 'widget' : 'change']);
  }
});
