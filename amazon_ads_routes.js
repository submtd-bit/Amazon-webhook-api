import { registerAmazonAdsDecisionRoutes as registerLegacyAmazonAdsDecisionRoutes } from './amazon_ads_routes_legacy.js';

const INACTIVE_AUDIT_VERSION = 'AMAZON_INACTIVE_AUDIT_V1.0.0';
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

function collectKnownEnforcements(issues) {
  let text = '';
  try { text = JSON.stringify(issues || []); } catch (_) { text = String(issues || ''); }
  return KNOWN_ENFORCEMENTS.filter(value => text.includes(value));
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(x => String(x || '').trim()).filter(Boolean))];
}

function waitAuditMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { registerAmazonAdsDecisionRoutes };
