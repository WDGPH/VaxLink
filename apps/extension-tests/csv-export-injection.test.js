/**
 * CSV exports must not be executable when opened in Excel/Sheets: a cell
 * starting with = + - @ evaluates as a formula even when quote-wrapped
 * (lot numbers and free-text labels are attacker/typo-controlled). Plain
 * numbers (negative expiry_days_remaining) must stay numeric.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const QUEUE_KEY = 'multiple_inject_queue_v1';

function installBrowserGlobals() {
  const store = new Map();
  const csvCaptures = [];
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(keys, cb) {
          const result = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (store.has(k)) result[k] = store.get(k);
          cb(result);
        },
        set(values, cb) {
          for (const [k, v] of Object.entries(values)) store.set(k, v);
          cb();
        }
      }
    }
  };
  globalThis.Blob = class {
    constructor(parts) {
      this.text = parts.join('');
      csvCaptures.push(this.text);
    }
  };
  globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
  globalThis.document = {
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ click() {}, remove() {}, set href(_) {}, set download(_) {} })
  };
  return { store, csvCaptures };
}

const { store, csvCaptures } = installBrowserGlobals();
const { ScanQueueManager } = await import('../extension/popup/popup-inventory.js');

test('CSV export neutralizes formula-prefixed cells but keeps numbers numeric', async () => {
  store.set(QUEUE_KEY, [{
    id: 'x',
    tradename: '=HYPERLINK("http://evil","x")',
    lot: '=1+1',
    name: '+SUM(A1:A9)',
    manufacturer: '@cmd',
    expiry_days_remaining: -5
  }]);
  const manager = new ScanQueueManager({
    storageKey: QUEUE_KEY,
    summaryEl: null,
    listEl: null,
    clearButton: null
  });
  await manager.load();
  manager.exportCsv();

  const csv = csvCaptures.at(-1);
  assert.ok(csv.includes(`"'=1+1"`), 'formula lot must be prefixed inert');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), 'HYPERLINK payload must be inert');
  assert.ok(csv.includes(`"'+SUM(A1:A9)"`), '+ prefix must be inert');
  assert.ok(csv.includes(`"'@cmd"`), '@ prefix must be inert');
  assert.ok(csv.includes(`"-5"`), 'negative plain numbers must stay numeric (no apostrophe)');
  assert.ok(!csv.includes(`"'-5"`), 'negative plain numbers must not be guarded');
});
