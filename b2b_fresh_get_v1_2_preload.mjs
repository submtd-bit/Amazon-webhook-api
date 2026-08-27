import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * Amazon B2B / minimum-price Fresh GET schema extension v1.2.0
 * READ ONLY / externalChanges=0
 *
 * Additive override for the existing route:
 *   POST /amazon/price/b2b/fresh-get
 *
 * Deploy by importing this module AFTER ./b2b_fresh_get_preload.mjs.
 * The existing module remains in place for one-step rollback.
 *
 * Adds read-only schema needed by the full minimum-price audit:
 * - issueCodes / issueDetails
 * - consumer maximumSellerAllowed
 * - Listings Items current offers (B2C/B2B)
 * - Amazon points when present in the B2C offer
 * - explicit schemaCapabilities
 *
 * NO Listings PATCH / PUT / DELETE.
 * NO pricing mutation.
 */
const MODULE_VERSION = "2026-08-27-b2b-fresh-get-v1.2.0";
const ROUTE = "/amazon/price/b2b/fresh-get";
const MAX_ITEMS = 50;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;

const SCHEMA_CAPABILITIES = Object.freeze({
  saleScheduleState: true,
  saleStartAt: true,
  saleEndAt: true,
  maximumSellerAllowed: true,
  issueCodes: true,
  issueDetails: true,
  amazonPoints: true,
  actualOfferB2CPrice: true,
  actualOfferB2BPrice: true,
  currentOffers: true
});

const originalListen = express.application.listen;

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && value !== null) {
    if (value.amount !== undefined) return numberOrNull(value.amount);
    if (value.Amount !== undefined) return numberOrNull(value.Amount);
    if (value.value !== undefined) return numberOrNull(value.value);
    if (value.Value !== undefined) return numberOrNull(value.Value);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isoOrEmpty(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

function epochOrNull(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : null;
}

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function getSecret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
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

async function amazonGet(url, accessToken) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json",
        },
        signal: controller.signal,
      });

      const text = await response.text();
      const json = safeJsonParse(text);

      if (response.ok) return json;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        throw new Error(`SP-API request error: ${response.status} ${JSON.stringify(json)}`);
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

  throw lastError || new Error("SP-API GET failed");
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  return amazonGet(url, accessToken);
}

function getScheduleEntries(offer, key) {
  const schedules = offer?.[key]?.[0]?.schedule;
  return Array.isArray(schedules) ? schedules : [];
}

function scheduleIsActive(schedule, nowMs) {
  const startMs = epochOrNull(schedule?.start_at);
  const endMs = epochOrNull(schedule?.end_at);
  if (startMs !== null && nowMs < startMs) return false;
  if (endMs !== null && nowMs >= endMs) return false;
  return true;
}

function getActiveScheduleValue(offer, key, nowMs) {
  const active = getScheduleEntries(offer, key)
    .filter(schedule => scheduleIsActive(schedule, nowMs))
    .sort((a, b) => (epochOrNull(b?.start_at) ?? 0) - (epochOrNull(a?.start_at) ?? 0));
  return active[0] || null;
}

function getScheduleDiagnostics(offer, key, nowMs) {
  const schedules = getScheduleEntries(offer, key);
  let activeCount = 0;
  let expiredCount = 0;
  let futureCount = 0;

  schedules.forEach(schedule => {
    const startMs = epochOrNull(schedule?.start_at);
    const endMs = epochOrNull(schedule?.end_at);
    if (scheduleIsActive(schedule, nowMs)) activeCount += 1;
    else if (endMs !== null && nowMs >= endMs) expiredCount += 1;
    else if (startMs !== null && nowMs < startMs) futureCount += 1;
  });

  return {
    scheduleCount: schedules.length,
    activeCount,
    expiredCount,
    futureCount,
  };
}

function floorHundred(value) {
  if (!Number.isFinite(value)) return null;
  return Math.floor(value / 100) * 100;
}

function parseQuantityPlan(b2bOffer, b2bPrice, nowMs) {
  const schedule = getActiveScheduleValue(b2bOffer, "quantity_discount_plan", nowMs) || {};
  const discountType = String(schedule?.discount_type || "").toLowerCase();
  const levels = Array.isArray(schedule?.levels) ? schedule.levels : [];

  const parsed = levels
    .map(level => {
      const lowerBound = numberOrNull(level?.lower_bound);
      const value = numberOrNull(level?.value);
      if (lowerBound === null || value === null) return null;

      let effectiveRaw = null;
      if (b2bPrice !== null && discountType === "percent") {
        effectiveRaw = b2bPrice * (1 - value / 100);
      } else if (discountType === "fixed_price") {
        effectiveRaw = value;
      }

      return {
        lowerBound,
        value,
        effectivePriceRaw: effectiveRaw,
        effectivePriceFloor100: effectiveRaw === null ? null : floorHundred(effectiveRaw),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.lowerBound - b.lowerBound);

  return {
    discountType,
    levels: parsed,
  };
}

function issueDetails(issues) {
  return (Array.isArray(issues) ? issues : []).map(issue => ({
    code: String(issue?.code || ""),
    severity: String(issue?.severity || ""),
    message: String(issue?.message || "").slice(0, 1000),
    attributeNames: Array.isArray(issue?.attributeNames) ? issue.attributeNames.map(String) : [],
    categories: Array.isArray(issue?.categories) ? issue.categories.map(String) : [],
    marketplaceIds: Array.isArray(issue?.marketplaceIds) ? issue.marketplaceIds.map(String) : [],
  }));
}

function audienceValue(offer) {
  if (!offer) return "";
  if (typeof offer.audience === "string") return String(offer.audience).toUpperCase();
  return String(offer?.audience?.value || offer?.audience?.displayName || "").toUpperCase();
}

function offerType(offer) {
  return String(offer?.offerType || offer?.offer_type || "").toUpperCase();
}

function offerPrice(offer) {
  if (!offer || !hasOwn(offer, "price")) return null;
  return numberOrNull(offer.price);
}

function parsePointsValue(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "object") return numberOrNull(raw);

  const candidates = [
    raw.pointsNumber,
    raw.PointsNumber,
    raw.points_number,
    raw.amount,
    raw.Amount,
    raw.value,
    raw.Value,
  ];

  for (const value of candidates) {
    const parsed = numberOrNull(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function summarizeCurrentOffers(listing) {
  const { marketplaceId } = getConfig();
  const offers = Array.isArray(listing?.offers) ? listing.offers : [];
  const marketOffers = offers.filter(offer => {
    const id = String(offer?.marketplaceId || offer?.marketplace_id || "");
    return !id || id === marketplaceId;
  });

  const b2c = marketOffers.find(offer =>
    offerType(offer) === "B2C" || audienceValue(offer) === "ALL"
  ) || null;

  const b2b = marketOffers.find(offer =>
    offerType(offer) === "B2B" || audienceValue(offer) === "B2B"
  ) || null;

  const b2cPrice = offerPrice(b2c);
  const b2bPrice = offerPrice(b2b);
  const b2cPointsRaw = b2c && hasOwn(b2c, "points") ? b2c.points : null;

  return {
    b2c: {
      sourcePresent: Boolean(b2c),
      priceSourcePresent: Boolean(b2c && hasOwn(b2c, "price")),
      price: b2cPrice,
      pointsSourcePresent: Boolean(b2c && hasOwn(b2c, "points")),
      points: parsePointsValue(b2cPointsRaw),
      offerType: offerType(b2c),
      audience: audienceValue(b2c),
    },
    b2b: {
      sourcePresent: Boolean(b2b),
      priceSourcePresent: Boolean(b2b && hasOwn(b2b, "price")),
      price: b2bPrice,
      offerType: offerType(b2b),
      audience: audienceValue(b2b),
    },
    summaries: marketOffers.map(offer => ({
      marketplaceId: String(offer?.marketplaceId || offer?.marketplace_id || ""),
      offerType: offerType(offer),
      audience: audienceValue(offer),
      price: offerPrice(offer),
      pointsSourcePresent: hasOwn(offer, "points"),
      points: hasOwn(offer, "points") ? parsePointsValue(offer.points) : null,
    })),
  };
}

function analyzeListing(listing, nowMs = Date.now()) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const availability = Array.isArray(listing?.fulfillmentAvailability)
    ? listing.fulfillmentAvailability[0] || {}
    : {};
  const offers = Array.isArray(attributes?.purchasable_offer)
    ? attributes.purchasable_offer
    : [];

  const consumer = offers.find(row => String(row?.audience || "ALL").toUpperCase() === "ALL") || null;
  const b2b = offers.find(row => String(row?.audience || "").toUpperCase() === "B2B") || null;

  const normalSchedule = getActiveScheduleValue(consumer, "our_price", nowMs);
  const saleSchedule = getActiveScheduleValue(consumer, "discounted_price", nowMs);
  const minSchedule = getActiveScheduleValue(consumer, "minimum_seller_allowed_price", nowMs);
  const maxSchedule = getActiveScheduleValue(consumer, "maximum_seller_allowed_price", nowMs);
  const b2bSchedule = getActiveScheduleValue(b2b, "our_price", nowMs);
  const b2bPrice = numberOrNull(b2bSchedule?.value_with_tax);
  const saleDiagnostics = getScheduleDiagnostics(consumer, "discounted_price", nowMs);
  const currentOffers = summarizeCurrentOffers(listing);
  const details = issueDetails(issues);

  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses: Array.isArray(summary?.status) ? summary.status.map(String) : [],
    buyable: Array.isArray(summary?.status) && summary.status.map(String).includes("BUYABLE"),
    errorCount: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR").length,
    issueCodesSourcePresent: Array.isArray(listing?.issues),
    issueCodes: [...new Set(details.map(row => row.code).filter(Boolean))],
    issueDetails: details,
    availableQuantity: numberOrNull(availability?.quantity)
      ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity)
      ?? 0,
    consumerPrice: {
      normal: numberOrNull(normalSchedule?.value_with_tax),
      sale: numberOrNull(saleSchedule?.value_with_tax),
      minimumSellerAllowed: numberOrNull(minSchedule?.value_with_tax),
      maximumSellerAllowed: numberOrNull(maxSchedule?.value_with_tax),
      maximumSellerAllowedSourcePresent:
        getScheduleEntries(consumer, "maximum_seller_allowed_price").length > 0,
      saleStartAt: saleSchedule ? isoOrEmpty(saleSchedule?.start_at) : "",
      saleEndAt: saleSchedule ? isoOrEmpty(saleSchedule?.end_at) : "",
      saleScheduleState: saleSchedule
        ? "ACTIVE"
        : (saleDiagnostics.expiredCount > 0
          ? "EXPIRED"
          : (saleDiagnostics.futureCount > 0 ? "FUTURE" : "NONE")),
      saleScheduleCount: saleDiagnostics.scheduleCount,
      saleExpiredScheduleCount: saleDiagnostics.expiredCount,
      saleFutureScheduleCount: saleDiagnostics.futureCount,
    },
    b2bOfferPresent: Boolean(b2b),
    b2bPrice,
    quantityPlan: parseQuantityPlan(b2b, b2bPrice, nowMs),

    // Listings Items includedData=offers diagnostics.
    actualOfferB2CPrice: currentOffers.b2c.price,
    actualOfferB2CPriceSourcePresent: currentOffers.b2c.priceSourcePresent,
    actualOfferB2BPrice: currentOffers.b2b.price,
    actualOfferB2BPriceSourcePresent: currentOffers.b2b.priceSourcePresent,
    amazonPoints: currentOffers.b2c.points,
    amazonPointsSourcePresent: currentOffers.b2c.pointsSourcePresent,
    currentOfferSummaries: currentOffers.summaries,
  };
}

function normalizeItems(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw new Error("items must be a non-empty array");
  if (items.length > MAX_ITEMS) throw new Error(`items must be <= ${MAX_ITEMS}`);

  const seen = new Set();
  return items.map((item, index) => {
    const sku = String(item?.sku || "").trim();
    const asin = String(item?.asin || "").trim();
    if (!sku) throw new Error(`items[${index}].sku is required`);
    if (!asin) throw new Error(`items[${index}].asin is required`);
    const key = `${sku}\u0000${asin}`;
    if (seen.has(key)) throw new Error(`duplicate item: ${sku} / ${asin}`);
    seen.add(key);
    return { sku, asin };
  });
}

async function handler(req, res) {
  const fetchedAt = new Date().toISOString();
  const nowMs = Date.parse(fetchedAt);

  try {
    const secret = getSecret();
    if (!secret) {
      return res.status(500).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        externalChanges: 0,
        error: "AMAZON_STOCK_API_SECRET is not set",
      });
    }

    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        externalChanges: 0,
        error: "Unauthorized",
      });
    }

    const items = normalizeItems(req.body);
    const accessToken = await getLwaAccessToken();
    const results = [];

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      try {
        const state = analyzeListing(await getListing(accessToken, item.sku), nowMs);

        if (state.asin !== item.asin) {
          results.push({
            ok: false,
            sku: item.sku,
            expectedAsin: item.asin,
            actualAsin: state.asin,
            error: `ASIN mismatch: expected=${item.asin} actual=${state.asin || "(empty)"}`,
          });
        } else {
          results.push({
            ok: true,
            sku: item.sku,
            asin: item.asin,
            fetchedAt,
            ...state,
          });
        }
      } catch (err) {
        results.push({
          ok: false,
          sku: item.sku,
          expectedAsin: item.asin,
          error: err?.message || String(err),
        });
      }

      if (i < items.length - 1) await sleep(250);
    }

    const okCount = results.filter(row => row.ok).length;
    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      fetchedAt,
      requested: items.length,
      succeeded: okCount,
      failed: items.length - okCount,
      schemaCapabilities: SCHEMA_CAPABILITIES,
      externalChanges: 0,
      results,
    });
  } catch (err) {
    console.error("B2B fresh GET v1.2 error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      fetchedAt,
      schemaCapabilities: SCHEMA_CAPABILITIES,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

/**
 * Additive route override:
 * Import AFTER the existing b2b_fresh_get_preload.mjs.
 * This wrapper registers v1.2 first at app.listen time. The old wrapper then
 * sees ROUTE already registered and safely skips its own handler.
 */
express.application.listen = function b2bFreshGetV12Listen(...args) {
  const alreadyRegistered = Boolean(
    this?._router?.stack?.some(layer => layer?.route?.path === ROUTE)
  );
  if (!alreadyRegistered) {
    this.post(ROUTE, handler);
  }
  return originalListen.apply(this, args);
};
