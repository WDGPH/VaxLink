/**
 * Shared helpers for the clinic-simulation test suites.
 *
 * Unlike the older "mirrored logic" tests, the background pipeline here is the
 * REAL apps/extension/background.js, evaluated in a Node vm sandbox with a
 * mocked `chrome` API. The NVC bundle is seeded into mocked storage exactly the
 * way the deployed extension caches it (`nvc_bundle_override`), so lookups run
 * the same indexing and resolution code paths as production.
 *
 * Requires apps/extension/nvc_bundle.json (gitignored). Download with:
 *   bash scripts/fetch-nvc.sh
 */

import vm from 'node:vm';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// NVC bundle loading (extension-tests/helpers/ → extension-tests/ → apps/ → extension/)
// ---------------------------------------------------------------------------

export const BUNDLE_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../extension/nvc_bundle.json'
);

export function loadNvcBundle() {
  if (!existsSync(BUNDLE_PATH)) return null;
  return JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));
}

/**
 * Extract every catalogue lot from the bundle as a flat record:
 * { lotNumber, code, expiryIso, manufacturer, tradenameRefs: [{code, display}] }
 */
export function extractCatalogueLots(bundle) {
  const lots = [];
  for (const entry of bundle.entry || []) {
    const r = entry.resource;
    if (!r || r.resourceType !== 'CodeSystem' || r.id !== 'nvc-vaccine-lot-id') continue;
    for (const concept of r.concept || []) {
      let lotNumber = null;
      let expiryIso = null;
      for (const prop of concept.property || []) {
        if (prop.code === 'lotNumber' && prop.valueString) lotNumber = prop.valueString;
        // Same precedence as background.js extractLotExpiry: first matching
        // property in document order wins.
        if (!expiryIso && (prop.code === 'expiryDate' || prop.code === 'originalExpiryDate')) {
          expiryIso = prop.valueDateTime || null;
        }
      }
      if (!lotNumber) continue;

      const tradenameRefs = [];
      let manufacturer = null;
      for (const ext of concept.extension || []) {
        const url = String(ext.url || '').toLowerCase();
        const coding = ext.valueCodeableConcept?.coding?.[0] || null;
        if (url.includes('linked-tradename-concept') && coding) {
          tradenameRefs.push({ code: coding.code || '', display: coding.display || '' });
        }
        if (url.includes('market-authorization-holder') && coding) {
          manufacturer = coding.display || coding.code || null;
        }
      }

      lots.push({ lotNumber, code: concept.code || '', expiryIso, manufacturer, tradenameRefs });
    }
  }
  return lots;
}

// ---------------------------------------------------------------------------
// GS1 barcode synthesis (what a vial's DataMatrix scanner wedge emits)
// ---------------------------------------------------------------------------

export const GS = String.fromCharCode(0x1d);

/** Deterministic synthetic GTIN-14 with valid check digit. Uses the unassigned
 * GS1 prefix 999 so it can never collide with a real override GTIN. */
export function makeSyntheticGtin14(seed) {
  const base = `0999900${String(Math.abs(seed) % 1000000).padStart(6, '0')}`;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    sum += Number(base[12 - i]) * (i % 2 === 0 ? 3 : 1);
  }
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

/** "2026-02-07" → "260207". Null/invalid dates return null (omit AI 17). */
export function isoToYYMMDD(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1].slice(2) + m[2] + m[3] : null;
}

/**
 * Build the keyboard-wedge text for a vial scan:
 *   (01) GTIN-14, (17) expiry, (10) lot, optional GS + (21) serial.
 * AI(01) and AI(17) are fixed-length so no separator precedes (10); the lot is
 * the final variable-length field unless a serial follows after a GS.
 */
export function buildVialBarcode({ gtin, expiryIso, lot, serial = null }) {
  let scan = '';
  if (gtin) scan += `01${gtin}`;
  const yymmdd = isoToYYMMDD(expiryIso);
  if (yymmdd) scan += `17${yymmdd}`;
  scan += `10${lot}`;
  if (serial) scan += `${GS}21${serial}`;
  return scan;
}

// ---------------------------------------------------------------------------
// Background service-worker harness (real background.js under a chrome mock)
// ---------------------------------------------------------------------------

const BACKGROUND_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../extension/background.js'
);

export function createBackgroundHarness(bundle) {
  const storageData = new Map();
  // Seed storage the way a synced production install looks: cached bundle plus
  // a fresh last-check timestamp so the startup auto-refresh skips the network.
  storageData.set('nvc_bundle_override', bundle);
  storageData.set('nvc_bundle_source_url', 'https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC');
  storageData.set('nvc_bundle_last_check_at', new Date().toISOString());

  const changedListeners = [];
  const messageListeners = [];
  const alarms = [];
  const consoleLines = [];
  let badgeText = '';

  function resolveKeys(keys) {
    if (keys === null || keys === undefined) return [...storageData.keys()];
    if (Array.isArray(keys)) return keys;
    if (typeof keys === 'string') return [keys];
    return Object.keys(keys);
  }

  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      getURL: (p) => `chrome-extension://vaxlink-test/${p}`
    },
    alarms: {
      create: (name, info) => alarms.push({ name, info }),
      onAlarm: { addListener() {} }
    },
    action: {
      setIcon() {},
      setBadgeText: ({ text }) => { badgeText = text; },
      setBadgeBackgroundColor() {}
    },
    storage: {
      onChanged: { addListener: (fn) => changedListeners.push(fn) },
      local: {
        get(keys, callback) {
          const result = {};
          for (const key of resolveKeys(keys)) {
            if (storageData.has(key)) result[key] = storageData.get(key);
          }
          if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
            for (const [key, fallback] of Object.entries(keys)) {
              if (!(key in result)) result[key] = fallback;
            }
          }
          queueMicrotask(() => callback(result));
        },
        set(values, callback) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: storageData.get(key), newValue: value };
            storageData.set(key, value);
          }
          queueMicrotask(() => {
            for (const fn of changedListeners) fn(changes, 'local');
            if (callback) callback();
          });
        }
      }
    }
  };

  const sandbox = {
    chrome,
    console: {
      log: (...args) => consoleLines.push(['log', ...args]),
      warn: (...args) => consoleLines.push(['warn', ...args]),
      error: (...args) => consoleLines.push(['error', ...args])
    },
    // Network is forbidden in tests; the icon fetch failure is caught inside
    // ensureActionIcon and the bundle path never hits fetch (storage is seeded).
    fetch: () => Promise.reject(new Error('network disabled in clinic-sim tests')),
    crypto: globalThis.crypto,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask
  };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(BACKGROUND_PATH, 'utf8'), sandbox, { filename: 'background.js' });

  function sendMessage(request) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sendResponse = (response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      let isAsync = false;
      for (const listener of messageListeners) {
        if (listener(request, { id: 'clinic-sim' }, sendResponse) === true) {
          isAsync = true;
        }
      }
      if (!isAsync && !settled) {
        settled = true;
        resolve(undefined);
      }
      setTimeout(() => {
        if (!settled) reject(new Error(`sendResponse never called for action ${request?.action}`));
      }, 15000).unref();
    });
  }

  return {
    sendMessage,
    storageData,
    alarms,
    consoleLines,
    getBadgeText: () => badgeText
  };
}

// ---------------------------------------------------------------------------
// Panorama agent matching (mirrored from content.js — keep in sync)
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
require(path.resolve(fileURLToPath(import.meta.url), '../../../extension/panorama-agent-rules.js'));
const PANORAMA_AGENT_RULES = globalThis.VAXLINK_PANORAMA_AGENT_RULES;

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[:/,_-]/g, ' ')
    .replace(/\broute\b/g, ' ')
    .replace(/\bqualifier\b/g, ' ')
    .replace(/\bvalue\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPanoramaAgentSourceText(data) {
  return normalizeForMatch([
    data?.name, data?.generic_name, data?.tradename, data?.disease,
    data?.antigen, data?.manufacturer, data?.route, data?.strength
  ].filter(Boolean).join(' '));
}

function panoramaSourceHasNormalizedTerm(src, tokens, term) {
  const normalizedTerm = normalizeForMatch(term);
  if (!normalizedTerm) return false;
  const termTokens = normalizedTerm.split(' ').filter(Boolean);
  if (!termTokens.length) return false;
  if (termTokens.length === 1) {
    const token = termTokens[0];
    return token.length <= 3 ? tokens.includes(token) : (tokens.includes(token) || src.includes(token));
  }
  if (src.includes(normalizedTerm)) return true;
  return termTokens.every((token) =>
    token.length <= 3 ? tokens.includes(token) : (tokens.includes(token) || src.includes(token))
  );
}

function clauseMatches(src, clause) {
  const tokens = src.split(' ').map((t) => t.trim()).filter(Boolean);
  if (clause.any && !clause.any.some((t) => panoramaSourceHasNormalizedTerm(src, tokens, t))) return false;
  if (clause.all && !clause.all.every((t) => panoramaSourceHasNormalizedTerm(src, tokens, t))) return false;
  if (clause.notAny && clause.notAny.some((t) => panoramaSourceHasNormalizedTerm(src, tokens, t))) return false;
  if (clause.notAll && clause.notAll.every((t) => panoramaSourceHasNormalizedTerm(src, tokens, t))) return false;
  return true;
}

export function getAgentOutputs(vaccineInfo) {
  const src = buildPanoramaAgentSourceText(vaccineInfo);
  const outputs = new Set();
  for (const rule of PANORAMA_AGENT_RULES || []) {
    if ((rule.clauses || []).some((clause) => clauseMatches(src, clause))) {
      for (const output of rule.outputs || []) outputs.add(output);
    }
  }
  return outputs;
}
