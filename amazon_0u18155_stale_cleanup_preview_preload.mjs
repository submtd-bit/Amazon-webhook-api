import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-0u18155-stale-cleanup-preview-v1.0.0";
const ROUTE = "/amazon/listing/0u18155-stale-cleanup-preview";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "0U-3IJD-CZ48",
  asin: "B0FMYF5C2Y",
  productType: "NOTEBOOK_COMPUTER",
  issueCode: "18155",
  ourPrice: 32000,
  expiredSalePrice: 53000,
  expiredSaleStart: "2025-10-26T15:00:00.000Z",
  expiredSaleEnd: "2025-11-29T15:00:00.000Z",
  minPrice: 32000,
  maxPrice: 58000,
  b2bPrice: 55100,
  quantityDiscountType: "percent",
  quantityTiers: [
    { lowerBound: 5, value: 5 },
    { lowerBound: 10, value: 7 },
  ],
});

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

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function firstSchedule(node) {
  if (!Array.isArray(node) || node.length !== 1) return null;
  const schedule = node[0]?.schedule;
  if (!Array.isArray(schedule) || schedule.length !== 1) return null;
  return schedule[0] || null;
}

function parseQuantityPlan(offer) {
  const schedule = offer?.quantity_discount_plan?.[0]?.schedule?.[0] || {};
  const tiers = Array.isArray(schedule?.levels)
    ? schedule.levels.map(x => ({
        lowerBound: numberOrNull(x?.lower_bound),
        value: numberOrNull(x?.value),
      }))
    : [];
  return {
    discountType: String(schedule?.discount_type || "").toLowerCase(),
    tiers,
  };
}

function plansEqual(a, b) {
  if (a.discountType !== b.discountType || a.tiers.length !== b.tiers.length) return false;
  return a.tiers.every((x, i) => x.lowerBound === b.tiers[i].lowerBound && x.value === b.tiers[i].value);
}

function assertCurrentState(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const asin = String(summary?.asin || "");
  const productType = String(summary?.productType || "");
  if (asin !== GUARD.asin) throw new Error(`GUARD_BLOCKED: ASIN mismatch ${asin}`);
  if (productType !== GUARD.productType) throw new Error(`GUARD_BLOCKED: productType mismatch ${productType}`);

  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const issue18155 = issues.filter(issue => String(issue?.code || "") === GUARD.issueCode && String(issue?.severity || "").toUpperCase() === "ERROR");
  if (issue18155.length !== 1) throw new Error(`GUARD_BLOCKED: expected exactly one ERROR 18155, found ${issue18155.length}`);

  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const offers = Array.isArray(attributes.purchasable_offer) ? JSON.parse(JSON.stringify(attributes.purchasable_offer)) : [];
  const consumerIndex = offers.findIndex(x => String(x?.audience || "ALL").toUpperCase() === "ALL");
  const b2bIndex = offers.findIndex(x => String(x?.audience || "").toUpperCase() === "B2B");
  if (consumerIndex < 0 || b2bIndex < 0) throw new Error("GUARD_BLOCKED: ALL or B2B offer missing");

  const consumer = offers[consumerIndex];
  const b2b = offers[b2bIndex];
  const our = firstSchedule(consumer.our_price);
  const sale = firstSchedule(consumer.discounted_price);
  const min = firstSchedule(consumer.minimum_seller_allowed_price);
  const max = firstSchedule(consumer.maximum_seller_allowed_price);
  const b2bOur = firstSchedule(b2b.our_price);
  const quantityPlan = parseQuantityPlan(b2b);

  if (numberOrNull(our?.value_with_tax) !== GUARD.ourPrice) throw new Error(`GUARD_BLOCKED: our price mismatch ${our?.value_with_tax}`);
  if (numberOrNull(sale?.value_with_tax) !== GUARD.expiredSalePrice) throw new Error(`GUARD_BLOCKED: sale price mismatch ${sale?.value_with_tax}`);
  if (String(sale?.start_at || "") !== GUARD.expiredSaleStart) throw new Error(`GUARD_BLOCKED: sale start mismatch ${sale?.start_at || ""}`);
  if (String(sale?.end_at || "") !== GUARD.expiredSaleEnd) throw new Error(`GUARD_BLOCKED: sale end mismatch ${sale?.end_at || ""}`);
  if (!(Date.parse(GUARD.expiredSaleEnd) < Date.now())) throw new Error("GUARD_BLOCKED: sale is not expired");
  if (numberOrNull(min?.value_with_tax) !== GUARD.minPrice) throw new Error(`GUARD_BLOCKED: minimum mismatch ${min?.value_with_tax}`);
  if (numberOrNull(max?.value_with_tax) !== GUARD.maxPrice) throw new Error(`GUARD_BLOCKED: maximum mismatch ${max?.value_with_tax}`);
  if (numberOrNull(b2bOur?.value_with_tax) !== GUARD.b2bPrice) throw new Error(`GUARD_BLOCKED: B2B price mismatch ${b2bOur?.value_with_tax}`);
  if (!plansEqual(quantityPlan, { discountType: GUARD.quantityDiscountType, tiers: GUARD.quantityTiers })) {
    throw new Error(`GUARD_BLOCKED: quantity plan mismatch ${JSON.stringify(quantityPlan)}`);
  }

  const afterOffers = JSON.parse(JSON.stringify(offers));
  delete afterOffers[consumerIndex].discounted_price;

  return {
    asin,
    productType,
    listingStatus: Array.isArray(summary?.status) ? summary.status : [],
    issue18155,
    beforeOffers: offers,
    afterOffers,
    before: {
      ourPrice: GUARD.ourPrice,
      expiredSalePrice: GUARD.expiredSalePrice,
      expiredSaleStart: GUARD.expiredSaleStart,
      expiredSaleEnd: GUARD.expiredSaleEnd,
      minPrice: GUARD.minPrice,
      maxPrice: GUARD.maxPrice,
      b2bPrice: GUARD.b2bPrice,
      quantityPlan,
      liveOffers: Array.isArray(listing?.offers) ? listing.offers : [],
    },
    after: {
      ourPrice: GUARD.ourPrice,
      discountedPriceRemoved: true,
      minPrice: GUARD.minPrice,
      maxPrice: GUARD.maxPrice,
      b2bPrice: GUARD.b2bPrice,
      quantityPlanPreserved: true,
    },
  };
}

async function validationPreview(accessToken, state) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });
  const body = {
    productType: state.productType,
    patches: [{
      op: "replace",
      path: "/attributes/purchasable_offer",
      value: state.afterOffers,
    }],
  };
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    errorCount: errors.length,
    issue18155Count: errors.filter(issue => String(issue?.code || "") === "18155").length,
    issues,
    validationPassed: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    }
    if (String(req.body?.sku || "").trim() !== GUARD.sku) throw new Error("GUARD_BLOCKED: unexpected SKU");

    const accessToken = await getLwaAccessToken();
    const state = assertCurrentState(await getListing(accessToken));
    const preview = await validationPreview(accessToken, state);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: GUARD.sku,
      asin: state.asin,
      productType: state.productType,
      listingStatus: state.listingStatus,
      issue18155: state.issue18155,
      repairIntent: "REMOVE_EXPIRED_DISCOUNTED_PRICE_ONLY_PRESERVE_CURRENT_MIN",
      before: state.before,
      after: state.after,
      validationPassed: preview.validationPassed,
      preview,
      readOnly: true,
      externalChanges: 0,
      note: "VALIDATION_PREVIEW only. Current 32000 minimum, B2B price, quantity plan, and all non-discounted data are preserved.",
    });
  } catch (err) {
    console.error("Amazon 0U 18155 stale cleanup preview error", err?.message || String(err));
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

express.application.listen = function amazon0u18155StaleCleanupPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
