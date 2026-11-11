import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentHarness } from './helpers/clinic-sim.js';

const legacyKey = 'vaxlink_reason_consent_autofill_v1';
const reasonKey = 'vaxlink_reason_autofill_v1';
const consentKey = 'vaxlink_consent_autofill_v1';

function fixture(settings) {
  const harness = createContentHarness();
  const { context, storageReads, storageListeners } = harness;
  const fields = {
    reason: {
      tagName: 'SELECT',
      options: [{ text: 'Staff choice' }, { text: 'Routine' }],
      selectedIndex: 0
    },
    consent: {
      tagName: 'SELECT',
      options: [{ text: 'Staff choice' }, { text: 'Consent obtained' }],
      selectedIndex: 0
    }
  };
  const writes = [];
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
  // Replace the page write only. Use the production preference, default-value,
  // deferred-work, and completion checks from the complete content script.
  context.fillFirstMatchingField = (selectors, value) => {
    const field = context.getFields(selectors)[0];
    field.selectedIndex = field.options.findIndex(
      (option) => option.text === value
    );
    writes.push(value);
    return true;
  };
  storageReads[0].callback({
    vaxlink_administered_datetime_autofill_v1: false,
    ...settings
  });
  return {
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
