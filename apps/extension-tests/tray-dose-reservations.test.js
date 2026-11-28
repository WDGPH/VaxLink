import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import {
  createBackgroundHarness,
  createContentHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const key = 'multiple_inject_queue_v1';
const skippedHistoryKey = 'vaxlink_skipped_dose_history_v1';
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
    storage: { [key]: rows, ...options.storage }
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
    },
    skippedHistory() {
      return harness.storageData.get(skippedHistoryKey);
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

test('only the verified last tray use renews one bounded session history entry', async () => {
  const historyKey = 'vaxlink_recent_chart_lots_v1';
  const original = {
    id: 'two',
    tradename: 'Sample vaccine',
    lot: 'LOT',
    barcode_expiry: '2099-12-31',
    remaining_doses: 2
  };
  const earlier = Array.from({ length: 20 }, (_, i) => ({
    ...original,
    id: `recent-${i}`,
    lot: `PRIOR${i}`
  }));
  const sessionStorage = new Map([[historyKey, earlier]]);
  const { change, get } = tray([original], { sessionStorage });
  const first = randomUUID();
  const final = randomUUID();
  await change(chart(1), 'reserve_dose', 'two', first);
  await change(chart(1), 'consume', 'two', first);
  assert.equal(get('two').remaining_doses, 1);
  assert.equal(sessionStorage.get(historyKey), earlier);

  await change(chart(2), 'reserve_dose', 'two', final);
  await change(chart(2), 'consume', 'two', final);
  assert.equal(get('two'), undefined);
  const history = sessionStorage.get(historyKey);
  assert.equal(history.length, 20);
  assert.equal(history[0].lot, 'LOT');
  assert.equal('remaining_doses' in history[0], false);
});

test('recent lots preserve legacy expiry and lookup confirmation for named vaccines', async () => {
  const historyKey = 'vaxlink_recent_chart_lots_v1';
  const sessionStorage = new Map();
  const { change } = tray(
    [
      {
        id: 'lot-alias',
        name: 'Same',
        lot: ' SAME ',
        dose_tracking: 'single_use'
      },
      {
        id: 'gtin-alias',
        name: '1234',
        gtin: '1234',
        lot: 'Other',
        dose_tracking: 'single_use'
      },
      {
        id: 'named',
        name: 'Sample vaccine',
        lot: 'NAMED',
        expiry: '12/31/2099',
        nvc_lot_matched: true,
        nvc_catalogue_version: 'test-version',
        dose_tracking: 'single_use'
      }
    ],
    { sessionStorage }
  );
  for (const id of ['lot-alias', 'gtin-alias', 'named']) {
    const token = randomUUID();
    assert.equal(
      (await change(chart(1), 'reserve_dose', id, token)).reserved,
      true
    );
    assert.equal((await change(chart(1), 'consume', id, token)).success, true);
  }

  const history = sessionStorage.get(historyKey);
  assert.deepEqual(
    Array.from(history, (vaccine) => vaccine.lot),
    ['NAMED']
  );
  const { record } = await change(
    popup,
    'add_from_history',
    history[0].id,
    undefined,
    { confirmed: true }
  );
  assert.equal(record.inventory_expiry, '2099-12-31');
  assert.equal(record.expiry, '12/31/2099');
  assert.equal(record.nvc_lot_matched, true);
  assert.equal(record.nvc_catalogue_version, 'test-version');
});

test('a skipped scan is restored once by ID even with another scan of the same Lot', async () => {
  const removed = {
    id: 'skipped',
    name: 'Sample vaccine',
    lot: 'SAMPLE',
    barcode_expiry: '2099-01-01',
    dose_tracking: 'single_use',
    remaining_doses: 1,
    total_doses: 1
  };
  const other = { ...removed, id: 'other' };
  let failWrite = true;
  const { change, get, skippedHistory } = tray(
    [
      {
        ...removed,
        locked_resume_order: 1,
        lock_session_id: 'original-session',
        lock_session_tab_id: 33,
        captured_while_locked: true
      },
      other
    ],
    {
      failStorageSet: (values) => failWrite && skippedHistoryKey in values
    }
  );
  const release = async () => {
    const token = randomUUID();
    assert.equal(
      (await change(chart(1), 'reserve_dose', removed.id, token)).success,
      true
    );
    assert.equal(
      (
        await change(chart(1), 'stop_dose', removed.id, token, {
          written: false
        })
      ).success,
      true
    );
    return token;
  };
  const remove = (sender, releaseToken) =>
    change(sender, 'remove_skipped_dose', removed.id, undefined, {
      expectedSingleUseLot: removed.lot,
      releaseToken
    });
  const restore = (sender) =>
    change(sender, 'restore_skipped_dose', removed.id);
  const oldRelease = await release();
  const currentRelease = await release();
  assert.equal((await remove(popup, currentRelease)).success, false);
  assert.equal(
    (await remove(chart(1, 'replacement'), currentRelease)).success,
    false
  );
  assert.equal((await remove(chart(1), currentRelease)).success, false);
  assert.equal(get(removed.id).captured_while_locked, true);
  assert.equal(skippedHistory(), undefined);

  failWrite = false;
  assert.equal((await remove(chart(1), oldRelease)).success, false);
  assert.equal((await remove(chart(1), currentRelease)).success, true);
  assert.equal(get(removed.id), undefined);
  assert.equal(get(other.id).lot, other.lot);
  assert.deepEqual({ ...skippedHistory()[0] }, removed);

  failWrite = true;
  assert.equal((await restore(popup)).success, false);
  assert.equal(get(removed.id), undefined);
  assert.equal(skippedHistory().length, 1);
  failWrite = false;
  const restored = await Promise.all([restore(popup), restore(chart(1))]);
  assert.equal(restored.filter(({ success }) => success).length, 1);
  assert.deepEqual({ ...get(removed.id) }, removed);
  assert.deepEqual({ ...get(other.id) }, other);
  assert.equal(skippedHistory().length, 0);
});

test('skipped scan removal keeps ambiguous, changed, handled, and non-single rows', async () => {
  const token = randomUUID();
  const dose = {
    id: 'scan',
    lot: 'SAMPLE',
    dose_tracking: 'single_use',
    unused_dose_release: { token, tabId: 1, documentId: 'document-1' }
  };
  for (const rows of [
    [dose, { ...dose }],
    [{ ...dose, lot: 'CHANGED' }],
    [{ ...dose, dose_tracking: 'retained' }],
    [{ ...dose, remaining_doses: 2 }],
    [{ ...dose, total_doses: 2 }],
    [{ ...dose, unused_dose_release: undefined }],
    [{ ...dose, reference_only: true }],
    [{ ...dose, dose_reservations: [{ token: randomUUID(), review: true }] }]
  ]) {
    const { change, get, skippedHistory } = tray(rows);
    assert.equal(
      (
        await change(chart(1), 'remove_skipped_dose', dose.id, undefined, {
          expectedSingleUseLot: dose.lot,
          releaseToken: token
        })
      ).success,
      false
    );
    assert.equal(get(dose.id).lot, rows[0].lot);
    assert.equal(skippedHistory(), undefined);
  }
});

test('a restored scan whose Lot has expired stays blocked from chart entry', async () => {
  const expired = {
    id: 'expired',
    lot: 'SAMPLE',
    dose_tracking: 'single_use',
    barcode_expiry: '2000-01-01'
  };
  const { change, get } = tray([], {
    storage: { [skippedHistoryKey]: [expired] }
  });
  assert.equal(
    (await change(popup, 'restore_skipped_dose', expired.id)).success,
    true
  );
  assert.deepEqual({ ...get(expired.id) }, expired);
  const attempt = await change(
    chart(1),
    'reserve_dose',
    expired.id,
    randomUUID()
  );
  assert.equal(attempt.success, false);
  assert.match(attempt.error, /expired/);
});

test('the chart tray can review a reserved dose and use any remaining dose', async () => {
  function node() {
    return {
      children: [],
      classList: { toggle() {} },
      appendChild(child) {
        this.children.push(child);
      },
      setAttribute() {},
      addEventListener(type, callback) {
        this[type] = callback;
      }
    };
  }

  for (const remaining_doses of [1, 2]) {
    const form = { isConnected: true };
    const list = node();
    const { context } = createContentHarness({
      document: { createElement: node }
    });
    const worker = createBackgroundHarness(makeTestNvcBundle(), {
      storage: { [key]: [{ id: 'chosen', lot: 'LOT', remaining_doses }] }
    });
    const original = chart(1);
    const first = randomUUID();
    const initial = await worker.sendMessage(
      {
        action: 'mutateQueue',
        storageKey: key,
        operation: 'reserve_dose',
        payload: { id: 'chosen', token: first }
      },
      original
    );
    assert.equal(initial.reserved, true);
    const second = chart(2);
    second.url = second.tab.url = context.location.href;
    context.chrome.runtime.sendMessage = (message, reply) =>
      void worker.sendMessage(message, second).then(reply);

    const useTrayVaccine = context.useTrayVaccine;
    let pending;
    let writes = 0;
    let reviewToken;
    Object.assign(context, {
      list,
      getPanoramaAutofillForm: () => form,
      getPanoramaFormContext: () => ({ kind: 'provider_single', ready: true }),
      getPanoramaMultiStepIndicatorKey: () => '',
      autoFillPanorama() {
        writes += 1;
        return { status: 'pending' };
      },
      useTrayVaccine(...args) {
        pending = useTrayVaccine(...args);
        return pending;
      },
      showDoseReview(row, token) {
        reviewToken = token;
      },
      warnPanoramaEntryBlocked() {}
    });
    vm.runInContext('hudQueueListEl = list;', context);
    context.renderHudQueueList(worker.storageData.get(key), true);
    const controls = list.children[0].children;
    assert.equal(
      controls.find((control) => control.textContent === 'In progress')
        .disabled,
      true
    );
    const held = structuredClone(worker.storageData.get(key));
    held[0].dose_reservations[0].review = true;
    context.renderHudQueueList(held, true);
    list.children
      .at(-1)
      .children.find(
        (control) => control.textContent === 'Check original chart'
      )
      .click();
    assert.equal(reviewToken, first);
    assert.equal(
      list.children
        .at(-1)
        .children.some((control) => control.textContent === 'Use'),
      remaining_doses === 2
    );
    const use = controls.find((control) => control.textContent === 'Use');
    assert.ok(use, 'a reservation cannot hide Use');
    use.click({ isTrusted: true });
    if (remaining_doses === 2) {
      assert.equal((await pending).status, 'pending');
      assert.equal(writes, 1);
      assert.equal(worker.storageData.get(key)[0].dose_reservations.length, 2);
    } else {
      await assert.rejects(pending, /already in use in another chart/);
      assert.equal(writes, 0);
      assert.equal(worker.storageData.get(key)[0].dose_reservations.length, 1);
    }
  }
});
