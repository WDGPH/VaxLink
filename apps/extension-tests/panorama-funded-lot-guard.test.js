import assert from 'node:assert/strict';
import test from 'node:test';

const PANORAMA_SHARED_FUNDING_LOT_PRODUCTS = Object.freeze([
  { label: 'Arexvy', terms: ['arexvy'] },
  { label: 'Bexsero', terms: ['bexsero'] },
  { label: 'Engerix B', terms: ['engerix b'] },
  { label: 'Gardasil 9', terms: ['gardasil 9'] },
  { label: 'Havrix', terms: ['havrix 1440', 'havrix 720', 'havrix'] },
  { label: 'Avaxim', terms: ['avaxim'] },
  { label: 'Nimenrix', terms: ['nimenrix'] },
  { label: 'Prevnar', terms: ['prevnar', 'prevenar'] },
  { label: 'RabAvert', terms: ['rabavert'] },
  { label: 'Imovax Rabies', terms: ['imovax rabies'] },
  { label: 'Shingrix', terms: ['shingrix'] },
  { label: 'Tubersol', terms: ['tubersol'] }
]);

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[:/,_-]/g, ' ')
    .replace(/\broute\b/g, ' ')
    .replace(/\bqualifier\b/g, ' ')
    .replace(/\bvalue\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPanoramaFundingSourceText(data) {
  return normalizeForMatch([
    data?.name,
    data?.tradename,
    data?.generic_name
  ].filter(Boolean).join(' '));
}

function getPanoramaSharedFundingLotProductLabel(data) {
  const source = buildPanoramaFundingSourceText(data);
  if (!source) return '';
  for (const product of PANORAMA_SHARED_FUNDING_LOT_PRODUCTS) {
    if ((product.terms || []).some((term) => source.includes(normalizeForMatch(term)))) {
      return product.label;
    }
  }
  return '';
}

function isExplicitPanoramaFundingValue(value) {
  return value === 'PUBLICLY_FUNDED' || value === 'NON_PUBLICLY_FUNDED';
}

test('shared PF/NPF lot products are recognized from scan metadata', () => {
  const cases = [
    [{ tradename: 'Arexvy' }, 'Arexvy'],
    [{ tradename: 'BEXSERO' }, 'Bexsero'],
    [{ tradename: 'Engerix-B Pediatric' }, 'Engerix B'],
    [{ tradename: 'Gardasil 9' }, 'Gardasil 9'],
    [{ name: 'HAVRIX 720' }, 'Havrix'],
    [{ tradename: 'Avaxim' }, 'Avaxim'],
    [{ tradename: 'Nimenrix' }, 'Nimenrix'],
    [{ tradename: 'Prevnar 20' }, 'Prevnar'],
    [{ tradename: 'Prevnar 13' }, 'Prevnar'],
    [{ name: 'Prevenar 13' }, 'Prevnar'],
    [{ tradename: 'RabAvert' }, 'RabAvert'],
    [{ tradename: 'IMOVAX Rabies' }, 'Imovax Rabies'],
    [{ tradename: 'Shingrix' }, 'Shingrix'],
    [{ tradename: 'Tubersol' }, 'Tubersol']
  ];

  for (const [input, expected] of cases) {
    assert.equal(getPanoramaSharedFundingLotProductLabel(input), expected);
  }
});

test('products outside the shared-lot list do not require the PF/NPF chooser', () => {
  for (const input of [
    { tradename: 'Comirnaty' },
    { tradename: 'Priorix' },
    { tradename: 'Twinrix' }
  ]) {
    assert.equal(getPanoramaSharedFundingLotProductLabel(input), '');
  }
});

test('only PF and NPF are explicit funded choices', () => {
  assert.equal(isExplicitPanoramaFundingValue('PUBLICLY_FUNDED'), true);
  assert.equal(isExplicitPanoramaFundingValue('NON_PUBLICLY_FUNDED'), true);
  assert.equal(isExplicitPanoramaFundingValue('SHOW_ALL'), false);
  assert.equal(isExplicitPanoramaFundingValue(''), false);
});

// Mirrors setPanoramaFundedRadioValue: setting the funded radio must fire
// exactly ONE radio AJAX, like a manual click. The old path clicked the
// PrimeFaces widget box AND dispatched a synthetic change on top — the second
// queued radio request re-rendered the lot section from a stale serialization
// and wiped the "Display Expired and Recalled Lots" checkbox (which a manual
// radio change preserves). The synthetic path is a fallback for when the
// widget did not take the click.
function setFundedRadio(radio, widgetBound) {
  const ajaxFired = [];
  if (radio.checked) return { result: 'already', ajaxFired };
  if (radio.box && widgetBound) {
    radio.checked = true;      // widget toggles the input...
    ajaxFired.push('widget');  // ...and fires its own AJAX
  }
  if (radio.checked) return { result: 'clicked', ajaxFired };
  radio.checked = true;
  ajaxFired.push('synthetic-change');
  return { result: 'clicked', ajaxFired };
}

test('setting the funded radio fires exactly one AJAX, like a manual click', () => {
  // widget bound (normal Panorama page): widget click only, no synthetic change
  assert.deepEqual(
    setFundedRadio({ checked: false, box: {} }, true),
    { result: 'clicked', ajaxFired: ['widget'] }
  );
  // widget not bound: the synthetic fallback still applies the choice, once
  assert.deepEqual(
    setFundedRadio({ checked: false, box: {} }, false),
    { result: 'clicked', ajaxFired: ['synthetic-change'] }
  );
  // already selected: no AJAX at all
  assert.deepEqual(
    setFundedRadio({ checked: true, box: {} }, true),
    { result: 'already', ajaxFired: [] }
  );
});

// Mirrors the shared-funding miss pacing in schedulePanoramaLotOrTradeSelection.
// Fill attempts fire in a sub-second burst (0/120/260/450ms + mutation observer)
// and the content script cannot see PrimeFaces' AJAX queue, so counting every
// failed lot lookup as a miss re-summoned the PF/NPF chooser before the
// radio/checkbox AJAX had repopulated the lot options (nurses had to answer the
// same prompt three times). Misses must be spaced out, and the window restarts
// whenever VaxLink itself triggers a lot-options refresh.
const SHARED_FUNDING_MISS_GAP_MS = 1200;

function createSharedFundingMissWindow() {
  let misses = 0;
  let lastMissAt = 0;
  return {
    restart(now) {
      misses = 0;
      lastMissAt = now;
    },
    // returns true when the third counted miss is reached (chooser re-summoned)
    recordMiss(now) {
      if ((now - lastMissAt) < SHARED_FUNDING_MISS_GAP_MS) return false;
      lastMissAt = now;
      misses += 1;
      return misses >= 3;
    }
  };
}

test('a sub-second burst of failed lot lookups does not re-summon the chooser', () => {
  const window_ = createSharedFundingMissWindow();
  window_.restart(1000); // NPF answered -> radio AJAX in flight
  // burst attempts while the refresh is still pending
  for (const at of [1000, 1120, 1260, 1450, 1500, 1610, 1720, 1830]) {
    assert.equal(window_.recordMiss(at), false);
  }
});

test('sustained genuine failure still re-summons the chooser after ~3 spaced misses', () => {
  const window_ = createSharedFundingMissWindow();
  window_.restart(1000);
  assert.equal(window_.recordMiss(2250), false);  // miss 1
  assert.equal(window_.recordMiss(2900), false);  // within gap -> not counted
  assert.equal(window_.recordMiss(3500), false);  // miss 2
  assert.equal(window_.recordMiss(4800), true);   // miss 3 -> chooser
});

test('a refresh triggered by VaxLink restarts the miss window', () => {
  const window_ = createSharedFundingMissWindow();
  window_.restart(0);
  assert.equal(window_.recordMiss(1200), false);  // miss 1
  assert.equal(window_.recordMiss(2400), false);  // miss 2
  // expired-lots checkbox clicked -> options are about to change
  window_.restart(2600);
  assert.equal(window_.recordMiss(3800), false);  // miss 1 again, not 3
  assert.equal(window_.recordMiss(5000), false);  // miss 2
  assert.equal(window_.recordMiss(6200), true);   // miss 3 -> chooser
});
