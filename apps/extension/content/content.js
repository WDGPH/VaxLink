// Part of VaxLink content-script bundle. Classic script (no ES imports);
// all content files share one global lexical scope, loaded in manifest order.

// --- registration (was mid-file in the monolith) ---

// Register listener immediately
setupMessageListener();
initHandsFreeScanner();

// Also re-register when DOM is ready in case of timing issues
document.addEventListener('DOMContentLoaded', () => {
  vlog('DOMContentLoaded');
});

// --- click-reduction bootstrap ---
function initClickReductionFeatures() {
  if (!isHandsFreeSupportedPage()) return;

  if (document.body) {
    initHud();
    initPostSaveWatcher();
    initPanoramaMultipleGridWatcher();
    initPanoramaMultiStepWatcher();
    // Initial auto-drain attempt after a short settle delay
    if (activeWorkflowMode === 'multiple') {
      setTimeout(() => tryAutoDrain(), 1200);
    }
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      initHud();
      initPostSaveWatcher();
      initPanoramaMultipleGridWatcher();
      initPanoramaMultiStepWatcher();
      if (activeWorkflowMode === 'multiple') {
        setTimeout(() => tryAutoDrain(), 1200);
      }
    });
  }
}

// Re-run when mode changes so HUD visibility updates
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (WORKFLOW_MODE_KEY in changes) {
    updateHudState();
    if (activeWorkflowMode === 'multiple') {
      setTimeout(() => tryAutoDrain(), 800);
    }
  }
});

if (document.readyState === 'loading') {
  // Normal page load: DOMContentLoaded fires well after chrome.storage.local.get
  // resolves, so activeWorkflowMode will be correctly set by the time
  // initClickReductionFeatures runs.
  document.addEventListener('DOMContentLoaded', initClickReductionFeatures);
} else {
  // Page is already loaded (PrimeFaces SPA navigation, or content script injected
  // late).  initHandsFreeScanner's chrome.storage.local.get callback is async and
  // hasn't fired yet, so activeWorkflowMode is still the default 'single'.
  // Deferring by one task tick gives the storage callback a chance to set the real
  // mode before initClickReductionFeatures reads it.  The storage callback also
  // schedules its own re-kick (maybeAutoFillPanoramaMultipleGrid + tryAutoDrain)
  // as a safety net in case even this deferred call races.
  setTimeout(initClickReductionFeatures, 0);
}
