const UPDATE_NOTICE_KEY = 'vaxlink_update_notice_version_v1';

export async function initializeUpdateNotice({ notice, dismissButton, getStored, removeStored }) {
  if (!notice || !dismissButton) return;

  let pendingVersion;
  try {
    const stored = await getStored([UPDATE_NOTICE_KEY]);
    pendingVersion = stored[UPDATE_NOTICE_KEY];
  } catch (_) {
    return;
  }
  if (typeof pendingVersion !== 'string' || !pendingVersion) return;

  notice.hidden = false;
  dismissButton.addEventListener('click', async () => {
    dismissButton.disabled = true;
    try {
      const latest = await getStored([UPDATE_NOTICE_KEY]);
      if (latest[UPDATE_NOTICE_KEY] === pendingVersion) {
        await removeStored(UPDATE_NOTICE_KEY);
      }
      notice.hidden = true;
    } catch (_) {
      dismissButton.disabled = false;
    }
  });
}
