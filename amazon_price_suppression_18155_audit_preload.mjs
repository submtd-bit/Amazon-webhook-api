import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-price-suppression-18155-audit-v1.0.0";
const ROUTE = "/amazon/listing/price-suppression-18155-audit";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const TARGETS = Object.freeze({
  "0U-3IJD-CZ48": { asin: "B0FMYF5C2Y" },
  "KL-GLTE-GU7A": { asin: "B0D4LDW2TF" },
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
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
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error ${sku}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function firstScheduleValue(node) {
  if (!Array.isArray(node) || !node.length) return null;
  const schedule = node[0]?.schedule;
  if (!Array.isArray(schedule) || !schedule.length) return null;
  const raw = schedule[0]?.value_with_tax;
  if (raw === null || raw === undefined || raw === "") return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : raw;
}

function firstScheduleWindow(node) {
  if (!Array.isArray(node) || !node.length) return null;
  const schedule = node[0]?.schedule;
  if (!Array.isArray(schedule) || !schedule.length) return null;
  const row = schedule[0] || {};
  return {
    valueWithTax: row.value_with_tax ?? null,
    startAt: row.start_at || null,
    endAt: row.end_at || null,
  };
}

function pricingRuleId(offer) {
  const plans = offer?.automated_pricing_merchandising_rule_plan;
  if (!Array.isArray(plans) || !plans.length) return "";
  return String(plans[0]?.merchandising_rule?.rule_id || "");
}

function summarizePurchasableOffer(attributes) {
  const rows = Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [];
  return rows.map((offer, index) => {
    const ourPrice = firstScheduleValue(offer?.our_price);
    const discountedPrice = firstScheduleValue(offer?.discounted_price);
    const minimum = firstScheduleValue(offer?.minimum_seller_allowed_price);
    const maximum = firstScheduleValue(offer?.maximum_seller_allowed_price);
    const listPrice = firstScheduleValue(offer?.list_price);
    const mapPrice = firstScheduleValue(offer?.map_price);
    const effectivePrice = discountedPrice !== null ? discountedPrice : ourPrice;
    const conflicts = [];

    if (typeof effectivePrice === "number" && typeof minimum === "number" && effectivePrice < minimum) {
      conflicts.push("EFFECTIVE_PRICE_BELOW_MINIMUM_SELLER_ALLOWED_PRICE");
    }
    if (typeof effectivePrice === "number" && typeof maximum === "number" && effectivePrice > maximum) {
      conflicts.push("EFFECTIVE_PRICE_ABOVE_MAXIMUM_SELLER_ALLOWED_PRICE");
    }
    if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
      conflicts.push("MINIMUM_ABOVE_MAXIMUM");
    }

    return {
      index,
      audience: String(offer?.audience || ""),
      currency: String(offer?.currency || ""),
      marketplaceId: String(offer?.marketplace_id || ""),
      ourPrice,
      discountedPrice,
      discountedPriceWindow: firstScheduleWindow(offer?.discounted_price),
      effectivePrice,
      minimumSellerAllowedPrice: minimum,
      maximumSellerAllowedPrice: maximum,
      listPrice,
      mapPrice,
      automatedPricingRuleId: pricingRuleId(offer),
      startAt: offer?.start_at?.value || null,
      endAt: offer?.end_at?.value || null,
      conflicts,
      raw: offer,
    };
  });
}

function summarizeOfferRows(offers) {
  if (!Array.isArray(offers)) return [];
  return offers.map((offer, index) => ({
    index,
    marketplaceId: String(offer?.marketplaceId || offer?.marketplace_id || ""),
    offerType: String(offer?.offerType || offer?.offer_type || ""),
    price: offer?.price ?? null,
    points: offer?.points ?? null,
    raw: offer,
  }));
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    const requestedSkus = Array.isArray(req.body?.skus) ? req.body.skus.map(x => String(x || "").trim()).filter(Boolean) : [];
    const skus = requestedSkus.length ? requestedSkus : Object.keys(TARGETS);
    if (skus.length !== 2 || new Set(skus).size !== 2) {
      throw new Error("GUARD_BLOCKED: exactly the two approved 18155 SKUs are required");
    }
    for (const sku of skus) {
      if (!TARGETS[sku]) throw new Error(`GUARD_BLOCKED: unexpected SKU ${sku}`);
    }

    const accessToken = await getLwaAccessToken();
    const results = [];

    for (const sku of skus) {
      const listing = await getListing(accessToken, sku);
      const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
      const actualAsin = String(summary?.asin || "");
      if (actualAsin !== TARGETS[sku].asin) {
        throw new Error(`GUARD_BLOCKED ${sku}: ASIN mismatch ${actualAsin}`);
      }

      const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
      const issues = Array.isArray(listing?.issues) ? listing.issues : [];
      const issue18155 = issues.filter(issue => String(issue?.code || "") === "18155");
      const errorIssues = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
      const purchasableOfferSummary = summarizePurchasableOffer(attributes);
      const allOffer = purchasableOfferSummary.find(x => x.audience === "ALL") || null;
      const b2bOffer = purchasableOfferSummary.find(x => x.audience === "B2B") || null;

      results.push({
        sku,
        asin: actualAsin,
        title: String(summary?.itemName || ""),
        productType: String(summary?.productType || ""),
        status: Array.isArray(summary?.status) ? summary.status : [],
        lastUpdatedDate: summary?.lastUpdatedDate || listing?.lastUpdatedDate || "",
        issue18155,
        issue18155Count: issue18155.length,
        errorCount: errorIssues.length,
        allIssues: issues,
        purchasableOfferSummary,
        allAudienceOffer: allOffer,
        b2bAudienceOffer: b2bOffer,
        rawPurchasableOffer: Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [],
        topLevelListPrice: Array.isArray(attributes?.list_price) ? attributes.list_price : [],
        conditionType: Array.isArray(attributes?.condition_type) ? attributes.condition_type : [],
        merchantShippingGroup: Array.isArray(attributes?.merchant_shipping_group) ? attributes.merchant_shipping_group : [],
        offers: summarizeOfferRows(listing?.offers),
        rawOffers: Array.isArray(listing?.offers) ? listing.offers : [],
        fulfillmentAvailability: Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [],
      });
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      externalChanges: 0,
      targetCount: results.length,
      issue18155SkuCount: results.filter(x => x.issue18155Count > 0).length,
      results,
    });
  } catch (err) {
    console.error("Amazon price suppression 18155 audit error", err?.message || String(err));
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

express.application.listen = function amazonPriceSuppression18155AuditListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
