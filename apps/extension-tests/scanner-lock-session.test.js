import assert from "node:assert/strict";
import test from "node:test";

import "../extension/scanner/scanner-lock-session.js";

const {
  buildLockedScanQueueContext,
  closeLockedScannerSession,
  createLockedScannerSession,
  isLockedScannerSession,
  normalizeMachineIdleState,
  shouldQueueScannerScan
} = globalThis.VaxLinkScannerLockSession;

test("only the locked machine state diverts scanner input into the queue", () => {
  assert.equal(normalizeMachineIdleState("unexpected"), "active");
  assert.equal(shouldQueueScannerScan("active"), false);
  assert.equal(shouldQueueScannerScan("idle"), false);
  assert.equal(shouldQueueScannerScan("locked"), true);
});

test("a lock session pins the active chart tab without storing patient data", () => {
  const session = createLockedScannerSession({
    now: "2026-07-28T12:00:00.000Z",
    activeTab: { id: 41, windowId: 7, url: "https://example.invalid/patient/secret" }
  });

  assert.equal(isLockedScannerSession(session), true);
  assert.equal(session.tabId, 41);
  assert.equal(session.windowId, 7);
  assert.equal("url" in session, false);

  const context = buildLockedScanQueueContext(session);
  assert.equal(context.captured_while_locked, true);
  assert.equal(context.lock_session_id, session.id);
  assert.equal(context.lock_session_tab_id, 41);
});

test("unlocking closes the session but preserves it for queue review", () => {
  const locked = createLockedScannerSession({ now: "2026-07-28T12:00:00.000Z" });
  const unlocked = closeLockedScannerSession(locked, "2026-07-28T12:05:00.000Z");
  assert.equal(unlocked.state, "active");
  assert.equal(unlocked.unlockedAt, "2026-07-28T12:05:00.000Z");
  assert.equal(isLockedScannerSession(unlocked), false);
});
