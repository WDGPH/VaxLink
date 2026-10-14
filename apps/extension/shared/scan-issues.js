(function attachScanIssues(root) {
  function lookupIssue(code, lot) {
    const messages = {
      nvc_not_found: `Lot ${lot || '(unknown)'} was read successfully but was not found in NVC. Verify the lot number and vaccine label, then enter the missing details manually in the chart.`,
      nvc_unavailable: 'NVC data is unavailable on this workstation. Refresh NVC Data, then try the lookup again.',
      lookup_failed: 'The NVC lookup could not be completed. Try again; if it continues, reopen VaxLink and refresh NVC Data.',
      missing_lot: 'No lot number was included in this scan, so NVC lot lookup could not run. Scan the full vaccine GS1 DataMatrix barcode or enter the lot manually.'
    };
    return { error: messages[code] || messages.lookup_failed, errorCode: code };
  }

  function malformedBarcodeMessage(error) {
    const detail = error?.message || 'No readable vaccine barcode fields were found.';
    return `Malformed barcode: ${detail}. Scan the full vaccine GS1 DataMatrix barcode again; check the scanner configuration if the scan is incomplete.`;
  }

  root.VaxLinkScanIssues = { lookupIssue, malformedBarcodeMessage };
})(globalThis);
