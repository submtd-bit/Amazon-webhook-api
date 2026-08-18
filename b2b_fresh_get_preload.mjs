import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-18-b2b-fresh-get-v1.0.0";
const ROUTE = "/amazon/price/b2b/fresh-get";
const MAX_ITEMS = 50;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
const originalListen = express.application.listen;

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    includedData: "summaries,attributes,issues,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  return amazonGet(url, accessToken);
}

function getScheduleValue(offer, key) {
  return offer?.[key]?.[0]?.schedule?.[0] || {};
}

function floorHundred(value) {
  if (!Number.isFinite(value)) return null;
  return Math.floor(value / 100) * 100;
}

function parseQuantityPlan(b2bOffer, b2bPrice) {
  const schedule = b2bOffer?.quantity_discount_plan?.[0]?.schedule?.[0] || {};
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

function analyzeListing(listing) {
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

  const normalSchedule = getScheduleValue(consumer, "our_price");
  const saleSchedule = getScheduleValue(consumer, "discounted_price");
  const minSchedule = getScheduleValue(consumer, "minimum_seller_allowed_price");
  const b2bSchedule = getScheduleValue(b2b, "our_price");
  const b2bPrice = numberOrNull(b2bSchedule?.value_with_tax);

  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses: Array.isArray(summary?.status) ? summary.status.map(String) : [],
    buyable: Array.isArray(summary?.status) && summary.status.map(String).includes("BUYABLE"),
    errorCount: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: numberOrNull(availability?.quantity)
      ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity)
      ?? 0,
    consumerPrice: {
      normal: numberOrNull(normalSchedule?.value_with_tax),
      sale: numberOrNull(saleSchedule?.value_with_tax),
      minimumSellerAllowed: numberOrNull(minSchedule?.value_with_tax),
    },
    b2bOfferPresent: Boolean(b2b),
    b2bPrice,
    quantityPlan: parseQuantityPlan(b2b, b2bPrice),
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
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const items = normalizeItems(req.body);
    const accessToken = await getLwaAccessToken();
    const results = [];

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      try {
        const state = analyzeListing(await getListing(accessToken, item.sku));
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

      // Keep the read path conservative and avoid burst traffic.
      if (i < items.length - 1) await sleep(250);
    }

    const okCount = results.filter(row => row.ok).length;
    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      fetchedAt,
      requested: items.length,
      succeeded: okCount,
      failed: items.length - okCount,
      externalChanges: 0,
      results,
    });
  } catch (err) {
    console.error("B2B fresh GET error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      fetchedAt,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function b2bFreshGetListen(...args) {
  const alreadyRegistered = Boolean(
    this?._router?.stack?.some(layer => layer?.route?.path === ROUTE)
  );
  if (!alreadyRegistered) {
    this.post(ROUTE, handler);
  }
  return originalListen.apply(this, args);
};
