// A scanner test holds a lease until the test reader has released the port.
export async function canConnect(sender) {
  if (
    sender?.id !== chrome.runtime.id ||
    sender?.tab ||
    sender?.url !== chrome.runtime.getURL('background.js')
  )
    return false;
  try {
    const stored = await chrome.storage.local.get(
      'vaxlink_scanner_test_lease_v1'
    );
    return !stored.vaxlink_scanner_test_lease_v1;
  } catch {
    return false;
  }
}
