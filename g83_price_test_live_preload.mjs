import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-08-24-g83-price-test-live-v1.0.0";
const ROUTE = "/amazon/price/g83/price-test/live";
const G83_SKU = "E7-YLJ3-F9CY";
const G83_ASIN = "B0GZBHBQN2";
const EXPECTED_NORMAL_PRICE = 58000;
const EXPECTED_SAFE_FLOOR = 45000;
const EXPECTED_TEST_PRICE = 46000;
const EXPECTED_DURATION_DAYS = 7;
const EXPECTED_B2B_PRICE = 39900;
const EXPECTED_QTY_LOWER_BOUND = 10;
const EXPECTED_QTY_PERCENT = 3;
const LIVE_CONFIRM = "G83-46000-7D-APPROVED-20260824";
const PREFLIGHT_MODULE_VERSION = "2026-08-24-g83-price-test-preflight-v1.0.0";
const FINGERPRINT_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 6;
const VERIFY_WAIT_MS = 2500;
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

function isoOrEmpty(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

function epochOrNull(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : null;
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
    includedData: "summaries,attributes,issues,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(G83_SKU)}?${query}`;
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

function analyzeListing(listing, nowMs = Date.now()) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const availability = Array.isArray(listing?.fulfillmentAvailability)
    ? listing.fulfillmentAvailability[0] || {}
    : {};
  const offers = Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [];
  const consumer = offers.find(row => String(row?.audience || "ALL").toUpperCase() === "ALL") || null;
  const b2b = offers.find(row => String(row?.audience || "").toUpperCase() === "B2B") || null;
  const normal = activeSchedule(consumer, "our_price", nowMs);
  const sale = activeSchedule(consumer, "discounted_price", nowMs);
  const minAllowed = activeSchedule(consumer, "minimum_seller_allowed_price", nowMs);
  const b2bPriceSchedule = activeSchedule(b2b, "our_price", nowMs);
  const qtyPlanSchedule = activeSchedule(b2b, "quantity_discount_plan", nowMs) || {};
  const qtyLevels = Array.isArray(qtyPlanSchedule?.levels) ? qtyPlanSchedule.levels : [];

  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses: Array.isArray(summary?.status) ? summary.status.map(String) : [],
    buyable: Array.isArray(summary?.status) && summary.status.map(String).includes("BUYABLE"),
    errorCount: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: numberOrNull(availability?.quantity)
      ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity)
      ?? 0,
    offers,
    consumer,
    b2b,
    normalPrice: numberOrNull(normal?.value_with_tax),
    activeSalePrice: numberOrNull(sale?.value_with_tax),
    activeSaleStart: sale ? isoOrEmpty(sale?.start_at) : "",
    activeSaleEnd: sale ? isoOrEmpty(sale?.end_at) : "",
    minimumSellerAllowedPrice: numberOrNull(minAllowed?.value_with_tax),
    b2bPrice: numberOrNull(b2bPriceSchedule?.value_with_tax),
    quantityDiscountPlan: {
      discountType: String(qtyPlanSchedule?.discount_type || "").toLowerCase(),
      levels: qtyLevels.map(level => ({
        lowerBound: numberOrNull(level?.lower_bound),
        value: numberOrNull(level?.value),
      })).filter(level => level.lowerBound !== null && level.value !== null),
    },
  };
}

function verifyFingerprint(token) {
  const secret = getSecret();
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) throw new Error("dryRunFingerprint is required");
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("dryRunFingerprint signature mismatch");
  }
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const now = Date.now();
  const issuedAt = Number(payload.issuedAt || 0);
  if (!(issuedAt > 0) || now - issuedAt > FINGERPRINT_TTL_MS || issuedAt - now > 60 * 1000) {
    throw new Error("dryRunFingerprint expired or future-dated");
  }
  if (
    payload.v !== 1 ||
    payload.moduleVersion !== PREFLIGHT_MODULE_VERSION ||
    payload.sku !== G83_SKU ||
    payload.asin !== G83_ASIN ||
    payload.normalPrice !== EXPECTED_NORMAL_PRICE ||
    payload.safeFloor !== EXPECTED_SAFE_FLOOR ||
    payload.salePrice !== EXPECTED_TEST_PRICE ||
    payload.durationDays !== EXPECTED_DURATION_DAYS ||
    payload.b2bPrice !== EXPECTED_B2B_PRICE ||
    payload.qtyLowerBound !== EXPECTED_QTY_LOWER_BOUND ||
    payload.qtyPercent !== EXPECTED_QTY_PERCENT
  ) {
    throw new Error("dryRunFingerprint exact-scope mismatch");
  }
  const startMs = Date.parse(String(payload.targetStartAt || ""));
  const endMs = Date.parse(String(payload.targetEndAt || ""));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= now) {
    throw new Error("dryRunFingerprint target schedule invalid");
  }
  const expectedEndMs = issuedAt + EXPECTED_DURATION_DAYS * 24 * 60 * 60 * 1000;
  if (Math.abs(endMs - expectedEndMs) > 5 * 60 * 1000) {
    throw new Error("dryRunFingerprint duration mismatch");
  }
  return payload;
}

function quantityPlanMatches(state) {
  const qty = state.quantityDiscountPlan || {};
  const levels = Array.isArray(qty.levels) ? qty.levels : [];
  return String(qty.discountType || "").toLowerCase() === "percent" &&
    levels.length === 1 &&
    levels[0].lowerBound === EXPECTED_QTY_LOWER_BOUND &&
    levels[0].value === EXPECTED_QTY_PERCENT;
}

function assertProtectedState(state, fingerprint, allowApplied) {
  const errors = [];
  if (state.asin !== G83_ASIN) errors.push(`ASIN mismatch: ${state.asin || "(empty)"}`);
  if (!state.productType) errors.push("productType missing");
  if (!state.buyable) errors.push(`BUYABLE missing: ${state.statuses.join(",")}`);
  if (state.errorCount !== 0) errors.push(`listing ERROR issues=${state.errorCount}`);
  if (!(state.availableQuantity > 0)) errors.push(`availableQuantity must be > 0: ${state.availableQuantity}`);
  if (!state.consumer) errors.push("consumer purchasable_offer missing");
  if (!state.b2b) errors.push("B2B purchasable_offer missing");
  if (state.normalPrice !== EXPECTED_NORMAL_PRICE) errors.push(`normal price mismatch: ${state.normalPrice}`);
  if (state.b2bPrice !== EXPECTED_B2B_PRICE) errors.push(`B2B price mismatch: ${state.b2bPrice}`);
  if (!quantityPlanMatches(state)) errors.push(`quantity discount plan mismatch: ${JSON.stringify(state.quantityDiscountPlan)}`);
  if (state.minimumSellerAllowedPrice !== fingerprint.amazonMinimumSellerAllowedPrice) {
    errors.push(`minimum seller allowed price changed since preflight: ${state.minimumSellerAllowedPrice}`);
  }
  if (!allowApplied && state.activeSalePrice !== null) errors.push(`active sale already present: ${state.activeSalePrice}`);
  if (errors.length) {
    const err = new Error(`G83 price-test LIVE gate failed: ${errors.join(" / ")}`);
    err.code = "PREFLIGHT_STATE_CHANGED";
    err.details = errors;
    throw err;
  }
}

function isApplied(state, fingerprint) {
  return state.asin === G83_ASIN &&
    state.buyable === true &&
    state.errorCount === 0 &&
    state.normalPrice === EXPECTED_NORMAL_PRICE &&
    state.activeSalePrice === EXPECTED_TEST_PRICE &&
    state.activeSaleEnd === isoOrEmpty(fingerprint.targetEndAt) &&
    state.b2bPrice === EXPECTED_B2B_PRICE &&
    quantityPlanMatches(state) &&
    state.minimumSellerAllowedPrice === fingerprint.amazonMinimumSellerAllowedPrice;
}

function buildLivePatch(state, fingerprint) {
  const offers = JSON.parse(JSON.stringify(state.offers));
  const consumerIndex = offers.findIndex(row => String(row?.audience || "ALL").toUpperCase() === "ALL");
  const b2bIndex = offers.findIndex(row => String(row?.audience || "").toUpperCase() === "B2B");
  if (consumerIndex < 0 || b2bIndex < 0) throw new Error("consumer/B2B offer missing while building LIVE patch");

  const beforeB2B = JSON.stringify(offers[b2bIndex]);
  const beforeNormal = JSON.stringify(offers[consumerIndex]?.our_price || null);
  const beforeMin = JSON.stringify(offers[consumerIndex]?.minimum_seller_allowed_price || null);
  const saleContainer = offers[consumerIndex]?.discounted_price?.[0];
  if (!saleContainer || !Array.isArray(saleContainer.schedule) || !saleContainer.schedule.length) {
    throw new Error("existing discounted_price schedule container missing; refusing to invent schema");
  }

  const template = JSON.parse(JSON.stringify(saleContainer.schedule[0] || {}));
  template.value_with_tax = EXPECTED_TEST_PRICE;
  template.start_at = isoOrEmpty(fingerprint.targetStartAt);
  template.end_at = isoOrEmpty(fingerprint.targetEndAt);
  saleContainer.schedule = [template];

  if (JSON.stringify(offers[b2bIndex]) !== beforeB2B) throw new Error("B2B offer changed while building LIVE patch");
  if (JSON.stringify(offers[consumerIndex]?.our_price || null) !== beforeNormal) throw new Error("consumer normal price changed while building LIVE patch");
  if (JSON.stringify(offers[consumerIndex]?.minimum_seller_allowed_price || null) !== beforeMin) throw new Error("minimum seller allowed price changed while building LIVE patch");

  return {
    productType: state.productType,
    patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }],
  };
}

function hasErrorIssues(result) {
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  return issues.some(row => String(row?.severity || "").toUpperCase() === "ERROR");
}

async function submitLivePatch(accessToken, patchBody) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(G83_SKU)}?${query}`;
  const result = await amazonRequest({ method: "PATCH", url, accessToken, body: patchBody });
  if (hasErrorIssues(result)) throw new Error(`Amazon LIVE PATCH returned ERROR issues: ${JSON.stringify(result.issues)}`);
  return result;
}

async function verifyApplied(accessToken, fingerprint) {
  let lastState = null;
  let lastError = "";
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    try {
      lastState = analyzeListing(await getListing(accessToken), Date.now());
      if (isApplied(lastState, fingerprint)) {
        return { verified: true, attempt, state: lastState };
      }
      lastError = `not yet applied: normal=${lastState.normalPrice} sale=${lastState.activeSalePrice} end=${lastState.activeSaleEnd} b2b=${lastState.b2bPrice}`;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return { verified: false, attempt: VERIFY_ATTEMPTS, state: lastState, error: lastError };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, error: "AMAZON_STOCK_API_SECRET is not set", externalChanges: 0 });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, error: "Unauthorized", externalChanges: 0 });
    }
    if (String(req.body?.confirm || "") !== LIVE_CONFIRM) {
      return res.status(400).json({ ok: false, error: `confirm must equal ${LIVE_CONFIRM}`, externalChanges: 0 });
    }

    const fingerprint = verifyFingerprint(req.body?.dryRunFingerprint);
    const accessToken = await getLwaAccessToken();
    const before = analyzeListing(await getListing(accessToken), Date.now());
    assertProtectedState(before, fingerprint, true);

    if (isApplied(before, fingerprint)) {
      return res.status(200).json({
        ok: true,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        status: "ALREADY_APPLIED",
        sku: G83_SKU,
        asin: G83_ASIN,
        before,
        verification: { verified: true, attempt: 0, state: before },
        amazonWrites: 0,
        actualExternalChanges: 0,
        externalChanges: 0,
      });
    }

    assertProtectedState(before, fingerprint, false);
    const patchBody = buildLivePatch(before, fingerprint);
    const accepted = await submitLivePatch(accessToken, patchBody);
    const verification = await verifyApplied(accessToken, fingerprint);
    if (!verification.verified) {
      return res.status(409).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        status: "VERIFICATION_FAILED_AFTER_ACCEPTED_PATCH",
        accepted,
        verification,
        amazonWrites: 1,
        actualExternalChanges: "UNVERIFIED",
        externalChanges: "UNVERIFIED",
      });
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      status: "COMPLETED",
      sku: G83_SKU,
      asin: G83_ASIN,
      accepted,
      verification,
      protections: {
        normalPrice: EXPECTED_NORMAL_PRICE,
        b2bPrice: EXPECTED_B2B_PRICE,
        quantityDiscount: `${EXPECTED_QTY_LOWER_BOUND} units @ ${EXPECTED_QTY_PERCENT}%`,
        minimumSellerAllowedPrice: fingerprint.amazonMinimumSellerAllowedPrice,
      },
      amazonWrites: 1,
      actualExternalChanges: 1,
      externalChanges: 1,
    });
  } catch (err) {
    console.error("G83 price-test LIVE error", { message: err?.message || String(err), code: err?.code || "" });
    return res.status(err?.code === "PREFLIGHT_STATE_CHANGED" ? 409 : 400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      status: err?.code || "ERROR",
      error: err?.message || String(err),
      amazonWrites: 0,
      actualExternalChanges: 0,
      externalChanges: 0,
    });
  }
}

express.application.listen = function g83PriceTestLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
