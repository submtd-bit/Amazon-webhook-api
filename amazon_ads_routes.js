/**
 * Render / Express routes for Amazon Ads Decision Engine v4.
 *
 * Integration (ES modules):
 *   import { registerAmazonAdsDecisionRoutes } from "./amazon_ads_routes.js";
 *   registerAmazonAdsDecisionRoutes(app, {
 *     spApiRequest: decisionSpApiRequest,
 *     sellerId: process.env.SPAPI_SELLER_ID,
 *     marketplaceId: process.env.SPAPI_MARKETPLACE_ID,
 *     apiSecret: process.env.AMAZON_STOCK_API_SECRET
 *   });
 *
 * Expected helper contract:
 *   spApiRequest({ method, path, query, body }) -> parsed JSON
 */

function registerAmazonAdsDecisionRoutes(app, deps) {
  const { spApiRequest, sellerId, marketplaceId, apiSecret } = deps;
  if (!app || !spApiRequest || !sellerId || !marketplaceId || !apiSecret) {
    throw new Error('Decision routes require app, spApiRequest, sellerId, marketplaceId and apiSecret.');
  }

  const requireSecret = (req, res, next) => {
    if (req.get('X-API-SECRET') !== apiSecret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };

  app.post('/ads/listings/snapshot', requireSecret, async (req, res) => {
    try {
      const skus = [...new Set((req.body?.skus || []).map(String).map(v => v.trim()).filter(Boolean))];
      if (!skus.length || skus.length > 1000) {
        return res.status(400).json({ error: 'skus must contain 1-1000 values' });
      }

      const listingResults = [];
      for (const sku of skus) {
        try {
          const listing = await spApiRequest({
            method: 'GET',
            path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
            query: {
              marketplaceIds: marketplaceId,
              includedData: 'summaries,attributes,issues,fulfillmentAvailability'
            }
          });
          listingResults.push(normalizeListing(sku, listing));
        } catch (error) {
          listingResults.push({ sku, status: 'ERROR', buyable: false, errorCount: 1, error: error.message });
        }
      }

      // Product Pricing API allows batching. Keep batches small for predictable throttling.
      const pricingBySku = {};
      for (const batch of chunk(skus, 20)) {
        try {
          const pricing = await spApiRequest({
            method: 'GET',
            path: '/products/pricing/v0/price',
            query: {
              MarketplaceId: marketplaceId,
              ItemType: 'Sku',
              Skus: batch.join(',')
            }
          });
          for (const item of pricing?.payload || pricing || []) {
            const sku = item.SellerSKU || item.sku;
            if (sku) pricingBySku[sku] = normalizePricing(item);
          }
        } catch (error) {
          for (const sku of batch) pricingBySku[sku] = { pricingError: error.message };
        }
      }

      const items = listingResults.map(item => {
        const p = pricingBySku[item.sku] || {};
        const ownPrice = numberOrZero(p.ownPrice || item.ownPrice);
        const featured = numberOrZero(p.featuredOfferPrice);
        const lowest = numberOrZero(p.lowestOfferPrice);
        const benchmark = featured || lowest || 0;
        return {
          ...item,
          ...p,
          ownPrice,
          featuredOfferPrice: featured,
          lowestOfferPrice: lowest,
          priceGapYen: ownPrice > 0 && benchmark > 0 ? ownPrice - benchmark : 0,
          priceGapPct: ownPrice > 0 && benchmark > 0 ? (ownPrice - benchmark) / benchmark : 0,
          pricingSource: p.pricingSource || 'ProductPricingV0'
        };
      });

      res.json({ items, count: items.length, marketplaceId });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/ads/listings/price', requireSecret, async (req, res) => {
    try {
      const sku = String(req.body?.sku || '').trim();
      const price = Number(req.body?.price);
      const currency = String(req.body?.currency || 'JPY');
      const dryRun = Boolean(req.body?.dryRun);
      if (!sku || !Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: 'valid sku and positive price are required' });
      }

      const patchBody = {
        productType: 'PRODUCT',
        patches: [{
          op: 'replace',
          path: '/attributes/purchasable_offer',
          value: [{
            marketplace_id: marketplaceId,
            currency,
            our_price: [{ schedule: [{ value_with_tax: price }] }]
          }]
        }]
      };

      if (dryRun) return res.json({ status: 'DRY_RUN', sku, price, patchBody });

      const result = await spApiRequest({
        method: 'PATCH',
        path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
        query: { marketplaceIds: marketplaceId, issueLocale: 'ja_JP' },
        body: patchBody
      });
      res.json({ status: 'ACCEPTED', sku, price, result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

function normalizeListing(sku, data) {
  const summary = Array.isArray(data?.summaries) ? data.summaries[0] || {} : {};
  const availability = Array.isArray(data?.fulfillmentAvailability)
    ? data.fulfillmentAvailability[0] || {}
    : {};
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const attrs = data?.attributes || {};
  const imageValues = collectImageValues(attrs);
  const main = imageValues[0] || {};
  const status = Array.isArray(summary.status) ? summary.status.join(',') : String(summary.status || '');
  return {
    sku,
    asin: summary.asin || '',
    productType: summary.productType || '',
    title: summary.itemName || '',
    status,
    buyable: /BUYABLE|DISCOVERABLE/i.test(status) && !issues.some(i => String(i.severity).toUpperCase() === 'ERROR'),
    discoverable: /DISCOVERABLE|BUYABLE/i.test(status),
    availableQuantity: numberOrZero(availability.quantity),
    fulfillmentChannel: availability.fulfillmentChannelCode || '',
    issueCount: issues.length,
    errorCount: issues.filter(i => String(i.severity).toUpperCase() === 'ERROR').length,
    imageCount: imageValues.length,
    mainImageUrl: main.link || main.url || '',
    mainImageWidth: numberOrZero(main.width?.value || main.width),
    mainImageHeight: numberOrZero(main.height?.value || main.height),
    rawJson: data
  };
}

function normalizePricing(item) {
  const product = item?.Product || item?.product || item;
  const offers = product?.CompetitivePricing?.CompetitivePrices || [];
  const ownOffer = product?.Offers?.[0] || {};
  const ownPrice = numberOrZero(ownOffer?.BuyingPrice?.LandedPrice?.Amount || ownOffer?.BuyingPrice?.ListingPrice?.Amount);
  const featured = offers.find(x => String(x.CompetitivePriceId) === '1') || offers[0] || {};
  const featuredPrice = numberOrZero(featured?.Price?.LandedPrice?.Amount || featured?.Price?.ListingPrice?.Amount);
  const lowest = numberOrZero(product?.CompetitivePricing?.NumberOfOfferListings?.[0]?.LowestPrice?.LandedPrice?.Amount);
  return {
    ownPrice,
    currency: ownOffer?.BuyingPrice?.LandedPrice?.CurrencyCode || 'JPY',
    featuredOfferPrice: featuredPrice,
    lowestOfferPrice: lowest,
    competitivePrice: featuredPrice,
    pricingSource: 'ProductPricingV0'
  };
}

function collectImageValues(attributes) {
  const values = [];
  for (const [key, entries] of Object.entries(attributes || {})) {
    if (!/image/i.test(key) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && (entry.link || entry.url)) values.push(entry);
    }
  }
  return values;
}

function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function numberOrZero(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

export { registerAmazonAdsDecisionRoutes };
