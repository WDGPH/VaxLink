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
    { tradename: 'Prevnar 20' },
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
