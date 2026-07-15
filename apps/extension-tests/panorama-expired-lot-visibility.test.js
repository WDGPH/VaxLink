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

// Mirrors the prompt ordering in fillPanoramaImmunizationFields /
// schedulePanoramaLotOrTradeSelection: for an expired lot the visibility
// checkbox is asserted BEFORE the PF/NPF chooser is shown, so its AJAX settles
// while the nurse reads the prompt and their answer only has the radio
// refresh left.
test('the visibility checkbox is asserted before the PF/NPF chooser appears', () => {
  const calls = [];
  const promptForFunding = (data) => {
    if (isExpiredPanoramaScan(data)) calls.push('display-expired-checkbox');
    calls.push('pf-npf-prompt');
  };

  promptForFunding({ expiry_flag: 'expired' });
  assert.deepEqual(calls, ['display-expired-checkbox', 'pf-npf-prompt']);

  calls.length = 0;
  promptForFunding({ expiry: '2099-01-01' });
  assert.deepEqual(calls, ['pf-npf-prompt']);
});

// Mirrors the click cooldown in schedulePanoramaLotOrTradeSelection. The ensure
// must never make the attempt bail out early (that starved the deferred
// date/reason/consent fills and the 3-miss prompt when Panorama kept resetting
// the checkbox); instead clicks are rate-limited and the pass continues.
const EXPIRED_VISIBILITY_CLICK_COOLDOWN_MS = 2500;

function createVisibilityClickGate() {
  let lastClickAt = 0;
  return {
    shouldAttempt(now) {
      return (now - lastClickAt) >= EXPIRED_VISIBILITY_CLICK_COOLDOWN_MS;
    },
    recordClick(now) {
      lastClickAt = now;
    }
  };
}

test('checkbox re-clicks are rate-limited so a reset loop cannot starve the fill pass', () => {
  const gate = createVisibilityClickGate();
  assert.equal(gate.shouldAttempt(10000), true);
  gate.recordClick(10000);
  // Panorama resets the box 1s later — within the cooldown the pass skips the
  // click and still runs the lot lookup and deferred fills.
  assert.equal(gate.shouldAttempt(11000), false);
  assert.equal(gate.shouldAttempt(12400), false);
  // after the cooldown the box is re-asserted
  assert.equal(gate.shouldAttempt(12600), true);
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
