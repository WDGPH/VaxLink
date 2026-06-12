/**
 * onHandsFreeKeydown Tab/Enter buffered branch (content.js).
 *
 * Every printable keystroke on a supported page lands in scannerBuffer; the
 * Tab/Enter branch used to preventDefault() whenever the buffer was non-empty,
 * eating a nurse's navigation key when she typed a short value (dose, search
 * text) and pressed Tab/Enter within the 1.5s gap window. The branch is now
 * gated on isLikelyScannerSequence(): >= SCAN_MIN_LENGTH chars typed at
 * machine speed.
 *
 * content.js is a classic browser script and cannot be imported directly, so
 * this mirrors the predicate and branch decision — keep in sync with
 * content.js (SCAN_* constants, isLikelyScannerSequence, onHandsFreeKeydown).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const SCAN_MIN_LENGTH = 8;
const SCAN_MAX_DURATION_MS = 6000;
const SCAN_MAX_AVG_INTERVAL_MS = 220;

// Mirrored from content.js isLikelyScannerSequence (parameterized on state).
function isLikelyScannerSequence(buffer, startedAt, lastAt) {
  const value = String(buffer || '');
  if (value.length < SCAN_MIN_LENGTH) return false;
  if (!startedAt || !lastAt) return false;
  const duration = lastAt - startedAt;
  if (duration < 0 || duration > SCAN_MAX_DURATION_MS) return false;
  const avgInterval = duration / Math.max(value.length - 1, 1);
  return avgInterval <= SCAN_MAX_AVG_INTERVAL_MS;
}

// Mirrored decision from the onHandsFreeKeydown Tab/Enter branch: intercept
// (preventDefault) only when the buffer is non-empty AND scanner-like.
function shouldInterceptSeparatorKey(buffer, startedAt, lastAt) {
  if (!buffer) return false;
  return isLikelyScannerSequence(buffer, startedAt, lastAt);
}

function typedState(text, msPerChar) {
  const startedAt = 1_000_000;
  const lastAt = startedAt + msPerChar * Math.max(text.length - 1, 1);
  return { buffer: text, startedAt, lastAt };
}

test('nurse typing a short dose value then Enter is NOT intercepted', () => {
  const s = typedState('0.5', 300);
  assert.equal(shouldInterceptSeparatorKey(s.buffer, s.startedAt, s.lastAt), false);
});

test('nurse typing a word at human speed then Tab is NOT intercepted', () => {
  // 9 chars at ~400ms/char — fast typist territory, still far from a scanner.
  const s = typedState('FLUCELVAX', 400);
  assert.equal(shouldInterceptSeparatorKey(s.buffer, s.startedAt, s.lastAt), false);
});

test('short fast input below SCAN_MIN_LENGTH is NOT intercepted', () => {
  const s = typedState('FLU', 50);
  assert.equal(shouldInterceptSeparatorKey(s.buffer, s.startedAt, s.lastAt), false);
});

test('scanner burst (GTIN segment at machine speed) IS intercepted', () => {
  const s = typedState('0100628451000020', 20);
  assert.equal(shouldInterceptSeparatorKey(s.buffer, s.startedAt, s.lastAt), true);
});

test('lot-only scan at machine speed IS intercepted', () => {
  const s = typedState('10Y016312', 30);
  assert.equal(shouldInterceptSeparatorKey(s.buffer, s.startedAt, s.lastAt), true);
});

test('empty buffer never intercepts via this branch', () => {
  assert.equal(shouldInterceptSeparatorKey('', 0, 0), false);
});
