import assert from 'node:assert/strict';
import test from 'node:test';
import { describePanoramaIntegration } from '../extension/popup-ui.js';

test('Panorama support results retain useful distinctions without displaying page-supplied values', () => {
  for (const [state, expected] of [
    ['ready', /does not confirm a saved record/],
    ['stale', /Reload it when safe/],
    ['not_ready', /still initializing/],
    ['missing', /Open a supported Panorama page/],
    ['unknown', /could not be confirmed/],
    ['<patient value>', /could not be confirmed/]
  ]) {
    const text = describePanoramaIntegration({ state });
    assert.match(text, expected);
    assert.doesNotMatch(text, /<patient value>/);
  }
});
