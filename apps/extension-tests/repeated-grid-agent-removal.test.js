import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  createBackgroundHarness,
  createContentHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const tray = 'multiple_inject_queue_v1';
const recent = 'vaxlink_skipped_dose_history_v1';

async function grid(scenario) {
  const { context } = createContentHarness();
  const url = context.location.href;
  const tab = { id: 42, url, active: true };
  const multi = ['three choices', 'interrupted'].includes(scenario);
  const agents = {
    first: 'MMR',
    second: 'MMR',
    third: 'HPV',
    ...(multi && { fourth: 'MMR', fifth: 'HPV', manual: 'MMR' })
  };
  const ids = Object.keys(agents);
  const scanned = ids.filter((id) => id !== 'manual');
  const secondLot = scenario === 'same lot' ? 'LOT-first' : 'LOT-second';
  const worker = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    storage: {
      [tray]: scanned.map((id) => ({
        id,
        lot: id === 'second' ? secondLot : `LOT-${id}`,
        generic_name: agents[id],
        dose_tracking: 'single_use',
        remaining_doses: 1
      }))
    }
  });
  const sender = {
    id: 'vaxlink-test',
    frameId: 0,
    documentId: 'grid-chart',
    url,
    tab
  };
  const requests = [];
  const warnings = [];
  const dateEvents = [];
  const settle = () => new Promise(setImmediate);
  const rows = ids.map((id, index) => {
    const prefix = `form:historicalfactoryTable:dataTable:${index}`;
    const label = { isConnected: true, textContent: '' };
    const field = {
      id: `${prefix}:immsAgentMenu:selectOneMenu_input`,
      tagName: 'SELECT',
      isConnected: true,
      value: '',
      options: [
        { value: '', text: '' },
        { value: '1', text: agents[id] }
      ],
      get selectedIndex() {
        return this.value ? 1 : 0;
      },
      dispatchEvent(event) {
        if (index === 1 && event.type === 'input' && scenario === 'new label')
          rows[1].label = { isConnected: true, textContent: 'Another row' };
      }
    };
    const [date, extra] = [1, 2].map((number) => ({
      id: `${prefix}:dateIn${number}:dateInput_input`,
      tagName: 'INPUT',
      isConnected: true,
      value: '',
      focus() {},
      blur() {},
      dispatchEvent(event) {
        dateEvents.push([this.id, event.type]);
      }
    }));
    return {
      field,
      label,
      date,
      extra,
      isConnected: true,
      getAttribute: (key) =>
        key === 'data-ri' ? String(index) : `row-${index}`,
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
      querySelectorAll: () => [date, extra],
      contains(node) {
        return [field, this.label, date, extra].includes(node);
      }
    };
  });
  const form = {
    isConnected: true,
    contains: (node) =>
      rows.includes(node) || rows.some((row) => row.contains(node))
  };
  const keep = new Map();
  const notice = {
    innerHTML: '',
    get firstElementChild() {
      return this.innerHTML;
    },
    querySelector: (selector) => ({
      addEventListener(type, callback) {
        assert.equal(type, 'click');
        const index = selector.match(/data-keep-repeated-grid="(\d+)"/)?.[1];
        if (index !== undefined) keep.set(Number(index), callback);
      }
    }),
    replaceChildren() {
      this.innerHTML = '';
    }
  };
  const skipped = {
    replaceChildren(child) {
      this.firstElementChild = child;
    }
  };
  context.document.body = {};
  context.document.getElementById = (id) =>
    rows.find(({ field }) => field.id.replace(/_input$/, '_label') === id)
      ?.label;
  context.document.createElement = (tag) =>
    tag === 'span'
      ? {
          get innerHTML() {
            return this.textContent;
          }
        }
      : { setAttribute() {}, querySelector: () => null };
  let poll = 0;
  context.chrome.runtime.sendMessage = (message, reply) => {
    if (message.operation) requests.push(message.operation);
    const send = async () => {
      const result = await worker.sendMessage(message, sender);
      if (
        message.action === 'checkScannerChart' &&
        scenario === 'worker outdated'
      )
        return { ...result, skippedDoseArchiveVersion: undefined };
      if (
        message.operation === 'remove_skipped_dose' &&
        scenario === 'interrupted'
      )
        rows[3].extra.value = '2026/11/26';
      if (message.operation === 'stop_dose') {
        if (scenario === 'takeover') context.cancelPanoramaAutofill();
        if (scenario === 'missing proof')
          return {
            ...result,
            rows: result.rows.map(({ unused_dose_release, ...row }) => row)
          };
      }
      return result;
    };
    const result = send();
    if (reply) void result.then(reply);
    return result;
  };
  Object.assign(context, {
    Event,
    notices: { notice, skipped },
    ensureToastHost() {},
    isPanoramaMultipleImmunizationGridPage: () => true,
    getPanoramaAutofillForm: () => form,
    getPanoramaFormContext: () => ({ kind: 'multiple_grid', ready: true }),
    getPanoramaMultipleGridRows: () => rows,
    getPanoramaMultipleGridRowState(index) {
      const { field, label, date } = rows[index];
      return {
        agentField: field,
        agentLabel: label,
        dateField: date,
        agentText: field.value ? label.textContent : '',
        dateText: date.value
      };
    },
    fillPanoramaMultipleGridAgent(index) {
      rows[index].field.value = '1';
      rows[index].label.textContent = rows[index].field.options[1].text;
      return true;
    },
    fillPanoramaMultipleGridDate1(index) {
      rows[index].date.value = `2026/11/2${index}`;
      return true;
    },
    showVaxlinkToast(data) {
      if (data._entryWarning) warnings.push(data._entryWarning);
    },
    setTimeout(callback, delay) {
      if (delay === 125) {
        if (poll++ === 0) {
          if (scenario === 'native clear') rows[1].date.value = '';
          if (scenario === 'date changed') rows[1].date.value = '2026/11/25';
          if (scenario === 'extra date') rows[1].extra.value = '2026/11/26';
        }
        queueMicrotask(callback);
      }
      return 1;
    },
    clearTimeout() {},
    MutationObserver: class {
      observe() {}
    }
  });
  vm.runInContext(
    'toastRepeatedAgentSlot = notices.notice; toastSkippedDoseSlot = notices.skipped',
    context
  );
  context.watchRepeatedGridAgents();
  for (const id of scanned) {
    const result = await context.useTrayVaccine(
      id,
      context.getScannerDeliveryContext('multiple_grid', true)
    );
    assert.equal(result.status, 'grid_added');
  }
  if (multi) {
    context.fillPanoramaMultipleGridAgent(5);
    context.fillPanoramaMultipleGridDate1(5);
    vm.runInContext('updateRepeatedGridNotice()', context);
  }
  await settle();
  assert.ok(notice.innerHTML.includes('Keep row 1 · Lot LOT-first'));
  assert.ok(notice.innerHTML.includes(`Keep row 2 · Lot ${secondLot}`));
  const click = (event, index = 0) => keep.get(index)(event);
  return { worker, requests, warnings, dateEvents, rows, click, settle };
}

test('the repeated Agent action keeps the selected row and archives the other exact scan', async () => {
  for (const scenario of ['native clear', 'Date1 fallback', 'same lot']) {
    const { worker, requests, dateEvents, rows, click, settle } =
      await grid(scenario);
    click({ isTrusted: false });
    await settle();
    assert.equal(rows[1].field.value, '1');
    click({ isTrusted: true });
    await settle();
    assert.equal(rows[0].field.value, '1');
    assert.equal(rows[0].date.value, '2026/11/20');
    assert.equal(rows[2].field.value, '1');
    assert.equal(rows[2].date.value, '2026/11/22');
    assert.equal(rows[1].field.value, '');
    assert.equal(rows[1].date.value, '');
    assert.deepEqual(
      dateEvents,
      scenario === 'native clear'
        ? []
        : [
            [rows[1].date.id, 'input'],
            [rows[1].date.id, 'change']
          ]
    );
    assert.deepEqual(requests, [
      'reserve_dose',
      'reserve_dose',
      'reserve_dose',
      'stop_dose',
      'remove_skipped_dose'
    ]);
    assert.deepEqual(
      Array.from(worker.storageData.get(tray), ({ id }) => id),
      ['first', 'third']
    );
    assert.deepEqual(
      Array.from(worker.storageData.get(recent), ({ id }) => id),
      ['second']
    );
  }
});

test('choosing the middle scan clears only its eligible group and stops after an interruption', async () => {
  for (const scenario of ['three choices', 'interrupted']) {
    const { worker, requests, rows, click, settle } = await grid(scenario);
    click({ isTrusted: true }, 1);
    await settle();
    assert.deepEqual(
      rows.map(({ field }) => field.value),
      ['', '1', '1', scenario === 'interrupted' ? '1' : '', '1', '1']
    );
    assert.deepEqual(
      rows.map(({ date }) => date.value),
      [
        '',
        '2026/11/21',
        '2026/11/22',
        scenario === 'interrupted' ? '2026/11/23' : '',
        '2026/11/24',
        '2026/11/25'
      ]
    );
    const saved = Array.from(worker.storageData.get(tray), ({ id }) => id);
    assert.deepEqual(
      saved,
      scenario === 'interrupted'
        ? ['second', 'third', 'fourth', 'fifth']
        : ['second', 'third', 'fifth']
    );
    assert.deepEqual(
      Array.from(worker.storageData.get(recent), ({ id }) => id),
      scenario === 'interrupted' ? ['first'] : ['fourth', 'first']
    );
    assert.equal(
      requests.filter((request) => request === 'remove_skipped_dose').length,
      scenario === 'interrupted' ? 1 : 2
    );
  }
});

test('the action keeps the scan when a control changes or release cannot be verified', async () => {
  for (const scenario of [
    'new label',
    'date changed',
    'extra date',
    'takeover',
    'missing proof'
  ]) {
    const { worker, requests, warnings, dateEvents, rows, click, settle } =
      await grid(scenario);
    click({ isTrusted: true });
    await settle();
    assert.equal(rows[0].date.value, '2026/11/20', scenario);
    assert.deepEqual(
      Array.from(worker.storageData.get(tray), ({ id }) => id),
      ['first', 'second', 'third'],
      scenario
    );
    assert.equal(requests.includes('remove_skipped_dose'), false, scenario);
    assert.match(
      warnings.at(-1),
      /row 2.*Immunization tray and Recent Scans/,
      scenario
    );
    if (scenario === 'new label')
      assert.equal(rows[1].label.textContent, 'Another row');
    if (scenario === 'date changed')
      assert.equal(rows[1].date.value, '2026/11/25');
    if (scenario === 'extra date')
      assert.equal(rows[1].extra.value, '2026/11/26');
    if (['new label', 'date changed', 'extra date'].includes(scenario))
      assert.deepEqual(dateEvents, [], scenario);
  }
});

test('a worker without archive support leaves both the grid and scans intact', async () => {
  const { worker, requests, warnings, rows, click, settle } =
    await grid('worker outdated');
  click({ isTrusted: true }, 1);
  await settle();
  assert.equal(rows[0].field.value, '1');
  assert.equal(rows[0].date.value, '2026/11/20');
  assert.equal(worker.storageData.get(tray).length, 3);
  assert.deepEqual(requests, ['reserve_dose', 'reserve_dose', 'reserve_dose']);
  assert.match(warnings.at(-1), /Reload VaxLink/);
});

test('an unavailable route check does not diagnose a stale worker', async () => {
  const { context } = createContentHarness();
  const warnings = [];
  context.showVaxlinkToast = ({ _entryWarning }) =>
    warnings.push(_entryWarning);
  context.chrome.runtime.sendMessage = async () => {
    throw new Error('The worker did not respond');
  };

  assert.equal(
    await context.ensureSkippedDoseWorkerSupport({}, () => true),
    false
  );
  assert.match(warnings[0], /could not confirm the active Panorama chart/);
});
