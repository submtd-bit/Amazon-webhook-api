import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-27-amazon-nonbuyable-asin-offer-audit-v1.0.0";
const ROUTE = "/amazon/listing/nonbuyable-asin-offer-audit";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 1100;
const MARKETPLACE_ID = "A1VC38T7YXB528";
const MAX_ITEMS = 20;
const originalListen = express.application.listen;

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
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
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
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
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function amazonGet(url, accessToken) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
function normalizeItems(body) {
  const raw = Array.isArray(body?.items) ? body.items : [];
  if (!raw.length) throw new Error("items is required");
  if (raw.length > MAX_ITEMS) throw new Error(`max ${MAX_ITEMS} items`);
  const seen = new Set();
  return raw.map((item, index) => {
    const sku = String(item?.sku || "").trim();
    const asin = String(item?.asin || "").trim().toUpperCase();
    const conditions = Array.isArray(item?.conditions)
      ? [...new Set(item.conditions.map(x => String(x || "").trim()).filter(Boolean))]
      : [];
    if (!sku) throw new Error(`items[${index}].sku is required`);
    if (!/^B[0-9A-Z]{9}$/.test(asin)) throw new Error(`items[${index}].asin is invalid`);
    if (!conditions.length) throw new Error(`items[${index}].conditions is required`);
    const key = `${sku}\u0000${asin}`;
    if (seen.has(key)) throw new Error(`duplicate item ${sku}`);
    seen.add(key);
    return { sku, asin, conditions };
  });
}
function moneyAmount(obj) {
  return numberOrNull(obj?.Amount ?? obj?.amount);
}
function normalizeOffer(offer, ourSellerId) {
  const sellerId = String(offer?.SellerId || "");
  const listingPrice = moneyAmount(offer?.ListingPrice);
  const shipping = moneyAmount(offer?.Shipping) ?? 0;
  const points = numberOrNull(offer?.Points?.PointsNumber) ?? 0;
  const landedBeforePoints = listingPrice === null ? null : listingPrice + shipping;
  const effectiveAfterPoints = landedBeforePoints === null ? null : landedBeforePoints - points;
  return {
    sellerId,
    isOurSeller: sellerId === ourSellerId,
    listingPrice,
    shipping,
    points,
    landedBeforePoints,
    effectiveAfterPoints,
    subCondition: String(offer?.SubCondition || ""),
    isBuyBoxWinner: offer?.IsBuyBoxWinner === true,
    isFeaturedMerchant: offer?.IsFeaturedMerchant === true,
    isFulfilledByAmazon: offer?.IsFulfilledByAmazon === true,
    shippingTime: offer?.ShippingTime || null,
    primeInformation: offer?.PrimeInformation || null,
  };
}
async function getItemOffers(accessToken, asin, itemCondition) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    MarketplaceId: marketplaceId,
    ItemCondition: itemCondition,
    CustomerType: "Consumer",
  });
  const url = `${endpoint}/products/pricing/v0/items/${encodeURIComponent(asin)}/offers?${query}`;
  const json = await amazonGet(url, accessToken);
  const payload = json?.payload || json?.Payload || {};
  const offersRaw = Array.isArray(payload?.Offers) ? payload.Offers : [];
  const offers = offersRaw.map(row => normalizeOffer(row, sellerId));
  const ourOffers = offers.filter(row => row.isOurSeller);
  return {
    itemCondition,
    offerCount: offers.length,
    ourOfferCount: ourOffers.length,
    ourOfferPresent: ourOffers.length > 0,
    ourOffers,
    offers,
    summary: payload?.Summary || null,
  };
}
function classify(item, conditionResults) {
  const successful = conditionResults.filter(x => !x.apiError);
  const failed = conditionResults.filter(x => x.apiError);
  const anyOurOffer = successful.some(x => x.ourOfferPresent);
  const anyMarketOffer = successful.some(x => x.offerCount > 0);
  const allSuccessfulZero = successful.length > 0 && successful.every(x => x.offerCount === 0);
  let primaryDiagnostic = "ASIN_MARKET_HAS_OTHER_OFFERS_BUT_OURS_ABSENT";
  if (anyOurOffer) primaryDiagnostic = "OUR_SELLER_OFFER_VISIBLE_BY_ASIN";
  else if (allSuccessfulZero) primaryDiagnostic = "NO_MARKET_OFFERS_FOR_TESTED_CONDITIONS";
  else if (!anyMarketOffer && failed.length === conditionResults.length) primaryDiagnostic = "ASIN_OFFER_API_ERROR";
  return {
    sku: item.sku,
    asin: item.asin,
    conditions: item.conditions,
    anyOurOfferVisible: anyOurOffer,
    anyMarketOfferVisible: anyMarketOffer,
    apiErrorCount: failed.length,
    primaryDiagnostic,
    conditionResults,
  };
}
async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, readOnly: true, externalChanges: 0, error: "Unauthorized" });

    const items = normalizeItems(req.body || {});
    const accessToken = await getLwaAccessToken();
    const results = [];

    for (const item of items) {
      const conditionResults = [];
      for (let i = 0; i < item.conditions.length; i += 1) {
        if (i > 0) await sleep(REQUEST_GAP_MS);
        const condition = item.conditions[i];
        try {
          conditionResults.push(await getItemOffers(accessToken, item.asin, condition));
        } catch (err) {
          conditionResults.push({
            itemCondition: condition,
            apiError: err?.message || String(err),
            offerCount: 0,
            ourOfferCount: 0,
            ourOfferPresent: false,
            ourOffers: [],
            offers: [],
          });
        }
      }
      results.push(classify(item, conditionResults));
      await sleep(REQUEST_GAP_MS);
    }

    const diagnosticCounts = {};
    for (const row of results) {
      const key = String(row.primaryDiagnostic || "UNKNOWN");
      diagnosticCounts[key] = Number(diagnosticCounts[key] || 0) + 1;
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      requestedItemCount: items.length,
      diagnosticCounts,
      readOnly: true,
      externalChanges: 0,
      results,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonNonBuyableAsinOfferAuditListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
