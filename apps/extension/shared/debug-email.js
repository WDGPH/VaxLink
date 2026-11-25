export function makeDebugEmail(log, carryIssue) {
  const filename = 'vaxlink-debug-details.json';
  const boundary = '=_vaxlink_debug';
  const bytes = new TextEncoder().encode(log);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  const attachment = btoa(binary).match(/.{1,76}/g) || [];
  return [
    'X-Unsent: 1',
    'To: innovation@wdgpublichealth.ca',
    carryIssue
      ? 'Subject: VaxLink could not carry a dose into Enter Details'
      : 'Subject: VaxLink troubleshooting details',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    carryIssue
      ? 'VaxLink could not carry a dose from the Multiple Immunizations grid into Enter Details.'
      : 'The VaxLink Debug log is attached.',
    '',
    'Describe what happened here.',
    '',
    `--${boundary}`,
    `Content-Type: application/json; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    ...attachment,
    `--${boundary}--`,
    ''
  ].join('\r\n');
}
