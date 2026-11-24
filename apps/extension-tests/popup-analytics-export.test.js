process.env.TZ = 'America/Toronto';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

test('a CSV export during a delayed Inventory save counts each action once', async () => {
  const inventoryKey = 'inventory_scan_batch_v1';
  const analyticsKey = 'vaxlink_analytics_v1';
  const localDay = (offset) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return new Intl.DateTimeFormat('en-CA').format(date);
  };
  const yesterday = localDay(-1);
  const today = localDay(0);
  const tomorrow = localDay(1);
  const createObjectURL = URL.createObjectURL;
  const downloads = [];
  const blobs = new Map();
  const listeners = {};
  const requests = [];
  let ready;
  const savingScan = Promise.withResolvers();
  let resumeScan;
  const nodes = Object.fromEntries(
    ['analyticsSummary', 'exportAllAnalyticsBtn', 'exportCsvBtn'].map((id) => [
      id,
      {
        addEventListener(type, listener) {
          listeners[`${id}:${type}`] = listener;
        }
      }
    ])
  );
  const day = (count) => ({
    workflows: {
      single: { liveScans: count },
      inventory: { liveScans: 0, queueSaved: 0 }
    },
    exports: { inventoryCount: 0, inventoryRows: 0 },
    queues: { inventorySaved: 0, maxInventoryDepth: 0 },
    autofill: { success: count },
    popupOpens: 0,
    eventCount: 0,
    sources: {},
    vaccines: {},
    manufacturers: {}
  });
  const data = {
    vaxlink_workflow_mode_v1: 'inventory',
    [inventoryKey]: [{ id: 'existing', lot: 'EXISTING' }],
    [analyticsKey]: {
      version: 1,
      deviceId: 'sample-device',
      deviceLabel: 'Sample workstation',
      firstSeenAt: '2026-06-09T15:00:00.000Z',
      days: {
        [yesterday]: {
          ...day(2),
          expiry: { expiringSoon: 5 },
          vaccines: { 'HISTORICAL-LOT': 2 },
          funding: { prompts: 2, choices: 1 }
        },
        [today]: { ...day(3), expiry: { noticesShown: 1 } },
        [tomorrow]: { ...day(5), funding: { single: 3, both: 1, unmatched: 2 } }
      },
      recentEvents: [{ note: 'OLD-EVENT' }]
    }
  };
  const background = createBackgroundHarness(makeTestNvcBundle(), {
    storage: structuredClone(data),
    delayStorageSet(values, resume) {
      if (!values[inventoryKey] || resumeScan) return false;
      resumeScan = resume;
      savingScan.resolve();
      return true;
    }
  });
  URL.createObjectURL = (blob) => {
    const url = `blob:sample-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  globalThis.document = {
    getElementById: (id) => nodes[id] || null,
    addEventListener(_type, listener) {
      ready = listener;
    },
    body: { appendChild() {} },
    createElement() {
      return {
        click() {
          downloads.push({
            filename: this.download,
            blob: blobs.get(this.href)
          });
        },
        remove() {}
      };
    }
  };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({}),
      onMessage: { addListener() {} },
      sendMessage(message, done) {
        requests.push(background.sendMessage(message).then(done));
      }
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(keys, done) {
          done(Object.fromEntries(keys.map((key) => [key, data[key]])));
        },
        set(values, done) {
          assert.equal(analyticsKey in values, false);
          Object.assign(data, values);
          done?.();
        }
      }
    }
  };
  try {
    await import('../extension/popup.js?local-analytics-export');
    await ready();
    assert.match(
      nodes.analyticsSummary.innerHTML,
      /Scans<\/th><td>3<\/td><td>10<\/td>/
    );

    const capture = background.captureScannerScan({
      rawText: '01001234567890121727123110UNLISTEDLOT'
    });
    await savingScan.promise;
    try {
      listeners['exportCsvBtn:click']();
      assert.match(downloads[0].filename, /\.csv$/);
      const csv = await downloads[0].blob.text();
      assert.match(csv, /EXISTING/);
      assert.doesNotMatch(csv, /UNLISTEDLOT/);
    } finally {
      resumeScan();
    }
    assert.equal((await capture).queued, true);
    await listeners['exportAllAnalyticsBtn:click']();

    assert.match(downloads[1].filename, /\.json$/);
    assert.match(
      nodes.analyticsSummary.innerHTML,
      /Inventory exports<\/th><td>1<\/td><td>1<\/td>/
    );
    const all = JSON.parse(await downloads[1].blob.text());
    assert.deepEqual(Object.keys(all.days), [yesterday, today, tomorrow]);
    assert.equal(all.deviceId, 'sample-device');
    assert.equal(all.deviceLabel, 'Sample workstation');
    assert.equal(all.firstSeenAt, data[analyticsKey].firstSeenAt);
    assert.equal(all.days[today].popupOpens, 1);
    assert.equal(all.rollup.workflows.single.liveScans, 10);
    assert.equal(all.rollup.workflows.inventory.liveScans, 1);
    assert.equal(all.rollup.autofill.success, 10);
    assert.deepEqual(all.rollup.exports, {
      inventoryCount: 1,
      inventoryRows: 1
    });
    assert.deepEqual(all.rollup.vaccines, { 'HISTORICAL-LOT': 2 });
    assert.deepEqual(all.rollup.funding, {
      prompts: 2,
      choices: 1,
      single: 3,
      both: 1,
      unmatched: 2
    });
    assert.equal(all.rollup.expiry.expiringSoon, 5);
    assert.equal(all.rollup.expiry.noticesShown, 1);
    assert.match(
      nodes.analyticsSummary.innerHTML,
      /Expiry notices shown<\/th><td>1<\/td><td>1<\/td>/
    );
    assert.equal(all.days[yesterday].expiry.noticesShown, undefined);
    assert.doesNotMatch(
      JSON.stringify(all),
      /UNLISTEDLOT|00123456789012|OLD-EVENT/
    );
  } finally {
    for (let index = 0; index < requests.length; index++) await requests[index];
    await new Promise(setImmediate);
    URL.createObjectURL = createObjectURL;
    delete globalThis.document;
    delete globalThis.chrome;
  }
});
