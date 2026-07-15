import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mirrors the reason-for-immunization / consent defaulting and "already satisfied"
// logic added to apps/extension/content.js. Kept as a self-contained reimplementation
// so the suite needs no DOM/jsdom, matching the rest of these tests.

function normalizeForMatch(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getPanoramaReasonForImmunizationValue(data) {
  const explicit = String(data?.reason_for_immunization || '').trim();
  return explicit || 'Routine';
}

function getPanoramaConsentReasonValue(data) {
  const explicit = String(data?.consent_reason || '').trim();
  return explicit || 'Consent obtained';
}

// select mocks: { options: [{value,text}], selectedIndex, disabled }
function canFillPanoramaControl(field) {
  return !!field && !field.disabled;
}

function hasDesiredSelection(fields, desiredText) {
  const desiredNorm = normalizeForMatch(desiredText);
  if (!desiredNorm) return true;
  return fields.some((field) => {
    const opt = field.options && field.selectedIndex >= 0 ? field.options[field.selectedIndex] : null;
    return !!opt && normalizeForMatch(opt.text) === desiredNorm;
  });
}

function autofillSatisfied(fields, desiredText) {
  if (!fields.length) return true;
  if (!fields.some(canFillPanoramaControl)) return true;
  return hasDesiredSelection(fields, desiredText);
}

test('reason defaults to Routine and consent to "Consent obtained"', () => {
  assert.equal(getPanoramaReasonForImmunizationValue({}), 'Routine');
  assert.equal(getPanoramaReasonForImmunizationValue({ reason_for_immunization: 'Travel' }), 'Travel');
  assert.equal(getPanoramaConsentReasonValue({}), 'Consent obtained');
  assert.equal(getPanoramaConsentReasonValue({ consent_reason: 'Consent refused' }), 'Consent refused');
});

test('a control is "satisfied" when absent, still disabled, or already set', () => {
  const routine = [{ value: '1327349', text: 'Routine' }];
  const empty = [{ value: '', text: '' }, ...routine];

  // absent -> nothing to do
  assert.equal(autofillSatisfied([], 'Routine'), true);
  // present but disabled (consent before the lot is chosen) -> leave to Panorama
  assert.equal(autofillSatisfied([{ options: empty, selectedIndex: 0, disabled: true }], 'Routine'), true);
  // enabled and unset -> scheduler should keep retrying
  assert.equal(autofillSatisfied([{ options: empty, selectedIndex: 0, disabled: false }], 'Routine'), false);
  // enabled and already showing the desired option -> done
  assert.equal(autofillSatisfied([{ options: empty, selectedIndex: 1, disabled: false }], 'Routine'), true);
});

// Mirrors the spaced stable-pass gate in schedulePanoramaLotOrTradeSelection.
// Right after a funding-radio AJAX the consent select is momentarily DISABLED
// (which counts as "satisfied") while the lot is already re-filled. Attempts
// fire ~110ms apart, so two un-spaced stable passes could land inside that
// transient window and stop the scheduler — then consent re-enables empty with
// nothing left running to fill it.
function createStablePassGate(gapMs = 700) {
  let passes = 0;
  let lastAt = 0;
  return {
    // returns true when the scheduler would stop
    observe(now, stable) {
      if (!stable) {
        passes = 0;
        return false;
      }
      if ((now - lastAt) >= gapMs) {
        lastAt = now;
        passes += 1;
      }
      return passes >= 2;
    }
  };
}

test('a transient disabled-consent window cannot stop the fill scheduler', () => {
  const gate = createStablePassGate();
  // radio AJAX cleared the lot section: consent disabled -> looks "satisfied"
  assert.equal(gate.observe(1000, true), false);
  assert.equal(gate.observe(1110, true), false); // burst pass: not counted
  assert.equal(gate.observe(1300, true), false);
  // consent re-enables empty -> not satisfied -> counter resets, consent refilled
  assert.equal(gate.observe(1500, false), false);
  // genuine stability across spaced passes still stops the scheduler
  assert.equal(gate.observe(2000, true), false);
  assert.equal(gate.observe(2800, true), true);
});

// Mirrors fillPanoramaAdministeredDateTimeFields: a field whose value already
// matches the target must NOT be rewritten. Rewriting is not a no-op in
// Panorama — the change event fires an AJAX refresh that clears the consent
// select (enabled only once a date is present) and it never re-populates. The
// PF/NPF chooser answer re-runs the whole fill, which is where this bites.
function administeredDateTimeWrites(administered, dateField, timeField) {
  const writes = [];
  if (administered.date
      && String(dateField?.value || '').trim() !== administered.date) {
    writes.push('date');
  }
  if (administered.time
      && String(timeField?.value || '').trim() !== administered.time) {
    writes.push('time');
  }
  return writes;
}

test('a re-fill pass leaves an already-correct Date Administered untouched', () => {
  const administered = { date: '2026/07/15', time: '10:30' };

  // First pass: both fields empty -> both written.
  assert.deepEqual(
    administeredDateTimeWrites(administered, { value: '' }, { value: '' }),
    ['date', 'time']
  );

  // PF/NPF answer re-fill: values already correct -> zero writes, so the
  // date change AJAX never fires and consent stays selected.
  assert.deepEqual(
    administeredDateTimeWrites(administered, { value: '2026/07/15' }, { value: '10:30' }),
    []
  );

  // A genuinely different value is still corrected.
  assert.deepEqual(
    administeredDateTimeWrites(administered, { value: '2026/07/14' }, { value: '10:30' }),
    ['date']
  );
});

// pano3 captures the pre-lot state (consent select rendered but disabled),
// pano4 the post-lot state (consent select enabled). The defaults must resolve
// to exactly one option in both.
for (const fixtureName of ['pano3.html', 'pano4.html']) {
  test(`default targets resolve to exactly one option in the ${fixtureName} fixture`, () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', fixtureName
    );
    const html = fs.readFileSync(fixture, 'utf8');

    const optionsFor = (idFrag) => {
      const m = html.match(new RegExp('id="[^"]*' + idFrag + ':iTermSelectOneMenu_input"[^>]*>(.*?)</select>'));
      if (!m) return [];
      return [...m[1].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
        .map((o) => ({ value: o[1], text: o[2] }))
        .filter((o) => o.value !== '');
    };

    const matches = (options, desired) => options.filter((o) => o.text.trim() === desired);

    assert.deepEqual(matches(optionsFor('reasonForImmunizationSelect'), 'Routine').map((o) => o.value), ['1327349']);
    assert.deepEqual(matches(optionsFor('consentReadinessReasonSelect'), 'Consent obtained').map((o) => o.value), ['1328318']);
  });
}
