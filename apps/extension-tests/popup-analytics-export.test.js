process.env.TZ = 'America/Toronto';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

test('Activity export retains every stored day and Today counts use the local day', async () => {
  const RealDate = Date;
  const createObjectURL = URL.createObjectURL;
  const downloads = [];
  const blobs = new Map();
  const listeners = {};
  const requests = [];
  let ready;
  let eventRecorded;
  const recorded = new Promise((resolve) => {
    eventRecorded = resolve;
  });
  // 21:30 in Toronto on June 11, already June 12 in UTC.
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : ['2026-06-12T01:30:00Z']));
    }
    static now() {
      return RealDate.parse('2026-06-12T01:30:00Z');
    }
  };
  const background = createBackgroundHarness(makeTestNvcBundle());
  const nodes = Object.fromEntries(
    ['analyticsSummary', 'exportAllAnalyticsBtn'].map((id) => [
      id,
      {
        addEventListener(type, listener) {
          listeners[`${id}:${type}`] = listener;
        }
      }
    ])
  );
  const day = (count) => ({
    workflows: { single: { liveScans: count } },
    autofill: { success: count },
    popupOpens: 0,
    eventCount: 0,
    sources: {},
    vaccines: {},
    manufacturers: {}
  });
  const data = {
    vaxlink_analytics_v1: {
      version: 1,
      deviceId: 'sample-device',
      deviceLabel: 'Sample workstation',
      days: {
        '2026-06-10': day(2),
        '2026-06-11': day(3),
        '2026-06-12': day(5)
      }
    }
  };
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
          Object.assign(data, values);
          if (
            Object.values(data.vaxlink_analytics_v1.days).some(
              (day) => day.popupOpens > 0
            )
          )
            eventRecorded();
          done?.();
        }
      }
    }
  };
  try {
    await import('../extension/popup.js?local-analytics-export');
    await ready();
    await recorded;
    assert.ok(
      data.vaxlink_analytics_v1.days['2026-06-11'].popupOpens > 0,
      'popup events also use the local day'
    );
    assert.match(
      nodes.analyticsSummary.innerHTML,
      /Scans<\/th><td>3<\/td><td>10<\/td>/
    );
    await listeners['exportAllAnalyticsBtn:click']();
    const all = JSON.parse(await downloads[0].blob.text());
    assert.deepEqual(Object.keys(all.days), [
      '2026-06-10',
      '2026-06-11',
      '2026-06-12'
    ]);
    assert.equal(all.rollup.workflows.single.liveScans, 10);
    assert.equal(all.rollup.autofill.success, 10);
    assert.ok(
      downloads.every((download) => download.filename.endsWith('.json'))
    );
  } finally {
    for (let index = 0; index < requests.length; index++) await requests[index];
    await new Promise(setImmediate);
    globalThis.Date = RealDate;
    URL.createObjectURL = createObjectURL;
    delete globalThis.document;
    delete globalThis.chrome;
  }
});
