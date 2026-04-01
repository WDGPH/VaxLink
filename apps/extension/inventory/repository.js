import {
  LEGACY_DO_NOT_USE_KEY,
  LEGACY_INCIDENTS_KEY,
  LEGACY_INVENTORY_BATCH_KEY,
  LEGACY_LEDGER_KEY,
  LEGACY_RECON_KEY,
  INVENTORY_DB_NAME,
  INVENTORY_DB_VERSION,
  STORE_INCIDENTS,
  STORE_ITEMS,
  STORE_LOT_FLAGS,
  STORE_MONITORING_CASES,
  STORE_RECONCILIATIONS,
  STORE_SHIPMENT_COMPARISONS,
  STORE_TRANSACTIONS
} from './constants.js';
import {
  buildLegacyInventoryRows,
  buildLegacyRowSignature,
  buildLotFlagsMap,
  buildReconciliationSnapshot,
  consumeDosesFromItems,
  createTransaction,
  getLatestReceiveSession,
  getMonitoringCaseStatus,
  normalizeIncident,
  normalizeInventoryItem,
  normalizeLotFlag,
  normalizeMonitoringCase,
  normalizeReconciliationSignoff,
  normalizeShipmentComparison,
  sortItemsByReceived
} from './model.js';
import { createId, normalizeLotKey, nowIso } from './utils.js';

let dbPromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

async function openInventoryDb() {
  if (dbPromise) return dbPromise;
  if (!globalThis.indexedDB) {
    throw new Error('IndexedDB is not available in this browser context.');
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(INVENTORY_DB_NAME, INVENTORY_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const store = db.createObjectStore(STORE_ITEMS, { keyPath: 'id' });
        store.createIndex('by_lot_key', 'lot_key', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_TRANSACTIONS)) {
        const store = db.createObjectStore(STORE_TRANSACTIONS, { keyPath: 'id' });
        store.createIndex('by_ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_INCIDENTS)) {
        const store = db.createObjectStore(STORE_INCIDENTS, { keyPath: 'id' });
        store.createIndex('by_ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_RECONCILIATIONS)) {
        const store = db.createObjectStore(STORE_RECONCILIATIONS, { keyPath: 'id' });
        store.createIndex('by_ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_LOT_FLAGS)) {
        db.createObjectStore(STORE_LOT_FLAGS, { keyPath: 'lot_key' });
      }
      if (!db.objectStoreNames.contains(STORE_SHIPMENT_COMPARISONS)) {
        const store = db.createObjectStore(STORE_SHIPMENT_COMPARISONS, { keyPath: 'id' });
        store.createIndex('by_created_at', 'created_at', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_MONITORING_CASES)) {
        const store = db.createObjectStore(STORE_MONITORING_CASES, { keyPath: 'id' });
        store.createIndex('by_created_at', 'created_at', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });

  return dbPromise;
}

async function getAllRecords(storeName) {
  const db = await openInventoryDb();
  const transaction = db.transaction(storeName, 'readonly');
  const store = transaction.objectStore(storeName);
  const records = await requestToPromise(store.getAll());
  await transactionToPromise(transaction);
  return Array.isArray(records) ? records : [];
}

async function writeStores({
  items = null,
  appendTransactions = [],
  appendIncidents = [],
  appendReconSignoffs = [],
  lotFlags = null,
  shipmentComparisons = null,
  monitoringCases = null
} = {}) {
  const storeNames = [];
  if (items !== null) storeNames.push(STORE_ITEMS);
  if (appendTransactions.length) storeNames.push(STORE_TRANSACTIONS);
  if (appendIncidents.length) storeNames.push(STORE_INCIDENTS);
  if (appendReconSignoffs.length) storeNames.push(STORE_RECONCILIATIONS);
  if (lotFlags !== null) storeNames.push(STORE_LOT_FLAGS);
  if (shipmentComparisons !== null) storeNames.push(STORE_SHIPMENT_COMPARISONS);
  if (monitoringCases !== null) storeNames.push(STORE_MONITORING_CASES);
  if (!storeNames.length) return;

  const db = await openInventoryDb();
  const transaction = db.transaction(storeNames, 'readwrite');

  if (items !== null) {
    const store = transaction.objectStore(STORE_ITEMS);
    store.clear();
    items.forEach((item) => {
      store.put(normalizeInventoryItem(item));
    });
  }

  if (appendTransactions.length) {
    const store = transaction.objectStore(STORE_TRANSACTIONS);
    appendTransactions.forEach((entry) => {
      store.put(entry);
    });
  }

  if (appendIncidents.length) {
    const store = transaction.objectStore(STORE_INCIDENTS);
    appendIncidents.forEach((entry) => {
      store.put(entry);
    });
  }

  if (appendReconSignoffs.length) {
    const store = transaction.objectStore(STORE_RECONCILIATIONS);
    appendReconSignoffs.forEach((entry) => {
      store.put(entry);
    });
  }

  if (lotFlags !== null) {
    const store = transaction.objectStore(STORE_LOT_FLAGS);
    store.clear();
    lotFlags.forEach((flag) => {
      store.put(normalizeLotFlag(flag));
    });
  }

  if (shipmentComparisons !== null) {
    const store = transaction.objectStore(STORE_SHIPMENT_COMPARISONS);
    store.clear();
    shipmentComparisons.forEach((comparison) => {
      store.put(normalizeShipmentComparison(comparison));
    });
  }

  if (monitoringCases !== null) {
    const store = transaction.objectStore(STORE_MONITORING_CASES);
    store.clear();
    monitoringCases.forEach((caseRecord) => {
      store.put(normalizeMonitoringCase(caseRecord));
    });
  }

  await transactionToPromise(transaction);
}

function sortByNewestTimestamp(records = [], field = 'ts') {
  return [...records].sort((left, right) => {
    const leftTs = new Date(left?.[field] || 0).getTime();
    const rightTs = new Date(right?.[field] || 0).getTime();
    return rightTs - leftTs;
  });
}

function sortMonitoringCases(cases = []) {
  const statusPriority = {
    overdue: 0,
    due_soon: 1,
    active: 2,
    returned: 3
  };

  return [...cases].sort((left, right) => {
    const leftStatus = getMonitoringCaseStatus(left);
    const rightStatus = getMonitoringCaseStatus(right);
    const priorityDiff = statusPriority[leftStatus] - statusPriority[rightStatus];
    if (priorityDiff !== 0) return priorityDiff;

    const leftDue = new Date(left.expected_return_date || left.created_at || 0).getTime();
    const rightDue = new Date(right.expected_return_date || right.created_at || 0).getTime();
    return leftDue - rightDue;
  });
}

function findReusableReceiveSession(items, receiveSessionLabel) {
  const labelKey = String(receiveSessionLabel || '').trim().toLowerCase();
  if (!labelKey) return null;
  const latestSession = getLatestReceiveSession(
    items.filter(
      (item) => String(item.receive_session_label || '').trim().toLowerCase() === labelKey
    )
  );
  if (!latestSession) return null;
  const ageMs = Date.now() - new Date(latestSession.latest_received_at || 0).getTime();
  return ageMs <= 15 * 60 * 1000 ? latestSession : null;
}

export function createInventoryRepository({
  getLocalStorage,
  setLocalStorage,
  removeLocalStorage
}) {
  async function readState() {
    const [
      items,
      ledger,
      incidents,
      reconSignoffs,
      lotFlags,
      shipmentComparisons,
      monitoringCases
    ] = await Promise.all([
      getAllRecords(STORE_ITEMS),
      getAllRecords(STORE_TRANSACTIONS),
      getAllRecords(STORE_INCIDENTS),
      getAllRecords(STORE_RECONCILIATIONS),
      getAllRecords(STORE_LOT_FLAGS),
      getAllRecords(STORE_SHIPMENT_COMPARISONS),
      getAllRecords(STORE_MONITORING_CASES)
    ]);

    const normalizedItems = sortItemsByReceived(items);
    const normalizedFlags = lotFlags.map((flag) => normalizeLotFlag(flag));

    return {
      items: normalizedItems,
      ledger: sortByNewestTimestamp(ledger),
      incidents: sortByNewestTimestamp(incidents.map((entry) => normalizeIncident(entry))),
      reconSignoffs: sortByNewestTimestamp(
        reconSignoffs.map((entry) => normalizeReconciliationSignoff(entry))
      ),
      lotFlags: normalizedFlags,
      lotFlagsMap: buildLotFlagsMap(normalizedFlags),
      shipmentComparisons: sortByNewestTimestamp(
        shipmentComparisons.map((entry) => normalizeShipmentComparison(entry)),
        'created_at'
      ),
      monitoringCases: sortMonitoringCases(
        monitoringCases.map((entry) => normalizeMonitoringCase(entry))
      )
    };
  }

  async function syncLegacyInventoryRows(legacyRows) {
    const nextItems = sortItemsByReceived(
      (legacyRows || []).map((row) => normalizeInventoryItem({ ...row, source: 'legacy_queue' }))
    );
    await writeStores({ items: nextItems });
    return readState();
  }

  async function mirrorInventoryRows(items) {
    await setLocalStorage({
      [LEGACY_INVENTORY_BATCH_KEY]: buildLegacyInventoryRows(items)
    });
  }

  async function migrateLegacyOperationalData(localState) {
    const ledger = Array.isArray(localState[LEGACY_LEDGER_KEY])
      ? localState[LEGACY_LEDGER_KEY].map((entry) => createTransaction(entry.type || 'event', entry))
      : [];
    const incidents = Array.isArray(localState[LEGACY_INCIDENTS_KEY])
      ? localState[LEGACY_INCIDENTS_KEY].map((entry) => normalizeIncident(entry))
      : [];
    const reconSignoffs = Array.isArray(localState[LEGACY_RECON_KEY])
      ? localState[LEGACY_RECON_KEY].map((entry) => normalizeReconciliationSignoff(entry))
      : [];
    const lotFlagsObject =
      localState[LEGACY_DO_NOT_USE_KEY] && typeof localState[LEGACY_DO_NOT_USE_KEY] === 'object'
        ? localState[LEGACY_DO_NOT_USE_KEY]
        : {};
    const lotFlags = Object.entries(lotFlagsObject).map(([lotKey, data]) =>
      normalizeLotFlag({
        lot_key: lotKey,
        lot: data?.lot || lotKey.toUpperCase(),
        reason: data?.reason || '',
        ts: data?.ts || ''
      })
    );

    if (!ledger.length && !incidents.length && !reconSignoffs.length && !lotFlags.length) {
      return;
    }

    await writeStores({
      appendTransactions: ledger,
      appendIncidents: incidents,
      appendReconSignoffs: reconSignoffs,
      lotFlags
    });

    await removeLocalStorage([
      LEGACY_LEDGER_KEY,
      LEGACY_INCIDENTS_KEY,
      LEGACY_RECON_KEY,
      LEGACY_DO_NOT_USE_KEY
    ]);
  }

  return {
    async loadState() {
      const localState = await getLocalStorage([
        LEGACY_INVENTORY_BATCH_KEY,
        LEGACY_LEDGER_KEY,
        LEGACY_INCIDENTS_KEY,
        LEGACY_RECON_KEY,
        LEGACY_DO_NOT_USE_KEY
      ]);

      await migrateLegacyOperationalData(localState);
      const dbState = await readState();
      const localRows = Array.isArray(localState[LEGACY_INVENTORY_BATCH_KEY])
        ? localState[LEGACY_INVENTORY_BATCH_KEY]
        : [];
      const localSignature = buildLegacyRowSignature(localRows);
      const dbSignature = buildLegacyRowSignature(buildLegacyInventoryRows(dbState.items));

      if (localSignature !== dbSignature) {
        return syncLegacyInventoryRows(localRows);
      }
      return dbState;
    },

    async syncFromLegacyRows(legacyRows) {
      return syncLegacyInventoryRows(Array.isArray(legacyRows) ? legacyRows : []);
    },

    async receiveInventoryRows(legacyRows, options = {}) {
      const current = await readState();
      const receiveSessionLabel = String(options.receiveSessionLabel || '').trim();
      const reusableSession = findReusableReceiveSession(current.items, receiveSessionLabel);
      const receiveSessionId = reusableSession?.id || options.receiveSessionId || createId();
      const sessionLabel = receiveSessionLabel || reusableSession?.label || 'Received stock batch';

      const appendedItems = (legacyRows || []).map((row) =>
        normalizeInventoryItem({
          ...row,
          source: 'inventory_manager',
          receive_session_id: receiveSessionId,
          receive_session_label: sessionLabel
        })
      );
      const nextItems = sortItemsByReceived([...current.items, ...appendedItems]);
      const ledgerEntries = appendedItems.map((item) =>
        createTransaction('receive_stock', {
          lot: item.lot,
          vaccine: item.tradename || item.generic_name || item.name || '',
          qty: item.remaining_doses || item.total_doses || 1,
          note: `batch=${sessionLabel}; expiry=${item.inventory_expiry || 'N/A'}`
        })
      );

      await writeStores({
        items: nextItems,
        appendTransactions: ledgerEntries
      });
      await mirrorInventoryRows(nextItems);
      return readState();
    },

    async createShipmentComparison({ shipmentLabel, expectedEntries, signedBy, note }) {
      const current = await readState();
      if (!Array.isArray(expectedEntries) || !expectedEntries.length) {
        throw new Error('Add at least one expected shipment line before creating comparison.');
      }

      const receiveSession = getLatestReceiveSession(current.items);
      const actualItems = receiveSession
        ? current.items.filter((item) => item.receive_session_id === receiveSession.id)
        : current.items;

      const comparison = normalizeShipmentComparison(
        {
          shipment_label: String(shipmentLabel || '').trim() || receiveSession?.label || 'Shipment comparison',
          receive_session_id: receiveSession?.id || '',
          receive_session_label: receiveSession?.label || '',
          expected_entries: expectedEntries,
          signed_by: String(signedBy || '').trim(),
          signed_at: signedBy ? nowIso() : '',
          note: String(note || '').trim()
        },
        actualItems
      );

      const nextComparisons = [comparison, ...current.shipmentComparisons].slice(0, 200);
      const transactions = [
        createTransaction('shipment_compare_created', {
          qty: comparison.summary.total_rows,
          note: `label=${comparison.shipment_label}; matched=${comparison.summary.matched}; missing=${comparison.summary.missing}; extra=${comparison.summary.extra}`
        })
      ];
      if (comparison.signed_by) {
        transactions.push(
          createTransaction('shipment_compare_signoff', {
            qty: comparison.summary.total_rows,
            note: `label=${comparison.shipment_label}; signed_by=${comparison.signed_by}`
          })
        );
      }

      await writeStores({
        shipmentComparisons: nextComparisons,
        appendTransactions: transactions
      });

      return readState();
    },

    async signShipmentComparison({ comparisonId, signedBy, note }) {
      const current = await readState();
      const targetId = String(comparisonId || '');
      const reviewer = String(signedBy || '').trim();
      if (!targetId || !reviewer) {
        throw new Error('Select a comparison and enter who signed it.');
      }

      const nextComparisons = current.shipmentComparisons.map((comparison) => {
        if (comparison.id !== targetId) {
          return comparison;
        }
        return normalizeShipmentComparison({
          ...comparison,
          signed_by: reviewer,
          signed_at: nowIso(),
          note: String(note || '').trim() || comparison.note || ''
        });
      });

      await writeStores({
        shipmentComparisons: nextComparisons,
        appendTransactions: [
          createTransaction('shipment_compare_signoff', {
            qty: 1,
            note: `comparison_id=${targetId}; signed_by=${reviewer}`
          })
        ]
      });

      return readState();
    },

    async createMonitoringCase({
      providerName,
      storageLocation,
      custodyContact,
      dropoffDate,
      expectedReturnDate,
      intakeBy,
      note,
      items
    }) {
      const current = await readState();
      if (!String(providerName || '').trim()) {
        throw new Error('Enter the provider profile or clinic name for holiday monitoring.');
      }
      if (!Array.isArray(items) || !items.length) {
        throw new Error('Scan at least one lot or barcode for holiday monitoring intake.');
      }

      const monitoringCase = normalizeMonitoringCase({
        provider_name: providerName,
        storage_location: storageLocation,
        custody_contact: custodyContact,
        dropoff_date: dropoffDate,
        expected_return_date: expectedReturnDate,
        intake_by: intakeBy,
        intake_note: note,
        items
      });

      const nextCases = [monitoringCase, ...current.monitoringCases].slice(0, 500);

      await writeStores({
        monitoringCases: nextCases,
        appendTransactions: [
          createTransaction('holiday_monitoring_intake', {
            vaccine: providerName,
            qty: monitoringCase.items.length,
            note: `location=${monitoringCase.storage_location || 'N/A'}; due=${monitoringCase.expected_return_date || 'N/A'}`
          })
        ]
      });

      return readState();
    },

    async returnMonitoringCase({ caseId, returnedBy, returnNote }) {
      const current = await readState();
      const targetId = String(caseId || '');
      const reviewer = String(returnedBy || '').trim();
      if (!targetId || !reviewer) {
        throw new Error('Enter who completed the holiday monitoring return.');
      }

      const nextCases = current.monitoringCases.map((caseRecord) => {
        if (caseRecord.id !== targetId) {
          return caseRecord;
        }
        return normalizeMonitoringCase({
          ...caseRecord,
          returned_at: nowIso(),
          returned_by: reviewer,
          return_note: String(returnNote || '').trim() || caseRecord.return_note || ''
        });
      });

      const targetCase = nextCases.find((caseRecord) => caseRecord.id === targetId);
      await writeStores({
        monitoringCases: nextCases,
        appendTransactions: [
          createTransaction('holiday_monitoring_return', {
            vaccine: targetCase?.provider_name || '',
            qty: targetCase?.items?.length || 0,
            note: `case_id=${targetId}; returned_by=${reviewer}`
          })
        ]
      });

      return readState();
    },

    async recordWastage({ lot, qty, reason, note }) {
      const current = await readState();
      const result = consumeDosesFromItems(current.items, lot, qty);
      const consumedQty = result.consumed || qty;

      await writeStores({
        items: result.items,
        appendTransactions: [
          createTransaction('wastage', {
            lot,
            qty: consumedQty,
            note: `reason=${reason}${note ? `; ${note}` : ''}`
          })
        ]
      });
      await mirrorInventoryRows(result.items);

      return {
        state: await readState(),
        consumed: consumedQty
      };
    },

    async recordIncident(incidentInput) {
      const current = await readState();
      const incident = normalizeIncident(incidentInput);
      const ledgerEntries = [
        createTransaction('cold_chain_incident', {
          lot: incident.lot,
          note: `outcome=${incident.outcome}; min=${incident.minTemp || 'N/A'}; max=${incident.maxTemp || 'N/A'}${incident.note ? `; ${incident.note}` : ''}`
        })
      ];

      let nextItems = current.items;
      let nextFlags = current.lotFlags;

      if (incident.outcome === 'discarded' && incident.lot) {
        const lotQty = current.items
          .filter((item) => item.lot_key === normalizeLotKey(incident.lot))
          .reduce((total, item) => total + (item.remaining_doses || item.total_doses || 1), 0);

        if (lotQty > 0) {
          const result = consumeDosesFromItems(current.items, incident.lot, lotQty);
          nextItems = result.items;
          ledgerEntries.push(
            createTransaction('wastage', {
              lot: incident.lot,
              qty: result.consumed,
              note: 'reason=cold_chain_excursion_discard'
            })
          );
        }
      }

      if (incident.outcome === 'quarantine' && incident.lot) {
        nextFlags = [
          ...current.lotFlags.filter((flag) => flag.lot_key !== incident.lot_key),
          normalizeLotFlag({
            lot: incident.lot,
            reason: 'cold_chain_incident'
          })
        ];
        ledgerEntries.push(
          createTransaction('lot_quarantined', {
            lot: incident.lot,
            note: 'auto from cold chain incident'
          })
        );
      }

      await writeStores({
        items: nextItems !== current.items ? nextItems : null,
        appendTransactions: ledgerEntries,
        appendIncidents: [incident],
        lotFlags: nextFlags !== current.lotFlags ? nextFlags : null
      });

      if (nextItems !== current.items) {
        await mirrorInventoryRows(nextItems);
      }

      return readState();
    },

    async saveReconciliationSignoff(physicalCounts) {
      const current = await readState();
      const snapshot = buildReconciliationSnapshot(current.items, physicalCounts);
      const signoff = normalizeReconciliationSignoff({
        summary: {
          total_groups: snapshot.length,
          matched_groups: snapshot.filter((item) => item.variance === 0).length,
          unresolved_groups: snapshot.filter((item) => item.variance !== 0 && item.variance !== null).length,
          pending_groups: snapshot.filter((item) => item.variance === null).length
        },
        rows: snapshot
      });

      await writeStores({
        appendReconSignoffs: [signoff],
        appendTransactions: [
          createTransaction('reconciliation_signoff', {
            qty: signoff.summary.total_groups,
            note: `matched=${signoff.summary.matched_groups}; unresolved=${signoff.summary.unresolved_groups}; pending=${signoff.summary.pending_groups}`
          })
        ]
      });

      return readState();
    },

    async setDoNotUseLot({ lot, flagged, reason }) {
      const current = await readState();
      const lotKey = normalizeLotKey(lot);
      const nextFlags = flagged
        ? [
            ...current.lotFlags.filter((flag) => flag.lot_key !== lotKey),
            normalizeLotFlag({ lot, reason: reason || 'manual' })
          ]
        : current.lotFlags.filter((flag) => flag.lot_key !== lotKey);

      await writeStores({
        lotFlags: nextFlags,
        appendTransactions: [
          createTransaction(flagged ? 'lot_quarantined' : 'lot_unquarantined', {
            lot,
            note: flagged ? (reason || 'manual') : 'manual clear'
          })
        ]
      });

      return readState();
    },

    async clearInventory() {
      await writeStores({
        items: [],
        appendTransactions: [
          createTransaction('inventory_cleared', {
            note: 'manual clear from inventory manager'
          })
        ]
      });
      await mirrorInventoryRows([]);
      return readState();
    }
  };
}
