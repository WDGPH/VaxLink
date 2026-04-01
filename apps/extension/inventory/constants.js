export const LEGACY_INVENTORY_BATCH_KEY = 'inventory_scan_batch_v1';
export const LEGACY_LEDGER_KEY = 'inventory_txn_ledger_v1';
export const LEGACY_INCIDENTS_KEY = 'inventory_cold_chain_incidents_v1';
export const LEGACY_RECON_KEY = 'inventory_reconciliation_signoffs_v1';
export const LEGACY_DO_NOT_USE_KEY = 'inventory_do_not_use_lots_v1';
export const ULTRA_FAST_SCANNER_KEY = 'inventory_ultrafast_scanner_v1';
export const SCANNER_BEEPS_KEY = 'inventory_scanner_beeps_v1';

export const INVENTORY_DB_NAME = 'vaxlink_inventory_ops_v2';
export const INVENTORY_DB_VERSION = 2;

export const STORE_ITEMS = 'inventory_items';
export const STORE_TRANSACTIONS = 'inventory_transactions';
export const STORE_INCIDENTS = 'inventory_incidents';
export const STORE_RECONCILIATIONS = 'inventory_reconciliation_signoffs';
export const STORE_LOT_FLAGS = 'inventory_lot_flags';
export const STORE_SHIPMENT_COMPARISONS = 'inventory_shipment_comparisons';
export const STORE_MONITORING_CASES = 'inventory_monitoring_cases';

export const INVENTORY_EXPORT_COLUMNS = [
  'scan_index',
  'scanned_at',
  'name',
  'tradename',
  'generic_name',
  'manufacturer',
  'gtin',
  'lot',
  'inventory_expiry',
  'expiry_flag',
  'remaining_doses',
  'total_doses',
  'din',
  'raw_barcode'
];
