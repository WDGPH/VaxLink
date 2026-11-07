import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Import the real popup module without opening its UI.
const previousDocument = globalThis.document;
globalThis.document = { addEventListener() {} };
const { sendAutoFillToActiveTab } = await import('../extension/popup.js');
if (previousDocument === undefined) delete globalThis.document;
else globalThis.document = previousDocument;
const manifest = JSON.parse(
  readFileSync(new URL('../extension/manifest.json', import.meta.url))
);
const panorama =
  'https://trpanoramadhir.prod.ehealthontario.ca/recordImms/detail';
const payload = {
  lot: 'SYNTHETIC',
  _vaxlinkQueueContext: { recordId: 'keep-this-dose' }
};
const previousChrome = globalThis.chrome;

function setup(
  t,
  { url = panorama, health, missingReceiver = false, navigateOnSend } = {}
) {
  const messages = [];
  const injections = [];
  let currentUrl = url;
  let first = true;
  const chrome = {
    runtime: { lastError: null, getManifest: () => manifest },
    tabs: {
      query(_query, done) {
        queueMicrotask(() => done([{ id: 42, url: currentUrl }]));
      },
      sendMessage(id, message, options, done) {
        messages.push({ id, message, options });
        if (message.action === 'getIntegrationHealth') return done(health);
        if (first && missingReceiver) {
          first = false;
          if (navigateOnSend) currentUrl = navigateOnSend;
          chrome.runtime.lastError = {
            message: 'Receiving end does not exist'
          };
          done();
          chrome.runtime.lastError = null;
        } else done({ success: true });
      }
    },
    scripting: {
      executeScript(request, done) {
        injections.push(request);
        done();
      }
    }
  };
  globalThis.chrome = chrome;
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });
  return { messages, injections };
}

test('popup rejects unsupported targets before sending a payload or injecting', async (t) => {
  for (const url of [
    'https://clinic.inputhealth.com/chart',
    'https://example.org/recordImms/detail',
    panorama.replace('/recordImms/detail', '/login')
  ]) {
    const run = setup(t, { url, missingReceiver: true });
    await assert.rejects(
      sendAutoFillToActiveTab(payload),
      /supported Panorama/
    );
    assert.equal(run.messages.length, 0);
    assert.equal(run.injections.length, 0);
  }
});

test('missing tab URL needs a Panorama handshake and cannot reuse old InputHealth support', async (t) => {
  for (const category of [
    'inputhealth',
    'unsupported',
    'panorama-immunization'
  ]) {
    const run = setup(t, {
      url: '',
      health: { schemaVersion: 1, category, initialized: { listener: true } }
    });
    if (category === 'panorama-immunization')
      assert.equal((await sendAutoFillToActiveTab(payload)).success, true);
    else
      await assert.rejects(
        sendAutoFillToActiveTab(payload),
        /supported Panorama/
      );
    assert.equal(run.messages[0].message.action, 'getIntegrationHealth');
    assert.equal(
      run.messages.filter(({ message }) => message.action === 'autoFill')
        .length,
      category === 'panorama-immunization' ? 1 : 0
    );
    assert.equal(run.injections.length, 0);
  }
});

test('navigation between delivery and recovery prevents injection into the new page', async (t) => {
  const run = setup(t, {
    missingReceiver: true,
    navigateOnSend: 'https://clinic.inputhealth.com/chart'
  });
  await assert.rejects(sendAutoFillToActiveTab(payload), /supported Panorama/);
  assert.equal(run.messages.length, 1);
  assert.equal(run.injections.length, 0);
});

test('supported Panorama recovery loads the actual package dependencies in the top frame', async (t) => {
  const run = setup(t, { missingReceiver: true });
  assert.equal((await sendAutoFillToActiveTab(payload)).success, true);
  assert.deepEqual(run.injections, [
    {
      target: { tabId: 42, frameIds: [0] },
      files: manifest.content_scripts[0].js
    }
  ]);
  assert.equal(run.messages.length, 2);
  assert.ok(run.messages.every(({ options }) => options.frameId === 0));
});
