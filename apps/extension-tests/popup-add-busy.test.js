import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/popup.js', import.meta.url),
  'utf8'
);
const code = source.slice(
  source.indexOf('async function addPreviewScanToInventory()'),
  source.indexOf('\nasync function addManualScanToMultipleQueue()')
);

test('preview refresh during add cannot cancel the saved scan or leave Add busy', async () => {
  let release;
  const lookup = new Promise((resolve) => {
    release = resolve;
  });
  const button = { busy: false };
  const saved = [];
  const context = vm.createContext({
    scannedInput: { value: 'barcode' },
    activeMode: 'inventory',
    inventoryAddInFlight: false,
    getPreviewBarcodeValue: () => 'barcode',
    parseInputData: () => ({ lot: 'lot' }),
    enrichParsedData: () => lookup,
    setButtonBusy: (element, busy) => {
      element.busy = busy;
    },
    addCurrentBtn: button,
    autoFillBtn: {},
    inventoryManager: {
      add: async (record) => {
        saved.push(record);
      },
      count: 1
    },
    buildQueueRecord: (data) => data,
    logAnalyticsEvent() {},
    removeLastPendingScanLine() {
      context.scannedInput.value = '';
    },
    queueAutoParse() {
      context.activeParseRequestId++;
    },
    getExpiryStatus: () => ({ flag: 'valid' }),
    buildParsedOutputMarkup: () => '',
    outputTypeForExpiry: () => '',
    writeOutput() {},
    activeParseRequestId: 1,
    parsedData: null
  });
  vm.runInContext(code, context);
  const adding = context.addPreviewScanToInventory();
  assert.equal(button.busy, true);
  context.activeParseRequestId++;
  context.scannedInput.value = 'barcode\nnew scan';
  release({ lot: 'lot' });
  await adding;
  assert.equal(saved.length, 1);
  assert.equal(context.scannedInput.value, 'barcode\nnew scan');
  assert.equal(button.busy, false);
});

for (const mode of ['manual', 'batch']) {
  test(`${mode} add preserves input entered during lookup`, async () => {
    let release;
    const lookup = new Promise((resolve) => {
      release = resolve;
    });
    const start =
      mode === 'manual'
        ? 'async function addManualScanToMultipleQueue()'
        : 'async function addPendingScansToInventory()';
    const end =
      mode === 'manual'
        ? '\nasync function addPendingScansToInventory()'
        : '\nasync function handleUseMultipleInjectRecord(';
    const saved = [];
    const input = { value: 'original' };
    const manager = {
      add: async (record) => saved.push(record),
      addMany: async (records) => saved.push(...records),
      count: 1
    };
    const context = vm.createContext({
      scannedInput: input,
      activeMode: mode === 'manual' ? 'multiple' : 'inventory',
      inventoryAddInFlight: false,
      multipleAddInFlight: false,
      testModeBarcode: input,
      testModeAddBtn: {},
      addBatchBtn: {},
      getPendingScanLines: () => input.value.split('\n'),
      setPendingScanLines: (lines) => {
        input.value = lines.join('\n');
      },
      parseInputData: () => ({ lot: 'lot' }),
      enrichParsedData: () => lookup,
      setButtonBusy() {},
      multipleInjectManager: manager,
      inventoryManager: manager,
      buildQueueRecord: (data) => data,
      logAnalyticsEvent() {},
      getExpiryStatus: () => ({ flag: 'valid' }),
      writeOutput() {},
      parsedData: null
    });
    vm.runInContext(
      source.slice(source.indexOf(start), source.indexOf(end)),
      context
    );
    const adding =
      mode === 'manual'
        ? context.addManualScanToMultipleQueue()
        : context.addPendingScansToInventory();
    input.value = 'new scan';
    release({ lot: 'lot' });
    await adding;
    assert.equal(saved.length, 1);
    assert.equal(input.value, 'new scan');
  });
}

test('overlapping inventory add requests save once and do not replace a newer preview', async () => {
  let release;
  const lookup = new Promise((resolve) => {
    release = resolve;
  });
  const saved = [];
  const output = [];
  const input = { value: 'first' };
  const context = vm.createContext({
    scannedInput: input,
    activeMode: 'inventory',
    inventoryAddInFlight: false,
    getPreviewBarcodeValue: () => input.value,
    getPendingScanLines: () => [input.value],
    parseInputData: () => ({ lot: 'old' }),
    enrichParsedData: () => lookup,
    setButtonBusy() {},
    addCurrentBtn: {},
    addBatchBtn: {},
    inventoryManager: {
      add: async (record) => saved.push(record),
      addMany: async (records) => saved.push(...records),
      count: 1
    },
    buildQueueRecord: (data) => data,
    logAnalyticsEvent() {},
    removeLastPendingScanLine() {},
    setPendingScanLines() {},
    queueAutoParse() {},
    getExpiryStatus: () => ({ flag: 'valid' }),
    buildParsedOutputMarkup: () => 'old output',
    outputTypeForExpiry: () => '',
    writeOutput: (message) => output.push(message),
    parsedData: { lot: 'new' }
  });
  vm.runInContext(
    source.slice(
      source.indexOf('async function addPreviewScanToInventory()'),
      source.indexOf('\nasync function handleUseMultipleInjectRecord(')
    ),
    context
  );
  const first = context.addPreviewScanToInventory();
  await context.addPreviewScanToInventory();
  await context.addPendingScansToInventory();
  input.value = 'new';
  context.activeMode = 'single';
  release({ lot: 'old' });
  await first;
  assert.equal(saved.length, 1);
  assert.equal(context.parsedData.lot, 'new');
  assert.deepEqual(output, []);
  assert.equal(context.inventoryAddInFlight, false);
});

test('clearing a saved preview invalidates its pending parse', async () => {
  const context = vm.createContext({
    scannedInput: { value: 'barcode' },
    activeMode: 'inventory',
    inventoryAddInFlight: false,
    activeParseRequestId: 4,
    parsedData: { lot: 'old' },
    autoFillBtn: {},
    addCurrentBtn: {},
    getPreviewBarcodeValue: () => 'barcode',
    parseInputData: () => ({ lot: 'old' }),
    enrichParsedData: async (data) => data,
    inventoryManager: { add: async () => {}, count: 1 },
    setButtonBusy() {},
    buildQueueRecord: (data) => data,
    logAnalyticsEvent() {},
    removeLastPendingScanLine() {
      context.scannedInput.value = '';
    },
    queueAutoParse() {},
    getExpiryStatus: () => ({ flag: 'valid' }),
    buildParsedOutputMarkup: () => '',
    outputTypeForExpiry: () => '',
    writeOutput() {}
  });
  vm.runInContext(code, context);
  await context.addPreviewScanToInventory();
  assert.equal(context.activeParseRequestId, 5);
  assert.equal(context.parsedData, null);
});
