/**
 * Render / Express routes for Amazon Ads Decision Engine v5.0.
 *
 * ES modules:
 *   import { registerAmazonAdsDecisionRoutes } from "./amazon_ads_routes.js";
 *
 * Expected helper:
 *   spApiRequest({ method, path, query, body }) -> parsed JSON
 */

function registerAmazonAdsDecisionRoutes(app, deps) {
  const { spApiRequest, sellerId, marketplaceId, apiSecret } = deps;

  if (!app || !spApiRequest || !sellerId || !marketplaceId || !apiSecret) {
    throw new Error(
      "Decision routes require app, spApiRequest, sellerId, marketplaceId and apiSecret."
    );
  }

  const requireSecret = (req, res, next) => {
    if (req.get("X-API-SECRET") !== apiSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  };

  app.post("/ads/listings/snapshot", requireSecret, async (req, res) => {
    try {
      const skus = [
        ...new Set(
          (req.body?.skus || [])
            .map(String)
            .map((value) => value.trim())
            .filter(Boolean)
        )
      ];

      if (!skus.length || skus.length > 1000) {
        return res.status(400).json({
          error: "skus must contain 1-1000 values"
        });
      }

      const listingResults = [];

      for (const sku of skus) {
        try {
          const listing = await spApiRequest({
            method: "GET",
            path:
              `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/` +
              `${encodeURIComponent(sku)}`,
            query: {
              marketplaceIds: marketplaceId,
              includedData:
                "summaries,attributes,issues,fulfillmentAvailability"
            }
          });

          listingResults.push(normalizeListing(sku, listing));
        } catch (error) {
          listingResults.push({
            sku,
            asin: "",
            productType: "",
            title: "",
            status: "ERROR",
            buyable: false,
            discoverable: false,
            availableQuantity: null,
            fulfillmentChannel: "",
            ownPrice: 0,
            currency: "JPY",
            issueCount: 0,
            errorCount: 1,
            imageCount: 0,
            mainImageUrl: "",
            mainImageWidth: 0,
            mainImageHeight: 0,
            error: error.message
          });
        }
      }

      // Only request pricing for listings that actually exist.
      const validSkus = listingResults
        .filter((item) => item.status !== "ERROR" && item.asin)
        .map((item) => item.sku);

      const pricingBySku = {};

      for (let index = 0; index < validSkus.length; index += 20) {
        const batch = validSkus.slice(index, index + 20);

        if (index > 0) {
          // Product Pricing v0 has a low restore rate. Avoid burst requests.
          await sleep(2300);
        }

        try {
          const pricing = await fetchPricingBatchWithRetry(
            spApiRequest,
            marketplaceId,
            batch
          );

          const payload = Array.isArray(pricing?.payload)
            ? pricing.payload
            : Array.isArray(pricing)
              ? pricing
              : [];

          for (const item of payload) {
            const sku = item?.SellerSKU || item?.sellerSKU || item?.sku;
            if (sku) {
              pricingBySku[String(sku)] = normalizePricing(item);
            }
          }
        } catch (error) {
          for (const sku of batch) {
            pricingBySku[sku] = {
              pricingError: error.message,
              pricingSource: "ProductPricingV0"
            };
          }
        }
      }

      const items = listingResults.map((item) => {
        const pricing = pricingBySku[item.sku] || {};

        const ownPrice =
          positiveNumber(pricing.ownPrice) ||
          positiveNumber(item.ownPrice) ||
          0;

        const featuredOfferPrice =
          positiveNumber(pricing.featuredOfferPrice) || 0;

        const lowestOfferPrice =
          positiveNumber(pricing.lowestOfferPrice) || 0;

        const competitivePrice =
          positiveNumber(pricing.competitivePrice) ||
          featuredOfferPrice ||
          lowestOfferPrice ||
          0;

        const benchmark =
          featuredOfferPrice || lowestOfferPrice || competitivePrice || 0;

        return {
          ...item,
          ...pricing,
          ownPrice,
          currency: pricing.currency || item.currency || "JPY",
          featuredOfferPrice,
          lowestOfferPrice,
          competitivePrice,
          priceGapYen:
            ownPrice > 0 && benchmark > 0
              ? ownPrice - benchmark
              : 0,
          priceGapPct:
            ownPrice > 0 && benchmark > 0
              ? (ownPrice - benchmark) / benchmark
              : 0,
          pricingSource:
            pricing.pricingSource ||
            (item.ownPrice > 0
              ? "ListingsItems.purchasable_offer"
              : "ProductPricingV0")
        };
      });

      return res.json({
        items,
        count: items.length,
        marketplaceId,
        diagnostics: {
          requestedSkuCount: skus.length,
          validListingCount: validSkus.length,
          notFoundOrErrorCount: skus.length - validSkus.length,
          pricingErrorCount: items.filter((item) => item.pricingError).length
        }
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("/price/orders/capabilities", requireSecret, (req, res) => {
    return res.json({
      ordersApiVersion: "2026-01-01",
      marketplaceId,
      defaultLookbackDays: 45,
      maxLookbackDays: 120,
      maxPages: 20,
      includesPii: false
    });
  });

  app.post("/price/orders/snapshot", requireSecret, async (req, res) => {
    try {
      const lookbackDays = clampInteger(req.body?.lookbackDays, 45, 7, 120);
      const maxPages = clampInteger(req.body?.maxPages, 20, 1, 20);
      const now = new Date();
      const createdBefore = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
      const createdAfter = new Date(
        now.getTime() - lookbackDays * 24 * 60 * 60 * 1000
      ).toISOString();

      const orders = [];
      let paginationToken = "";
      let pages = 0;

      do {
        const query = {
          createdAfter,
          createdBefore,
          marketplaceIds: marketplaceId,
          maxResultsPerPage: 100,
          includedData: "PROCEEDS,FULFILLMENT,PROMOTION"
        };
        if (paginationToken) query.paginationToken = paginationToken;

        const response = await spApiRequest({
          method: "GET",
          path: "/orders/2026-01-01/orders",
          query
        });

        const pageOrders = Array.isArray(response?.orders)
          ? response.orders
          : [];
        orders.push(...pageOrders);
        pages += 1;
        paginationToken = String(response?.pagination?.nextToken || "");

        if (paginationToken && pages < maxPages) {
          await sleep(150);
        }
      } while (paginationToken && pages < maxPages);

      const items = normalizeOrdersSnapshot(orders);

      return res.json({
        ordersApiVersion: "2026-01-01",
        marketplaceId,
        createdAfter,
        createdBefore,
        lookbackDays,
        pages,
        partial: Boolean(paginationToken),
        orderCount: orders.length,
        count: items.length,
        items
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message,
        code: error.code || "ORDER_SNAPSHOT_ERROR"
      });
    }
  });

}
function normalizeOrdersSnapshot(orders) {
  const items = [];

  for (const order of Array.isArray(orders) ? orders : []) {
    const fulfillmentStatus = String(
      order?.fulfillment?.fulfillmentStatus || ""
    ).toUpperCase();
    const fulfilledBy = String(order?.fulfillment?.fulfilledBy || "");
    const orderItems = Array.isArray(order?.orderItems)
      ? order.orderItems
      : [];

    for (const item of orderItems) {
      const product = item?.product || {};
      const quantityOrdered = numberOrZero(item?.quantityOrdered);
      const unitPrice = moneyAmountOrNull(product?.price?.unitPrice);
      const itemSubtotal = sumItemProceedsType(item?.proceeds?.breakdowns, "ITEM");
      const promotionDiscount = Math.abs(
        sumItemProceedsType(item?.proceeds?.breakdowns, "DISCOUNT")
      );
      const grossItemSales = unitPrice !== null
        ? unitPrice * quantityOrdered
        : itemSubtotal;

      items.push({
        orderId: String(order?.orderId || ""),
        orderItemId: String(item?.orderItemId || ""),
        orderDate: order?.createdTime || "",
        lastUpdatedTime: order?.lastUpdatedTime || "",
        fulfillmentStatus,
        fulfilledBy,
        marketplaceId: order?.salesChannel?.marketplaceId || "",
        marketplaceName: order?.salesChannel?.marketplaceName || "",
        sellerSku: String(product?.sellerSku || ""),
        asin: String(product?.asin || ""),
        title: String(product?.title || ""),
        quantityOrdered,
        quantityFulfilled: numberOrZero(item?.fulfillment?.quantityFulfilled),
        unitPrice,
        currency: product?.price?.unitPrice?.currencyCode || "JPY",
        grossItemSales,
        itemSubtotal,
        promotionDiscount
      });
    }
  }

  return items;
}

function sumItemProceedsType(breakdowns, type) {
  return (Array.isArray(breakdowns) ? breakdowns : [])
    .filter((entry) => String(entry?.type || "").toUpperCase() === type)
    .reduce((sum, entry) => sum + numberOrZero(entry?.subtotal?.amount), 0);
}

function moneyAmountOrNull(money) {
  if (!money || money.amount === null || money.amount === undefined) {
    return null;
  }
  const value = Number(money.amount);
  return Number.isFinite(value) ? value : null;
}

function clampInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  const integer = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.min(Math.max(integer, minimum), maximum);
}

async function fetchPricingBatchWithRetry(
  spApiRequest,
  marketplaceId,
  skus
) {
  try {
    return await spApiRequest({
      method: "GET",
      path: "/products/pricing/v0/price",
      query: {
        MarketplaceId: marketplaceId,
        ItemType: "Sku",
        Skus: skus.join(",")
      }
    });
  } catch (error) {
    if (!/429|QuotaExceeded/i.test(String(error?.message || error))) {
      throw error;
    }

    await sleep(3500);

    return spApiRequest({
      method: "GET",
      path: "/products/pricing/v0/price",
      query: {
        MarketplaceId: marketplaceId,
        ItemType: "Sku",
        Skus: skus.join(",")
      }
    });
  }
}

function normalizeListing(sku, data) {
  const summary = Array.isArray(data?.summaries)
    ? data.summaries[0] || {}
    : {};

  const availability = Array.isArray(data?.fulfillmentAvailability)
    ? data.fulfillmentAvailability[0] || {}
    : {};

  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const attributes = data?.attributes || {};

  const statuses = Array.isArray(summary.status)
    ? summary.status.map((value) => String(value).toUpperCase())
    : String(summary.status || "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);

  const listingSuppressed = issues.some((issue) => {
    const actions = issue?.enforcements?.actions;
    if (!Array.isArray(actions)) return false;

    return actions.some((entry) =>
      /LISTING_SUPPRESSED|OFFER_SUPPRESSED|PURCHASING_DISABLED/i.test(
        String(entry?.action || "")
      )
    );
  });

  const imageValues = collectImageValues(summary, attributes);
  const mainImage =
    imageValues.find((image) => image.isMain) ||
    imageValues[0] ||
    {};

  return {
    sku,
    asin: summary.asin || "",
    productType: summary.productType || "",
    title: summary.itemName || "",
    status: statuses.join(","),
    buyable: statuses.includes("BUYABLE") && !listingSuppressed,
    discoverable: statuses.includes("DISCOVERABLE"),
    availableQuantity: finiteNumberOrNull(availability.quantity),
    fulfillmentChannel: availability.fulfillmentChannelCode || "",
    ownPrice: extractOwnPrice(attributes),
    currency: extractCurrency(attributes) || "JPY",
    issueCount: issues.length,
    errorCount: issues.filter(
      (issue) => String(issue?.severity || "").toUpperCase() === "ERROR"
    ).length,
    imageCount: imageValues.length,
    mainImageUrl: mainImage.url || "",
    mainImageWidth: numberOrZero(mainImage.width),
    mainImageHeight: numberOrZero(mainImage.height),
    rawJson: data
  };
}

function extractOwnPrice(attributes) {
  const offers = Array.isArray(attributes?.purchasable_offer)
    ? attributes.purchasable_offer
    : [];

  const offer =
    offers.find(
      (entry) => String(entry?.audience || "ALL").toUpperCase() === "ALL"
    ) ||
    offers[0] ||
    {};

  const discounted = extractCurrentScheduledValue(
    offer?.discounted_price?.[0]?.schedule
  );

  if (discounted > 0) return discounted;

  return extractCurrentScheduledValue(
    offer?.our_price?.[0]?.schedule
  );
}

function extractCurrency(attributes) {
  const offers = Array.isArray(attributes?.purchasable_offer)
    ? attributes.purchasable_offer
    : [];

  const offer =
    offers.find(
      (entry) => String(entry?.audience || "ALL").toUpperCase() === "ALL"
    ) ||
    offers[0] ||
    {};

  return String(offer?.currency || "");
}

function extractCurrentScheduledValue(schedule) {
  if (!Array.isArray(schedule)) return 0;

  const now = Date.now();

  for (const entry of schedule) {
    const startText =
      entry?.start_at?.value ??
      entry?.start_at ??
      entry?.startAt?.value ??
      entry?.startAt ??
      "";

    const endText =
      entry?.end_at?.value ??
      entry?.end_at ??
      entry?.endAt?.value ??
      entry?.endAt ??
      "";

    const start = startText ? Date.parse(startText) : null;
    const end = endText ? Date.parse(endText) : null;

    const isStarted = start === null || Number.isNaN(start) || start <= now;
    const isNotEnded = end === null || Number.isNaN(end) || end >= now;

    if (!isStarted || !isNotEnded) continue;

    const value =
      entry?.value_with_tax ??
      entry?.valueWithTax ??
      entry?.value ??
      0;

    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }

  return 0;
}

function normalizePricing(item) {
  const product = item?.Product || item?.product || {};
  const offers = Array.isArray(product?.Offers)
    ? product.Offers
    : Array.isArray(product?.offers)
      ? product.offers
      : [];

  const ownOffer = offers[0] || {};

  const ownPrice =
    positiveNumber(
      ownOffer?.BuyingPrice?.LandedPrice?.Amount
    ) ||
    positiveNumber(
      ownOffer?.BuyingPrice?.ListingPrice?.Amount
    ) ||
    0;

  const competitivePrices =
    product?.CompetitivePricing?.CompetitivePrices ||
    product?.competitivePricing?.competitivePrices ||
    [];

  const featured =
    competitivePrices.find(
      (entry) =>
        String(
          entry?.CompetitivePriceId ??
          entry?.competitivePriceId ??
          ""
        ) === "1"
    ) ||
    competitivePrices[0] ||
    {};

  const featuredOfferPrice =
    positiveNumber(featured?.Price?.LandedPrice?.Amount) ||
    positiveNumber(featured?.Price?.ListingPrice?.Amount) ||
    positiveNumber(featured?.price?.landedPrice?.amount) ||
    positiveNumber(featured?.price?.listingPrice?.amount) ||
    0;

  const lowestOfferPrice = findLowestOfferPrice(offers);

  return {
    ownPrice,
    currency:
      ownOffer?.BuyingPrice?.LandedPrice?.CurrencyCode ||
      ownOffer?.BuyingPrice?.ListingPrice?.CurrencyCode ||
      "JPY",
    featuredOfferPrice,
    lowestOfferPrice,
    competitivePrice: featuredOfferPrice,
    pricingSource: "ProductPricingV0"
  };
}

function findLowestOfferPrice(offers) {
  const values = [];

  for (const offer of offers || []) {
    const price =
      positiveNumber(offer?.BuyingPrice?.LandedPrice?.Amount) ||
      positiveNumber(offer?.BuyingPrice?.ListingPrice?.Amount) ||
      0;

    if (price > 0) values.push(price);
  }

  return values.length ? Math.min(...values) : 0;
}

function collectImageValues(summary, attributes) {
  const images = [];
  const seen = new Set();

  const addImage = (url, width, height, isMain) => {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl || seen.has(normalizedUrl)) return;

    seen.add(normalizedUrl);
    images.push({
      url: normalizedUrl,
      width: numberOrZero(width),
      height: numberOrZero(height),
      isMain: Boolean(isMain)
    });
  };

  addImage(
    summary?.mainImage?.link,
    summary?.mainImage?.width,
    summary?.mainImage?.height,
    true
  );

  for (const [key, entries] of Object.entries(attributes || {})) {
    if (!/image/i.test(key) || !Array.isArray(entries)) continue;

    for (const entry of entries) {
      addImage(
        entry?.media_location ||
          entry?.mediaLocation ||
          entry?.link ||
          entry?.url,
        entry?.width?.value || entry?.width,
        entry?.height?.value || entry?.height,
        /main_product_image/i.test(key)
      );
    }
  }

  images.sort((a, b) => Number(b.isMain) - Number(a.isMain));
  return images;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrZero(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function positiveNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0
    ? numeric
    : 0;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { registerAmazonAdsDecisionRoutes, normalizeOrdersSnapshot };
