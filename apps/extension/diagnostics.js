const SESSION_KEY = 'vaxlink_diagnostic_session_v1';
const el = (id) => document.getElementById(id);
const nodes = Object.fromEntries(
  [
    'refresh',
    'health-message',
    'health',
    'record-status',
    'start',
    'stop',
    'clear',
    'preview',
    'coverage',
    'export-preview',
    'export-summary',
    'download',
    'cancel-export',
    'attempts',
    'coverage-events',
    'page-events'
  ].map((id) => [id, el(id)])
);
const originText = new URL(location.href).searchParams.get('origin');
const originTabId =
  /^\d+$/.test(originText || '') && Number.isSafeInteger(Number(originText))
    ? Number(originText)
    : null;
let session = null;
let exportData = null;
nodes.download.disabled = true;
let selectedAttempt = '';
let countdown = null;

function command(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: `diagnostics.${action}`, ...payload },
      (response) => {
        if (chrome.runtime.lastError)
          return resolve({
            success: false,
            error: chrome.runtime.lastError.message
          });
        resolve(
          response || { success: false, error: 'No response from diagnostics.' }
        );
      }
    );
  });
}
function formatTime(value) {
  if (!Number.isFinite(value) && typeof value !== 'string')
    return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}
function display(value) {
  if (value === null || value === undefined || value === '')
    return 'Unavailable';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value).replaceAll('_', ' ');
}
function addRow(list, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = display(value);
  list.append(term, detail);
}
function setHealth(health) {
  const scanner = health?.scanner || {};
  const catalogue = health?.catalogue || {};
  const integration = health?.integration || {};
  const build = health?.build || {};
  nodes.health.replaceChildren();
  addRow(
    nodes.health,
    'Extension build',
    [build.version, build.id].filter(Boolean).join(' · ') || 'Unavailable'
  );
  addRow(nodes.health, 'Scanner', scanner.state);
  addRow(
    nodes.health,
    'Scanner observation',
    scanner.source === 'fresh'
      ? 'Fresh worker reply'
      : scanner.source === 'cached'
        ? `Cached; ${Number.isFinite(scanner.ageMs) ? `${Math.floor(scanner.ageMs / 1000)} seconds old` : 'age unknown'}`
        : 'Unavailable'
  );
  addRow(nodes.health, 'Hardware frames captured', scanner.captureCount);
  addRow(
    nodes.health,
    'Last hardware capture',
    scanner.lastCaptureAt ? formatTime(scanner.lastCaptureAt) : 'Unavailable'
  );
  addRow(nodes.health, 'Catalogue', catalogue.state);
  addRow(nodes.health, 'Catalogue usable', catalogue.usable);
  addRow(
    nodes.health,
    'Catalogue cache / degraded freshness',
    `${display(catalogue.usingCache)} / ${display(catalogue.freshnessDegraded)}`
  );
  addRow(
    nodes.health,
    'Catalogue last checked',
    catalogue.lastCheckAt ? formatTime(catalogue.lastCheckAt) : 'Unavailable'
  );
  addRow(
    nodes.health,
    'Catalogue last error',
    catalogue.lastError || 'None reported'
  );
  addRow(nodes.health, 'Page integration', integration.state);
  addRow(
    nodes.health,
    'Page category / workflow',
    [integration.category, integration.workflow].filter(Boolean).join(' / ') ||
      'Unavailable'
  );
  addRow(
    nodes.health,
    'Page build at load',
    [integration.buildAtLoad?.version, integration.buildAtLoad?.id]
      .filter(Boolean)
      .join(' · ') || 'Unavailable'
  );
  addRow(
    nodes.health,
    'Page listener / settings ready',
    integration.initialized
      ? `${display(integration.initialized.listener)} / ${display(integration.initialized.settings)}`
      : 'Unavailable'
  );
  nodes['health-message'].textContent =
    'Health observed. A cached scanner result is not a live connection check.';
}
async function refresh() {
  expireLocal();
  nodes.refresh.disabled = true;
  const [health, reading] = await Promise.all([
    command('health', { originTabId }),
    command('read')
  ]);
  if (health.success) setHealth(health.health);
  else {
    nodes.health.replaceChildren();
    nodes['health-message'].textContent =
      `Health unavailable: ${health.error || 'unknown error'}`;
  }
  if (reading.success) applySession(reading.session);
  else
    nodes['record-status'].textContent =
      `Recording unavailable: ${reading.error || 'unknown error'}`;
  nodes.refresh.disabled = false;
}
function isRecording(value = session) {
  return (
    !!value && value.state === 'recording' && Date.now() < value.recordingUntil
  );
}
function expireLocal() {
  if (
    session &&
    Number.isFinite(session.expiresAt) &&
    Date.now() >= session.expiresAt
  ) {
    session = null;
    exportData = null;
    nodes.download.disabled = true;
    selectedAttempt = '';
    nodes['export-preview'].hidden = true;
    nodes['export-summary'].textContent = '';
    applySession(null);
    nodes['record-status'].textContent =
      'Recording retention ended; local events and export preview were cleared.';
    return true;
  }
  if (exportData && Date.now() >= exportData.session.expiresAt) {
    exportData = null;
    nodes.download.disabled = true;
    nodes['export-preview'].hidden = true;
    nodes['export-summary'].textContent = '';
  }
  return false;
}
function updateCountdown() {
  if (expireLocal()) return;
  if (!session) {
    nodes['record-status'].textContent = 'No recording retained.';
    return;
  }
  if (isRecording()) {
    const seconds = Math.ceil((session.recordingUntil - Date.now()) / 1000);
    nodes['record-status'].textContent =
      `Recording · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`;
  } else
    nodes['record-status'].textContent =
      session.state === 'recording'
        ? 'Recording time ended. Refresh to confirm the final state.'
        : `Stopped · retained until ${formatTime(session.expiresAt)}`;
  nodes.start.disabled = isRecording();
  nodes.stop.disabled = !isRecording();
}
function outcomeClass(outcome) {
  if (['failed', 'cancelled', 'interrupted', 'timed_out'].includes(outcome))
    return 'failure';
  if (['pending', 'partial', 'unknown', 'superseded'].includes(outcome))
    return 'waiting';
  return outcome === 'verified' ? 'success' : '';
}
const labels = {
  serial_chunk: 'Serial bytes',
  frame: 'Frame',
  parse: 'Parse',
  nvc: 'Catalogue',
  route: 'Route',
  queue: 'Queue',
  fill: 'Form fill',
  snapshot: 'Field state',
  retry: 'Retry',
  resource: 'Resource timing',
  render: 'Rendering',
  lifecycle: 'Context lifecycle'
};
function label(event) {
  const outcome =
    event.outcome === 'pending' && event.reason === 'user'
      ? 'waiting for user'
      : display(event.outcome);
  return `${labels[event.code] || 'Observation'} · ${outcome}${event.reason && event.reason !== 'none' ? ` · ${display(event.reason)}` : ''}`;
}
function eventDetails(event) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label(event);
  summary.className = outcomeClass(event.outcome);
  details.append(summary);
  const list = document.createElement('dl');
  addRow(list, 'Observed', formatTime(event.observedAt));
  addRow(list, 'Context', event.context);
  addRow(
    list,
    'Context reference',
    event.contextId ? event.contextId.slice(0, 8) : 'Unavailable'
  );
  if (event.elapsedMs !== undefined)
    addRow(list, 'Elapsed', `${Math.round(event.elapsedMs * 10) / 10} ms`);
  if (event.reason) addRow(list, 'Reason', event.reason);
  for (const [key, value] of Object.entries(event.metadata || {})) {
    if (
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string'
    )
      addRow(
        list,
        key.replace(/([A-Z])/g, ' $1'),
        typeof value === 'number' && /Ms$/.test(key)
          ? `${Math.round(value * 10) / 10} ms`
          : value
      );
  }
  details.append(list);
  return details;
}
function checkpoint(event) {
  if (event.code === 'fill' && event.outcome === 'verified')
    return 'Final form fields matched';
  if (event.code === 'snapshot' && event.outcome === 'observed')
    return 'Form field state observed';
  if (event.code === 'queue' && event.outcome === 'queued')
    return 'Scan queued';
  if (event.code === 'route' && event.outcome === 'delivered')
    return 'Scan delivered to a page';
  if (event.code === 'nvc' && event.outcome === 'enriched')
    return 'Catalogue details found';
  if (event.code === 'parse' && event.outcome === 'parsed')
    return 'Barcode parsed';
  if (event.code === 'frame' && event.outcome === 'partial')
    return 'Incomplete scanner frame observed';
  if (
    event.code === 'frame' &&
    ['accepted', 'observed'].includes(event.outcome)
  )
    return 'Scanner frame observed';
  if (event.code === 'serial_chunk' && event.outcome === 'observed')
    return 'Serial bytes observed';
  return '';
}
function appendTimeline(container, events) {
  for (let i = 0; i < events.length;) {
    const event = events[i];
    if (event.code === 'retry' && event.outcome === 'pending') {
      let end = i + 1;
      while (
        end < events.length &&
        events[end].code === 'retry' &&
        events[end].outcome === 'pending' &&
        events[end].reason === event.reason
      )
        end++;
      if (end - i > 1) {
        const group = document.createElement('details');
        const heading = document.createElement('summary');
        heading.textContent = `Retry waiting · ${end - i} observations`;
        heading.className = 'waiting';
        group.append(heading);
        for (const item of events.slice(i, end))
          group.append(eventDetails(item));
        container.append(group);
        i = end;
        continue;
      }
    }
    container.append(eventDetails(event));
    i++;
  }
}
function renderEvents() {
  nodes.attempts.replaceChildren();
  nodes['coverage-events'].replaceChildren();
  nodes['page-events'].replaceChildren();
  const events = Array.isArray(session?.events) ? session.events : [];
  const groups = new Map();
  const page = [];
  for (const event of events) {
    if (event.code === 'resource' || event.code === 'render') {
      page.push(event);
      continue;
    }
    if (!event.operationId) continue;
    if (!groups.has(event.operationId)) groups.set(event.operationId, []);
    groups.get(event.operationId).push(event);
  }
  const all = [...groups.entries()].map(([id, items]) => ({
    id,
    items: items.sort((a, b) => a.observedAt - b.observedAt)
  }));
  const attempts = all
    .filter(({ items }) => items.some((event) => event.code !== 'lifecycle'))
    .sort((a, b) => b.items.at(-1).observedAt - a.items.at(-1).observedAt);
  const coverage = all.filter(({ items }) =>
    items.every((event) => event.code === 'lifecycle')
  );
  if (!coverage.length)
    nodes['coverage-events'].textContent =
      'No separate context lifecycle observations.';
  for (const group of coverage)
    for (const event of group.items)
      nodes['coverage-events'].append(eventDetails(event));
  if (!attempts.length)
    nodes.attempts.textContent = 'No workflow attempts observed.';
  for (const attempt of attempts) {
    const last = attempt.items.at(-1);
    const checkpointOrder = [
      'Serial bytes observed',
      'Scanner frame observed',
      'Incomplete scanner frame observed',
      'Barcode parsed',
      'Catalogue details found',
      'Scan delivered to a page',
      'Scan queued',
      'Form field state observed',
      'Final form fields matched'
    ];
    const established = attempt.items
      .map(checkpoint)
      .filter(Boolean)
      .sort(
        (a, b) => checkpointOrder.indexOf(b) - checkpointOrder.indexOf(a)
      )[0];
    const outcome = [...attempt.items]
      .reverse()
      .find((event) =>
        ['failed', 'cancelled', 'timed_out', 'interrupted', 'pending'].includes(
          event.outcome
        )
      );
    const box = document.createElement('details');
    box.className = 'attempt';
    box.open = attempt.id === selectedAttempt;
    box.addEventListener('toggle', () => {
      if (box.open && selectedAttempt !== attempt.id) {
        selectedAttempt = attempt.id;
        renderEvents();
      } else if (!box.open && selectedAttempt === attempt.id) {
        selectedAttempt = '';
        renderEvents();
      }
    });
    const summary = document.createElement('summary');
    summary.textContent = `${formatTime(last.observedAt)} · ${established || 'No confirmed checkpoint'}${outcome && attempt.items.indexOf(outcome) > attempt.items.findLastIndex((e) => checkpoint(e)) ? ` · ${label(outcome)}` : ''}`;
    summary.className =
      outcome &&
      attempt.items.indexOf(outcome) >
        attempt.items.findLastIndex((e) => checkpoint(e))
        ? outcomeClass(outcome.outcome)
        : '';
    box.append(summary);
    const detail = document.createElement('p');
    detail.textContent = `Last established checkpoint: ${established || 'None recorded'}. Latest observation: ${label(last)}.`;
    box.append(detail);
    const parent = attempt.items.find(
      (event) => event.parentOperationId
    )?.parentOperationId;
    if (parent) {
      const related = document.createElement('p');
      related.textContent = groups.has(parent)
        ? `Related to earlier queued attempt ${parent.slice(0, 8)}.`
        : 'A parent queue attempt was linked but is not present in this recording.';
      box.append(related);
    }
    appendTimeline(box, attempt.items);
    nodes.attempts.append(box);
  }
  const selected = attempts.find((attempt) => attempt.id === selectedAttempt);
  if (!selected) {
    nodes['page-events'].textContent =
      'Select an attempt to see nearby page observations.';
    return;
  }
  const contexts = new Set(
    selected.items
      .filter((event) => event.context === 'content')
      .map((event) => event.contextId)
  );
  const first = selected.items[0].observedAt - 2000;
  const last = selected.items.at(-1).observedAt + 2000;
  const nearby = page
    .filter(
      (event) =>
        event.context === 'content' &&
        contexts.has(event.contextId) &&
        event.observedAt >= first &&
        event.observedAt <= last
    )
    .sort((a, b) => b.observedAt - a.observedAt);
  if (!nearby.length)
    nodes['page-events'].textContent =
      'No nearby resource or rendering observations for this attempt.';
  for (const event of nearby.slice(0, 100))
    nodes['page-events'].append(eventDetails(event));
  if (nearby.length > 100) {
    const extra = document.createElement('p');
    extra.textContent = `${nearby.length - 100} earlier nearby observations are included in the export.`;
    nodes['page-events'].append(extra);
  }
}
function applySession(next) {
  if (
    next &&
    (!Number.isFinite(next.expiresAt) || Date.now() >= next.expiresAt)
  )
    next = null;
  if (exportData && (!next || next.id !== exportData.session.id)) {
    exportData = null;
    nodes.download.disabled = true;
    nodes['export-preview'].hidden = true;
  }
  session = next || null;
  nodes.start.textContent =
    session && !isRecording()
      ? 'Start new recording and replace retained data'
      : 'Start recording';
  nodes.clear.disabled = !session;
  nodes.preview.disabled = !session;
  nodes.stop.disabled = !isRecording();
  nodes.coverage.textContent = session
    ? `${session.events?.length || 0} events retained; ${session.dropped || 0} events reported dropped. A missing tail or context restart can leave an attempt incomplete.`
    : '';
  updateCountdown();
  renderEvents();
}
nodes.refresh.addEventListener('click', () => void refresh());
nodes.start.addEventListener('click', async () => {
  expireLocal();
  nodes.start.disabled = true;
  const latest = await command('read');
  if (!latest.success) {
    nodes['record-status'].textContent =
      latest.error || 'Could not check the current recording.';
    nodes.start.disabled = false;
    return;
  }
  applySession(latest.session);
  if (isRecording()) {
    nodes['record-status'].textContent = 'A recording is already active.';
    return;
  }
  if (
    session &&
    !confirm('Start a new recording and replace the retained recording?')
  )
    return;
  const response = await command('start');
  if (!response.success) {
    nodes['record-status'].textContent =
      response.error || 'Could not start recording.';
    updateCountdown();
    return;
  }
  const current = await command('read');
  if (current.success) applySession(current.session);
  else
    nodes['record-status'].textContent =
      'Recording started; its details could not be read. Refresh to check.';
});
nodes.stop.addEventListener('click', async () => {
  expireLocal();
  if (!session) return;
  nodes.stop.disabled = true;
  const response = await command('stop', { sessionId: session.id });
  if (!response.success) {
    nodes['record-status'].textContent =
      response.error || 'Could not stop recording.';
    updateCountdown();
    return;
  }
  const current = await command('read');
  if (current.success) applySession(current.session);
  else
    nodes['record-status'].textContent =
      'Stop requested; refresh to check the final state.';
});
nodes.clear.addEventListener('click', async () => {
  expireLocal();
  if (!session || !confirm('Clear this recording and its retained events?'))
    return;
  const response = await command('clear', { sessionId: session.id });
  if (!response.success) {
    nodes['record-status'].textContent =
      response.error || 'Could not clear recording.';
    return;
  }
  exportData = null;
  nodes.download.disabled = true;
  nodes['export-preview'].hidden = true;
  applySession(null);
});
nodes.preview.addEventListener('click', async () => {
  expireLocal();
  if (!session) return;
  const response = await command('export', { sessionId: session.id });
  if (!response.success || !response.data?.session) {
    nodes['record-status'].textContent =
      response.error || 'Could not prepare export.';
    return;
  }
  if (
    expireLocal() ||
    !session ||
    response.data.session.id !== session.id ||
    Date.now() >= response.data.session.expiresAt
  )
    return;
  exportData = response.data;
  const data = exportData.session;
  const size = new TextEncoder().encode(JSON.stringify(exportData)).length;
  nodes['export-summary'].textContent =
    `Snapshot: ${data.events?.length || 0} events, ${data.dropped || 0} reported dropped, ${size} bytes. Started ${formatTime(data.startedAt)}; retained until ${formatTime(data.expiresAt)}. Build: ${display(exportData.build?.version || exportData.build?.id)}. The recording is limited to 15 minutes, 1,000 events, and 1 MiB.`;
  nodes['export-preview'].hidden = false;
  nodes.download.disabled = false;
  nodes.download.focus();
});
nodes['cancel-export'].addEventListener('click', () => {
  expireLocal();
  exportData = null;
  nodes.download.disabled = true;
  nodes['export-preview'].hidden = true;
  nodes.preview.focus();
});
nodes.download.addEventListener('click', async () => {
  expireLocal();
  if (!exportData || !session) return;
  const previewed = exportData;
  nodes.download.disabled = true;
  const response = await command('export', { sessionId: previewed.session.id });
  if (
    expireLocal() ||
    exportData !== previewed ||
    !session ||
    session.id !== previewed.session.id ||
    !response.success ||
    response.data?.session?.id !== previewed.session.id ||
    Date.now() >= response.data.session.expiresAt ||
    Date.now() >= previewed.session.expiresAt
  ) {
    exportData = null;
    nodes.download.disabled = true;
    nodes['export-preview'].hidden = true;
    nodes['export-summary'].textContent = '';
    nodes['record-status'].textContent =
      response.error ||
      'The preview is no longer available. Refresh and prepare a new export.';
    return;
  }
  const blob = new Blob([JSON.stringify(previewed, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'vaxlink-diagnostics.json';
  link.click();
  URL.revokeObjectURL(url);
  exportData = null;
  nodes.download.disabled = true;
  nodes['export-preview'].hidden = true;
  nodes['export-summary'].textContent = '';
  nodes.preview.focus();
});
window.addEventListener('focus', expireLocal);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) expireLocal();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && Object.hasOwn(changes, SESSION_KEY))
    applySession(changes[SESSION_KEY].newValue || null);
});
countdown = setInterval(updateCountdown, 1000);
window.addEventListener('unload', () => clearInterval(countdown), {
  once: true
});
void refresh();
