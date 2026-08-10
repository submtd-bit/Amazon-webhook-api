/**
 * Render / Express routes for Amazon Ads Decision Engine v6.1.2.
 * Adds read-only competitor ASIN price snapshots using Product Pricing getItemOffersBatch.
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

  // v6.1.2: read-only competitor price snapshot. No listing/ads mutation.
  app.post('/ads/competitor-prices/snapshot', requireSecret, async (req, res) => {
    try {
      const asins = [...new Set((req.body?.asins || [])
        .map(v => String(v || '').trim().toUpperCase())
        .filter(v => /^B0[A-Z0-9]{8}$/.test(v)))];
      if (!asins.length || asins.length > 100) {
        return res.status(400).json({ error: 'asins must contain 1-100 valid ASINs' });
      }

      const itemCondition = String(req.body?.itemCondition || 'Refurbished').trim() || 'Refurbished';
      const preferredSubConditions = Array.isArray(req.body?.preferredSubConditions)
        ? req.body.preferredSubConditions.map(normalizeConditionText).filter(Boolean)
        : ['very good'];
      const items = [];

      const asinBatches = chunk(asins, 20);
      for (let batchIndex = 0; batchIndex < asinBatches.length; batchIndex += 1) {
        if (batchIndex > 0) await waitMs(10500);
        const asinBatch = asinBatches[batchIndex];
        const requests = asinBatch.map(asin => ({
          uri: `/products/pricing/v0/items/${encodeURIComponent(asin)}/offers`,
          method: 'GET',
          MarketplaceId: marketplaceId,
          ItemCondition: itemCondition,
          CustomerType: 'Consumer'
        }));

        let response;
        try {
          response = await spApiRequest({
            method: 'POST',
            path: '/batches/products/pricing/v0/itemOffers',
            body: { requests }
          });
        } catch (error) {
          asinBatch.forEach(asin => items.push({
            asin,
            marketplaceId,
            status: 'ERROR',
            statusCode: '',
            currency: 'JPY',
            featuredOfferPrice: '',
            featuredOfferCondition: '',
            featuredOfferSubCondition: '',
            lowestOfferPrice: '',
            lowestOfferCondition: itemCondition,
            lowestOfferSubCondition: '',
            competitivePriceThreshold: '',
            comparisonPrice: '',
            comparisonSource: '',
            offerCount: 0,
            source: 'SP-API getItemOffersBatch',
            updatedAt: new Date().toISOString(),
            error: error.message || String(error)
          }));
          continue;
        }

        const responses = response?.responses || response?.Responses || [];
        asinBatch.forEach((asin, index) => {
          items.push(normalizeCompetitorPriceResponse(
            asin,
            responses[index] || {},
            marketplaceId,
            itemCondition,
            preferredSubConditions
          ));
        });
      }

      res.json({
        items,
        count: items.length,
        marketplaceId,
        itemCondition,
        preferredSubConditions,
        readOnly: true
      });
    } catch (error) {
      res.status(500).json({ error: error.message || String(error) });
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

function normalizeCompetitorPriceResponse(asin, batchItem, marketplaceId, itemCondition, preferredSubConditions) {
  const statusCode = typeof batchItem?.status === 'number'
    ? batchItem.status
    : batchItem?.status?.statusCode ?? batchItem?.Status?.StatusCode ?? batchItem?.statusCode ?? '';
  const body = batchItem?.body || batchItem?.Body || {};
  const payload = body?.payload || body?.Payload || body || {};
  const offersRaw = payload?.Offers || payload?.offers || [];
  const summary = payload?.Summary || payload?.summary || {};
  const lowestRaw = summary?.LowestPrices || summary?.lowestPrices || [];

  const offers = (Array.isArray(offersRaw) ? offersRaw : []).map(normalizeCompetitorOffer).filter(o => o.landedPrice > 0);
  const preferred = offers.filter(o => preferredSubConditions.includes(normalizeConditionText(o.subCondition)));
  const eligible = preferred.length ? preferred : offers;
  eligible.sort((a, b) => a.effectivePrice - b.effectivePrice);

  const featured = eligible.find(o => o.isBuyBoxWinner) || offers.find(o => o.isBuyBoxWinner) || null;
  const lowestOffer = eligible[0] || null;

  const summaryPrices = (Array.isArray(lowestRaw) ? lowestRaw : [])
    .map(normalizeCompetitorSummaryPrice)
    .filter(o => o.landedPrice > 0)
    .sort((a, b) => a.effectivePrice - b.effectivePrice);
  const summaryLowest = summaryPrices[0] || null;

  const comparison = featured || lowestOffer || summaryLowest || null;
  const offerCount = numberOrZero(summary?.TotalOfferCount ?? summary?.totalOfferCount ?? offers.length);
  const errors = body?.errors || body?.Errors || batchItem?.errors || batchItem?.Errors || [];

  return {
    asin,
    marketplaceId,
    status: comparison ? 'READY' : (statusCode === 200 ? 'NO_PRICE' : 'ERROR'),
    statusCode,
    currency: comparison?.currency || featured?.currency || lowestOffer?.currency || summaryLowest?.currency || 'JPY',
    featuredOfferPrice: featured ? featured.effectivePrice : '',
    featuredOfferCondition: itemCondition,
    featuredOfferSubCondition: featured?.subCondition || '',
    lowestOfferPrice: (lowestOffer || summaryLowest)?.effectivePrice || '',
    lowestOfferCondition: itemCondition,
    lowestOfferSubCondition: lowestOffer?.subCondition || summaryLowest?.subCondition || '',
    competitivePriceThreshold: '',
    comparisonPrice: comparison?.effectivePrice || '',
    comparisonSource: featured ? 'BuyBoxWinner' : lowestOffer ? 'LowestPreferredOffer' : summaryLowest ? 'Summary.LowestPrices' : '',
    offerCount,
    source: 'SP-API getItemOffersBatch / ' + itemCondition,
    updatedAt: new Date().toISOString(),
    error: comparison ? '' : stringifyErrors(errors) || (statusCode && statusCode !== 200 ? 'API status=' + statusCode : 'price not found')
  };
}

function normalizeCompetitorOffer(offer) {
  const listingPrice = moneyAmount(offer?.ListingPrice ?? offer?.listingPrice);
  const shipping = moneyAmount(offer?.Shipping ?? offer?.shipping) || 0;
  const landed = listingPrice !== null ? listingPrice + shipping : null;
  const points = pointAmount(offer?.Points ?? offer?.points) || 0;
  const effective = landed !== null ? Math.max(0, landed - points) : 0;
  const currency = (offer?.ListingPrice?.CurrencyCode || offer?.listingPrice?.currencyCode || 'JPY');
  return {
    effectivePrice: effective,
    landedPrice: landed || 0,
    currency,
    subCondition: String(offer?.SubCondition ?? offer?.subCondition ?? offer?.Subcondition ?? ''),
    isBuyBoxWinner: Boolean(offer?.IsBuyBoxWinner ?? offer?.isBuyBoxWinner)
  };
}

function normalizeCompetitorSummaryPrice(item) {
  const listing = moneyAmount(item?.ListingPrice ?? item?.listingPrice);
  const shipping = moneyAmount(item?.Shipping ?? item?.shipping) || 0;
  const landedApi = moneyAmount(item?.LandedPrice ?? item?.landedPrice);
  const points = pointAmount(item?.Points ?? item?.points) || 0;
  const landed = landedApi !== null ? landedApi : (listing !== null ? listing + shipping : null);
  const effective = landed !== null ? Math.max(0, landed - points) : 0;
  const currency = item?.LandedPrice?.CurrencyCode || item?.ListingPrice?.CurrencyCode || 'JPY';
  return {
    effectivePrice: effective,
    landedPrice: landed || 0,
    currency,
    subCondition: String(item?.condition ?? item?.Condition ?? '')
  };
}

function moneyAmount(obj) {
  if (!obj) return null;
  const value = obj.Amount ?? obj.amount;
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pointAmount(obj) {
  if (!obj) return 0;
  const direct = Number(obj.PointsNumber ?? obj.pointsNumber);
  if (Number.isFinite(direct)) return direct;
  return moneyAmount(obj.PointsMonetaryValue ?? obj.pointsMonetaryValue) || 0;
}

function normalizeConditionText(value) {
  return String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function stringifyErrors(errors) {
  if (!errors) return '';
  try { return JSON.stringify(errors).slice(0, 1000); } catch (e) { return String(errors).slice(0, 1000); }
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

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
