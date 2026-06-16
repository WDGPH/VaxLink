import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const rulesPath = path.resolve(
  fileURLToPath(import.meta.url),
  '../../extension/panorama-agent-rules.js'
);
require(rulesPath);
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

function buildAutofillPayloadFromQueueRecord(record) {
  if (!record) return null;
  return {
    tradename: record.tradename || '',
    generic_name: record.generic_name || '',
    disease: record.disease || '',
    antigen: record.antigen || '',
    manufacturer: record.manufacturer || '',
    route: record.route || '',
    strength: record.strength || '',
    din: record.din || '',
    drug_code: record.drug_code || record.din || '',
    name: record.name || record.generic_name || record.tradename || record.din || ''
  };
}

function buildPanoramaAgentSourceText(data) {
  return normalizeForMatch([
    data?.name,
    data?.generic_name,
    data?.tradename,
    data?.disease,
    data?.antigen,
    data?.manufacturer,
    data?.route,
    data?.strength
  ].filter(Boolean).join(' '));
}

function getNormalizedSourceTokens(sourceText) {
  return String(sourceText || '')
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

function panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term) {
  const normalizedTerm = normalizeForMatch(term);
  if (!normalizedTerm) return false;

  const termTokens = normalizedTerm.split(' ').filter(Boolean);
  if (!termTokens.length) return false;

  if (termTokens.length === 1) {
    const token = termTokens[0];
    if (token.length <= 3) {
      return sourceTokens.includes(token);
    }
    return sourceTokens.includes(token) || sourceText.includes(token);
  }

  if (sourceText.includes(normalizedTerm)) {
    return true;
  }

  return termTokens.every((token) => (
    token.length <= 3
      ? sourceTokens.includes(token)
      : (sourceTokens.includes(token) || sourceText.includes(token))
  ));
}

function panoramaSourceHasAny(sourceText, sourceTokens, terms) {
  return terms.some((term) => panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term));
}

function panoramaSourceHasAll(sourceText, sourceTokens, terms) {
  return terms.every((term) => panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term));
}

function panoramaAgentRuleMatches(sourceText, rule) {
  return (rule.clauses || []).some((clause) => {
    const sourceTokens = getNormalizedSourceTokens(sourceText);
    if (clause.any && !panoramaSourceHasAny(sourceText, sourceTokens, clause.any)) return false;
    if (clause.all && !panoramaSourceHasAll(sourceText, sourceTokens, clause.all)) return false;
    if (clause.notAny && panoramaSourceHasAny(sourceText, sourceTokens, clause.notAny)) return false;
    if (clause.notAll && panoramaSourceHasAll(sourceText, sourceTokens, clause.notAll)) return false;
    return true;
  });
}

function getPanoramaAgentCandidates(data) {
  const values = [];
  const seen = new Set();
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    const key = normalizeForMatch(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    values.push(raw);
  };

  add(data?.tradename);
  add(data?.generic_name);
  add(data?.name);

  const sourceText = buildPanoramaAgentSourceText(data);
  for (const rule of PANORAMA_AGENT_RULES) {
    if (!panoramaAgentRuleMatches(sourceText, rule)) continue;
    for (const output of rule.outputs || []) {
      add(output);
    }
  }

  add(data?.din);
  return values;
}

function isShortAgentCandidate(value) {
  const compact = normalizeForMatch(value).replace(/[^a-z0-9]/g, '');
  return compact.length > 0 && compact.length <= 3;
}

function filledAgentTextMatchesCandidate(filledRawValue, candidate) {
  const candidateNorm = normalizeForMatch(candidate);
  if (!candidateNorm) return false;
  const filledRaw = String(filledRawValue || '').trim();
  const filledNorm = normalizeForMatch(filledRaw);
  if (!filledNorm) return false;
  if (filledNorm === candidateNorm) return true;

  const candidateRaw = String(candidate || '').trim();
  if (candidateRaw && filledRaw.trim().toLowerCase().startsWith(candidateRaw.toLowerCase() + '-')) return false;
  if (filledNorm.includes(candidateNorm)) return true;

  const candidateTokens = candidateNorm.split(' ').filter((token) => token.length >= 3);
  return candidateTokens.length > 0 && candidateTokens.every((token) => filledNorm.includes(token));
}

function isAgentTextAccepted(candidate, filledRawValue) {
  const candidateNorm = normalizeForMatch(candidate);
  const filledRaw = String(filledRawValue || '').trim();
  const filledNorm = normalizeForMatch(filledRaw);
  if (filledAgentTextMatchesCandidate(filledRaw, candidate)) return true;

  if (isShortAgentCandidate(candidate)) {
    const token = candidateNorm.replace(/[^a-z0-9]/g, '');
    const filledCompact = filledNorm.replace(/[^a-z0-9]/g, '');
    if (filledCompact === token) return true;
    const bracketMatch = filledNorm.match(/\[([^\]]+)\]/);
    return !!(bracketMatch && normalizeForMatch(bracketMatch[1]).replace(/[^a-z0-9]/g, '') === token);
  }

  const candidateTokens = candidateNorm.split(' ').filter((token) => token.length >= 3);
  return candidateTokens.length > 0 && candidateTokens.every((token) => filledNorm.includes(token));
}

function queueRecordMatchesPanoramaAgentText(record, agentText) {
  const payload = buildAutofillPayloadFromQueueRecord(record);
  if (!payload) return false;
  const candidates = getPanoramaAgentCandidates(payload);
  return candidates.some((candidate) => isAgentTextAccepted(candidate, agentText));
}

function findMatchingQueueRecordIndexForPanoramaAgent(rows, agentText) {
  const raw = String(agentText || '').trim();
  if (!raw || !Array.isArray(rows) || !rows.length) return -1;
  return rows.findIndex((row) => queueRecordMatchesPanoramaAgentText(row, raw));
}

test('multi-step matching picks the queued record whose agent matches the current Panorama step', () => {
  const rows = [
    { tradename: 'Priorix', generic_name: '[MMR] Measles mumps rubella vaccine', disease: 'Measles, Mumps, Rubella' },
    {
      tradename: '[Inf] FLUZONE Quadrivalent',
      generic_name: '[Inf] Influenza quadrivalent vaccine',
      disease: 'Influenza',
      antigen: 'Influenza A virus subtype H1N1 antigen, Influenza virus antigen'
    },
    { tradename: 'Engerix B', generic_name: '[HB] Hepatitis B regular strength vaccine', disease: 'Hepatitis B', strength: '20' }
  ];

  assert.equal(findMatchingQueueRecordIndexForPanoramaAgent(rows, 'HB'), 2);
  assert.equal(findMatchingQueueRecordIndexForPanoramaAgent(rows, 'Inf (QIV)'), 1);
  assert.equal(findMatchingQueueRecordIndexForPanoramaAgent(rows, 'MMR'), 0);
});

test('multi-step matching uses Panorama agent outputs, not tradename scan order', () => {
  const rows = [
    { tradename: 'Boostrix', generic_name: '[Tdap] Tetanus diphtheria acellular pertussis vaccine', disease: 'Diphtheria, Tetanus, Pertussis' },
    {
      tradename: '[Inf] FLUZONE High-Dose Quadrivalent',
      generic_name: '[Inf] Influenza quadrivalent vaccine',
      disease: 'Influenza',
      antigen: 'Influenza A virus subtype H1N1 antigen, Influenza virus antigen'
    }
  ];

  assert.equal(findMatchingQueueRecordIndexForPanoramaAgent(rows, 'Inf High Dose (QIV)'), 1);
});

test('multi-step matching leaves the queue untouched when the current Panorama step has no queued match', () => {
  const rows = [
    { tradename: 'Priorix', generic_name: '[MMR] Measles mumps rubella vaccine', disease: 'Measles, Mumps, Rubella' },
    { tradename: 'Engerix B', generic_name: '[HB] Hepatitis B regular strength vaccine', disease: 'Hepatitis B', strength: '20' }
  ];

  assert.equal(findMatchingQueueRecordIndexForPanoramaAgent(rows, 'Var'), -1);
});
