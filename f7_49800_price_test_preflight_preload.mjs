import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-09-03-f7-49800-price-test-preflight-v1.0.0";
const ROUTE = "/amazon/price/f7/49800-price-test/preflight";
const F7_SKU = "F7-AF7O-IGX5";
const F7_ASIN = "B0FN3KQFR3";
const EXPECTED_PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const EXPECTED_NORMAL_PRICE = 73000;
const EXPECTED_TEST_PRICE = 49800;
const EXPECTED_SAFE_FLOOR = 25700;
const EXPECTED_DURATION_DAYS = 3;
const EXPECTED_AMAZON_MIN = 25000;
const EXPECTED_AMAZON_MAX = 73000;
const EXPECTED_B2B_PRICE = 69350;
const EXPECTED_AMAZON_POINTS = 730;
const REQUEST_TIMEOUT_MS = 20000;
const FINGERPRINT_TTL_MS = 60 * 60 * 1000;
const originalPost = express.application.post;

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    const candidates = [value.pointsNumber, value.PointsNumber, value.points_number, value.amount, value.Amount, value.value, value.Value];
    for (const candidate of candidates) {
      const parsed = numberOrNull(candidate);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoOrEmpty(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
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
  if (marketplaceId !== "A1VC38T7YXB528") throw new Error(`marketplace mismatch: ${marketplaceId}`);
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
    const text = await response.text();
    const json = safeJsonParse(text);
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
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(F7_SKU)}?${query}`;
  return amazonRequest({ method: "GET", url, accessToken });
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

function activeSchedule(offer, key, nowMs) {
  return getScheduleEntries(offer, key)
    .filter(schedule => scheduleIsActive(schedule, nowMs))
    .sort((a, b) => (epochOrNull(b?.start_at) ?? 0) - (epochOrNull(a?.start_at) ?? 0))[0] || null;
}

function saleScheduleDiagnostics(offer, nowMs) {
  const schedules = getScheduleEntries(offer, "discounted_price");
  let active = 0;
  let expired = 0;
  let future = 0;
  for (const schedule of schedules) {
    const startMs = epochOrNull(schedule?.start_at);
    const endMs = epochOrNull(schedule?.end_at);
    if (scheduleIsActive(schedule, nowMs)) active += 1;
    else if (endMs !== null && nowMs >= endMs) expired += 1;
    else if (startMs !== null && nowMs < startMs) future += 1;
  }
  return { count: schedules.length, active, expired, future };
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
  return numberOrNull(offer?.price);
}

function summarizeCurrentOffers(listing) {
  const { marketplaceId } = getConfig();
  const offers = Array.isArray(listing?.offers) ? listing.offers : [];
  const marketOffers = offers.filter(offer => {
    const id = String(offer?.marketplaceId || offer?.marketplace_id || "");
    return !id || id === marketplaceId;
  });
  const b2c = marketOffers.find(offer => offerType(offer) === "B2C" || audienceValue(offer) === "ALL") || null;
  const b2b = marketOffers.find(offer => offerType(offer) === "B2B" || audienceValue(offer) === "B2B") || null;
  return {
    b2cPrice: offerPrice(b2c),
    b2bPrice: offerPrice(b2b),
    b2cPointsSourcePresent: Boolean(b2c && Object.prototype.hasOwnProperty.call(b2c, "points")),
    b2cPoints: b2c && Object.prototype.hasOwnProperty.call(b2c, "points") ? numberOrNull(b2c.points) : null,
  };
}

function parseQuantityPlan(b2b, nowMs) {
  const schedule = activeSchedule(b2b, "quantity_discount_plan", nowMs) || {};
  const levels = Array.isArray(schedule?.levels) ? schedule.levels : [];
  return {
    discountType: String(schedule?.discount_type || "").toLowerCase(),
    levels: levels.map(level => ({
      lowerBound: numberOrNull(level?.lower_bound),
      value: numberOrNull(level?.value),
    })).filter(level => level.lowerBound !== null && level.value !== null),
  };
}

function analyzeListing(listing, nowMs = Date.now()) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const availability = Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability[0] || {} : {};
  const offers = Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [];
  const consumer = offers.find(row => String(row?.audience || "ALL").toUpperCase() === "ALL") || null;
  const b2b = offers.find(row => String(row?.audience || "").toUpperCase() === "B2B") || null;
  const normal = activeSchedule(consumer, "our_price", nowMs);
  const sale = activeSchedule(consumer, "discounted_price", nowMs);
  const minAllowed = activeSchedule(consumer, "minimum_seller_allowed_price", nowMs);
  const maxAllowed = activeSchedule(consumer, "maximum_seller_allowed_price", nowMs);
  const b2bPriceSchedule = activeSchedule(b2b, "our_price", nowMs);
  const currentOffers = summarizeCurrentOffers(listing);
  const saleDiag = saleScheduleDiagnostics(consumer, nowMs);
  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses: Array.isArray(summary?.status) ? summary.status.map(String) : [],
    buyable: Array.isArray(summary?.status) && summary.status.map(String).includes("BUYABLE"),
    errorCount: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: numberOrNull(availability?.quantity) ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity) ?? 0,
    offers,
    consumer,
    b2b,
    normalPrice: numberOrNull(normal?.value_with_tax),
    activeSalePrice: numberOrNull(sale?.value_with_tax),
    minimumSellerAllowedPrice: numberOrNull(minAllowed?.value_with_tax),
    maximumSellerAllowedPrice: numberOrNull(maxAllowed?.value_with_tax),
    b2bPrice: numberOrNull(b2bPriceSchedule?.value_with_tax),
    quantityDiscountPlan: parseQuantityPlan(b2b, nowMs),
    saleScheduleDiagnostics: saleDiag,
    actualOfferB2CPrice: currentOffers.b2cPrice,
    actualOfferB2BPrice: currentOffers.b2bPrice,
    amazonPointsSourcePresent: currentOffers.b2cPointsSourcePresent,
    amazonPoints: currentOffers.b2cPoints,
  };
}

function assertExactScope(body) {
  const errors = [];
  if (body?.dryRun !== true) errors.push("dryRun must be true");
  if (String(body?.sku || "") !== F7_SKU) errors.push(`sku must equal ${F7_SKU}`);
  if (String(body?.asin || "") !== F7_ASIN) errors.push(`asin must equal ${F7_ASIN}`);
  if (Number(body?.normalPrice) !== EXPECTED_NORMAL_PRICE) errors.push(`normalPrice must equal ${EXPECTED_NORMAL_PRICE}`);
  if (Number(body?.salePrice) !== EXPECTED_TEST_PRICE) errors.push(`salePrice must equal ${EXPECTED_TEST_PRICE}`);
  if (Number(body?.safeFloor) !== EXPECTED_SAFE_FLOOR) errors.push(`safeFloor must equal ${EXPECTED_SAFE_FLOOR}`);
  if (Number(body?.durationDays) !== EXPECTED_DURATION_DAYS) errors.push(`durationDays must equal ${EXPECTED_DURATION_DAYS}`);
  if (Number(body?.preserveB2BPrice) !== EXPECTED_B2B_PRICE) errors.push(`preserveB2BPrice must equal ${EXPECTED_B2B_PRICE}`);
  if (Number(body?.preserveAmazonPoints) !== EXPECTED_AMAZON_POINTS) errors.push(`preserveAmazonPoints must equal ${EXPECTED_AMAZON_POINTS}`);
  if (errors.length) throw new Error(`Exact-scope request rejected: ${errors.join(" / ")}`);
}

function assertListingState(state) {
  const errors = [];
  if (state.asin !== F7_ASIN) errors.push(`ASIN mismatch: ${state.asin || "(empty)"}`);
  if (state.productType !== EXPECTED_PRODUCT_TYPE) errors.push(`productType mismatch: ${state.productType || "(empty)"}`);
  if (!state.buyable) errors.push(`BUYABLE missing: ${state.statuses.join(",")}`);
  if (state.errorCount !== 0) errors.push(`listing ERROR issues=${state.errorCount}`);
  if (!(state.availableQuantity > 0)) errors.push(`availableQuantity must be > 0: ${state.availableQuantity}`);
  if (!state.consumer) errors.push("consumer purchasable_offer missing");
  if (!state.b2b) errors.push("B2B purchasable_offer missing");
  if (state.normalPrice !== EXPECTED_NORMAL_PRICE) errors.push(`normal price mismatch: ${state.normalPrice}`);
  if (state.activeSalePrice !== null) errors.push(`active sale must be absent before test: ${state.activeSalePrice}`);
  if (state.saleScheduleDiagnostics.future !== 0) errors.push(`future sale schedule must be absent: ${JSON.stringify(state.saleScheduleDiagnostics)}`);
  if (state.saleScheduleDiagnostics.count < 1) errors.push("existing discounted_price schedule container missing");
  if (state.minimumSellerAllowedPrice !== EXPECTED_AMAZON_MIN) errors.push(`Amazon minimum mismatch: ${state.minimumSellerAllowedPrice}`);
  if (state.maximumSellerAllowedPrice !== EXPECTED_AMAZON_MAX) errors.push(`Amazon maximum mismatch: ${state.maximumSellerAllowedPrice}`);
  if (EXPECTED_TEST_PRICE < EXPECTED_SAFE_FLOOR) errors.push("test price is below internal safe floor");
  if (EXPECTED_TEST_PRICE < state.minimumSellerAllowedPrice) errors.push("test price is below Amazon minimum seller allowed price");
  if (state.b2bPrice !== EXPECTED_B2B_PRICE) errors.push(`B2B price mismatch: ${state.b2bPrice}`);
  if (state.quantityDiscountPlan.discountType !== "" || state.quantityDiscountPlan.levels.length !== 0) {
    errors.push(`quantity discount plan must remain absent: ${JSON.stringify(state.quantityDiscountPlan)}`);
  }
  if (state.actualOfferB2CPrice !== EXPECTED_NORMAL_PRICE) errors.push(`actual B2C offer mismatch: ${state.actualOfferB2CPrice}`);
  if (state.actualOfferB2BPrice !== EXPECTED_B2B_PRICE) errors.push(`actual B2B offer mismatch: ${state.actualOfferB2BPrice}`);
  if (!state.amazonPointsSourcePresent || state.amazonPoints !== EXPECTED_AMAZON_POINTS) {
    errors.push(`Amazon points mismatch/source missing: ${state.amazonPoints}`);
  }
  if (errors.length) {
    const err = new Error(`F7 49800 price-test preflight failed: ${errors.join(" / ")}`);
    err.code = "PREFLIGHT_FAILED";
    err.details = errors;
    throw err;
  }
}

function withoutDiscountedPrice(offer) {
  const copy = JSON.parse(JSON.stringify(offer || {}));
  delete copy.discounted_price;
  return copy;
}

function buildPreviewPatch(state, nowMs) {
  const offers = JSON.parse(JSON.stringify(state.offers));
  const consumerIndex = offers.findIndex(row => String(row?.audience || "ALL").toUpperCase() === "ALL");
  const b2bIndex = offers.findIndex(row => String(row?.audience || "").toUpperCase() === "B2B");
  if (consumerIndex < 0 || b2bIndex < 0) throw new Error("consumer/B2B offer missing while building preview");

  const beforeConsumerProtected = JSON.stringify(withoutDiscountedPrice(offers[consumerIndex]));
  const beforeB2B = JSON.stringify(offers[b2bIndex]);
  const saleContainer = offers[consumerIndex]?.discounted_price?.[0];
  if (!saleContainer || !Array.isArray(saleContainer.schedule) || !saleContainer.schedule.length) {
    throw new Error("existing discounted_price schedule container missing; refusing to invent schema");
  }

  const startAt = new Date(nowMs - 60 * 1000).toISOString();
  const endAt = new Date(nowMs + EXPECTED_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const template = JSON.parse(JSON.stringify(saleContainer.schedule[0] || {}));
  template.value_with_tax = EXPECTED_TEST_PRICE;
  template.start_at = startAt;
  template.end_at = endAt;
  saleContainer.schedule = [template];

  const afterConsumerProtected = JSON.stringify(withoutDiscountedPrice(offers[consumerIndex]));
  const afterB2B = JSON.stringify(offers[b2bIndex]);
  if (beforeConsumerProtected !== afterConsumerProtected) throw new Error("consumer protected fields changed while building sale preview");
  if (beforeB2B !== afterB2B) throw new Error("B2B offer changed while building consumer sale preview");

  return {
    startAt,
    endAt,
    patchBody: {
      productType: state.productType,
      patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }],
    },
    protections: {
      consumerOnlyDiscountedPriceChanged: true,
      consumerNormalPricePreservedExact: true,
      amazonMinimumPreservedExact: true,
      amazonMaximumPreservedExact: true,
      b2bOfferPreservedExact: true,
      quantityDiscountPlanPreservedAbsent: true,
      amazonPointsObservedBefore: state.amazonPoints,
      amazonPointsPathNotPatched: true,
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
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(F7_SKU)}?${query}`;
  const result = await amazonRequest({ method: "PATCH", url, accessToken, body: patchBody });
  if (hasErrorIssues(result)) {
    const err = new Error(`Amazon VALIDATION_PREVIEW returned ERROR issues: ${JSON.stringify(result.issues)}`);
    err.code = "AMAZON_VALIDATION_ERROR";
    throw err;
  }
  return result;
}

function makeFingerprint(before, preview, issuedAtMs) {
  const secret = getSecret();
  const payload = {
    v: 1,
    moduleVersion: MODULE_VERSION,
    sku: F7_SKU,
    asin: F7_ASIN,
    productType: EXPECTED_PRODUCT_TYPE,
    normalPrice: EXPECTED_NORMAL_PRICE,
    salePrice: EXPECTED_TEST_PRICE,
    safeFloor: EXPECTED_SAFE_FLOOR,
    durationDays: EXPECTED_DURATION_DAYS,
    amazonMinimumSellerAllowedPrice: EXPECTED_AMAZON_MIN,
    amazonMaximumSellerAllowedPrice: EXPECTED_AMAZON_MAX,
    b2bPrice: EXPECTED_B2B_PRICE,
    amazonPoints: EXPECTED_AMAZON_POINTS,
    quantityDiscountPlanAbsent: true,
    targetStartAt: preview.startAt,
    targetEndAt: preview.endAt,
    issuedAt: issuedAtMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function handler(req, res) {
  const issuedAtMs = Date.now();
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    assertExactScope(req.body || {});
    const accessToken = await getLwaAccessToken();
    const before = analyzeListing(await getListing(accessToken), issuedAtMs);
    assertListingState(before);
    const preview = buildPreviewPatch(before, issuedAtMs);
    const amazonValidation = await submitValidationPreview(accessToken, preview.patchBody);
    const dryRunFingerprint = makeFingerprint(before, preview, issuedAtMs);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      status: "VALIDATION_PREVIEW_PASS",
      dryRun: true,
      exactScope: {
        sku: F7_SKU,
        asin: F7_ASIN,
        productType: EXPECTED_PRODUCT_TYPE,
        normalPrice: EXPECTED_NORMAL_PRICE,
        salePrice: EXPECTED_TEST_PRICE,
        safeFloor: EXPECTED_SAFE_FLOOR,
        durationDays: EXPECTED_DURATION_DAYS,
        preserveB2BPrice: EXPECTED_B2B_PRICE,
        preserveAmazonPoints: EXPECTED_AMAZON_POINTS,
      },
      before: {
        asin: before.asin,
        productType: before.productType,
        buyable: before.buyable,
        errorCount: before.errorCount,
        availableQuantity: before.availableQuantity,
        normalPrice: before.normalPrice,
        activeSalePrice: before.activeSalePrice,
        minimumSellerAllowedPrice: before.minimumSellerAllowedPrice,
        maximumSellerAllowedPrice: before.maximumSellerAllowedPrice,
        b2bPrice: before.b2bPrice,
        quantityDiscountPlan: before.quantityDiscountPlan,
        actualOfferB2CPrice: before.actualOfferB2CPrice,
        actualOfferB2BPrice: before.actualOfferB2BPrice,
        amazonPoints: before.amazonPoints,
        saleScheduleDiagnostics: before.saleScheduleDiagnostics,
      },
      target: {
        salePrice: EXPECTED_TEST_PRICE,
        safeFloor: EXPECTED_SAFE_FLOOR,
        startAt: preview.startAt,
        endAt: preview.endAt,
        durationDays: EXPECTED_DURATION_DAYS,
        primaryEvaluationHours: 48,
        maxEvaluationHours: 72,
      },
      protections: preview.protections,
      amazonValidation,
      dryRunFingerprint,
      fingerprintTtlMinutes: FINGERPRINT_TTL_MS / 60000,
      nextDecision: "READY_FOR_FRESH_REGET_AND_EXPLICIT_LIVE_APPROVAL__NO_LIVE_IN_THIS_ROUTE",
      amazonWrites: 0,
      externalChanges: 0,
    });
  } catch (err) {
    console.error("F7 49800 price-test preflight error", {
      message: err?.message || String(err),
      code: err?.code || "",
    });
    const status = err?.code === "PREFLIGHT_FAILED" ? 409 : (err?.code === "AMAZON_VALIDATION_ERROR" ? 422 : 400);
    return res.status(status).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      status: err?.code || "ERROR",
      error: err?.message || String(err),
      amazonWrites: 0,
      externalChanges: 0,
    });
  }
}

express.application.post = function f7PriceTestPreflightPost(path, ...handlers) {
  if (path === ROUTE) return originalPost.call(this, path, handler);
  return originalPost.call(this, path, ...handlers);
};
