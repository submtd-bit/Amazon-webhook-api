import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-24-amazon-competitor-price-v1.0.0";
const ROUTE = "/amazon/competitor/price/fresh-get";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const MAX_ITEMS = 20;
const REQUEST_TIMEOUT_MS = 20000;
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

function getSecret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

function getConfig() {
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  return { marketplaceId, endpoint };
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
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}

async function amazonGet(url, accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "x-amz-access-token": accessToken, accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    const json = safeJsonParse(text);
    if (!response.ok) throw new Error(`SP-API request error: ${response.status} ${JSON.stringify(json)}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeItems(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw new Error("items must be a non-empty array");
  if (items.length > MAX_ITEMS) throw new Error(`items must be <= ${MAX_ITEMS}`);
  const seen = new Set();
  return items.map((item, index) => {
    const asin = String(item?.asin || "").trim().toUpperCase();
    const condition = String(item?.condition || "Refurbished").trim();
    const customerType = String(item?.customerType || "Consumer").trim();
    if (!/^B[0-9A-Z]{9}$/.test(asin)) throw new Error(`items[${index}].asin is invalid`);
    const key = `${asin}\u0000${condition}\u0000${customerType}`;
    if (seen.has(key)) throw new Error(`duplicate item: ${asin}`);
    seen.add(key);
    return { asin, condition, customerType };
  });
}

function moneyAmount(money) {
  return numberOrNull(money?.Amount ?? money?.amount);
}

function landed(offer) {
  const listing = moneyAmount(offer?.ListingPrice);
  const shipping = moneyAmount(offer?.Shipping) || 0;
  return listing === null ? null : listing + shipping;
}

function normalizeOffer(offer) {
  const listingPrice = moneyAmount(offer?.ListingPrice);
  const shipping = moneyAmount(offer?.Shipping) || 0;
  const landedPrice = listingPrice === null ? null : listingPrice + shipping;
  return {
    listingPrice,
    shipping,
    landedPrice,
    currency: String(offer?.ListingPrice?.CurrencyCode || offer?.Shipping?.CurrencyCode || ""),
    isBuyBoxWinner: offer?.IsBuyBoxWinner === true,
    isFulfilledByAmazon: offer?.IsFulfilledByAmazon === true,
    subCondition: String(offer?.SubCondition || ""),
    sellerPositiveFeedbackRating: numberOrNull(offer?.SellerFeedbackRating?.SellerPositiveFeedbackRating),
    feedbackCount: numberOrNull(offer?.SellerFeedbackRating?.FeedbackCount),
    points: numberOrNull(offer?.Points?.PointsNumber),
  };
}

function analyzePayload(payload) {
  const offersRaw = Array.isArray(payload?.Offers) ? payload.Offers : [];
  const offers = offersRaw.map(normalizeOffer).filter(row => row.listingPrice !== null);
  const byListing = offers.slice().sort((a, b) => a.listingPrice - b.listingPrice || a.landedPrice - b.landedPrice);
  const byLanded = offers.slice().sort((a, b) => a.landedPrice - b.landedPrice || a.listingPrice - b.listingPrice);
  const buyBox = offers.filter(row => row.isBuyBoxWinner).sort((a, b) => a.landedPrice - b.landedPrice)[0] || null;
  return {
    offerCount: offers.length,
    lowestListingPrice: byListing.length ? byListing[0].listingPrice : null,
    lowestLandedPrice: byLanded.length ? byLanded[0].landedPrice : null,
    featuredOfferListingPrice: buyBox ? buyBox.listingPrice : null,
    featuredOfferLandedPrice: buyBox ? buyBox.landedPrice : null,
    featuredOfferIsFba: buyBox ? buyBox.isFulfilledByAmazon : null,
    offers: byLanded.slice(0, 20),
    summary: payload?.Summary || null,
  };
}

async function getItemOffers(accessToken, item) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    MarketplaceId: marketplaceId,
    ItemCondition: item.condition,
    CustomerType: item.customerType,
  });
  const url = `${endpoint}/products/pricing/v0/items/${encodeURIComponent(item.asin)}/offers?${query}`;
  const json = await amazonGet(url, accessToken);
  return analyzePayload(json?.payload || json?.Payload || {});
}

async function handler(req, res) {
  const fetchedAt = new Date().toISOString();
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, error: "AMAZON_STOCK_API_SECRET is not set", externalChanges: 0 });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, error: "Unauthorized", externalChanges: 0 });
    }

    const items = normalizeItems(req.body || {});
    const accessToken = await getLwaAccessToken();
    const results = [];
    for (const item of items) {
      try {
        const pricing = await getItemOffers(accessToken, item);
        results.push({ ok: true, asin: item.asin, condition: item.condition, customerType: item.customerType, fetchedAt, ...pricing });
      } catch (err) {
        results.push({ ok: false, asin: item.asin, condition: item.condition, customerType: item.customerType, fetchedAt, error: err?.message || String(err) });
      }
    }

    const succeeded = results.filter(row => row.ok).length;
    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      fetchedAt,
      requested: items.length,
      succeeded,
      failed: items.length - succeeded,
      externalChanges: 0,
      results,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      fetchedAt,
      error: err?.message || String(err),
      externalChanges: 0,
    });
  }
}

express.application.listen = function amazonCompetitorPriceListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
