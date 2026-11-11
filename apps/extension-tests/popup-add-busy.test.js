import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const barcode = (lot) => `01001234567890121727123110${lot}`;
let instance = 0;

async function popup(failSave = false, mode = 'inventory') {
  let release, started, ready, focused;
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
      'queueBarcodeInput',
      'addBatchBtn',
      'addQueueBtn',
      'queueEntryPanel',
      'queueEntryToggleBtn',
      'cancelQueueEntryBtn',
      'inventoryBarcodeInput',
      'inventoryEntryPanel',
      'inventoryEntryToggleBtn',
      'cancelInventoryEntryBtn',
      'singleModeBtn',
      'multipleModeBtn',
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
        hidden: [
          'queueSaveNotice',
          'queueEntryPanel',
          'inventoryEntryPanel'
        ].includes(id),
        disabled: ['queueEntryToggleBtn', 'inventoryEntryToggleBtn'].includes(
          id
        ),
        style: {},
        dataset: {},
        listeners: {},
        classList: { toggle() {} },
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        focus() {
          focused = id;
        },
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
      getManifest: () => ({
        update_url: 'https://clients2.google.com/service/update2/crx'
      }),
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
    focused: () => focused,
    background,
    pending,
    release: () => release(),
    setSaveFailure: (value) => {
      failSave = value;
    },
    click: (id) => nodes[id].listeners.click()
  };
}

test('a preview refresh cannot cancel an in-flight save or replace the new input', async () => {
  const p = await popup();
  p.click('inventoryEntryToggleBtn');
  const adding = p.click('addBatchBtn');
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
  assert.equal(p.nodes.addBatchBtn.disabled, false);
});

test('new input survives completion and Add recovers after success or failure', async () => {
  for (const [button, input, mode] of [
    ['addBatchBtn', 'inventoryBarcodeInput', 'inventory'],
    ['addQueueBtn', 'queueBarcodeInput', 'multiple']
  ]) {
    for (const fail of [false, true]) {
      const p = await popup(fail, mode);
      if (mode === 'multiple') p.click('queueEntryToggleBtn');
      else p.click('inventoryEntryToggleBtn');
      const adding = p.click(button);
      await p.pending;
      assert.equal(p.nodes[button].disabled, true);
      p.nodes[input].value = barcode('NEXTLOT');
      p.nodes.output.innerHTML = 'Current preview';
      if (fail) await p.click('singleModeBtn');
      p.release();
      await adding;
      assert.equal(p.nodes[input].value, barcode('NEXTLOT'));
      if (mode === 'multiple')
        assert.equal(p.nodes.queueEntryPanel.hidden, false);
      else assert.equal(p.nodes.inventoryEntryPanel.hidden, false);
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

test('a later confirmed save clears the notice, while an older completion preserves a newer failure', async () => {
  const p = await popup(true);
  const older = p.click('addBatchBtn');
  await p.pending;
  await p.click('multipleModeBtn');
  p.nodes.queueBarcodeInput.value = barcode('NEXTLOT');
  await p.click('addQueueBtn');
  const warning = p.nodes.queueSaveNoticeText.textContent;
  assert.equal(p.nodes.queueSaveNotice.hidden, false);
  p.setSaveFailure(false);
  p.release();
  await older;
  assert.equal(p.nodes.queueSaveNotice.hidden, false);
  assert.equal(p.nodes.queueSaveNoticeText.textContent, warning);
  await p.click('addQueueBtn');
  assert.equal(p.nodes.queueSaveNotice.hidden, true);
});

test('both queues keep entry drafts and close only after a confirmed save', async () => {
  for (const [mode, panel, toggle, input, cancel, add] of [
    [
      'multiple',
      'queueEntryPanel',
      'queueEntryToggleBtn',
      'queueBarcodeInput',
      'cancelQueueEntryBtn',
      'addQueueBtn'
    ],
    [
      'inventory',
      'inventoryEntryPanel',
      'inventoryEntryToggleBtn',
      'inventoryBarcodeInput',
      'cancelInventoryEntryBtn',
      'addBatchBtn'
    ]
  ]) {
    for (const fail of [false, true]) {
      const p = await popup(fail, mode);
      assert.equal(p.nodes[panel].hidden, true);
      assert.equal(p.nodes[toggle].disabled, false);
      p.click(toggle);
      assert.equal(p.nodes[panel].hidden, false);
      assert.equal(p.nodes[toggle].attributes['aria-expanded'], 'true');
      assert.equal(p.focused(), input);
      p.click(cancel);
      assert.equal(p.nodes[panel].hidden, true);
      assert.equal(p.nodes[input].value, barcode('TESTLOT'));
      assert.equal(p.focused(), toggle);
      p.click(toggle);
      const adding = p.click(add);
      await p.pending;
      assert.equal(p.nodes[toggle].disabled, true);
      assert.equal(p.nodes[cancel].disabled, true);
      p.release();
      await adding;
      assert.equal(p.nodes[toggle].disabled, false);
      assert.equal(p.nodes[cancel].disabled, false);
      assert.equal(p.nodes[panel].hidden, !fail);
      assert.equal(p.nodes[input].value, fail ? barcode('TESTLOT') : '');
      assert.equal(p.nodes[toggle].attributes['aria-expanded'], String(fail));
      if (!fail) assert.equal(p.focused(), toggle);
    }
  }
});

test('inventory batch saves valid lines and keeps only failed lines for correction', async () => {
  const p = await popup();
  p.click('inventoryEntryToggleBtn');
  p.nodes.inventoryBarcodeInput.value = `${barcode('TESTLOT')}\n{}\n${barcode('NEXTLOT')}`;
  const adding = p.click('addBatchBtn');
  await p.pending;
  p.release();
  await adding;
  assert.deepEqual(
    Array.from(
      p.background.storageData.get('inventory_scan_batch_v1'),
      (row) => row.lot
    ),
    ['TESTLOT', 'NEXTLOT']
  );
  assert.equal(
    p.background.storageData.get('multiple_inject_queue_v1'),
    undefined
  );
  assert.equal(p.nodes.inventoryBarcodeInput.value, '{}');
  assert.equal(p.nodes.inventoryEntryPanel.hidden, false);
  assert.equal(p.nodes.queueSaveNotice.hidden, false);
  p.nodes.inventoryBarcodeInput.value = barcode('FIXEDLOT');
  await p.click('addBatchBtn');
  assert.equal(
    p.background.storageData.get('inventory_scan_batch_v1').length,
    3
  );
  assert.equal(p.nodes.inventoryEntryPanel.hidden, true);
  assert.equal(p.nodes.queueSaveNotice.hidden, true);
});
