import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createBackgroundHarness } from './helpers/clinic-sim.js';
import { initializeUpdateNotice } from '../extension/popup-update-notice.js';

const UPDATE_NOTICE_KEY = 'vaxlink_update_notice_version_v1';

function createPopupNotice(store) {
  const notice = { hidden: true };
  const dismissButton = {
    disabled: false,
    addEventListener(event, callback) {
      assert.equal(event, 'click');
      this.click = callback;
    }
  };
  const getStored = async () => ({ [UPDATE_NOTICE_KEY]: store.get(UPDATE_NOTICE_KEY) });
  const removeStored = async (key) => store.delete(key);
  return { notice, dismissButton, getStored, removeStored };
}

test('only an extension update queues a notice for the next popup open', async () => {
  const harness = createBackgroundHarness(null, { manifestVersion: '1.2.0' });
  harness.triggerInstalled({ reason: 'install' });
  assert.equal(harness.storageData.has(UPDATE_NOTICE_KEY), false);
  harness.triggerInstalled({ reason: 'chrome_update' });
  assert.equal(harness.storageData.has(UPDATE_NOTICE_KEY), false);

  harness.triggerInstalled({ reason: 'update', previousVersion: '1.1.3' });
  assert.equal(harness.storageData.get(UPDATE_NOTICE_KEY), '1.2.0');

  const popup = createPopupNotice(harness.storageData);
  await initializeUpdateNotice(popup);
  assert.equal(popup.notice.hidden, false);
  assert.equal(harness.storageData.get(UPDATE_NOTICE_KEY), '1.2.0');

  await popup.dismissButton.click();
  assert.equal(popup.notice.hidden, true);
  assert.equal(harness.storageData.has(UPDATE_NOTICE_KEY), false);

  const nextPopup = createPopupNotice(harness.storageData);
  await initializeUpdateNotice(nextPopup);
  assert.equal(nextPopup.notice.hidden, true);
});

test('an update arriving while the notice is open remains pending', async () => {
  const store = new Map([[UPDATE_NOTICE_KEY, '1.2.0']]);
  const popup = createPopupNotice(store);
  await initializeUpdateNotice(popup);
  store.set(UPDATE_NOTICE_KEY, '1.2.1');

  await popup.dismissButton.click();
  assert.equal(store.get(UPDATE_NOTICE_KEY), '1.2.1');
  const nextPopup = createPopupNotice(store);
  await initializeUpdateNotice(nextPopup);
  assert.equal(nextPopup.notice.hidden, false);
});

test('popup notice gives the supported page refresh instruction without a new permission', () => {
  const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.match(html, /VaxLink was updated\. Reload any already-open Panorama immunization or InputHealth chart page before using VaxLink\./);
  assert.equal(manifest.permissions.includes('notifications'), false);
});
