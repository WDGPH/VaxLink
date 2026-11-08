import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDate,
  parseGS1Barcode,
  parseDateToLocal,
  getExpiryStatus
} from '../extension/popup-parser.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('rejects impossible expiry dates and preserves GS1 month-end dates', () => {
  for (const value of ['261340', '260000', '260230', '270229']) {
    assert.equal(formatDate(value), null, value);
  }
  for (const value of [
    '02/29/2027',
    '2026-13-40',
    '2026-02-30T00:00:00Z',
    '2026-2-30',
    '02/30/26',
    '2026-02-20Tgarbage'
  ]) {
    assert.equal(parseDateToLocal(value), null, value);
    assert.equal(getExpiryStatus(value).flag, 'unknown', value);
  }
  assert.equal(formatDate('280200'), '02/29/2028');
  assert.equal(formatDate('270200'), '02/28/2027');
  assert.ok(parseDateToLocal('02/29/2028'));
  assert.ok(parseDateToLocal('2028-02-29T00:00:00Z'));
  assert.ok(parseDateToLocal('2028-02-29T23:00:00-05:00'));
  assert.throws(
    () => parseGS1Barcode('01006284510000201726134010LOT123'),
    /AI\(17\) expiry date is invalid/
  );
});

test('counts calendar days across daylight saving time', () => {
  const script = String.raw`
    import { getExpiryStatus } from './apps/extension/popup-parser.js';
    import { readFileSync } from 'node:fs';
    import vm from 'node:vm';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-03-08T12:00:00-04:00'])); }
      static now() { return new RealDate('2026-03-08T12:00:00-04:00').getTime(); }
    };
    const statuses = [getExpiryStatus];
    for (const file of ['background.js', 'content.js']) {
      const source = readFileSync('./apps/extension/' + file, 'utf8');
      const fn = source.match(/function getExpiryStatus\(value\) \{[\s\S]*?\n\}/)[0];
      const context = vm.createContext({ Date });
      vm.runInContext(readFileSync('./apps/extension/shared/expiry-date.js', 'utf8'), context);
      statuses.push(vm.runInContext('(' + fn + ')', context));
    }
    console.log(JSON.stringify(statuses.map(status => ['2026-03-09', '2026-04-08', '2026-2-30'].map(status))));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, TZ: 'America/Toronto' },
      encoding: 'utf8'
    })
  );
  assert.deepEqual(
    result.map((statuses) =>
      statuses.map(({ flag, daysRemaining }) => [flag, daysRemaining])
    ),
    Array.from({ length: 3 }, () => [
      ['expiring_soon', 1],
      ['valid', 31],
      ['unknown', null]
    ])
  );
});
