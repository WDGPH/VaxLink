import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentHarness } from './helpers/clinic-sim.js';

const legacyKey = 'vaxlink_reason_consent_autofill_v1';
const reasonKey = 'vaxlink_reason_autofill_v1';
const consentKey = 'vaxlink_consent_autofill_v1';

function fixture(settings) {
  const state = { now: 1000 };
  const harness = createContentHarness({
    performance: { now: () => state.now },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    }
  });
  const { context, storageReads, storageListeners } = harness;
  const writes = [];
  const select = (text) => {
    const options = [
      { value: '', text: 'Select' },
      { value: 'default', text },
      { value: 'staff', text: 'Staff choice' }
    ];
    return {
      tagName: 'SELECT',
      options,
      selectedIndex: 0,
      get value() {
        return options[this.selectedIndex].value;
      },
      set value(value) {
        this.selectedIndex = options.findIndex(
          (option) => option.value === value
        );
      },
      closest: () => null,
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
      focus() {},
      blur() {},
      dispatchEvent(event) {
        if (event.type === 'change')
          writes.push(options[this.selectedIndex].text);
      }
    };
  };
  const fields = {
    reason: select('Routine'),
    consent: select('Consent obtained')
  };
  context.getFields = (selectors) => {
    if (
      selectors.some((selector) =>
        selector.includes('reasonForImmunizationSelect')
      )
    )
      return [fields.reason];
    if (
      selectors.some((selector) =>
        selector.includes('consentReadinessReasonSelect')
      )
    )
      return [fields.consent];
    return [];
  };
  context.canFillPanoramaControl = () => true;
  storageReads[0].callback({
    vaxlink_administered_datetime_autofill_v1: false,
    ...settings
  });
  return {
    context,
    fields,
    state,
    writes,
    fill(reason, consent) {
      fields.reason.selectedIndex = fields.consent.selectedIndex = 0;
      writes.length = 0;
      assert.equal(
        context.hasPanoramaDeferredDetailData({}),
        reason || consent
      );
      assert.equal(
        context.hasPanoramaDeferredDetailFieldsFilled({}),
        !reason && !consent
      );
      context.fillPanoramaReasonForImmunization({});
      context.fillPanoramaConsentReason({});
      assert.deepEqual(writes, [
        ...(reason ? ['Routine'] : []),
        ...(consent ? ['Consent obtained'] : [])
      ]);
      assert.equal(fields.reason.selectedIndex, reason ? 1 : 0);
      assert.equal(fields.consent.selectedIndex, consent ? 1 : 0);
      assert.equal(context.hasPanoramaDeferredDetailFieldsFilled({}), true);
    },
    change(key, value) {
      for (const listener of storageListeners)
        listener({ [key]: { newValue: value } }, 'local');
    }
  };
}

test('reason and consent independently preserve defaults, legacy choices, and manual values', () => {
  for (const [settings, reason, consent] of [
    [{}, true, true],
    [{ [legacyKey]: false }, false, false],
    [{ [legacyKey]: true }, true, true],
    [{ [legacyKey]: false, [reasonKey]: true }, true, false],
    [{ [legacyKey]: false, [consentKey]: true }, false, true],
    [{ [reasonKey]: false, [consentKey]: true }, false, true],
    [{ [reasonKey]: true, [consentKey]: false }, true, false],
    [{ [reasonKey]: false, [consentKey]: false }, false, false]
  ])
    fixture(settings).fill(reason, consent);
});

test('open chart tabs follow separate changes without losing the other preference', () => {
  const f = fixture({ [legacyKey]: false });
  for (const [key, value, reason, consent] of [
    [reasonKey, true, true, false],
    [consentKey, true, true, true],
    [reasonKey, false, false, true],
    [legacyKey, true, false, true],
    [reasonKey, undefined, true, true],
    [consentKey, false, true, false]
  ]) {
    f.change(key, value);
    f.fill(reason, consent);
  }
});

test('prefilled Reason and Consent satisfy the watcher without being overwritten', () => {
  const f = fixture({});
  f.fields.reason.value = f.fields.consent.value = 'staff';
  assert.equal(f.context.hasPanoramaDeferredDetailFieldsFilled({}), true);
  assert.equal(f.context.fillPanoramaReasonForImmunization({}), 0);
  assert.equal(f.context.fillPanoramaConsentReason({}), 0);
  assert.deepEqual(f.writes, []);
});

test('the visible consent menu uses the matching item at most twice', () => {
  const f = fixture({});
  const consent = f.fields.consent;
  const id = 'recordImms:consentReadinessReasonSelect:iTermSelectOneMenu';
  const visible = () => ({ width: 100, height: 20 });
  let opened = false;
  let clicks = 0;
  const item = {
    classList: { contains: () => false },
    getAttribute: () => null,
    textContent: 'Consent obtained',
    getBoundingClientRect: visible,
    click() {
      clicks++;
    }
  };
  const panel = {
    id: id + '_panel',
    getBoundingClientRect: () => (opened ? visible() : { width: 0, height: 0 }),
    querySelectorAll: () => [item]
  };
  consent.id = id + '_input';
  consent.closest = () => ({
    querySelector: () => ({
      getBoundingClientRect: visible,
      click() {
        opened = true;
      }
    })
  });
  f.context.document.querySelectorAll = () => [panel];
  const data = { _vaxlinkOwner: {} };
  const fill = () => f.context.fillPanoramaConsentReason(data);
  assert.equal(fill(), 1);
  assert.equal(fill(), 0);
  f.state.now += 700;
  assert.equal(fill(), 1);
  f.state.now += 700;
  assert.equal(fill(), 0);
  assert.equal(clicks, 2);
  assert.equal(
    consent.value,
    '',
    'the widget, rather than VaxLink, sets the value'
  );
  assert.deepEqual(f.writes, []);
});
