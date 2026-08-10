/**
 * Render / Express routes for Amazon Ads Decision Engine v6.1.3.
 * Adds read-only competitor ASIN price snapshots and Catalog Items specification snapshots.
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

  // v6.1.3: read-only Catalog Items snapshot for own/competitor ASIN specification comparison.
  app.post('/ads/catalog-items/snapshot', requireSecret, async (req, res) => {
    try {
      const asins = [...new Set((req.body?.asins || [])
        .map(v => String(v || '').trim().toUpperCase())
        .filter(v => /^B0[A-Z0-9]{8}$/.test(v)))];
      if (!asins.length || asins.length > 100) {
        return res.status(400).json({ error: 'asins must contain 1-100 valid ASINs' });
      }

      const items = [];
      for (let index = 0; index < asins.length; index += 1) {
        if (index > 0) await waitMs(250);
        const asin = asins[index];
        try {
          const data = await spApiRequest({
            method: 'GET',
            path: `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`,
            query: {
              marketplaceIds: marketplaceId,
              includedData: 'attributes,summaries,productTypes'
            }
          });
          items.push(normalizeCatalogItem(asin, data, marketplaceId));
        } catch (error) {
          items.push({
            asin,
            marketplaceId,
            status: 'ERROR',
            title: '',
            brand: '',
            model: '',
            productType: '',
            cpu: '',
            cpuClass: '',
            cpuGeneration: '',
            memoryGb: '',
            storageGb: '',
            storageType: '',
            screenInches: '',
            operatingSystem: '',
            office: '',
            specCompleteness: 0,
            source: 'Catalog Items v2022-04-01',
            updatedAt: new Date().toISOString(),
            error: error.message || String(error)
          });
        }
      }

      res.json({ items, count: items.length, marketplaceId, readOnly: true });
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

function normalizeCatalogItem(asin, data, marketplaceId) {
  const summaries = Array.isArray(data?.summaries) ? data.summaries : [];
  const summary = summaries.find(x => !x?.marketplaceId || x.marketplaceId === marketplaceId) || summaries[0] || {};
  const productTypes = Array.isArray(data?.productTypes) ? data.productTypes : [];
  const productTypeRow = productTypes.find(x => !x?.marketplaceId || x.marketplaceId === marketplaceId) || productTypes[0] || {};
  const attrs = data?.attributes || {};

  const title = firstText(summary.itemName, attrFirst(attrs, 'item_name'));
  const brand = firstText(summary.brand, attrFirst(attrs, 'brand'), attrFirst(attrs, 'manufacturer'));
  const model = firstText(attrFirst(attrs, 'model_name'), attrFirst(attrs, 'model_number'));
  const productType = firstText(productTypeRow.productType, summary.productType);

  const cpuModel = firstObject(attrs, 'cpu_model');
  const cpu = firstText(
    nestedFirstText(cpuModel, 'model_number'),
    nestedFirstText(cpuModel, 'family'),
    attrFirst(attrs, 'processor_model_number'),
    attrFirst(attrs, 'processor_type'),
    extractCpuText(title)
  );
  const cpuClass = extractCpuClass([cpu, title].filter(Boolean).join(' '));
  const generationText = firstText(nestedFirstText(cpuModel, 'generation'), extractGenerationText([cpu, title].join(' ')));
  const cpuGeneration = parseGenerationNumber(generationText);

  const ramEntry = firstObject(attrs, 'ram_memory');
  const memoryGb = firstPositiveNumber(
    nestedMeasurement(ramEntry, 'installed_size', 'GB'),
    measurementAttr(attrs, 'memory_storage_capacity', 'GB'),
    extractMemoryGb(title)
  );

  const hardDisk = firstObject(attrs, 'hard_disk');
  const storageGb = firstPositiveNumber(
    nestedMeasurement(hardDisk, 'size', 'GB'),
    measurementAttr(attrs, 'flash_memory', 'GB', 'installed_size'),
    extractStorageGb(title)
  );
  const storageType = firstText(
    nestedFirstText(hardDisk, 'description'),
    /\bSSD\b/i.test(title) ? 'SSD' : '',
    /\bHDD\b/i.test(title) ? 'HDD' : ''
  );

  const display = firstObject(attrs, 'display');
  const screenInches = firstPositiveNumber(
    nestedMeasurement(display, 'size', 'inches'),
    extractScreenInches(title)
  );
  const operatingSystem = firstText(attrFirst(attrs, 'operating_system'), extractOperatingSystem(title));

  const officeHaystack = [
    title,
    ...attrTextList(attrs, 'included_components'),
    ...attrTextList(attrs, 'bullet_point'),
    ...attrTextList(attrs, 'product_description')
  ].join(' ');
  const office = /(?:MS\s*)?Office\s*20\d{2}|Microsoft\s*Office/i.test(officeHaystack)
    ? ((officeHaystack.match(/(?:MS\s*)?Office\s*20\d{2}|Microsoft\s*Office(?:\s*20\d{2})?/i) || [''])[0])
    : '';

  const keySpecs = [cpuClass, cpuGeneration, memoryGb, storageGb, storageType, screenInches];
  const complete = keySpecs.filter(v => v !== '' && v !== 0 && v !== null && v !== undefined).length;

  return {
    asin,
    marketplaceId,
    status: title ? 'READY' : 'PARTIAL',
    title,
    brand,
    model,
    productType,
    cpu,
    cpuClass,
    cpuGeneration: cpuGeneration || '',
    memoryGb: memoryGb || '',
    storageGb: storageGb || '',
    storageType,
    screenInches: screenInches || '',
    operatingSystem,
    office,
    specCompleteness: complete / keySpecs.length,
    source: 'Catalog Items v2022-04-01',
    updatedAt: new Date().toISOString(),
    error: ''
  };
}

function firstObject(attrs, key) {
  const list = Array.isArray(attrs?.[key]) ? attrs[key] : [];
  return list.find(v => v && typeof v === 'object') || {};
}

function attrFirst(attrs, key) {
  const list = Array.isArray(attrs?.[key]) ? attrs[key] : [];
  for (const entry of list) {
    if (entry == null) continue;
    if (typeof entry === 'string' || typeof entry === 'number') return entry;
    if (entry.value != null && typeof entry.value !== 'object') return entry.value;
  }
  return '';
}

function attrTextList(attrs, key) {
  const list = Array.isArray(attrs?.[key]) ? attrs[key] : [];
  return list.map(entry => {
    if (entry == null) return '';
    if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
    if (entry.value != null && typeof entry.value !== 'object') return String(entry.value);
    return '';
  }).filter(Boolean);
}

function nestedFirstText(obj, key) {
  if (!obj || typeof obj !== 'object') return '';
  const value = obj[key];
  const list = Array.isArray(value) ? value : value != null ? [value] : [];
  for (const entry of list) {
    if (entry == null) continue;
    if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
    if (entry.value != null && typeof entry.value !== 'object') return String(entry.value);
  }
  return '';
}

function nestedMeasurement(obj, key, desiredUnit) {
  if (!obj || typeof obj !== 'object') return 0;
  const list = Array.isArray(obj[key]) ? obj[key] : [];
  for (const entry of list) {
    const value = Number(entry?.value);
    const unit = String(entry?.unit || desiredUnit || '').toUpperCase();
    if (!Number.isFinite(value) || value <= 0) continue;
    return convertStorageUnit(value, unit, desiredUnit);
  }
  return 0;
}

function measurementAttr(attrs, key, desiredUnit, nestedKey) {
  const entries = Array.isArray(attrs?.[key]) ? attrs[key] : [];
  for (const entry of entries) {
    if (nestedKey) {
      const value = nestedMeasurement(entry, nestedKey, desiredUnit);
      if (value > 0) return value;
    }
    const n = Number(entry?.value);
    if (Number.isFinite(n) && n > 0) return convertStorageUnit(n, String(entry?.unit || desiredUnit), desiredUnit);
  }
  return 0;
}

function convertStorageUnit(value, fromUnit, desiredUnit) {
  const from = String(fromUnit || '').toUpperCase();
  const desired = String(desiredUnit || '').toUpperCase();
  if (desired !== 'GB') return value;
  if (from === 'TB') return value * 1000;
  if (from === 'MB') return value / 1000;
  return value;
}

function firstText(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function extractCpuText(text) {
  const s = String(text || '');
  return (s.match(/(?:Intel\s*)?Core\s*i[3579][\s-]*\d{3,5}[A-Z0-9-]*/i) ||
    s.match(/Ryzen\s*[3579][\s-]*\d{3,5}[A-Z0-9-]*/i) || [''])[0];
}

function extractCpuClass(text) {
  const s = String(text || '');
  const intel = s.match(/Core\s*i([3579])/i);
  if (intel) return `i${intel[1]}`;
  const ryzen = s.match(/Ryzen\s*([3579])/i);
  if (ryzen) return `Ryzen ${ryzen[1]}`;
  return '';
}

function extractGenerationText(text) {
  const s = String(text || '');
  const jp = s.match(/第\s*(\d{1,2})\s*世代/i);
  if (jp) return `第${jp[1]}世代`;
  const cpu = s.match(/Core\s*i[3579][\s-]*(\d{4,5})/i);
  if (cpu) {
    const digits = cpu[1];
    const generation = digits.length >= 5 ? Number(digits.slice(0, 2)) : Number(digits.charAt(0));
    if (generation > 0 && generation < 30) return `第${generation}世代`;
  }
  return '';
}

function parseGenerationNumber(value) {
  const m = String(value || '').match(/(\d{1,2})/);
  return m ? Number(m[1]) : 0;
}

function extractMemoryGb(text) {
  const s = String(text || '');
  const explicit = s.match(/(?:RAM|メモリ)\s*[:：]?\s*(\d+)\s*GB/i);
  if (explicit) return Number(explicit[1]);
  return 0;
}

function extractStorageGb(text) {
  const s = String(text || '');
  const m = s.match(/(?:SSD|HDD|ストレージ)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(TB|GB)/i);
  if (!m) return 0;
  return String(m[2]).toUpperCase() === 'TB' ? Number(m[1]) * 1000 : Number(m[1]);
}

function extractScreenInches(text) {
  const m = String(text || '').match(/(\d{1,2}(?:\.\d+)?)\s*(?:インチ|型)/i);
  return m ? Number(m[1]) : 0;
}

function extractOperatingSystem(text) {
  const m = String(text || '').match(/Windows\s*(?:10|11)(?:\s*(?:Pro|Home))?/i);
  return m ? m[0] : '';
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
