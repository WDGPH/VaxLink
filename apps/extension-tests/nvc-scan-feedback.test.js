import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/content.js', import.meta.url),
  'utf8'
);
const parser = readFileSync(
  new URL('../extension/shared/gs1-parser.js', import.meta.url),
  'utf8'
);

test('failed chart fill still shows the NVC failure and retains barcode fields', async () => {
  for (const error of [
    'NVC catalogue is unavailable',
    'Lot not found in the NVC catalogue'
  ]) {
    const slot = { innerHTML: '' };
    const location = new URL('https://inputhealth.com/chart');
    const window = { location, __vaxlinkHandsFreeInitialized: true };
    window.top = window.self = window;
    const context = vm.createContext({
      console,
      window,
      location,
      testSlot: slot,
      document: {
        readyState: 'loading',
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        createElement: () => ({
          textContent: '',
          get innerHTML() {
            return this.textContent;
          }
        })
      },
      chrome: {
        runtime: {
          id: 'vaxlink-test',
          lastError: null,
          onMessage: { addListener() {} },
          sendMessage: (request, done) =>
            done?.(
              request.action === 'lookupVaccineInfo'
                ? { error, errorCategory: 'unavailable' }
                : { success: true }
            )
        },
        storage: { onChanged: { addListener() {} } }
      },
      setTimeout: () => 0,
      clearTimeout() {}
    });
    vm.runInContext(parser, context);
    vm.runInContext(source, context);
    // Supply only the toast mount. The parser, lookup, fill, feedback, and escaping
    // functions all run from the complete maintained content script.
    vm.runInContext(
      'ensureToastHost = () => {}; toastRoutineSlot = testSlot;',
      context
    );
    let fillPayload;
    const autofill = context.autoFillTelus;
    context.autoFillTelus = (data) => {
      fillPayload = data;
      return autofill(data);
    };
    const result = await context.handleHandsFreeScan(
      '01001234567890121727123110TRAININGLOT'
    );
    assert.equal(result.success, false);
    assert.equal(fillPayload.lot, 'TRAININGLOT');
    assert.equal(fillPayload.gtin, '00123456789012');
    assert.ok(fillPayload.expiry);
    assert.ok(slot.innerHTML.includes(error));
    assert.match(slot.innerHTML, /Vaccine details are incomplete/);
  }
});
