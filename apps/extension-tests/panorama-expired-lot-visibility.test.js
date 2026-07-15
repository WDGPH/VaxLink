import assert from 'node:assert/strict';
import test from 'node:test';

// Mirrors the expired-lot visibility logic in apps/extension/content.js.
// Panorama hides expired/recalled lots from the lot dropdown unless the
// "Display Expired and Recalled Lots" checkbox is on, and every funding-radio
// AJAX (e.g. answering the PF/NPF chooser) re-renders the LotInfo section and
// resets that checkbox. The fill scheduler must re-assert it before each lot
// attempt for an expired scan, then wait for the lot options to refresh.

function parseDateToLocal(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!isoMatch) return null;
  return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
}

function getExpiryStatus(value) {
  const expiry = parseDateToLocal(value);
  if (!expiry) return { flag: 'unknown', daysRemaining: null };
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.floor((expiry.getTime() - todayMidnight.getTime()) / msPerDay);
  if (daysRemaining < 0) return { flag: 'expired', daysRemaining };
  if (daysRemaining <= 30) return { flag: 'expiring_soon', daysRemaining };
  return { flag: 'valid', daysRemaining };
}

function isExpiredPanoramaScan(data) {
  const flag = data?.expiry_flag
    || getExpiryStatus(data?.inventory_expiry || data?.expiry || data?.nvc_lot_expiry).flag;
  return flag === 'expired';
}

// checkbox mock: { checked } or null when Panorama has not rendered it
function ensureExpiredRecalledLotsVisible(input) {
  if (!input) return 'not_found';
  if (input.checked) return 'already';
  input.checked = true;
  return 'clicked';
}

test('expired scans are detected from the explicit flag or any expiry date field', () => {
  assert.equal(isExpiredPanoramaScan({ expiry_flag: 'expired' }), true);
  assert.equal(isExpiredPanoramaScan({ expiry: '2020-01-01' }), true);
  assert.equal(isExpiredPanoramaScan({ inventory_expiry: '2020-01-01' }), true);
  assert.equal(isExpiredPanoramaScan({ nvc_lot_expiry: '2020-01-01' }), true);
  assert.equal(isExpiredPanoramaScan({ expiry: '2099-01-01' }), false);
  assert.equal(isExpiredPanoramaScan({ expiry_flag: 'valid', expiry: '2020-01-01' }), false);
  assert.equal(isExpiredPanoramaScan({}), false);
});

test('the visibility checkbox is only clicked when present and unchecked', () => {
  assert.equal(ensureExpiredRecalledLotsVisible(null), 'not_found');
  assert.equal(ensureExpiredRecalledLotsVisible({ checked: true }), 'already');

  const checkbox = { checked: false };
  assert.equal(ensureExpiredRecalledLotsVisible(checkbox), 'clicked');
  // The AJAX from that click must settle before the next lot attempt; once it
  // has, the next scheduler pass sees the box checked and moves on to the lot.
  assert.equal(ensureExpiredRecalledLotsVisible(checkbox), 'already');
});

test('a funding-radio reset that unchecks the box is re-asserted on the next pass', () => {
  const checkbox = { checked: false };
  // initial expired scan: assert visibility, then the lot fill succeeds
  assert.equal(ensureExpiredRecalledLotsVisible(checkbox), 'clicked');
  // nurse answers NPF -> radio AJAX re-renders LotInfo and resets the box
  checkbox.checked = false;
  // the re-fill pass must click it again instead of failing the lot lookup
  assert.equal(ensureExpiredRecalledLotsVisible(checkbox), 'clicked');
  assert.equal(checkbox.checked, true);
});
