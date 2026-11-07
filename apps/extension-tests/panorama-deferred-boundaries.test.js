import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/content.js', import.meta.url),
  'utf8'
);

function setup() {
  let now = 100000;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    set(fn, delay, interval = 0) {
      const id = nextId++;
      timers.set(id, { fn, at: now + Number(delay || 0), interval });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!entry) break;
        const [id, timer] = entry;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.fn();
      }
      now = end;
    }
  };
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  class FakeEvent {
    constructor(type) {
      this.type = type;
    }
  }
  const listeners = new Map();
  let owner = { isConnected: true };
  let fields;
  function makeFields(form) {
    const makeInput = (id) => ({
      id,
      tagName: 'INPUT',
      type: 'text',
      value: '',
      disabled: false,
      form,
      isConnected: true,
      focus() {},
      blur() {},
      dispatchEvent() {},
      getBoundingClientRect: () => ({ width: 10, height: 10 }),
      closest: (selector) => (selector === 'form' ? form : null)
    });
    const makeSelect = (id, text) => {
      const field = {
        id,
        tagName: 'SELECT',
        disabled: false,
        form,
        isConnected: true,
        options: [
          { value: '', text: '' },
          { value: 'yes', text }
        ],
        selectedIndex: 0,
        focus() {},
        blur() {},
        dispatchEvent() {},
        closest: (selector) => (selector === 'form' ? form : null)
      };
      Object.defineProperty(field, 'value', {
        get() {
          return this.options[this.selectedIndex].value;
        },
        set(value) {
          this.selectedIndex = this.options.findIndex(
            (option) => option.value === value
          );
        }
      });
      return field;
    };
    return {
      date: makeInput('dateAdministedDate:dateInput_input'),
      time: makeInput('dateAdministedDate:timeInput:timeInput'),
      reason: makeSelect(
        'reasonForImmunizationSelect:iTermSelectOneMenu_input',
        'Routine'
      ),
      consent: makeSelect(
        'consentReadinessReasonSelect:iTermSelectOneMenu_input',
        'Consent obtained'
      )
    };
  }
  fields = makeFields(owner);
  const body = { isConnected: true };
  const document = {
    readyState: 'loading',
    body,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    querySelectorAll(selector) {
      if (selector.includes('dateAdministedDate:dateInput_input'))
        return [fields.date];
      if (selector.includes('dateAdministedDate:timeInput:timeInput'))
        return [fields.time];
      if (selector.includes('reasonForImmunizationSelect'))
        return [fields.reason];
      if (selector.includes('consentReadinessReasonSelect'))
        return [fields.consent];
      return [];
    },
    querySelector() {
      return null;
    },
    getElementById() {
      return null;
    }
  };
  const location = {
    protocol: 'https:',
    hostname: 'www.panorama.prod.ehealthontario.ca',
    pathname: '/recordImms/',
    href: 'https://www.panorama.prod.ehealthontario.ca/recordImms/'
  };
  const window = { location, __vaxlinkHandsFreeInitialized: true };
  window.top = window.self = window;
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: { onChanged: { addListener() {} } }
  };
  const context = vm.createContext({
    window,
    document,
    location,
    chrome,
    console,
    Date: FakeDate,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: (fn, ms) => clock.set(fn, ms),
    clearTimeout: (id) => clock.clear(id),
    setInterval: (fn, ms) => clock.set(fn, ms, ms),
    clearInterval: (id) => clock.clear(id)
  });
  vm.runInContext(source, context, { filename: 'content.js' });
  const schedule = (administered_at) =>
    context.schedulePanoramaLotOrTradeSelection({ administered_at });
  return {
    context,
    clock,
    schedule,
    get fields() {
      return fields;
    },
    manual(field) {
      context.cancelPanoramaFillRetriesForManualEdit({
        isTrusted: true,
        target: field
      });
    },
    replaceControls() {
      fields = makeFields(owner);
    },
    replaceForm() {
      owner = { isConnected: true };
      fields = makeFields(owner);
    },
    disconnectForm() {
      owner.isConnected = false;
    }
  };
}

const first = '2025-01-02T12:34:00';
const second = '2025-02-03T13:45:00';

function resolve(run, time = first) {
  run.schedule(time);
  run.clock.advance(1000);
  assert.equal(run.fields.date.value, '2025/01/02');
}

for (const name of ['date', 'time', 'reason', 'consent']) {
  test(`trusted ${name} edit cancels late deferred writes`, () => {
    const run = setup();
    resolve(run);
    run.manual(run.fields[name]);
    run.fields.date.value = 'manual';
    run.clock.advance(4000);
    assert.equal(run.fields.date.value, 'manual');
  });
}

test('new operation cancels earlier late writes', () => {
  const run = setup();
  resolve(run);
  run.schedule(second);
  run.clock.advance(4000);
  assert.equal(run.fields.date.value, '2025/02/03');
});

test('replaced controls in the same form receive late writes', () => {
  const run = setup();
  resolve(run);
  run.replaceControls();
  run.clock.advance(4000);
  assert.equal(run.fields.date.value, '2025/01/02');
});

for (const action of ['replaceForm', 'disconnectForm']) {
  test(`${action} cancels late writes`, () => {
    const run = setup();
    resolve(run);
    run[action]();
    run.fields.date.value = 'manual';
    run.clock.advance(4000);
    assert.equal(run.fields.date.value, 'manual');
  });
}

test('late writes skip while the visible PrimeFaces queue is busy', () => {
  const run = setup();
  resolve(run);
  run.fields.date.value = 'manual';
  run.context.PrimeFaces = { ajax: { Queue: { isEmpty: () => false } } };
  run.clock.advance(4000);
  assert.equal(run.fields.date.value, 'manual');
});

test('navigation in the same document cancels late writes', () => {
  const run = setup();
  resolve(run);
  run.fields.date.value = 'manual';
  run.context.location.href =
    'https://www.panorama.prod.ehealthontario.ca/recordImms/other';
  run.clock.advance(4000);
  assert.equal(run.fields.date.value, 'manual');
});

test('a deferred control in another connected form cancels late writes', () => {
  const run = setup();
  resolve(run);
  run.fields.consent.form = { isConnected: true };
  run.fields.date.value = 'manual';
  run.clock.advance(4000);
  assert.equal(run.fields.date.value, 'manual');
});

test('trusted funding-radio takeover also cancels the operation', () => {
  const run = setup();
  resolve(run);
  run.manual({ id: 'fundedRadio:selectOneRadio:1' });
  run.fields.date.value = 'manual';
  run.clock.advance(4000);
  assert.equal(run.fields.date.value, 'manual');
});
