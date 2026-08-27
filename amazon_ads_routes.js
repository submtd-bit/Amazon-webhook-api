import { registerAmazonAdsDecisionRoutes as registerLegacyAmazonAdsDecisionRoutes } from './amazon_ads_routes_legacy.js';

const INACTIVE_AUDIT_VERSION = 'AMAZON_INACTIVE_AUDIT_V1.0.0';
const NONBUYABLE_DEEP_AUDIT_VERSION = 'AMAZON_NONBUYABLE_NO_REASON_DEEP_AUDIT_V1.0.0';
const IMAGE_SUPPRESSION_AUDIT_VERSION = 'AMAZON_IMAGE_SUPPRESSION_AUDIT_V1.0.0';
const BENCHMARK_ASIN = 'B0GHY9J1NF';
const BENCHMARK_SKU = 'x13g1-i5-10210u-8gb-ssd1';
const KNOWN_ENFORCEMENTS = [
  'LISTING_SUPPRESSED',
  'ATTRIBUTE_SUPPRESSED',
  'CATALOG_ITEM_REMOVED',
  'SEARCH_SUPPRESSED'
];

function registerAmazonAdsDecisionRoutes(app, deps) {
  registerLegacyAmazonAdsDecisionRoutes(app, deps);

  const { spApiRequest, sellerId, marketplaceId, apiSecret } = deps;
  if (!app || !spApiRequest || !sellerId || !marketplaceId || !apiSecret) {
    throw new Error('Inactive audit route requires app, spApiRequest, sellerId, marketplaceId and apiSecret.');
  }

  const requireSecret = (req, res, next) => {
    if (req.get('X-API-SECRET') !== apiSecret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };

  app.post('/ads/listings/inactive-audit', requireSecret, async (req, res) => {
    try {
      const maxPagesRequested = Number(req.body?.maxPages || 250);
      const maxPages = Number.isFinite(maxPagesRequested)
        ? Math.max(1, Math.min(500, Math.floor(maxPagesRequested)))
        : 250;

      const all = [];
      const seenSkus = new Set();
      let pageToken = '';
      let pageCount = 0;

      do {
        pageCount += 1;
        if (pageCount > maxPages) {
          throw new Error(`INACTIVE_AUDIT_PAGE_LIMIT_EXCEEDED: maxPages=${maxPages}`);
        }

        const query = {
          marketplaceIds: marketplaceId,
          issueLocale: 'ja_JP',
          includedData: 'summaries,issues,fulfillmentAvailability',
          withoutStatus: 'BUYABLE',
          sortBy: 'sku',
          sortOrder: 'ASC',
          pageSize: 20
        };
        if (pageToken) query.pageToken = pageToken;

        const data = await spApiRequest({
          method: 'GET',
          path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
          query
        });

        const pageItems = Array.isArray(data?.items) ? data.items : [];
        for (const raw of pageItems) {
          const item = normalizeInactiveAuditItem(raw, marketplaceId);
          if (!item.sku || seenSkus.has(item.sku)) continue;
          seenSkus.add(item.sku);
          all.push(item);
        }

        pageToken = String(
          data?.pagination?.nextToken ||
          data?.pagination?.NextToken ||
          data?.nextToken ||
          data?.NextToken ||
          ''
        ).trim();

        if (pageToken) await waitAuditMs(250);
      } while (pageToken);

      let benchmark = null;
      try {
        const rawBenchmark = await spApiRequest({
          method: 'GET',
          path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(BENCHMARK_SKU)}`,
          query: {
            marketplaceIds: marketplaceId,
            issueLocale: 'ja_JP',
            includedData: 'summaries,issues,fulfillmentAvailability'
          }
        });
        benchmark = normalizeInactiveAuditItem({ ...rawBenchmark, sku: rawBenchmark?.sku || BENCHMARK_SKU }, marketplaceId);
        benchmark.needsVisualCheck = true;
        benchmark.visualCheckReason = 'BENCHMARK_B0GHY9J1NF';
      } catch (error) {
        benchmark = {
          sku: BENCHMARK_SKU,
          asin: BENCHMARK_ASIN,
          status: 'API_ERROR',
          buyable: false,
          discoverable: false,
          needsVisualCheck: true,
          visualCheckReason: 'BENCHMARK_API_ERROR',
          apiError: error.message || String(error)
        };
      }

      for (const item of all) {
        if (item.sku === BENCHMARK_SKU || item.asin === BENCHMARK_ASIN) {
          item.needsVisualCheck = true;
          item.visualCheckReason = 'BENCHMARK_B0GHY9J1NF';
        }
      }

      all.sort((a, b) => {
        const aBenchmark = a.sku === BENCHMARK_SKU || a.asin === BENCHMARK_ASIN ? 1 : 0;
        const bBenchmark = b.sku === BENCHMARK_SKU || b.asin === BENCHMARK_ASIN ? 1 : 0;
        if (aBenchmark !== bBenchmark) return bBenchmark - aBenchmark;
        if (a.needsVisualCheck !== b.needsVisualCheck) return a.needsVisualCheck ? -1 : 1;
        return String(a.sku).localeCompare(String(b.sku));
      });

      const visualCheckItems = all.filter(x => x.needsVisualCheck);
      const clearApiReasonItems = all.filter(x => !x.needsVisualCheck);
      const reasonMissingItems = all.filter(x => x.reasonClass === 'NON_BUYABLE_NO_API_REASON' || x.reasonClass === 'WARNING_ONLY_NONBUYABLE');

      res.json({
        version: INACTIVE_AUDIT_VERSION,
        readOnly: true,
        externalChanges: 0,
        marketplaceId,
        scope: 'WITHOUT_STATUS_BUYABLE',
        pageCount,
        inactiveCandidateCount: all.length,
        clearApiReasonCount: clearApiReasonItems.length,
        reasonMissingOrNonBlockingCount: reasonMissingItems.length,
        visualCheckCount: visualCheckItems.length,
        benchmarkFoundInInactiveCandidates: all.some(x => x.sku === BENCHMARK_SKU || x.asin === BENCHMARK_ASIN),
        benchmark,
        items: all
      });
    } catch (error) {
      res.status(500).json({
        version: INACTIVE_AUDIT_VERSION,
        readOnly: true,
        externalChanges: 0,
        error: error.message || String(error)
      });
    }
  });

  app.post('/ads/listings/nonbuyable-no-reason-audit', requireSecret, async (req, res) => {
    try {
      const maxPagesRequested = Number(req.body?.maxPages || 250);
      const maxPages = Number.isFinite(maxPagesRequested)
        ? Math.max(1, Math.min(500, Math.floor(maxPagesRequested)))
        : 250;

      const all = [];
      const seenSkus = new Set();
      let pageToken = '';
      let pageCount = 0;

      do {
        pageCount += 1;
        if (pageCount > maxPages) {
          throw new Error(`NONBUYABLE_DEEP_AUDIT_PAGE_LIMIT_EXCEEDED: maxPages=${maxPages}`);
        }

        const query = {
          marketplaceIds: marketplaceId,
          issueLocale: 'ja_JP',
          includedData: 'summaries,issues,fulfillmentAvailability',
          withoutStatus: 'BUYABLE',
          sortBy: 'sku',
          sortOrder: 'ASC',
          pageSize: 20
        };
        if (pageToken) query.pageToken = pageToken;

        const data = await spApiRequest({
          method: 'GET',
          path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
          query
        });

        const pageItems = Array.isArray(data?.items) ? data.items : [];
        for (const raw of pageItems) {
          const item = normalizeInactiveAuditItem(raw, marketplaceId);
          if (!item.sku || seenSkus.has(item.sku)) continue;
          seenSkus.add(item.sku);
          all.push(item);
        }

        pageToken = String(
          data?.pagination?.nextToken ||
          data?.pagination?.NextToken ||
          data?.nextToken ||
          data?.NextToken ||
          ''
        ).trim();
        if (pageToken) await waitAuditMs(250);
      } while (pageToken);

      const targets = all.filter(x => x.reasonClass === 'NON_BUYABLE_NO_API_REASON');
      const results = [];

      for (const target of targets) {
        try {
          const raw = await spApiRequest({
            method: 'GET',
            path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(target.sku)}`,
            query: {
              marketplaceIds: marketplaceId,
              issueLocale: 'ja_JP',
              includedData: 'summaries,attributes,issues,offers,fulfillmentAvailability'
            }
          });

          results.push(buildDeepNonBuyableDiagnostics(target, raw, marketplaceId));
        } catch (error) {
          results.push({
            sku: target.sku,
            asin: target.asin,
            title: target.title,
            initialReasonClass: target.reasonClass,
            initialStatus: splitStatuses(target.status),
            initialAvailableQuantity: target.availableQuantity,
            deepFetchOk: false,
            deepFetchError: error.message || String(error),
            rootCauseConfirmed: false,
            primaryDiagnostic: 'DEEP_GET_API_ERROR',
            diagnosticSignals: ['DEEP_GET_API_ERROR']
          });
        }
        if (targets.length > 1) await waitAuditMs(250);
      }

      const diagnosticCounts = {};
      for (const row of results) {
        const key = String(row.primaryDiagnostic || 'UNKNOWN');
        diagnosticCounts[key] = Number(diagnosticCounts[key] || 0) + 1;
      }

      res.json({
        version: NONBUYABLE_DEEP_AUDIT_VERSION,
        readOnly: true,
        externalChanges: 0,
        marketplaceId,
        scope: 'CURRENT_NON_BUYABLE_NO_API_REASON_ONLY',
        pageCount,
        inactiveCandidateCount: all.length,
        targetCount: targets.length,
        targetSkus: targets.map(x => x.sku),
        deepFetchOkCount: results.filter(x => x.deepFetchOk).length,
        deepFetchErrorCount: results.filter(x => !x.deepFetchOk).length,
        rootCauseConfirmedCount: results.filter(x => x.rootCauseConfirmed).length,
        diagnosticCounts,
        results
      });
    } catch (error) {
      res.status(500).json({
        version: NONBUYABLE_DEEP_AUDIT_VERSION,
        readOnly: true,
        externalChanges: 0,
        error: error.message || String(error)
      });
    }
  });

  app.post('/ads/listings/image-suppression-audit', requireSecret, async (req, res) => {
    try {
      const skus = uniqueStrings(Array.isArray(req.body?.skus) ? req.body.skus : []);
      if (!skus.length) {
        return res.status(400).json({
          version: IMAGE_SUPPRESSION_AUDIT_VERSION,
          readOnly: true,
          externalChanges: 0,
          error: 'skus is required'
        });
      }
      if (skus.length > 50) {
        return res.status(400).json({
          version: IMAGE_SUPPRESSION_AUDIT_VERSION,
          readOnly: true,
          externalChanges: 0,
          error: 'max 50 skus per request'
        });
      }

      const results = [];
      for (const sku of skus) {
        try {
          const raw = await spApiRequest({
            method: 'GET',
            path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
            query: {
              marketplaceIds: marketplaceId,
              issueLocale: 'ja_JP',
              includedData: 'summaries,attributes,issues'
            }
          });

          const summaries = Array.isArray(raw?.summaries) ? raw.summaries : [];
          const summary = summaries.find(x => !x?.marketplaceId || x.marketplaceId === marketplaceId) || summaries[0] || {};
          const issues = Array.isArray(raw?.issues) ? raw.issues : [];
          const imageIssues = issues.filter(issue => {
            const code = String(issue?.code || '').trim();
            const message = String(issue?.message || '');
            const attributes = Array.isArray(issue?.attributeNames) ? issue.attributeNames : [];
            return code === '100238' ||
              code === '18320' ||
              /画像|image/i.test(message) ||
              attributes.some(name => /image|media|locator/i.test(String(name || '')));
          });

          results.push({
            sku,
            asin: String(summary.asin || '').trim(),
            title: String(summary.itemName || '').trim(),
            status: Array.isArray(summary.status) ? summary.status : [],
            imageIssueCount: imageIssues.length,
            imageIssues: imageIssues.map(issue => ({
              code: String(issue?.code || ''),
              severity: String(issue?.severity || ''),
              message: String(issue?.message || ''),
              attributeNames: Array.isArray(issue?.attributeNames) ? issue.attributeNames : [],
              enforcementActions: collectKnownEnforcements([issue])
            })),
            mediaAttributes: extractMediaAttributes(raw?.attributes || {}),
            apiError: ''
          });
        } catch (error) {
          results.push({
            sku,
            asin: '',
            title: '',
            status: [],
            imageIssueCount: 0,
            imageIssues: [],
            mediaAttributes: {},
            apiError: error.message || String(error)
          });
        }

        if (skus.length > 1) await waitAuditMs(250);
      }

      res.json({
        version: IMAGE_SUPPRESSION_AUDIT_VERSION,
        readOnly: true,
        externalChanges: 0,
        marketplaceId,
        requestedSkuCount: skus.length,
        apiErrorCount: results.filter(x => x.apiError).length,
        imageIssueSkuCount: results.filter(x => x.imageIssueCount > 0).length,
        results
      });
    } catch (error) {
      res.status(500).json({
        version: IMAGE_SUPPRESSION_AUDIT_VERSION,
        readOnly: true,
        externalChanges: 0,
        error: error.message || String(error)
      });
    }
  });
}

function normalizeInactiveAuditItem(raw, marketplaceId) {
  const summaries = Array.isArray(raw?.summaries) ? raw.summaries : [];
  const summary = summaries.find(x => !x?.marketplaceId || x.marketplaceId === marketplaceId) || summaries[0] || {};
  const issues = Array.isArray(raw?.issues) ? raw.issues : [];
  const availability = Array.isArray(raw?.fulfillmentAvailability) ? raw.fulfillmentAvailability : [];
  const statuses = Array.isArray(summary.status)
    ? summary.status.map(x => String(x || '').trim()).filter(Boolean)
    : String(summary.status || '').split(',').map(x => x.trim()).filter(Boolean);

  const buyable = statuses.includes('BUYABLE');
  const discoverable = statuses.includes('DISCOVERABLE');
  const deleted = statuses.includes('DELETED');
  const quantities = availability.map(x => Number(x?.quantity || 0)).filter(Number.isFinite);
  const availableQuantity = quantities.reduce((sum, value) => sum + Math.max(0, value), 0);
  const errorIssues = issues.filter(x => String(x?.severity || '').toUpperCase() === 'ERROR');
  const warningIssues = issues.filter(x => String(x?.severity || '').toUpperCase() === 'WARNING');
  const enforcementActions = collectKnownEnforcements(issues);
  const issueCodes = uniqueStrings(issues.map(x => x?.code));
  const issueMessages = uniqueStrings(issues.map(x => x?.message));
  const issueAttributes = uniqueStrings(issues.flatMap(x => Array.isArray(x?.attributeNames) ? x.attributeNames : []));

  let reasonClass = '';
  if (deleted) reasonClass = 'DELETED';
  else if (enforcementActions.length) reasonClass = 'ENFORCEMENT';
  else if (errorIssues.length) reasonClass = 'LISTING_ERROR';
  else if (availableQuantity <= 0) reasonClass = 'ZERO_STOCK_ONLY';
  else if (warningIssues.length) reasonClass = 'WARNING_ONLY_NONBUYABLE';
  else reasonClass = 'NON_BUYABLE_NO_API_REASON';

  const hasClearBlockingSignal =
    deleted ||
    enforcementActions.length > 0 ||
    errorIssues.length > 0 ||
    availableQuantity <= 0;

  let reason = '';
  if (deleted) reason = 'API status includes DELETED';
  else if (enforcementActions.length) reason = `Enforcement: ${enforcementActions.join(', ')}`;
  else if (errorIssues.length) reason = issueMessages.join(' / ') || `ERROR issue count=${errorIssues.length}`;
  else if (availableQuantity <= 0) reason = 'fulfillmentAvailability quantity=0';
  else if (warningIssues.length) reason = issueMessages.join(' / ') || `WARNING issue count=${warningIssues.length}`;
  else reason = 'BUYABLE absent, but Listings Items API returned no blocking issue/enforcement and quantity is positive';

  return {
    sku: String(raw?.sku || '').trim(),
    asin: String(summary.asin || '').trim(),
    title: String(summary.itemName || '').trim(),
    productType: String(summary.productType || '').trim(),
    status: statuses.join(','),
    buyable,
    discoverable,
    deleted,
    availableQuantity,
    fulfillmentChannels: uniqueStrings(availability.map(x => x?.fulfillmentChannelCode)),
    issueCount: issues.length,
    errorCount: errorIssues.length,
    warningCount: warningIssues.length,
    enforcementActions,
    issueCodes,
    issueAttributes,
    issueMessages,
    reasonClass,
    reason,
    needsVisualCheck: !hasClearBlockingSignal,
    visualCheckReason: hasClearBlockingSignal ? '' : 'API_REASON_MISSING_OR_NON_BLOCKING',
    createdDate: String(summary.createdDate || ''),
    lastUpdatedDate: String(summary.lastUpdatedDate || ''),
    issues: issues.map(x => ({
      code: x?.code || '',
      message: x?.message || '',
      severity: x?.severity || '',
      attributeNames: Array.isArray(x?.attributeNames) ? x.attributeNames : [],
      categories: Array.isArray(x?.categories) ? x.categories : []
    }))
  };
}

function buildDeepNonBuyableDiagnostics(initial, raw, marketplaceId) {
  const summaries = Array.isArray(raw?.summaries) ? raw.summaries : [];
  const summary = summaries.find(x => !x?.marketplaceId || x.marketplaceId === marketplaceId) || summaries[0] || {};
  const statuses = Array.isArray(summary.status)
    ? summary.status.map(x => String(x || '').trim()).filter(Boolean)
    : String(summary.status || '').split(',').map(x => x.trim()).filter(Boolean);
  const attributes = raw?.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes) ? raw.attributes : {};
  const issues = Array.isArray(raw?.issues) ? raw.issues : [];
  const offers = Array.isArray(raw?.offers) ? raw.offers : [];
  const availability = Array.isArray(raw?.fulfillmentAvailability) ? raw.fulfillmentAvailability : [];
  const errorIssues = issues.filter(x => String(x?.severity || '').toUpperCase() === 'ERROR');
  const warningIssues = issues.filter(x => String(x?.severity || '').toUpperCase() === 'WARNING');
  const enforcementActions = collectKnownEnforcements(issues);
  const quantities = availability.map(x => Number(x?.quantity || 0)).filter(Number.isFinite);
  const availableQuantity = quantities.reduce((sum, value) => sum + Math.max(0, value), 0);
  const b2cOffer = offers.find(x => String(x?.offerType || '').toUpperCase() === 'B2C') || null;
  const b2bOffer = offers.find(x => String(x?.offerType || '').toUpperCase() === 'B2B') || null;
  const b2cPrice = finiteNumberOrNull(b2cOffer?.price?.amount);
  const b2bPrice = finiteNumberOrNull(b2bOffer?.price?.amount);
  const conditionType = String(attributes?.condition_type?.[0]?.value || '').trim();
  const skipOfferValue = attributes?.skip_offer?.[0]?.value;
  const skipOfferTrue = skipOfferValue === true || String(skipOfferValue || '').toLowerCase() === 'true';
  const purchasableOfferRows = Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [];
  const fulfillmentAttributeRows = Array.isArray(attributes?.fulfillment_availability) ? attributes.fulfillment_availability : [];
  const merchantShippingGroup = attributes?.merchant_shipping_group || [];
  const listPrice = attributes?.list_price || [];
  const mainImage = attributes?.main_product_image_locator || [];

  const diagnosticSignals = [];
  let primaryDiagnostic = 'NO_BLOCKING_SIGNAL_AFTER_DEEP_GET';
  let rootCauseConfirmed = false;

  if (statuses.includes('BUYABLE')) {
    primaryDiagnostic = 'RECOVERED_DURING_DEEP_GET';
    rootCauseConfirmed = true;
    diagnosticSignals.push('RECOVERED_DURING_DEEP_GET');
  } else if (enforcementActions.length) {
    primaryDiagnostic = 'DEEP_ENFORCEMENT_FOUND';
    rootCauseConfirmed = true;
    diagnosticSignals.push('DEEP_ENFORCEMENT_FOUND');
  } else if (errorIssues.length) {
    primaryDiagnostic = 'DEEP_ERROR_FOUND';
    rootCauseConfirmed = true;
    diagnosticSignals.push('DEEP_ERROR_FOUND');
  } else if (availableQuantity <= 0) {
    primaryDiagnostic = 'DEEP_ZERO_STOCK_FOUND';
    rootCauseConfirmed = true;
    diagnosticSignals.push('DEEP_ZERO_STOCK_FOUND');
  }

  if (!b2cOffer) diagnosticSignals.push('B2C_OFFER_MISSING');
  else if (!(Number.isFinite(b2cPrice) && b2cPrice > 0)) diagnosticSignals.push('B2C_PRICE_MISSING_OR_INVALID');
  if (!purchasableOfferRows.length) diagnosticSignals.push('PURCHASABLE_OFFER_ATTRIBUTE_MISSING');
  if (skipOfferTrue) diagnosticSignals.push('SKIP_OFFER_TRUE');
  if (!conditionType) diagnosticSignals.push('CONDITION_TYPE_MISSING');
  if (!mainImage.length) diagnosticSignals.push('MAIN_IMAGE_ATTRIBUTE_MISSING');
  if (!fulfillmentAttributeRows.length) diagnosticSignals.push('FULFILLMENT_ATTRIBUTE_MISSING');
  if (!issues.length) diagnosticSignals.push('NO_ISSUES_RETURNED');
  if (!enforcementActions.length) diagnosticSignals.push('NO_ENFORCEMENT_RETURNED');

  if (!rootCauseConfirmed) {
    if (diagnosticSignals.includes('B2C_OFFER_MISSING')) primaryDiagnostic = 'B2C_OFFER_MISSING';
    else if (diagnosticSignals.includes('B2C_PRICE_MISSING_OR_INVALID')) primaryDiagnostic = 'B2C_PRICE_MISSING_OR_INVALID';
    else if (diagnosticSignals.includes('PURCHASABLE_OFFER_ATTRIBUTE_MISSING')) primaryDiagnostic = 'PURCHASABLE_OFFER_ATTRIBUTE_MISSING';
    else if (diagnosticSignals.includes('SKIP_OFFER_TRUE')) primaryDiagnostic = 'SKIP_OFFER_TRUE';
    else if (diagnosticSignals.includes('CONDITION_TYPE_MISSING')) primaryDiagnostic = 'CONDITION_TYPE_MISSING';
    else primaryDiagnostic = 'NO_BLOCKING_SIGNAL_AFTER_DEEP_GET';
  }

  return {
    sku: String(raw?.sku || initial.sku || '').trim(),
    asin: String(summary.asin || initial.asin || '').trim(),
    title: String(summary.itemName || initial.title || '').trim(),
    productType: String(summary.productType || initial.productType || '').trim(),
    initialReasonClass: initial.reasonClass,
    initialStatus: splitStatuses(initial.status),
    initialAvailableQuantity: initial.availableQuantity,
    deepFetchOk: true,
    deepStatus: statuses,
    deepBuyable: statuses.includes('BUYABLE'),
    deepDiscoverable: statuses.includes('DISCOVERABLE'),
    deepAvailableQuantity: availableQuantity,
    fulfillmentAvailability: availability,
    issueCount: issues.length,
    errorCount: errorIssues.length,
    warningCount: warningIssues.length,
    enforcementActions,
    issues: issues.map(x => ({
      code: String(x?.code || ''),
      severity: String(x?.severity || ''),
      message: String(x?.message || ''),
      attributeNames: Array.isArray(x?.attributeNames) ? x.attributeNames : [],
      categories: Array.isArray(x?.categories) ? x.categories : []
    })),
    offerSnapshot: {
      b2cPresent: Boolean(b2cOffer),
      b2cPrice,
      b2cPoints: finiteNumberOrNull(b2cOffer?.points?.pointsNumber),
      b2bPresent: Boolean(b2bOffer),
      b2bPrice,
      rawOffers: offers
    },
    attributeSnapshot: {
      conditionType,
      skipOfferValue: skipOfferValue ?? null,
      skipOfferTrue,
      purchasableOfferPresent: purchasableOfferRows.length > 0,
      purchasableOfferRows,
      fulfillmentAvailabilityAttributePresent: fulfillmentAttributeRows.length > 0,
      fulfillmentAvailabilityAttributeRows: fulfillmentAttributeRows,
      merchantShippingGroup,
      listPrice,
      mainProductImagePresent: mainImage.length > 0,
      mainProductImageRows: mainImage
    },
    rootCauseConfirmed,
    primaryDiagnostic,
    diagnosticSignals: uniqueStrings(diagnosticSignals),
    createdDate: String(summary.createdDate || ''),
    lastUpdatedDate: String(summary.lastUpdatedDate || '')
  };
}

function extractMediaAttributes(attributes) {
  const out = {};
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return out;

  for (const [key, value] of Object.entries(attributes)) {
    if (/image|media|locator/i.test(String(key || ''))) {
      out[key] = value;
    }
  }
  return out;
}

function collectKnownEnforcements(issues) {
  let text = '';
  try { text = JSON.stringify(issues || []); } catch (_) { text = String(issues || ''); }
  return KNOWN_ENFORCEMENTS.filter(value => text.includes(value));
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(x => String(x || '').trim()).filter(Boolean))];
}

function splitStatuses(value) {
  if (Array.isArray(value)) return value.map(x => String(x || '').trim()).filter(Boolean);
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean);
}

function finiteNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function waitAuditMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { registerAmazonAdsDecisionRoutes };
