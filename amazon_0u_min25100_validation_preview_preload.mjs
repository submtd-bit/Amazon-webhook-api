import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * Amazon 0U minimum seller allowed price 25,100 Validation Preview v1.0.0
 * 2026-08-28
 *
 * Exact scope:
 * - SKU 0U-3IJD-CZ48 / ASIN B0FMYF5C2Y / Amazon.co.jp
 * - Change ONLY consumer minimum_seller_allowed_price: 32,000 -> 25,100
 * - Preserve consumer our_price 32,000 exactly
 * - Preserve Amazon points 320 exactly
 * - Preserve maximum_seller_allowed_price 58,000 exactly
 * - Preserve discounted_price container/schedules exactly
 * - Preserve B2B our_price 55,100 exactly
 * - Preserve quantity discounts 5+@5% and 10+@7% exactly
 * - Preserve inventory quantity 0; BUYABLE=false is allowed because inventory is zero
 * - Require current ERROR issues 18155 and 18639 before preview
 *
 * SP-API VALIDATION_PREVIEW only. No persistent Amazon mutation.
 */
const MODULE_VERSION = "2026-08-28-amazon-0u-min25100-validation-preview-v1.0.0";
const ROUTE = "/amazon/listing/0u-min25100-validation-preview";
const BATCH_TOKEN = "0U_MIN_25100_20260828_V1";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
const originalListen = express.application.listen;

const TARGET = Object.freeze({
  sku: "0U-3IJD-CZ48",
  asin: "B0FMYF5C2Y",
  marketplaceId: "A1VC38T7YXB528",
  productType: "NOTEBOOK_COMPUTER",
  normalPrice: 32000,
  actualB2CPrice: 32000,
  amazonPoints: 320,
  currentMinimum: 32000,
  targetMinimum: 25100,
  maximumSellerAllowed: 58000,
  b2bPrice: 55100,
  quantityDiscountType: "percent",
  quantityTiers: [
    { lowerBound: 5, value: 5 },
    { lowerBound: 10, value: 7 },
  ],
  availableQuantity: 0,
  totalCost: 17250,
  feeRate: 0.10,
  minimumProfit: 5000,
  minimumGrossMargin: 0.20,
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    for (const key of ["amount", "Amount", "value", "Value", "pointsNumber", "PointsNumber", "points_number"]) {
      if (value && value[key] !== undefined) return numberOrNull(value[key]);
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function jsonEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function hasOwn(obj, key) { return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function epochOrNull(value) { const t = Date.parse(String(value || "")); return Number.isFinite(t) ? t : null; }
function floorHundred(value) { return Number.isFinite(value) ? Math.floor(value / 100) * 100 : null; }
function ceilHundred(value) { return Number.isFinite(value) ? Math.ceil(value / 100) * 100 : null; }
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }

function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || TARGET.marketplaceId).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== TARGET.marketplaceId) throw new Error(`GUARD_BLOCKED: marketplace mismatch ${marketplaceId}`);
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

async function amazonRequest(url, options) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      const json = safeJsonParse(text);
      if (response.ok) return { response, json };
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        const err = new Error(`SP-API error: ${response.status} ${JSON.stringify(json).slice(0, 2500)}`);
        err.amazonBody = json;
        throw err;
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_MS * attempt);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("SP-API request failed");
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`;
  return (await amazonRequest(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  })).json;
}

async function validationPreview(accessToken, productType, offers) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`;
  const body = {
    productType,
    patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }],
  };
  const { response, json } = await amazonRequest(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status: String(json?.status || "").toUpperCase(),
    submissionId: String(json?.submissionId || ""),
    issues,
    errors,
    raw: json,
  };
}

function scheduleIsActive(schedule, nowMs) {
  const start = epochOrNull(schedule?.start_at);
  const end = epochOrNull(schedule?.end_at);
  if (start !== null && nowMs < start) return false;
  if (end !== null && nowMs >= end) return false;
  return true;
}

function activeScheduleRef(offer, key, nowMs) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : [];
  const candidates = [];
  groups.forEach((group, groupIndex) => {
    const schedules = Array.isArray(group?.schedule) ? group.schedule : [];
    schedules.forEach((schedule, scheduleIndex) => {
      if (!scheduleIsActive(schedule, nowMs)) return;
      candidates.push({ groupIndex, scheduleIndex, schedule, startMs: epochOrNull(schedule?.start_at) ?? 0 });
    });
  });
  candidates.sort((a, b) => b.startMs - a.startMs);
  return candidates[0] || null;
}

function scheduleDiagnostics(offer, key, nowMs) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : [];
  let total = 0, active = 0, expired = 0, future = 0;
  groups.forEach(group => {
    const schedules = Array.isArray(group?.schedule) ? group.schedule : [];
    schedules.forEach(schedule => {
      total += 1;
      const start = epochOrNull(schedule?.start_at);
      const end = epochOrNull(schedule?.end_at);
      if (scheduleIsActive(schedule, nowMs)) active += 1;
      else if (end !== null && nowMs >= end) expired += 1;
      else if (start !== null && nowMs < start) future += 1;
    });
  });
  return { total, active, expired, future };
}

function audienceValue(offer) {
  if (!offer) return "";
  if (typeof offer.audience === "string") return String(offer.audience).toUpperCase();
  return String(offer?.audience?.value || offer?.audience?.displayName || "").toUpperCase();
}
function offerType(offer) { return String(offer?.offerType || offer?.offer_type || "").toUpperCase(); }
function offerPrice(offer) { return offer && hasOwn(offer, "price") ? numberOrNull(offer.price) : null; }

function parsePointsValue(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "object") return numberOrNull(raw);
  for (const key of ["pointsNumber", "PointsNumber", "points_number", "amount", "Amount", "value", "Value"]) {
    if (raw[key] !== undefined) {
      const n = numberOrNull(raw[key]);
      if (n !== null) return n;
    }
  }
  return null;
}

function summarizeActualOffers(listing) {
  const { marketplaceId } = getConfig();
  const offers = Array.isArray(listing?.offers) ? listing.offers : [];
  const market = offers.filter(offer => {
    const id = String(offer?.marketplaceId || offer?.marketplace_id || "");
    return !id || id === marketplaceId;
  });
  const b2c = market.find(offer => offerType(offer) === "B2C" || audienceValue(offer) === "ALL") || null;
  const b2b = market.find(offer => offerType(offer) === "B2B" || audienceValue(offer) === "B2B") || null;
  return {
    b2cPresent: Boolean(b2c),
    b2cPrice: offerPrice(b2c),
    pointsPresent: Boolean(b2c && hasOwn(b2c, "points")),
    points: b2c && hasOwn(b2c, "points") ? parsePointsValue(b2c.points) : null,
    b2bPresent: Boolean(b2b),
    b2bPrice: offerPrice(b2b),
  };
}

function quantityPlanFromB2B(b2b, nowMs) {
  const ref = activeScheduleRef(b2b, "quantity_discount_plan", nowMs);
  const schedule = ref?.schedule || null;
  const type = String(schedule?.discount_type || "").toLowerCase();
  const levels = Array.isArray(schedule?.levels) ? schedule.levels : [];
  return {
    type,
    levels: levels.map(level => ({
      lowerBound: numberOrNull(level?.lower_bound),
      value: numberOrNull(level?.value),
    })).filter(level => level.lowerBound !== null && level.value !== null),
  };
}

function quantityPlanMatches(actual) {
  if (actual.type !== TARGET.quantityDiscountType) return false;
  if (actual.levels.length !== TARGET.quantityTiers.length) return false;
  return actual.levels.every((row, index) =>
    row.lowerBound === TARGET.quantityTiers[index].lowerBound &&
    row.value === TARGET.quantityTiers[index].value
  );
}

function analyzeListing(listing, nowMs) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const offers = Array.isArray(attributes?.purchasable_offer) ? clone(attributes.purchasable_offer) : [];
  const indexed = offers.map((offer, index) => ({ offer, index }));
  const consumers = indexed.filter(x => audienceValue(x.offer) === "ALL");
  const b2bs = indexed.filter(x => audienceValue(x.offer) === "B2B");
  const consumer = consumers.length === 1 ? consumers[0].offer : null;
  const b2b = b2bs.length === 1 ? b2bs[0].offer : null;
  const normalRef = activeScheduleRef(consumer, "our_price", nowMs);
  const minimumRef = activeScheduleRef(consumer, "minimum_seller_allowed_price", nowMs);
  const maximumRef = activeScheduleRef(consumer, "maximum_seller_allowed_price", nowMs);
  const b2bRef = activeScheduleRef(b2b, "our_price", nowMs);
  const saleDiagnostics = scheduleDiagnostics(consumer, "discounted_price", nowMs);
  const actual = summarizeActualOffers(listing);
  const quantityPlan = quantityPlanFromB2B(b2b, nowMs);
  const availableQuantity = numberOrNull(listing?.fulfillmentAvailability?.[0]?.quantity)
    ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity)
    ?? 0;
  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    issues,
    errorIssues: issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR"),
    availableQuantity,
    offers,
    consumerIndex: consumers.length === 1 ? consumers[0].index : -1,
    b2bIndex: b2bs.length === 1 ? b2bs[0].index : -1,
    consumer,
    b2b,
    normalRef,
    normalPrice: numberOrNull(normalRef?.schedule?.value_with_tax),
    minimumRef,
    minimumSellerAllowed: numberOrNull(minimumRef?.schedule?.value_with_tax),
    maximumRef,
    maximumSellerAllowed: numberOrNull(maximumRef?.schedule?.value_with_tax),
    b2bRef,
    b2bPrice: numberOrNull(b2bRef?.schedule?.value_with_tax),
    saleDiagnostics,
    actual,
    quantityPlan,
    consumerCount: consumers.length,
    b2bCount: b2bs.length,
  };
}

function economics() {
  const profitFloorRaw = (TARGET.totalCost + TARGET.amazonPoints + TARGET.minimumProfit) / (1 - TARGET.feeRate);
  const marginFloorRaw = (TARGET.totalCost + TARGET.amazonPoints) / (1 - TARGET.feeRate - TARGET.minimumGrossMargin);
  const profitFloor = ceilHundred(profitFloorRaw);
  const marginFloor = ceilHundred(marginFloorRaw);
  const calculatedMinimum = Math.max(profitFloor, marginFloor);
  return {
    totalCost: TARGET.totalCost,
    amazonPoints: TARGET.amazonPoints,
    feeRate: TARGET.feeRate,
    minimumProfit: TARGET.minimumProfit,
    minimumGrossMargin: TARGET.minimumGrossMargin,
    profitFloorRaw,
    profitFloor,
    marginFloorRaw,
    marginFloor,
    calculatedMinimum,
    targetMatchesCalculatedMinimum: calculatedMinimum === TARGET.targetMinimum,
    currentMinimumDrift: TARGET.currentMinimum - calculatedMinimum,
  };
}

function preflightBlocks(state) {
  const blocks = [];
  const issueCodes = new Set(state.errorIssues.map(x => String(x?.code || "")));
  if (state.asin !== TARGET.asin) blocks.push(`ASIN_MISMATCH:${state.asin || "(empty)"}`);
  if (state.productType !== TARGET.productType) blocks.push(`PRODUCT_TYPE_DRIFT:${state.productType || "(empty)"}`);
  if (!state.statuses.includes("DISCOVERABLE")) blocks.push(`NOT_DISCOVERABLE:${state.statuses.join(",")}`);
  if (state.availableQuantity !== TARGET.availableQuantity) blocks.push(`INVENTORY_DRIFT:${state.availableQuantity}`);
  if (state.consumerCount !== 1) blocks.push(`CONSUMER_OFFER_COUNT:${state.consumerCount}`);
  if (state.b2bCount !== 1) blocks.push(`B2B_OFFER_COUNT:${state.b2bCount}`);
  if (state.normalPrice !== TARGET.normalPrice) blocks.push(`NORMAL_PRICE_DRIFT:${state.normalPrice}`);
  if (!state.actual.b2cPresent || state.actual.b2cPrice !== TARGET.actualB2CPrice) blocks.push(`ACTUAL_B2C_DRIFT:${state.actual.b2cPrice}`);
  if (!state.actual.pointsPresent || state.actual.points !== TARGET.amazonPoints) blocks.push(`POINTS_DRIFT:${state.actual.points}`);
  if (state.minimumSellerAllowed !== TARGET.currentMinimum) blocks.push(`MINIMUM_DRIFT:${state.minimumSellerAllowed}`);
  if (state.maximumSellerAllowed !== TARGET.maximumSellerAllowed) blocks.push(`MAXIMUM_DRIFT:${state.maximumSellerAllowed}`);
  if (state.b2bPrice !== TARGET.b2bPrice) blocks.push(`B2B_ATTRIBUTE_PRICE_DRIFT:${state.b2bPrice}`);
  if (!state.actual.b2bPresent || state.actual.b2bPrice !== TARGET.b2bPrice) blocks.push(`ACTUAL_B2B_DRIFT:${state.actual.b2bPrice}`);
  if (!quantityPlanMatches(state.quantityPlan)) blocks.push(`QUANTITY_PLAN_DRIFT:${JSON.stringify(state.quantityPlan)}`);
  if (!issueCodes.has("18155")) blocks.push("ISSUE_18155_NOT_PRESENT");
  if (!issueCodes.has("18639")) blocks.push("ISSUE_18639_NOT_PRESENT");
  if (!state.minimumRef) blocks.push("ACTIVE_MINIMUM_SCHEDULE_MISSING");
  const econ = economics();
  if (!econ.targetMatchesCalculatedMinimum) blocks.push(`ECONOMICS_TARGET_MISMATCH:${econ.calculatedMinimum}`);
  return blocks;
}

function buildPreviewOffers(state) {
  const offers = clone(state.offers);
  const consumer = offers[state.consumerIndex];
  const minRef = state.minimumRef;
  if (!consumer || !minRef) throw new Error("GUARD_BLOCKED: target consumer/minimum schedule missing");
  const group = consumer.minimum_seller_allowed_price?.[minRef.groupIndex];
  const schedule = group?.schedule?.[minRef.scheduleIndex];
  if (!schedule) throw new Error("GUARD_BLOCKED: target minimum schedule path missing");
  schedule.value_with_tax = TARGET.targetMinimum;

  const expected = clone(state.offers);
  expected[state.consumerIndex].minimum_seller_allowed_price[minRef.groupIndex].schedule[minRef.scheduleIndex].value_with_tax = TARGET.targetMinimum;
  if (!jsonEqual(offers, expected)) throw new Error("GUARD_BLOCKED: preview offer mutation exceeded target leaf");
  return offers;
}

async function handler(req, res) {
  let validationPreviewCalls = 0;
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, validationPreviewCalls, persistentWriteCalls: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, validationPreviewCalls, persistentWriteCalls: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    const asin = String(req.body?.asin || "").trim();
    const batchToken = String(req.body?.batchToken || "").trim();
    if (sku !== TARGET.sku) throw new Error(`GUARD_BLOCKED: unexpected SKU ${sku}`);
    if (asin !== TARGET.asin) throw new Error(`GUARD_BLOCKED: unexpected ASIN ${asin}`);
    if (batchToken !== BATCH_TOKEN) throw new Error("GUARD_BLOCKED: batch token mismatch");

    const accessToken = await getLwaAccessToken();
    const nowMs = Date.now();
    const state = analyzeListing(await getListing(accessToken), nowMs);
    const blocks = preflightBlocks(state);
    if (blocks.length) throw new Error(`PRECHECK_BLOCKED:${blocks.join("|")}`);

    const previewOffers = buildPreviewOffers(state);
    const preview = await validationPreview(accessToken, state.productType, previewOffers);
    validationPreviewCalls = 1;
    const previewErrorCodes = preview.errors.map(issue => String(issue?.code || ""));
    const issue18155AfterPreview = previewErrorCodes.includes("18155");
    const issue18639AfterPreview = previewErrorCodes.includes("18639");
    const validationPassed = preview.responseOk && preview.errors.length === 0 && ["VALID", "ACCEPTED"].includes(preview.status);

    return res.status(200).json({
      ok: true,
      code: validationPassed ? "0U_MIN_25100_VALIDATION_PREVIEW_PASS" : "0U_MIN_25100_VALIDATION_PREVIEW_HAS_ERRORS",
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      batchToken: BATCH_TOKEN,
      sku: TARGET.sku,
      asin: TARGET.asin,
      marketplaceId: TARGET.marketplaceId,
      changeIntent: "CONSUMER_MINIMUM_ONLY_32000_TO_25100",
      before: {
        statuses: state.statuses,
        buyable: state.buyable,
        availableQuantity: state.availableQuantity,
        normalPrice: state.normalPrice,
        actualB2CPrice: state.actual.b2cPrice,
        amazonPoints: state.actual.points,
        minimumSellerAllowed: state.minimumSellerAllowed,
        maximumSellerAllowed: state.maximumSellerAllowed,
        b2bAttributePrice: state.b2bPrice,
        actualB2BPrice: state.actual.b2bPrice,
        quantityPlan: state.quantityPlan,
        discountedPriceDiagnostics: state.saleDiagnostics,
        errorCodes: state.errorIssues.map(issue => String(issue?.code || "")),
      },
      proposed: {
        minimumSellerAllowed: TARGET.targetMinimum,
        allOtherPurchasableOfferFieldsPreserved: true,
      },
      economics: economics(),
      preview: {
        httpStatus: preview.httpStatus,
        responseOk: preview.responseOk,
        status: preview.status,
        submissionId: preview.submissionId,
        errorCount: preview.errors.length,
        errorCodes: previewErrorCodes,
        issue18155AfterPreview,
        issue18639AfterPreview,
        issues: preview.issues,
        validationPassed,
      },
      preservation: {
        consumerOurPrice32000: true,
        amazonPoints320ObservedAndUntouched: true,
        maximum58000: true,
        discountedPriceContainerUntouched: true,
        b2b55100: true,
        quantity5at5And10at7: true,
        inventory0Untouched: true,
      },
      validationPreviewCalls,
      persistentWriteCalls: 0,
      externalChanges: 0,
      nextAction: validationPassed
        ? "REPORT_AND_WAIT_FOR_EXPLICIT_LIVE_APPROVAL"
        : "ANALYZE_PREVIEW_ERRORS_NO_LIVE",
      note: "SP-API VALIDATION_PREVIEW only. No persistent listing mutation was sent.",
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      code: "0U_MIN_25100_VALIDATION_PREVIEW_BLOCKED",
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: TARGET.sku,
      asin: TARGET.asin,
      validationPreviewCalls,
      persistentWriteCalls: 0,
      externalChanges: 0,
      error: err?.message || String(err),
      note: "Fail closed. No persistent Amazon mutation was sent.",
    });
  }
}

express.application.listen = function amazon0uMin25100ValidationPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
