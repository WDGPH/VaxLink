// Part of VaxLink content-script bundle. Classic script (no ES imports);
// all content files share one global lexical scope, loaded in manifest order.

let toastHost = null;
let toastRoot = null;
// Two stacked slots so a persistent expired warning and routine feedback
// (queued / duplicate / mode switch) can coexist instead of clobbering each
// other (issue #28): warning on top, routine toasts below it.
let toastWarningSlot = null;
let toastRoutineSlot = null;
let toastDismissTimer = null;

function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastRoot;
  toastHost = document.createElement('div');
  toastHost.id = 'vaxlink-toast-host';
  const shadow = toastHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .vl-toast-stack {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      pointer-events: none;
    }
    .vl-toast {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      padding: 10px 16px;
      border-radius: 8px;
      color: #fff;
      max-width: 360px;
      box-shadow: 0 4px 14px rgba(0,0,0,.25);
      opacity: 0;
      transform: translateY(-8px);
      transition: opacity .2s, transform .2s;
      pointer-events: none;
    }
    .vl-toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    .vl-toast.valid   { background: #047857; }
    .vl-toast.expiring { background: #b45309; }
    .vl-toast.expired  { background: #b91c1c; }
    .vl-toast.info     { background: #0e7490; }
    .vl-toast.duplicate { background: #52525b; }
    .vl-toast.persistent { pointer-events: auto; }
    .vl-toast-dismiss {
      margin-top: 8px;
      padding: 4px 10px;
      border: 1px solid rgba(255,255,255,.6);
      border-radius: 5px;
      background: rgba(0,0,0,.25);
      color: #fff;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .vl-toast-dismiss:hover { background: rgba(0,0,0,.4); }
    .vl-toast-title { font-weight: 600; margin-bottom: 2px; }
    .vl-toast-detail { opacity: .9; font-size: 12px; }
    .vl-toast-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .vl-toast-action {
      padding: 5px 10px;
      border: 1px solid rgba(255,255,255,.65);
      border-radius: 6px;
      background: rgba(255,255,255,.14);
      color: #fff;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .vl-toast-action:hover { background: rgba(255,255,255,.22); }
    .vl-toast-action.secondary {
      background: rgba(0,0,0,.22);
      border-color: rgba(255,255,255,.35);
    }
  `;
  shadow.appendChild(style);
  toastRoot = document.createElement('div');
  toastRoot.className = 'vl-toast-stack';
  toastWarningSlot = document.createElement('div');
  toastRoutineSlot = document.createElement('div');
  toastRoot.appendChild(toastWarningSlot);
  toastRoot.appendChild(toastRoutineSlot);
  shadow.appendChild(toastRoot);
  document.body.appendChild(toastHost);
  return toastRoot;
}

function showVaxlinkToast(data, durationMs = 4000) {
  if (!isHandsFreeSupportedPage()) return;
  ensureToastHost();

  // Routine toasts share one slot and one auto-dismiss timer; the persistent
  // expired warning lives in its own slot above and is never replaced by them.
  const showRoutineToast = (html, ms, options = {}) => {
    if (toastDismissTimer) {
      clearTimeout(toastDismissTimer);
      toastDismissTimer = null;
    }
    toastRoutineSlot.innerHTML = html;
    if (!options.persistent) {
      toastDismissTimer = setTimeout(() => dismissToast(toastRoutineSlot), ms);
    }
  };

  if (data._commandMode) {
    const modeLabels = { single: 'Single Inject', multiple: 'Multiple Inject', inventory: 'Inventory' };
    const sourceDetail = data._commandSource === 'hud'
      ? 'Switched from VaxLink HUD'
      : 'Switched via scanner command';
    showRoutineToast(`<div class="vl-toast info show">
      <div class="vl-toast-title">Mode: ${modeLabels[data._commandMode] || data._commandMode}</div>
      <div class="vl-toast-detail">${sourceDetail}</div>
    </div>`, durationMs);
    return;
  }

  if (data._queueEmpty) {
    showRoutineToast(`<div class="vl-toast info show">
      <div class="vl-toast-title">Queue empty</div>
      <div class="vl-toast-detail">Scan more vaccines or switch to Single mode</div>
    </div>`, durationMs);
    return;
  }

  if (data._stepMatchMissing) {
    showRoutineToast(`<div class="vl-toast info show">
      <div class="vl-toast-title">No queued match for this agent</div>
      <div class="vl-toast-detail">Panorama selected an agent that is not represented in the queue. VaxLink left the queue unchanged.</div>
    </div>`, durationMs + 2000);
    return;
  }

  if (data._sharedFundingLotFilterRequired || data._sharedFundingLotSwitchFilter) {
    const productLabel = data._sharedFundingLotLabel || data.tradename || data.generic_name || data.name || 'This product';
    const needsInitialChoice = !!data._sharedFundingLotFilterRequired;
    const title = needsInitialChoice ? 'Choose PF or NPF' : 'Try the other funding bucket';
    const detail = needsInitialChoice
      ? `${productLabel} can use the same lot in both Panorama funding buckets.`
      : `${productLabel}${data.lot ? ` lot ${data.lot}` : ''} was not found under ${getPanoramaFundingLabel(data._fundedRadioValue)}.`;
    const followUp = needsInitialChoice
      ? `Pick Publicly Funded or Non-Publicly Funded and VaxLink will continue automatically.`
      : 'Pick the funding bucket to try and VaxLink will continue automatically.';

    showRoutineToast(`<div class="vl-toast info persistent show">
      <div class="vl-toast-title">${escapeToastHtml(title)}</div>
      <div class="vl-toast-detail">${escapeToastHtml(detail)}</div>
      <div class="vl-toast-detail">${escapeToastHtml(followUp)}</div>
      <div class="vl-toast-actions">
        <button class="vl-toast-action" type="button" data-vl-funded-choice="PUBLICLY_FUNDED">Publicly Funded</button>
        <button class="vl-toast-action" type="button" data-vl-funded-choice="NON_PUBLICLY_FUNDED">Non-Publicly Funded</button>
        <button class="vl-toast-action secondary" type="button" data-vl-funded-choice-dismiss="true">Not now</button>
      </div>
    </div>`, durationMs, { persistent: true });

    toastRoutineSlot.querySelectorAll('[data-vl-funded-choice]').forEach((button) => {
      button.addEventListener('click', async () => {
        const fundedChoice = button.getAttribute('data-vl-funded-choice');
        if (toastDismissTimer) {
          clearTimeout(toastDismissTimer);
          toastDismissTimer = null;
        }
        toastRoutineSlot.innerHTML = '';
        const radioResult = setPanoramaFundedRadioValue(fundedChoice);
        if (radioResult === 'not_found') {
          showRoutineToast(`<div class="vl-toast info show">
            <div class="vl-toast-title">Funding selector not found</div>
            <div class="vl-toast-detail">Panorama did not expose the PF/NPF selector yet. Try again once the lot section finishes loading.</div>
          </div>`, 7000);
          return;
        }
        const autofillResult = autoFillTelus(data);
        if (isAutofillSuccess(autofillResult)) {
          await finalizeDeferredPanoramaAutofill(data);
        }
      });
    });
    const dismissBtn = toastRoutineSlot.querySelector('[data-vl-funded-choice-dismiss]');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => dismissToast(toastRoutineSlot));
    }
    return;
  }

  const label = data.tradename || data.generic_name || data.name || data.lot || 'Vaccine';
  const lot = data.lot || '';
  const flag = data.expiry_flag || getExpiryStatus(data.inventory_expiry || data.expiry || data.nvc_lot_expiry).flag;
  const expiry = data.inventory_expiry || data.expiry || data.nvc_lot_expiry || '';

  let expiryText = '';
  if (expiry) {
    const friendlyDate = expiry.length > 10 ? expiry.slice(0, 10) : expiry;
    const flagLabels = { valid: 'Valid', expiring_soon: 'Expiring soon', expired: 'Expired' };
    expiryText = `${flagLabels[flag] || 'Unknown'} (exp ${friendlyDate})`;
  }
  const detail = [lot ? `Lot ${lot}` : '', expiryText].filter(Boolean).join(' \u2014 ');

  if (data._duplicateIgnored) {
    showRoutineToast(`<div class="vl-toast duplicate show">
      <div class="vl-toast-title">Duplicate scan ignored</div>
      <div class="vl-toast-detail">${escapeToastHtml(label)} is already in the queue</div>
      ${detail ? `<div class="vl-toast-detail">${escapeToastHtml(detail)}</div>` : ''}
    </div>`, durationMs);
    return;
  }

  const cssClass = flag === 'expired' ? 'expired' : (flag === 'expiring_soon' ? 'expiring' : 'valid');
  const isExpired = flag === 'expired';
  const queuedNote = data._queuedCount
    ? `<div class="vl-toast-detail">Added to queue (${Number(data._queuedCount)} queued)</div>`
    : '';

  const toastHtml = `<div class="vl-toast ${cssClass}${isExpired ? ' persistent' : ''} show">
    <div class="vl-toast-title">${isExpired ? '\u26a0 Expired vaccine scanned' : escapeToastHtml(label)}</div>
    ${isExpired ? `<div class="vl-toast-detail">${escapeToastHtml(label)}</div>` : ''}
    ${detail ? `<div class="vl-toast-detail">${escapeToastHtml(detail)}</div>` : ''}
    ${queuedNote}
    ${isExpired ? '<button class="vl-toast-dismiss" type="button">Dismiss</button>' : ''}
  </div>`;

  if (isExpired) {
    // Persistent: own slot, no timer \u2014 stays until the nurse dismisses it
    // (issue #28). Routine toasts keep flowing in the slot below.
    toastWarningSlot.innerHTML = toastHtml;
    playAudioCue('expiry_warning');
    const dismissBtn = toastWarningSlot.querySelector('.vl-toast-dismiss');
    if (dismissBtn) dismissBtn.addEventListener('click', () => dismissToast(toastWarningSlot));
    return;
  }
  showRoutineToast(toastHtml, durationMs);
}

function dismissToast(slot) {
  const el = slot && slot.querySelector('.vl-toast');
  if (el) el.classList.remove('show');
  setTimeout(() => { if (slot) slot.innerHTML = ''; }, 300);
}

function escapeToastHtml(text) {
  const d = document.createElement('span');
  d.textContent = text;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// In-page floating HUD for multiple-inject queue
// ---------------------------------------------------------------------------

let hudHost = null;
let hudShadow = null;
let hudCountEl = null;
let hudApplyBtn = null;
let hudContainer = null;
let hudModeToggleBtn = null;
let hudQueueWrap = null;
let hudQueueListEl = null;
let hudClearBtn = null;
let hudMiniEl = null;
let hudUserHidden = false;
let hudCurrentLeft = null;
let hudCurrentTop = null;
let hudIsDragging = false;
let hudDragOffsetX = 0;
let hudDragOffsetY = 0;
let hudMiniPointerDown = false;
let hudMiniDidDrag = false;
let hudMiniDragOffsetX = 0;
let hudMiniDragOffsetY = 0;
let hudMiniDownX = 0;
let hudMiniDownY = 0;

function setHudModeToggleState(button, activeMode) {
  if (!button) return;
  const mode = activeMode === 'multiple' ? 'multiple' : 'single';
  const nextMode = mode === 'multiple' ? 'single' : 'multiple';
  const label = mode === 'multiple' ? 'Multiple' : 'Single';
  const targetLabel = nextMode === 'multiple' ? 'Multiple' : 'Single';
  button.innerHTML = `
    <span class="vl-hud-mode-top">Chart Mode</span>
    <span class="vl-hud-mode-main">
      <span class="vl-hud-mode-current">${label}</span>
      <span class="vl-hud-mode-next">Switch to ${targetLabel}</span>
    </span>
  `;
  button.dataset.mode = mode;
  button.setAttribute('aria-label', `Switch to ${targetLabel} mode`);
  button.setAttribute('title', `Switch to ${targetLabel} mode`);
}

async function setHudWorkflowMode(newMode) {
  const nextMode = newMode === 'multiple' ? 'multiple' : 'single';
  if (activeWorkflowMode === nextMode) {
    updateHudState();
    return;
  }

  activeWorkflowMode = nextMode;
  updateHudState();
  try {
    await setLocalStorage({ [WORKFLOW_MODE_KEY]: nextMode });
    logAnalyticsEvent('workflow_mode_set', { workflow: nextMode, source: 'hud_toggle' });
    showVaxlinkToast({ _commandMode: nextMode, _commandSource: 'hud' });
  } catch (error) {
    console.warn('VaxLink HUD mode switch error:', error);
  }
}

function initHud() {
  if (hudInitialized) return;
  if (!isHandsFreeSupportedPage()) return;
  hudInitialized = true;

  hudHost = document.createElement('div');
  hudHost.id = 'vaxlink-hud-host';
  hudShadow = hudHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .vl-hud {
      position: relative;
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      background:
        radial-gradient(circle at top left, rgba(125, 211, 252, .22), transparent 42%),
        linear-gradient(180deg, rgba(15, 58, 79, .96) 0%, rgba(12, 44, 61, .96) 100%);
      color: #f4fbff;
      padding: 12px;
      border-radius: 20px;
      border: 1px solid rgba(173, 216, 230, .16);
      box-shadow: 0 16px 34px rgba(3, 20, 30, .34);
      font-size: 13px;
      cursor: default;
      user-select: none;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      transition: opacity .2s, transform .2s;
      min-width: 188px;
    }
    .vl-hud.hidden { display: none; }
    .vl-hud-head {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .vl-hud-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: linear-gradient(180deg, #67e8f9 0%, #22d3ee 100%);
      box-shadow: 0 0 0 4px rgba(103, 232, 249, .12);
      flex: 0 0 auto;
    }
    .vl-hud-queue {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .vl-hud-queue.hidden { display: none; }
    .vl-hud-count {
      background: rgba(207, 250, 254, .14);
      color: #dffaff;
      border-radius: 999px;
      padding: 4px 10px;
      font-weight: 700;
      min-width: 20px;
      text-align: center;
      box-shadow: inset 0 0 0 1px rgba(207, 250, 254, .08);
    }
    .vl-hud-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 180px;
      overflow-y: auto;
    }
    .vl-hud-list.hidden { display: none; }
    .vl-hud-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: rgba(207, 250, 254, .08);
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 11.5px;
      color: #dffaff;
    }
    .vl-hud-item-label {
      min-width: 0;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .vl-hud-item-label.expired { color: #fca5a5; font-weight: 700; }
    .vl-hud-item-remove {
      background: transparent;
      border: none;
      color: rgba(232, 249, 253, .6);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
      border-radius: 6px;
      flex-shrink: 0;
    }
    .vl-hud-item-remove:hover { background: rgba(248, 113, 113, .25); color: #fff; }
    .vl-hud-clear-btn {
      background: transparent;
      color: rgba(232, 249, 253, .75);
      box-shadow: inset 0 0 0 1px rgba(232, 249, 253, .25);
    }
    .vl-hud-clear-btn:hover { background: rgba(248, 113, 113, .2); color: #fff; }
    .vl-hud-btn {
      background: #ecfeff;
      color: #0f4357;
      border: none;
      border-radius: 16px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
      letter-spacing: .01em;
      transition: transform .16s ease, box-shadow .16s ease, background .16s ease, color .16s ease;
    }
    .vl-hud-mode-toggle {
      width: 100%;
      position: relative;
      overflow: hidden;
      text-align: left;
      padding: 11px 12px 12px;
      background: linear-gradient(180deg, rgba(240, 253, 255, .18) 0%, rgba(224, 247, 250, .08) 100%);
      color: #f4fbff;
      box-shadow:
        inset 0 0 0 1px rgba(255,255,255,.12),
        0 10px 22px rgba(7, 29, 40, .22);
    }
    .vl-hud-mode-toggle[data-mode="multiple"] {
      background: linear-gradient(180deg, rgba(236, 254, 255, .98) 0%, rgba(194, 244, 248, .94) 100%);
      color: #0f4357;
      box-shadow: 0 12px 22px rgba(8, 58, 77, .18);
    }
    .vl-hud-mode-toggle::before {
      content: "";
      position: absolute;
      inset: auto -18% -42% auto;
      width: 118px;
      height: 118px;
      border-radius: 999px;
      background: rgba(125, 211, 252, .14);
      pointer-events: none;
    }
    .vl-hud-btn:hover {
      background: #fff;
      transform: translateY(-1px);
      box-shadow: 0 8px 18px rgba(9, 40, 53, .18);
    }
    .vl-hud-mode-toggle:hover {
      background: linear-gradient(180deg, rgba(240, 253, 255, .24) 0%, rgba(224, 247, 250, .12) 100%);
      color: #f4fbff;
    }
    .vl-hud-mode-toggle[data-mode="multiple"]:hover {
      background: linear-gradient(180deg, rgba(255, 255, 255, 1) 0%, rgba(214, 248, 251, .98) 100%);
      color: #0f4357;
    }
    .vl-hud-btn:disabled { opacity: .5; cursor: default; }
    .vl-hud-btn:active { transform: translateY(0); }
    .vl-hud-label {
      font-size: 11px;
      letter-spacing: .03em;
      text-transform: uppercase;
      color: rgba(232, 249, 253, .82);
    }
    .vl-hud-mode-top {
      display: block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      opacity: .72;
      margin-bottom: 5px;
    }
    .vl-hud-mode-main {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      position: relative;
      z-index: 1;
    }
    .vl-hud-mode-current {
      display: inline-block;
      font-size: 18px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: -.02em;
    }
    .vl-hud-mode-next {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      opacity: .78;
      white-space: nowrap;
    }
    .vl-hud-head {
      cursor: grab;
    }
    .vl-hud-head.dragging {
      cursor: grabbing;
    }
    .vl-hud-hide-btn {
      margin-left: auto;
      background: transparent;
      color: rgba(232, 249, 253, .55);
      font-size: 18px;
      line-height: 1;
      padding: 0 5px;
      border-radius: 8px;
      font-weight: 300;
      min-width: unset;
      flex-shrink: 0;
    }
    .vl-hud-hide-btn:hover {
      background: rgba(232, 249, 253, .12);
      color: #f4fbff;
      transform: none;
      box-shadow: none;
    }
    .vl-hud-mini {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      width: 36px;
      height: 36px;
      border-radius: 999px;
      background:
        radial-gradient(circle at top left, rgba(125, 211, 252, .22), transparent 42%),
        linear-gradient(180deg, rgba(15, 58, 79, .96) 0%, rgba(12, 44, 61, .96) 100%);
      border: 1px solid rgba(173, 216, 230, .2);
      box-shadow: 0 8px 18px rgba(3, 20, 30, .3);
      cursor: grab;
      display: none;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      transition: transform .16s ease, box-shadow .16s ease;
    }
    .vl-hud-mini.visible { display: flex; }
    .vl-hud-mini:hover {
      transform: scale(1.1);
      box-shadow: 0 10px 24px rgba(3, 20, 30, .44);
    }
    .vl-hud-mini-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: linear-gradient(180deg, #67e8f9 0%, #22d3ee 100%);
      box-shadow: 0 0 0 4px rgba(103, 232, 249, .18);
    }
  `;
  hudShadow.appendChild(style);

  hudContainer = document.createElement('div');
  hudContainer.className = 'vl-hud hidden';

  const head = document.createElement('div');
  head.className = 'vl-hud-head';

  const dot = document.createElement('span');
  dot.className = 'vl-hud-dot';

  const label = document.createElement('span');
  label.className = 'vl-hud-label';
  label.textContent = 'VaxLink';

  const hideBtn = document.createElement('button');
  hideBtn.className = 'vl-hud-btn vl-hud-hide-btn';
  hideBtn.title = 'Hide VaxLink HUD';
  hideBtn.setAttribute('aria-label', 'Hide VaxLink HUD');
  hideBtn.textContent = '−';
  hideBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setHudHidden(true);
  });

  head.appendChild(dot);
  head.appendChild(label);
  head.appendChild(hideBtn);
  hudContainer.appendChild(head);

  hudModeToggleBtn = document.createElement('button');
  hudModeToggleBtn.className = 'vl-hud-btn vl-hud-mode-toggle';
  hudModeToggleBtn.addEventListener('click', () => {
    const nextMode = activeWorkflowMode === 'multiple' ? 'single' : 'multiple';
    void setHudWorkflowMode(nextMode);
  });
  hudContainer.appendChild(hudModeToggleBtn);

  hudQueueWrap = document.createElement('div');
  hudQueueWrap.className = 'vl-hud-queue hidden';

  hudCountEl = document.createElement('span');
  hudCountEl.className = 'vl-hud-count';
  hudCountEl.textContent = '0';

  hudApplyBtn = document.createElement('button');
  hudApplyBtn.className = 'vl-hud-btn';
  hudApplyBtn.textContent = 'Apply Next';
  hudApplyBtn.addEventListener('click', applyNextQueueItem);

  hudClearBtn = document.createElement('button');
  hudClearBtn.className = 'vl-hud-btn vl-hud-clear-btn';
  hudClearBtn.textContent = 'Clear';
  hudClearBtn.title = 'Clear the multiple-inject queue';
  hudClearBtn.addEventListener('click', () => {
    // Two-step confirm so a stray click cannot wipe a clinic's scans.
    if (hudClearBtn.dataset.confirming === 'true') {
      delete hudClearBtn.dataset.confirming;
      hudClearBtn.textContent = 'Clear';
      void clearHudQueue();
      return;
    }
    hudClearBtn.dataset.confirming = 'true';
    hudClearBtn.textContent = 'Sure?';
    setTimeout(() => {
      delete hudClearBtn.dataset.confirming;
      hudClearBtn.textContent = 'Clear';
    }, 3000);
  });

  hudQueueWrap.appendChild(hudCountEl);
  hudQueueWrap.appendChild(hudApplyBtn);
  hudQueueWrap.appendChild(hudClearBtn);
  hudContainer.appendChild(hudQueueWrap);

  hudQueueListEl = document.createElement('div');
  hudQueueListEl.className = 'vl-hud-list hidden';
  hudContainer.appendChild(hudQueueListEl);
  hudShadow.appendChild(hudContainer);

  hudMiniEl = document.createElement('button');
  hudMiniEl.className = 'vl-hud-mini';
  hudMiniEl.title = 'Show VaxLink HUD';
  hudMiniEl.setAttribute('aria-label', 'Show VaxLink HUD');
  const miniDot = document.createElement('span');
  miniDot.className = 'vl-hud-mini-dot';
  hudMiniEl.appendChild(miniDot);
  // Mini: mousedown starts potential drag; mouseup without movement restores HUD
  hudMiniEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    hudMiniPointerDown = true;
    hudMiniDidDrag = false;
    const rect = hudMiniEl.getBoundingClientRect();
    hudMiniDragOffsetX = e.clientX - rect.left;
    hudMiniDragOffsetY = e.clientY - rect.top;
    hudMiniDownX = e.clientX;
    hudMiniDownY = e.clientY;
    hudMiniEl.style.cursor = 'grabbing';
    e.preventDefault();
  });
  hudShadow.appendChild(hudMiniEl);

  document.body.appendChild(hudHost);

  // Drag-to-move: drag the head to reposition the HUD
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    hudIsDragging = true;
    const rect = hudContainer.getBoundingClientRect();
    hudDragOffsetX = e.clientX - rect.left;
    hudDragOffsetY = e.clientY - rect.top;
    head.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (hudIsDragging) {
      let newLeft = e.clientX - hudDragOffsetX;
      let newTop = e.clientY - hudDragOffsetY;
      newLeft = Math.max(0, Math.min(window.innerWidth - hudContainer.offsetWidth, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - hudContainer.offsetHeight, newTop));
      applyHudPosition({ left: newLeft, top: newTop });
    } else if (hudMiniPointerDown) {
      const dx = e.clientX - hudMiniDownX;
      const dy = e.clientY - hudMiniDownY;
      if (!hudMiniDidDrag && (Math.abs(dx) + Math.abs(dy) > 4)) {
        hudMiniDidDrag = true;
      }
      if (hudMiniDidDrag) {
        let newLeft = e.clientX - hudMiniDragOffsetX;
        let newTop = e.clientY - hudMiniDragOffsetY;
        newLeft = Math.max(0, Math.min(window.innerWidth - 36, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - 36, newTop));
        hudCurrentLeft = newLeft;
        hudCurrentTop = newTop;
        applyMiniPosition();
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (hudIsDragging) {
      hudIsDragging = false;
      head.classList.remove('dragging');
      if (hudCurrentLeft !== null && hudCurrentTop !== null) {
        chrome.storage.local.set({ [HUD_POSITION_KEY]: { left: hudCurrentLeft, top: hudCurrentTop } });
      }
    } else if (hudMiniPointerDown) {
      hudMiniPointerDown = false;
      hudMiniEl.style.cursor = '';
      if (hudMiniDidDrag) {
        chrome.storage.local.set({ [HUD_POSITION_KEY]: { left: hudCurrentLeft, top: hudCurrentTop } });
      } else {
        setHudHidden(false);
      }
    }
  });

  // Restore saved position and hidden state
  chrome.storage.local.get([HUD_POSITION_KEY, HUD_HIDDEN_KEY], (stored) => {
    if (stored && stored[HUD_POSITION_KEY]) {
      applyHudPosition(stored[HUD_POSITION_KEY]);
    }
    if (stored && stored[HUD_HIDDEN_KEY]) {
      hudUserHidden = true;
      hudContainer.classList.add('hidden');
      hudMiniEl.classList.add('visible');
      applyMiniPosition();
    }
    updateHudState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      MULTIPLE_INJECT_QUEUE_KEY in changes ||
      WORKFLOW_MODE_KEY in changes ||
      LEGACY_POPUP_MODE_KEY in changes ||
      LEGACY_REMOTE_MODE_KEY in changes ||
      LEGACY_HANDS_FREE_KEY in changes
    ) {
      updateHudState();
    }
  });
}

function applyHudPosition({ left, top }) {
  hudCurrentLeft = left;
  hudCurrentTop = top;
  hudContainer.style.bottom = 'auto';
  hudContainer.style.right = 'auto';
  hudContainer.style.left = left + 'px';
  hudContainer.style.top = top + 'px';
}

function applyMiniPosition() {
  if (!hudMiniEl) return;
  if (hudCurrentLeft !== null && hudCurrentTop !== null) {
    hudMiniEl.style.removeProperty('bottom');
    hudMiniEl.style.removeProperty('right');
    hudMiniEl.style.left = hudCurrentLeft + 'px';
    hudMiniEl.style.top = hudCurrentTop + 'px';
  } else {
    hudMiniEl.style.removeProperty('left');
    hudMiniEl.style.removeProperty('top');
    hudMiniEl.style.bottom = '16px';
    hudMiniEl.style.right = '16px';
  }
}

function setHudHidden(hidden) {
  hudUserHidden = hidden;
  if (hudContainer) hudContainer.classList.toggle('hidden', hidden);
  if (hudMiniEl) {
    hudMiniEl.classList.toggle('visible', hidden);
    if (hidden) applyMiniPosition();
  }
  chrome.storage.local.set({ [HUD_HIDDEN_KEY]: hidden });
}

function updateHudState() {
  chrome.storage.local.get([MULTIPLE_INJECT_QUEUE_KEY], (stored) => {
    const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
      ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
    const count = rows.length;
    const shouldShow = isPanoramaRecordImmsPage();
    const showQueueControls = activeWorkflowMode === 'multiple' && count > 0 && isPanoramaImmunizationPage();

    if (hudContainer) {
      hudContainer.classList.toggle('hidden', !shouldShow || hudUserHidden);
    }
    if (hudMiniEl) {
      hudMiniEl.classList.toggle('visible', shouldShow && hudUserHidden);
    }
    setHudModeToggleState(hudModeToggleBtn, activeWorkflowMode);
    if (hudQueueWrap) {
      hudQueueWrap.classList.toggle('hidden', !showQueueControls);
    }
    if (hudCountEl) {
      hudCountEl.textContent = String(count);
    }
    if (hudApplyBtn) {
      hudApplyBtn.disabled = count === 0;
    }
    renderHudQueueList(rows, showQueueControls);
  });
}

function renderHudQueueList(rows, visible) {
  if (!hudQueueListEl) return;
  hudQueueListEl.classList.toggle('hidden', !visible || rows.length === 0);
  hudQueueListEl.textContent = '';
  if (!visible) return;

  for (const row of rows) {
    if (!row) continue;
    const item = document.createElement('div');
    item.className = 'vl-hud-item';

    const label = document.createElement('span');
    label.className = 'vl-hud-item-label';
    const name = row.tradename || row.generic_name || row.name || 'Vaccine';
    label.textContent = row.lot ? `${name} · ${row.lot}` : name;
    label.title = label.textContent;
    if (row.expiry_flag === 'expired') {
      label.classList.add('expired');
      label.title += ' — EXPIRED';
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'vl-hud-item-remove';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${name} from queue`;
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.addEventListener('click', () => {
      void removeHudQueueRow(row.id);
    });

    item.appendChild(label);
    item.appendChild(removeBtn);
    hudQueueListEl.appendChild(item);
  }
}

async function removeHudQueueRow(id) {
  if (!id || applyQueueInFlight) return;
  const stored = await getLocalStorage([MULTIPLE_INJECT_QUEUE_KEY]);
  const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
    ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
  const next = rows.filter((row) => row && row.id !== id);
  if (next.length === rows.length) return;
  await setLocalStorage({ [MULTIPLE_INJECT_QUEUE_KEY]: next });
  updateHudState();
}

async function clearHudQueue() {
  if (applyQueueInFlight) return;
  await setLocalStorage({ [MULTIPLE_INJECT_QUEUE_KEY]: [] });
  updateHudState();
}

// Guards the read-match-write sequence below: tryAutoDrain, the multi-step
// observer, and the HUD apply button can all fire close together, and without
// this flag two callers could consume the same queued record (double-fill) or
// clobber each other's setLocalStorage (dropped record).
