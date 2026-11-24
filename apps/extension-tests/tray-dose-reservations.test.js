import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const key = 'multiple_inject_queue_v1';
const chartUrl =
  'https://panorama.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/form';
const popup = {
  id: 'vaxlink-test',
  url: 'chrome-extension://vaxlink-test/popup.html'
};

function chart(tabId, documentId = `document-${tabId}`) {
  return {
    id: 'vaxlink-test',
    frameId: 0,
    documentId,
    url: chartUrl,
    tab: { id: tabId, url: chartUrl }
  };
}

function tray(rows, options = {}) {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    ...options,
    storage: { [key]: rows }
  });
  return {
    change(sender, operation, id, token, details) {
      return harness.sendMessage(
        {
          action: 'mutateQueue',
          storageKey: key,
          operation,
          payload: { id, ...(token !== undefined && { token }), ...details }
        },
        sender
      );
    },
    get(id) {
      return harness.storageData.get(key).find((row) => row.id === id);
    }
  };
}

test('only one chart reserves the last dose and a possible write requires review', async () => {
  const row = { id: 'one', lot: 'LOT1', dose_tracking: 'single_use' };
  const { change, get } = tray([row]);
  const first = randomUUID();
  const second = randomUUID();
  const [accepted, blocked] = await Promise.all([
    change(chart(1), 'reserve_dose', 'one', first),
    change(chart(2), 'reserve_dose', 'one', second)
  ]);
  assert.equal(accepted.reserved, true);
  assert.match(blocked.error, /already in use in another chart/);
  assert.equal(
    (await change(chart(1), 'reserve_dose', 'one', first)).reserved,
    true
  );
  assert.equal(get('one').dose_reservations.length, 1);

  // Silence from the chart cannot distinguish an untouched form from a write.
  assert.equal(
    (await change(chart(2), 'review_dose', 'one', first, { used: false }))
      .success,
    false
  );
  assert.equal(
    (await change(chart(1, 'replacement-form'), 'consume', 'one', first))
      .success,
    false
  );
  assert.equal((await change(popup, 'consume', 'one')).success, false);
  assert.equal((await change(popup, 'remove', 'one')).success, false);
  assert.equal(
    (
      await change(popup, 'setDoseCount', 'one', undefined, {
        expected: JSON.stringify(['single_use', null, null]),
        quantity: 2
      })
    ).success,
    false
  );

  assert.equal(
    (await change(chart(1), 'stop_dose', 'one', first, { written: false }))
      .success,
    true
  );
  assert.equal(
    (await change(chart(2), 'reserve_dose', 'one', second)).reserved,
    true
  );
  await change(chart(2), 'stop_dose', 'one', second, { written: true });
  await change(chart(2), 'stop_dose', 'one', second, { written: false });
  assert.match(
    (await change(chart(1), 'reserve_dose', 'one', first)).error,
    /Check the original chart/
  );
  assert.equal(
    (await change(chart(1), 'review_dose', 'one', second, { used: true }))
      .success,
    true
  );
  assert.equal(get('one'), undefined);
});

test('verified chart use consumes its reserved count once and preserves other owners', async () => {
  const { change, get } = tray([
    { id: 'two', lot: 'LOT2', remaining_doses: 2 }
  ]);
  const first = randomUUID();
  const second = randomUUID();
  assert.equal(
    (await change(chart(1), 'reserve_dose', 'two', first)).reserved,
    true
  );
  assert.equal(
    (await change(chart(2), 'reserve_dose', 'two', second)).reserved,
    true
  );
  assert.equal((await change(chart(1), 'consume', 'two', first)).success, true);
  assert.equal(get('two').remaining_doses, 1);
  assert.equal(get('two').dose_reservations[0].token, second);
  assert.equal(
    (await change(chart(1), 'consume', 'two', first)).success,
    false
  );
  assert.equal(
    (await change(chart(2), 'consume', 'two', second)).success,
    true
  );
  assert.equal(get('two'), undefined);
});

test('pinned and uncounted rows bypass counting only when the lot is eligible', async () => {
  const rows = [
    { id: 'pinned', lot: 'LOT1', dose_tracking: 'retained' },
    { id: 'legacy', lot: 'LOT2' },
    {
      id: 'expired',
      lot: 'LOT3',
      nvc_lot_expiry: '2020-01-01',
      dose_tracking: 'retained'
    },
    { id: 'reference', lot: 'LOT4', reference_only: true },
    { id: 'missing' }
  ];
  const { change, get } = tray(rows);
  for (const row of rows) {
    const result = await change(chart(1), 'reserve_dose', row.id, randomUUID());
    const usable = ['pinned', 'legacy'].includes(row.id);
    assert.equal(result.success, usable);
    if (usable) assert.equal(result.reserved, false);
    assert.deepEqual(get(row.id), row);
  }
  assert.equal(
    (await change(popup, 'reserve_dose', 'pinned', randomUUID())).success,
    false
  );
  assert.equal(
    (
      await change(
        { ...chart(1), documentId: undefined },
        'reserve_dose',
        'pinned',
        randomUUID()
      )
    ).success,
    false
  );
});

test('review of a silent reservation requires confirmation from the original browser document', async () => {
  let originalReply;
  const token = randomUUID();
  const { change, get } = tray(
    [{ id: 'held', lot: 'LOT1', dose_tracking: 'single_use' }],
    {
      tabsApi: {
        sendMessage(tabId, message, options, reply) {
          assert.equal(tabId, 1);
          assert.equal(message.action, 'isDoseReservationActive');
          assert.equal(message.token, token);
          assert.equal(options.documentId, 'document-1');
          reply(originalReply);
        }
      }
    }
  );
  assert.equal(
    (await change(chart(1), 'reserve_dose', 'held', token)).reserved,
    true
  );
  for (const response of [undefined, { active: true }, { active: false }]) {
    originalReply = response;
    const result = await change(chart(2), 'review_dose', 'held', token, {
      used: false
    });
    assert.equal(result.success, response?.active === false);
    assert.equal(!!get('held').dose_reservations, response?.active !== false);
  }
  assert.equal(
    (await change(chart(2), 'reserve_dose', 'held', randomUUID())).reserved,
    true
  );
});
