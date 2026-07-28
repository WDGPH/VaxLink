(() => {
const SCANNER_LOCK_STATE_KEY = "vaxlink_scanner_lock_state_v1";
const SCANNER_LOCK_SESSION_KEY = "vaxlink_scanner_lock_session_v1";

function normalizeMachineIdleState(value) {
  if (value === "locked" || value === "idle") return value;
  return "active";
}

function shouldQueueScannerScan(idleState) {
  return normalizeMachineIdleState(idleState) === "locked";
}

function createLockedScannerSession({ now = new Date(), activeTab = null } = {}) {
  const timestamp = now instanceof Date ? now : new Date(now);
  const lockedAt = Number.isNaN(timestamp.getTime()) ? new Date().toISOString() : timestamp.toISOString();
  const tabId = Number.isInteger(activeTab?.id) ? activeTab.id : null;
  const windowId = Number.isInteger(activeTab?.windowId) ? activeTab.windowId : null;
  return {
    id: `locked-${lockedAt}-${Math.random().toString(36).slice(2, 10)}`,
    state: "locked",
    lockedAt,
    unlockedAt: "",
    tabId,
    windowId
  };
}

function closeLockedScannerSession(session, now = new Date()) {
  if (!session || typeof session !== "object") return null;
  const timestamp = now instanceof Date ? now : new Date(now);
  return {
    ...session,
    state: "active",
    unlockedAt: Number.isNaN(timestamp.getTime()) ? new Date().toISOString() : timestamp.toISOString()
  };
}

function isLockedScannerSession(session) {
  return !!(session && session.state === "locked" && session.id);
}

function buildLockedScanQueueContext(session) {
  if (!isLockedScannerSession(session)) return {};
  return {
    captured_while_locked: true,
    lock_session_id: session.id,
    lock_session_locked_at: session.lockedAt || "",
    lock_session_tab_id: session.tabId,
    lock_session_window_id: session.windowId
  };
}

globalThis.VaxLinkScannerLockSession = Object.freeze({
  SCANNER_LOCK_STATE_KEY,
  SCANNER_LOCK_SESSION_KEY,
  normalizeMachineIdleState,
  shouldQueueScannerScan,
  createLockedScannerSession,
  closeLockedScannerSession,
  isLockedScannerSession,
  buildLockedScanQueueContext
});
})();
