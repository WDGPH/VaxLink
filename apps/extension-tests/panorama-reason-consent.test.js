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

test('default targets resolve to exactly one option in the pano3 fixture', () => {
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'pano3.html'
  );
  const html = fs.readFileSync(fixture, 'utf8');

  const optionsFor = (idFrag) => {
    const m = html.match(new RegExp('id="[^"]*' + idFrag + ':iTermSelectOneMenu_input"[^>]*>(.*?)</select>'));
    if (!m) return [];
    return [...m[1].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)]
      .map((o) => ({ value: o[1], text: o[2] }))
      .filter((o) => o.value !== '');
  };

  const matches = (options, desired) => options.filter((o) => o.text.trim() === desired);

  assert.deepEqual(matches(optionsFor('reasonForImmunizationSelect'), 'Routine').map((o) => o.value), ['1327349']);
  assert.deepEqual(matches(optionsFor('consentReadinessReasonSelect'), 'Consent obtained').map((o) => o.value), ['1328318']);
});
