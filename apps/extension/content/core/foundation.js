// Part of VaxLink content-script bundle. Classic script (no ES imports);
// all content files share one global lexical scope, loaded in manifest order.

// Flip to true while developing (content script isolated world).
const VAXLINK_CONTENT_DEBUG = false;
function vlog(...args) {
  if (VAXLINK_CONTENT_DEBUG) console.log('[VaxLink]', ...args);
}

const HANDS_FREE_BUILD = '2026-03-11-hf-recovery-1';
vlog('content script', location.href, 'readyState=', document.readyState, 'build=', HANDS_FREE_BUILD);

const WORKFLOW_MODE_KEY = 'vaxlink_workflow_mode_v1';
const LEGACY_POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
const LEGACY_HANDS_FREE_KEY = 'hands_free_scan_autofill_enabled';
const LEGACY_REMOTE_MODE_KEY = 'hands_free_scan_mode_v1';
const MULTIPLE_INJECT_QUEUE_KEY = 'multiple_inject_queue_v1';
const INVENTORY_BATCH_KEY = 'inventory_scan_batch_v1';
const ADMIN_DATETIME_AUTOFILL_KEY = 'vaxlink_administered_datetime_autofill_v1';
const AUDIO_FEEDBACK_KEY = 'vaxlink_audio_feedback_enabled_v1';
const HUD_POSITION_KEY = 'vaxlink_hud_position_v1';
const HUD_HIDDEN_KEY = 'vaxlink_hud_hidden_v1';
let activeWorkflowMode = 'single';
let adminDateTimeAutofillEnabled = true;
let audioFeedbackEnabled = true;
let hudInitialized = false;
let lastAutoDrainAt = 0;
let lastVaxlinkFillAt = 0;
let scannerBuffer = '';
let scannerStartedAt = 0;
let scannerLastAt = 0;
let scannerIdleTimer = null;
let scannerInputTimer = null;
let lastHandledScanValue = '';
let lastHandledScanAt = 0;
let lastInputCandidate = '';
let lastInputCandidateAt = 0;
let audioContextRef = null;
let expiryGuardHost = null;
let expiryGuardRoot = null;

const SCAN_MIN_LENGTH = 8;
const SCAN_MAX_DURATION_MS = 6000;
const SCAN_MAX_AVG_INTERVAL_MS = 220;
const SCAN_CHAR_GAP_RESET_MS = 1500;
const SCAN_IDLE_COMMIT_MS = 1500;
const INPUT_CANDIDATE_TTL_MS = 5000;

function normalizeAdminDateTimeAutofillSetting(stored) {
  return !(stored && stored[ADMIN_DATETIME_AUTOFILL_KEY] === false);
}

function normalizeAudioFeedbackSetting(stored) {
  return !(stored && stored[AUDIO_FEEDBACK_KEY] === false);
}

function getAudioContext() {
  if (audioContextRef) return audioContextRef;
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) return null;
  audioContextRef = new AudioContextCtor();
  return audioContextRef;
}

function playAudioCue(kind) {
  if (!audioFeedbackEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }

  const playTone = (frequency, durationMs, type = 'sine', gainValue = 0.06, delayMs = 0) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + (delayMs / 1000));
    gain.gain.exponentialRampToValueAtTime(gainValue, ctx.currentTime + (delayMs / 1000) + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (delayMs / 1000) + (durationMs / 1000));
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime + (delayMs / 1000));
    oscillator.stop(ctx.currentTime + (delayMs / 1000) + (durationMs / 1000) + 0.02);
  };

  if (kind === 'success') {
    playTone(880, 90, 'sine', 0.045, 0);
    playTone(1175, 120, 'sine', 0.05, 95);
    return;
  }
  if (kind === 'error') {
    playTone(220, 220, 'square', 0.055, 0);
    return;
  }
  if (kind === 'duplicate') {
    playTone(440, 90, 'square', 0.05, 0);
    playTone(330, 110, 'square', 0.05, 120);
    return;
  }
  if (kind === 'expiry_warning') {
    playTone(980, 110, 'square', 0.06, 0);
    playTone(980, 110, 'square', 0.06, 170);
  }
}

function normalizeWorkflowMode(stored) {
  const direct = stored && stored[WORKFLOW_MODE_KEY];
  if (direct === 'single' || direct === 'multiple' || direct === 'inventory') {
    return direct;
  }

  const legacyPopup = stored && stored[LEGACY_POPUP_MODE_KEY];
  if (legacyPopup === 'inventory') {
    return 'inventory';
  }
  if (legacyPopup === 'inject') {
    return 'single';
  }

  const legacyRemote = stored && stored[LEGACY_REMOTE_MODE_KEY];
  if (legacyRemote === 'tray') {
    return 'multiple';
  }
  if (legacyRemote === 'autofill') {
    return 'single';
  }

  if (stored && stored[LEGACY_HANDS_FREE_KEY]) {
    return 'single';
  }

  return 'single';
}

function getQueueStorageKeyForWorkflow(mode) {
  if (mode === 'multiple') {
    return MULTIPLE_INJECT_QUEUE_KEY;
  }
  if (mode === 'inventory') {
    return INVENTORY_BATCH_KEY;
  }
  return '';
}

function logAnalyticsEvent(eventType, payload = {}) {
  try {
    chrome.runtime.sendMessage({ action: 'logAnalyticsEvent', eventType, payload }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    // Ignore analytics failures on client pages.
  }
}

function setupMessageListener() {
  if (window.__vaxlinkMessageListenerInitialized) {
    return;
  }
  window.__vaxlinkMessageListenerInitialized = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    vlog('autoFill message', request?.action, request?.data);
    if (request.action === 'autoFill') {
      // Only the top frame should respond to autoFill messages from the popup.
      // With all_frames:true, iframes also receive the message; if an iframe
      // responds first with { success: false } (no matching fields), the popup
      // sees a failure even though the main frame would succeed. Returning
      // false lets the top frame's response through. (Edge delivers iframe
      // responses before the main frame more often than Chrome, causing
      // multi-inject to fail.)
      if (window.top !== window.self) {
        return false;
      }
      try {
        const result = autoFillTelus(request.data);
        vlog('autoFillTelus', result?.status, result);
        sendResponse({
          success: isAutofillSuccess(result),
          pending: isAutofillPending(result),
          status: result?.status || 'failed',
          error: result?.error || ''
        });
      } catch (e) {
        console.error('Error in autoFillTelus:', e);
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }
    vlog('unknown action', request?.action);
    sendResponse({ success: false, error: 'Unknown action' });
    return true;
  });
  vlog('message listener registered');
}
