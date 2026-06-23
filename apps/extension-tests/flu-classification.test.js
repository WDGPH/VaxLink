import assert from 'node:assert/strict';
import test from 'node:test';

import { getAgentOutputs } from './helpers/clinic-sim.js';

test('seasonal FLUZONE Quadrivalent maps to Inf (QIV), not H1N1, when NVC antigen includes H1N1', () => {
  const outputs = getAgentOutputs({
    tradename: '[Inf] FLUZONE Quadrivalent',
    generic_name: '[Inf] Influenza quadrivalent vaccine',
    disease: 'Influenza',
    antigen: 'Influenza A virus subtype H1N1 antigen, Influenza virus antigen',
    manufacturer: 'SANOFI VACCINES CANADA LTD.',
    route: 'Intramuscular: IM'
  });

  assert.ok(outputs.has('Inf (QIV)'));
  assert.ok(!outputs.has('H1N1'));
});

test('FLUZONE High-Dose Quadrivalent maps to Inf High Dose (QIV), not H1N1', () => {
  const outputs = getAgentOutputs({
    tradename: '[Inf] FLUZONE High-Dose Quadrivalent',
    generic_name: '[Inf] Influenza quadrivalent vaccine',
    disease: 'Influenza',
    antigen: 'Influenza A virus subtype H1N1 antigen, Influenza virus antigen',
    manufacturer: 'SANOFI VACCINES CANADA LTD.',
    route: 'Intramuscular: IM'
  });

  assert.ok(outputs.has('Inf High Dose (QIV)'));
  assert.ok(!outputs.has('H1N1'));
});

test('explicit monovalent H1N1 vaccine still maps to H1N1', () => {
  const outputs = getAgentOutputs({
    tradename: '[Inf] Pandemic H1N1 Vaccine',
    generic_name: '[Inf] Influenza A subtype H1N1 vaccine',
    disease: 'Influenza',
    antigen: 'Influenza A virus subtype H1N1 antigen'
  });

  assert.ok(outputs.has('H1N1'));
  assert.ok(!outputs.has('Inf (QIV)'));
  assert.ok(!outputs.has('Inf (TIV)'));
  assert.ok(!outputs.has('inf-unspecified'));
});

test('explicit H5N1 vaccine still maps to H5N1', () => {
  const outputs = getAgentOutputs({
    tradename: '[Inf] AREPANRIX H5N1',
    generic_name: '[Inf] Influenza A subtype H5N1 vaccine',
    disease: 'Influenza',
    antigen: 'Influenza A virus subtype H5N1 antigen'
  });

  assert.ok(outputs.has('H5N1'));
  assert.ok(!outputs.has('Inf (QIV)'));
  assert.ok(!outputs.has('Inf (TIV)'));
  assert.ok(!outputs.has('inf-unspecified'));
});
