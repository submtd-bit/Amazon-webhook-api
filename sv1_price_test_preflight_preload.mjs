import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-sv1-price-test-preflight-v1.0.0";
const ROUTE = "/amazon/price/sv1/price-test/preflight";
const SV1_SKU = "RB-Y7G2-H0EK";
const SV1_ASIN = "B0GZGM1BND";
const EXPECTED_NORMAL_PRICE = 56000;
const EXPECTED_TEST_PRICE = 52800;
const EXPECTED_SAFE_FLOOR = 40500;
const EXPECTED_DURATION_HOURS = 72;
const REQUEST_TIMEOUT_MS = 20000;
const originalPost = express.application.post;

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function epochOrNull(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : null;
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

async function amazonRequest({ method, url, accessToken, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "x-amz-access-token": accessToken,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const json = safeJsonParse(await response.text());
    if (!response.ok) throw new Error(`SP-API request error: ${response.status} ${JSON.stringify(json)}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SV1_SKU)}?${query}`;
  return amazonRequest({ method: "GET", url, accessToken });
}

function scheduleEntries(offer, key) {
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

function activeSchedule(offer, key, nowMs) {
  return scheduleEntries(offer, key)
    .filter(s => scheduleIsActive(s, nowMs))
    .sort((a, b) => (epochOrNull(b?.start_at) ?? 0) - (epochOrNull(a?.start_at) ?? 0))[0] || null;
}

function analyzeListing(listing, nowMs = Date.now()) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const availability = Array.isArray(listing?.fulfillmentAvailability)
    ? listing.fulfillmentAvailability[0] || {}
    : {};
  const offers = Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [];
  const consumerIndex = offers.findIndex(row => String(row?.audience || "ALL").toUpperCase() === "ALL");
  const consumer = consumerIndex >= 0 ? offers[consumerIndex] : null;
  const normal = activeSchedule(consumer, "our_price", nowMs);
  const activeSale = activeSchedule(consumer, "discounted_price", nowMs);
  const minAllowed = activeSchedule(consumer, "minimum_seller_allowed_price", nowMs);
  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses: Array.isArray(summary?.status) ? summary.status.map(String) : [],
    errorCount: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: numberOrNull(availability?.quantity)
      ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity)
      ?? 0,
    offers,
    consumerIndex,
    consumer,
    normalPrice: numberOrNull(normal?.value_with_tax),
    activeSalePrice: numberOrNull(activeSale?.value_with_tax),
    minimumSellerAllowedPrice: numberOrNull(minAllowed?.value_with_tax),
  };
}

function assertExactScope(body) {
  const errors = [];
  if (body?.dryRun !== true) errors.push("dryRun must be true");
  if (String(body?.sku || "") !== SV1_SKU) errors.push(`sku must equal ${SV1_SKU}`);
  if (String(body?.asin || "") !== SV1_ASIN) errors.push(`asin must equal ${SV1_ASIN}`);
  if (Number(body?.normalPrice) !== EXPECTED_NORMAL_PRICE) errors.push(`normalPrice must equal ${EXPECTED_NORMAL_PRICE}`);
  if (Number(body?.salePrice) !== EXPECTED_TEST_PRICE) errors.push(`salePrice must equal ${EXPECTED_TEST_PRICE}`);
  if (Number(body?.safeFloor) !== EXPECTED_SAFE_FLOOR) errors.push(`safeFloor must equal ${EXPECTED_SAFE_FLOOR}`);
  if (Number(body?.durationHours) !== EXPECTED_DURATION_HOURS) errors.push(`durationHours must equal ${EXPECTED_DURATION_HOURS}`);
  if (errors.length) throw new Error(`Exact-scope request rejected: ${errors.join(" / ")}`);
}

function assertListingState(state) {
  const errors = [];
  if (state.asin !== SV1_ASIN) errors.push(`ASIN mismatch: ${state.asin || "(empty)"}`);
  if (!state.productType) errors.push("productType missing");
  if (!state.statuses.includes("BUYABLE")) errors.push(`BUYABLE missing: ${state.statuses.join(",")}`);
  if (state.errorCount !== 0) errors.push(`listing ERROR issues=${state.errorCount}`);
  if (!(state.availableQuantity > 0)) errors.push(`availableQuantity must be > 0: ${state.availableQuantity}`);
  if (!state.consumer || state.consumerIndex < 0) errors.push("consumer purchasable_offer missing");
  if (state.normalPrice !== EXPECTED_NORMAL_PRICE) errors.push(`normal price mismatch: ${state.normalPrice}`);
  if (state.activeSalePrice !== null) errors.push(`active sale must be absent before test: ${state.activeSalePrice}`);
  if (!(state.minimumSellerAllowedPrice > 0)) errors.push(`minimum seller allowed price missing: ${state.minimumSellerAllowedPrice}`);
  if (state.minimumSellerAllowedPrice > EXPECTED_SAFE_FLOOR) {
    errors.push(`Amazon minimum seller allowed price exceeds internal safe floor: ${state.minimumSellerAllowedPrice}`);
  }
  if (EXPECTED_TEST_PRICE < EXPECTED_SAFE_FLOOR) errors.push("test price is below internal safe floor");
  if (errors.length) {
    const err = new Error(`SV1 price-test preflight failed: ${errors.join(" / ")}`);
    err.code = "PREFLIGHT_FAILED";
    throw err;
  }
}

function buildPreviewPatch(state, nowMs) {
  const offers = JSON.parse(JSON.stringify(state.offers));
  const beforeOffers = JSON.parse(JSON.stringify(offers));
  const consumer = offers[state.consumerIndex];
  const saleContainer = consumer?.discounted_price?.[0];
  if (!saleContainer || !Array.isArray(saleContainer.schedule) || !saleContainer.schedule.length) {
    throw new Error("existing discounted_price schedule container missing; refusing to invent schema");
  }

  const startAt = new Date(nowMs - 60 * 1000).toISOString();
  const endAt = new Date(nowMs + EXPECTED_DURATION_HOURS * 60 * 60 * 1000).toISOString();
  const template = JSON.parse(JSON.stringify(saleContainer.schedule[0] || {}));
  template.value_with_tax = EXPECTED_TEST_PRICE;
  template.start_at = startAt;
  template.end_at = endAt;
  saleContainer.schedule = [template];

  for (let i = 0; i < offers.length; i += 1) {
    if (i === state.consumerIndex) continue;
    if (JSON.stringify(offers[i]) !== JSON.stringify(beforeOffers[i])) {
      throw new Error(`non-consumer offer changed at index ${i}`);
    }
  }
  if (JSON.stringify(consumer?.our_price || null) !== JSON.stringify(beforeOffers[state.consumerIndex]?.our_price || null)) {
    throw new Error("consumer normal price changed while building preview");
  }
  if (JSON.stringify(consumer?.minimum_seller_allowed_price || null) !== JSON.stringify(beforeOffers[state.consumerIndex]?.minimum_seller_allowed_price || null)) {
    throw new Error("minimum seller allowed price changed while building preview");
  }

  return {
    startAt,
    endAt,
    patchBody: {
      productType: state.productType,
      patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }],
    },
  };
}

function hasErrorIssues(result) {
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  return issues.some(row => String(row?.severity || "").toUpperCase() === "ERROR");
}

async function submitValidationPreview(accessToken, patchBody) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", mode: "VALIDATION_PREVIEW" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SV1_SKU)}?${query}`;
  const result = await amazonRequest({ method: "PATCH", url, accessToken, body: patchBody });
  if (hasErrorIssues(result)) throw new Error(`Amazon VALIDATION_PREVIEW returned ERROR issues: ${JSON.stringify(result.issues)}`);
  return result;
}

async function handler(req, res) {
  const nowMs = Date.now();
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    assertExactScope(req.body || {});
    const accessToken = await getLwaAccessToken();
    const before = analyzeListing(await getListing(accessToken), nowMs);
    assertListingState(before);
    const preview = buildPreviewPatch(before, nowMs);
    const amazonValidation = await submitValidationPreview(accessToken, preview.patchBody);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      status: "DRY_RUN_VALIDATED",
      dryRun: true,
      externalChanges: 0,
      sku: SV1_SKU,
      asin: SV1_ASIN,
      before: {
        normalPrice: before.normalPrice,
        activeSalePrice: before.activeSalePrice,
        minimumSellerAllowedPrice: before.minimumSellerAllowedPrice,
        availableQuantity: before.availableQuantity,
        statuses: before.statuses,
      },
      target: {
        salePrice: EXPECTED_TEST_PRICE,
        safeFloor: EXPECTED_SAFE_FLOOR,
        durationHours: EXPECTED_DURATION_HOURS,
        startAt: preview.startAt,
        endAt: preview.endAt,
      },
      protections: {
        normalPricePreserved: true,
        minimumSellerAllowedPricePreserved: true,
        allNonConsumerOffersPreserved: true,
        liveMutationPathExists: false,
      },
      amazonValidation,
    });
  } catch (err) {
    console.error("SV1 price-test preflight error", { message: err?.message || String(err), code: err?.code || "" });
    return res.status(err?.code === "PREFLIGHT_FAILED" ? 409 : 500).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      status: err?.code || "ERROR",
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.post = function patchedPost(path, ...handlers) {
  if (path === ROUTE) return originalPost.call(this, path, ...handlers);
  return originalPost.call(this, path, ...handlers);
};

const originalUse = express.application.use;
express.application.use = function patchedUse(...args) {
  const result = originalUse.apply(this, args);
  if (!this.__sv1PriceTestPreflightInstalled) {
    this.__sv1PriceTestPreflightInstalled = true;
    originalPost.call(this, ROUTE, handler);
    console.log(`${MODULE_VERSION} route installed: POST ${ROUTE}`);
  }
  return result;
};
