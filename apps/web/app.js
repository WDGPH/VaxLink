const API_URL = "https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC";
const LOCAL_BUNDLE_PATH = "./nvc-bundle.json";

const state = {
  bundle: null,
  entries: [],
  filtered: [],
  selectedIndex: null,
  lotConcepts: [],
};

const els = {
  loadLocalBtn: document.getElementById("loadLocalBtn"),
  loadRemoteBtn: document.getElementById("loadRemoteBtn"),
  status: document.getElementById("status"),
  bundleMeta: document.getElementById("bundleMeta"),
  barcodeInput: document.getElementById("barcodeInput"),
  parseBarcodeBtn: document.getElementById("parseBarcodeBtn"),
  clearBarcodeBtn: document.getElementById("clearBarcodeBtn"),
  barcodeResult: document.getElementById("barcodeResult"),
  searchInput: document.getElementById("searchInput"),
  resourceTypeSelect: document.getElementById("resourceTypeSelect"),
  typeSummary: document.getElementById("typeSummary"),
  resourceTableBody: document.getElementById("resourceTableBody"),
  detailSummary: document.getElementById("detailSummary"),
  jsonViewer: document.getElementById("jsonViewer"),
};

const setStatus = (message) => {
  els.status.textContent = message;
};

const toPrimaryLabel = (resource) => {
  return resource.title || resource.name || resource.id || "(no title/name/id)";
};

const conceptExtensionValues = (concept) => {
  const values = [];
  for (const ext of concept.extension || []) {
    if (typeof ext.valueString === "string") values.push(ext.valueString);
    if (typeof ext.valueDate === "string") values.push(ext.valueDate);
    if (typeof ext.valueBoolean === "boolean") values.push(String(ext.valueBoolean));
    if (ext.valueCodeableConcept?.text) values.push(ext.valueCodeableConcept.text);
    for (const coding of ext.valueCodeableConcept?.coding || []) {
      if (coding.code) values.push(coding.code);
      if (coding.display) values.push(coding.display);
    }
  }
  return values;
};

const getConceptProperty = (concept, code) => {
  const prop = (concept.property || []).find((p) => p.code === code);
  if (!prop) return "";
  if (typeof prop.valueString === "string") return prop.valueString;
  if (typeof prop.valueDateTime === "string") return prop.valueDateTime;
  if (prop.valueCoding?.code) return prop.valueCoding.code;
  if (prop.valueCoding?.display) return prop.valueCoding.display;
  if (typeof prop.valueBoolean === "boolean") return String(prop.valueBoolean);
  return "";
};

const getExtensionText = (concept, urlPart) => {
  const ext = (concept.extension || []).find((e) => (e.url || "").includes(urlPart));
  if (!ext) return "";
  if (ext.valueCodeableConcept?.text) return ext.valueCodeableConcept.text;
  return ext.valueString || "";
};

const normalizeLot = (value) => (value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const toIsoDateYYMMDD = (value) => {
  if (!/^\d{6}$/.test(value || "")) return "";
  const yy = Number(value.slice(0, 2));
  const mm = value.slice(2, 4);
  const dd = value.slice(4, 6);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${year}-${mm}-${dd}`;
};

const parseDelimitedAIs = (raw) => {
  const out = {};
  const regex = /[\(\[](\d{2})[\)\]]\s*([^\(\)\[\]\u001d]*)/g;
  let match = null;
  while ((match = regex.exec(raw)) !== null) {
    const ai = match[1];
    const value = match[2].trim();
    if (value) out[ai] = value;
  }
  return out;
};

const parseCompactAIs = (raw) => {
  const out = {};
  const fixed = { "01": 14, "11": 6, "13": 6, "15": 6, "17": 6 };
  const variable = new Set(["10", "21"]);
  const input = raw.replace(/\s+/g, "").replace(/^\]d2/i, "");
  const isSep = (ch) => ch === "\u001d" || ch === "|";

  let i = 0;
  while (i < input.length) {
    if (isSep(input[i])) {
      i += 1;
      continue;
    }

    const ai = input.slice(i, i + 2);
    if (fixed[ai]) {
      const len = fixed[ai];
      const start = i + 2;
      const end = start + len;
      const value = input.slice(start, end);
      if (value.length === len) out[ai] = value;
      i = end;
      continue;
    }

    if (variable.has(ai)) {
      const start = i + 2;
      i = start;
      while (i < input.length && !isSep(input[i])) {
        const nextAi = input.slice(i, i + 2);
        if (fixed[nextAi] && input.length - i - 2 >= fixed[nextAi]) break;
        if (variable.has(nextAi) && i > start) break;
        i += 1;
      }
      const value = input.slice(start, i);
      if (value) out[ai] = value;
      continue;
    }

    i += 1;
  }

  return out;
};

const parseLabelFields = (raw) => {
  const out = {};
  const lotMatch = raw.match(/\b(?:lot|lot\s*number|batch|batch\s*number|bn)\b\s*[:#-]?\s*([A-Za-z0-9\-\/]+)/i);
  const expMatch = raw.match(/\b(?:exp|expiry|expires)\b\s*[:#-]?\s*([0-9]{2,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4}|[0-9]{6,8})/i);
  const dinMatch = raw.match(/\bdin\b\s*[:#-]?\s*([0-9]{8})\b/i);
  if (lotMatch) out.lot = lotMatch[1];
  if (expMatch) out.exp = expMatch[1];
  if (dinMatch) out.din = dinMatch[1];
  return out;
};

const parseBarcodePayload = (raw) => {
  const fields = {};
  const evidence = [];
  const clean = raw.trim();
  const assign = (key, value, source) => {
    if (!value || fields[key]) return;
    fields[key] = value;
    evidence.push(`${source}: ${key}=${value}`);
  };

  const delimited = parseDelimitedAIs(clean);
  assign("gtin", delimited["01"], "AI");
  assign("lot", delimited["10"], "AI");
  assign("serial", delimited["21"], "AI");
  assign("expiry", toIsoDateYYMMDD(delimited["17"]) || delimited["17"], "AI");

  const compact = parseCompactAIs(clean);
  assign("gtin", compact["01"], "compact AI");
  assign("lot", compact["10"], "compact AI");
  assign("serial", compact["21"], "compact AI");
  assign("expiry", toIsoDateYYMMDD(compact["17"]) || compact["17"], "compact AI");

  const labels = parseLabelFields(clean);
  assign("lot", labels.lot, "label");
  assign("din", labels.din, "label");
  assign("expiry", labels.exp, "label");

  return { fields, evidence };
};

const findLotMatches = (lotValue) => {
  const needle = normalizeLot(lotValue);
  if (!needle) return [];
  const matches = [];

  for (const concept of state.lotConcepts) {
    const lot = getConceptProperty(concept, "lotNumber");
    if (normalizeLot(lot) !== needle) continue;

    matches.push({
      lot,
      conceptCode: concept.code || "",
      tradename: getExtensionText(concept, "nvc-linked-tradename-concept"),
      marketAuthorizationHolder: getExtensionText(concept, "nvc-linked-to-market-authorization-holder"),
      din: getConceptProperty(concept, "drugIdentificationNumber"),
      expiryDate: getConceptProperty(concept, "expiryDate"),
      healthCanadaApprovalDate: getConceptProperty(concept, "healthCanadaApprovalDate"),
    });
  }

  return matches;
};

const renderBarcodeResult = (parsed, matches) => {
  const lines = [];
  lines.push(`Parsed fields: ${Object.keys(parsed.fields).length === 0 ? "none" : ""}`);
  for (const [key, value] of Object.entries(parsed.fields)) {
    lines.push(`- ${key}: ${value}`);
  }

  if (parsed.evidence.length > 0) {
    lines.push("");
    lines.push("Detected by:");
    for (const hit of parsed.evidence) lines.push(`- ${hit}`);
  }

  if (parsed.fields.lot) {
    lines.push("");
    lines.push(`Lot lookup (${parsed.fields.lot}): ${matches.length} match(es)`);
    for (const m of matches.slice(0, 10)) {
      lines.push(`- tradename: ${m.tradename || "n/a"}`);
      lines.push(`  lot: ${m.lot || "n/a"} | expiry: ${m.expiryDate || "n/a"} | DIN: ${m.din || "n/a"}`);
      lines.push(`  MAH: ${m.marketAuthorizationHolder || "n/a"}`);
      lines.push(`  lot code: ${m.conceptCode || "n/a"}`);
    }
    if (matches.length > 10) lines.push(`- ...and ${matches.length - 10} more`);
  }

  els.barcodeResult.textContent = lines.join("\n");
};

const handleParseBarcode = () => {
  const raw = els.barcodeInput.value.trim();
  if (!raw) {
    els.barcodeResult.textContent = "No input. Paste a scanned payload first.";
    return;
  }

  const parsed = parseBarcodePayload(raw);
  const matches = parsed.fields.lot ? findLotMatches(parsed.fields.lot) : [];
  renderBarcodeResult(parsed, matches);

  if (parsed.fields.lot) {
    els.searchInput.value = parsed.fields.lot;
    els.resourceTypeSelect.value = "";
    applyFilters();
  }
};

const collectNestedConceptText = (resource) => {
  const tokens = [];
  if (resource.resourceType === "ValueSet") {
    for (const include of resource.compose?.include || []) {
      for (const concept of include.concept || []) {
        if (concept.code) tokens.push(concept.code);
        if (concept.display) tokens.push(concept.display);
        for (const d of concept.designation || []) {
          if (d.value) tokens.push(d.value);
          if (d.language) tokens.push(d.language);
          if (d.use?.code) tokens.push(d.use.code);
          if (d.use?.display) tokens.push(d.use.display);
        }
        tokens.push(...conceptExtensionValues(concept));
      }
    }
  }
  if (resource.resourceType === "CodeSystem") {
    for (const concept of resource.concept || []) {
      if (concept.code) tokens.push(concept.code);
      if (concept.display) tokens.push(concept.display);
      if (concept.definition) tokens.push(concept.definition);
      for (const d of concept.designation || []) {
        if (d.value) tokens.push(d.value);
      }
      for (const p of concept.property || []) {
        if (p.code) tokens.push(p.code);
        if (typeof p.valueString === "string") tokens.push(p.valueString);
        if (typeof p.valueDateTime === "string") tokens.push(p.valueDateTime);
      }
    }
  }
  return tokens;
};

const findMatchingConcept = (resource, query) => {
  if (!query) return null;
  if (resource.resourceType === "ValueSet") {
    for (const include of resource.compose?.include || []) {
      for (const concept of include.concept || []) {
        const text = [
          concept.code,
          concept.display,
          ...(concept.designation || []).map((d) => d.value),
          ...conceptExtensionValues(concept),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (text.includes(query)) return concept;
      }
    }
  }
  if (resource.resourceType === "CodeSystem") {
    for (const concept of resource.concept || []) {
      const text = [
        concept.code,
        concept.display,
        concept.definition,
        ...(concept.designation || []).map((d) => d.value),
        ...(concept.property || []).flatMap((p) => [
          p.code,
          p.valueString,
          p.valueDateTime,
          p.valueCoding?.code,
          p.valueCoding?.display,
        ]),
        ...conceptExtensionValues(concept),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (text.includes(query)) return concept;
    }
  }
  return null;
};

const summarizeResource = (resource) => {
  const parts = [
    `resourceType: ${resource.resourceType || "unknown"}`,
    resource.id ? `id: ${resource.id}` : null,
    resource.name ? `name: ${resource.name}` : null,
    resource.title ? `title: ${resource.title}` : null,
    resource.url ? `url: ${resource.url}` : null,
    resource.status ? `status: ${resource.status}` : null,
    resource.version ? `version: ${resource.version}` : null,
    resource.publisher ? `publisher: ${resource.publisher}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
};

const buildSearchBlob = (resource) => {
  return [
    resource.resourceType,
    resource.id,
    resource.name,
    resource.title,
    resource.url,
    resource.status,
    resource.version,
    resource.publisher,
    resource.description,
    ...collectNestedConceptText(resource),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
};

const renderTypeSummary = (entries) => {
  const counts = new Map();
  for (const entry of entries) {
    const type = entry.resource?.resourceType || "Unknown";
    counts.set(type, (counts.get(type) || 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  els.typeSummary.innerHTML = sorted
    .map(([type, count]) => `<span class="badge">${type}: ${count}</span>`)
    .join("");
};

const renderTypeFilter = (entries) => {
  const types = [...new Set(entries.map((e) => e.resource?.resourceType).filter(Boolean))].sort();
  const previous = els.resourceTypeSelect.value;
  els.resourceTypeSelect.innerHTML = `<option value="">All</option>${types
    .map((type) => `<option value="${type}">${type}</option>`)
    .join("")}`;

  if (types.includes(previous)) {
    els.resourceTypeSelect.value = previous;
  }
};

const renderBundleMeta = () => {
  if (!state.bundle) {
    els.bundleMeta.textContent = "";
    return;
  }

  const b = state.bundle;
  els.bundleMeta.textContent = `Bundle ${b.id || "(no id)"} | type: ${b.type || "n/a"} | entries: ${
    state.entries.length
  }`;
};

const showSelection = (index) => {
  const entry = state.filtered[index];
  if (!entry) {
    state.selectedIndex = null;
    els.detailSummary.textContent = "Select a row to inspect details.";
    els.jsonViewer.textContent = "";
    return;
  }

  state.selectedIndex = index;
  const resource = entry.resource || {};
  const query = els.searchInput.value.trim().toLowerCase();
  const concept = findMatchingConcept(resource, query);
  const conceptLine = concept
    ? `\nMatched concept: code ${concept.code || "n/a"} | ${concept.display || "(no display)"}`
    : "";
  els.detailSummary.textContent = `${summarizeResource(resource)}${conceptLine}`;
  els.jsonViewer.textContent = JSON.stringify(resource, null, 2);
};

const renderTable = () => {
  if (state.filtered.length === 0) {
    els.resourceTableBody.innerHTML = `<tr><td colspan="5">No matching resources.</td></tr>`;
    showSelection(null);
    return;
  }

  els.resourceTableBody.innerHTML = state.filtered
    .map(({ resource }, index) => {
      const selectedClass = state.selectedIndex === index ? "selected" : "";
      return `
        <tr data-index="${index}" class="${selectedClass}">
          <td>${index + 1}</td>
          <td>${resource.resourceType || ""}</td>
          <td>${toPrimaryLabel(resource)}</td>
          <td>${resource.url || ""}</td>
          <td>${resource.status || ""}</td>
        </tr>
      `;
    })
    .join("");
};

const applyFilters = () => {
  const query = els.searchInput.value.trim().toLowerCase();
  const selectedType = els.resourceTypeSelect.value;

  state.filtered = state.entries.filter((entry) => {
    const resource = entry.resource || {};
    if (selectedType && resource.resourceType !== selectedType) {
      return false;
    }

    if (query) {
      const blob = entry.searchBlob || buildSearchBlob(resource);
      return blob.includes(query);
    }

    return true;
  });

  renderTable();
  if (state.filtered.length > 0) {
    showSelection(Math.min(state.selectedIndex ?? 0, state.filtered.length - 1));
    renderTable();
  }
};

const loadBundle = async (source = "local") => {
  setStatus(source === "local" ? "Loading local bundle..." : "Fetching remote bundle...");

  try {
    const response = await fetch(source === "local" ? LOCAL_BUNDLE_PATH : API_URL, {
      headers:
        source === "remote"
          ? {
              Accept: "application/json+fhir",
              "x-app-desc": "PHAC NVC Client",
            }
          : {},
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const bundle = await response.json();
    if (bundle.resourceType !== "Bundle" || !Array.isArray(bundle.entry)) {
      throw new Error("Response is not a valid FHIR Bundle with entry[]");
    }

    state.bundle = bundle;
    state.entries = bundle.entry.map((entry) => {
      const resource = entry.resource || {};
      return { resource, searchBlob: buildSearchBlob(resource) };
    });
    const lotCodeSystem = bundle.entry
      .map((e) => e.resource || {})
      .find((r) => r.resourceType === "CodeSystem" && r.id === "nvc-vaccine-lot-id");
    state.lotConcepts = lotCodeSystem?.concept || [];
    state.filtered = [...state.entries];
    state.selectedIndex = null;

    renderBundleMeta();
    renderTypeSummary(state.entries);
    renderTypeFilter(state.entries);
    applyFilters();

    setStatus(
      source === "local"
        ? `Loaded ${state.entries.length} resources from ${LOCAL_BUNDLE_PATH}`
        : `Loaded ${state.entries.length} resources from API`,
    );
  } catch (error) {
    setStatus(`Load failed (${source}): ${error.message}`);
  }
};

els.loadLocalBtn.addEventListener("click", () => {
  loadBundle("local");
});

els.loadRemoteBtn.addEventListener("click", () => {
  loadBundle("remote");
});

els.parseBarcodeBtn.addEventListener("click", handleParseBarcode);
els.clearBarcodeBtn.addEventListener("click", () => {
  els.barcodeInput.value = "";
  els.barcodeResult.textContent = "No barcode parsed yet.";
});

els.searchInput.addEventListener("input", applyFilters);
els.resourceTypeSelect.addEventListener("change", applyFilters);

els.resourceTableBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-index]");
  if (!row) {
    return;
  }

  const index = Number(row.dataset.index);
  showSelection(index);
  renderTable();
});

loadBundle("local");
