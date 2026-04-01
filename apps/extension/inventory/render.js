import {
  buildInventorySummary,
  buildMonitoringSummary,
  getLatestReceiveSession,
  getMonitoringCaseStatus,
  sortItemsByFefo
} from './model.js';
import {
  escapeHtml,
  formatDateTime,
  normalizeLotKey,
  normalizeNonNegativeInt
} from './utils.js';

function renderLedger(host, ledger) {
  if (!host) return;
  if (!ledger.length) {
    host.innerHTML = '<div class="empty">No transactions yet.</div>';
    return;
  }

  const markup = ledger.slice(0, 120).map((entry) => `
    <tr>
      <td>${escapeHtml(formatDateTime(entry.ts))}</td>
      <td>${escapeHtml(entry.type || 'event')}</td>
      <td>${escapeHtml(entry.lot || 'N/A')}</td>
      <td>${escapeHtml(entry.vaccine || 'N/A')}</td>
      <td>${escapeHtml(entry.qty ?? '')}</td>
      <td>${escapeHtml(entry.note || '')}</td>
    </tr>
  `).join('');

  host.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th>Lot</th>
          <th>Vaccine</th>
          <th>Qty</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>${markup}</tbody>
    </table>
  `;
}

function renderFefo(host, items, lotFlagsMap) {
  if (!host) return;
  if (!items.length) {
    host.innerHTML = '<div class="empty">No inventory for FEFO prioritization yet.</div>';
    return;
  }

  const rows = sortItemsByFefo(items)
    .slice(0, 8)
    .map((item) => {
      const flagged = !!lotFlagsMap[normalizeLotKey(item.lot)];
      return `
        <tr>
          <td>${escapeHtml(item.tradename || item.generic_name || item.name || 'N/A')}</td>
          <td>${escapeHtml(item.lot || 'N/A')}</td>
          <td>${escapeHtml(item.inventory_expiry || item.barcode_expiry || 'N/A')}</td>
          <td>${escapeHtml(
            normalizeNonNegativeInt(item.remaining_doses, item.total_doses ?? 'N/A')
          )}</td>
          <td>${flagged ? '<span class="chip">Do Not Use</span>' : '<span class="chip">Use First</span>'}</td>
        </tr>
      `;
    })
    .join('');

  host.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Vaccine</th>
          <th>Lot</th>
          <th>Expiry</th>
          <th>Doses</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderDoNotUseLots(host, lotFlagsMap) {
  if (!host) return;
  const entries = Object.entries(lotFlagsMap || {});
  if (!entries.length) {
    host.textContent = 'No lots currently quarantined.';
    return;
  }

  host.textContent = `Quarantined lots: ${entries
    .map(([lotKey, data]) => `${lotKey.toUpperCase()} (${data.reason || 'no reason'})`)
    .join(' | ')}`;
}

function renderReconciliation(host, items, physicalCounts, onPhysicalCountChange) {
  if (!host) return;
  if (!items.length) {
    host.innerHTML = '<div class="empty">No records available for reconciliation yet.</div>';
    return;
  }

  const groups = [];
  const byKey = new Map();
  items.forEach((item) => {
    const vaccine = item.tradename || item.generic_name || item.name || 'Unknown';
    const lot = item.lot || 'N/A';
    const key = `${vaccine}||${lot}`;
    if (!byKey.has(key)) {
      byKey.set(key, { vaccine, lot, rows: 0, expected: 0 });
      groups.push(byKey.get(key));
    }
    const group = byKey.get(key);
    group.rows += 1;
    group.expected += normalizeNonNegativeInt(item.remaining_doses, item.total_doses ?? 1);
  });

  const markup = groups.map((group) => {
    const physical = Number.parseInt(String(physicalCounts.get(`${group.vaccine}||${group.lot}`) ?? ''), 10);
    const variance = Number.isFinite(physical) ? physical - group.expected : null;
    const varianceClass = variance === null
      ? ''
      : variance === 0
        ? 'variance-ok'
        : Math.abs(variance) <= 2
          ? 'variance-warn'
          : 'variance-bad';
    const varianceLabel =
      variance === null ? 'Pending count' : (variance > 0 ? `+${variance}` : String(variance));

    return `
      <tr>
        <td>${escapeHtml(group.vaccine)}</td>
        <td>${escapeHtml(group.lot)}</td>
        <td>${escapeHtml(group.rows)}</td>
        <td>${escapeHtml(group.expected)}</td>
        <td><input type="number" min="0" data-recon-key="${encodeURIComponent(`${group.vaccine}||${group.lot}`)}" value="${Number.isFinite(physical) ? physical : ''}" placeholder="0"></td>
        <td class="${varianceClass}">${escapeHtml(varianceLabel)}</td>
      </tr>
    `;
  }).join('');

  host.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Vaccine</th>
          <th>Lot</th>
          <th>Entries</th>
          <th>Expected Doses</th>
          <th>Physical Count</th>
          <th>Variance</th>
        </tr>
      </thead>
      <tbody>${markup}</tbody>
    </table>
  `;

  host.querySelectorAll('[data-recon-key]').forEach((input) => {
    input.addEventListener('input', () => {
      const encodedKey = input.getAttribute('data-recon-key') || '';
      const key = decodeURIComponent(encodedKey);
      const value = String(input.value || '').trim();
      onPhysicalCountChange(key, value);
    });
  });
}

function renderShipmentComparisonTarget(host, items) {
  if (!host) return;
  const latestSession = getLatestReceiveSession(items);
  if (!latestSession) {
    host.textContent = 'Comparison target: no dedicated receive batch found yet. The comparison will fall back to current local inventory.';
    return;
  }
  host.textContent = `Comparison target: latest receive batch "${latestSession.label}" with ${latestSession.item_count} item(s) and ${latestSession.total_doses} dose(s).`;
}

function renderShipmentComparison(host, comparison, totalCount) {
  if (!host) return;
  if (!comparison) {
    host.innerHTML = '<div class="empty">No shipment comparison yet. Paste expected shipment lines, then create a comparison against the latest receive batch.</div>';
    return;
  }

  const summary = comparison.summary || {};
  const summaryText = [
    `${summary.total_rows || 0} row(s) reviewed`,
    `${summary.matched || 0} matched`,
    `${summary.missing || 0} missing`,
    `${summary.extra || 0} extra`,
    `${summary.qty_mismatch || 0} qty mismatch`,
    `${summary.lot_mismatch || 0} lot mismatch`,
    `${summary.expiry_mismatch || 0} expiry mismatch`
  ].join(' | ');

  const rows = (comparison.comparison_rows || []).map((row) => {
    const flagMarkup = (row.flags || []).length
      ? row.flags.map((flag) => `<span class="chip">${escapeHtml(flag.replace(/_/g, ' '))}</span>`).join(' ')
      : '<span class="chip">match</span>';
    return `
      <tr>
        <td>${escapeHtml(row.vaccine || 'N/A')}</td>
        <td>${escapeHtml(row.expected_lot || 'N/A')}</td>
        <td>${escapeHtml(row.received_lot || 'N/A')}</td>
        <td>${escapeHtml(row.expected_qty ?? '')}</td>
        <td>${escapeHtml(row.received_qty ?? '')}</td>
        <td>${escapeHtml(row.expected_expiry || 'N/A')}</td>
        <td>${escapeHtml(row.received_expiry || 'N/A')}</td>
        <td>${flagMarkup}</td>
      </tr>
    `;
  }).join('');

  host.innerHTML = `
    <div class="comparison-summary">
      <strong>${escapeHtml(comparison.shipment_label || 'Shipment comparison')}</strong>
      <div class="micro-note">${escapeHtml(summaryText)}</div>
      <div class="micro-note">Compared against: ${escapeHtml(comparison.receive_session_label || 'current local inventory')} | Saved comparisons: ${escapeHtml(totalCount)}</div>
      <div class="micro-note">Sign-off: ${escapeHtml(comparison.signed_by || 'pending')} ${comparison.signed_at ? `(${escapeHtml(formatDateTime(comparison.signed_at))})` : ''}</div>
      ${comparison.note ? `<div class="micro-note">Note: ${escapeHtml(comparison.note)}</div>` : ''}
    </div>
    <table>
      <thead>
        <tr>
          <th>Vaccine</th>
          <th>Expected Lot</th>
          <th>Received Lot</th>
          <th>Expected Qty</th>
          <th>Received Qty</th>
          <th>Expected Expiry</th>
          <th>Received Expiry</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMonitoring(hostSummary, hostTable, monitoringCases, onReturnMonitoringCase) {
  if (hostSummary) {
    const summary = buildMonitoringSummary(monitoringCases);
    hostSummary.textContent = `${summary.total_cases} monitoring case(s). ${summary.active} active, ${summary.due_soon} due soon, ${summary.overdue} overdue, ${summary.returned} returned.`;
  }

  if (!hostTable) return;
  if (!monitoringCases.length) {
    hostTable.innerHTML = '<div class="empty">No holiday monitoring cases yet.</div>';
    return;
  }

  const rows = monitoringCases.map((caseRecord) => {
    const status = getMonitoringCaseStatus(caseRecord);
    const lots = (caseRecord.items || []).map((item) => item.lot || 'N/A').join(' | ');
    const action = status === 'returned'
      ? '<span class="chip">Returned</span>'
      : `<button class="monitoring-action" type="button" data-return-case-id="${escapeHtml(caseRecord.id)}">Mark Returned</button>`;
    return `
      <tr>
        <td>${escapeHtml(caseRecord.provider_name || 'N/A')}</td>
        <td><span class="chip">${escapeHtml(status.replace(/_/g, ' '))}</span></td>
        <td>${escapeHtml(caseRecord.dropoff_date || 'N/A')}</td>
        <td>${escapeHtml(caseRecord.expected_return_date || 'N/A')}</td>
        <td>${escapeHtml(caseRecord.returned_at ? formatDateTime(caseRecord.returned_at) : 'Pending')}</td>
        <td>${escapeHtml(caseRecord.storage_location || 'N/A')}</td>
        <td>${escapeHtml(caseRecord.custody_contact || 'N/A')}</td>
        <td>${escapeHtml((caseRecord.items || []).length)}</td>
        <td>${escapeHtml(lots || 'N/A')}</td>
        <td>${action}</td>
      </tr>
    `;
  }).join('');

  hostTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Provider</th>
          <th>Status</th>
          <th>Drop-off</th>
          <th>Expected Return</th>
          <th>Returned</th>
          <th>Storage</th>
          <th>Custody</th>
          <th>Items</th>
          <th>Lots</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  hostTable.querySelectorAll('[data-return-case-id]').forEach((button) => {
    button.addEventListener('click', () => {
      onReturnMonitoringCase(button.getAttribute('data-return-case-id'));
    });
  });
}

function renderTable(host, items, lotFlagsMap) {
  if (!host) return;
  if (!items.length) {
    host.innerHTML = '<div class="empty">No inventory records found. Add scans from the extension popup in Inventory mode.</div>';
    return;
  }

  const markup = items.map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(item.tradename || item.generic_name || item.name || 'N/A')}</td>
      <td>${escapeHtml(item.lot || 'N/A')}</td>
      <td>${escapeHtml(item.inventory_expiry || item.barcode_expiry || 'N/A')}</td>
      <td>
        <span class="chip">${escapeHtml(item.expiry_flag || 'unknown')}</span>
        ${lotFlagsMap[normalizeLotKey(item.lot)] ? '<span class="chip">Do Not Use</span>' : ''}
      </td>
      <td>${escapeHtml(item.manufacturer || 'N/A')}</td>
      <td>${escapeHtml(item.remaining_doses ?? item.total_doses ?? 'N/A')}</td>
      <td>${escapeHtml(formatDateTime(item.scanned_at))}</td>
    </tr>
  `).join('');

  host.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Vaccine</th>
          <th>Lot</th>
          <th>Expiry</th>
          <th>Status</th>
          <th>Manufacturer</th>
          <th>Doses</th>
          <th>Scanned At</th>
        </tr>
      </thead>
      <tbody>${markup}</tbody>
    </table>
  `;
}

export function createInventoryRenderer(elements) {
  return {
    renderStatus(message, type = 'info') {
      elements.statusEl.textContent = message;
      elements.statusEl.style.color = type === 'error' ? '#97272c' : '#5f7488';
    },
    updateScanIndicator(ultraFastScannerEnabled) {
      if (!elements.scanLiveIndicatorEl) return;
      elements.scanLiveIndicatorEl.textContent = ultraFastScannerEnabled
        ? 'Ultra-fast mode ON: scanner Enter key receives instantly.'
        : 'Ultra-fast mode OFF: collect lines, then click Receive.';
    },
    render(state, options) {
      const { physicalCounts, onPhysicalCountChange, onReturnMonitoringCase } = options;
      elements.summaryEl.textContent = buildInventorySummary(state.items, state.lotFlagsMap);
      renderReconciliation(
        elements.reconHostEl,
        state.items,
        physicalCounts,
        onPhysicalCountChange
      );
      renderLedger(elements.ledgerHostEl, state.ledger);
      renderFefo(elements.fefoHostEl, state.items, state.lotFlagsMap);
      renderDoNotUseLots(elements.doNotUseHostEl, state.lotFlagsMap);
      renderShipmentComparisonTarget(elements.shipmentCompareTargetEl, state.items);
      renderShipmentComparison(
        elements.shipmentCompareHostEl,
        state.shipmentComparisons[0] || null,
        state.shipmentComparisons.length
      );
      renderMonitoring(
        elements.monitoringSummaryEl,
        elements.monitoringHostEl,
        state.monitoringCases,
        onReturnMonitoringCase
      );
      renderTable(elements.tableHostEl, state.items, state.lotFlagsMap);

      const hasItems = state.items.length > 0;
      const hasComparison = state.shipmentComparisons.length > 0;
      const hasMonitoringCases = state.monitoringCases.length > 0;
      elements.exportBtn.disabled = !hasItems;
      elements.clearBtn.disabled = !hasItems;
      if (elements.saveShipmentCompareSignoffBtn) {
        elements.saveShipmentCompareSignoffBtn.disabled = !hasComparison;
      }
      if (elements.exportShipmentCompareBtn) {
        elements.exportShipmentCompareBtn.disabled = !hasComparison;
      }
      if (elements.exportMonitoringBtn) {
        elements.exportMonitoringBtn.disabled = !hasMonitoringCases;
      }
    }
  };
}
