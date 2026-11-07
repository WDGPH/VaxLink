#!/usr/bin/env node
// Developer-only synthetic investigation. The extension package never includes this file.
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { makeTestNvcBundle } from '../apps/extension-tests/helpers/clinic-sim.js';

const args = process.argv.slice(2);
if (args.some((arg) => !['--capture', '--help'].includes(arg)))
  throw new Error('Use --capture or --help.');
if (args.includes('--help')) {
  console.log(
    'Build Alpha first: ./scripts/package-extension.sh alpha\nRun: node scripts/capture-browser.mjs [--capture]\n--capture writes a full-mode HAR, Playwright trace, screenshot and Chrome performance trace.'
  );
  process.exit(0);
}
const capture = args.includes('--capture');
const version = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url))
).version;
const zip = resolve(`dist/vaxlink-alpha-${version}.zip`);
const zipSha256 = createHash('sha256')
  .update(await readFile(zip))
  .digest('hex');
const temporary = await mkdtemp(join(tmpdir(), 'vaxlink-synthetic-browser-'));
const extension = join(temporary, 'extension');
const profile = join(temporary, 'profile');
const output = resolve(
  '.local-captures',
  `run-${new Date().toISOString().replace(/[:.]/g, '-')}`
);
await mkdir(output, { recursive: true, mode: 0o700 });
execFileSync('python3', ['-m', 'zipfile', '-e', zip, extension]);
const build = JSON.parse(
  (await readFile(join(extension, 'build-identity.js'), 'utf8')).match(
    /Object\.freeze\((.*)\)/
  )[1]
);
const fixture = await readFile(
  new URL('./fixtures/capture-panorama.html', import.meta.url),
  'utf8'
);
const fixtureUrl =
  'https://trpanoramadhir.prod.ehealthontario.ca/recordImms/fixture';
const browserArgs = [
  `--disable-extensions-except=${extension}`,
  `--load-extension=${extension}`,
  '--host-resolver-rules=MAP * ~NOTFOUND'
];
const launch = (extra = {}) =>
  chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: browserArgs,
    ...extra
  });
let context;
let tracingStarted = false;
let cdp;
let traceEvents = [];
let traceFinished;
const errors = [];
const mark = async (page, name) =>
  page.evaluate((value) => performance.mark(`vaxlink-capture:${value}`), name);
try {
  context = await launch();
  const seedWorker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent('serviceworker'));
  const id = new URL(seedWorker.url()).host;
  const seedPage = await context.newPage();
  await seedPage.goto(`chrome-extension://${id}/popup.html`);
  const bundle = makeTestNvcBundle('TESTLOT');
  bundle.entry[0].resource.compose.include[0].concept[0].display = 'Boostrix';
  bundle.entry[1].resource.concept[0].property.push({
    code: 'expiryDate',
    valueDate: '2027-12-31'
  });
  await seedPage.evaluate(
    async (bundle) =>
      chrome.storage.local.set({
        nvc_bundle_override: bundle,
        nvc_bundle_last_check_at: new Date().toISOString(),
        vaxlink_workflow_mode_v1: 'single'
      }),
    bundle
  );
  await context.close();
  context = await launch(
    capture
      ? {
          recordHar: {
            path: join(output, 'network.har'),
            mode: 'full',
            content: 'omit',
            urlFilter:
              /^https:\/\/trpanoramadhir\.prod\.ehealthontario\.ca\/(recordImms\/fixture|synthetic-resource)/
          }
        }
      : {}
  );
  context.on('page', (page) => {
    page.on('pageerror', (error) =>
      errors.push(`Page error: ${error.message}`)
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push(`Console error: ${message.text()}`);
    });
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('chrome-extension://')) return route.continue();
    if (url === fixtureUrl)
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: fixture
      });
    if (
      url === 'https://trpanoramadhir.prod.ehealthontario.ca/synthetic-resource'
    )
      return route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: 'synthetic'
      });
    return route.abort();
  });
  if (capture) {
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;
  }
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/popup.html`);
  const chartPromise = context.waitForEvent('page');
  const tabId = await control.evaluate(
    async (url) => (await chrome.tabs.create({ url, active: true })).id,
    fixtureUrl
  );
  const chart = await chartPromise;
  await chart.waitForLoadState('domcontentloaded');
  if (capture) {
    cdp = await context.newCDPSession(chart);
    traceFinished = new Promise((done) =>
      cdp.on('Tracing.tracingComplete', done)
    );
    cdp.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value));
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      categories: 'devtools.timeline,blink.user_timing,loading'
    });
  }
  const viewerPromise = context.waitForEvent('page');
  await control.evaluate(
    async (origin) =>
      chrome.tabs.create({
        url: chrome.runtime.getURL(`diagnostics.html?origin=${origin}`),
        active: false
      }),
    tabId
  );
  const viewer = await viewerPromise;
  await viewer.locator('#start').waitFor();
  await viewer.waitForFunction(
    () =>
      !document
        .getElementById('record-status')
        .textContent.includes('Loading recording')
  );
  const health = await viewer.evaluate(
    async (originTabId) =>
      chrome.runtime.sendMessage({ action: 'diagnostics.health', originTabId }),
    tabId
  );
  if (health.health?.build?.id !== build.id)
    throw new Error('Running extension does not match the selected package.');
  const handshake = await control.evaluate(async (tab) => {
    for (let i = 0; i < 50; i++) {
      try {
        const status = await chrome.tabs.sendMessage(
          tab,
          { action: 'getIntegrationHealth' },
          { frameId: 0 }
        );
        if (status?.initialized?.listener) return status;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Content script did not initialize.');
  }, tabId);
  await viewer.locator('#start').click();
  await viewer.waitForFunction(() =>
    document.getElementById('record-status').textContent.includes('Recording ·')
  );
  await control.evaluate(
    async (tab) => chrome.tabs.update(tab, { active: true }),
    tabId
  );
  const verified = viewer
    .evaluate(async () => {
      const key = 'vaxlink_diagnostic_session_v1';
      const has = (session) =>
        session?.events?.some(
          (event) => event.code === 'fill' && event.outcome === 'verified'
        );
      const current = (await chrome.storage.session.get(key))[key];
      if (has(current)) return;
      return new Promise((done, reject) => {
        const timer = setTimeout(() => {
          chrome.storage.onChanged.removeListener(listener);
          reject(new Error('Final form verification was not observed.'));
        }, 15000);
        function listener(changes, area) {
          if (area === 'session' && has(changes[key]?.newValue)) {
            clearTimeout(timer);
            chrome.storage.onChanged.removeListener(listener);
            done();
          }
        }
        chrome.storage.onChanged.addListener(listener);
      });
    })
    .then(
      () => null,
      (error) => error
    );
  await mark(chart, 'before-synthetic-scan');
  const ingress = await viewer.evaluate(async () =>
    chrome.runtime.sendMessage({
      action: 'scannerScanCaptured',
      scan: {
        rawText: '10TESTLOT',
        source: 'synthetic-browser',
        capturedAt: new Date().toISOString()
      }
    })
  );
  if (!ingress?.routed)
    throw new Error('Synthetic scan was not routed to the fixture.');
  const verificationError = await verified;
  if (verificationError) throw verificationError;
  await mark(chart, 'final-fields-verified');
  const fields = await chart.evaluate(() =>
    [...document.querySelectorAll('select,input')].map((field) => !!field.value)
  );
  if (fields.length !== 6 || fields.some((value) => !value))
    throw new Error('A synthetic form field was not populated.');
  const stopped = await viewer.evaluate(async () => {
    const current = await chrome.runtime.sendMessage({
      action: 'diagnostics.read'
    });
    if (!current.success || !current.session)
      throw new Error('Recording is unavailable.');
    return chrome.runtime.sendMessage({
      action: 'diagnostics.stop',
      sessionId: current.session.id
    });
  });
  if (!stopped.success) throw new Error('Could not stop the recording.');
  const read = await viewer.evaluate(async () =>
    chrome.runtime.sendMessage({ action: 'diagnostics.read' })
  );
  const events = read.session?.events || [];
  if (
    !events.some(
      (event) =>
        event.code === 'snapshot' &&
        event.metadata?.field === 'lot' &&
        event.metadata?.replaced
    )
  )
    throw new Error('The delayed lot replacement was not observed.');
  const exported = await viewer.evaluate(
    async (sessionId) =>
      chrome.runtime.sendMessage({ action: 'diagnostics.export', sessionId }),
    read.session?.id
  );
  if (
    !exported.success ||
    ['VAXLINK-SYNTHETIC-MARKER', 'TESTLOT', '10TESTLOT'].some((value) =>
      JSON.stringify(exported.data).includes(value)
    )
  )
    throw new Error('Diagnostic export failed its synthetic privacy check.');
  await writeFile(
    join(output, 'diagnostic-session.json'),
    JSON.stringify(exported.data, null, 2) + '\n'
  );
  if (capture) {
    await chart.screenshot({ path: join(output, 'synthetic-chart.png') });
    await cdp.send('Tracing.end');
    await traceFinished;
    await writeFile(
      join(output, 'performance.json'),
      JSON.stringify({ traceEvents })
    );
    traceEvents = [];
    await context.tracing.stop({ path: join(output, 'playwright-trace.zip') });
    tracingStarted = false;
  }
  if (errors.length)
    throw new Error(`Browser reported errors: ${errors.join('; ')}`);
  await writeFile(
    join(output, 'conditions.json'),
    JSON.stringify(
      {
        synthetic: true,
        browser: context.browser().version(),
        playwright: '1.65.0',
        build,
        zipSha256,
        capture,
        debuggerAttached: true,
        throttling: 'none',
        physicalScannerTested: false,
        ingress: 'synthetic scannerScanCaptured after serial boundary',
        coverage: {
          routed: !!ingress.routed,
          finalFieldsVerified: true,
          replacementObserved: true,
          resourceEvents: events.filter((event) => event.code === 'resource')
            .length,
          dropped: read.session.dropped
        },
        errors
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Synthetic capture completed: ${output}`);
} finally {
  if (tracingStarted)
    await context?.tracing
      .stop({ path: join(output, 'playwright-trace-incomplete.zip') })
      .catch(() => {});
  await context?.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
