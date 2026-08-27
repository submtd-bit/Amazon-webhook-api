import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-27-amazon-nonbuyable-market-offer-audit-v1.0.0";
const ROUTE = "/amazon/listing/nonbuyable-market-offer-audit";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 1100;
const MAX_SKUS = 20;
const MARKETPLACE_ID = "A1VC38T7YXB528";
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
function summaryOf(listing) {
  return Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
}
function statusesOf(listing) {
  const status = summaryOf(listing)?.status;
  return Array.isArray(status) ? status.map(x => String(x || "").trim()).filter(Boolean) : [];
}
function conditionTypeOf(listing) {
  return String(listing?.attributes?.condition_type?.[0]?.value || "").trim();
}
function queryConditionsFor(conditionType) {
  if (/^used_/i.test(conditionType)) return ["Used"];
  if (/refurbished/i.test(conditionType)) return ["Refurbished"];
  if (conditionType === "new_new") return ["New", "Refurbished"];
  return ["New", "Refurbished", "Used"];
}
function allAudienceOffer(listing) {
  const rows = Array.isArray(listing?.attributes?.purchasable_offer) ? listing.attributes.purchasable_offer : [];
  return rows.find(row => String(row?.audience || "").toUpperCase() === "ALL") || null;
}
function parseIsoOrNull(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? { text, ms } : null;
}
function detectOfferTimeSignals(listing, nowMs) {
  const offer = allAudienceOffer(listing);
  const startAt = parseIsoOrNull(offer?.start_at?.value);
  const endAt = parseIsoOrNull(offer?.end_at?.value);
  const discountedRows = Array.isArray(offer?.discounted_price) ? offer.discounted_price : [];
  const saleSchedules = discountedRows.flatMap(row => Array.isArray(row?.schedule) ? row.schedule : []);
  const expiredDiscountedSchedules = saleSchedules.filter(row => {
    const end = parseIsoOrNull(row?.end_at);
    return end && end.ms < nowMs;
  });
  return {
    startAt: startAt?.text || null,
    endAt: endAt?.text || null,
    offerStarted: !startAt || startAt.ms <= nowMs,
    offerEnded: Boolean(endAt && endAt.ms < nowMs),
    expiredDiscountedScheduleCount: expiredDiscountedSchedules.length,
    expiredDiscountedSchedules,
  };
}
function moneyAmount(obj) {
  return numberOrNull(obj?.Amount ?? obj?.amount);
}
function normalizeMarketOffer(offer, sellerId) {
  const listingPrice = moneyAmount(offer?.ListingPrice);
  const shipping = moneyAmount(offer?.Shipping) ?? 0;
  const points = numberOrNull(offer?.Points?.PointsNumber) ?? 0;
  const landedBeforePoints = listingPrice === null ? null : listingPrice + shipping;
  const effectiveAfterPoints = landedBeforePoints === null ? null : landedBeforePoints - points;
  return {
    sellerId: String(offer?.SellerId || ""),
    isOurSeller: String(offer?.SellerId || "") === sellerId,
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
    shipsFrom: offer?.ShipsFrom || null,
  };
}
async function getListingOffers(accessToken, sku, itemCondition) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    MarketplaceId: marketplaceId,
    ItemCondition: itemCondition,
    CustomerType: "Consumer",
  });
  const url = `${endpoint}/products/pricing/v0/listings/${encodeURIComponent(sku)}/offers?${query}`;
  const json = await amazonGet(url, accessToken);
  const payload = json?.payload || json?.Payload || {};
  const offersRaw = Array.isArray(payload?.Offers) ? payload.Offers : [];
  const offers = offersRaw.map(row => normalizeMarketOffer(row, sellerId));
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
function listingSnapshot(listing) {
  const summary = summaryOf(listing);
  const offers = Array.isArray(listing?.offers) ? listing.offers : [];
  const b2c = offers.find(x => String(x?.offerType || "").toUpperCase() === "B2C") || null;
  const availability = Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [];
  const qty = availability.reduce((sum, row) => {
    const n = numberOrNull(row?.quantity);
    return sum + (n === null ? 0 : Math.max(0, n));
  }, 0);
  return {
    sku: String(listing?.sku || ""),
    asin: String(summary?.asin || ""),
    title: String(summary?.itemName || ""),
    productType: String(summary?.productType || ""),
    status: statusesOf(listing),
    conditionType: conditionTypeOf(listing),
    b2cPrice: numberOrNull(b2c?.price?.amount),
    b2cPoints: numberOrNull(b2c?.points?.pointsNumber),
    availableQuantity: qty,
    issueCount: Array.isArray(listing?.issues) ? listing.issues.length : 0,
    merchantShippingGroup: listing?.attributes?.merchant_shipping_group || [],
  };
}
function deriveDiagnostic(listing, marketResults, nowMs) {
  const snap = listingSnapshot(listing);
  const time = detectOfferTimeSignals(listing, nowMs);
  const anyOurOffer = marketResults.some(row => row.ourOfferPresent);
  const anyOffers = marketResults.some(row => row.offerCount > 0);
  const signals = [];
  if (time.offerEnded) signals.push("PURCHASABLE_OFFER_END_AT_EXPIRED");
  if (time.expiredDiscountedScheduleCount > 0) signals.push("EXPIRED_DISCOUNTED_PRICE_PRESENT");
  if (!anyOurOffer) signals.push("OUR_SELLER_OFFER_NOT_VISIBLE_IN_PRODUCT_PRICING");
  if (!anyOffers) signals.push("NO_COMPETITIVE_OFFERS_RETURNED_FOR_TESTED_CONDITIONS");
  if (snap.status.includes("BUYABLE")) signals.push("LISTING_RECOVERED_TO_BUYABLE");

  let primaryDiagnostic = "MARKET_OFFER_PRESENT_BUT_LISTINGS_NOT_BUYABLE";
  if (snap.status.includes("BUYABLE")) primaryDiagnostic = "RECOVERED_TO_BUYABLE";
  else if (time.offerEnded) primaryDiagnostic = "EXPIRED_PURCHASABLE_OFFER_END_AT";
  else if (!anyOurOffer) primaryDiagnostic = "OUR_SELLER_OFFER_ABSENT_FROM_PRODUCT_PRICING";

  return {
    primaryDiagnostic,
    diagnosticSignals: signals,
    timeSignals: time,
    anyOurOfferVisible: anyOurOffer,
  };
}
async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, readOnly: true, externalChanges: 0, error: "Unauthorized" });

    const skus = [...new Set((Array.isArray(req.body?.skus) ? req.body.skus : []).map(x => String(x || "").trim()).filter(Boolean))];
    if (!skus.length) throw new Error("skus is required");
    if (skus.length > MAX_SKUS) throw new Error(`max ${MAX_SKUS} skus`);

    const accessToken = await getLwaAccessToken();
    const nowMs = Date.now();
    const results = [];

    for (const sku of skus) {
      try {
        const listing = await getListing(accessToken, sku);
        const snap = listingSnapshot(listing);
        const queryConditions = queryConditionsFor(snap.conditionType);
        const marketResults = [];
        for (let i = 0; i < queryConditions.length; i += 1) {
          if (i > 0) await sleep(REQUEST_GAP_MS);
          try {
            marketResults.push(await getListingOffers(accessToken, sku, queryConditions[i]));
          } catch (err) {
            marketResults.push({ itemCondition: queryConditions[i], apiError: err?.message || String(err), offerCount: 0, ourOfferCount: 0, ourOfferPresent: false, ourOffers: [], offers: [] });
          }
        }
        const diagnostic = deriveDiagnostic(listing, marketResults, nowMs);
        results.push({
          ok: true,
          ...snap,
          queryConditions,
          marketResults,
          ...diagnostic,
        });
      } catch (err) {
        results.push({ ok: false, sku, error: err?.message || String(err), primaryDiagnostic: "AUDIT_ERROR", diagnosticSignals: ["AUDIT_ERROR"] });
      }
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
      requestedSkuCount: skus.length,
      succeeded: results.filter(x => x.ok).length,
      failed: results.filter(x => !x.ok).length,
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

express.application.listen = function amazonNonBuyableMarketOfferAuditListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
