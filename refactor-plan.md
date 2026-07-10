# VaxLink Refactor Plan — Modular Architecture

**Branch:** `refactor/extension-architecture`
**Scope:** `apps/extension/` — introduce a folder-based, separation-of-concerns architecture
**Status:** Structural split implemented (Phase 1 delivered); shared/ UMD extraction deferred
**Author:** generated 2026-07-10

> **Implementation note (2026-07-10).** The folder architecture and the `content.js`
> decomposition are done and test-green (140 pass / 0 fail, unchanged from baseline).
> `content.js` was split **verbatim** (byte-for-byte reconstruction verified) into ordered
> classic content scripts under `content/` that share the realm's global lexical scope; all
> top-level execution was relocated to the `content/content.js` entry (loaded last).
> `panorama-agent-rules.js`, `popup*.js`, `queue-record.js`, `popup-parser.js`, and
> `background.js` were relocated into `content/platforms/panorama/`, `popup/`, `shared/`, and
> `background/`. Manifest `content_scripts[].js` is now an ordered, foldered array; the packaged
> zip was verified to contain all folders and no test files. **Deferred to a follow-up:** the
> §4 Phase-2 extraction of pure logic into `shared/` UMD modules to delete the "mirrored" test
> blocks — the current pass keeps that logic inside the content files and leaves the mirrors in
> place, so no test behavior changed.

---

## 1. Motivation

`apps/extension/` is a flat directory of large single-purpose files. `content.js` alone is **4,443 lines / ~149 KB with 187 top-level functions**, mixing eight unrelated concerns (scanner detection, GS1 parsing, storage, queue/inventory, Panorama DOM autofill, HUD/toast UI, orchestration, analytics). `popup.js` (1,720) and `background.js` (1,724) are similarly monolithic. Problems this causes:

1. **Not scalable.** Adding a new EMR platform or workflow means editing the same giant files, so every change collides. The CLAUDE.md-referenced platform-registry refactor has no place to live.
2. **Weak separation of concerns.** DOM autofill, business logic, and UI are interleaved in one scope.
3. **Test drift.** Because `content.js` is a classic script with no exports, the suite *re-implements* its logic — `content-keydown-buffer.test.js` says *"Mirrored from content.js"* and `helpers/clinic-sim.js` says *"mirrored from content.js — keep in sync."* Mirrors drift from production.
4. **Merge friction.** Clinic-pilot fixes (#24–#29) repeatedly conflict on `dev → main` in these files.

### Goals
- A **clean, modular folder structure** with one concern per directory, ready to scale (new EMR adapters, new workflows) without touching unrelated code.
- **Directly testable modules** — tests import real files, deleting the mirrored copies.

### Non-goals
- **No behavior change.** Pure structural refactor, gated by the existing `node:test` suite at every step.
- **No build step.** The extension is loaded directly by Chrome (CLAUDE.md). No bundler, no transpilation, no TypeScript.
- **No manifest name churn.** Only structural fields change; the name stays stamped by `scripts/package-extension.sh`.

---

## 2. Constraints that shape the structure

Verified against the codebase:

| Fact | Implication for the refactor |
|---|---|
| Package script (`scripts/package-extension.sh`) recursively `copytree` + `os.walk`s **all** of `apps/extension/`, excluding only `.claude`, `.gitignore`, `README.md`. | **Subfolders ship automatically.** Folder structure is fully compatible with the Chrome Web Store zip. |
| **Content scripts** (`content.js`, `panorama-agent-rules.js`) are classic scripts in MV3 — **no ES `import`**. They share one isolated-world global scope, loaded in `manifest.json` `content_scripts[].js` **array order**. | Content-world files split into ordered files that attach to a `globalThis.VaxLink.*` namespace inside IIFEs (the proven `panorama-agent-rules.js` pattern). Manifest lists them in dependency order. |
| **Popup** already loads via `<script type="module" src="popup.js">`; `popup-parser.js`, `popup-inventory.js`, `queue-record.js` are ES modules with `export`. | Popup-world files use real ES modules and relative `import`. |
| **Background** is a classic service worker today, but MV3 supports `"type": "module"` workers. | Background may opt into ES modules to import shared logic. |
| Tests load real files via `vm.runInContext` (`background.js`) and `require` (`panorama-agent-rules.js`), per `helpers/clinic-sim.js`. | Extracted content-world modules stay loadable the same way, so tests use real code, not mirrors. |

**The core rule:** three execution contexts (content / popup / background) with different module capabilities. The folder tree makes that boundary explicit so nobody accidentally `import`s a content-world file into a place that can't load it.

---

## 3. Target folder structure

```
apps/extension/
├── manifest.json
├── popup.html
├── assets/
│
├── shared/                     # pure logic usable by ANY context (UMD-style: attaches to
│   │                           #   globalThis AND sets module.exports — loadable as classic
│   │                           #   script, ES import, or require). No DOM, no chrome.* calls.
│   ├── gs1/
│   │   ├── ai-tables.js        # GS1 Application Identifier definitions
│   │   ├── parse-scanner.js    # scanner keystroke-timing GS1 parse (from content.js)
│   │   └── parse-manual.js     # manual-input parse (today's popup-parser.js)
│   ├── vaccine/
│   │   ├── expiry.js           # getExpiryStatus, parseDateToLocal, date helpers
│   │   └── classify.js         # lot/GTIN → agent classification helpers
│   ├── queue/
│   │   └── record.js           # today's queue-record.js (row normalization / CSV shape)
│   └── namespace.js            # defines globalThis.VaxLink = {} bootstrap for content world
│
├── content/                    # CONTENT-SCRIPT world (classic scripts, globalThis.VaxLink.*)
│   ├── content.js              # entry orchestrator: message listener, page gating, watchers
│   ├── core/
│   │   ├── log.js              # vlog
│   │   ├── storage.js          # getLocalStorage / setLocalStorage / appendQueue…
│   │   ├── settings.js         # normalize*Setting
│   │   ├── audio.js            # getAudioContext, playAudioCue
│   │   └── analytics.js        # logAnalyticsEvent
│   ├── scanner/
│   │   ├── detect.js           # keystroke-timing detection, buffer, key/paste/input handlers
│   │   └── handle-scan.js      # handleHandsFreeScan orchestration
│   ├── workflow/
│   │   ├── mode.js             # normalizeWorkflowMode, storage-key selection
│   │   └── queue.js            # buildInventoryRecordFromParsed, saveScanToQueue, merges
│   ├── platforms/              # ← the scalability seam for new EMRs
│   │   ├── registry.js         # isHandsFreeSupportedPage, dispatch to the right adapter
│   │   ├── panorama/
│   │   │   ├── agent-rules.js  # today's panorama-agent-rules.js (data)
│   │   │   ├── fields.js       # fillField/fillSelect/fillCombo/label-finding primitives
│   │   │   ├── autofill.js     # agent→lot→trade→date/funding orchestration, isPrimeFacesAjaxBusy
│   │   │   └── multi.js        # multiple-grid + multi-step detail pages
│   │   └── inputhealth/
│   │       └── autofill.js     # generic-fill path (extracted from autoFillTelus)
│   └── ui/
│       ├── hud.js              # initHud + HUD state/position/mode
│       └── toast.js            # showVaxlinkToast, ensureToastHost
│
├── popup/                      # POPUP world (ES modules)
│   ├── popup.js                # entry (referenced by popup.html)
│   ├── inventory.js            # today's popup-inventory.js
│   ├── ui.js                   # today's popup-ui.js
│   └── parser.js               # thin re-export of shared/gs1/parse-manual.js
│
└── background/                 # SERVICE-WORKER world
    └── background.js           # (optionally "type": "module" to import shared/*)
```

**Guiding principles**
- **`shared/`** holds only pure, side-effect-free logic (no `document`, no `chrome.*`). Written UMD-style so it loads in all three contexts and in Node tests. This is where the "mirrored" test logic collapses into one real source of truth.
- **`content/platforms/`** is the scalability payoff: adding an EMR = adding one folder + registering it in `registry.js`. This primes the CLAUDE.md platform-registry refactor without doing it now.
- **Each context is a top-level folder** so the module-capability boundary (import vs. globalThis) is visually obvious and enforced by convention.
- **`content.js`, `popup.js`, `background.js` remain the named entry points** referenced by `manifest.json` / `popup.html`, just relocated and slimmed to orchestration.

`manifest.json` content-script list becomes an ordered, foldered array, e.g.:

```json
"content_scripts": [{
  "js": [
    "shared/namespace.js",
    "shared/gs1/ai-tables.js",
    "shared/gs1/parse-scanner.js",
    "shared/vaccine/expiry.js",
    "shared/queue/record.js",
    "content/core/log.js",
    "content/core/storage.js",
    "content/core/settings.js",
    "content/core/audio.js",
    "content/core/analytics.js",
    "content/workflow/mode.js",
    "content/workflow/queue.js",
    "content/platforms/panorama/agent-rules.js",
    "content/platforms/panorama/fields.js",
    "content/platforms/panorama/autofill.js",
    "content/platforms/panorama/multi.js",
    "content/platforms/inputhealth/autofill.js",
    "content/platforms/registry.js",
    "content/scanner/detect.js",
    "content/scanner/handle-scan.js",
    "content/ui/toast.js",
    "content/ui/hud.js",
    "content/content.js"
  ],
  "run_at": "document_start"
}]
```

(`matches` unchanged.) Order = dependency order: shared → core → workflow → platforms → scanner/ui → orchestrator.

---

## 4. Phased execution (each phase test-green & independently shippable)

Order: lowest-risk pure logic first, DOM/UI last. Move code **verbatim** — no logic edits in a move commit.

- **Phase 0 — Safety net.** `cd apps/extension-tests && npm test` green; record baseline pass count. Inventory every "mirrored" test block that Phase 2 will replace with a real import.

- **Phase 1 — Scaffold folders + relocate existing modules.** Create the tree. Move the *already-modular* files first with zero content change: `popup-*.js → popup/`, `queue-record.js → shared/queue/record.js`, `panorama-agent-rules.js → content/platforms/panorama/agent-rules.js`, `background.js → background/`. Update `manifest.json`, `popup.html`, and test import paths. This proves the folder plumbing (manifest paths, packaging, tests) before any hard extraction.

- **Phase 2 — Extract pure logic into `shared/`.** Pull scanner GS1 parsing, expiry/date, classification, AI tables out of `content.js` into `shared/`. **Delete the mirrored copies** in `content-keydown-buffer.test.js` / `helpers/clinic-sim.js`; point those tests at the real `shared/` file via the existing `vm`/`require` pattern. Biggest net win: less code *and* stronger tests.

- **Phase 3 — Extract `content/core/` + `content/workflow/`.** Logging, storage, settings, audio, analytics, workflow mode, queue building. Side-effect-light; guarded by suite.

- **Phase 4 — Extract `content/platforms/`.** Panorama `fields`/`autofill`/`multi`, plus `inputhealth/autofill` from `autoFillTelus`, behind a `registry.js` that owns `isHandsFreeSupportedPage()` dispatch. Preserve the fill invariant (`agent → lot → deferred date/time`, gated on `!isPrimeFacesAjaxBusy()`) and the intentional Panorama ID misspellings (e.g. `dateAdministedDate`) **verbatim**. Use `pano1.html`/`pano2.html` fixtures.

- **Phase 5 — Extract `content/ui/` + slim `content/content.js`.** HUD (`initHud` ≈ 450 lines) and toast last (least automated coverage). `content.js` becomes a thin orchestrator: message listener, page gating, watcher init.

- **Phase 6 — Verify.** Full `npm test`; `node --check` on every file (mirrors `extension-ci.yml`); load unpacked in `chrome://extensions`; manual smoke test on Panorama (agent/lot/date autofill, HUD, single/multiple/inventory workflows); `./scripts/package-extension.sh alpha` builds a valid zip; optionally `/code-review` the branch diff.

---

## 5. Per-phase acceptance criteria

Every phase must satisfy **all** of:
1. Test suite passes at **≥** the Phase-0 baseline (no test deleted without a real-code test replacing a mirror).
2. `node --check` passes on every changed/added `.js`.
3. No runtime behavior change — diffs are cut/paste + namespacing/imports only.
4. `manifest.json` changes limited to structural fields (`content_scripts[].js`, `background`); `name`/`version` untouched.
5. Branch still packages: `./scripts/package-extension.sh alpha` produces a zip whose contents include the new folders and exclude tests.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Load-order bug** — a content file uses a global defined by a later file. | Manifest `js` array ordered by dependency; cross-file access via `VaxLink.*` resolved at call time. `node --check` + suite catch it. |
| **`import` used in a content-script file** (unsupported in MV3). | Convention enforced by folder: `content/**` never uses `import`; only `shared/**` (UMD) and `popup/**`/`background/**` (ES modules) do. |
| **Broken relative paths** after moves (manifest, popup.html, tests). | Phase 1 moves *already-modular* files first and re-runs suite + a manual load before any extraction. |
| **Packaging picks up the wrong files.** | Package script recurses all of `apps/extension/`; tests stay in `apps/extension-tests/`. Phase 6 inspects zip contents. |
| **Merge conflicts with in-flight pilot fixes (#24–#29).** | Land as one focused PR promptly; phase-per-commit localizes conflicts to one concern; coordinate rebases. |
| **Silent behavior change during cut/paste.** | Move verbatim; forbid logic edits in a move commit; suite is the gate. |
| **Panorama regressions not caught by unit tests.** | Phase 6 manual smoke test against real Panorama; keep `pano1.html`/`pano2.html` as references. |

---

## 7. What this unlocks (future, out of scope here)

- **Platform-registry refactor** (CLAUDE.md / `skills/vaxlink-emr-adaptation/SKILL.md`): with `content/platforms/<emr>/` + `registry.js` in place, a new EMR is a new folder + one registration — no edits to scanner, queue, or UI code.
- **Popup/background decomposition** into their folders' sub-modules using the same playbook (ES modules).
- Still explicitly rejected: TypeScript / any build step.

---

## 8. First concrete step

Branch `refactor/extension-architecture` exists. Begin **Phase 0**: run the suite, record the baseline, and list the exact "mirrored" test blocks to be replaced by real `shared/` imports in Phase 2.
