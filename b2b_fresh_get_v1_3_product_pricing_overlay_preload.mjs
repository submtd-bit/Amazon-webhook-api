import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * Amazon B2B Fresh GET Product Pricing overlay v1.3.0
 * READ ONLY / externalChanges=0
 *
 * Imported AFTER b2b_fresh_get_v1_2_preload.mjs.
 * Keeps the v1.2 route and schema intact, then overlays only B2C actual-offer
 * authority fields from Product Pricing exact seller offers:
 *   - actualOfferB2CPrice
 *   - amazonPoints
 *   - effectiveAfterPoints (additive)
 *   - actualOfferSource (additive)
 *
 * Listings-derived values are retained in additive diagnostic fields.
 * B2B, inventory, listing status, min/max and fulfillment authorities are NOT changed.
 */

const MODULE_VERSION = "2026-09-01-b2b-fresh-get-product-pricing-overlay-v1.3.0";
const ROUTE = "/amazon/price/b2b/fresh-get";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const ITEM_CONDITION = "New";
const MAX_BATCH_ITEMS = 20;
const BATCH_GAP_MS = 11000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;
const originalListen = express.application.listen;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && value !== null) {
    if (value.Amount !== undefined) return numberOrNull(value.Amount);
    if (value.amount !== undefined) return numberOrNull(value.amount);
    if (value.value !== undefined) return numberOrNull(value.value);
    if (value.Value !== undefined) return numberOrNull(value.Value);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getSecret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== MARKETPLACE_ID) throw new Error(`marketplace mismatch: ${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}

async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing env: LWA_CLIENT_ID / LWA_CLIENT_SECRET / REFRESH_TOKEN");
  }

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) {
    throw new Error(`LWA token error: ${response.status}`);
  }
  return json.access_token;
}

async function amazonPost(path, body, accessToken) {
  const { endpoint } = getConfig();
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: {
          "x-amz-access-token": accessToken,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const json = safeJsonParse(text);
      if (response.ok) return json;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        throw new Error(`SP-API POST error: ${response.status} ${JSON.stringify(json)}`);
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter * 1000)
        : RETRY_BASE_MS * attempt;
      await sleep(waitMs);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("SP-API POST failed");
}

function normalizeRequestItems(req) {
  const raw = Array.isArray(req?.body?.items) ? req.body.items : [];
  return raw
    .map(item => ({
      sku: String(item?.sku || "").trim(),
      asin: String(item?.asin || "").trim().toUpperCase(),
    }))
    .filter(item => item.sku && /^B[0-9A-Z]{9}$/.test(item.asin));
}

function buildBatchBody(items) {
  const { marketplaceId } = getConfig();
  return {
    requests: items.map(item => ({
      uri: `/products/pricing/v0/items/${encodeURIComponent(item.asin)}/offers`,
      method: "GET",
      MarketplaceId: marketplaceId,
      ItemCondition: ITEM_CONDITION,
      CustomerType: "Consumer",
    })),
  };
}

function responseStatus(batchItem) {
  return typeof batchItem?.status === "number"
    ? batchItem.status
    : batchItem?.status?.statusCode
      ?? batchItem?.Status?.StatusCode
      ?? batchItem?.statusCode
      ?? null;
}

function moneyAmount(obj) {
  return numberOrNull(obj?.Amount ?? obj?.amount);
}

function pointsNumber(raw) {
  return numberOrNull(raw?.PointsNumber ?? raw?.pointsNumber ?? raw?.points_number) ?? 0;
}

function parseProductPricingResponse(item, batchItem) {
  const { sellerId } = getConfig();
  const status = responseStatus(batchItem);
  const body = batchItem?.body || batchItem?.Body || {};
  const payload = body?.payload || body?.Payload || body || {};
  const offers = Array.isArray(payload?.Offers)
    ? payload.Offers
    : (Array.isArray(payload?.offers) ? payload.offers : []);

  const ourOffers = offers
    .filter(offer => String(offer?.SellerId || offer?.sellerId || "") === sellerId)
    .map(offer => {
      const listingPrice = moneyAmount(offer?.ListingPrice || offer?.listingPrice);
      const shipping = moneyAmount(offer?.Shipping || offer?.shipping) ?? 0;
      const points = pointsNumber(offer?.Points || offer?.points);
      const landedBeforePoints = listingPrice === null ? null : listingPrice + shipping;
      const effectiveAfterPoints = landedBeforePoints === null
        ? null
        : Math.max(0, landedBeforePoints - points);
      return {
        listingPrice,
        shipping,
        points,
        landedBeforePoints,
        effectiveAfterPoints,
        isBuyBoxWinner: offer?.IsBuyBoxWinner === true || offer?.isBuyBoxWinner === true,
        isFulfilledByAmazon: offer?.IsFulfilledByAmazon === true || offer?.isFulfilledByAmazon === true,
        subCondition: String(offer?.SubCondition || offer?.subCondition || ""),
      };
    })
    .filter(offer => offer.listingPrice !== null);

  const selected = ourOffers.find(offer => offer.isBuyBoxWinner) || ourOffers[0] || null;

  return {
    sku: item.sku,
    asin: item.asin,
    httpStatus: status,
    ok: Number(status) >= 200 && Number(status) < 300 && Boolean(selected),
    ourOfferPresent: Boolean(selected),
    ourOfferCount: ourOffers.length,
    selected,
  };
}

async function fetchProductPricing(items) {
  const results = new Map();
  if (!items.length) return results;

  const accessToken = await getLwaAccessToken();
  const batches = [];
  for (let i = 0; i < items.length; i += MAX_BATCH_ITEMS) {
    batches.push(items.slice(i, i + MAX_BATCH_ITEMS));
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    if (batchIndex > 0) await sleep(BATCH_GAP_MS);
    const batch = batches[batchIndex];
    const json = await amazonPost(
      "/batches/products/pricing/v0/itemOffers",
      buildBatchBody(batch),
      accessToken,
    );
    const responses = json?.responses || json?.Responses || [];

    batch.forEach((item, index) => {
      const parsed = parseProductPricingResponse(item, responses[index] || {});
      results.set(`${item.sku}\u0000${item.asin}`, parsed);
    });
  }

  return results;
}

function overlayResponse(body, pricingMap) {
  if (!body || body.ok !== true || !Array.isArray(body.results)) return body;

  let overlaySucceeded = 0;
  let fallbackCount = 0;

  const results = body.results.map(row => {
    if (!row || row.ok !== true) return row;

    const sku = String(row.sku || "").trim();
    const asin = String(row.asin || "").trim().toUpperCase();
    const pricing = pricingMap.get(`${sku}\u0000${asin}`) || null;

    const listingsActualOfferB2CPrice = row.actualOfferB2CPrice ?? null;
    const listingsAmazonPoints = row.amazonPoints ?? null;

    if (pricing?.ok && pricing.selected) {
      overlaySucceeded += 1;
      return {
        ...row,
        listingsActualOfferB2CPrice,
        listingsAmazonPoints,
        actualOfferB2CPrice: pricing.selected.listingPrice,
        actualOfferB2CPriceSourcePresent: true,
        amazonPoints: pricing.selected.points,
        amazonPointsSourcePresent: true,
        actualOfferShipping: pricing.selected.shipping,
        landedBeforePoints: pricing.selected.landedBeforePoints,
        effectiveAfterPoints: pricing.selected.effectiveAfterPoints,
        actualOfferSource: "PRODUCT_PRICING_SELLER_OFFER",
        actualOfferAuthorityVerified: true,
        productPricingDiagnostic: {
          moduleVersion: MODULE_VERSION,
          httpStatus: pricing.httpStatus,
          ourOfferPresent: pricing.ourOfferPresent,
          ourOfferCount: pricing.ourOfferCount,
          isBuyBoxWinner: pricing.selected.isBuyBoxWinner,
          subCondition: pricing.selected.subCondition,
        },
      };
    }

    fallbackCount += 1;
    return {
      ...row,
      listingsActualOfferB2CPrice,
      listingsAmazonPoints,
      actualOfferSource: "LISTINGS_ITEMS_FALLBACK_PRODUCT_PRICING_UNAVAILABLE",
      actualOfferAuthorityVerified: false,
      productPricingDiagnostic: {
        moduleVersion: MODULE_VERSION,
        httpStatus: pricing?.httpStatus ?? null,
        ourOfferPresent: pricing?.ourOfferPresent ?? false,
        ourOfferCount: pricing?.ourOfferCount ?? 0,
      },
    };
  });

  return {
    ...body,
    moduleVersionBase: body.moduleVersion || "",
    moduleVersion: MODULE_VERSION,
    schemaCapabilities: {
      ...(body.schemaCapabilities || {}),
      productPricingB2COverlay: true,
      actualOfferSource: true,
      actualOfferAuthorityVerified: true,
      effectiveAfterPoints: true,
    },
    productPricingOverlay: {
      enabled: true,
      itemCondition: ITEM_CONDITION,
      requested: results.filter(row => row?.ok === true).length,
      succeeded: overlaySucceeded,
      fallbackCount,
      externalChanges: 0,
    },
    readOnly: true,
    externalChanges: 0,
    results,
  };
}

function installOverlay(app) {
  const routeLayer = app?._router?.stack?.find(layer => layer?.route?.path === ROUTE);
  if (!routeLayer?.route?.stack?.length) {
    throw new Error("B2B_FRESH_GET_V12_ROUTE_NOT_FOUND");
  }

  const handlerLayer = routeLayer.route.stack.find(layer => typeof layer?.handle === "function");
  if (!handlerLayer) throw new Error("B2B_FRESH_GET_V12_HANDLER_NOT_FOUND");
  if (handlerLayer.handle?.__productPricingOverlayV13 === true) return;

  const baseHandler = handlerLayer.handle;

  const wrapped = async function productPricingOverlayV13(req, res, next) {
    const secret = getSecret();
    const suppliedSecret = String(req.headers?.["x-api-secret"] || "");
    const requestItems = normalizeRequestItems(req);
    const authorized = Boolean(secret) && suppliedSecret === secret;

    const pricingPromise = authorized && requestItems.length
      ? fetchProductPricing(requestItems)
          .then(map => ({ ok: true, map }))
          .catch(error => ({ ok: false, error }))
      : Promise.resolve({ ok: false, error: null });

    const originalJson = res.json.bind(res);
    let captured = null;

    res.json = function captureJson(body) {
      captured = { statusCode: res.statusCode, body };
      return res;
    };

    try {
      const returned = baseHandler(req, res, next);
      if (returned && typeof returned.then === "function") await returned;
    } catch (error) {
      res.json = originalJson;
      throw error;
    }

    res.json = originalJson;
    if (!captured) return;

    let output = captured.body;
    if (captured.statusCode === 200 && output?.ok === true && Array.isArray(output?.results)) {
      const pricingResult = await pricingPromise;
      if (pricingResult.ok) {
        output = overlayResponse(output, pricingResult.map);
      } else {
        output = {
          ...output,
          moduleVersionBase: output.moduleVersion || "",
          moduleVersion: MODULE_VERSION,
          schemaCapabilities: {
            ...(output.schemaCapabilities || {}),
            productPricingB2COverlay: true,
            actualOfferSource: true,
            actualOfferAuthorityVerified: true,
            effectiveAfterPoints: true,
          },
          productPricingOverlay: {
            enabled: true,
            requested: requestItems.length,
            succeeded: 0,
            fallbackCount: Array.isArray(output.results) ? output.results.filter(row => row?.ok === true).length : 0,
            error: String(pricingResult.error?.message || pricingResult.error || "PRODUCT_PRICING_OVERLAY_FAILED").slice(0, 1000),
            externalChanges: 0,
          },
          results: Array.isArray(output.results)
            ? output.results.map(row => row?.ok === true
              ? {
                  ...row,
                  listingsActualOfferB2CPrice: row.actualOfferB2CPrice ?? null,
                  listingsAmazonPoints: row.amazonPoints ?? null,
                  actualOfferSource: "LISTINGS_ITEMS_FALLBACK_PRODUCT_PRICING_API_ERROR",
                  actualOfferAuthorityVerified: false,
                }
              : row)
            : output.results,
          readOnly: true,
          externalChanges: 0,
        };
      }
    }

    return res.status(captured.statusCode).json(output);
  };

  wrapped.__productPricingOverlayV13 = true;
  handlerLayer.handle = wrapped;
}

express.application.listen = function b2bFreshGetProductPricingOverlayV13Listen(...args) {
  const server = originalListen.apply(this, args);
  try {
    installOverlay(this);
    console.log("B2B fresh GET Product Pricing overlay installed", {
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      externalChanges: 0,
    });
  } catch (error) {
    console.error("B2B fresh GET Product Pricing overlay install failed", {
      moduleVersion: MODULE_VERSION,
      error: error?.message || String(error),
      externalChanges: 0,
    });
  }
  return server;
};
