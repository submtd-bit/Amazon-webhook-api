import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-kl18155-preview-v1.0.0";
const ROUTE = "/amazon/listing/kl18155-repair-preview";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "KL-GLTE-GU7A",
  asin: "B0D4LDW2TF",
  productType: "NOTEBOOK_COMPUTER",
  issueCode: "18155",
  audience: "ALL",
  ourPrice: 56000,
  salePrice: 47800,
  saleStart: "2025-09-29T15:00:00.000Z",
  saleEnd: "2025-10-30T15:00:00.000Z",
  minPrice: 54000,
  maxPrice: 90000,
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
  const allIndexes = offers.map((offer, index) => ({ offer, index })).filter(x => String(x.offer?.audience || "").toUpperCase() === GUARD.audience);
  if (allIndexes.length !== 1) throw new Error(`GUARD_BLOCKED: expected exactly one ALL purchasable_offer, found ${allIndexes.length}`);

  const allIndex = allIndexes[0].index;
  const allOffer = offers[allIndex];
  const our = firstSchedule(allOffer.our_price);
  const sale = firstSchedule(allOffer.discounted_price);
  const min = firstSchedule(allOffer.minimum_seller_allowed_price);
  const max = firstSchedule(allOffer.maximum_seller_allowed_price);
  if (!our || numberOrNull(our.value_with_tax) !== GUARD.ourPrice) throw new Error(`GUARD_BLOCKED: our price mismatch ${our?.value_with_tax}`);
  if (!sale || numberOrNull(sale.value_with_tax) !== GUARD.salePrice) throw new Error(`GUARD_BLOCKED: sale price mismatch ${sale?.value_with_tax}`);
  if (String(sale.start_at || "") !== GUARD.saleStart) throw new Error(`GUARD_BLOCKED: sale start mismatch ${sale?.start_at || ""}`);
  if (String(sale.end_at || "") !== GUARD.saleEnd) throw new Error(`GUARD_BLOCKED: sale end mismatch ${sale?.end_at || ""}`);
  if (!min || numberOrNull(min.value_with_tax) !== GUARD.minPrice) throw new Error(`GUARD_BLOCKED: minimum price mismatch ${min?.value_with_tax}`);
  if (!max || numberOrNull(max.value_with_tax) !== GUARD.maxPrice) throw new Error(`GUARD_BLOCKED: maximum price mismatch ${max?.value_with_tax}`);
  if (!(Date.parse(GUARD.saleEnd) < Date.now())) throw new Error("GUARD_BLOCKED: sale schedule is not expired");

  const afterOffers = JSON.parse(JSON.stringify(offers));
  delete afterOffers[allIndex].discounted_price;

  return {
    asin,
    productType,
    status: Array.isArray(summary?.status) ? summary.status : [],
    issue18155,
    beforeOffers: offers,
    afterOffers,
    before: {
      ourPrice: GUARD.ourPrice,
      salePrice: GUARD.salePrice,
      saleStart: GUARD.saleStart,
      saleEnd: GUARD.saleEnd,
      minPrice: GUARD.minPrice,
      maxPrice: GUARD.maxPrice,
    },
    after: {
      ourPrice: GUARD.ourPrice,
      discountedPriceRemoved: true,
      minPrice: GUARD.minPrice,
      maxPrice: GUARD.maxPrice,
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
    issues,
    validationPassed: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
    body,
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }
    const sku = String(req.body?.sku || "").trim();
    if (sku !== GUARD.sku) throw new Error("GUARD_BLOCKED: unexpected SKU");
    if (req.body?.dryRun === false) throw new Error("LIVE is intentionally disabled on this route");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken);
    const state = assertCurrentState(listing);
    const preview = await validationPreview(accessToken, state);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: GUARD.sku,
      asin: state.asin,
      productType: state.productType,
      listingStatus: state.status,
      issue18155: state.issue18155,
      repairIntent: "REMOVE_EXPIRED_DISCOUNTED_PRICE_ONLY",
      before: state.before,
      after: state.after,
      validationPassed: preview.validationPassed,
      preview: {
        httpStatus: preview.httpStatus,
        responseOk: preview.responseOk,
        status: preview.status,
        submissionId: preview.submissionId,
        errorCount: preview.errorCount,
        issues: preview.issues,
      },
      externalChanges: 0,
      note: "VALIDATION_PREVIEW only. Normal price, minimum price, maximum price, and all non-discounted offer data are preserved.",
    });
  } catch (err) {
    console.error("Amazon KL 18155 preview error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonKl18155PreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
