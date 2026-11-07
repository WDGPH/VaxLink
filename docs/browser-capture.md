# Synthetic browser capture

Use this developer-only runner to investigate the packaged Alpha extension with a synthetic chart. It runs the real scan routing and form-fill code. It does not test a physical scanner or establish how a clinic workstation behaves.

## Setup and run

Install the locked development dependencies and Playwright's bundled Chromium:

```bash
npm ci
npx playwright install chromium
./scripts/package-extension.sh alpha
node scripts/capture-browser.mjs
```

The default run checks routing, a delayed lot-control replacement, and final observed form fields. It writes `conditions.json` and a sanitized `diagnostic-session.json` under `.local-captures/`. For an opt-in investigation with browser artifacts, run:

```bash
node scripts/capture-browser.mjs --capture
```

The runner extracts the Alpha ZIP and creates a disposable, purpose-specific browser profile in a temporary directory. It seeds a synthetic catalogue and relaunches with the same profile so the worker reads its cache. It intercepts the supported training URL and serves a local fixture. Other web requests are blocked. No clinic account, everyday browser profile, or real patient record is used. The temporary profile and extracted extension are removed when the run ends.

The runner sends synthetic scanner input to the extension after the serial capture boundary. It does not use Playwright to select or fill the chart fields. It checks the extension's final field observation and the fixture's controls. The fixture's 450 ms replacement is a controlled scenario, not a measurement of Panorama.

## Artifacts and interpretation

Each run writes to a timestamped directory under `.local-captures/`, which Git ignores. `conditions.json` records the browser, extension build and ZIP checksum, capture settings, coverage and reported errors. With `--capture`, the directory also contains:

- `network.har`: full-mode HAR restricted to the synthetic fixture and resource URLs, with response content omitted.
- `playwright-trace.zip`: Playwright actions, checkpoints and snapshots. Open it with `npx playwright show-trace path/to/playwright-trace.zip`.
- `performance.json`: Chromium tracing events, including `vaxlink-capture:before-synthetic-scan` and `vaxlink-capture:final-fields-verified` User Timing marks.
- `synthetic-chart.png`: a screenshot of the synthetic fixture.

Playwright snapshots describe its own actions and checkpoints; they do not show every internal extension decision. The extension's local recorder supplies its own events. Resource and rendering timing can help form hypotheses but does not prove a server or workstation cause. HAR replay does not automatically reproduce the original response delays; model a delay explicitly when building a focused reproduction.

Playwright and Chrome tracing attach debugging tools and can affect execution and keep the extension worker alive. Compare findings with a normal recording and DevTools closed. A successful synthetic run does not prove physical capture, clinic operation, or a saved clinical record.

Keep captures local and inspect them before sharing. HAR files can contain URLs and headers even when bodies are omitted; traces can contain DOM, screenshots and other sensitive material. Redacting a screenshot does not sanitize its companion trace. Do not use this runner with credentials or real records, and do not upload captures as automatic CI artifacts.
