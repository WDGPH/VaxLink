import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/popup.js', import.meta.url),
  'utf8'
);
const code = source.slice(
  source.indexOf('function isSupportedPanoramaUrl('),
  source.indexOf('\nfunction handleAutoFillResponse')
);
const supported =
  'https://panorama.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/form';
const ready = {
  supported: true,
  ready: true,
  context: { document: 'doc', form: 'form' }
};

function harness({
  url = supported,
  probe = { result: true, documentId: 'original' },
  replies = [ready],
  injectFails = false,
  fillFails = false
} = {}) {
  const messages = [];
  const scripts = [];
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      query(_query, callback) {
        queueMicrotask(() => callback([{ id: 1, url }]));
      },
      sendMessage(_id, message, options, callback) {
        messages.push({ message, options });
        if (message.action === 'getPanoramaIntegration') {
          const reply = replies.shift();
          if (!reply)
            chrome.runtime.lastError = {
              message: 'Receiving end does not exist'
            };
          callback(reply);
          chrome.runtime.lastError = null;
          return;
        }
        if (fillFails) chrome.runtime.lastError = { message: 'Document gone' };
        callback(fillFails ? undefined : { success: true });
        chrome.runtime.lastError = null;
      }
    },
    scripting: {
      executeScript(details, callback) {
        scripts.push(details);
        if (details.func) return callback(probe ? [probe] : []);
        if (injectFails)
          chrome.runtime.lastError = { message: 'Document gone' };
        callback();
        chrome.runtime.lastError = null;
      }
    }
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout });
  vm.runInContext(code, context);
  return {
    messages,
    scripts,
    send: () =>
      new Promise((resolve) =>
        context.sendAutoFillMessage(1, { lot: 'test' }, resolve)
      )
  };
}

test('direct fill sends the observed context to the probed document', async () => {
  const h = harness();
  assert.equal((await h.send()).success, true);
  assert.deepEqual(
    h.messages.map(({ message }) => message.action),
    ['getPanoramaIntegration', 'autoFill']
  );
  assert.equal(h.messages[1].options.documentId, 'original');
  assert.equal(h.messages[1].message.expectedContext.form, 'form');
});

test('missing URL needs an existing ready integration and never authorizes injection', async () => {
  const h = harness({ url: null, replies: [null] });
  assert.equal((await h.send()).success, false);
  assert.deepEqual(
    h.messages.map(({ message }) => message.action),
    ['getPanoramaIntegration']
  );
  assert.equal(h.scripts.length, 0);
});

test('recovery stays on the probed document and requires a ready handshake', async () => {
  const h = harness({ replies: [null, ready] });
  assert.equal((await h.send()).success, true);
  assert.deepEqual(Array.from(h.scripts[1].target.documentIds), ['original']);
  assert.equal(h.messages[1].options.documentId, 'original');
  assert.equal(h.messages[2].options.documentId, 'original');
});

test('missing document identity, unready form, and navigation fail without delivery', async () => {
  for (const options of [
    { probe: null },
    { replies: [{ ...ready, ready: false }] },
    { replies: [null], injectFails: true }
  ]) {
    const h = harness(options);
    assert.equal((await h.send()).success, false);
    assert.equal(
      h.messages.some(({ message }) => message.action === 'autoFill'),
      false
    );
  }
});

test('failed delivery does not retry against another document', async () => {
  const h = harness({ fillFails: true });
  assert.equal((await h.send()).success, false);
  assert.equal(h.scripts.length, 1);
  assert.equal(
    h.messages.filter(({ message }) => message.action === 'autoFill').length,
    1
  );
});

test('persistent queue review is visible outside Settings and stale acknowledgements cannot hide it', async () => {
  const reviewKey = 'vaxlink_queue_review_notice_v1';
  const notice = { hidden: true };
  let acknowledgeClick;
  const acknowledge = {
    addEventListener: (_type, fn) => {
      acknowledgeClick = fn;
    }
  };
  let changed;
  let reply;
  const requests = [];
  const errors = [];
  const context = vm.createContext({
    QUEUE_REVIEW_NOTICE_KEY: reviewKey,
    document: {
      getElementById: (id) =>
        id === 'queueReviewNotice' ? notice : acknowledge
    },
    getLocalStorage: async () => ({ [reviewKey]: 'first' }),
    chrome: {
      storage: {
        onChanged: {
          addListener: (fn) => {
            changed = fn;
          }
        }
      },
      runtime: {
        sendMessage: (request, callback) => {
          requests.push(request);
          reply = callback;
        }
      }
    },
    writeOutput: (message) => errors.push(message)
  });
  const init = source.match(/^function initQueueReviewNotice\([^]*?^}/m)[0];
  vm.runInContext(init, context);
  context.initQueueReviewNotice();
  await Promise.resolve();
  assert.equal(notice.hidden, false);
  acknowledgeClick();
  assert.equal(requests[0].reviewToken, 'first');
  changed({ [reviewKey]: { newValue: 'second' } }, 'local');
  reply({ success: true, cleared: true });
  assert.equal(notice.hidden, false);
  acknowledgeClick();
  reply({ success: false });
  assert.equal(notice.hidden, false);
  assert.equal(errors.length, 1);
  acknowledgeClick();
  reply({ success: true, cleared: true });
  assert.equal(notice.hidden, true);
  assert.ok(
    requests.every((request) => request.action === 'acknowledgeQueueReview')
  );
  const html = readFileSync(
    new URL('../extension/popup.html', import.meta.url),
    'utf8'
  );
  assert.ok(
    html.indexOf('id="queueReviewNotice"') < html.indexOf('id="settingsPanel"')
  );
});
