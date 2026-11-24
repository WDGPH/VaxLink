(function () {
  const recipient = 'NVC-CNV@phac-aspc.gc.ca';
  const cc = 'innovation@wdgpublichealth.ca';
  const project = 'https://github.com/WDGPH/VaxLink';

  function hasCatalogueMatch(data) {
    return (
      !!data &&
      !data.lookup_error &&
      !data.lookup_error_category &&
      (data.nvc_lot_matched === true || !!formatExpiry(data.nvc_lot_expiry))
    );
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, 120)
      .toWellFormed();
  }

  function formatExpiry(value) {
    const expiry = globalThis.VaxLinkExpiryDate.parseDateToLocal(value);
    return expiry
      ? `${String(expiry.getFullYear()).padStart(4, '0')}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}`
      : '';
  }

  function makeDraft(
    data,
    { panorama = false, training = false, bothFundingCategories = false } = {}
  ) {
    if (
      panorama
        ? !hasCatalogueMatch(data)
        : data?.lookup_error_category !== 'not_found'
    )
      return '';

    const lot = String(data.lot || '').trim();
    if (!/^[\x20-\x7e]{1,20}$/.test(lot)) return '';
    const product = cleanText(data.tradename || data.generic_name);
    const gtin = data.gtin || '';
    const din = data.din || '';
    const manufacturer = panorama && cleanText(data.manufacturer);
    const catalogueExpiry = panorama && formatExpiry(data.nvc_lot_expiry);
    const scannedExpiry = formatExpiry(
      data.barcode_expiry ?? (panorama ? '' : data.expiry)
    );
    const expiryDate =
      panorama &&
      (data.expiry_source === 'nvc' ||
        (data.nvc_lot_matched !== true && scannedExpiry === catalogueExpiry))
        ? ''
        : scannedExpiry;
    const version = data.nvc_catalogue_version || '';
    const fields = [
      product && `Vaccine name: ${product}`,
      manufacturer && `Manufacturer: ${manufacturer}`,
      panorama && /^\d{8}$/.test(din) && `DIN: ${din}`,
      /^\d{8,14}$/.test(gtin) && `GTIN: ${gtin}`,
      `Lot number: ${lot}`,
      expiryDate && `Expiry date on barcode: ${expiryDate}`,
      catalogueExpiry && `Expiry date in catalogue: ${catalogueExpiry}`,
      String(version).length <= 32 &&
        /^\d+(?:\.\d+)*$/.test(version) &&
        `Catalogue version checked: ${version}`
    ].filter(Boolean);
    const site = training ? 'Panorama training' : 'Panorama';
    const subject = panorama
      ? `Vaccine lot not found in ${site} — ${lot}`
      : `Missing vaccine lot in the National Vaccine Catalogue — ${lot}`;
    const request = panorama
      ? `The National Vaccine Catalogue matched this lot. VaxLink could not find a matching option in ${site}` +
        (bothFundingCategories ? ' under either funding category' : '') +
        `. Could you check whether this lot is available in ${site}?`
      : 'VaxLink could not find this vaccine lot in its copy of the National Vaccine Catalogue. Could you check whether the lot should be listed?';
    const body = [
      request,
      '',
      ...fields,
      '',
      `VaxLink project: ${project}`
    ].join('\r\n');
    return `mailto:${panorama ? '' : recipient}?cc=${encodeURIComponent(cc)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  globalThis.VaxLinkNvcLotReport = { hasCatalogueMatch, makeDraft };
})();
