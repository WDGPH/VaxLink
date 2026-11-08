import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const barcode = (lot) => `01001234567890121727123110${lot}`;
let instance = 0;

async function popup(failSave = false, mode = 'inventory') {
  let release, started, ready;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const background = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { vaxlink_workflow_mode_v1: mode },
    failStorageSet: (values) =>
      failSave &&
      ('inventory_scan_batch_v1' in values ||
        'multiple_inject_queue_v1' in values)
  });
  const nodes = Object.fromEntries(
    [
      'scannedData',
      'testModeBarcode',
      'addCurrentBtn',
      'addBatchBtn',
      'testModeAddBtn',
      'singleModeBtn',
      'output',
      'queueSaveNotice',
      'queueSaveNoticeText',
      'dismissQueueSaveNotice'
    ].map((id) => [
      id,
      {
        value: barcode('TESTLOT'),
        textContent: 'Add',
        innerHTML: '',
        hidden: id === 'queueSaveNotice',
        style: {},
        dataset: {},
        listeners: {},
        classList: { toggle() {} },
        setAttribute() {},
        addEventListener(type, listener) {
          this.listeners[type] = listener;
        }
      }
    ])
  );
  globalThis.document = {
    getElementById: (id) => nodes[id] || null,
    addEventListener(_type, listener) {
      ready = listener;
    }
  };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({}),
      onMessage: { addListener() {} },
      sendMessage(message, done) {
        const send = () =>
          void background
            .sendMessage(message, {
              id: 'vaxlink-test',
              url: 'chrome-extension://vaxlink-test/popup.html'
            })
            .then(done);
        if (
          message.action === 'lookupVaccineInfo' &&
          message.lot === 'TESTLOT'
        ) {
          release = send;
          started();
        } else send();
      }
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(keys, done) {
          done(
            Object.fromEntries(
              keys.map((key) => [key, background.storageData.get(key)])
            )
          );
        },
        set(values, done) {
          for (const [key, value] of Object.entries(values))
            background.storageData.set(key, value);
          done();
        }
      }
    }
  };
  // Opening a new popup creates fresh module state; the query does the same here.
  await import(
    new URL(`../extension/popup.js?case=${++instance}`, import.meta.url)
  );
  await ready();
  return {
    nodes,
    background,
    pending,
    release: () => release(),
    click: (id) => nodes[id].listeners.click()
  };
}

test('a preview refresh cannot cancel an in-flight save or replace the new input', async () => {
  const p = await popup();
  const adding = p.click('addCurrentBtn');
  await p.pending;
  p.nodes.scannedData.value = barcode('NEXTLOT');
  await p.click('singleModeBtn');
  let html = '';
  const refreshed = new Promise((resolve) => {
    Object.defineProperty(p.nodes.output, 'innerHTML', {
      get: () => html,
      set(value) {
        html = value;
        if (value.includes('NEXTLOT') && !value.includes('lookup-loading'))
          resolve();
      }
    });
  });
  p.nodes.scannedData.listeners.keydown({ key: 'Enter', preventDefault() {} });
  await refreshed;
  const preview = p.nodes.output.innerHTML;
  p.release();
  await adding;
  assert.equal(
    p.background.storageData.get('inventory_scan_batch_v1')[0].lot,
    'TESTLOT'
  );
  assert.equal(p.nodes.scannedData.value, barcode('NEXTLOT'));
  assert.equal(p.nodes.output.innerHTML, preview);
  assert.equal(p.nodes.addCurrentBtn.disabled, false);
});

test('new input survives completion and Add recovers after success or failure', async () => {
  for (const [button, input, mode] of [
    ['addCurrentBtn', 'scannedData', 'inventory'],
    ['addBatchBtn', 'scannedData', 'inventory'],
    ['testModeAddBtn', 'testModeBarcode', 'multiple']
  ]) {
    for (const fail of [false, true]) {
      const p = await popup(fail, mode);
      const adding = p.click(button);
      await p.pending;
      assert.equal(p.nodes[button].disabled, true);
      p.nodes[input].value = barcode('NEXTLOT');
      p.nodes.output.innerHTML = 'Current preview';
      if (fail) await p.click('singleModeBtn');
      p.release();
      await adding;
      assert.equal(p.nodes[input].value, barcode('NEXTLOT'));
      assert.equal(p.nodes.output.innerHTML, 'Current preview');
      assert.equal(p.nodes[button].disabled, false);
      assert.equal(p.nodes[button].textContent, 'Add');
      assert.equal(p.nodes.queueSaveNotice.hidden, !fail);
      if (fail) {
        assert.match(
          p.nodes.queueSaveNoticeText.textContent,
          /save not confirmed/
        );
        await p.click('dismissQueueSaveNotice');
        assert.equal(p.nodes.queueSaveNotice.hidden, true);
      }
    }
  }
});
